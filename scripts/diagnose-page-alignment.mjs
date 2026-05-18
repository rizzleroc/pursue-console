// Sanity-check that page N in one source IS page N in another source.
//
// We have two upstream renderers (pdfjs via vision-ocr.mjs, PyMuPDF via
// Denis's Gemini pipeline) writing page N of the same PDF independently.
// If the page numbering ever drifts — Denis skips a cover, pdfjs treats
// a render error as a present page, anything — the cross-source
// comparison silently scores apples vs oranges and the agreement
// numbers are meaningless.
//
// For each event that has BOTH p<N>.gemini.txt and p<N>.gpt-vision.txt
// for many pages, this script:
//   1. Computes token-Jaccard for the aligned pair (N, N)
//   2. Also computes (N, N-1) and (N, N+1)
//   3. If the mean off-by-one overlap > mean aligned overlap, flags
//      the event as misaligned and reports which shift fits better
//
// Run: node scripts/diagnose-page-alignment.mjs
// Optional: NODE_DEBUG_DOC=<eid> to dump per-page scores for one doc

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VIS = path.join(ROOT, "data-raw", ".vision-cache");
const DEBUG_DOC = process.env.NODE_DEBUG_DOC || null;

// Only events with at least this many overlapping pages get a verdict —
// fewer than that and the signal/noise isn't worth it.
const MIN_PAIRS = 4;
// An "alignment" is considered better than another if the mean Jaccard
// exceeds it by this margin. Smaller = more sensitive to false alarms.
const SIGNIFICANCE = 0.06;

function tokens(text) {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || []).slice(0, 600));
}
function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
function mean(xs) { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }

async function loadPages(dir, source) {
  // Returns Map<pageNum, tokenSet>
  const out = new Map();
  if (!existsSync(dir)) return out;
  const files = await readdir(dir);
  const re = new RegExp(`^p(\\d+)\\.${source}\\.txt$`);
  for (const f of files) {
    const m = f.match(re);
    if (!m) continue;
    const pn = Number(m[1]);
    try {
      const text = (await readFile(path.join(dir, f), "utf8")).trim();
      if (text.length >= 40) out.set(pn, tokens(text));
    } catch {}
  }
  return out;
}

async function listEventDirs() {
  try { return (await readdir(VIS, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
}

const results = [];
for (const eid of await listEventDirs()) {
  const dir = path.join(VIS, eid);
  const [gem, gpt] = await Promise.all([loadPages(dir, "gemini"), loadPages(dir, "gpt-vision")]);

  // Pages present in BOTH gemini and gpt-vision
  const sharedPages = [...gem.keys()].filter(p => gpt.has(p)).sort((a, b) => a - b);
  if (sharedPages.length < MIN_PAIRS) continue;

  // Three alignments
  const aligned = sharedPages.map(p => jaccard(gem.get(p), gpt.get(p)));
  const shiftPlus  = sharedPages.filter(p => gpt.has(p + 1)).map(p => jaccard(gem.get(p), gpt.get(p + 1)));
  const shiftMinus = sharedPages.filter(p => gpt.has(p - 1)).map(p => jaccard(gem.get(p), gpt.get(p - 1)));

  const mA = mean(aligned);
  const mP = mean(shiftPlus);
  const mM = mean(shiftMinus);

  let verdict = "aligned";
  let suggestedShift = 0;
  if (mP > mA + SIGNIFICANCE && mP > mM) { verdict = "gemini-trails-gpt"; suggestedShift = +1; }
  else if (mM > mA + SIGNIFICANCE && mM > mP) { verdict = "gemini-leads-gpt"; suggestedShift = -1; }

  results.push({
    eid, pairs: sharedPages.length,
    meanAligned: Number(mA.toFixed(3)),
    meanShiftPlus: Number(mP.toFixed(3)),
    meanShiftMinus: Number(mM.toFixed(3)),
    verdict, suggestedShift,
  });

  if (DEBUG_DOC && DEBUG_DOC === eid) {
    console.log(`\n[debug ${eid}] per-page scores:`);
    for (let i = 0; i < sharedPages.length; i++) {
      const p = sharedPages[i];
      console.log(`  p${String(p).padStart(4, "0")}  aligned=${aligned[i].toFixed(3)}  shift+1=${shiftPlus[i]?.toFixed(3) ?? "n/a"}  shift-1=${shiftMinus[i]?.toFixed(3) ?? "n/a"}`);
    }
  }
}

results.sort((a, b) => {
  // worst-aligned first; misaligned float to top
  if (a.verdict !== "aligned" && b.verdict === "aligned") return -1;
  if (a.verdict === "aligned" && b.verdict !== "aligned") return 1;
  return a.meanAligned - b.meanAligned;
});

console.log(`[align] ${results.length} events with ≥${MIN_PAIRS} overlapping pages\n`);
console.log(`event                                        pairs  aligned  +1     -1     verdict`);
console.log(`─────────────────────────────────────────────────────────────────────────────────`);
for (const r of results) {
  const flag = r.verdict !== "aligned" ? "  ⚠ MISALIGNED" : "";
  console.log(
    r.eid.padEnd(44),
    String(r.pairs).padStart(5),
    r.meanAligned.toFixed(3).padStart(7),
    r.meanShiftPlus.toFixed(3).padStart(6),
    r.meanShiftMinus.toFixed(3).padStart(6),
    `  ${r.verdict}${flag}`
  );
}

const misaligned = results.filter(r => r.verdict !== "aligned");
console.log(`\n[align] ${results.length - misaligned.length} aligned · ${misaligned.length} MISALIGNED`);
if (misaligned.length) {
  console.log(`\nMisaligned events — every cross-source comparison on these is comparing wrong pages:`);
  for (const r of misaligned) {
    console.log(`  ${r.eid}: shift ${r.suggestedShift > 0 ? "+" : ""}${r.suggestedShift} fits better (${r.verdict})`);
  }
  console.log(`\nFor a per-page breakdown of any one event:`);
  console.log(`  NODE_DEBUG_DOC=<eid> node scripts/diagnose-page-alignment.mjs`);
}
