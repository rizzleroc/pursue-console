// Emit public/multi-source-review.json — per-page text from each
// available source (gemini vision, tesseract OCR) so the static /mc/
// REVIEW surface can render real side-by-side comparisons.
//
// Source files:
//   data-raw/.vision-cache/<eid>/p<NNNN>.gemini.txt   — Gemini 2.0 vision
//   data-raw/.ocr-cache/<eid>/p<NNNN>.txt              — Tesseract OCR
//
// Output:
//   public/multi-source-review.json
//   {
//     generatedAt,
//     count,
//     pages: {
//       "<eid>": {
//         "<page>": { gemini: "…", ocr: "…", agreement?: number }
//       }
//     }
//   }
//
// We cap to MAX_PAGES_PER_EVENT pages per event and MAX_EVENTS events
// total so public/ stays under ~5MB.

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VIS = path.join(ROOT, "data-raw", ".vision-cache");
const OCR = path.join(ROOT, "data-raw", ".ocr-cache");
const OUT = path.join(ROOT, "public", "multi-source-review.json");

const MAX_PAGES_PER_EVENT = 20;
const MAX_EVENTS = 30;
const MAX_CHARS = 6000; // truncate very long pages

async function existsDir(p) { try { return (await stat(p)).isDirectory(); } catch { return false; } }
async function readIf(p) {
  try { return (await readFile(p, "utf8")).trim(); } catch { return null; }
}

// Trivial agreement metric — fraction of OCR tokens that appear in vision
// text. Used to surface the most-divergent pages first.
function tokenAgreement(a, b) {
  if (!a || !b) return 0;
  const at = a.toLowerCase().split(/[^a-z0-9']+/).filter((t) => t.length >= 3);
  const bSet = new Set(b.toLowerCase().split(/[^a-z0-9']+/).filter((t) => t.length >= 3));
  if (!at.length) return 0;
  let hits = 0;
  for (const t of at) if (bSet.has(t)) hits++;
  return hits / at.length;
}

const events = (await existsDir(VIS)) ? (await readdir(VIS)) : [];
const out = { generatedAt: new Date().toISOString(), count: 0, pages: {} };

let evCount = 0;
for (const eid of events) {
  if (evCount >= MAX_EVENTS) break;
  const visDir = path.join(VIS, eid);
  if (!(await existsDir(visDir))) continue;
  const ocrDir = path.join(OCR, eid);
  const files = (await readdir(visDir))
    .filter((f) => f.match(/^p\d+\.gemini\.txt$/))
    .sort()
    .slice(0, MAX_PAGES_PER_EVENT);
  if (!files.length) continue;
  const eventPages = {};
  for (const f of files) {
    const m = f.match(/^p(\d+)\.gemini\.txt$/);
    if (!m) continue;
    const pageNum = parseInt(m[1], 10);
    const visTxt = await readIf(path.join(visDir, f));
    const ocrTxt = await readIf(path.join(ocrDir, `p${m[1]}.txt`));
    if (!visTxt && !ocrTxt) continue;
    const entry = {};
    if (visTxt) entry.gemini = visTxt.slice(0, MAX_CHARS);
    if (ocrTxt) entry.ocr = ocrTxt.slice(0, MAX_CHARS);
    if (visTxt && ocrTxt) entry.agreement = +tokenAgreement(visTxt, ocrTxt).toFixed(3);
    eventPages[pageNum] = entry;
  }
  if (Object.keys(eventPages).length) {
    out.pages[eid] = eventPages;
    evCount++;
  }
}

out.count = Object.values(out.pages).reduce((n, ps) => n + Object.keys(ps).length, 0);
await writeFile(OUT, JSON.stringify(out));
console.log(
  `[multi-source-review] wrote ${path.relative(ROOT, OUT)} — ${evCount} events · ${out.count} pages`
);
