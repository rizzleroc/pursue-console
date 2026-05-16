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

// Pages per ChatGPT call. 1 = legacy one-at-a-time (original behavior).
// 3-5 = effective 3-5x throughput because each batch is one chat message
// rather than N separate fresh chats — same rate-limit cost, more pages.
// Set to 1 to disable batching.
const BATCH_PAGES = Number(process.env.BATCH_PAGES || 4);
const BATCH_SEP   = "<<<<< PAGE BREAK >>>>>";  // unambiguous separator

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => min + Math.random() * (max - min);
// Jittered gap target: ±JITTER around base, floored at 8s for sanity.
const nextGapSecs = () => Math.max(8, rand(PACE_SECS * (1 - JITTER), PACE_SECS * (1 + JITTER)));
// Drift the break thresholds by ±3 / ±6 so they don't fire on the same modulus
let microThreshold = Math.round(PAGES_PER_MICRO_BREAK + rand(-3, 3));
let macroThreshold = Math.round(PAGES_PER_MACRO_BREAK + rand(-6, 6));

async function loadToken() {
  // Env wins. Then check the bundled pursue-vision-mcp token, then whipgen.
  if (process.env.PURSUE_VISION_TOKEN) return process.env.PURSUE_VISION_TOKEN;
  if (process.env.WHIPGEN_TOKEN)       return process.env.WHIPGEN_TOKEN;
  for (const name of [".pursue-vision-token", ".whipgen-token"]) {
    const p = path.join(os.homedir(), name);
    try { return (await readFile(p, "utf8")).trim(); } catch {}
  }
  throw new Error("no daemon token — set PURSUE_VISION_TOKEN or run a daemon that writes ~/.pursue-vision-token");
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

// Multi-page batched call: send N pages in one chat message, expect N
// transcriptions in the reply separated by BATCH_SEP. Falls through to
// individual single-page calls if the model returns the wrong section count
// (caller catches and retries). Returns [{text, visuals}, ...] in order.
async function visionTranscribeBatch(pngPaths, label) {
  if (pngPaths.length === 1) return [await visionTranscribe(pngPaths[0], label)];
  const N = pngPaths.length;
  const prompt =
    `I'm sending you ${N} pages from the same document, in order from page 1 to page ${N}. ` +
    `For each page perform the same transcription task:\n` +
    `• Transcribe the text verbatim, preserving line breaks.\n` +
    `• Write (?) where a portion is unreadable or blacked out.\n` +
    `• Output (blank) if the entire page is blank.\n` +
    `• Include handwritten annotations inline.\n` +
    `• After each page's text, ONLY IF that page contains photographs, drawings, ` +
    `diagrams, sketches, maps, charts, or annotated images, add a section starting with the exact line:\n` +
    `=== VISUAL CONTENT ===\n` +
    `with bulleted lines like "- [PHOTO] description" / [DIAGRAM] / [SKETCH] / [MAP] / [CHART] / [ANNOTATION].\n` +
    `\nBetween consecutive pages output this exact separator line on its own line:\n` +
    `${BATCH_SEP}\n` +
    `\nThe expected structure is:\n` +
    `<page 1 text>\n=== VISUAL CONTENT === (if any)\n${BATCH_SEP}\n<page 2 text>\n${BATCH_SEP}\n... and so on through page ${N}.\n` +
    `Do not include any preamble, summary, or commentary. Begin with page 1 immediately. ` +
    `These are declassified public documents.`;
  const r = await fetch(`${DAEMON}/chat-with-files`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      filePaths: pngPaths, prompt, provider: "chatgpt", label,
      freshChat: true,
      timeoutMs: 600_000,   // 10 min — multi-page replies are longer
    }),
  });
  if (!r.ok) throw new Error(`/chat-with-files HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const raw = j.text ?? j.result?.text ?? j.output ?? "";
  // Split on the separator — case-insensitive, whitespace-tolerant
  const sepRe = new RegExp(`\\n?\\s*${BATCH_SEP.replace(/[<>]/g, c => "\\" + c)}\\s*\\n?`, "i");
  const sections = raw.split(sepRe);
  if (sections.length !== N) {
    const err = new Error(`batch mismatch: expected ${N} pages, got ${sections.length} sections`);
    err.batchMismatch = true;
    err.raw = raw;
    throw err;
  }
  return sections.map(s => splitTextAndVisuals(s));
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

// ---- discover targets ----
// If ONLY is set, that's the explicit list — trust the user, no source filter.
// Otherwise auto-pick scanned docs whose manifest source is 'ocr' / 'mixed'
// (the ones that would most benefit from a vision pass). Sort by page count
// so the smallest finish first and a kill-and-restart isn't stuck behind
// a 200-page giant.
async function discoverTargets() {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "public/text/manifest.json"), "utf8"));
  if (ONLY.size > 0) {
    return [...ONLY]
      .filter(id => manifest[id] && !SKIP.has(id))
      .sort((a, b) => (manifest[a].pages || 0) - (manifest[b].pages || 0));
  }
  const candidates = Object.entries(manifest)
    .filter(([, v]) => v.source === "ocr" || v.source === "mixed")
    .map(([id, v]) => ({ id, pages: v.pages || Infinity }))
    .filter(({ id }) => !SKIP.has(id));
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

// Periodically refresh public/live-feed.json so a local `npm run dev` server
// reflects new vision pages in near-real-time. The deployed build only
// updates on the next git push, but at least the local dashboard is honest
// about what's actively being processed during a long run.
import { spawn } from "node:child_process";
const FEED_REFRESH_MS = 90_000;   // every 90s
let lastFeedRefresh = 0;
function refreshFeedIfStale() {
  const now = Date.now();
  if (now - lastFeedRefresh < FEED_REFRESH_MS) return;
  lastFeedRefresh = now;
  // Fire-and-forget. Failures are non-fatal — we'll try again next batch.
  const child = spawn(process.execPath, [path.join(ROOT, "scripts/build-live-feed.mjs")], {
    cwd: ROOT, stdio: "ignore", detached: false,
  });
  child.on("error", () => {});  // swallow
}

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

  console.log(`\n→ ${id}  (${doc.numPages} pages, vision-OCRing ${nPages}, batch=${BATCH_PAGES})`);
  const docT0 = Date.now();
  let nOk = 0, nCache = 0, nErr = 0;

  // Build the to-do list first — pages that aren't cached and that render OK.
  // Render errors are isolated here so they don't poison a batch upload.
  const todo = [];   // [{ page, pngPath, cachePath, visualsPath }, ...]
  for (let p = 1; p <= nPages; p++) {
    const cachePath = path.join(docCacheDir, `p${String(p).padStart(4, "0")}.txt`);
    const visualsPath = path.join(docVisualsDir, `p${String(p).padStart(4, "0")}.json`);
    if (existsSync(cachePath)) {
      const sz = (await readFile(cachePath, "utf8")).length;
      if (sz > 0) { nCache++; continue; }
    }
    const pngPath = path.join(docPngDir, `p${String(p).padStart(4, "0")}.png`);
    try {
      if (!existsSync(pngPath)) {
        const png = await renderPagePng(doc, p, DPI_SCALE);
        await writeFile(pngPath, png);
      }
      todo.push({ page: p, pngPath, cachePath, visualsPath });
    } catch (e) {
      nErr++;
      await writeFile(cachePath, "", "utf8");
      await writeFile(visualsPath, "[]", "utf8");
      console.log(`\n  p${p}/${nPages}  RENDER ERR ${e.message.slice(0, 140)}`);
    }
  }

  // Write a single batch result back to per-page files
  async function writeBatchResult(batch, results) {
    for (let i = 0; i < batch.length; i++) {
      const { cachePath, visualsPath } = batch[i];
      const text = (results[i]?.text || "").trim();
      const visuals = results[i]?.visuals || [];
      await writeFile(cachePath, text, "utf8");
      await writeFile(visualsPath, JSON.stringify(visuals), "utf8");
    }
  }

  // Process the to-do list in batches of BATCH_PAGES.
  for (let i = 0; i < todo.length; i += BATCH_PAGES) {
    const batch = todo.slice(i, i + BATCH_PAGES);
    const paths = batch.map(b => b.pngPath);
    const firstP = batch[0].page;
    const lastP = batch[batch.length - 1].page;
    const label = batch.length > 1 ? `${id}-p${firstP}-${lastP}` : `${id}-p${firstP}`;
    try {
      const results = await pacedCall(() => visionTranscribeBatch(paths, label));
      await writeBatchResult(batch, results);
      nOk += batch.length;
      refreshFeedIfStale();
      const dt = ((Date.now() - docT0) / 60000).toFixed(1);
      const allMin = ((Date.now() - tAll) / 60000).toFixed(1);
      const vis = results.reduce((s, r) => s + (r.visuals?.length || 0), 0);
      const vTag = vis ? ` +${vis}v` : "";
      const tag = batch.length > 1 ? `[${batch.length}-batch]` : "";
      process.stdout.write(`  p${firstP}${batch.length>1?`-${lastP}`:""}/${nPages} ${tag} ✓${vTag}  [doc ${dt}m · total ${allMin}m]                 \r`);
    } catch (e) {
      // Batch failure → fall back to individual calls so we still get the
      // good pages. Batch-mismatch errors (model returned wrong section
      // count) are recoverable this way.
      console.log(`\n  p${firstP}-${lastP}  BATCH ERR (${e.batchMismatch ? "section-mismatch" : "fetch"}) — falling back to single-page`);
      for (const item of batch) {
        try {
          const result = await pacedCall(() => visionTranscribe(item.pngPath, `${id}-p${item.page}-fb`));
          await writeBatchResult([item], [result]);
          refreshFeedIfStale();
          nOk++;
        } catch (e2) {
          nErr++;
          await writeFile(item.cachePath, "", "utf8");
          await writeFile(item.visualsPath, "[]", "utf8");
          console.log(`  p${item.page}  FALLBACK ERR ${e2.message.slice(0, 120)}`);
        }
      }
    }
  }

  await doc.cleanup(); await doc.destroy();
  totalPages += nPages; totalCached += nCache; totalOcrd += nOk; totalErr += nErr;
  const docDt = ((Date.now() - docT0) / 60000).toFixed(1);
  console.log(`\n  ✓ ${id} — vision ${nOk} · cached ${nCache} · err ${nErr}  [${docDt} min · batch=${BATCH_PAGES}]`);
}

const allMin = ((Date.now() - tAll) / 60000).toFixed(1);
console.log(`\n[vision] done. pages ${totalPages} · ocr ${totalOcrd} · cached ${totalCached} · err ${totalErr}  [${allMin} min total]`);
console.log(`[vision] cache → ${CACHE_DIR}`);
console.log(`[vision] next: update scripts/build-text-files.mjs to prefer .vision-cache over .ocr-cache, then rebuild embeddings`);
