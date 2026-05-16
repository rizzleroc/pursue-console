// Generate public/work-available.json — the public work queue volunteers poll.
//
// For each catalogued event:
//   - How many pages does the source PDF have? (from manifest.json)
//   - How many have been vision-OCR'd? (from data-raw/.vision-cache page count)
//   - Which pages still need vision OCR? (the gap)
//   - What's the source URL? (from events.js for download)
//
// Output schema:
//   {
//     generatedAt, totalPagesNeeded, totalDocsRemaining,
//     byEvent: {
//       <eid>: {
//         title, agency, pdfUrl,
//         totalPages, pagesCompleted, pagesNeeded,
//         queue: [<pageNumber>, ...]     // pages 1-indexed, monotonic
//       }
//     }
//   }

import { readFile, writeFile, readdir, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VIS = path.join(ROOT, "data-raw/.vision-cache");
const MANIFEST = path.join(ROOT, "public/text/manifest.json");
const OUT = path.join(ROOT, "public/work-available.json");

const { EVENTS } = await import("../src/data/events.js");

// CI: the vision cache is gitignored and not present in fresh checkouts.
// Leave whatever was committed in public/work-available.json alone in that
// case — the maintainer regenerates locally and commits after each batch.
if (!existsSync(VIS)) {
  console.log("[work-available] no .vision-cache locally — leaving public/work-available.json untouched.");
  process.exit(0);
}

let manifest = {};
try { manifest = JSON.parse(await readFile(MANIFEST, "utf8")); } catch {}

async function visionPageCount(eid) {
  const dir = path.join(VIS, eid);
  if (!existsSync(dir)) return new Set();
  const files = await readdir(dir);
  const set = new Set();
  for (const f of files) {
    const m = f.match(/^p(\d+)\.txt$/);
    if (!m) continue;
    // a vision page counts only if the cache file has real content (not the
    // empty placeholder we write on render error / abandoned attempts)
    try {
      const txt = await readFile(path.join(dir, f), "utf8");
      if (txt.trim().length > 5) set.add(Number(m[1]));
    } catch {}
  }
  return set;
}

const byEvent = {};
let totalPagesNeeded = 0;
let totalDocsRemaining = 0;

for (const ev of EVENTS) {
  // Only care about events whose source is OCR/mixed (i.e., scanned PDFs needing
  // vision uplift). pdfjs-clean text-layer docs and pure-curated entries skip.
  const m = manifest[ev.id];
  if (!m) continue;
  if (!["ocr", "mixed", "vision"].includes(m.source)) continue;
  const totalPages = m.pages || 0;
  if (totalPages === 0) continue;

  const visionPages = await visionPageCount(ev.id);
  const queue = [];
  for (let p = 1; p <= totalPages; p++) {
    if (!visionPages.has(p)) queue.push(p);
  }
  if (queue.length === 0) continue;  // doc is fully vision-OCR'd

  byEvent[ev.id] = {
    title: ev.title,
    agency: ev.agency,
    date: ev.date,
    pdfUrl: ev.url || null,
    totalPages,
    pagesCompleted: visionPages.size,
    pagesNeeded: queue.length,
    queue,
  };
  totalPagesNeeded += queue.length;
  totalDocsRemaining++;
}

const out = {
  generatedAt: new Date().toISOString(),
  totalPagesNeeded,
  totalDocsRemaining,
  inventoryTotal: 162,
  cataloguedTotal: EVENTS.length,
  byEvent,
};

await writeFile(OUT, JSON.stringify(out));
const { stat } = await import("node:fs/promises");
const sz = (await stat(OUT)).size;
console.log(`[work-available] wrote ${OUT}  ${(sz/1024).toFixed(0)} KB  ${totalDocsRemaining} docs · ${totalPagesNeeded} pages need vision OCR`);
// Top 5 biggest remaining
const top = Object.entries(byEvent).sort((a,b) => b[1].pagesNeeded - a[1].pagesNeeded).slice(0,5);
for (const [eid, w] of top) {
  console.log(`  ${eid.padEnd(28)} ${w.pagesCompleted}/${w.totalPages} done · ${w.pagesNeeded} need vision`);
}
