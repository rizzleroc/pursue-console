# pursue-finetune

Fine-tune a small language model on the PURSUE corpus so ASK can answer content questions accurately without depending on a frontier-LLM proxy. Target deployment: in-browser via transformers.js (if 360M class) or hosted via Railway (if 1B+).

## Pipeline

```
public/text/*.txt          ┐
public/dossier-extracts.json  ├─→ prepare_corpus.py ─→ corpus.jsonl        (raw chunks for DAP)
src/data/events.js         ┘                       └─→ seed_passages.jsonl (high-quality passages for Q&A gen)

seed_passages.jsonl ──→ generate_qa.py ──→ qa_pairs.jsonl  (synthetic Q&A grounded in passages)
                       (uses Claude Haiku via the Anthropic API; ~$10 for ~2K pairs)

qa_pairs.jsonl + eval_set.jsonl ──→ finetune.py ──→ adapter/          (LoRA weights)
                                                  + merged-model/    (optional merged weights)

adapter/ ──→ run_eval.py ──→ eval_report.md   (vs. base model on eval_set.jsonl)
```

## Why these choices

- **Base model**: SmolLM2-360M-Instruct for the browser path, Qwen2.5-1.5B-Instruct if going hosted-only. SmolLM2 was specifically trained for on-device use and has the best small-model instruction-following per parameter.
- **LoRA over full fine-tune**: 12 MB of corpus text + ~2K Q&A pairs is too small to risk overwriting the base model's general capabilities. LoRA (rank=16) updates ~1% of params, fast to train, easy to merge or hot-swap.
- **Synthetic Q&A**: 12 MB of raw text alone wouldn't teach the model HOW to answer questions about it — only WHAT'S in it. Synthetic Q&A pairs grounded in real passages teach both the content and the format (cite-as-`[eid · page]`, refuse when context insufficient).

## Cost / time estimate

| Step | Cost | Time |
|---|---|---|
| `prepare_corpus.py` | $0 | ~1 min on CPU |
| `generate_qa.py` (2K pairs, Claude Haiku) | ~$10 | ~30 min wall-clock |
| `finetune.py` (LoRA, SmolLM2-360M, 3 epochs) | $0 on Colab T4 free tier | ~1 hour |
| `run_eval.py` | ~$0.50 (eval set ≈ 30 items × 2 models) | ~10 min |
| **Total** | **~$10.50** | **~2 hours active work** |

## Running it

```bash
cd training
pip install -r requirements.txt

# 1. Build corpus + seed passages from the existing extracts
python prepare_corpus.py
# → corpus.jsonl (~3,500 chunks)
# → seed_passages.jsonl (~500 high-quality excerpts)

# 2. Generate synthetic Q&A pairs (requires ANTHROPIC_API_KEY in env)
export ANTHROPIC_API_KEY=sk-ant-...
python generate_qa.py --n 2000
# → qa_pairs.jsonl

# 3. Fine-tune (on Colab T4 or local GPU — script is self-contained)
python finetune.py --base HuggingFaceTB/SmolLM2-360M-Instruct
# → adapter/

# 4. Evaluate base vs fine-tuned on the held-out eval set
python run_eval.py --adapter adapter/
# → eval_report.md
```

## Outputs

Everything under `training/out/` (gitignored). The trained adapter (~10 MB) can be:
- **Merged + uploaded to Hugging Face** as `<your-org>/pursue-smollm2-360m-adapter` for the browser to fetch
- **Bundled with `pursue-rag-server/`** so the Railway proxy uses it instead of calling Claude

See `out/HOW_TO_DEPLOY.md` (created by `finetune.py`) for the post-training deployment recipe.

## Files

| File | What it does |
|---|---|
| `prepare_corpus.py` | Reads `public/text/*.txt` + `public/dossier-extracts.json`, produces sentence-window chunks for DAP + high-quality seed passages for Q&A generation. |
| `generate_qa.py` | For each seed passage, prompts Claude Haiku with `qa_prompt.txt` to generate 1-3 grounded Q&A pairs. Validates each pair (citation matches eid; answer doesn't extrapolate beyond passage). |
| `qa_prompt.txt` | The Q&A generation prompt. Tuned to produce factual, citation-grounded, refusal-positive pairs. Edit to change Q&A style. |
| `eval_set.jsonl` | 30 hand-curated eval items covering: factual lookup, multi-doc comparison, summarization, refusal-when-unknown, citation accuracy. The bedrock metric. |
| `finetune.py` | LoRA SFT on `qa_pairs.jsonl`. Uses TRL's `SFTTrainer`. Saves adapter under `out/adapter/`. |
| `run_eval.py` | Runs the eval set against (a) base model, (b) base + adapter, computes per-question scores via Claude-as-judge, writes `eval_report.md` with per-item diffs. |
| `requirements.txt` | Python deps. Pinned where it matters. |
