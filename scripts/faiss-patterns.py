#!/usr/bin/env python3
"""
FAISS pattern analysis over the PURSUE corpus.

Goal: validate FAISS works on the freshly converted (vision-OCR'd) data,
combine each event's chunks back into a single per-event representation,
and surface recurring cross-document patterns — time-of-day, shared
phenomenological descriptions, sensor modality.

Pipeline:
  1. Load public/embeddings.bin + embeddings-meta.json (873 chunks x 384d).
  2. Build a FAISS IndexFlatIP, validate add/search round-trips.
  3. Aggregate chunk vectors -> per-event mean vector (L2-normalized).
     This is the "combine converted data with original content" step:
     vision pages + tesseract OCR + pdfjs text + curated summary all
     contribute to one event vector.
  4. Regex-mine the raw text in public/text/*.txt for structured signals:
       - time-of-day  (clock times + phase words)
       - shape descriptors
       - behavior descriptors
       - sensor modality
  5. FAISS k-means cluster the per-event vectors.
  6. Run semantic probe queries through FAISS.
  7. Cross-tabulate: do semantic clusters share time-of-day / descriptors?

Run:  python scripts/faiss-patterns.py
"""
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import faiss

ROOT = Path(__file__).resolve().parent.parent
BIN = ROOT / "public" / "embeddings.bin"
META = ROOT / "public" / "embeddings-meta.json"
INFO = ROOT / "public" / "embeddings-info.json"
TEXT_DIR = ROOT / "public" / "text"
MANIFEST = ROOT / "public" / "text" / "manifest.json"
EVENTS_JS = ROOT / "src" / "data" / "events.js"

# ----------------------------------------------------------------------
# 0. Helpers — parse events.js for date/agency/title context
# ----------------------------------------------------------------------
def load_events():
    src = EVENTS_JS.read_text(encoding="utf-8")
    out = {}
    for m in re.finditer(r'\{\s*id:\s*"([^"]+)",(.*?)\}\s*,(?=\s*\{|\s*\];)', src, re.S):
        eid, body = m.group(1), m.group(2)
        def f(name):
            mm = re.search(rf'{name}:\s*"((?:\\.|[^"\\])*)"', body)
            return mm.group(1).replace('\\"', '"') if mm else ""
        out[eid] = {"title": f("title"), "date": f("date"), "agency": f("agency"),
                    "loc": f("loc"), "era": f("era"), "type": f("type")}
    return out


# ----------------------------------------------------------------------
# 1-2. Load embeddings, build + validate FAISS index
# ----------------------------------------------------------------------
def load_and_validate():
    info = json.loads(INFO.read_text())
    dim, count = info["dim"], info["count"]
    vecs = np.fromfile(BIN, dtype=np.float32)
    assert vecs.size == dim * count, f"bin size {vecs.size} != {dim}*{count}"
    vecs = vecs.reshape(count, dim)
    meta = json.loads(META.read_text())
    assert len(meta) == count, f"meta {len(meta)} != count {count}"

    index = faiss.IndexFlatIP(dim)
    index.add(vecs)
    # validate: every vector's nearest neighbour is itself at cos~1.0
    D, I = index.search(vecs[:20], 1)
    self_hit = np.mean(I[:, 0] == np.arange(20))
    self_cos = np.mean(D[:, 0])
    print(f"[faiss] index built: {index.ntotal} vectors x {dim}d")
    print(f"[faiss] validation — self-NN accuracy {self_hit*100:.0f}%, mean self-cos {self_cos:.4f}  "
          f"{'PASS' if self_hit == 1.0 and self_cos > 0.99 else 'FAIL'}")
    return vecs, meta, info, index, dim


# ----------------------------------------------------------------------
# 3. Combine converted + original content -> per-event vectors
# ----------------------------------------------------------------------
def per_event_vectors(vecs, meta, dim):
    buckets = defaultdict(list)
    src_mix = defaultdict(Counter)
    for i, m in enumerate(meta):
        buckets[m["eventId"]].append(i)
        # infer source of chunk
        kind = m.get("kind", "page")
        src_mix[m["eventId"]][kind] += 1
    ev_ids, ev_vecs = [], []
    for eid, idxs in buckets.items():
        v = vecs[idxs].mean(axis=0)
        n = np.linalg.norm(v)
        if n > 0:
            v = v / n
        ev_ids.append(eid)
        ev_vecs.append(v)
    ev_vecs = np.array(ev_vecs, dtype=np.float32)
    print(f"[combine] {len(ev_ids)} per-event vectors "
          f"(mean of {len(meta)} chunks: vision+ocr+pdfjs+curated merged)")
    return ev_ids, ev_vecs, src_mix


# ----------------------------------------------------------------------
# 4. Regex-mine raw text for structured signals
# ----------------------------------------------------------------------
TIME_PHASE = {
    "night":   r"\b(night|nighttime|after dark|midnight|nocturnal)\b",
    "evening": r"\b(evening|dusk|sunset|twilight)\b",
    "morning": r"\b(morning|dawn|sunrise|daybreak)\b",
    "daytime": r"\b(noon|midday|daylight|afternoon|broad daylight)\b",
}
# Military / report clock times: 0300, 1430 hrs, 03:33, 2100Z, 11:00 p.m.
CLOCK = re.compile(r"\b([0-2]?\d[:.]?[0-5]\d)\s?(hrs?|hours|z|zulu|local|gmt|a\.?m\.?|p\.?m\.?)\b", re.I)
CLOCK_BARE = re.compile(r"\b([01]\d|2[0-3])[0-5]\d\b")  # 0000-2359 bare

SHAPE = {
    "disc/disk":    r"\b(disc|disk|saucer|disc-shaped|disk-shaped)\b",
    "sphere/orb":   r"\b(sphere|spherical|orb|ball|round object|globe)\b",
    "cylinder":     r"\b(cylinder|cylindrical|cigar|tube-shaped|rocket-shaped)\b",
    "triangle":     r"\b(triangle|triangular|delta|chevron|boomerang)\b",
    "oval/ellipsoid": r"\b(oval|ellipsoid|elliptical|egg-shaped|elongated)\b",
    "light(s)":     r"\b(light|lights|glow|glowing|luminous|bright object)\b",
}
BEHAVIOR = {
    "hover":         r"\b(hover|hovering|stationary|motionless|suspended)\b",
    "high-speed":    r"\b(high speed|high-speed|tremendous speed|terrific speed|rapid|extreme velocity)\b",
    "accelerate":    r"\b(accelerat\w+|sped (?:away|off)|shot (?:up|away|off)|darted)\b",
    "vertical":      r"\b(vertical|straight up|ascend\w*|climb\w*|rose rapidly)\b",
    "silent":        r"\b(silent|noiseless|no sound|without sound|soundless)\b",
    "instantaneous": r"\b(instantaneous\w*|vanished|disappeared instantly|blinked out|materializ\w+)\b",
    "erratic":       r"\b(erratic|zigzag|abrupt|sudden(?:ly)? (?:turn|stop)|right.angle)\b",
}
SENSOR = {
    "radar":    r"\b(radar|track(?:ed)? on scope|skin paint)\b",
    "infrared": r"\b(infrared|\bir\b|flir|thermal|forward.looking)\b",
    "visual":   r"\b(visual|naked eye|eyewitness|observed by|sighted by)\b",
    "eo/optical": r"\b(electro.optical|\beo\b|telescope|camera|photograph\w*)\b",
}

def mine_text(eid):
    fp = TEXT_DIR / f"{eid}.txt"
    if not fp.exists():
        return None
    raw = fp.read_text(encoding="utf-8", errors="ignore")
    body = raw.split("\n---\n", 1)[1] if "\n---\n" in raw else raw
    low = body.lower()
    out = {"chars": len(body)}
    out["phase"] = {k: len(re.findall(rx, low)) for k, rx in TIME_PHASE.items()}
    clock_hits = CLOCK.findall(low) + [(c, "bare") for c in CLOCK_BARE.findall(body)]
    out["clock_times"] = clock_hits
    # bucket clock times into 4 quarters of the day where parseable
    hours = []
    for t, _unit in clock_hits:
        digs = re.sub(r"[^0-9]", "", t)
        if len(digs) >= 3:
            h = int(digs[:-2]) if len(digs) == 4 else int(digs[0])
            if 0 <= h <= 23:
                hours.append(h)
    out["hours"] = hours
    out["shape"]    = {k: len(re.findall(rx, low)) for k, rx in SHAPE.items()}
    out["behavior"] = {k: len(re.findall(rx, low)) for k, rx in BEHAVIOR.items()}
    out["sensor"]   = {k: len(re.findall(rx, low)) for k, rx in SENSOR.items()}
    return out


# ----------------------------------------------------------------------
# 5. FAISS k-means clustering of per-event vectors
# ----------------------------------------------------------------------
def cluster(ev_vecs, k=6):
    d = ev_vecs.shape[1]
    km = faiss.Kmeans(d, k, niter=40, seed=42, verbose=False, spherical=True)
    km.train(ev_vecs)
    _, labels = km.index.search(ev_vecs, 1)
    return labels.ravel()


# ----------------------------------------------------------------------
# 6. Semantic probes
# ----------------------------------------------------------------------
PROBES = [
    "sighting occurred at night in darkness",
    "sighting occurred in daylight",
    "object hovered motionless then accelerated away at high speed",
    "completely silent with no engine noise",
    "object made instantaneous right-angle turns",
    "tracked simultaneously on radar and visually",
    "metallic disc-shaped craft",
    "formation of multiple lights moving together",
]

def run_probes(index, meta, model):
    qv = model.encode(PROBES, normalize_embeddings=True).astype(np.float32)
    D, I = index.search(qv, 6)
    print("\n" + "=" * 72)
    print("SEMANTIC PROBES — FAISS top-6 chunks per concept")
    print("=" * 72)
    for p, dist, idx in zip(PROBES, D, I):
        print(f"\n  ▸ \"{p}\"")
        seen = set()
        for s, i in zip(dist, idx):
            m = meta[i]
            tag = f"{m['eventId']}:p{m['page']}"
            if m["eventId"] in seen:
                continue
            seen.add(m["eventId"])
            print(f"      {s:.3f}  {tag:32s} {m.get('snippet','')[:58]}")


# ----------------------------------------------------------------------
# main
# ----------------------------------------------------------------------
def main():
    print("=" * 72)
    print("FAISS PATTERN ANALYSIS — PURSUE corpus")
    print("=" * 72)

    vecs, meta, info, index, dim = load_and_validate()
    events = load_events()
    ev_ids, ev_vecs, src_mix = per_event_vectors(vecs, meta, dim)

    # --- mine text for every event we have a vector for ---
    mined = {}
    for eid in ev_ids:
        m = mine_text(eid)
        if m:
            mined[eid] = m

    # ---- PATTERN 1: time-of-day across the whole corpus ----
    print("\n" + "=" * 72)
    print("PATTERN 1 — TIME OF DAY")
    print("=" * 72)
    phase_tot = Counter()
    docs_with_phase = Counter()
    all_hours = []
    for eid, mt in mined.items():
        for ph, n in mt["phase"].items():
            phase_tot[ph] += n
            if n:
                docs_with_phase[ph] += 1
        all_hours += mt["hours"]
    print(f"  phase-word mentions across {len(mined)} docs:")
    for ph, n in phase_tot.most_common():
        print(f"    {ph:9s} {n:4d} mentions in {docs_with_phase[ph]:2d} docs")
    if all_hours:
        quarters = Counter()
        for h in all_hours:
            quarters[("00-06 night" if h < 6 else "06-12 morning" if h < 12
                      else "12-18 afternoon" if h < 18 else "18-24 evening")] += 1
        print(f"\n  {len(all_hours)} parseable clock times -> quarter-day distribution:")
        for q, n in sorted(quarters.items()):
            bar = "#" * round(40 * n / max(quarters.values()))
            print(f"    {q:16s} {n:4d}  {bar}")
        night = quarters.get("00-06 night", 0) + quarters.get("18-24 evening", 0)
        day = quarters.get("06-12 morning", 0) + quarters.get("12-18 afternoon", 0)
        print(f"\n  >> dark hours (18:00-06:00): {night}   daylight (06:00-18:00): {day}"
              f"   ratio {night/max(day,1):.2f}:1")

    # ---- PATTERN 2: shared phenomenological descriptions ----
    print("\n" + "=" * 72)
    print("PATTERN 2 — SHARED DESCRIPTIONS (shape / behavior / sensor)")
    print("=" * 72)
    for label, keyset in [("SHAPE", SHAPE), ("BEHAVIOR", BEHAVIOR), ("SENSOR", SENSOR)]:
        tot = Counter()
        docs = Counter()
        for eid, mt in mined.items():
            key = label.lower()
            for k, n in mt[key].items():
                tot[k] += n
                if n:
                    docs[k] += 1
        print(f"\n  {label} — term mentions / # docs containing:")
        for k, n in tot.most_common():
            pct = 100 * docs[k] / len(mined)
            bar = "#" * round(30 * docs[k] / len(mined))
            print(f"    {k:18s} {n:4d} mentions  {docs[k]:2d}/{len(mined)} docs ({pct:3.0f}%)  {bar}")

    # co-occurrence: which behavior pairs appear together most
    print("\n  BEHAVIOR co-occurrence (docs sharing both):")
    bkeys = list(BEHAVIOR)
    pair_counts = Counter()
    for eid, mt in mined.items():
        present = [k for k in bkeys if mt["behavior"][k] > 0]
        for a in range(len(present)):
            for b in range(a + 1, len(present)):
                pair_counts[tuple(sorted((present[a], present[b])))] += 1
    for (a, b), n in pair_counts.most_common(8):
        print(f"    {a:16s} + {b:16s}  {n} docs")

    # ---- PATTERN 3: semantic clusters vs. structured signals ----
    print("\n" + "=" * 72)
    print("PATTERN 3 — SEMANTIC CLUSTERS (FAISS k-means) vs STRUCTURED SIGNALS")
    print("=" * 72)
    k = 6
    labels = cluster(ev_vecs, k)
    for c in range(k):
        members = [ev_ids[i] for i in range(len(ev_ids)) if labels[i] == c]
        if not members:
            continue
        # dominant descriptors in this cluster
        sh = Counter(); bh = Counter(); ph = Counter()
        for eid in members:
            if eid not in mined:
                continue
            for kk, n in mined[eid]["shape"].items():
                if n: sh[kk] += 1
            for kk, n in mined[eid]["behavior"].items():
                if n: bh[kk] += 1
            for kk, n in mined[eid]["phase"].items():
                if n: ph[kk] += 1
        eras = Counter(events.get(e, {}).get("era", "?") for e in members)
        print(f"\n  cluster {c}  ({len(members)} events)")
        sample = ", ".join(members[:5]) + ("…" if len(members) > 5 else "")
        print(f"    members : {sample}")
        print(f"    eras    : {dict(eras.most_common())}")
        if sh: print(f"    shapes  : {', '.join(f'{x}({n})' for x,n in sh.most_common(3))}")
        if bh: print(f"    behavior: {', '.join(f'{x}({n})' for x,n in bh.most_common(3))}")
        if ph: print(f"    time    : {', '.join(f'{x}({n})' for x,n in ph.most_common(3))}")

    # ---- semantic probes ----
    try:
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
        run_probes(index, meta, model)
    except Exception as e:
        print(f"\n[probes] skipped — {e}")

    # ---- headline findings ----
    print("\n" + "=" * 72)
    print("HEADLINE PATTERNS")
    print("=" * 72)
    if all_hours:
        print(f"  • {len(all_hours)} clock times extracted; {night}/{night+day} "
              f"({100*night/max(night+day,1):.0f}%) fall in dark hours.")
    top_shape = max(((k, sum(1 for e in mined if mined[e]['shape'][k]>0)) for k in SHAPE), key=lambda x: x[1])
    top_beh = max(((k, sum(1 for e in mined if mined[e]['behavior'][k]>0)) for k in BEHAVIOR), key=lambda x: x[1])
    print(f"  • most universal shape descriptor : '{top_shape[0]}' in {top_shape[1]}/{len(mined)} docs")
    print(f"  • most universal behavior         : '{top_beh[0]}' in {top_beh[1]}/{len(mined)} docs")
    if pair_counts:
        (a, b), n = pair_counts.most_common(1)[0]
        print(f"  • strongest behavior pairing      : '{a}' + '{b}' co-occur in {n} docs")
    print("=" * 72)


if __name__ == "__main__":
    main()
