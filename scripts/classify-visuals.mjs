// Page-level visual classification across the whole corpus.
//
// For each page we've already transcribed, render the page as JPEG and
// ask the MCP to classify it into one of:
//
//   photograph        — actual photograph (incl. surveillance imagery)
//   hand-drawing      — witness sketch, hand-drawn diagram
//   photocopied-negative — photocopy of a film negative
//   newspaper-clipping — newspaper article reproduction
//   map               — geographic or floor plan
//   diagram           — technical / mechanical / schematic
//   text-only         — pure typewritten / handwritten text, no imagery
//
// Output per page (sidecar):
//   data-raw/.visuals/<eid>/p<NNN>.json
//     { kind, title, description, classifiedAt, classifier }
//
// AND, if kind !== "text-only":
//   public/media/<eid>/p<NNN>.jpg        (800px max-edge, q70, ~80KB)
//
// The MEDIA view reads this. Deep-link target is the page in DossierView
// — no extracted bboxes, no per-image crops; the page IS the screenshot.
//
// Usage:
//   node scripts/classify-visuals.mjs                       # all unclassified
//   node scripts/classify-visuals.mjs --only=cometa
//   node scripts/classify-visuals.mjs --slice=10            # 10 pages then stop
//   node scripts/classify-visuals.mjs --provider=gemini     # default chatgpt
//   node scripts/classify-visuals.mjs --reclassify          # re-do existing
//
// Requires the daemon at $DAEMON (default :9223) with a logged-in tab
// for the chosen provider.

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "data-raw");
const VIS_CACHE = path.join(RAW, ".vision-cache");
const VISUALS_DIR = path.join(RAW, ".visuals");
const MEDIA_DIR = path.join(ROOT, "public", "media");
const STAGE = path.join(os.homedir(), ".pursue-vision-staging", "classify");
const DAEMON = process.env.DAEMON || "http://127.0.0.1:9223";

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const ONLY = args.only || null;
const SLICE = args.slice ? Number(args.slice) : null;
const PROVIDER = (args.provider || "chatgpt").toLowerCase();
const RECLASSIFY = !!args.reclassify;

// Render at 800px max-edge so the MCP upload is small + the
// committed JPEG fits the repo. 100 DPI ≈ 800px for letter-size.
const RENDER_LONG_SIDE = 1100;   // classifier-pass quality
const COMMIT_LONG_SIDE = 800;    // committed thumbnail (re-render at lower res)
const JPEG_QUALITY = 0.70;
const ALLOWED_KINDS = new Set(["photograph", "hand-drawing", "photocopied-negative", "newspaper-clipping", "map", "diagram", "text-only"]);

const CLASSIFY_PROMPT = `Look at this scanned document page. Classify it as ONE of these categories:

- photograph              an actual photograph (incl. surveillance / aerial imagery)
- hand-drawing            a witness sketch or hand-drawn diagram
- photocopied-negative    a photocopy of a film negative (high contrast, often inverted tones)
- newspaper-clipping      a newspaper article reproduction
- map                     a geographic map or floor plan
- diagram                 a technical, mechanical, or schematic drawing
- text-only               pure typewritten or handwritten text with no visual imagery

Reply with ONE LINE of JSON in this exact shape and nothing else:

{"kind":"<one-of-the-above>","title":"<short title, max 60 chars; for newspaper, use the headline; else describe the subject>","description":"<one sentence, max 200 chars, what's visible>"}

If the page is text-only, set title to "" and description to a brief note like "typewritten memorandum" or "handwritten witness statement, redacted".`;

async function loadToken() {
  for (const p of [path.join(os.homedir(), ".pursue-vision-token"), path.join(os.homedir(), ".whipgen-token")]) {
    try { return (await readFile(p, "utf8")).trim(); } catch {}
  }
  if (process.env.PURSUE_VISION_TOKEN) return process.env.PURSUE_VISION_TOKEN;
  if (process.env.WHIPGEN_TOKEN) return process.env.WHIPGEN_TOKEN;
  console.error("error: no token at ~/.pursue-vision-token / ~/.whipgen-token");
  process.exit(1);
}
const TOKEN = await loadToken();

await mkdir(STAGE, { recursive: true });
await mkdir(VISUALS_DIR, { recursive: true });
await mkdir(MEDIA_DIR, { recursive: true });

// ---- pdfjs render ----
// We pointedly do NOT pass wasmUrl/standardFontDataUrl. The classifier
// pass just rasterizes pages; text glyph fidelity doesn't matter (the
// vision model sees pixels), and the wasm/font loaders intermittently
// fail with "Value is none of these types String, Path" on this
// pdfjs+Node combo. Plain disable-everything beats partial config.
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
class NodeCanvasFactory {
  create(w, h) { const cv = createCanvas(w, h); return { canvas: cv, context: cv.getContext("2d") }; }
  reset(c, w, h) { c.canvas.width = w; c.canvas.height = h; }
  destroy(c) { c.canvas.width = 0; c.canvas.height = 0; c.canvas = null; c.context = null; }
}
const docCache = new Map();
async function getDoc(eid) {
  if (docCache.has(eid)) return docCache.get(eid);
  const candidates = (await readdir(RAW)).filter(f => f.toLowerCase().endsWith(".pdf"));
  let pdfFile = candidates.find(f => f.toLowerCase().replace(/\.pdf$/, "") === eid.toLowerCase())
             || candidates.find(f => f.toLowerCase().includes(eid.toLowerCase()))
             || null;
  if (!pdfFile) { docCache.set(eid, null); return null; }
  const buf = await readFile(path.join(RAW, pdfFile));
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    useWorkerFetch: false,
  }).promise;
  docCache.set(eid, doc);
  return doc;
}
async function renderJpeg(eid, pageNum, longSide, quality) {
  const doc = await getDoc(eid);
  if (!doc) throw new Error(`no local PDF for ${eid}`);
  const page = await doc.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1 });
  const baseLong = Math.max(baseViewport.width, baseViewport.height);
  const scale = longSide / baseLong;
  const viewport = page.getViewport({ scale });
  const factory = new NodeCanvasFactory();
  const cv = factory.create(Math.floor(viewport.width), Math.floor(viewport.height));
  // annotationMode: 0 disables annotation rendering. pdfjs's CanvasGraphics
  // .beginAnnotation throws "Value is none of these types String, Path" on
  // many of our scanned PDFs because the annotation references aren't
  // well-formed. We don't need annotations for visual classification.
  await page.render({ canvasContext: cv.context, viewport, canvasFactory: factory, annotationMode: 0 }).promise;
  const buf = cv.canvas.toBuffer("image/jpeg", { quality });
  factory.destroy(cv);
  return buf;
}

// ---- MCP call ----
async function classifyPageOnce(filePath) {
  const r = await fetch(`${DAEMON}/chat-with-files`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      provider: PROVIDER,
      filePaths: [filePath],
      prompt: CLASSIFY_PROMPT,
      freshChat: true,
      timeoutMs: 120_000,
    }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return (j.text || "").trim();
}

// Tolerant JSON extractor — model sometimes wraps the JSON in markdown
// fences, sometimes truncates, sometimes adds a preamble. Try multiple
// strategies before giving up.
function extractClassification(raw) {
  // Strip markdown fences if present
  const cleaned = raw.replace(/```json\s*|```\s*$/g, "").trim();
  const tries = [];
  const m1 = cleaned.match(/\{[^{}]*"kind"[^{}]*\}/);
  if (m1) tries.push(m1[0]);
  const m2 = cleaned.match(/\{[\s\S]*?\}/);
  if (m2) tries.push(m2[0]);
  // Last resort: parse the cleaned thing as-is
  tries.push(cleaned);
  for (const t of tries) {
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj.kind === "string" && ALLOWED_KINDS.has(obj.kind)) {
        return {
          kind: obj.kind,
          title: String(obj.title || "").slice(0, 60),
          description: String(obj.description || "").slice(0, 200),
        };
      }
    } catch {}
  }
  return null;
}

async function classifyPage(filePath) {
  // Try twice — the model occasionally truncates its reply or wraps it.
  let lastRaw = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await classifyPageOnce(filePath);
    lastRaw = raw;
    const obj = extractClassification(raw);
    if (obj) return obj;
  }
  throw new Error(`no valid classification in reply: ${lastRaw.slice(0, 160)}`);
}

// ---- discover targets ----
async function listEventDirs() {
  try { return (await readdir(VIS_CACHE, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
}
const targets = [];
for (const eid of await listEventDirs()) {
  if (ONLY && eid !== ONLY) continue;
  const dir = path.join(VIS_CACHE, eid);
  const files = await readdir(dir);
  const pageNums = new Set();
  for (const f of files) {
    const m = f.match(/^p(\d+)\.txt$/);
    if (m) pageNums.add(Number(m[1]));
  }
  for (const pn of [...pageNums].sort((a, b) => a - b)) {
    const sidecar = path.join(VISUALS_DIR, eid, `p${String(pn).padStart(4, "0")}.json`);
    if (!RECLASSIFY && existsSync(sidecar)) continue;
    targets.push({ eid, page: pn, sidecar });
  }
}
const queue = SLICE ? targets.slice(0, SLICE) : targets;
console.log(`[classify] ${targets.length} unclassified pages, processing ${queue.length}, provider=${PROVIDER}`);

// ---- main loop ----
const tallies = {};
let ok = 0, failed = 0, mediaSaved = 0;
for (let i = 0; i < queue.length; i++) {
  const { eid, page, sidecar } = queue[i];
  const pad4 = String(page).padStart(4, "0");
  process.stdout.write(`[${i+1}/${queue.length}] ${eid.padEnd(28)} p${pad4} `);

  // Render at classifier-pass quality, stage for MCP
  let classJpeg;
  try { classJpeg = await renderJpeg(eid, page, RENDER_LONG_SIDE, JPEG_QUALITY); }
  catch (e) {
    console.log(`SKIP (render): ${e.message}`);
    if (process.env.DEBUG_RENDER) console.log(e.stack);
    failed++; continue;
  }
  const stagedPath = path.join(STAGE, `${eid}-p${pad4}.jpg`);
  await writeFile(stagedPath, classJpeg);

  // Classify
  let result;
  try { result = await classifyPage(stagedPath); }
  catch (e) { console.log(`FAIL: ${e.message}`); failed++; continue; }
  result.classifiedAt = new Date().toISOString();
  result.classifier = PROVIDER;
  result.promptSha = createHash("sha256").update(CLASSIFY_PROMPT).digest("hex").slice(0, 12);

  // Persist sidecar
  await mkdir(path.dirname(sidecar), { recursive: true });
  await writeFile(sidecar, JSON.stringify(result, null, 2) + "\n", "utf8");

  // If non-text, render the committed thumbnail to public/media/<eid>/p<NNN>.jpg
  if (result.kind !== "text-only") {
    const mediaPath = path.join(MEDIA_DIR, eid, `p${pad4}.jpg`);
    await mkdir(path.dirname(mediaPath), { recursive: true });
    try {
      const thumb = await renderJpeg(eid, page, COMMIT_LONG_SIDE, JPEG_QUALITY);
      await writeFile(mediaPath, thumb);
      mediaSaved++;
    } catch {}
  }

  tallies[result.kind] = (tallies[result.kind] || 0) + 1;
  ok++;
  const titlePreview = result.title ? ` · "${result.title.slice(0, 40)}"` : "";
  console.log(`${result.kind.padEnd(20)}${titlePreview}`);
}

console.log(`\n[classify] done. ok=${ok}  failed=${failed}  media_saved=${mediaSaved}`);
console.log(`[classify] by kind:`);
for (const [k, n] of Object.entries(tallies).sort((a, b) => b[1] - a[1])) {
  console.log(`             ${k.padEnd(22)} ${n}`);
}
console.log(`[classify] next: node scripts/build-media-index.mjs`);
