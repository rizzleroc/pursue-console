// Aggregate corpus-wide signature patterns from the extracted-text corpus
// (vision + OCR + pdfjs). Reads per-doc signatures from public/dossier-
// extracts.json and pivots them: signature → events that exhibit it, with
// per-event mention counts and overall occurrence totals.
//
// Output: public/patterns.json
//   {
//     generatedAt, sourceDocs, totalEvents,
//     byKind: {
//       shape:    [{ term, total, docCount, events: [{eid, count}] }, ...],
//       behavior: [...],
//       sensor:   [...],
//       entity:   [...],   // proper-noun mentions across the corpus
//       date:     [...]    // dates referenced anywhere
//     }
//   }
//
// Consumed by PatternsView's TEXT-MINED SIGNATURES section.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const EXTRACTS = path.join(ROOT, "public/dossier-extracts.json");
const OUT = path.join(ROOT, "public/patterns.json");

if (!existsSync(EXTRACTS)) {
  console.log("[patterns] no dossier-extracts.json — leaving public/patterns.json untouched.");
  process.exit(0);
}

const raw = JSON.parse(await readFile(EXTRACTS, "utf8"));

const byKind = { shape: new Map(), behavior: new Map(), sensor: new Map(), entity: new Map(), date: new Map() };

function bump(map, term, eid, count) {
  if (!map.has(term)) map.set(term, { term, total: 0, events: new Map() });
  const row = map.get(term);
  row.total += count;
  row.events.set(eid, (row.events.get(eid) || 0) + count);
}

let docCount = 0;
for (const [eid, doc] of Object.entries(raw)) {
  if (!doc?.profile) continue;
  docCount++;
  const sig = doc.profile.signatures || {};
  for (const cat of ["shape", "behavior", "sensor"]) {
    const entries = sig[cat] || {};
    for (const [term, n] of Object.entries(entries)) bump(byKind[cat], term, eid, n);
  }
  for (const e of doc.profile.entities || []) bump(byKind.entity, e.name, eid, e.count);
  for (const d of doc.profile.dates || []) bump(byKind.date, d, eid, 1);
}

function freeze(map, minDocs = 1) {
  return [...map.values()]
    .filter(r => r.events.size >= minDocs)
    .map(r => ({
      term: r.term,
      total: r.total,
      docCount: r.events.size,
      events: [...r.events.entries()]
        .map(([eid, count]) => ({ eid, count }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.docCount - a.docCount || b.total - a.total);
}

const out = {
  generatedAt: new Date().toISOString(),
  sourceDocs: docCount,
  byKind: {
    // Per the design, signatures need to appear in >=1 doc; entities/dates >=2 to filter noise
    shape:    freeze(byKind.shape,    1),
    behavior: freeze(byKind.behavior, 1),
    sensor:   freeze(byKind.sensor,   1),
    entity:   freeze(byKind.entity,   2),
    date:     freeze(byKind.date,     2),
  },
};

await writeFile(OUT, JSON.stringify(out));
const { stat } = await import("node:fs/promises");
const sz = (await stat(OUT)).size;
console.log(`[patterns] wrote ${OUT}  ${(sz/1024).toFixed(0)} KB  ${docCount} docs`);

for (const cat of ["shape", "behavior", "sensor"]) {
  const top = out.byKind[cat].slice(0, 4).map(r => `${r.term}(${r.docCount}d/${r.total}m)`).join("  ");
  console.log(`  ${cat.padEnd(8)} ${top}`);
}
const topE = out.byKind.entity.slice(0, 6).map(r => `${r.term}(${r.docCount})`).join("  ");
console.log(`  entity   ${topE}`);
