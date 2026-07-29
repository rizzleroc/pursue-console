// =====================================================================
// build-vector-map.mjs — Project the corpus's event-level embeddings
// into 2D via UMAP so the browser can render an Obsidian-style graph
// view of the semantic space (every record = one dot; distance =
// semantic distance).
//
// Runs at build time. Deterministic (fixed random seed) so successive
// builds produce visually consistent maps.
//
// Input:
//   public/embeddings.bin
//   public/embeddings-meta.json
//   public/embeddings-info.json
//
// Output:
//   public/vector-map.json  →  { generatedAt, count, dim, items: [
//     { eid, x, y }   — x/y normalized to [0, 1]
//   ]}
//
// The browser (VectorMapView) already knows title/agency/flag/date
// from events.js; we only need to ship the coords, so this file
// stays small (~5 KB for ~150 events). Mean-vector-per-event logic
// mirrors scripts/build-event-similarity.mjs — same input, same
// grouping, so the layout is consistent with the NETWORK view's
// SEMANTIC mode.
// =====================================================================
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UMAP } from "umap-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BIN  = path.join(ROOT, "public/embeddings.bin");
const META = path.join(ROOT, "public/embeddings-meta.json");
const INFO = path.join(ROOT, "public/embeddings-info.json");
const OUT  = path.join(ROOT, "public/vector-map.json");

// Seeded PRNG — UMAP needs a random function; a deterministic seed
// makes each rebuild produce the same layout so PRs don't churn on
// visually-random rotation/mirroring of the map.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  if (!existsSync(BIN) || !existsSync(META) || !existsSync(INFO)) {
    console.log("[vector-map] embeddings not built yet — skipping. Run build-embeddings.py first.");
    process.exit(0);
  }
  const info = JSON.parse(await readFile(INFO, "utf8"));
  const meta = JSON.parse(await readFile(META, "utf8"));
  const raw  = await readFile(BIN);
  const dim = info.dim;
  const count = info.count;
  const all = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  if (all.length !== dim * count) {
    throw new Error(`size mismatch ${all.length} vs ${dim}*${count}`);
  }

  // Group chunk indexes by eventId, mirroring build-event-similarity.mjs
  // so the layout is coherent with what NETWORK's SEMANTIC mode shows.
  const byEvent = new Map();
  for (let i = 0; i < meta.length; i++) {
    const eid = meta[i].eventId;
    if (!byEvent.has(eid)) byEvent.set(eid, []);
    byEvent.get(eid).push(i);
  }
  const eids = [...byEvent.keys()];
  const N = eids.length;
  if (N < 5) {
    console.error(`ERR: only ${N} events — UMAP needs at least 5.`);
    process.exit(1);
  }

  // Mean-then-L2-normalize per event.
  const eventVecs = [];
  for (let e = 0; e < N; e++) {
    const idxs = byEvent.get(eids[e]);
    const v = new Float64Array(dim);
    for (const ci of idxs) {
      const base = ci * dim;
      for (let k = 0; k < dim; k++) v[k] += all[base + k];
    }
    let norm = 0;
    for (let k = 0; k < dim; k++) norm += v[k] * v[k];
    norm = Math.sqrt(norm) || 1;
    const out = new Array(dim);
    for (let k = 0; k < dim; k++) out[k] = v[k] / norm;
    eventVecs.push(out);
  }
  console.log(`UMAP · ${N} events × ${dim} dims → 2D`);

  const nNeighbors = Math.min(12, Math.max(3, Math.floor(N / 8)));
  const umap = new UMAP({
    nComponents: 2,
    // Small corpus (100-200 events): keep nNeighbors low so the map
    // preserves local structure. Too high (default 15) with N≈130
    // starts blending clusters into a single blob.
    nNeighbors,
    // minDist controls how tightly clusters pack. 0.15 is a compromise
    // between "readable dot separation" and "clusters look like clusters."
    minDist: 0.15,
    random: mulberry32(0xC0DEFACE),
  });
  const projected = umap.fit(eventVecs);   // → [[x,y], ...]

  // Normalize to [0, 1] on each axis so the frontend can position
  // dots inside any container size without recomputing bounds.
  let minX =  Infinity, minY =  Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of projected) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const spanX = (maxX - minX) || 1;
  const spanY = (maxY - minY) || 1;
  const items = eids.map((eid, i) => ({
    eid,
    x: +((projected[i][0] - minX) / spanX).toFixed(5),
    y: +((projected[i][1] - minY) / spanY).toFixed(5),
  }));

  const out = {
    generatedAt: new Date().toISOString(),
    count: items.length,
    dim,
    params: { nComponents: 2, nNeighbors, minDist: 0.15, seed: "0xC0DEFACE" },
    items,
  };
  await writeFile(OUT, JSON.stringify(out), "utf8");
  const kb = (JSON.stringify(out).length / 1024).toFixed(1);
  console.log(`OK · wrote ${OUT} (${items.length} points, ${kb} KB)`);
}

main().catch(err => {
  console.error("[build-vector-map] FAILED:", err);
  process.exit(1);
});
