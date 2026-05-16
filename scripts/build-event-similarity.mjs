// Compute per-event mean vectors from public/embeddings.bin, then save the
// top-K semantically nearest neighbors per event to public/event-similarity.json.
//
// Output schema:
//   {
//     generatedAt: "2026-05-16T...",
//     dim: 384,
//     events: { [eid]: { vec: [384 floats], neighbors: [{ eid, cos }, ...top 8] } }
//   }
//
// Consumed by:
//   - DossierView "SEMANTICALLY RELATED RECORDS" panel
//   - NetworkView "SEMANTIC" mode (event↔event edges weighted by cos)
//   - Anywhere else that wants to ride the FAISS-derived semantic structure
//
// Per-event vector = L2-normalized mean of all that event's chunk vectors
// (curated + page + visual chunks all contribute, equally weighted). The
// resulting unit vector represents "what is this document about, semantically."
// Cosine similarity between events is a real, useful measure derived from
// the FAISS index we already built.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BIN = path.join(ROOT, "public/embeddings.bin");
const META = path.join(ROOT, "public/embeddings-meta.json");
const INFO = path.join(ROOT, "public/embeddings-info.json");
const OUT = path.join(ROOT, "public/event-similarity.json");

const TOP_K = Number(process.env.TOP_K || 10);
const MIN_COS = Number(process.env.MIN_COS || 0.30);  // hide weak edges

// Bail gracefully if embeddings haven't been built yet (fresh-clone CI run).
// The committed event-similarity.json (if any) stays in place.
if (!existsSync(BIN) || !existsSync(META) || !existsSync(INFO)) {
  console.log("[similarity] no embeddings.bin yet — leaving public/event-similarity.json untouched.");
  process.exit(0);
}

const info = JSON.parse(await readFile(INFO, "utf8"));
const meta = JSON.parse(await readFile(META, "utf8"));
const raw = await readFile(BIN);
const dim = info.dim;
const count = info.count;
const all = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
if (all.length !== dim * count) throw new Error(`size mismatch ${all.length} vs ${dim}*${count}`);

// Group chunk indexes by eventId
const byEvent = new Map();
for (let i = 0; i < meta.length; i++) {
  const eid = meta[i].eventId;
  if (!byEvent.has(eid)) byEvent.set(eid, []);
  byEvent.get(eid).push(i);
}

// Build mean unit vector per event
const eids = [...byEvent.keys()];
const N = eids.length;
const eventVecs = new Float32Array(N * dim);
for (let e = 0; e < N; e++) {
  const idxs = byEvent.get(eids[e]);
  const offset = e * dim;
  for (const ci of idxs) {
    const base = ci * dim;
    for (let k = 0; k < dim; k++) eventVecs[offset + k] += all[base + k];
  }
  // L2 normalize
  let norm = 0;
  for (let k = 0; k < dim; k++) { const v = eventVecs[offset + k]; norm += v * v; }
  norm = Math.sqrt(norm) || 1;
  for (let k = 0; k < dim; k++) eventVecs[offset + k] /= norm;
}

// Cosine between all pairs; keep top-K per event
const events = {};
for (let e = 0; e < N; e++) {
  const offset = e * dim;
  const scores = [];
  for (let f = 0; f < N; f++) {
    if (f === e) continue;
    let s = 0;
    const fOff = f * dim;
    for (let k = 0; k < dim; k++) s += eventVecs[offset + k] * eventVecs[fOff + k];
    if (s >= MIN_COS) scores.push({ idx: f, cos: s });
  }
  scores.sort((a, b) => b.cos - a.cos);
  events[eids[e]] = {
    chunks: byEvent.get(eids[e]).length,
    neighbors: scores.slice(0, TOP_K).map(s => ({ eid: eids[s.idx], cos: Number(s.cos.toFixed(4)) })),
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  dim,
  eventCount: N,
  topK: TOP_K,
  minCos: MIN_COS,
  events,
};

await writeFile(OUT, JSON.stringify(out));
const { stat } = await import("node:fs/promises");
const sz = (await stat(OUT)).size;
console.log(`[similarity] wrote ${OUT}  ${(sz/1024).toFixed(0)} KB  ${N} events · top-${TOP_K} neighbors · ≥${MIN_COS} cos`);

// Quick demo for the log
const sample = ["cometa", "presidential-1963", "apollo-11", "krasuski-1944"].filter(id => events[id]);
for (const id of sample) {
  const top3 = events[id].neighbors.slice(0, 3).map(n => `${n.eid}(${n.cos.toFixed(3)})`).join("  ");
  console.log(`  ${id.padEnd(28)} → ${top3}`);
}
