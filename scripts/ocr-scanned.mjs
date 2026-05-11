// OCR pass for PDFs whose text extraction was empty.
// Renders each page via pdfjs + @napi-rs/canvas, OCRs via tesseract.js.
// RESUMABLE: each page's OCR text is cached to data-raw/.ocr-cache/<id>/p<NNN>.txt
//   — re-runs skip already-cached pages. Delete a cache file to redo it.
//
// Env:
//   ONLY=id1,id2    — only these event ids
//   SKIP=id1,id2    — skip these event ids
//   MAX_PAGES=N     — cap pages per doc (default: all pages)
//   DPI_SCALE=2.0   — render scale (higher = slower but more accurate)

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(ROOT, "data-raw");
const CACHE_DIR = path.join(RAW_DIR, ".ocr-cache");
const OUT = path.join(ROOT, "src/data/corpus.json");

const MAX_PAGES = process.env.MAX_PAGES ? Number(process.env.MAX_PAGES) : Infinity;
const DPI_SCALE = Number(process.env.DPI_SCALE || 2.0);
const SKIP = new Set((process.env.SKIP || "").split(",").filter(Boolean));
const ONLY = new Set((process.env.ONLY || "").split(",").filter(Boolean));

const STOP = new Set(`a about above after again against all am an and any are as at be because been before being below between both but by can did do does doing don down during each few for from further had has have having he her here hers him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves
also one two three four five would could should may might shall must one any all every some thing things page pages document documents report reports memo memos via from etc inc co llc llp eg ie cf vs vs.`.split(/\s+/));

const tokenize = (text) => text
  .toLowerCase()
  .replace(/[^a-z0-9'\-\s]/g, " ")
  .split(/\s+/)
  .map(w => w.replace(/^['-]+|['-]+$/g, ""))
  .filter(w => w.length >= 3 && w.length <= 30 && !/^\d+$/.test(w) && !STOP.has(w));

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(cv, w, h) { cv.canvas.width = w; cv.canvas.height = h; }
  destroy(cv) { cv.canvas.width = 0; cv.canvas.height = 0; cv.canvas = null; cv.context = null; }
}

async function renderPagePng(doc, pageNum, scale) {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const factory = new NodeCanvasFactory();
  const cv = factory.create(Math.floor(viewport.width), Math.floor(viewport.height));
  await page.render({ canvasContext: cv.context, viewport, canvasFactory: factory }).promise;
  const buf = cv.canvas.toBuffer("image/png");
  factory.destroy(cv);
  return buf;
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
    .sort((a,b) => b[1] - a[1])
    .slice(0, 2500);
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

// Discover targets: docs with no/low extracted text in the current corpus
const corpus = await loadCorpus();
const targets = Object.entries(corpus.byEvent || {})
  .filter(([id, d]) => (d.charCount || 0) < 200 || d.ocr === "partial")
  .map(([id]) => id)
  .filter(id => !SKIP.has(id))
  .filter(id => ONLY.size === 0 || ONLY.has(id));

if (!targets.length) {
  console.log("[ocr] nothing to do — every doc already has extracted text.");
  process.exit(0);
}

console.log(`[ocr] ${targets.length} target(s): ${targets.join(", ")}`);
console.log(`[ocr] MAX_PAGES=${MAX_PAGES === Infinity ? "ALL" : MAX_PAGES}  DPI_SCALE=${DPI_SCALE}`);

const worker = await createWorker("eng", 1, { logger: () => {} });
let docsTouched = 0;
const t0 = Date.now();

for (const id of targets) {
  const pdfPath = path.join(RAW_DIR, `${id}.pdf`);
  let buf;
  try { buf = await readFile(pdfPath); } catch { console.log(`  ✗ ${id} — pdf not on disk`); continue; }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, disableFontFace: true }).promise;
  const nPages = Math.min(doc.numPages, MAX_PAGES);
  const docCacheDir = path.join(CACHE_DIR, id);
  await mkdir(docCacheDir, { recursive: true });

  console.log(`\n→ ${id}  (${doc.numPages} pages, OCRing ${nPages})`);
  const docT0 = Date.now();
  let pagesOcrd = 0, pagesCached = 0, pagesErr = 0;
  let fullText = "";

  for (let p = 1; p <= nPages; p++) {
    const cachePath = path.join(docCacheDir, `p${String(p).padStart(4, "0")}.txt`);
    if (existsSync(cachePath)) {
      const cached = await readFile(cachePath, "utf8");
      fullText += " " + cached;
      pagesCached++;
      continue;
    }
    try {
      const png = await renderPagePng(doc, p, DPI_SCALE);
      const { data } = await worker.recognize(png);
      const pageText = (data.text || "").trim();
      await writeFile(cachePath, pageText, "utf8");
      fullText += " " + pageText;
      pagesOcrd++;
      const elapsed = ((Date.now() - docT0) / 1000).toFixed(0);
      process.stdout.write(`  p${p}/${nPages} ocr ${pageText.length}c  [doc ${elapsed}s, total ${((Date.now()-t0)/60000).toFixed(1)}m]\r`);
    } catch (e) {
      pagesErr++;
      await writeFile(cachePath, "", "utf8");  // empty cache so we don't retry
      process.stdout.write(`  p${p}/${nPages} ERR ${e.message.slice(0,50)}\n`);
    }
  }
  await doc.cleanup(); await doc.destroy();

  const tokens = tokenize(fullText);
  const terms = {};
  for (const t of tokens) terms[t] = (terms[t] || 0) + 1;
  const isPartial = nPages < doc.numPages;
  corpus.byEvent[id] = {
    pages: doc.numPages,
    charCount: fullText.length,
    terms,
    sample: fullText.slice(0, 800).replace(/\s+/g, " ").trim(),
    ocr: isPartial ? "partial" : true,
    ocrPages: nPages,
  };
  const dt = ((Date.now() - docT0) / 1000).toFixed(0);
  console.log(`\n  ✓ ${id} — chars=${fullText.length} terms=${Object.keys(terms).length}  [${pagesOcrd} ocr'd, ${pagesCached} cached, ${pagesErr} err, ${dt}s]`);

  // Save progress after each doc — incremental
  await rebuildIndexes(corpus);
  corpus.stats.eventsProcessed = Object.keys(corpus.byEvent).length;
  await writeFile(OUT, JSON.stringify(corpus, null, 0));
  docsTouched++;
}

await worker.terminate();
const totalMin = ((Date.now() - t0) / 60000).toFixed(1);
console.log(`\n[ocr] done. ${docsTouched} docs merged. corpus terms=${Object.keys(corpus.globalTerms).length}. ${totalMin} min total.`);
