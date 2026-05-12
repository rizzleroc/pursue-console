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
import re
import time
from pathlib import Path
import numpy as np
import faiss
from sentence_transformers import SentenceTransformer

ROOT = Path(__file__).resolve().parent.parent
TEXT_DIR = ROOT / "public" / "text"
EVENTS_JS = ROOT / "src" / "data" / "events.js"
OUT_BIN = ROOT / "public" / "embeddings.bin"
OUT_META = ROOT / "public" / "embeddings-meta.json"
OUT_INFO = ROOT / "public" / "embeddings-info.json"

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
MIN_CHUNK_CHARS = 30
MAX_CHUNK_CHARS = 2000  # split longer pages so dense models see coherent context


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
    """Split a text dump into [(page, body), ...] using === Page N === markers."""
    if "=== Page" not in text:
        return [(0, text.strip())]
    parts = re.split(r"=== Page (\d+) ===", text)
    out = []
    for i in range(1, len(parts), 2):
        page = int(parts[i])
        body = (parts[i + 1] if i + 1 < len(parts) else "").strip()
        if body:
            out.append((page, body))
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

    events = load_events_meta()
    print(f"[embeddings] parsed {len(events)} events from events.js")

    chunks = []  # list of dicts: { eventId, page, kind, body, snippet }

    # 1) Synthetic metadata chunks for every catalogued event (so even
    #    event with no extracted text is still searchable by its summary)
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
        })

    # 2) Per-page chunks from extracted text
    for fp in sorted(TEXT_DIR.glob("*.txt")):
        eid = fp.stem
        if eid == "manifest":
            continue
        raw = fp.read_text(encoding="utf-8", errors="ignore")
        # strip our header (everything before first \n---\n)
        body_full = raw.split("\n---\n", 1)[1] if "\n---\n" in raw else raw
        for page, body in page_chunks_of(body_full):
            for piece in slice_long(body):
                if len(piece) < MIN_CHUNK_CHARS:
                    continue
                chunks.append({
                    "eventId": eid,
                    "page": page,
                    "kind": "page",
                    "body": piece,
                    "snippet": piece[:240].replace("\n", " ").strip(),
                })

    print(f"[embeddings] {len(chunks)} chunks to embed")

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

    # Meta (drop body; keep snippet)
    meta_out = [{"eventId": c["eventId"], "page": c["page"], "kind": c["kind"], "snippet": c["snippet"]} for c in chunks]
    OUT_META.write_text(json.dumps(meta_out), encoding="utf-8")
    print(f"[embeddings] wrote {OUT_META} — {OUT_META.stat().st_size/1024:.0f} KB")

    info = {
        "model": MODEL_NAME,
        "dim": int(vecs.shape[1]),
        "count": int(vecs.shape[0]),
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    OUT_INFO.write_text(json.dumps(info), encoding="utf-8")
    print(f"[embeddings] wrote {OUT_INFO}")


if __name__ == "__main__":
    main()
