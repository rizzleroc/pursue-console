#!/usr/bin/env python3
# =====================================================================
# finetune.py — LoRA fine-tune a small base model on qa_pairs.jsonl.
#
# Defaults are sized for a T4 GPU (Colab free tier): SmolLM2-360M
# Instruct, LoRA rank 16, 3 epochs, ~1 hour wall-clock on ~2K pairs.
# Bigger base model? Pass --base. Need to fit Qwen2.5-1.5B on a T4 →
# enable 4-bit quantization with --qlora.
#
# Output:  out/adapter/  (LoRA weights + tokenizer)
# Also writes out/HOW_TO_DEPLOY.md with the post-training recipe.
# =====================================================================
import argparse
import json
import os
import sys
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent / "out"
QA_FILE = OUT_DIR / "qa_pairs.jsonl"
EVAL_FILE = Path(__file__).resolve().parent / "eval_set.jsonl"
ADAPTER_DIR = OUT_DIR / "adapter"
DEPLOY_DOC = OUT_DIR / "HOW_TO_DEPLOY.md"

def load_pairs(path):
    rows = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows

# Build the chat-template input for one Q&A pair. The system message
# matches what webllmClient.js and pursue-rag-server build, so the
# fine-tune teaches the model to expect (and follow) that exact format.
SYSTEM = (
    "You are an investigator's analytic assistant. Answer the user's question using ONLY the supplied context passages. "
    "When you use a passage, cite it inline as [eid · page] using the EID exactly as it appears. "
    "If the context doesn't contain enough to answer, say so plainly — do not invent facts. "
    "Keep the answer under 300 words, terse and analytic."
)

def format_pair(pair, tokenizer):
    messages = [
        {"role": "system", "content": SYSTEM},
        # Mimic the RAG runtime: passage is the context. During inference
        # we'll embed real retrieved passages here; during training we
        # supply the same passage the Q&A was grounded in.
        {"role": "user",   "content": pair["q"]},
        {"role": "assistant", "content": pair["a"]},
    ]
    return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base",     default="HuggingFaceTB/SmolLM2-360M-Instruct")
    ap.add_argument("--epochs",   type=int, default=3)
    ap.add_argument("--lr",       type=float, default=2e-4)
    ap.add_argument("--rank",     type=int, default=16)
    ap.add_argument("--alpha",    type=int, default=32)
    ap.add_argument("--bs",       type=int, default=4)
    ap.add_argument("--qlora",    action="store_true", help="4-bit quantize base for 1B+ models on T4")
    ap.add_argument("--maxlen",   type=int, default=1024)
    args = ap.parse_args()

    if not QA_FILE.exists():
        sys.exit(f"ERR: {QA_FILE} missing — run generate_qa.py first.")

    try:
        import torch
        from datasets import Dataset
        from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
        from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
        from trl import SFTTrainer, SFTConfig
    except ImportError as e:
        sys.exit(f"ERR: missing dep: {e}. pip install -r requirements.txt")

    pairs = load_pairs(QA_FILE)
    eval_pairs = load_pairs(EVAL_FILE) if EVAL_FILE.exists() else []
    print(f"  train pairs: {len(pairs)}")
    print(f"  eval pairs:  {len(eval_pairs)} (used as held-out sanity, not gradient)")

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model_kwargs = {"torch_dtype": torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16}
    if args.qlora:
        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
        )
    model = AutoModelForCausalLM.from_pretrained(args.base, **model_kwargs)
    if args.qlora:
        model = prepare_model_for_kbit_training(model)

    lora = LoraConfig(
        r=args.rank, lora_alpha=args.alpha,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
        lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    ds_train = Dataset.from_list([{"text": format_pair(p, tokenizer)} for p in pairs])
    ds_eval = Dataset.from_list([
        {"text": format_pair({"q": e["q"], "a": e["gold"]}, tokenizer)} for e in eval_pairs
    ]) if eval_pairs else None

    cfg = SFTConfig(
        output_dir=str(OUT_DIR / "checkpoints"),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.bs,
        gradient_accumulation_steps=2,
        learning_rate=args.lr,
        warmup_ratio=0.05,
        bf16=torch.cuda.is_bf16_supported(),
        fp16=not torch.cuda.is_bf16_supported(),
        logging_steps=10,
        save_strategy="epoch",
        eval_strategy="epoch" if ds_eval else "no",
        max_seq_length=args.maxlen,
        dataset_text_field="text",
        report_to="none",
    )
    trainer = SFTTrainer(
        model=model, processing_class=tokenizer,
        train_dataset=ds_train, eval_dataset=ds_eval,
        args=cfg,
    )
    trainer.train()

    ADAPTER_DIR.mkdir(parents=True, exist_ok=True)
    trainer.save_model(str(ADAPTER_DIR))
    tokenizer.save_pretrained(str(ADAPTER_DIR))

    DEPLOY_DOC.write_text(f"""# How to deploy the fine-tuned adapter

LoRA adapter saved at `{ADAPTER_DIR}`. It's about 10-30 MB and can be:

## (A) Browser path — merge then convert to ONNX
```bash
# Merge LoRA into the base, then convert to transformers.js (ONNX) format
python -m peft.export --base_model {args.base} --adapter {ADAPTER_DIR} --output_dir out/merged
# Use Xenova's conversion notebook to push out/merged to Hugging Face as
#   <your-user>/pursue-{args.base.split('/')[-1].lower()}
# Then in src/lib/askSettings.js set DEFAULT_MODEL_ID to that repo path.
```

## (B) Hosted path — load adapter at runtime in pursue-rag-server
```python
# In pursue-rag-server/server.mjs (or a new model_server.py companion):
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel
base = AutoModelForCausalLM.from_pretrained("{args.base}")
model = PeftModel.from_pretrained(base, "{ADAPTER_DIR}")
tok = AutoTokenizer.from_pretrained("{ADAPTER_DIR}")
# Run inference per request, dispatch via the existing /ask route.
```

## Verify quality before deploying
```bash
python run_eval.py --adapter {ADAPTER_DIR}
# Inspect out/eval_report.md — at minimum, citation accuracy must
# beat the base model. If refusal rate dropped, you've made it
# hallucinate MORE — back the LR down and retrain.
```
""", encoding="utf-8")

    print(f"\nDone. adapter at {ADAPTER_DIR}")
    print(f"Next: python run_eval.py --adapter {ADAPTER_DIR}")
    print(f"Deploy: see {DEPLOY_DOC}")

if __name__ == "__main__":
    main()
