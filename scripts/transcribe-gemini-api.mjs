// transcribe-gemini-api.mjs — Render PDF pages via pdfjs-dist and transcribe
// them using the Gemini REST API, writing results into the vision-cache format.
//
// This is the Node.js equivalent of Denis Sergeevitch's Python pipeline
// (PyMuPDF + google-genai), implementing Phase 1 of design/PRD-OWN-PIPELINE.md.
//
//   data-raw/<eid>.pdf  (input — must already be present)
//        │
//        │  pdfjs-dist render @ 200 DPI → JPEG buffer
//        │  POST to Gemini API (gemini-2.0-flash-lite)
//        ↓
//   data-raw/.vision-cache/<eid>/p<NNNN>.gemini.txt   (cleaned transcript)
//   data-raw/.vision-cache/<eid>/p<NNNN>.sources.json (provenance sidecar)
//
// Source-priority order (matches import-gemini-corpus.mjs):
//   human  >  gpt-vision  >  gemini  >  ocr
//
// Resume-safe: pages whose .gemini.txt + sidecar gemini source already exist
// are skipped.  Run again after a crash and only the missing pages are done.
//
// Usage:
//   GEMINI_API_KEY=... node scripts/transcribe-gemini-api.mjs --eid=<event-id>
//   GEMINI_API_KEY=... node scripts/transcribe-gemini-api.mjs --all [--workers=8] [--dry-run]

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, Path2D, DOMMatrix } from "pdfjs-dist/node_modules/@napi-rs/canvas/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "data-raw");
const VIS_CACHE = path.join(RAW, ".vision-cache");
const SYNC = path.join(RAW, "inventory-sync.json");

// ----- args -----
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

const ONLY_EID  = args.eid   || null;
const ALL       = !!args.all;
const WORKERS   = Math.max(1, Number(args.workers || 8));
const DRY       = !!args["dry-run"];

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("[transcribe] error: GEMINI_API_KEY environment variable is not set.");
  console.error("             export GEMINI_API_KEY=<your-key>  or prefix the command:");
  console.error("             GEMINI_API_KEY=<key> node scripts/transcribe-gemini-api.mjs --eid=...");
  process.exit(1);
}

if (!ONLY_EID && !ALL) {
  console.error("[transcribe] error: specify --eid=<event-id> or --all");
  console.error("             node scripts/transcribe-gemini-api.mjs --eid=arabian-gulf-2020");
  console.error("             node scripts/transcribe-gemini-api.mjs --all [--workers=8] [--dry-run]");
  process.exit(1);
}

// ----- source priority (mirrors import-gemini-corpus.mjs) -----
const SOURCE_PRIORITY = ["human", "gpt-vision", "gemini", "ocr"];

function priorityOf(source) {
  const i = SOURCE_PRIORITY.indexOf(source);
  return i === -1 ? 99 : i;
}

function pickBest(sources) {
  // Lowest priority index wins. Among same priority, longer wins.
  let best = null;
  for (const [name, info] of Object.entries(sources)) {
    if (!info?.chars) continue;
    if (!best) { best = name; continue; }
    const cmp = priorityOf(name) - priorityOf(best);
    if (cmp < 0) best = name;
    else if (cmp === 0 && info.chars > sources[best].chars) best = name;
  }
  return best;
}

async function readSidecar(p) {
  if (!existsSync(p)) return { best: null, sources: {} };
  try { return JSON.parse(await readFile(p, "utf8")); }
  catch { return { best: null, sources: {} }; }
}

// ----- Gemini API -----
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

const TRANSCRIPTION_PROMPT =
  "Please transcribe all text in this document page image. " +
  "Output only the text as it appears, preserving line breaks and paragraph structure. " +
  "Mark redacted sections as [REDACTED]. " +
  "Mark illegible sections as [ILLEGIBLE]. " +
  "Do not add commentary or headers.";

// Exponential backoff on 429 / 503; max 4 retries.
async function callGemini(jpegBase64, retries = 4) {
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: "image/jpeg", data: jpegBase64 } },
        { text: TRANSCRIPTION_PROMPT },
      ],
    }],
  };

  let delay = 2000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (res.ok) {
      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      return text.trim();
    }

    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      // Respect Retry-After header if present, otherwise exponential backoff.
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : delay;
      console.warn(`[transcribe]   HTTP ${res.status} — retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/${retries})`);
      await new Promise(r => setTimeout(r, waitMs));
      delay *= 2;
      continue;
    }

    const errText = (await res.text()).slice(0, 300);
    throw new Error(`Gemini API HTTP ${res.status}: ${errText}`);
  }

  throw new Error("Gemini API: exceeded max retries");
}

// ----- pdfjs setup (mirrors volunteer.mjs) -----
// pdfjs's isValidFetchUrl() rejects file:// URLs; serve assets over HTTP.
const PDFJS_DIST_DIR = path.join(ROOT, "node_modules/pdfjs-dist");
const assetServer = http.createServer((req, res) => {
  const safePath = path.normalize(decodeURIComponent(req.url)).replace(/^[/\\]+/, "");
  const filePath = path.join(PDFJS_DIST_DIR, safePath);
  if (!filePath.startsWith(PDFJS_DIST_DIR + path.sep) && filePath !== PDFJS_DIST_DIR) {
    res.writeHead(403); return res.end();
  }
  const ct = filePath.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
  res.writeHead(200, { "Content-Type": ct });
  createReadStream(filePath).on("error", () => res.end()).pipe(res);
});
await new Promise(resolve => assetServer.listen(0, "127.0.0.1", resolve));
const { port: assetPort } = assetServer.address();

// Wire in @napi-rs/canvas globals before importing pdfjs.
globalThis.Path2D = Path2D;
globalThis.DOMMatrix = DOMMatrix;
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const PDFJS_WASM_URL  = `http://127.0.0.1:${assetPort}/wasm/`;
const PDFJS_FONTS_URL = `http://127.0.0.1:${assetPort}/standard_fonts/`;

class NodeCanvasFactory {
  create(w, h)  { const c = createCanvas(w, h); return { canvas: c, context: c.getContext("2d") }; }
  reset(cv, w, h) { cv.canvas.width = w; cv.canvas.height = h; }
  destroy(cv)  { cv.canvas.width = 0; cv.canvas.height = 0; cv.canvas = null; cv.context = null; }
}

// Render a single PDF page to a JPEG Buffer at scale (default 2.0 ≈ 200 DPI).
async function renderJpeg(doc, pageNum, scale = 2.0) {
  const page = await doc.getPage(pageNum);
  const vp = page.getViewport({ scale });
  const factory = new NodeCanvasFactory();
  const cv = factory.create(Math.floor(vp.width), Math.floor(vp.height));
  await page.render({ canvasContext: cv.context, viewport: vp, canvasFactory: factory }).promise;
  const buf = cv.canvas.toBuffer("image/jpeg", { quality: 0.92 });
  factory.destroy(cv);
  return buf;
}

// ----- resolve which eids to process -----
async function buildEidList() {
  const map = new Map(); // eid → pdf path

  if (!existsSync(SYNC)) {
    // No inventory — only direct data-raw/<eid>.pdf is usable.
    if (ONLY_EID) {
      const p = path.join(RAW, `${ONLY_EID}.pdf`);
      if (existsSync(p)) map.set(ONLY_EID, p);
    }
    return map;
  }

  const inv = JSON.parse(await readFile(SYNC, "utf8"));
  for (const r of (inv.rows || [])) {
    if (!r.event_id) continue;
    const eidPath = path.join(RAW, `${r.event_id}.pdf`);
    if (existsSync(eidPath)) { map.set(r.event_id, eidPath); continue; }
    const rawPath = path.join(RAW, r.filename);
    if (existsSync(rawPath)) map.set(r.event_id, rawPath);
  }

  // Also pick up any <eid>.pdf in data-raw/ not listed in inventory.
  try {
    const files = await readdir(RAW);
    for (const f of files) {
      if (!/\.pdf$/i.test(f)) continue;
      const eid = f.replace(/\.pdf$/i, "");
      if (!map.has(eid)) map.set(eid, path.join(RAW, f));
    }
  } catch {}

  if (ONLY_EID) {
    const single = new Map();
    const p = map.get(ONLY_EID);
    if (p) {
      single.set(ONLY_EID, p);
    } else {
      // Try direct path even if not in inventory.
      const direct = path.join(RAW, `${ONLY_EID}.pdf`);
      if (existsSync(direct)) single.set(ONLY_EID, direct);
    }
    return single;
  }

  return map;
}

// ----- page-level work item -----
// Returns true if this page already has a gemini source in the sidecar.
async function pageAlreadyDone(dstDir, pad4) {
  const geminiTxt = path.join(dstDir, `p${pad4}.gemini.txt`);
  if (!existsSync(geminiTxt)) return false;
  const sidecarPath = path.join(dstDir, `p${pad4}.sources.json`);
  const sidecar = await readSidecar(sidecarPath);
  return !!(sidecar.sources?.gemini?.chars);
}

// Write gemini.txt + update sidecar + sync canonical .txt.
async function writePage(dstDir, pad4, text) {
  const geminiTxt  = path.join(dstDir, `p${pad4}.gemini.txt`);
  const sidecarPath = path.join(dstDir, `p${pad4}.sources.json`);
  const canonPath  = path.join(dstDir, `p${pad4}.txt`);

  await writeFile(geminiTxt, text + "\n", "utf8");

  const sidecar = await readSidecar(sidecarPath);

  // Preserve any pre-existing gpt-vision source that was stored inline in .txt
  // (matches the seeding logic in import-gemini-corpus.mjs).
  if (Object.keys(sidecar.sources).length === 0 && existsSync(canonPath)) {
    const existing = (await readFile(canonPath, "utf8")).trim();
    if (existing.length >= 30) {
      const gptPath = path.join(dstDir, `p${pad4}.gpt-vision.txt`);
      if (!existsSync(gptPath)) await writeFile(gptPath, existing + "\n", "utf8");
      sidecar.sources["gpt-vision"] = {
        chars: existing.length,
        imported_at: null,
        text_file: `p${pad4}.gpt-vision.txt`,
        note: "seeded from pre-existing canonical",
      };
    }
  }

  sidecar.sources.gemini = {
    chars: text.length,
    imported_at: new Date().toISOString(),
    model: "gemini-2.0-flash-lite",
    text_file: `p${pad4}.gemini.txt`,
  };

  const newBest = pickBest(sidecar.sources);
  sidecar.best = newBest;

  // Sync canonical .txt to the winning source's file.
  const winnerInfo = sidecar.sources[newBest];
  if (winnerInfo?.text_file) {
    const winnerPath = path.join(dstDir, winnerInfo.text_file);
    if (existsSync(winnerPath)) {
      const winnerText = await readFile(winnerPath, "utf8");
      await writeFile(canonPath, winnerText, "utf8");
    }
  }

  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
}

// ----- process one event -----
async function processEid(eid, pdfPath) {
  const pdfBuf = await readFile(pdfPath);
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuf),
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: true,
    wasmUrl: PDFJS_WASM_URL,
    standardFontDataUrl: PDFJS_FONTS_URL,
  }).promise;

  const total = doc.numPages;
  const dstDir = path.join(VIS_CACHE, eid);
  await mkdir(dstDir, { recursive: true });

  // Build list of pages still needing transcription.
  const pending = [];
  for (let pg = 1; pg <= total; pg++) {
    const pad4 = String(pg).padStart(4, "0");
    if (!(await pageAlreadyDone(dstDir, pad4))) {
      pending.push(pg);
    }
  }

  if (pending.length === 0) {
    console.log(`[transcribe] ${eid}  all ${total} pages already done — skipping`);
    return { ok: 0, skipped: total, err: 0 };
  }

  console.log(`[transcribe] ${eid}  ${pending.length}/${total} pages to transcribe (${WORKERS} workers)`);

  if (DRY) {
    console.log(`[transcribe] --dry-run: would transcribe pages ${pending.slice(0,5).join(", ")}${pending.length > 5 ? "…" : ""}`);
    return { ok: 0, skipped: total - pending.length, err: 0 };
  }

  let ok = 0, err = 0;

  // Concurrency pool.
  const queue = [...pending];
  async function worker() {
    while (queue.length > 0) {
      const pg = queue.shift();
      if (pg === undefined) break;
      const pad4 = String(pg).padStart(4, "0");
      try {
        const jpegBuf = await renderJpeg(doc, pg);
        const b64 = jpegBuf.toString("base64");
        const text = await callGemini(b64);
        await writePage(dstDir, pad4, text);
        ok++;
        console.log(`[transcribe] ${eid}  p${pad4}/${String(total).padStart(4, "0")} → ${text.length} chars`);
      } catch (e) {
        err++;
        console.error(`[transcribe] ${eid}  p${pad4} ERROR: ${e.message}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(WORKERS, pending.length) }, () => worker());
  await Promise.all(workers);

  return { ok, skipped: total - pending.length, err };
}

// ----- main -----
await mkdir(VIS_CACHE, { recursive: true });

const eidMap = await buildEidList();

if (eidMap.size === 0) {
  if (ONLY_EID) {
    console.error(`[transcribe] no PDF found for eid "${ONLY_EID}"`);
    console.error(`             expected: ${path.join(RAW, ONLY_EID + ".pdf")}`);
    console.error(`             run \`npm run corpus:fetch-missing\` to download PDFs`);
  } else {
    console.error(`[transcribe] no PDFs found in ${RAW}`);
    console.error(`             run \`npm run corpus:fetch-missing\` to download PDFs`);
  }
  assetServer.close();
  process.exit(1);
}

console.log(`[transcribe] ${eidMap.size} event(s) queued · ${WORKERS} worker(s)${DRY ? " · DRY RUN" : ""}`);

let totalOk = 0, totalSkipped = 0, totalErr = 0;
for (const [eid, pdfPath] of eidMap) {
  try {
    const { ok, skipped, err } = await processEid(eid, pdfPath);
    totalOk      += ok;
    totalSkipped += skipped;
    totalErr     += err;
  } catch (e) {
    console.error(`[transcribe] ${eid} FATAL: ${e.message}`);
    totalErr++;
  }
}

assetServer.close();

console.log(`\n[transcribe] done · transcribed ${totalOk} · skipped ${totalSkipped} already-done · errors ${totalErr}`);
if (totalErr > 0) process.exit(2);
