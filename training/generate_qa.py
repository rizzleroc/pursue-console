#!/usr/bin/env python3
# =====================================================================
# generate_qa.py — Generate synthetic Q&A pairs grounded in the corpus.
#
# For each seed passage (from prepare_corpus.py → seed_passages.jsonl),
# call Claude Haiku with the qa_prompt.txt template. Parse the JSONL the
# model returns. Validate every pair:
#   - Citation `[eid · pN]` must reference the supplied EID
#   - Answer length sane
#   - JSON parses
# Write valid pairs to out/qa_pairs.jsonl.
#
# Idempotent: rerun-safe via a (eid, page) → row resume index. Pass
# --n to cap how many seed passages to consume (good for cheap test
# runs before committing to a full $10 generation).
# =====================================================================
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent / "out"
PROMPT_FILE = Path(__file__).resolve().parent / "qa_prompt.txt"
SEED_FILE = OUT_DIR / "seed_passages.jsonl"
QA_FILE = OUT_DIR / "qa_pairs.jsonl"
RESUME_INDEX = OUT_DIR / ".qa_resume_index"

def load_seeds():
    if not SEED_FILE.exists():
        sys.exit(f"ERR: {SEED_FILE} missing — run prepare_corpus.py first.")
    with SEED_FILE.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)

def load_resumed():
    if not RESUME_INDEX.exists():
        return set()
    with RESUME_INDEX.open(encoding="utf-8") as f:
        return {tuple(line.strip().split("\t", 1)) for line in f if line.strip()}

def mark_resumed(eid, page):
    with RESUME_INDEX.open("a", encoding="utf-8") as f:
        f.write(f"{eid}\t{page}\n")

CITATION_RE = re.compile(r"\[([A-Za-z0-9_\-]+)\s*·\s*p(\d+)\]")

def validate_pair(pair, expected_eid):
    if not isinstance(pair, dict): return False, "not an object"
    q = pair.get("q"); a = pair.get("a")
    if not isinstance(q, str) or not isinstance(a, str):       return False, "q/a not strings"
    if len(q) < 12 or len(q) > 400:                            return False, f"q length {len(q)}"
    if len(a) < 20 or len(a) > 1200:                           return False, f"a length {len(a)}"
    cites = CITATION_RE.findall(a)
    if not cites:                                              return False, "no citation"
    eids_cited = {c[0] for c in cites}
    if expected_eid not in eids_cited:                         return False, f"wrong EID cited: {eids_cited}"
    return True, "ok"

def call_claude(client, model, prompt, passage_block, retry=3):
    """Returns the model's text output, or None on persistent failure."""
    full_prompt = prompt + "\n" + passage_block
    for attempt in range(retry):
        try:
            msg = client.messages.create(
                model=model,
                max_tokens=1500,
                messages=[{"role": "user", "content": full_prompt}],
            )
            return "".join(b.text for b in msg.content if b.type == "text")
        except Exception as e:
            wait = 2 ** attempt
            print(f"  retry {attempt + 1}/{retry} in {wait}s: {e}", file=sys.stderr)
            time.sleep(wait)
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=0, help="cap on seed passages (0 = all)")
    ap.add_argument("--model", default="claude-haiku-4-5", help="anthropic model id")
    ap.add_argument("--fresh", action="store_true", help="ignore .qa_resume_index and regenerate everything")
    args = ap.parse_args()

    if "ANTHROPIC_API_KEY" not in os.environ:
        sys.exit("ERR: export ANTHROPIC_API_KEY=sk-ant-... before running.")

    try:
        from anthropic import Anthropic
    except ImportError:
        sys.exit("ERR: pip install anthropic")

    client = Anthropic()
    prompt = PROMPT_FILE.read_text(encoding="utf-8")

    if args.fresh and RESUME_INDEX.exists():
        RESUME_INDEX.unlink()
    resumed = load_resumed()
    seeds = list(load_seeds())
    if args.n > 0:
        seeds = seeds[: args.n]

    print(f"Generating Q&A for {len(seeds)} seed passages")
    print(f"  resumed: {len(resumed)} already done")
    print(f"  model:   {args.model}")
    print(f"  out:     {QA_FILE}")

    written = 0
    rejected = 0
    with QA_FILE.open("a", encoding="utf-8") as f_out:
        for i, seed in enumerate(seeds):
            eid = seed["eid"]
            page = seed["page"]
            key = (eid, str(page))
            if key in resumed:
                continue

            passage_block = (
                f"EID: {eid}\n"
                f"PAGE: {page}\n"
                f"TITLE: {seed.get('title') or '?'}\n"
                f"AGENCY: {seed.get('agency') or '?'}\n"
                f"DATE: {seed.get('date') or '?'}\n"
                f"PASSAGE:\n{seed['passage']}\n"
            )
            text = call_claude(client, args.model, prompt, passage_block)
            if text is None:
                print(f"[{i+1}/{len(seeds)}] {eid} p{page} · API failed", file=sys.stderr)
                continue

            # Parse JSONL — be lenient about stray prose around it.
            doc_pairs = 0
            for line in text.splitlines():
                line = line.strip()
                if not line or line.startswith("```"):
                    continue
                try:
                    pair = json.loads(line)
                except json.JSONDecodeError:
                    rejected += 1
                    continue
                ok, why = validate_pair(pair, eid)
                if not ok:
                    rejected += 1
                    continue
                pair["eid"]  = eid
                pair["page"] = page
                f_out.write(json.dumps(pair, ensure_ascii=False) + "\n")
                f_out.flush()
                written += 1
                doc_pairs += 1
            mark_resumed(eid, page)
            print(f"[{i+1}/{len(seeds)}] {eid} p{page} · +{doc_pairs} pairs (total {written}, rejected {rejected})")

    print(f"\nDone. wrote {written} pairs, rejected {rejected}.")
    print(f"  → {QA_FILE}")

if __name__ == "__main__":
    main()
