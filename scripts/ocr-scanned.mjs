// OCR pass for PDFs whose text extraction was empty.
// Renders each page via pdfjs + @napi-rs/canvas, then runs tesseract.js.
// Merges results back into src/data/corpus.json.
//
// SLOW: ~5–10s/page. The largest docs (incident-summaries 209p, fbi-vault
// 185p, COMETA 94p) take meaningful time. Run, walk away, come back.
//
// Skip specific ids via SKIP=id1,id2; only do specific via ONLY=id1,id2.
// Limit max pages per doc via MAX_PAGES=40.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(ROOT, "data-raw");
const OUT = path.join(ROOT, "src/data/corpus.json");
const MAX_PAGES = Number(process.env.MAX_PAGES || 40);
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

// Provide a Node canvas factory for pdfjs.
class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(cv, w, h) { cv.canvas.width = w; cv.canvas.height = h; }
  destroy(cv) { cv.canvas.width = 0; cv.canvas.height = 0; cv.canvas = null; cv.context = null; }
}

async function renderPage(doc, pageNum, scale = 2.0) {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const factory = new NodeCanvasFactory();
  const cv = factory.create(Math.floor(viewport.width), Math.floor(viewport.height));
  await page.render({ canvasContext: cv.context, viewport, canvasFactory: factory }).promise;
  const buf = cv.canvas.toBuffer("image/png");
  factory.destroy(cv);
  return buf;
}

const corpus = JSON.parse(await readFile(OUT, "utf8"));
const targets = Object.entries(corpus.byEvent)
  .filter(([id, d]) => d.charCount < 200)
  .map(([id]) => id)
  .filter(id => !SKIP.has(id))
  .filter(id => ONLY.size === 0 || ONLY.has(id));

if (!targets.length) {
  console.log("[ocr] nothing to do.");
  process.exit(0);
}

console.log(`[ocr] ${targets.length} candidate(s): ${targets.join(", ")}`);
console.log(`[ocr] MAX_PAGES=${MAX_PAGES} per doc`);

const worker = await createWorker("eng", 1, { logger: () => {} });
let touched = 0;

for (const id of targets) {
  const pdfPath = path.join(RAW_DIR, `${id}.pdf`);
  let buf;
  try { buf = await readFile(pdfPath); } catch { console.log(`  ✗ ${id} — pdf not on disk`); continue; }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, disableFontFace: true }).promise;
  const nPages = Math.min(doc.numPages, MAX_PAGES);
  console.log(`\n→ ${id}  (${doc.numPages} pages, OCRing ${nPages})`);
  let text = "";
  for (let p = 1; p <= nPages; p++) {
    try {
      const png = await renderPage(doc, p, 2.0);
      const { data } = await worker.recognize(png);
      text += " " + (data.text || "");
      process.stdout.write(`  p${p}: ${(data.text || "").length}c\r`);
    } catch (e) {
      process.stdout.write(`  p${p}: ERR ${e.message}\n`);
    }
  }
  await doc.cleanup(); await doc.destroy();

  const tokens = tokenize(text);
  const terms = {};
  for (const t of tokens) terms[t] = (terms[t] || 0) + 1;
  corpus.byEvent[id] = {
    pages: doc.numPages,
    charCount: text.length,
    terms,
    sample: text.slice(0, 800).replace(/\s+/g, " ").trim(),
    ocr: true,
    ocrPages: nPages,
  };
  console.log(`  ✓ ${id} — chars=${text.length} terms=${Object.keys(terms).length}${nPages < doc.numPages ? ` (truncated at p${nPages})` : ""}`);
  touched++;
}

await worker.terminate();

// Rebuild global indexes
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
corpus.stats.ocrEvents = (corpus.stats.ocrEvents || 0) + touched;
corpus.generatedAt = new Date().toISOString();

await writeFile(OUT, JSON.stringify(corpus, null, 0));
console.log(`\n[ocr] merged ${touched} OCR'd docs. corpus terms=${keepSet.size}`);
