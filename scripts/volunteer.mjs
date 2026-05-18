// volunteer.mjs — SETI-style "How can I help?" runner
//
// Polls the published work queue, claims a slice of pages, downloads the
// source PDFs directly from war.gov, runs vision OCR through the contributor's
// own pursue-vision-mcp daemon, writes results into contributions/<handle>/,
// and (optionally) opens a pull request.
//
// Usage:
//   node scripts/volunteer.mjs --my-handle=@your-gh-handle [options]
//
// Options:
//     --my-handle=<handle>         GitHub handle (no @, used for path + PR author)
//     --provider=chatgpt|gemini    Vision model (default chatgpt). Writes to
//                                  contributions/<handle>/gpt-vision/  or
//                                  contributions/<handle>/gemini/        accordingly.
//                                  Requires the matching tab logged-in in your Chrome.
//     --slice=20                   Max pages to claim this run (default 20)
//     --eid=<event-id>             Restrict to a single event (else picks deterministically)
//     --batch-pages=4              Pages per batch (default 4)
//     --daemon=http://127.0.0.1:9223   pursue-vision-mcp address
//     --token-file=~/.pursue-vision-token
//     --queue-url=https://rizzleroc.github.io/pursue-console/work-available.json
//     --pdf-root=./data-raw/volunteer    Where downloaded PDFs land (gitignored)
//     --no-pr                      Skip the `gh pr create` step (do it yourself)
//     --dry-run                    Plan only; download nothing, OCR nothing
//
// Exit codes:
//     0  done
//     1  setup error (no daemon, bad args, etc)
//     2  partial completion (some pages succeeded, some failed)

import { readFile, writeFile, mkdir, readdir, rename } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCanvas, Path2D, DOMMatrix } from "@napi-rs/canvas";

process.on("unhandledRejection", e => console.error("  ! unhandled:", e?.message || e));
process.on("uncaughtException",  e => console.error("  ! uncaught:",  e?.message || e));

// ----- args -----
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

const HANDLE = (args["my-handle"] || "").replace(/^@/, "").trim();
if (!HANDLE) {
  console.error("error: --my-handle=<your-github-handle> is required");
  console.error("       this is the directory contributions land in (contributions/<handle>/...)");
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,39}$/.test(HANDLE)) {
  console.error(`error: '${HANDLE}' is not a valid GitHub handle`);
  process.exit(1);
}

const SLICE = Number(args.slice || 20);
const ONLY_EID = args.eid || null;
const BATCH_PAGES = Number(args["batch-pages"] || 4);
const DAEMON = args.daemon || "http://127.0.0.1:9223";
const QUEUE_URL = args["queue-url"] || "https://rizzleroc.github.io/pursue-console/work-available.json";
const DRY = !!args["dry-run"];
const NO_PR = !!args["no-pr"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PDF_ROOT = path.resolve(args["pdf-root"] || path.join(ROOT, "data-raw/volunteer"));
// Provider (--provider=chatgpt|gemini, default chatgpt). The MCP daemon
// routes the request to the matching driver. The `<source>` segment of
// the contribution path is the same string the corpus uses (gpt-vision
// for chatgpt, gemini for gemini), so a re-run on the other provider
// adds a second source to the same page rather than overwriting it.
const PROVIDER = (args.provider || "chatgpt").toLowerCase();
const PROVIDER_TO_SOURCE = { chatgpt: "gpt-vision", gemini: "gemini" };
const CONTRIB_SOURCE = PROVIDER_TO_SOURCE[PROVIDER];
if (!CONTRIB_SOURCE) {
  console.error(`error: --provider must be 'chatgpt' or 'gemini' (got '${PROVIDER}')`);
  process.exit(1);
}
const CONTRIB_ROOT = path.join(ROOT, "contributions", HANDLE, CONTRIB_SOURCE);
const TOKEN_FILE = (args["token-file"] || "~/.pursue-vision-token").replace(/^~/, os.homedir());

async function loadToken() {
  if (process.env.PURSUE_VISION_TOKEN) return process.env.PURSUE_VISION_TOKEN;
  if (process.env.WHIPGEN_TOKEN) return process.env.WHIPGEN_TOKEN;
  // Try whipgen-token first — if the primary MCP is running it takes precedence.
  // Falls back to pursue-vision-token for standalone daemon setups.
  for (const p of [path.join(os.homedir(), ".whipgen-token"), TOKEN_FILE]) {
    try { return (await readFile(p, "utf8")).trim(); } catch {}
  }
  console.error(`error: no token. Start the daemon first (it writes ${TOKEN_FILE}), or set PURSUE_VISION_TOKEN`);
  process.exit(1);
}
const TOKEN = await loadToken();

// ----- step 1: fetch the work queue -----
console.log(`[volunteer] fetching ${QUEUE_URL}`);
const queueRes = await fetch(QUEUE_URL);
if (!queueRes.ok) { console.error(`error: queue fetch HTTP ${queueRes.status}`); process.exit(1); }
const queue = await queueRes.json();
console.log(`[volunteer] queue gen ${queue.generatedAt} · ${queue.totalDocsRemaining} docs · ${queue.totalPagesNeeded} pages need vision OCR`);

// ----- step 2: pick a slice -----
// Picking strategy: hash(handle) determines a stable starting event so two
// volunteers running concurrently don't both grab the same first doc.
// Within an event we just take the head of the queue.
function hash(s) { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) | 0; return Math.abs(h); }
let candidateEids = Object.keys(queue.byEvent);
if (ONLY_EID) {
  if (!queue.byEvent[ONLY_EID]) { console.error(`error: --eid=${ONLY_EID} is not in the queue (already done?)`); process.exit(1); }
  candidateEids = [ONLY_EID];
} else {
  // Stable rotation: start from hash(handle) % length, but always rotate
  // to favor pdfjs-render-friendly docs over the known-bad ones.
  const KNOWN_RENDER_HARD = new Set(["fbi-62hq83894", "skylab"]);
  candidateEids = candidateEids.filter(e => !KNOWN_RENDER_HARD.has(e));
  const start = hash(HANDLE) % Math.max(1, candidateEids.length);
  candidateEids = candidateEids.slice(start).concat(candidateEids.slice(0, start));
}

const claims = [];   // { eid, doc, pages: [pageNumbers] }
let remaining = SLICE;
for (const eid of candidateEids) {
  if (remaining <= 0) break;
  const doc = queue.byEvent[eid];
  if (!doc.pdfUrl) continue;
  const take = doc.queue.slice(0, remaining);
  if (!take.length) continue;
  claims.push({ eid, doc, pages: take });
  remaining -= take.length;
}
const total = claims.reduce((s, c) => s + c.pages.length, 0);
console.log(`[volunteer] claiming ${total} page(s) across ${claims.length} doc(s):`);
for (const c of claims) console.log(`    ${c.eid.padEnd(28)} pages ${c.pages.join(",")}`);

// ---- progress reporter → MONITOR (separate process from MCP daemon) ----
// Two parallel write paths:
//   1. POST to http://127.0.0.1:9224/progress (the monitor) — live push
//   2. Write to ~/.pursue-helper/progress.json — survives monitor restarts
// Both are best-effort. The dashboard polls /progress; if the POST fails
// the dashboard just shows the previous state. Never fatal.
const MONITOR_URL = process.env.PURSUE_MONITOR_URL || "http://127.0.0.1:9224";
const MONITOR_TOKEN = process.env.PURSUE_MONITOR_TOKEN || null;  // monitor is unauth by default
const HELPER_DIR = process.env.PURSUE_HELPER_DIR || path.join(os.homedir(), ".pursue-helper");
const STATE_PATH = path.join(HELPER_DIR, "progress.json");
const STATE_TMP  = path.join(HELPER_DIR, "progress.json.tmp");
await mkdir(HELPER_DIR, { recursive: true }).catch(() => {});

const SHIFT_START = Date.now();
const sessionRecent = [];
let currentState = {
  handle: HANDLE, shiftStart: SHIFT_START, idle: false,
  now: null, slice: { done: 0, total: 0 }, corpus: { done: 0, target: 0 },
  recent: [], session: { pagesOk: 0, pagesErr: 0 },
};
async function reportProgress(patch = {}) {
  currentState = { ...currentState, ...patch, updatedAt: Date.now() };
  // Path 1: POST to monitor
  try {
    const headers = { "Content-Type": "application/json" };
    if (MONITOR_TOKEN) headers.Authorization = `Bearer ${MONITOR_TOKEN}`;
    await fetch(`${MONITOR_URL}/progress`, {
      method: "POST",
      headers,
      body: JSON.stringify(currentState),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
  // Path 2: atomic write to local file
  try {
    await writeFile(STATE_TMP, JSON.stringify(currentState), "utf8");
    await rename(STATE_TMP, STATE_PATH);
  } catch {}
}
function recordCompletion(page, state, note) {
  sessionRecent.push({ page, state, note, ts: Date.now() });
  while (sessionRecent.length > 6) sessionRecent.shift();
}

// Best-effort initial broadcast so the dashboard reflects the claim
await reportProgress({
  now: { phase: "rendering pending pages…", eid: claims[0]?.eid, page: claims[0]?.pages[0] },
  slice: { done: 0, total },
  corpus: { done: queue.totalDocsRemaining ? (queue.inventoryTotal || 162) - queue.totalPagesNeeded : 0, target: queue.inventoryTotal || 162 },
  recent: [],
  session: { pagesOk: 0, pagesErr: 0 },
});

if (DRY) { console.log("[volunteer] --dry-run set, exiting before any work."); process.exit(0); }

// ----- step 3: download PDFs -----
await mkdir(PDF_ROOT, { recursive: true });
for (const c of claims) {
  const dest = path.join(PDF_ROOT, `${c.eid}.pdf`);
  if (existsSync(dest)) { console.log(`  ⊖ ${c.eid}.pdf already present`); continue; }
  console.log(`  ↓ ${c.eid}.pdf  ${c.doc.pdfUrl}`);
  const r = await fetch(c.doc.pdfUrl);
  if (!r.ok) { console.error(`    HTTP ${r.status} — skipping doc`); c.skip = true; continue; }
  await writeFile(dest, Buffer.from(await r.arrayBuffer()));
}
const live = claims.filter(c => !c.skip);

// ----- step 4: render + OCR via daemon -----
// pdfjs's isValidFetchUrl() rejects file:// URLs (only accepts http/https), so
// useWorkerFetch is never enabled and wasm/font loading silently fails. Serve
// the pdfjs-dist assets over a local HTTP server so the URLs pass validation.
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
console.log(`[volunteer] pdfjs asset server → http://127.0.0.1:${assetPort}/`);

// pdfjs creates `new Path2D()` from whatever is in scope; @napi-rs/canvas's
// clip/fill only accept their own Path2D class. Wire it up before import.
globalThis.Path2D = Path2D;
globalThis.DOMMatrix = DOMMatrix;
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const PDFJS_WASM_URL  = `http://127.0.0.1:${assetPort}/wasm/`;
const PDFJS_FONTS_URL = `http://127.0.0.1:${assetPort}/standard_fonts/`;
class NCF {
  create(w, h) { const c = createCanvas(w, h); return { canvas: c, context: c.getContext("2d") }; }
  reset(cv, w, h) { cv.canvas.width = w; cv.canvas.height = h; }
  destroy(cv) { cv.canvas.width = 0; cv.canvas.height = 0; cv.canvas = null; cv.context = null; }
}
async function renderPng(doc, page, scale = 2.0) {
  const p = await doc.getPage(page);
  const vp = p.getViewport({ scale });
  const factory = new NCF();
  const cv = factory.create(Math.floor(vp.width), Math.floor(vp.height));
  await p.render({ canvasContext: cv.context, viewport: vp, canvasFactory: factory }).promise;
  const buf = cv.canvas.toBuffer("image/png");
  factory.destroy(cv);
  return buf;
}

const BATCH_SEP = "<<<<< PAGE BREAK >>>>>";
const PROMPT_SINGLE =
  "Please transcribe the text shown in this image so I can search the content. " +
  "Output only the text exactly as written, preserving line breaks. " +
  "If a portion is unreadable or has been blacked out, write (?) in its place. " +
  "If the page is entirely blank, output: (blank). " +
  "If you can read handwritten annotations, include them inline. " +
  "After the transcribed text, if and only if the page contains any photographs, drawings, diagrams, " +
  "sketches, maps, charts, or annotated images, add a section beginning with the exact line:\n" +
  "=== VISUAL CONTENT ===\nand under it one bulleted line per visual element, prefixed with the kind " +
  "in brackets. Use these kinds: [PHOTO], [DIAGRAM], [SKETCH], [MAP], [CHART], [ANNOTATION].\n" +
  "If there are no visual elements, omit the VISUAL CONTENT section entirely.\n\n" +
  "This is a declassified public document.";

function batchPrompt(n) {
  return `I'm sending you ${n} pages from the same document, in order from page 1 to page ${n}. ` +
    `For each page perform the same transcription task:\n` +
    `• Transcribe the text verbatim, preserving line breaks.\n` +
    `• Write (?) where unreadable or blacked out.\n` +
    `• Output (blank) for blank pages.\n` +
    `• Include handwritten annotations inline.\n` +
    `• After each page's text, ONLY IF that page contains photographs/drawings/diagrams/sketches/maps/charts/annotated images, ` +
    `add a section starting with the exact line "=== VISUAL CONTENT ===" with bulleted lines like ` +
    `"- [PHOTO] description" / [DIAGRAM] / [SKETCH] / [MAP] / [CHART] / [ANNOTATION].\n` +
    `Between consecutive pages output this exact separator line on its own line:\n${BATCH_SEP}\n` +
    `Do not include any preamble, summary, or commentary. Begin with page 1. ` +
    `These are declassified public documents.`;
}
function splitVisuals(raw) {
  const m = raw.match(/\n?\s*===\s*VISUAL\s+CONTENT\s*===\s*\n?/i);
  if (!m) return { text: raw.trim(), visuals: [] };
  const text = raw.slice(0, m.index).trim();
  const tail = raw.slice(m.index + m[0].length).trim();
  const visuals = [];
  for (const line of tail.split(/\n+/)) {
    const lm = line.trim().match(/^[-•*]\s*\[([A-Z]+)\]\s*(.+)$/);
    if (lm) visuals.push({ kind: lm[1].toLowerCase(), description: lm[2].trim() });
  }
  return { text, visuals };
}
async function callDaemon(filePaths) {
  const isBatch = filePaths.length > 1;
  const prompt = isBatch ? batchPrompt(filePaths.length) : PROMPT_SINGLE;
  const r = await fetch(`${DAEMON}/chat-with-files`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ provider: PROVIDER, filePaths, prompt, freshChat: true, timeoutMs: 600_000 }),
  });
  if (!r.ok) throw new Error(`daemon HTTP ${r.status}: ${(await r.text()).slice(0,200)}`);
  const j = await r.json();
  const raw = j.text ?? j.result?.text ?? j.output ?? "";
  if (!isBatch) return [splitVisuals(raw)];
  const sepRe = new RegExp(`\\n?\\s*${BATCH_SEP.replace(/[<>]/g, c => "\\" + c)}\\s*\\n?`, "i");
  const sections = raw.split(sepRe);
  if (sections.length !== filePaths.length) {
    const err = new Error(`batch returned ${sections.length} sections for ${filePaths.length} pages`);
    err.batchMismatch = true; throw err;
  }
  return sections.map(s => splitVisuals(s));
}

const PNG_STAGE = path.join(os.homedir(), ".pursue-vision-staging", HANDLE);
await mkdir(PNG_STAGE, { recursive: true });

let pagesOK = 0, pagesErr = 0;
const tAll = Date.now();
for (const c of live) {
  const pdfBuf = await readFile(path.join(PDF_ROOT, `${c.eid}.pdf`));
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuf),
    useSystemFonts: false, disableFontFace: true,
    useWorkerFetch: true,
    wasmUrl: PDFJS_WASM_URL, standardFontDataUrl: PDFJS_FONTS_URL,
  }).promise;
  const docDir = path.join(CONTRIB_ROOT, c.eid);
  const docPngDir = path.join(PNG_STAGE, c.eid);
  await mkdir(docDir, { recursive: true });
  await mkdir(docPngDir, { recursive: true });

  // Render all pages we can; isolate render errors
  const ready = [];
  for (const p of c.pages) {
    const txt = path.join(docDir, `p${String(p).padStart(4,"0")}.txt`);
    const jsn = path.join(docDir, `p${String(p).padStart(4,"0")}.json`);
    if (existsSync(txt)) { console.log(`  ⊖ ${c.eid} p${p} already submitted`); continue; }
    const png = path.join(docPngDir, `p${String(p).padStart(4,"0")}.png`);
    try {
      if (!existsSync(png)) await writeFile(png, await renderPng(doc, p, 2.0));
      ready.push({ p, png, txt, jsn });
    } catch (e) {
      pagesErr++;
      await writeFile(txt, "", "utf8");
      await writeFile(jsn, "[]", "utf8");
      console.log(`  ✗ ${c.eid} p${p}  RENDER  ${e.message.slice(0,120)}\n${e.stack?.split('\n').slice(1,5).join('\n')}`);
      recordCompletion(p, "render_err", e.message.slice(0, 60));
      reportProgress({
        slice: { done: pagesOK, total },
        session: { pagesOk: pagesOK, pagesErr },
        recent: sessionRecent.slice(),
      });
    }
  }

  // Send in BATCH_PAGES slices
  for (let i = 0; i < ready.length; i += BATCH_PAGES) {
    const batch = ready.slice(i, i + BATCH_PAGES);
    const pages = batch.map(b => b.p).join(",");
    const firstP = batch[0].p;

    // Tell the dashboard what we're focused on RIGHT NOW
    const previewB64 = Buffer.from(batch[0].png, "utf8").toString("base64url");
    reportProgress({
      now: {
        eid: c.eid,
        page: firstP,
        docMeta: c.doc.title + (c.doc.agency ? "  ·  " + c.doc.agency : ""),
        phase: batch.length > 1 ? `batched ${batch.length} pages · awaiting ChatGPT` : "single page · awaiting ChatGPT",
        metaLine: `BATCH ${Math.floor(i / BATCH_PAGES) + 1} / ${Math.ceil(ready.length / BATCH_PAGES)}     ·     PAGES ${pages}     ·     SLICE ${pagesOK}/${total}`,
        previewUrl: `/preview/${previewB64}`,
      },
    });

    try {
      const out = await callDaemon(batch.map(b => b.png));
      for (let j = 0; j < batch.length; j++) {
        const { text, visuals } = out[j];
        await writeFile(batch[j].txt, (text || "").trim(), "utf8");
        await writeFile(batch[j].jsn, JSON.stringify(visuals), "utf8");
        recordCompletion(batch[j].p, "ok", batch.length > 1 ? "batched" : "single");
      }
      pagesOK += batch.length;
      console.log(`  ✓ ${c.eid} p${pages}  batched`);
      reportProgress({
        slice: { done: pagesOK, total },
        session: { pagesOk: pagesOK, pagesErr },
        recent: sessionRecent.slice(),
      });
    } catch (e) {
      console.log(`  ⚠ ${c.eid} p${pages} batch failed (${e.message.slice(0,80)}) — falling back to single-page`);
      for (const b of batch) {
        // Reflect the fallback in the focal frame
        const fbb64 = Buffer.from(b.png, "utf8").toString("base64url");
        reportProgress({
          now: {
            eid: c.eid, page: b.p,
            docMeta: c.doc.title,
            phase: "BATCH FELL BACK · single page",
            metaLine: `FALLBACK after fetch retry · PAGE ${b.p} · SLICE ${pagesOK}/${total}`,
            previewUrl: `/preview/${fbb64}`,
          },
        });
        try {
          const [out] = await callDaemon([b.png]);
          await writeFile(b.txt, (out.text || "").trim(), "utf8");
          await writeFile(b.jsn, JSON.stringify(out.visuals), "utf8");
          pagesOK++;
          recordCompletion(b.p, "fallback", "single after fetch retry");
        } catch (e2) {
          pagesErr++;
          await writeFile(b.txt, "", "utf8");
          await writeFile(b.jsn, "[]", "utf8");
          console.log(`  ✗ ${c.eid} p${b.p}  ${e2.message.slice(0,120)}`);
          recordCompletion(b.p, "err", e2.message.slice(0, 50));
        }
        reportProgress({
          slice: { done: pagesOK, total },
          session: { pagesOk: pagesOK, pagesErr },
          recent: sessionRecent.slice(),
        });
      }
    }
  }
  await doc.cleanup(); await doc.destroy();
}

// Final: mark daemon as idle so the dashboard's status dot calms down
await reportProgress({
  now: null,
  idle: true,
  slice: { done: pagesOK, total },
  session: { pagesOk: pagesOK, pagesErr },
  recent: sessionRecent.slice(),
});

assetServer.close();
const elapsed = ((Date.now() - tAll) / 60_000).toFixed(1);
console.log(`\n[volunteer] done. ok=${pagesOK} err=${pagesErr}  [${elapsed} min]`);
console.log(`[volunteer] files at: ${CONTRIB_ROOT}`);

if (pagesOK === 0) { console.log("[volunteer] nothing to commit, exiting."); process.exit(2); }

if (NO_PR) {
  console.log("[volunteer] --no-pr set, leaving the rest to you (git add + commit + gh pr create)");
  process.exit(0);
}

// ----- step 5: open PR -----
console.log("[volunteer] preparing PR via gh CLI…");
const branch = `contrib-${HANDLE}-${Date.now().toString(36)}`;
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
    c.on("error", reject);
    c.on("exit", code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}
try {
  await run("git", ["checkout", "-b", branch]);
  await run("git", ["add", `contributions/${HANDLE}`]);
  const docsTouched = [...new Set(claims.map(c => c.eid))].join(", ");
  await run("git", ["commit", "-m", `corpus: volunteer transcriptions for ${docsTouched}\n\nSubmitted by @${HANDLE} via scripts/volunteer.mjs (${pagesOK} pages).`]);
  await run("git", ["push", "-u", "origin", branch]);
  const body = `## Volunteer contribution\n\n` +
    `Submitted ${pagesOK} vision-OCR'd pages across ${claims.length} document(s):\n\n` +
    claims.map(c => `- \`${c.eid}\` pages ${c.pages.join(", ")}`).join("\n") +
    `\n\nGenerated via [pursue-vision-mcp](../tree/main/pursue-vision-mcp) by @${HANDLE}.\n\n` +
    `CI will validate against [JUDGE-STANDARD.md](../blob/main/JUDGE-STANDARD.md). ` +
    `Pages in the \`?-review\` quality band will be checked manually.`;
  await run("gh", ["pr", "create", "--title", `Volunteer corpus contribution from @${HANDLE}`, "--body", body]);
  console.log("[volunteer] PR opened. Thank you!");
} catch (e) {
  console.error("[volunteer] PR step failed:", e.message);
  console.error("[volunteer] your files are still on disk — finish by hand: git add contributions/" + HANDLE + " && gh pr create");
  process.exit(2);
}
