// Backfill VISUAL CONTENT for pages we already transcribed before the
// prompt was updated to include image descriptions.
//
// For each page where data-raw/.vision-cache/<eid>/p<NNN>.txt exists but
// data-raw/.vision-visuals-cache/<eid>/p<NNN>.json does NOT, fire a single
// vision call asking only for the visual catalogue (no re-transcription).
//
// Cheaper than re-running full vision OCR: the prompt is shorter, output
// is shorter, and we skip text we already have.
//
// Uses the same pacing (jitter + breaks) as scripts/vision-ocr.mjs so the
// daemon-to-ChatGPT cadence looks human.
//
// Env:
//   ONLY=id1,id2     — only these event ids
//   SKIP=id1,id2     — skip these
//   MAX_PAGES=N      — cap per doc (default ALL)
//   DPI_SCALE=2.0    — render scale for re-rendering pages
//   PACE_SECS / JITTER / *_BREAK_*   — same as vision-ocr.mjs
//   DAEMON=http://127.0.0.1:9223
//
// Token: $WHIPGEN_TOKEN or ~/.whipgen-token

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
// pdfjs's nested canvas (0.1.x); see backfill-media-renders.mjs.
import { createCanvas } from "pdfjs-dist/node_modules/@napi-rs/canvas/index.js";

process.on("unhandledRejection", e => console.error("  ! unhandledRejection:", e?.message || e));
process.on("uncaughtException",  e => console.error("  ! uncaughtException:", e?.message || e));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(ROOT, "data-raw");
const CACHE_DIR = path.join(RAW_DIR, ".vision-cache");
const VISUALS_DIR = path.join(RAW_DIR, ".vision-visuals-cache");
const PNG_STAGE = path.join(os.homedir(), ".whipgen-smoke", "pursue-console");

const DAEMON = process.env.DAEMON || "http://127.0.0.1:9223";
const MAX_PAGES = process.env.MAX_PAGES ? Number(process.env.MAX_PAGES) : Infinity;
const DPI_SCALE = Number(process.env.DPI_SCALE || 2.0);
const SKIP = new Set((process.env.SKIP || "").split(",").filter(Boolean));
const ONLY = new Set((process.env.ONLY || "").split(",").filter(Boolean));

const PACE_SECS                = Number(process.env.PACE_SECS || 25);
const JITTER                   = Number(process.env.JITTER || 0.6);
const PAGES_PER_MICRO_BREAK    = Number(process.env.PAGES_PER_MICRO_BREAK || 8);
const MICRO_BREAK_MIN_SECS     = Number(process.env.MICRO_BREAK_MIN_SECS || 90);
const MICRO_BREAK_MAX_SECS     = Number(process.env.MICRO_BREAK_MAX_SECS || 240);
const PAGES_PER_MACRO_BREAK    = Number(process.env.PAGES_PER_MACRO_BREAK || 32);
const MACRO_BREAK_MIN_SECS     = Number(process.env.MACRO_BREAK_MIN_SECS || 480);
const MACRO_BREAK_MAX_SECS     = Number(process.env.MACRO_BREAK_MAX_SECS || 900);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => min + Math.random() * (max - min);

async function loadToken() {
  if (process.env.WHIPGEN_TOKEN) return process.env.WHIPGEN_TOKEN;
  return (await readFile(path.join(os.homedir(), ".whipgen-token"), "utf8")).trim();
}
const TOKEN = await loadToken();

const VISUAL_PROMPT =
  "Look at this image and tell me whether it contains any photographs, " +
  "drawings, diagrams, sketches, maps, charts, or annotated images. " +
  "Reply with one bulleted line per visual element, prefixed with its kind " +
  "in brackets — [PHOTO], [DIAGRAM], [SKETCH], [MAP], [CHART], or " +
  "[ANNOTATION]. Describe what is shown: subjects, context, captions, " +
  "arrows, circled regions, scale — anything that would help someone " +
  "searching for this visual content. Example:\n" +
  "- [PHOTO] black-and-white aerial photograph of a desert airstrip with two parked aircraft, no caption visible.\n" +
  "- [ANNOTATION] red ink circle drawn over a small dot in the upper-right quadrant of the photo.\n\n" +
  "If there are no visual elements at all (text-only document page), reply with the single word: (none)\n\n" +
  "This is a declassified public document.";

async function visionDescribeImages(pngPath, label) {
  const r = await fetch(`${DAEMON}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      imagePath: pngPath, prompt: VISUAL_PROMPT, provider: "chatgpt",
      label, freshChat: true, timeoutMs: 240_000,
    }),
  });
  if (!r.ok) throw new Error(`/analyze HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const raw = (j.text ?? j.result?.text ?? j.output ?? "").trim();
  if (!raw || /^\(none\)/i.test(raw)) return [];
  const visuals = [];
  for (const line of raw.split(/\n+/)) {
    const lm = line.trim().match(/^[-•*]\s*\[([A-Z]+)\]\s*(.+)$/);
    if (lm) visuals.push({ kind: lm[1].toLowerCase(), description: lm[2].trim() });
  }
  return visuals;
}

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const PDFJS_WASM_URL = "file://" + path.join(ROOT, "node_modules/pdfjs-dist/wasm/").replaceAll("\\", "/");
const PDFJS_FONTS_URL = "file://" + path.join(ROOT, "node_modules/pdfjs-dist/standard_fonts/").replaceAll("\\", "/");

class NodeCanvasFactory {
  create(width, height) { const c = createCanvas(width, height); return { canvas: c, context: c.getContext("2d") }; }
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

// Discover augment targets: pages where vision text exists but visuals are missing.
async function discoverTargets() {
  if (!existsSync(CACHE_DIR)) return [];
  const docs = await readdir(CACHE_DIR);
  const out = [];
  for (const id of docs) {
    if (SKIP.has(id) || (ONLY.size && !ONLY.has(id))) continue;
    const docCacheDir = path.join(CACHE_DIR, id);
    const docVisDir = path.join(VISUALS_DIR, id);
    const pages = (await readdir(docCacheDir))
      .filter(f => /^p\d+\.txt$/.test(f))
      .map(f => Number(f.match(/^p(\d+)/)[1]))
      .sort((a, b) => a - b);
    const missing = [];
    for (const p of pages) {
      const jsonPath = path.join(docVisDir, `p${String(p).padStart(4, "0")}.json`);
      if (!existsSync(jsonPath)) missing.push(p);
    }
    if (missing.length) out.push({ id, missing });
  }
  return out;
}

const targets = await discoverTargets();
if (!targets.length) { console.log("[augment] nothing to augment — all vision pages already have visuals files."); process.exit(0); }
const totalMissing = targets.reduce((s, t) => s + t.missing.length, 0);
console.log(`[augment] ${targets.length} doc(s), ${totalMissing} page(s) need visual backfill:`);
for (const t of targets) console.log(`    ${t.id} — ${t.missing.length} pages`);
console.log(`[augment] PACE_SECS=${PACE_SECS} JITTER=${JITTER}  micro every ~${PAGES_PER_MICRO_BREAK}  macro every ~${PAGES_PER_MACRO_BREAK}`);

let lastCallEndedAt = 0, callsSinceMicro = 0, callsSinceMacro = 0;
let microThreshold = Math.round(PAGES_PER_MICRO_BREAK + rand(-3, 3));
let macroThreshold = Math.round(PAGES_PER_MACRO_BREAK + rand(-6, 6));
const nextGapSecs = () => Math.max(8, rand(PACE_SECS * (1 - JITTER), PACE_SECS * (1 + JITTER)));

async function paced(fn) {
  if (callsSinceMacro >= macroThreshold) {
    const s = rand(MACRO_BREAK_MIN_SECS, MACRO_BREAK_MAX_SECS);
    console.log(`\n  ☕☕ macro break — ${(s/60).toFixed(1)} min`);
    await sleep(s * 1000);
    callsSinceMacro = 0; callsSinceMicro = 0;
    macroThreshold = Math.round(PAGES_PER_MACRO_BREAK + rand(-6, 6));
    microThreshold = Math.round(PAGES_PER_MICRO_BREAK + rand(-3, 3));
  } else if (callsSinceMicro >= microThreshold) {
    const s = rand(MICRO_BREAK_MIN_SECS, MICRO_BREAK_MAX_SECS);
    console.log(`\n  ☕  micro break — ${(s/60).toFixed(1)} min`);
    await sleep(s * 1000);
    callsSinceMicro = 0;
    microThreshold = Math.round(PAGES_PER_MICRO_BREAK + rand(-3, 3));
  }
  const gap = Date.now() - lastCallEndedAt;
  const target = nextGapSecs() * 1000;
  if (gap < target) await sleep(target - gap);
  try {
    const out = await fn();
    callsSinceMicro++; callsSinceMacro++;
    return out;
  } finally {
    lastCallEndedAt = Date.now();
  }
}

let totalOk = 0, totalVisuals = 0, totalErr = 0;
const tAll = Date.now();
for (const { id, missing } of targets) {
  const pdfPath = path.join(RAW_DIR, `${id}.pdf`);
  if (!existsSync(pdfPath)) { console.log(`  ✗ ${id} — pdf not on disk`); continue; }
  const buf = await readFile(pdfPath);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, disableFontFace: true, wasmUrl: PDFJS_WASM_URL, standardFontDataUrl: PDFJS_FONTS_URL }).promise;
  const docVisDir = path.join(VISUALS_DIR, id);
  const docPngDir = path.join(PNG_STAGE, id);
  await mkdir(docVisDir, { recursive: true });
  await mkdir(docPngDir, { recursive: true });
  console.log(`\n→ ${id}  (${missing.length} pages to augment)`);
  const docT0 = Date.now();
  const limit = Math.min(missing.length, MAX_PAGES);
  for (let i = 0; i < limit; i++) {
    const p = missing[i];
    const pngPath = path.join(docPngDir, `p${String(p).padStart(4, "0")}.png`);
    const visualsPath = path.join(docVisDir, `p${String(p).padStart(4, "0")}.json`);
    try {
      if (!existsSync(pngPath)) {
        const png = await renderPagePng(doc, p, DPI_SCALE);
        await writeFile(pngPath, png);
      }
      const v = await paced(() => visionDescribeImages(pngPath, `${id}-p${p}-v`));
      await writeFile(visualsPath, JSON.stringify(v), "utf8");
      totalOk++; totalVisuals += v.length;
      const dt = ((Date.now() - docT0) / 1000).toFixed(0);
      const allMin = ((Date.now() - tAll) / 60000).toFixed(1);
      process.stdout.write(`  p${p} → ${v.length} visual${v.length===1?"":"s"}  [doc ${dt}s · total ${allMin}m]                 \r`);
    } catch (e) {
      totalErr++;
      // Mark as attempted with empty array so we don't loop on it.
      await writeFile(visualsPath, "[]", "utf8");
      console.log(`\n  p${p}  ERR ${e.message.slice(0, 140)}`);
    }
  }
  await doc.cleanup(); await doc.destroy();
}
const dt = ((Date.now() - tAll) / 60000).toFixed(1);
console.log(`\n[augment] done. pages ok=${totalOk} visuals=${totalVisuals} err=${totalErr}  [${dt} min total]`);
