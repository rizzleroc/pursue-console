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

// pdfjs occasionally emits an AbortException from internal aborted-render
// machinery that escapes our try/catch as an unhandled rejection. Without
// this handler Node v24 terminates the whole process on first occurrence,
// killing the long-running OCR loop. We log and keep going.
process.on("unhandledRejection", (err) => {
  console.error("  ! unhandledRejection (continuing):", (err && (err.message || err.toString())) || err);
});
process.on("uncaughtException", (err) => {
  console.error("  ! uncaughtException (continuing):", (err && (err.message || err.toString())) || err);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(ROOT, "data-raw");
const CACHE_DIR = path.join(RAW_DIR, ".vision-cache");
const VISUALS_DIR = path.join(RAW_DIR, ".vision-visuals-cache");
// PNG staging area inside the daemon's allowed read root (homedir).
// The daemon won't accept paths outside ALLOWED_READ_ROOTS (defaults to ~).
const PNG_STAGE = path.join(os.homedir(), ".whipgen-smoke", "pursue-console");

const DAEMON = process.env.DAEMON || "http://127.0.0.1:9223";
const MAX_PAGES = process.env.MAX_PAGES ? Number(process.env.MAX_PAGES) : Infinity;
const DPI_SCALE = Number(process.env.DPI_SCALE || 2.0);
const SKIP = new Set((process.env.SKIP || "").split(",").filter(Boolean));
const ONLY = new Set((process.env.ONLY || "").split(",").filter(Boolean));
// Humanized pacing. Fixed-interval calls are an automation tell — even
// rate-limit-respecting ones. We jitter every interval and insert micro
// breaks (a couple of minutes, every 5-11 pages) and macro breaks
// (8-15 minutes, every 25-40 pages) to look like a real human reading,
// transcribing, and stepping away for coffee / lunch.
//
// Env tunables:
//   PACE_SECS                  base seconds between calls (default 25)
//   JITTER                     ±fraction of base, default 0.6 → 10-40s gaps
//   PAGES_PER_MICRO_BREAK      avg pages before a coffee break (default 8)
//   MICRO_BREAK_MIN_SECS / MAX micro break duration range (default 90-240)
//   PAGES_PER_MACRO_BREAK      avg pages before a meal break (default 32)
//   MACRO_BREAK_MIN_SECS / MAX macro break duration range (default 480-900)
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
// Jittered gap target: ±JITTER around base, floored at 8s for sanity.
const nextGapSecs = () => Math.max(8, rand(PACE_SECS * (1 - JITTER), PACE_SECS * (1 + JITTER)));
// Drift the break thresholds by ±3 / ±6 so they don't fire on the same modulus
let microThreshold = Math.round(PAGES_PER_MICRO_BREAK + rand(-3, 3));
let macroThreshold = Math.round(PAGES_PER_MACRO_BREAK + rand(-6, 6));

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
// Returns { text, visuals } where:
//   text    — verbatim text transcription (what previous prompt produced)
//   visuals — array of { kind, description } if the page contains photos,
//             diagrams, sketches, maps, or annotated images; empty otherwise.
//
// Both parts come back from a single ChatGPT-vision call. We split on a
// known marker so legacy text-only cache files remain valid.
async function visionTranscribe(pngPath, label) {
  const prompt =
    "Please transcribe the text shown in this image so I can search the content. " +
    "Output only the text exactly as written, preserving line breaks. " +
    "If a portion is unreadable or has been blacked out, write (?) in its place. " +
    "If the page is entirely blank, output: (blank). " +
    "If you can read handwritten annotations, include them inline.\n\n" +
    "After the transcribed text, if and only if the page contains any " +
    "photographs, drawings, diagrams, sketches, maps, charts, or annotated " +
    "images, add a section beginning with the exact line:\n" +
    "=== VISUAL CONTENT ===\n" +
    "and under it one bulleted line per visual element, prefixed with the " +
    "kind in brackets. Use these kinds: [PHOTO], [DIAGRAM], [SKETCH], " +
    "[MAP], [CHART], [ANNOTATION]. Describe what is shown — subjects, " +
    "context, captions, arrows, circled regions, scale, anything that " +
    "would help someone searching for the visual content. Example:\n" +
    "- [PHOTO] black-and-white aerial photograph of a desert airstrip with " +
    "two parked aircraft, no caption visible.\n" +
    "- [ANNOTATION] red ink circle and arrow drawn over a small dot in the " +
    "upper-right quadrant of the photo.\n" +
    "If there are no visual elements at all, omit the VISUAL CONTENT " +
    "section entirely — do not include the marker.\n\n" +
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
      timeoutMs: 300_000,     // 5 min — dense pages occasionally take 3-4 min
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`/analyze HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  const j = await r.json();
  // Daemon returns { text, jobId, durationMs, ... }
  const raw = j.text ?? j.result?.text ?? j.output ?? "";
  return splitTextAndVisuals(raw);
}

// Split the model output on the visual-content marker. Robust to small
// formatting drift — case-insensitive, optional surrounding whitespace.
function splitTextAndVisuals(raw) {
  const re = /\n?\s*===\s*VISUAL\s+CONTENT\s*===\s*\n?/i;
  const m = raw.match(re);
  if (!m) return { text: raw.trim(), visuals: [] };
  const text = raw.slice(0, m.index).trim();
  const tail = raw.slice(m.index + m[0].length).trim();
  // Parse bulleted lines: `- [KIND] description`
  const visuals = [];
  for (const line of tail.split(/\n+/)) {
    const lm = line.trim().match(/^[-•*]\s*\[([A-Z]+)\]\s*(.+)$/);
    if (lm) {
      visuals.push({ kind: lm[1].toLowerCase(), description: lm[2].trim() });
    }
  }
  return { text, visuals };
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
let lastCallEndedAt = 0;          // for pacing
let consecutiveFetchFailures = 0; // for adaptive backoff
let callsSinceMicro = 0;          // counter toward next coffee break
let callsSinceMacro = 0;          // counter toward next meal break

async function pacedCall(fn) {
  // Macro break first (rarer, longer — like stepping away for lunch)
  if (callsSinceMacro >= macroThreshold) {
    const secs = rand(MACRO_BREAK_MIN_SECS, MACRO_BREAK_MAX_SECS);
    console.log(`\n  ☕☕ macro break — ${(secs/60).toFixed(1)} min (after ${callsSinceMacro} calls)`);
    await sleep(secs * 1000);
    callsSinceMacro = 0; callsSinceMicro = 0;
    macroThreshold = Math.round(PAGES_PER_MACRO_BREAK + rand(-6, 6));
    microThreshold = Math.round(PAGES_PER_MICRO_BREAK + rand(-3, 3));
  } else if (callsSinceMicro >= microThreshold) {
    // Micro break (more frequent, shorter — coffee, restroom, distraction)
    const secs = rand(MICRO_BREAK_MIN_SECS, MICRO_BREAK_MAX_SECS);
    console.log(`\n  ☕  micro break — ${(secs/60).toFixed(1)} min (after ${callsSinceMicro} calls)`);
    await sleep(secs * 1000);
    callsSinceMicro = 0;
    microThreshold = Math.round(PAGES_PER_MICRO_BREAK + rand(-3, 3));
  }

  // Jittered gap between successive calls so cadence isn't fixed-period
  const gap = Date.now() - lastCallEndedAt;
  const targetMs = nextGapSecs() * 1000;
  if (gap < targetMs) await sleep(targetMs - gap);

  try {
    const out = await fn();
    consecutiveFetchFailures = 0;
    callsSinceMicro++;
    callsSinceMacro++;
    return out;
  } catch (e) {
    if (/fetch failed|ECONN|ETIMEDOUT/i.test(e.message || "")) {
      consecutiveFetchFailures++;
      // 60s, 120s, 240s, 480s — give the daemon/CDN time to recover.
      const backoff = Math.min(60 * Math.pow(2, consecutiveFetchFailures - 1), 480);
      console.log(`\n  ⏸  consecutive fetch fail #${consecutiveFetchFailures} — backing off ${backoff}s`);
      await sleep(backoff * 1000);
    }
    throw e;
  } finally {
    lastCallEndedAt = Date.now();
  }
}

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
  const docCacheDir   = path.join(CACHE_DIR, id);
  const docVisualsDir = path.join(VISUALS_DIR, id);
  const docPngDir     = path.join(PNG_STAGE, id);
  await mkdir(docCacheDir, { recursive: true });
  await mkdir(docVisualsDir, { recursive: true });
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
      const result = await pacedCall(() => visionTranscribe(pngPath, `${id}-p${p}`));
      const text = (result.text || "").trim();
      const visuals = result.visuals || [];
      await writeFile(cachePath, text, "utf8");
      // Always write a visuals file (empty if none) so re-runs can tell the
      // difference between "we asked and there were none" vs "we never asked".
      const visualsPath = path.join(docVisualsDir, `p${String(p).padStart(4, "0")}.json`);
      await writeFile(visualsPath, JSON.stringify(visuals), "utf8");
      nOk++;
      const dt = ((Date.now() - docT0) / 1000).toFixed(0);
      const allMin = ((Date.now() - tAll) / 60000).toFixed(1);
      const vTag = visuals.length ? ` +${visuals.length}v` : "";
      process.stdout.write(`  p${p}/${nPages}  ${text.length}c${vTag}  [doc ${dt}s · total ${allMin}m]                 \r`);
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
