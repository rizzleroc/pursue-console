// Re-evaluate the cross-source review queue with a STANDARDIZED prompt
// across BOTH Gemini and ChatGPT-vision via the MCP /fanout endpoint.
//
// Purpose: when GPT-vision and Gemini disagree on a page, it's either
// (a) the page is genuinely ambiguous (handwriting, redaction, damage)
//     — re-running with the same prompt won't help, escalate to human
// (b) the original prompts elicited different behaviors from the models
//     — re-running with one canonical prompt should resolve it
//
// This script renders each disputed page at 200 DPI (same as Denis's
// PyMuPDF pipeline) and POSTs it to /fanout with providers=[chatgpt,
// gemini] using prompts/standard-transcription.txt. Results land at:
//
//   data-raw/.vision-cache/<eid>/p<NNN>.gpt-vision.v2.txt
//   data-raw/.vision-cache/<eid>/p<NNN>.gemini.v2.txt
//
// The next `compare-sources` run computes v2-v2 agreement; pages where
// it stays low become page-intrinsic disputes flagged for humans.
//
// Usage:
//   node scripts/reevaluate-disputed.mjs                       # all 22
//   node scripts/reevaluate-disputed.mjs --only=1949-discs     # one doc
//   node scripts/reevaluate-disputed.mjs --slice=5             # first 5
//   DAEMON=http://127.0.0.1:9223 node scripts/reevaluate-disputed.mjs
//
// Requires the pursue-vision-mcp daemon to be running with BOTH:
//   - a logged-in chat.openai.com tab
//   - a logged-in gemini.google.com tab

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
// pdfjs's nested canvas (0.1.x); see backfill-media-renders.mjs.
import { createCanvas } from "pdfjs-dist/node_modules/@napi-rs/canvas/index.js";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import { fanoutWithFallback, createFailureBudget } from "./lib/whipgen-fanout.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VIS = path.join(ROOT, "data-raw", ".vision-cache");
const RAW = path.join(ROOT, "data-raw");
const PROMPT_FILE = path.join(__dirname, "prompts", "standard-transcription.txt");
const STAGE = path.join(os.homedir(), ".pursue-vision-staging", "reeval");
const DAEMON = process.env.DAEMON || "http://127.0.0.1:9223";

// 200 DPI matches Denis's pipeline so the input to both providers is
// equivalent. pdfjs's "scale" is relative to 72 DPI (PDF base), so
// 200/72 ≈ 2.78.
const DPI = 200;
const SCALE = DPI / 72;
const MAX_LONG_SIDE = 3000;

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const ONLY = args.only || null;
const SLICE = args.slice ? Number(args.slice) : null;
const PROVIDERS = ["chatgpt", "gemini", "claude"];

async function loadToken() {
  for (const p of [path.join(os.homedir(), ".pursue-vision-token"), path.join(os.homedir(), ".whipgen-token")]) {
    try { return (await readFile(p, "utf8")).trim(); } catch {}
  }
  if (process.env.PURSUE_VISION_TOKEN) return process.env.PURSUE_VISION_TOKEN;
  if (process.env.WHIPGEN_TOKEN) return process.env.WHIPGEN_TOKEN;
  console.error("error: no token at ~/.pursue-vision-token or ~/.whipgen-token (and no PURSUE_VISION_TOKEN / WHIPGEN_TOKEN env)");
  process.exit(1);
}

const TOKEN = await loadToken();
const PROMPT = await readFile(PROMPT_FILE, "utf8");
const PROMPT_HASH = (await import("node:crypto")).createHash("sha256").update(PROMPT).digest("hex").slice(0, 12);

await mkdir(STAGE, { recursive: true });

// ---- discover the review queue (sidecar truth) ----
async function listEventDirs() {
  try { return (await import("node:fs/promises")).readdir(VIS, { withFileTypes: true }).then(es => es.filter(d => d.isDirectory()).map(d => d.name)); }
  catch { return []; }
}
const eventDirs = await listEventDirs();
const targets = [];
for (const eid of eventDirs) {
  if (ONLY && eid !== ONLY) continue;
  const dir = path.join(VIS, eid);
  const files = await (await import("node:fs/promises")).readdir(dir);
  for (const f of files) {
    const m = f.match(/^p(\d+)\.sources\.json$/);
    if (!m) continue;
    try {
      const sc = JSON.parse(await readFile(path.join(dir, f), "utf8"));
      if (sc.comparison?.needs_review) targets.push({ eid, page: Number(m[1]), sidecarPath: path.join(dir, f), sidecar: sc });
    } catch {}
  }
}
targets.sort((a, b) => (a.sidecar.comparison?.agreement_score ?? 1) - (b.sidecar.comparison?.agreement_score ?? 1));
const queue = SLICE ? targets.slice(0, SLICE) : targets;

if (!queue.length) {
  console.log("[reeval] no disputed pages to re-evaluate");
  process.exit(0);
}

console.log(`[reeval] standardized prompt sha=${PROMPT_HASH}, providers=${PROVIDERS.join(",")}`);
console.log(`[reeval] ${queue.length} disputed pages to re-evaluate (sorted worst-first)`);

// ---- pdfjs render helper ----
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const PDFJS_WASM_URL  = pathToFileURL(path.join(ROOT, "node_modules/pdfjs-dist/wasm")).href + "/";
const PDFJS_FONTS_URL = pathToFileURL(path.join(ROOT, "node_modules/pdfjs-dist/standard_fonts")).href + "/";

class NodeCanvasFactory {
  create(w, h) { const cv = createCanvas(w, h); return { canvas: cv, context: cv.getContext("2d") }; }
  reset(c, w, h) { c.canvas.width = w; c.canvas.height = h; }
  destroy(c) { c.canvas.width = 0; c.canvas.height = 0; c.canvas = null; c.context = null; }
}

const docCache = new Map();
async function getDoc(eid) {
  if (docCache.has(eid)) return docCache.get(eid);
  // Map eid → local PDF file. Catalogued events store url under events.js;
  // we read the inventory rows from corpus-stats for the filename, falling
  // back to scanning data-raw/ for any pdf containing the eid.
  let pdfPath = null;
  try {
    const stats = JSON.parse(await readFile(path.join(ROOT, "public", "corpus-stats.json"), "utf8"));
    // best-effort: walk data-raw/ for a matching pdf
    const candidates = (await (await import("node:fs/promises")).readdir(RAW)).filter(f => f.toLowerCase().endsWith(".pdf"));
    pdfPath = candidates.find(f => f.toLowerCase().replace(/\.pdf$/, "") === eid.toLowerCase())
           || candidates.find(f => f.toLowerCase().includes(eid.toLowerCase()))
           || null;
    if (pdfPath) pdfPath = path.join(RAW, pdfPath);
  } catch {}
  if (!pdfPath || !existsSync(pdfPath)) {
    docCache.set(eid, null);
    return null;
  }
  const buf = await readFile(pdfPath);
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    disableFontFace: true,
    wasmUrl: PDFJS_WASM_URL,
    standardFontDataUrl: PDFJS_FONTS_URL,
  }).promise;
  docCache.set(eid, doc);
  return doc;
}

async function renderPng(eid, pageNum) {
  const doc = await getDoc(eid);
  if (!doc) throw new Error(`no local PDF for ${eid}`);
  const page = await doc.getPage(pageNum);
  let scale = SCALE;
  const baseViewport = page.getViewport({ scale: 1 });
  const longSide = Math.max(baseViewport.width, baseViewport.height) * SCALE;
  if (longSide > MAX_LONG_SIDE) scale = SCALE * (MAX_LONG_SIDE / longSide);
  const viewport = page.getViewport({ scale });
  const factory = new NodeCanvasFactory();
  const cv = factory.create(Math.floor(viewport.width), Math.floor(viewport.height));
  await page.render({ canvasContext: cv.context, viewport, canvasFactory: factory }).promise;
  const buf = cv.canvas.toBuffer("image/png");
  factory.destroy(cv);
  return buf;
}

// ---- main loop ----
//
// /fanout itself can stall when a browser tab gets stuck (#258); the
// wrapper bounds that with a wall-clock deadline, retries transient
// transport errors with backoff, and fills any missing provider via
// serial /chat-with-files. A shared failure budget drops a stuck
// provider after two failures so the rest of the queue isn't burned
// hitting the same timeout per page.
const FAILURE_BUDGET = createFailureBudget();

let ok = 0, partial = 0, failed = 0;
for (let i = 0; i < queue.length; i++) {
  const { eid, page, sidecarPath, sidecar } = queue[i];
  const pad4 = String(page).padStart(4, "0");
  process.stdout.write(`[${i+1}/${queue.length}] ${eid.padEnd(28)} p${pad4} `);

  let png;
  try { png = await renderPng(eid, page); }
  catch (e) { console.log(`SKIP (render): ${e.message}`); failed++; continue; }

  const stagedPath = path.join(STAGE, `${eid}-p${pad4}.png`);
  await writeFile(stagedPath, png);

  let res;
  try {
    res = await fanoutWithFallback({
      daemonBaseUrl: DAEMON,
      token: TOKEN,
      providers: PROVIDERS,
      filePaths: [stagedPath],
      prompt: PROMPT,
      label: "pursue-reeval",
      freshChat: true,
      failureBudget: FAILURE_BUDGET,
    });
  } catch (e) {
    console.log(`FAIL (${e.code || "fanout"}): ${e.message}`);
    failed++;
    continue;
  }

  const dstDir = path.join(VIS, eid);
  await mkdir(dstDir, { recursive: true });

  const writes = [];
  const reevaluation = { at: new Date().toISOString(), prompt_sha: PROMPT_HASH, providers: {} };
  let anyOk = 0, anyFail = 0;
  for (const provider of PROVIDERS) {
    const r = res.byProvider[provider];
    const sourceKey = provider === "chatgpt" ? "gpt-vision" : provider; // align to our source naming
    if (r?.ok && r.text?.trim().length >= 20) {
      const text = r.text.trim();
      const fp = path.join(dstDir, `p${pad4}.${sourceKey}.v2.txt`);
      writes.push(writeFile(fp, text + "\n", "utf8"));
      reevaluation.providers[sourceKey] = { chars: text.length, duration_ms: r.durationMs, text_file: `p${pad4}.${sourceKey}.v2.txt` };
      anyOk++;
    } else {
      reevaluation.providers[sourceKey] = { ok: false, error: r?.error || "no-text" };
      anyFail++;
    }
  }
  await Promise.all(writes);

  // Persist reevaluation block on sidecar
  sidecar.comparison ||= {};
  sidecar.comparison.reevaluation = reevaluation;
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n", "utf8");

  if (anyOk === PROVIDERS.length) { console.log(`OK [${res.path}] (${res.totalMs}ms)`); ok++; }
  else if (anyOk > 0)             { console.log(`PARTIAL [${res.path}] (${anyOk}/${PROVIDERS.length}, ${res.totalMs}ms)`); partial++; }
  else                            { console.log(`FAIL [${res.path}] (no provider returned text, ${res.totalMs}ms)`); failed++; }
}

console.log(`\n[reeval] done. ok=${ok}  partial=${partial}  failed=${failed}`);
console.log(`[reeval] next: node scripts/compare-sources.mjs && node scripts/db-rebuild.mjs && node scripts/export-review-queue.mjs`);
