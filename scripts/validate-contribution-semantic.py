#!/usr/bin/env python3
"""
FAISS-based semantic gate for contribution PRs (Gate 4 in JUDGE-STANDARD.md).

Loads public/embeddings.bin into a real faiss.IndexFlatIP, embeds every
contribution file with sentence-transformers/all-MiniLM-L6-v2, then for
each contribution evaluates:

  4a. Document affinity — top-5 nearest existing chunks should include
      at least one from the claimed <event-id>. If not, check cosine to
      the doc centroid as a fallback.
  4b. Canonical agreement — if .vision-cache/<eid>/p<NNN>.txt exists,
      cosine similarity against it bands the outcome (>=0.85 strong,
      0.60-0.85 corroborating-but-distinct, 0.30-0.60 review, <0.30 reject).
  4c. In-document continuity — cosine to the mean of neighbour pages
      (±1) of the same eid should be reasonable.

Writes the per-file verdict to /tmp/semantic-verdict.json so the
Node validator can fold it into the combined report and the CI
workflow can post the unified matrix as a PR comment.

Exit code 0 if no rejects, 1 otherwise.
"""
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import faiss
from sentence_transformers import SentenceTransformer

ROOT = Path(__file__).resolve().parent.parent
EMB_BIN = ROOT / "public" / "embeddings.bin"
EMB_META = ROOT / "public" / "embeddings-meta.json"
EMB_INFO = ROOT / "public" / "embeddings-info.json"
VIS_CACHE = ROOT / "data-raw" / ".vision-cache"
CONTRIB = ROOT / "contributions"
EVENTS_JS = ROOT / "src" / "data" / "events.js"
VERDICT_OUT = Path(os.environ.get("VERDICT_OUT", "/tmp/semantic-verdict.json"))

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

# Thresholds — see JUDGE-STANDARD.md
DOC_AFFINITY_REVIEW = 0.30  # cos to centroid when top-5 misses
CANON_PASS = 0.85
CANON_OVERLAP = 0.60
CANON_REVIEW = 0.30
NEIGHBOR_PASS = 0.40
NEIGHBOR_REVIEW = 0.20


def load_events():
    src = EVENTS_JS.read_text(encoding="utf-8")
    return {m.group(1) for m in re.finditer(r'\{\s*id:\s*"([^"]+)"', src)}


def collect_contributions():
    if not CONTRIB.exists():
        return []
    out = []
    for handle_dir in CONTRIB.iterdir():
        if not handle_dir.is_dir():
            continue
        handle = handle_dir.name
        # contributions/<handle>/<source>/<eid>/p<NNN>.txt is canonical.
        # Legacy <handle>/<eid>/ shape is accepted and tagged gpt-vision.
        KNOWN_SOURCES = {"human", "gpt-vision", "gemini", "ocr"}
        for child in handle_dir.iterdir():
            if not child.is_dir():
                continue
            if child.name in KNOWN_SOURCES:
                source = child.name
                for eid_dir in child.iterdir():
                    if not eid_dir.is_dir():
                        continue
                    for f in eid_dir.iterdir():
                        if f.is_file() and f.suffix == ".txt":
                            out.append({
                                "handle": handle, "source": source,
                                "eid": eid_dir.name, "file": f.name, "path": f,
                                "rel": f"contributions/{handle}/{source}/{eid_dir.name}/{f.name}",
                            })
            else:
                for f in child.iterdir():
                    if f.is_file() and f.suffix == ".txt":
                        out.append({
                            "handle": handle, "source": "gpt-vision",
                            "eid": child.name, "file": f.name, "path": f,
                            "rel": f"contributions/{handle}/{child.name}/{f.name}",
                        })
    return out


def page_num(filename):
    m = re.match(r"^p(\d+)\.txt$", filename)
    return int(m.group(1)) if m else None


def main():
    contribs = collect_contributions()
    if not contribs:
        print("[semantic] no contributions/ files to validate — exiting clean")
        VERDICT_OUT.parent.mkdir(parents=True, exist_ok=True)
        VERDICT_OUT.write_text(json.dumps({"verdicts": [], "summary": "no submissions"}))
        return 0

    if not EMB_BIN.exists():
        print(f"[semantic] FAIL — no {EMB_BIN}. Run `python scripts/build-embeddings.py` first.")
        return 1

    eids = load_events()
    info = json.loads(EMB_INFO.read_text())
    dim, count = info["dim"], info["count"]
    vecs = np.fromfile(EMB_BIN, dtype=np.float32).reshape(count, dim)
    meta = json.loads(EMB_META.read_text())

    # Pre-compute per-event doc centroids + per-(eid, page) indices
    by_eid = defaultdict(list)
    by_eid_page = {}
    for i, m in enumerate(meta):
        by_eid[m["eventId"]].append(i)
        if m.get("kind") != "meta":
            by_eid_page[(m["eventId"], m["page"])] = i
    centroids = {}
    for eid, idxs in by_eid.items():
        v = vecs[idxs].mean(axis=0)
        n = np.linalg.norm(v)
        centroids[eid] = (v / n if n > 0 else v).astype(np.float32)

    index = faiss.IndexFlatIP(dim)
    index.add(vecs)
    print(f"[semantic] FAISS index built — {index.ntotal} vectors x {dim}d")

    print(f"[semantic] loading {MODEL_NAME} …")
    model = SentenceTransformer(MODEL_NAME)

    # Encode every contribution in one pass
    texts = []
    for c in contribs:
        try:
            texts.append(c["path"].read_text(encoding="utf-8", errors="ignore").strip())
        except Exception as e:
            texts.append("")
            c["read_error"] = str(e)
    contrib_vecs = model.encode(texts, normalize_embeddings=True, show_progress_bar=False).astype(np.float32)

    verdicts = []
    pass_n = review_n = reject_n = 0
    print(f"\n[semantic] gate 4 evaluation — {len(contribs)} file(s)")
    print(f"  {'file':56s} 4a doc-affinity   4b canon         4c neighbors    verdict")
    print(f"  {'-'*120}")

    for c, qv in zip(contribs, contrib_vecs):
        verdict = {"rel": c["rel"], "eid": c["eid"], "handle": c["handle"], "file": c["file"]}

        if c.get("read_error"):
            verdict["status"] = "reject"
            verdict["reason"] = f"read error: {c['read_error']}"
            verdicts.append(verdict); reject_n += 1; continue

        if c["eid"] not in eids:
            verdict["status"] = "reject"
            verdict["reason"] = f"unknown event id: {c['eid']}"
            verdicts.append(verdict); reject_n += 1; continue

        # 4a: document affinity via top-5 FAISS search
        D, I = index.search(qv.reshape(1, -1), 5)
        nearest_eids = [meta[i]["eventId"] for i in I[0]]
        same_in_top5 = c["eid"] in nearest_eids
        top1_same = (nearest_eids[0] == c["eid"]) if nearest_eids else False
        centroid_cos = float(qv @ centroids[c["eid"]]) if c["eid"] in centroids else 0.0
        if same_in_top5:
            v4a = "pass"
        elif centroid_cos >= DOC_AFFINITY_REVIEW:
            v4a = "review"
        else:
            v4a = "reject"
        verdict["4a"] = {
            "verdict": v4a,
            "top1_eid": nearest_eids[0] if nearest_eids else None,
            "top1_cos": float(D[0][0]),
            "same_in_top5": same_in_top5,
            "centroid_cos": round(centroid_cos, 3),
        }

        # 4b: canonical agreement (only if a canonical vision-cache page exists)
        pnum = page_num(c["file"])
        canon_cos = None; v4b = "n/a"
        if pnum is not None:
            for cand in (VIS_CACHE / c["eid"] / f"p{pnum:04d}.txt",
                         VIS_CACHE / c["eid"] / f"p{pnum}.txt"):
                if cand.exists():
                    canon_text = cand.read_text(encoding="utf-8", errors="ignore").strip()
                    if canon_text:
                        cv = model.encode([canon_text], normalize_embeddings=True).astype(np.float32)[0]
                        canon_cos = float(qv @ cv)
                        if canon_cos >= CANON_PASS:           v4b = "pass-strong"
                        elif canon_cos >= CANON_OVERLAP:       v4b = "pass-overlap"
                        elif canon_cos >= CANON_REVIEW:        v4b = "review"
                        else:                                   v4b = "reject"
                    break
        verdict["4b"] = {"verdict": v4b, "canon_cos": None if canon_cos is None else round(canon_cos, 3)}

        # 4c: in-doc continuity (cos to mean of ±1 neighbor page indices, if present)
        neigh_vecs = []
        if pnum is not None:
            for np_ in (pnum - 1, pnum + 1):
                idx = by_eid_page.get((c["eid"], np_))
                if idx is not None: neigh_vecs.append(vecs[idx])
        v4c = "n/a"; neigh_cos = None
        if neigh_vecs:
            nv = np.mean(neigh_vecs, axis=0); n = np.linalg.norm(nv)
            if n > 0: nv = nv / n
            neigh_cos = float(qv @ nv)
            if neigh_cos >= NEIGHBOR_PASS:        v4c = "pass"
            elif neigh_cos >= NEIGHBOR_REVIEW:    v4c = "review"
            else:                                  v4c = "reject"
        verdict["4c"] = {"verdict": v4c, "neighbor_cos": None if neigh_cos is None else round(neigh_cos, 3),
                         "neighbors_found": len(neigh_vecs)}

        # combined
        gate_results = [v4a, v4b, v4c]
        if any(g == "reject" for g in gate_results):
            status = "reject"
        elif any(g == "review" for g in gate_results):
            status = "review"
        else:
            status = "pass"
        verdict["status"] = status

        def fmt(v): return f"{v.get('verdict','-'):8s}"
        print(f"  {c['rel']:56s} {fmt(verdict['4a']):20s} {fmt(verdict['4b']):14s} {fmt(verdict['4c']):14s} {status.upper()}")
        verdicts.append(verdict)
        if status == "pass": pass_n += 1
        elif status == "review": review_n += 1
        else: reject_n += 1

    summary = f"{pass_n} pass · {review_n} review · {reject_n} reject"
    print(f"\n[semantic] {summary}")

    VERDICT_OUT.parent.mkdir(parents=True, exist_ok=True)
    VERDICT_OUT.write_text(json.dumps({"verdicts": verdicts, "summary": summary,
                                        "pass": pass_n, "review": review_n, "reject": reject_n}, indent=2))

    return 1 if reject_n > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
