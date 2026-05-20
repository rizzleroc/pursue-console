// For every page in data-raw/.visuals/ that has a non-text-only
// classification but no PNG in public/media/<eid>/, render it from
// the local PDF if available.
//
// Use case: after extract-media-from-gemini.mjs harvests visual
// markers, only some pages get rendered (where the script's render
// happened to succeed). This sweep backfills the rest so MEDIA tiles
// show real images instead of placeholders for every page where a
// local PDF exists.
//
// Run: node scripts/backfill-media-renders.mjs
// Fast — pure local work, no MCP calls.

import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "data-raw");
const VISUALS = path.join(ROOT, "data-raw", ".visuals");
const MEDIA = path.join(ROOT, "public", "media");

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

class CF {
  create(w, h) { const c = createCanvas(w, h); return { canvas: c, context: c.getContext("2d") }; }
  reset(c, w, h) { c.canvas.width = w; c.canvas.height = h; }
  destroy(c) { c.canvas.width = 0; c.canvas.height = 0; c.canvas = null; c.context = null; }
}

const docCache = new Map();
async function getDoc(eid) {
  if (docCache.has(eid)) return docCache.get(eid);
  const candidates = (await readdir(RAW)).filter(f => f.toLowerCase().endsWith(".pdf"));
  const lower = eid.toLowerCase();
  const pdfFile = candidates.find(f => f.toLowerCase().replace(/\.pdf$/, "") === lower)
              || candidates.find(f => f.toLowerCase().includes(lower)) || null;
  if (!pdfFile) { docCache.set(eid, null); return null; }
  const buf = await readFile(path.join(RAW, pdfFile));
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false, disableFontFace: true,
    isEvalSupported: false, useWorkerFetch: false,
  }).promise;
  docCache.set(eid, doc);
  return doc;
}

async function renderPng(eid, pageNum, longSide = 800) {
  const doc = await getDoc(eid);
  if (!doc) return null;
  try {
    const page = await doc.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });
    const scale = longSide / Math.max(base.width, base.height);
    const vp = page.getViewport({ scale });
    const fac = new CF();
    const cv = fac.create(Math.floor(vp.width), Math.floor(vp.height));
    await page.render({ canvasContext: cv.context, viewport: vp, canvasFactory: fac, annotationMode: 0 }).promise;
    const buf = cv.canvas.toBuffer("image/png");
    fac.destroy(cv);
    return buf;
  } catch { return null; }
}

const VISIBLE_KINDS = new Set(["photograph", "hand-drawing", "photocopied-negative", "newspaper-clipping", "map", "diagram"]);

async function listDirs(p) {
  try { return (await readdir(p, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
}

let scanned = 0, alreadyHave = 0, rendered = 0, noPdf = 0, failed = 0;
const byEvent = {};

for (const eid of await listDirs(VISUALS)) {
  for (const f of await readdir(path.join(VISUALS, eid))) {
    const m = f.match(/^p(\d+)\.json$/);
    if (!m) continue;
    scanned++;
    const pn = Number(m[1]);
    const pad = String(pn).padStart(4, "0");
    let sc;
    try { sc = JSON.parse(await readFile(path.join(VISUALS, eid, f), "utf8")); } catch { continue; }
    if (!VISIBLE_KINDS.has(sc.kind)) continue;

    const pngOut = path.join(MEDIA, eid, `p${pad}.png`);
    const jpgOut = path.join(MEDIA, eid, `p${pad}.jpg`);
    if (existsSync(pngOut) || existsSync(jpgOut)) { alreadyHave++; continue; }

    const png = await renderPng(eid, pn);
    if (png === null) {
      // distinguish "no local PDF" from render failure
      if (!(await getDoc(eid))) { noPdf++; continue; }
      failed++;
      continue;
    }
    await mkdir(path.dirname(pngOut), { recursive: true });
    await writeFile(pngOut, png);
    rendered++;
    byEvent[eid] = (byEvent[eid] || 0) + 1;
  }
}

console.log(`[backfill] scanned ${scanned} visual sidecars`);
console.log(`           ${alreadyHave} already had an image`);
console.log(`           ${rendered} newly rendered`);
console.log(`           ${noPdf} skipped (no local PDF)`);
console.log(`           ${failed} render failed`);
if (Object.keys(byEvent).length) {
  console.log(`[backfill] newly rendered by event:`);
  for (const [eid, n] of Object.entries(byEvent).sort((a, b) => b[1] - a[1])) {
    console.log(`             ${eid.padEnd(45)} ${n}`);
  }
}
console.log(`[backfill] next: node scripts/build-media-index.mjs`);
