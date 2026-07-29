#!/usr/bin/env python3
# =====================================================================
# run_eval.py — Compare base model vs fine-tuned adapter on eval_set.jsonl.
#
# Two dimensions of evaluation:
#   1. Citation accuracy — does the answer cite an EID from `expected_eids`?
#      (Deterministic. The bedrock metric.)
#   2. LLM-as-judge quality — Claude grades each answer 0-3 vs the gold
#      answer, with explicit anti-leniency instructions.
#
# Writes out/eval_report.md with per-item diffs, aggregate scores, and
# the worst-performing examples for human review.
# =====================================================================
import argparse
import json
import os
import re
import sys
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent / "out"
EVAL_FILE = Path(__file__).resolve().parent / "eval_set.jsonl"
REPORT = OUT_DIR / "eval_report.md"

CITATION_RE = re.compile(r"\[([A-Za-z0-9_\-]+)\s*·\s*p?(\d+)?\]")

JUDGE_PROMPT = """You are grading a small model's answer against a gold-standard reference. Score 0-3:

  3 = matches the gold answer's substance and cites the right source(s). Minor wording differences are fine.
  2 = mostly correct but misses a key detail or has a small inaccuracy. Cites correctly.
  1 = partially correct but contains a meaningful error, hallucination, or wrong citation.
  0 = wrong answer, fabricated content, or refuses when the gold provides a real answer.

For REFUSAL questions (gold says "The records do not contain..."), grade 3 ONLY if the candidate also refuses appropriately. Grade 0 if the candidate fabricates an answer.

Output ONLY a single JSON object on one line: {"score": N, "reason": "one short sentence"}.

QUESTION: {question}

GOLD ANSWER: {gold}

CANDIDATE ANSWER: {candidate}
"""

def load_jsonl(path):
    rows = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows

def citation_score(answer, expected_eids):
    """1.0 if at least one expected EID is cited. For refusal items
    (expected_eids = []), 1.0 if the answer cites the single relevant
    source it's refusing about — i.e. ANY citation is acceptable
    because the gold answer also cites the source it's refusing about."""
    cites = {c[0] for c in CITATION_RE.findall(answer)}
    if not expected_eids:
        return 1.0 if cites else 0.5
    return 1.0 if (cites & set(expected_eids)) else 0.0

def generate_with(model_id, adapter_path, items, device):
    """Run inference for one model (base or base+adapter)."""
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM
    tok = AutoTokenizer.from_pretrained(model_id)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        torch_dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16,
    ).to(device)
    if adapter_path:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, adapter_path).to(device)
    model.eval()

    SYSTEM = (
        "You are an investigator's analytic assistant. Answer the user's question using ONLY the supplied context passages. "
        "When you use a passage, cite it inline as [eid · page] using the EID exactly as it appears. "
        "If the context doesn't contain enough to answer, say so plainly — do not invent facts. "
        "Keep the answer under 300 words, terse and analytic."
    )
    answers = []
    for item in items:
        messages = [{"role": "system", "content": SYSTEM},
                    {"role": "user",   "content": item["q"]}]
        prompt = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = tok(prompt, return_tensors="pt").to(device)
        with torch.no_grad():
            out = model.generate(
                **inputs, max_new_tokens=400, do_sample=False,
                pad_token_id=tok.pad_token_id,
            )
        gen = tok.decode(out[0][inputs.input_ids.shape[1]:], skip_special_tokens=True)
        answers.append(gen.strip())
    return answers

def judge(item, candidate, client, model):
    prompt = JUDGE_PROMPT.format(question=item["q"], gold=item["gold"], candidate=candidate)
    msg = client.messages.create(model=model, max_tokens=200,
                                  messages=[{"role": "user", "content": prompt}])
    text = "".join(b.text for b in msg.content if b.type == "text").strip()
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                j = json.loads(line)
                return int(j.get("score", 0)), j.get("reason", "")
            except json.JSONDecodeError:
                pass
    return 0, f"unparseable judge response: {text[:100]}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base",     default="HuggingFaceTB/SmolLM2-360M-Instruct")
    ap.add_argument("--adapter",  default=None, help="path to LoRA adapter dir; omit to eval base only")
    ap.add_argument("--judge",    default="claude-haiku-4-5")
    ap.add_argument("--device",   default="cuda")
    args = ap.parse_args()

    if "ANTHROPIC_API_KEY" not in os.environ:
        sys.exit("ERR: export ANTHROPIC_API_KEY=sk-ant-... for the judge.")
    try:
        from anthropic import Anthropic
    except ImportError:
        sys.exit("ERR: pip install anthropic")
    client = Anthropic()

    items = load_jsonl(EVAL_FILE)
    print(f"Evaluating {len(items)} eval items")

    print("Generating with base model…")
    base_answers = generate_with(args.base, None, items, args.device)
    if args.adapter:
        print("Generating with base + adapter…")
        adapter_answers = generate_with(args.base, args.adapter, items, args.device)
    else:
        adapter_answers = [None] * len(items)

    rows = []
    base_cite_sum = 0; adapter_cite_sum = 0
    base_judge_sum = 0; adapter_judge_sum = 0
    for i, item in enumerate(items):
        b_ans = base_answers[i]
        a_ans = adapter_answers[i]
        b_cite = citation_score(b_ans, item["expected_eids"])
        a_cite = citation_score(a_ans, item["expected_eids"]) if a_ans else None
        base_cite_sum += b_cite
        if a_cite is not None:
            adapter_cite_sum += a_cite

        b_score, b_reason = judge(item, b_ans, client, args.judge)
        if a_ans:
            a_score, a_reason = judge(item, a_ans, client, args.judge)
        else:
            a_score, a_reason = None, None
        base_judge_sum += b_score
        if a_score is not None:
            adapter_judge_sum += a_score

        rows.append({
            "id": item["id"], "category": item["category"], "q": item["q"],
            "base":    {"answer": b_ans, "cite": b_cite, "score": b_score, "reason": b_reason},
            "adapter": {"answer": a_ans, "cite": a_cite, "score": a_score, "reason": a_reason},
        })
        print(f"  [{item['id']}] base {b_score}/3 cite={b_cite:.0f}  "
              f"adapter {a_score if a_score is not None else '-'}/3 cite={a_cite if a_cite is not None else '-'}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with REPORT.open("w", encoding="utf-8") as f:
        n = len(items)
        f.write("# Eval Report\n\n")
        f.write(f"- Eval items:       {n}\n")
        f.write(f"- Base model:       `{args.base}`\n")
        f.write(f"- Adapter:          `{args.adapter or '—'}`\n")
        f.write(f"- Judge:            `{args.judge}`\n\n")
        f.write("## Aggregate\n\n")
        f.write(f"| Metric | Base | Adapter | Δ |\n|---|---|---|---|\n")
        f.write(f"| Citation accuracy (0-1) | {base_cite_sum/n:.2f} | "
                f"{(adapter_cite_sum/n if args.adapter else 0):.2f} | "
                f"{((adapter_cite_sum-base_cite_sum)/n if args.adapter else 0):+.2f} |\n")
        f.write(f"| Judge score (0-3) | {base_judge_sum/n:.2f} | "
                f"{(adapter_judge_sum/n if args.adapter else 0):.2f} | "
                f"{((adapter_judge_sum-base_judge_sum)/n if args.adapter else 0):+.2f} |\n\n")
        f.write("## Per-item\n\n")
        for r in rows:
            f.write(f"### {r['id']} · {r['category']}\n\n")
            f.write(f"**Q:** {r['q']}\n\n")
            f.write(f"**Base** (score {r['base']['score']}/3 · cite {r['base']['cite']:.0f}): {r['base']['reason']}\n\n")
            f.write(f"> {r['base']['answer']}\n\n")
            if r['adapter']['answer']:
                f.write(f"**Adapter** (score {r['adapter']['score']}/3 · cite {r['adapter']['cite']:.0f}): {r['adapter']['reason']}\n\n")
                f.write(f"> {r['adapter']['answer']}\n\n")
    print(f"\nReport: {REPORT}")

if __name__ == "__main__":
    main()
