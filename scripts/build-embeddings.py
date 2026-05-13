#!/usr/bin/env python3
"""
Build dense semantic embeddings for every page of every extracted document
in public/text/. Output is consumed by the in-browser semantic search view.

Pipeline:
  1. Walk public/text/*.txt
  2. Split each into per-page chunks using "=== Page N ===" markers
     (same chunking the lexical MiniSearch index uses, so the two stay aligned)
  3. Add one synthetic chunk per event with title + summary + tags so very
     short records are still findable
  4. Embed each chunk with sentence-transformers/all-MiniLM-L6-v2 (384-dim)
  5. L2-normalize so inner product == cosine similarity (FAISS IndexFlatIP)
  6. Build a FAISS index for sanity-check and to print top-k examples
  7. Export:
       public/embeddings.bin           — raw float32 array, N * 384 * 4 bytes
       public/embeddings-meta.json     — N items: { eventId, page, kind, snippet }
       public/embeddings-info.json     — { dim, count, model, generatedAt }

The browser doesn't need FAISS; with N ~ 900 chunks, brute-force cosine in JS
runs in < 5 ms.
"""
import json
import os
import re
import time
from pathlib import Path
from urllib.request import urlretrieve
import numpy as np
import faiss
from sentence_transformers import SentenceTransformer

ROOT = Path(__file__).resolve().parent.parent
TEXT_DIR = ROOT / "public" / "text"
EVENTS_JS = ROOT / "src" / "data" / "events.js"
OUT_BIN = ROOT / "public" / "embeddings.bin"
OUT_META = ROOT / "public" / "embeddings-meta.json"
OUT_INFO = ROOT / "public" / "embeddings-info.json"
WORDLIST = ROOT / "scripts" / ".words.txt"

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
MIN_CHUNK_CHARS = 30
MAX_CHUNK_CHARS = 2000  # split longer pages so dense models see coherent context

# Quality threshold — OCR chunks below this score are dropped from the
# index. They embed to near-random vectors and false-match unrelated
# queries; better to lose recall on garbage than poison precision.
# Tunable via env: MIN_QUALITY=0.30 python scripts/build-embeddings.py
MIN_QUALITY = float(os.environ.get("MIN_QUALITY", "0.25"))


def load_wordlist():
    """Top ~10K English words for OCR quality scoring."""
    if not WORDLIST.exists():
        print(f"[embeddings] fetching wordlist for quality scoring…")
        urlretrieve("https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english.txt", WORDLIST)
    return {w.strip().lower() for w in WORDLIST.read_text().splitlines() if len(w.strip()) >= 3}


def text_quality(text, words):
    """Fraction of alphabetic tokens that are common English words.
       Real English: 0.5–0.8. OCR garbage: 0.0–0.25."""
    toks = re.findall(r"[A-Za-z']+", text)
    if len(toks) < 5:
        return 0.0
    real = sum(1 for t in toks if 3 <= len(t) <= 20 and t.lower() in words)
    return real / len(toks)


def load_events_meta():
    """Cheap parse of events.js to recover { id → {title, summary, tags, agency, ...} }."""
    src = EVENTS_JS.read_text(encoding="utf-8")
    # crude — we only need a handful of fields and the file is hand-curated
    out = {}
    # capture { id: "x", title: "y", ... }
    for m in re.finditer(r'\{\s*id:\s*"([^"]+)",(.*?)\}\s*,(?=\s*\{|\s*\];)', src, re.S):
        eid = m.group(1); body = m.group(2)
        def field(name):
            mm = re.search(rf'{name}:\s*"((?:\\.|[^"\\])*)"', body)
            return mm.group(1).replace('\\"', '"') if mm else ""
        def list_field(name):
            mm = re.search(rf'{name}:\s*\[(.*?)\]', body, re.S)
            if not mm: return []
            return re.findall(r'"((?:\\.|[^"\\])*)"', mm.group(1))
        out[eid] = {
            "title": field("title"),
            "summary": field("summary"),
            "agency": field("agency"),
            "date": field("date"),
            "loc": field("loc"),
            "type": field("type"),
            "tags": list_field("tags"),
        }
    return out


def page_chunks_of(text):
    """Split a text dump into [(page, body, source), ...] using
       === Page N === (tesseract OCR / pdfjs) or
       === Page N (vision) === markers (whipgen + ChatGPT)."""
    if "=== Page" not in text:
        return [(0, text.strip(), None)]
    # Capture page number and optional source tag in parentheses.
    parts = re.split(r"=== Page (\d+)(?:\s*\((\w+)\))? ===", text)
    out = []
    for i in range(1, len(parts), 3):
        page = int(parts[i])
        marker_src = parts[i + 1] if i + 1 < len(parts) else None
        body = (parts[i + 2] if i + 2 < len(parts) else "").strip()
        if body:
            out.append((page, body, marker_src))
    return out


def slice_long(body, n=MAX_CHUNK_CHARS):
    """If a page body is long, split on paragraph then sentence to fit."""
    if len(body) <= n:
        return [body]
    paragraphs = re.split(r"\n\s*\n", body)
    pieces, buf = [], ""
    for p in paragraphs:
        if len(buf) + len(p) + 2 <= n:
            buf = (buf + "\n\n" + p).strip()
        else:
            if buf: pieces.append(buf)
            if len(p) <= n:
                buf = p
            else:
                # fallback: hard slice
                for k in range(0, len(p), n):
                    pieces.append(p[k:k+n])
                buf = ""
    if buf: pieces.append(buf)
    return pieces


def main():
    print(f"[embeddings] loading {MODEL_NAME} …")
    t0 = time.time()
    model = SentenceTransformer(MODEL_NAME)
    print(f"[embeddings] model loaded in {time.time()-t0:.1f}s, dim={model.get_sentence_embedding_dimension()}")

    words = load_wordlist()
    print(f"[embeddings] quality wordlist: {len(words)} terms, threshold q≥{MIN_QUALITY}")

    # Discover which docs were OCR'd vs pdfjs-clean — chunks from OCR
    # docs are subject to the quality filter; clean text-layer chunks
    # always pass.
    try:
        manifest = json.loads((ROOT / "public/text/manifest.json").read_text())
    except FileNotFoundError:
        manifest = {}
    # 'mixed' docs have both vision and tesseract pages — treat the doc-level
    # source as 'ocr' so unmarked pages still pass the quality filter; vision
    # pages override per-marker.
    ocr_ids = {k for k, v in manifest.items() if v.get("source") in ("ocr", "mixed")}
    pdfjs_ids = {k for k, v in manifest.items() if v.get("source") == "pdfjs"}
    vision_only_ids = {k for k, v in manifest.items() if v.get("source") == "vision"}

    events = load_events_meta()
    print(f"[embeddings] parsed {len(events)} events from events.js  ({len(pdfjs_ids)} clean / {len(ocr_ids)} OCR)")

    chunks = []  # { eventId, page, kind, body, snippet, source, quality }

    # 1) Synthetic metadata chunks for every catalogued event — these are
    #    hand-curated and always pass; they guarantee every event remains
    #    findable even if all its body chunks fail the quality filter.
    for eid, meta in events.items():
        tags = " ".join(meta.get("tags", []))
        body = " · ".join([s for s in [meta["title"], meta["summary"], tags, meta["loc"], meta["agency"], meta["type"]] if s])
        if not body or len(body) < MIN_CHUNK_CHARS:
            continue
        chunks.append({
            "eventId": eid,
            "page": 0,
            "kind": "meta",
            "body": body,
            "snippet": meta["summary"][:200],
            "source": "curated",
            "quality": 1.0,
        })

    # 2) Per-page chunks from extracted text
    rejected_by_source = {"ocr": 0, "pdfjs": 0, "vision": 0}
    rejected_chunks = []  # save a few examples for the report
    for fp in sorted(TEXT_DIR.glob("*.txt")):
        eid = fp.stem
        if eid == "manifest":
            continue
        # Doc-level source (manifest); per-page marker_src may override.
        doc_source = (
            "vision" if eid in vision_only_ids
            else "ocr" if eid in ocr_ids
            else "pdfjs" if eid in pdfjs_ids
            else "unknown"
        )
        raw = fp.read_text(encoding="utf-8", errors="ignore")
        body_full = raw.split("\n---\n", 1)[1] if "\n---\n" in raw else raw
        for page, body, marker_src in page_chunks_of(body_full):
            source = marker_src or doc_source  # vision marker wins
            for piece in slice_long(body):
                if len(piece) < MIN_CHUNK_CHARS:
                    continue
                q = text_quality(piece, words)
                # Vision-OCR text is high-quality by construction (GPT
                # outputs readable English). Don't quality-filter it —
                # we'd false-reject genuine '(blank)' or short pages.
                if source != "vision" and q < MIN_QUALITY:
                    rejected_by_source[source] = rejected_by_source.get(source, 0) + 1
                    if len(rejected_chunks) < 5:
                        rejected_chunks.append((eid, page, q, piece[:120].replace("\n"," ")))
                    continue
                chunks.append({
                    "eventId": eid,
                    "page": page,
                    "kind": "page",
                    "body": piece,
                    "snippet": piece[:240].replace("\n", " ").strip(),
                    "source": source,
                    "quality": round(q, 3),
                })

    print(f"[embeddings] kept {len(chunks)} chunks, rejected {sum(rejected_by_source.values())} below q≥{MIN_QUALITY} "
          f"({rejected_by_source.get('ocr', 0)} OCR + {rejected_by_source.get('pdfjs', 0)} pdfjs)")
    if rejected_chunks:
        print("[embeddings] rejected samples:")
        for eid, p, q, s in rejected_chunks:
            print(f"   {eid}:p{p}  q={q:.2f}  {s[:100]}")

    texts = [c["body"] for c in chunks]
    t1 = time.time()
    vecs = model.encode(
        texts,
        batch_size=64,
        show_progress_bar=True,
        convert_to_numpy=True,
        normalize_embeddings=True,   # FAISS IndexFlatIP becomes cosine
    ).astype(np.float32)
    print(f"[embeddings] encoded in {time.time()-t1:.1f}s, shape={vecs.shape}")

    # Sanity: build FAISS index and demo
    index = faiss.IndexFlatIP(vecs.shape[1])
    index.add(vecs)
    q = model.encode(["object that materialized and disappeared instantly"], normalize_embeddings=True).astype(np.float32)
    D, I = index.search(q, 5)
    print("[embeddings] demo query 'object that materialized and disappeared instantly' top 5:")
    for rank, idx in enumerate(I[0]):
        c = chunks[idx]
        print(f"   {rank+1}. ({D[0][rank]:.3f})  {c['eventId']}:p{c['page']}  — {c['snippet'][:80]}")

    # Export raw vectors as little-endian float32 binary
    OUT_BIN.write_bytes(vecs.tobytes(order="C"))
    print(f"[embeddings] wrote {OUT_BIN} — {OUT_BIN.stat().st_size/1024:.0f} KB")

    # Meta (drop body; keep snippet + quality + source)
    meta_out = [
        {"eventId": c["eventId"], "page": c["page"], "kind": c["kind"],
         "source": c["source"], "quality": c["quality"], "snippet": c["snippet"]}
        for c in chunks
    ]
    OUT_META.write_text(json.dumps(meta_out), encoding="utf-8")
    print(f"[embeddings] wrote {OUT_META} — {OUT_META.stat().st_size/1024:.0f} KB")

    # Coverage stats by source
    by_source = {}
    for c in chunks:
        s = c["source"]
        by_source.setdefault(s, {"count": 0, "qSum": 0.0})
        by_source[s]["count"] += 1
        by_source[s]["qSum"] += c["quality"]
    by_source_out = {s: {"count": v["count"], "meanQuality": round(v["qSum"]/v["count"], 3)} for s, v in by_source.items()}

    info = {
        "model": MODEL_NAME,
        "dim": int(vecs.shape[1]),
        "count": int(vecs.shape[0]),
        "minQuality": MIN_QUALITY,
        "rejectedByQuality": rejected_by_source,
        "bySource": by_source_out,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    OUT_INFO.write_text(json.dumps(info, indent=2), encoding="utf-8")
    print(f"[embeddings] wrote {OUT_INFO}")
    print(f"[embeddings] coverage by source: {by_source_out}")


if __name__ == "__main__":
    main()
