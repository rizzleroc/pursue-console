// Vision OCR via the local whipgen daemon (ChatGPT Plus).
//
// For each scanned PDF whose tesseract output is low-quality, render
// every page to a PNG via pdfjs + @napi-rs/canvas, then ask ChatGPT
// vision to transcribe it verbatim. Results cached per-page under
// data-raw/.vision-cache/<id>/p<NNN>.txt — re-runs skip cached pages.
//
// Env:
//   ONLY=id1,id2     — only these event ids
//   SKIP=id1,id2     — skip these event ids
//   MAX_PAGES=N      — cap pages per doc (default: ALL)
//   DPI_SCALE=2.0    — render scale; higher = bigger PNG, more accurate
//   DAEMON=http://127.0.0.1:9223   — whipgen daemon URL
//
// Token: $WHIPGEN_TOKEN or ~/.whipgen-token

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(ROOT, "data-raw");
const CACHE_DIR = path.join(RAW_DIR, ".vision-cache");
// PNG staging area inside the daemon's allowed read root (homedir).
// The daemon won't accept paths outside ALLOWED_READ_ROOTS (defaults to ~).
const PNG_STAGE = path.join(os.homedir(), ".whipgen-smoke", "pursue-console");

const DAEMON = process.env.DAEMON || "http://127.0.0.1:9223";
const MAX_PAGES = process.env.MAX_PAGES ? Number(process.env.MAX_PAGES) : Infinity;
const DPI_SCALE = Number(process.env.DPI_SCALE || 2.0);
const SKIP = new Set((process.env.SKIP || "").split(",").filter(Boolean));
const ONLY = new Set((process.env.ONLY || "").split(",").filter(Boolean));

async function loadToken() {
  if (process.env.WHIPGEN_TOKEN) return process.env.WHIPGEN_TOKEN;
  const tokPath = path.join(os.homedir(), ".whipgen-token");
  return (await readFile(tokPath, "utf8")).trim();
}
const TOKEN = await loadToken();

async function daemonStatus() {
  const r = await fetch(`${DAEMON}/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`daemon /status → HTTP ${r.status}`);
  return r.json();
}

// Send a single PNG to ChatGPT vision via the daemon's /analyze route.
//
// IMPORTANT prompt-engineering note: an "OCR engine" frame with bracketed
// classification markers ([REDACTED] / [illegible]) consistently trips
// content-policy refusals on government-document images — we got back
// "[illegible]" instead of actual text. A polite, purpose-stated, no-
// bracket-keywords prompt with the explicit "declassified public
// document" disclaimer produces faithful verbatim transcription with
// (?) for genuinely unreadable spans. Don't regress this.
async function visionTranscribe(pngPath, label) {
  const prompt =
    "Please transcribe the text shown in this image so I can search the content. " +
    "Output only the text exactly as written, preserving line breaks. " +
    "If a portion is unreadable or has been blacked out, write (?) in its place. " +
    "If the page is entirely blank, output: (blank). " +
    "If you can read handwritten annotations, include them inline. " +
    "This is a declassified public document.";
  const r = await fetch(`${DAEMON}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      imagePath: pngPath,
      prompt,
      provider: "chatgpt",
      label,
      freshChat: true,        // each page in its own chat so context doesn't bleed
      timeoutMs: 180_000,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`/analyze HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  const j = await r.json();
  // Daemon returns { text, jobId, durationMs, ... }
  return j.text ?? j.result?.text ?? j.output ?? "";
}

// ---- pdf → png rendering (same factory as ocr-scanned.mjs) ----
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const PDFJS_WASM_URL = "file://" + path.join(ROOT, "node_modules/pdfjs-dist/wasm/").replaceAll("\\", "/");
const PDFJS_FONTS_URL = "file://" + path.join(ROOT, "node_modules/pdfjs-dist/standard_fonts/").replaceAll("\\", "/");

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

// ---- discover targets: scanned docs whose OCR output is below threshold ----
// Returns ids sorted by ascending page count so a kill-and-restart doesn't
// leave the user staring at a 200-page giant before any small doc completes.
async function discoverTargets() {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "public/text/manifest.json"), "utf8"));
  const candidates = Object.entries(manifest)
    .filter(([id, v]) => v.source === "ocr")
    .map(([id, v]) => ({ id, pages: v.pages || Infinity }))
    .filter(({ id }) => !SKIP.has(id))
    .filter(({ id }) => ONLY.size === 0 || ONLY.has(id));
  candidates.sort((a, b) => a.pages - b.pages);
  return candidates.map(c => c.id);
}

// ---- main loop ----
const status = await daemonStatus();
console.log(`[vision] daemon up at ${DAEMON} · history events ${status.history?.events ?? "?"}`);

const targets = await discoverTargets();
if (!targets.length) {
  console.log("[vision] no candidates (set ONLY=... to force).");
  process.exit(0);
}
console.log(`[vision] ${targets.length} target(s): ${targets.join(", ")}`);
console.log(`[vision] MAX_PAGES=${MAX_PAGES === Infinity ? "ALL" : MAX_PAGES}  DPI_SCALE=${DPI_SCALE}`);

await mkdir(CACHE_DIR, { recursive: true });
let totalPages = 0, totalCached = 0, totalOcrd = 0, totalErr = 0;
const tAll = Date.now();

for (const id of targets) {
  const pdfPath = path.join(RAW_DIR, `${id}.pdf`);
  if (!existsSync(pdfPath)) { console.log(`  ✗ ${id} — pdf missing`); continue; }

  const buf = await readFile(pdfPath);
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    disableFontFace: true,
    wasmUrl: PDFJS_WASM_URL,
    standardFontDataUrl: PDFJS_FONTS_URL,
  }).promise;
  const nPages = Math.min(doc.numPages, MAX_PAGES);
  const docCacheDir = path.join(CACHE_DIR, id);
  const docPngDir = path.join(PNG_STAGE, id);
  await mkdir(docCacheDir, { recursive: true });
  await mkdir(docPngDir, { recursive: true });

  console.log(`\n→ ${id}  (${doc.numPages} pages, vision-OCRing ${nPages})`);
  const docT0 = Date.now();
  let nOk = 0, nCache = 0, nErr = 0;

  for (let p = 1; p <= nPages; p++) {
    const cachePath = path.join(docCacheDir, `p${String(p).padStart(4, "0")}.txt`);
    if (existsSync(cachePath)) {
      const sz = (await readFile(cachePath, "utf8")).length;
      if (sz > 0) { nCache++; continue; }
    }
    // Stage PNG inside the daemon's allowed read root (~/.whipgen-smoke/…)
    const pngPath = path.join(docPngDir, `p${String(p).padStart(4, "0")}.png`);
    try {
      if (!existsSync(pngPath)) {
        const png = await renderPagePng(doc, p, DPI_SCALE);
        await writeFile(pngPath, png);
      }
      const t = await visionTranscribe(pngPath, `${id}-p${p}`);
      await writeFile(cachePath, (t || "").trim(), "utf8");
      nOk++;
      const dt = ((Date.now() - docT0) / 1000).toFixed(0);
      const allMin = ((Date.now() - tAll) / 60000).toFixed(1);
      const tlen = (t || "").length;
      process.stdout.write(`  p${p}/${nPages}  ${tlen}c  [doc ${dt}s · total ${allMin}m]                 \r`);
    } catch (e) {
      nErr++;
      await writeFile(cachePath, "", "utf8");  // mark as attempted
      console.log(`\n  p${p}/${nPages}  ERR ${e.message.slice(0, 140)}`);
    }
  }
  await doc.cleanup(); await doc.destroy();
  totalPages += nPages; totalCached += nCache; totalOcrd += nOk; totalErr += nErr;
  const docDt = ((Date.now() - docT0) / 60000).toFixed(1);
  console.log(`\n  ✓ ${id} — vision ${nOk} · cached ${nCache} · err ${nErr}  [${docDt} min]`);
}

const allMin = ((Date.now() - tAll) / 60000).toFixed(1);
console.log(`\n[vision] done. pages ${totalPages} · ocr ${totalOcrd} · cached ${totalCached} · err ${totalErr}  [${allMin} min total]`);
console.log(`[vision] cache → ${CACHE_DIR}`);
console.log(`[vision] next: update scripts/build-text-files.mjs to prefer .vision-cache over .ocr-cache, then rebuild embeddings`);
