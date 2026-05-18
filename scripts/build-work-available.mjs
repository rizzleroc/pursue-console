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

// Per-event review-queue page numbers — read sidecars for pages flagged
// needs_review by scripts/compare-sources.mjs (cross-source disagreement
// loud enough to warrant human eyes).
async function reviewPagesForEvent(eid) {
  const dir = path.join(VIS, eid);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of await readdir(dir)) {
    const m = f.match(/^p(\d+)\.sources\.json$/);
    if (!m) continue;
    try {
      const sc = JSON.parse(await readFile(path.join(dir, f), "utf8"));
      if (sc.comparison?.needs_review) out.push(Number(m[1]));
    } catch {}
  }
  return out.sort((a, b) => a - b);
}

// Per-event visuals-needing-context queue. A page qualifies when the
// classifier has tagged it non-text-only AND no human contributor has
// supplied title+context yet (classifier still starts with "chatgpt"/
// "gemini" — not "human:<handle>"). Each entry carries the kind so the
// volunteer flow can present the right capture template.
const VISUALS_DIR = path.join(ROOT, "data-raw", ".visuals");
const VISIBLE_KINDS = new Set(["photograph", "hand-drawing", "photocopied-negative", "newspaper-clipping", "map", "diagram"]);
async function visualsNeedingContextForEvent(eid) {
  const dir = path.join(VISUALS_DIR, eid);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of await readdir(dir)) {
    const m = f.match(/^p(\d+)\.json$/);
    if (!m) continue;
    try {
      const sc = JSON.parse(await readFile(path.join(dir, f), "utf8"));
      if (!VISIBLE_KINDS.has(sc.kind)) continue;
      const classifier = sc.classifier || "";
      if (classifier.startsWith("human:")) continue;  // already has human-curated context
      out.push({
        page: Number(m[1]),
        kind: sc.kind,
        suggestedTitle: sc.title || "",
        suggestedDescription: sc.description || "",
      });
    } catch {}
  }
  return out.sort((a, b) => a.page - b.page);
}

const byEvent = {};
let totalPagesNeeded = 0;
let totalDocsRemaining = 0;
let totalPagesNeedingReview = 0;
let totalPagesNeedingVisualContext = 0;

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
  // Pages where Gemini + GPT-vision (or any 2 sources) disagree enough
  // to warrant a human typing it up. These are higher-leverage than
  // "more OCR" — fixing one disputed page improves canonical quality
  // forever, vs adding one more sometimes-wrong machine pass.
  const reviewQueue = await reviewPagesForEvent(ev.id);
  const visualsQueue = await visualsNeedingContextForEvent(ev.id);

  // If a doc has no work AND no review queue AND no visuals queue, skip.
  if (queue.length === 0 && reviewQueue.length === 0 && visualsQueue.length === 0) continue;

  byEvent[ev.id] = {
    title: ev.title,
    agency: ev.agency,
    date: ev.date,
    pdfUrl: ev.url || null,
    totalPages,
    pagesCompleted: visionPages.size,
    pagesNeeded: queue.length,
    pagesNeedingReview: reviewQueue.length,
    pagesNeedingVisualContext: visualsQueue.length,
    queue,
    reviewQueue,
    visualsNeedingContext: visualsQueue,
  };
  totalPagesNeeded += queue.length;
  totalPagesNeedingReview += reviewQueue.length;
  totalPagesNeedingVisualContext += visualsQueue.length;
  if (queue.length > 0) totalDocsRemaining++;
}

const out = {
  generatedAt: new Date().toISOString(),
  totalPagesNeeded,
  totalDocsRemaining,
  totalPagesNeedingReview,
  totalPagesNeedingVisualContext,
  inventoryTotal: 162,
  cataloguedTotal: EVENTS.length,
  byEvent,
};

await writeFile(OUT, JSON.stringify(out));
const { stat } = await import("node:fs/promises");
const sz = (await stat(OUT)).size;
console.log(`[work-available] wrote ${OUT}  ${(sz/1024).toFixed(0)} KB  ${totalDocsRemaining} docs · ${totalPagesNeeded} pages need vision OCR · ${totalPagesNeedingReview} pages need human review · ${totalPagesNeedingVisualContext} pages need visual context`);
// Top 5 biggest remaining
const top = Object.entries(byEvent).sort((a,b) => b[1].pagesNeeded - a[1].pagesNeeded).slice(0,5);
for (const [eid, w] of top) {
  console.log(`  ${eid.padEnd(28)} ${w.pagesCompleted}/${w.totalPages} done · ${w.pagesNeeded} need vision`);
}
