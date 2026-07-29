// One-shot OCR for the 4 R03 scan-only PDFs that build-text-files.mjs
// skipped (no text layer). Renders each page via pdfjs + @napi-rs/canvas,
// OCRs via tesseract.js, writes data-raw/.ocr-cache/<id>/p<NNN>.txt that
// build-text-files.mjs picks up on the next run.
//
// Standalone of scripts/ocr-scanned.mjs — the latter's discovery loop
// only iterates events already in corpus.json, which leaves R03 out.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCanvas } from "pdfjs-dist/node_modules/@napi-rs/canvas/index.js";
import { createWorker } from "tesseract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(ROOT, "data-raw");
const CACHE_DIR = path.join(RAW_DIR, ".ocr-cache");
const DPI_SCALE = Number(process.env.DPI_SCALE || 2.0);

const TARGETS = ["FBI-UAP-D003", "CIA-UAP-010", "DOW-UAP-D085", "DOW-UAP-D086"];

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const PDFJS_WASM_URL = pathToFileURL(path.join(ROOT, "node_modules/pdfjs-dist/wasm")).href + "/";
const PDFJS_FONTS_URL = pathToFileURL(path.join(ROOT, "node_modules/pdfjs-dist/standard_fonts")).href + "/";
// Local tesseract.js eng training data — egress is blocked from jsdelivr,
// so we keep the gzipped traineddata under data-raw/.tesseract/ and point
// createWorker at it via langPath (file:// URL of the parent directory).
const LANG_PATH = pathToFileURL(path.join(ROOT, "data-raw/.tesseract")).href + "/";

class NodeCanvasFactory {
  create(width, height) {
    const c = createCanvas(width, height);
    return { canvas: c, context: c.getContext("2d") };
  }
  reset(c, w, h) { c.canvas.width = w; c.canvas.height = h; }
  destroy(c) { c.canvas.width = 0; c.canvas.height = 0; }
}

const worker = await createWorker("eng", 1, {
  logger: () => {},
  langPath: LANG_PATH,
  cachePath: path.join(ROOT, "data-raw/.tesseract"),
  workerPath: path.join(ROOT, "node_modules/tesseract.js/src/worker-script/node/index.js"),
  corePath: path.join(ROOT, "node_modules/tesseract.js-core"),
});

let totalPages = 0;
let totalChars = 0;

for (const id of TARGETS) {
  const pdfPath = path.join(RAW_DIR, `${id}.pdf`);
  if (!existsSync(pdfPath)) {
    console.log(`[ocr-r03] skip ${id} — pdf missing`);
    continue;
  }
  const buf = await readFile(pdfPath);
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    disableFontFace: true,
    wasmUrl: PDFJS_WASM_URL,
    standardFontDataUrl: PDFJS_FONTS_URL,
    canvasFactory: new NodeCanvasFactory(),
  }).promise;

  const cacheDir = path.join(CACHE_DIR, id);
  await mkdir(cacheDir, { recursive: true });

  console.log(`[ocr-r03] ${id}: ${doc.numPages} page(s) at ${DPI_SCALE}x`);
  for (let p = 1; p <= doc.numPages; p++) {
    const pageFile = path.join(cacheDir, `p${String(p).padStart(3, "0")}.txt`);
    if (existsSync(pageFile) && (await readFile(pageFile, "utf8")).trim().length > 0) {
      console.log(`  · p${p} already cached, skip`);
      continue;
    }
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: DPI_SCALE });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    const png = canvas.toBuffer("image/png");
    // tesseract.js v7: write to a temp file first to be safe across setups
    const tmpPath = path.join(tmpdir(), `ocr-${randomBytes(4).toString("hex")}.png`);
    await writeFile(tmpPath, png);
    const t0 = Date.now();
    const { data } = await worker.recognize(tmpPath);
    const text = (data?.text || "").trim();
    await writeFile(pageFile, text + "\n", "utf8");
    totalChars += text.length;
    totalPages++;
    console.log(`  ✓ p${p} ${text.length}c in ${Date.now() - t0}ms`);
  }
  await doc.cleanup();
  await doc.destroy();
}

await worker.terminate();
console.log(`[ocr-r03] done — ${totalPages} page(s), ${totalChars} chars`);
