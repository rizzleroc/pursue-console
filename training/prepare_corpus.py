#!/usr/bin/env python3
# =====================================================================
# prepare_corpus.py — Turn the PURSUE extracted-text + dossier-extracts
# files into two training-ready JSONL files:
#
#   out/corpus.jsonl         — sentence-window chunks (~500 tok each)
#                              for continued/domain-adaptive pretraining.
#                              Includes EID + page + agency metadata so
#                              we can do citation-aware training later.
#
#   out/seed_passages.jsonl  — high-quality excerpts from
#                              public/dossier-extracts.json (already
#                              scored + ranked by build-dossier-extracts.mjs).
#                              These seed generate_qa.py — each becomes
#                              the grounding context for 1-3 Q&A pairs.
#
# Pure CPU, no model loads, ~1 minute on the full corpus.
# =====================================================================
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEXT_DIR = ROOT / "public" / "text"
EXTRACTS = ROOT / "public" / "dossier-extracts.json"
EVENTS_JS = ROOT / "src" / "data" / "events.js"
OUT_DIR = Path(__file__).resolve().parent / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ---- read events metadata so chunks carry agency/title/release tags ----
# events.js is JS, not JSON. We parse just enough by regex — every record
# has shape {... id: "...", title: "...", agency: "...", ... } and we
# only need the few fields that help training.
def read_events_meta():
    src = EVENTS_JS.read_text(encoding="utf-8", errors="replace")
    out = {}
    # Find every { id: "x", ... } block. Loose match, good enough for
    # this purpose; build pipeline truth is corpus-stats.json downstream.
    pat = re.compile(r'\{\s*id:\s*"([^"]+)"([^{}]*)\}', re.S)
    for m in pat.finditer(src):
        eid = m.group(1)
        body = m.group(2)
        def field(name):
            mm = re.search(rf'{name}:\s*"([^"]*)"', body)
            return mm.group(1) if mm else None
        out[eid] = {
            "title":   field("title"),
            "agency":  field("agency"),
            "release": field("release") or "Release 01",
            "date":    field("date"),
        }
    return out

# ---- page-split a text file using the build-text-files.mjs format ----
PAGE_HDR = re.compile(r"^===\s*Page\s+(\d+)\s*\(([^)]+)\)\s*===\s*$", re.M)

def split_pages(txt: str):
    """Yield (page_num, page_text) tuples."""
    parts = PAGE_HDR.split(txt)
    # parts[0] is the doc header (Title / Agency / Date / etc.); skip.
    # Then we have repeating triples: [page_num, source, page_text].
    for i in range(1, len(parts), 3):
        if i + 2 >= len(parts):
            break
        try:
            page = int(parts[i])
        except ValueError:
            continue
        body = parts[i + 2].strip()
        if body:
            yield page, body

# ---- chunk a page into windows of ~target_chars characters ----
def window_chunks(text: str, target_chars=2000, overlap=200):
    """Sentence-aware windowing. Splits on sentence boundaries near
    target_chars, with `overlap` chars carried into the next chunk so
    context isn't lost across boundaries."""
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return
    sentences = re.split(r"(?<=[.!?])\s+", text)
    buf = []
    buf_len = 0
    for s in sentences:
        if buf_len + len(s) > target_chars and buf:
            chunk = " ".join(buf).strip()
            yield chunk
            # carry tail for overlap
            tail = chunk[-overlap:] if overlap > 0 else ""
            buf = [tail, s] if tail else [s]
            buf_len = len(tail) + len(s)
        else:
            buf.append(s)
            buf_len += len(s)
    if buf:
        yield " ".join(buf).strip()

def main():
    if not TEXT_DIR.exists():
        sys.exit(f"ERR: {TEXT_DIR} not found. Build the corpus first.")
    events_meta = read_events_meta()

    corpus_path = OUT_DIR / "corpus.jsonl"
    seed_path = OUT_DIR / "seed_passages.jsonl"

    chunk_count = 0
    doc_count = 0
    with corpus_path.open("w", encoding="utf-8") as f_corpus:
        for txt_file in sorted(TEXT_DIR.glob("*.txt")):
            eid = txt_file.stem
            meta = events_meta.get(eid, {})
            try:
                txt = txt_file.read_text(encoding="utf-8", errors="replace")
            except OSError as e:
                print(f"WARN: skip {eid}: {e}", file=sys.stderr)
                continue
            doc_count += 1
            for page, body in split_pages(txt):
                for chunk in window_chunks(body):
                    if len(chunk) < 200:
                        continue   # skip near-empty pages
                    rec = {
                        "eid":     eid,
                        "page":    page,
                        "title":   meta.get("title"),
                        "agency":  meta.get("agency"),
                        "release": meta.get("release"),
                        "date":    meta.get("date"),
                        "text":    chunk,
                    }
                    f_corpus.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    chunk_count += 1

    # ---- seed passages from dossier-extracts.json ----
    # Each entry in excerptsByPage has top[] excerpts already scored. We
    # take the top excerpt per page, deduped, only the ones flagged with
    # uap=true OR scoring above a threshold. These are the highest-signal
    # passages — perfect grounding for synthetic Q&A.
    seed_count = 0
    if EXTRACTS.exists():
        extracts = json.loads(EXTRACTS.read_text(encoding="utf-8"))
        with seed_path.open("w", encoding="utf-8") as f_seed:
            for eid, doc in extracts.items():
                meta = events_meta.get(eid, {})
                ebp = doc.get("excerptsByPage", {}) or {}
                for page_str, info in ebp.items():
                    try:
                        page = int(page_str)
                    except ValueError:
                        continue
                    for ex in (info.get("top") or [])[:1]:    # top-1 per page
                        text = (ex.get("text") or "").strip()
                        score = ex.get("score") or 0
                        flags = ex.get("flags") or {}
                        if len(text) < 80 or len(text) > 1200:
                            continue
                        if score < 3 and not flags.get("uap"):
                            continue
                        rec = {
                            "eid":     eid,
                            "page":    page,
                            "title":   meta.get("title"),
                            "agency":  meta.get("agency"),
                            "release": meta.get("release"),
                            "date":    meta.get("date"),
                            "score":   score,
                            "flags":   flags,
                            "passage": text,
                        }
                        f_seed.write(json.dumps(rec, ensure_ascii=False) + "\n")
                        seed_count += 1
    else:
        print(f"WARN: {EXTRACTS} missing — no seed_passages.jsonl produced.", file=sys.stderr)

    print(f"OK · corpus.jsonl   · {chunk_count:5d} chunks from {doc_count} docs")
    print(f"OK · seed_passages.jsonl · {seed_count:5d} high-quality passages")
    print(f"OUT · {OUT_DIR}")

if __name__ == "__main__":
    main()
