// OCR via Poppler `pdftoppm` (renderer) + tesseract.js (OCR).
// Replaces the @napi-rs/canvas + pdfjs path which had Skia render bugs
// on JBig2 / JPEG2000 / certain font-laden pages.
//
// Resumable: writes data-raw/.ocr-cache/<id>/p<NNNN>.txt per page.
// Idempotent: skips pages already cached.
//
// Env:
//   ONLY=id1,id2  — only these
//   SKIP=id1,id2  — skip these
//   FORCE=1       — re-render even cached pages
//   DPI=200       — pdftoppm resolution (default 200; raise for tougher pages)

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createWorker } from "tesseract.js";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(ROOT, "data-raw");
const CACHE_DIR = path.join(RAW_DIR, ".ocr-cache");
const OUT = path.join(ROOT, "src/data/corpus.json");

const DPI = Number(process.env.DPI || 200);
const SKIP = new Set((process.env.SKIP || "").split(",").filter(Boolean));
const ONLY = new Set((process.env.ONLY || "").split(",").filter(Boolean));
const FORCE = process.env.FORCE === "1";

const STOP = new Set(`a about above after again against all am an and any are as at be because been before being below between both but by can did do does doing don down during each few for from further had has have having he her here hers him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves
also one two three four five would could should may might shall must one any all every some thing things page pages document documents report reports memo memos via from etc inc co llc llp eg ie cf vs vs.`.split(/\s+/));

const tokenize = (t) => t.toLowerCase().replace(/[^a-z0-9'\-\s]/g, " ").split(/\s+/)
  .map(w => w.replace(/^['-]+|['-]+$/g, ""))
  .filter(w => w.length >= 3 && w.length <= 30 && !/^\d+$/.test(w) && !STOP.has(w));

// Use pdftoppm to render ONE page to a PNG file (avoids the
// 'Buffer rejected as String/Path' tesseract.js v7 input bug too).
async function renderPageWithPoppler(pdfPath, pageNum, dpi) {
  const tmpBase = path.join(tmpdir(), `whg-${randomBytes(4).toString("hex")}`);
  await execFileP("pdftoppm", [
    "-r", String(dpi),
    "-f", String(pageNum), "-l", String(pageNum),
    "-png", "-gray",                 // single-channel grayscale → smaller files
    pdfPath, tmpBase,
  ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  // pdftoppm appends -NN.png with zero padding equal to total digit count.
  // For a one-page render we get tmpBase-1.png (or -01, -001…). Just glob it.
  const dir = path.dirname(tmpBase);
  const prefix = path.basename(tmpBase);
  const f = (await readdir(dir)).find(name => name.startsWith(prefix) && name.endsWith(".png"));
  if (!f) throw new Error("pdftoppm produced no PNG");
  return path.join(dir, f);
}

async function pdfPageCount(pdfPath) {
  try {
    const { stdout } = await execFileP("pdfinfo", [pdfPath], { windowsHide: true });
    const m = stdout.match(/Pages:\s+(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

async function loadCorpus() {
  try { return JSON.parse(await readFile(OUT, "utf8")); }
  catch { return { stats: {}, byEvent: {}, globalTerms: {}, byTerm: {} }; }
}

async function rebuildIndexes(corpus) {
  const globalTerms = {}, byTerm = {};
  for (const [id, d] of Object.entries(corpus.byEvent)) {
    for (const [w, c] of Object.entries(d.terms || {})) {
      globalTerms[w] = (globalTerms[w] || 0) + c;
      (byTerm[w] = byTerm[w] || []).push(id);
    }
  }
  const kept = Object.entries(globalTerms)
    .filter(([w, c]) => (byTerm[w]?.length || 0) >= 2 || c >= 4)
    .sort((a, b) => b[1] - a[1]).slice(0, 3000);
  const keepSet = new Set(kept.map(([w]) => w));
  for (const id of Object.keys(corpus.byEvent)) {
    const t = corpus.byEvent[id].terms || {};
    corpus.byEvent[id].terms = Object.fromEntries(Object.entries(t).filter(([w]) => keepSet.has(w)));
  }
  const byTermClean = {};
  for (const [w, ids] of Object.entries(byTerm)) if (keepSet.has(w)) byTermClean[w] = [...new Set(ids)];
  corpus.globalTerms = Object.fromEntries(kept);
  corpus.byTerm = byTermClean;
  corpus.stats.uniqueTerms = keepSet.size;
  corpus.generatedAt = new Date().toISOString();
}

await mkdir(CACHE_DIR, { recursive: true });
const corpus = await loadCorpus();

// Targets: only docs that NEED OCR. Skip records where pdfjs already
// produced clean text from the PDF text layer (those have ocr !== true).
// We never want to overwrite an exact text-layer extraction with lossy OCR.
const candidates = Object.keys(corpus.byEvent);
const targets = [];
for (const id of candidates) {
  if (SKIP.has(id)) continue;
  if (ONLY.size && !ONLY.has(id)) continue;
  const d = corpus.byEvent[id];
  // Was this a text-layer extraction? If so, leave it alone.
  const wasTextLayer = !d.ocr && (d.charCount || 0) > 200;
  if (wasTextLayer && !FORCE) continue;
  const pdfPath = path.join(RAW_DIR, `${id}.pdf`);
  if (!existsSync(pdfPath)) continue;
  const dir = path.join(CACHE_DIR, id);
  const cached = existsSync(dir) ? (await readdir(dir)).filter(f => /^p\d+\.txt$/.test(f)).length : 0;
  const pp = await pdfPageCount(pdfPath);
  if (pp === 0) continue;
  if (FORCE || cached < pp) targets.push({ id, pp, cached });
}

if (!targets.length) { console.log("[ocr-poppler] every cached doc is complete."); process.exit(0); }
console.log(`[ocr-poppler] DPI=${DPI}  targets=${targets.length}`);
for (const t of targets) console.log(`  · ${t.id.padEnd(28)} ${t.cached}/${t.pp} cached`);

const worker = await createWorker("eng", 1, { logger: () => {} });
const t0 = Date.now();
let docsTouched = 0;

for (const { id, pp } of targets) {
  const pdfPath = path.join(RAW_DIR, `${id}.pdf`);
  const dir = path.join(CACHE_DIR, id);
  await mkdir(dir, { recursive: true });
  const docT0 = Date.now();
  let didPages = 0, skipped = 0, errs = 0;
  let fullText = "";

  for (let p = 1; p <= pp; p++) {
    const cachePath = path.join(dir, `p${String(p).padStart(4,"0")}.txt`);
    if (!FORCE && existsSync(cachePath)) {
      const stat = await readFile(cachePath, "utf8");
      if (stat.length > 0) { fullText += " " + stat; skipped++; continue; }
    }
    let pngPath = null;
    try {
      pngPath = await renderPageWithPoppler(pdfPath, p, DPI);
      const { data } = await worker.recognize(pngPath);
      const text = (data.text || "").trim();
      await writeFile(cachePath, text, "utf8");
      fullText += " " + text;
      didPages++;
      const elapsed = ((Date.now() - docT0)/1000).toFixed(0);
      process.stdout.write(`  ${id} p${p}/${pp} ocr ${text.length}c  [doc ${elapsed}s · total ${((Date.now()-t0)/60000).toFixed(1)}m]\r`);
    } catch (e) {
      errs++;
      await writeFile(cachePath, "", "utf8");
      process.stdout.write(`  ${id} p${p}/${pp} ERR ${e.message.slice(0,60)}\n`);
    } finally {
      if (pngPath) { try { await (await import("node:fs/promises")).unlink(pngPath); } catch {} }
    }
  }

  const tokens = tokenize(fullText);
  const terms = {};
  for (const t of tokens) terms[t] = (terms[t] || 0) + 1;
  corpus.byEvent[id] = {
    pages: pp,
    charCount: fullText.length,
    terms,
    sample: fullText.slice(0, 800).replace(/\s+/g, " ").trim(),
    ocr: true,
    ocrPages: pp,
  };
  const dt = ((Date.now() - docT0)/1000).toFixed(0);
  console.log(`\n  ✓ ${id} — chars=${fullText.length} terms=${Object.keys(terms).length}  [${didPages} ocr'd, ${skipped} cached, ${errs} err, ${dt}s]`);

  await rebuildIndexes(corpus);
  corpus.stats.eventsProcessed = Object.keys(corpus.byEvent).length;
  await writeFile(OUT, JSON.stringify(corpus, null, 0));
  docsTouched++;
}

await worker.terminate();
console.log(`\n[ocr-poppler] done. ${docsTouched} docs · ${((Date.now()-t0)/60000).toFixed(1)} min · ${Object.keys(corpus.globalTerms).length} terms`);
