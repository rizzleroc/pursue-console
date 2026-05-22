// Build per-event full-text files at public/text/<id>.txt.
// Sources:
//   - data-raw/.ocr-cache/<id>/p*.txt  (when OCR has run on a scanned doc)
//   - data-raw/<id>.pdf via pdfjs       (when the PDF has a text layer)
// Writes one .txt per event id; updates a manifest at public/text/manifest.json.
// Safe to re-run any time; idempotent.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(ROOT, "data-raw");
const CACHE_DIR = path.join(RAW_DIR, ".ocr-cache");
const VISION_DIR = path.join(RAW_DIR, ".vision-cache");
const VISUALS_DIR = path.join(RAW_DIR, ".vision-visuals-cache");
const OUT_DIR = path.join(ROOT, "public/text");
// Sidecar JSON: per-event { page: [{kind, description}, ...] } map of visual
// elements detected on each page. Consumed by build-embeddings, build-dossier-
// extracts, and the DossierView "VISUAL CONTENT" panel.
const VISUALS_OUT = path.join(ROOT, "public/visuals.json");

const { EVENTS } = await import("../src/data/events.js");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
// pathToFileURL produces 'file:///C:/...' on Windows; raw 'file://' concat
// lacks the third slash and pdfjs's font/wasm loaders fail silently. See vision-ocr.mjs.
const PDFJS_WASM_URL = pathToFileURL(path.join(ROOT, "node_modules/pdfjs-dist/wasm")).href + "/";
const PDFJS_FONTS_URL = pathToFileURL(path.join(ROOT, "node_modules/pdfjs-dist/standard_fonts")).href + "/";

await mkdir(OUT_DIR, { recursive: true });

// Vision OCR cache wins over tesseract cache wins over pdfjs text layer.
// Pages can be merged: where vision-cache has a page, use it; else fall
// back to OCR-cache for that page. This way a partial vision run still
// improves the doc without losing the noisier-but-present OCR pages.
async function fromCaches(id) {
  const ocrDir = path.join(CACHE_DIR, id);
  const visDir = path.join(VISION_DIR, id);
  const hasOcr = existsSync(ocrDir);
  const hasVis = existsSync(visDir);
  if (!hasOcr && !hasVis) return null;

  const pageMap = new Map(); // page -> { text, source }

  if (hasOcr) {
    const files = (await readdir(ocrDir)).filter(f => /^p\d+\.txt$/.test(f));
    for (const f of files) {
      const pageNum = Number(f.match(/^p(\d+)/)[1]);
      const text = (await readFile(path.join(ocrDir, f), "utf8")).trim();
      if (text) pageMap.set(pageNum, { text, source: "ocr" });
    }
  }
  if (hasVis) {
    const files = (await readdir(visDir)).filter(f => /^p\d+\.txt$/.test(f));
    for (const f of files) {
      const pageNum = Number(f.match(/^p(\d+)/)[1]);
      const text = (await readFile(path.join(visDir, f), "utf8")).trim();
      if (text) pageMap.set(pageNum, { text, source: "vision" }); // overwrite OCR
    }
  }
  // Optional visuals sidecar — vision pages may have associated
  // [PHOTO]/[DIAGRAM]/etc descriptions stored as JSON.
  const visualsDocDir = path.join(VISUALS_DIR, id);
  const pageVisuals = {};   // pageNum -> [{kind, description}]
  if (existsSync(visualsDocDir)) {
    for (const f of await readdir(visualsDocDir)) {
      if (!/^p\d+\.json$/.test(f)) continue;
      const pageNum = Number(f.match(/^p(\d+)/)[1]);
      try {
        const arr = JSON.parse(await readFile(path.join(visualsDocDir, f), "utf8"));
        if (Array.isArray(arr) && arr.length) pageVisuals[pageNum] = arr;
      } catch {}
    }
  }

  if (!pageMap.size) return { pageVisuals };  // unusual: visuals exist but no text

  const pages = [...pageMap.keys()].sort((a, b) => a - b);
  const parts = [];
  let visionCount = 0;
  for (const pageNum of pages) {
    const e = pageMap.get(pageNum);
    if (e.source === "vision") visionCount++;
    const marker = e.source === "vision" ? `=== Page ${pageNum} (vision) ===` : `=== Page ${pageNum} ===`;
    parts.push(`\n\n${marker}\n\n${e.text}`);
    // If this page has visuals, append them as a clearly-marked block so the
    // build-embeddings tokenizer + build-dossier-extracts can find them too.
    const v = pageVisuals[pageNum];
    if (v && v.length) {
      const lines = v.map(x => `- [${(x.kind || "image").toUpperCase()}] ${x.description}`).join("\n");
      parts.push(`\n=== Page ${pageNum} (visual) ===\n\n${lines}`);
    }
  }
  // Source label: 'vision' if all pages from vision, 'mixed' if both, 'ocr' otherwise
  const source = visionCount === pages.length ? "vision" : (visionCount > 0 ? "mixed" : "ocr");
  return { text: parts.join("\n"), source, pages: pages.length, pageVisuals };
}
// Keep the old name working for any external callers.
const fromOcrCache = fromCaches;

async function fromPdfText(id) {
  const pdfPath = path.join(RAW_DIR, `${id}.pdf`);
  if (!existsSync(pdfPath)) return null;
  const buf = await readFile(pdfPath);
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    disableFontFace: true,
    wasmUrl: PDFJS_WASM_URL,
    standardFontDataUrl: PDFJS_FONTS_URL,
  }).promise;
  const parts = [];
  let totalChars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    try {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const t = tc.items.map(it => it.str || "").join(" ").replace(/\s+/g, " ").trim();
      if (t) parts.push(`\n\n=== Page ${p} ===\n\n${t}`);
      totalChars += t.length;
    } catch {}
  }
  await doc.cleanup(); await doc.destroy();
  if (totalChars < 50) return null;  // empty / scanned — caller will fall back to OCR cache if any
  return { text: parts.join("\n"), source: "pdfjs", pages: doc.numPages };
}

const manifest = {};
const allVisuals = {};   // eid -> { page -> [{kind, description}] }
let wrote = 0, skipped = 0, visualPages = 0, totalVisuals = 0;

for (const ev of EVENTS) {
  let result = null;
  // Prefer OCR cache when present (only exists if PDF was scanned and OCR'd)
  result = await fromOcrCache(ev.id);
  // Fall back to PDF text layer
  if (!result || !result.text) {
    const pdf = await fromPdfText(ev.id);
    if (pdf) result = { ...pdf, pageVisuals: result?.pageVisuals || {} };
  }

  if (!result) { skipped++; continue; }

  // Capture visuals sidecar regardless of text source.
  if (result.pageVisuals && Object.keys(result.pageVisuals).length) {
    allVisuals[ev.id] = result.pageVisuals;
    visualPages += Object.keys(result.pageVisuals).length;
    totalVisuals += Object.values(result.pageVisuals).reduce((s, arr) => s + arr.length, 0);
  }
  if (!result.text) {
    skipped++;
    continue;
  }
  const header = `${ev.title}\n${"=".repeat(ev.title.length)}\n\nAgency: ${ev.agency}\nDate: ${ev.date}\nLocation: ${ev.loc}\nType: ${ev.type}\nSource extraction: ${result.source.toUpperCase()} · ${result.pages} pages\n\n---`;
  const full = header + result.text;
  await writeFile(path.join(OUT_DIR, `${ev.id}.txt`), full, "utf8");
  manifest[ev.id] = { source: result.source, pages: result.pages, chars: full.length };
  wrote++;
  const vTag = result.pageVisuals && Object.keys(result.pageVisuals).length
    ? ` (+${Object.keys(result.pageVisuals).length}p visuals)` : "";
  console.log(`  ✓ ${ev.id.padEnd(28)} ${result.source.padEnd(6)} ${result.pages}p ${full.length}c${vTag}`);
}

await writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 0), "utf8");
await writeFile(VISUALS_OUT, JSON.stringify(allVisuals), "utf8");
console.log(`\n[text-files] wrote ${wrote}, skipped ${skipped}.  visuals: ${totalVisuals} elements across ${visualPages} pages.`);
