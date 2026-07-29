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
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getPdfjsAssetUrls } from "./lib/pdfjs-assets.mjs";
// pdfjs's nested canvas (0.1.x), not the top-level 1.0.x — keeps the
// renderer compatible with pages that have complex vector content.
// See backfill-media-renders.mjs for the failure mode.
import { createCanvas, Path2D, DOMMatrix } from "pdfjs-dist/node_modules/@napi-rs/canvas/index.js";

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
// Review mode uses the standardized transcription prompt (no batch protocol),
// so force one page per call. Explicit --batch-pages still wins for OCR mode.
const BATCH_PAGES = Number(args["batch-pages"] || (args.review ? 1 : 4));
const DAEMON = args.daemon || "http://127.0.0.1:9223";
const QUEUE_URL = args["queue-url"] || "https://rizzleroc.github.io/pursue-console/work-available.json";
const DRY = !!args["dry-run"];
const NO_PR = !!args["no-pr"];
// R10 — --review mode: re-run disputed pages (from public/review-queue.json)
// through the standardized prompt. Output lands at
// contributions/<handle>/<source>-review/<eid>/p<NNN>.txt and is consumed by
// import-contributions.mjs as p<NNN>.<base>.v2.txt for compare-sources to
// re-score the dispute. The default --my-handle invocation behaves exactly
// as before; --review only changes the picking + prompt + output path.
const REVIEW_MODE = !!args.review;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PDF_ROOT = path.resolve(args["pdf-root"] || path.join(ROOT, "data-raw/volunteer"));
// Provider (--provider=chatgpt|gemini, default chatgpt). The MCP daemon
// routes the request to the matching driver. The `<source>` segment of
// the contribution path is the same string the corpus uses (gpt-vision
// for chatgpt, gemini for gemini), so a re-run on the other provider
// adds a second source to the same page rather than overwriting it.
const PROVIDER = (args.provider || "chatgpt").toLowerCase();
const PROVIDER_TO_SOURCE = { chatgpt: "gpt-vision", gemini: "gemini", claude: "claude" };
// Review mode targets the review source so it doesn't overwrite the original
// OCR — the judge sees both sources and resolves the dispute.
const CONTRIB_SOURCE = REVIEW ? "gpt-vision-review" : PROVIDER_TO_SOURCE[PROVIDER];
if (!CONTRIB_SOURCE) {
  console.error(`error: --provider must be 'chatgpt', 'gemini', or 'claude' (got '${PROVIDER}')`);
  process.exit(1);
}
// In --review mode the contribution lands under <source>-review/ so the
// importer treats it as the v2 re-OCR of a disputed page, not a fresh source.
const CONTRIB_SLOT = REVIEW_MODE ? `${CONTRIB_SOURCE}-review` : CONTRIB_SOURCE;
const CONTRIB_ROOT = path.join(ROOT, "contributions", HANDLE, CONTRIB_SLOT);
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

// Pre-check gh CLI auth so we don't OCR pages for 30 minutes only to
// fail at the PR step. Skipped under --no-pr (volunteer wants to PR
// by hand) and under --dry-run.
async function checkGhAuth() {
  if (NO_PR || DRY) return;
  const { spawn } = await import("node:child_process");
  await new Promise(resolve => {
    const p = spawn("gh", ["auth", "status"], { stdio: "ignore" });
    p.on("close", code => {
      if (code !== 0) {
        console.error("error: GitHub CLI is not authenticated. Run `gh auth login` (or pass --no-pr to skip the PR step).");
        process.exit(1);
      }
      resolve();
    });
    p.on("error", () => {
      console.error("error: `gh` not found in PATH. Install GitHub CLI from https://cli.github.com (or pass --no-pr).");
      process.exit(1);
    });
  });
}
await checkGhAuth();

// ----- R7 Phase 1: static claims ledger -----
// A claim is just a JSON file at public/claims/<eid>/p<NNNN>.json with
// { handle, claimed_at, lease_secs, phase }. Other volunteers skip pages with
// an unexpired claim by a different handle. Best-effort throughout — parse
// errors → "no claim"; write errors → log + continue (the claim is advisory).
// See design/VOLUNTEER-LEASING.md.
const CLAIMS_DIR = path.join(ROOT, "public", "claims");
function claimPath(eid, pageNum) {
  return path.join(CLAIMS_DIR, eid, `p${String(pageNum).padStart(4, "0")}.json`);
}
async function readClaim(eid, pageNum) {
  try {
    const txt = await readFile(claimPath(eid, pageNum), "utf8");
    return JSON.parse(txt);
  } catch { return null; }
}
function claimIsActive(claim) {
  if (!claim?.claimed_at || !claim?.lease_secs) return false;
  const ageSecs = (Date.now() - new Date(claim.claimed_at).getTime()) / 1000;
  return Number.isFinite(ageSecs) && ageSecs < Number(claim.lease_secs);
}
async function writeClaim(eid, pageNum, handle, leaseSecs, phase) {
  try {
    await mkdir(path.join(CLAIMS_DIR, eid), { recursive: true });
    await writeFile(claimPath(eid, pageNum), JSON.stringify({
      handle, claimed_at: new Date().toISOString(), lease_secs: leaseSecs, phase,
    }) + "\n", "utf8");
  } catch (e) {
    console.log(`    ! claim write failed for ${eid} p${pageNum}: ${e.message.slice(0, 80)}`);
  }
}

// ----- step 1: fetch the work queue -----
// In --review mode the picking strategy switches to public/review-queue.json
// (sibling of work-available.json on the same Pages base). The OCR-queue
// fetch still happens — we read its `leasing` field for the lease windows.
console.log(`[volunteer] fetching ${QUEUE_URL}`);
let queue;
if (QUEUE_URL.startsWith("http://") || QUEUE_URL.startsWith("https://")) {
  const queueRes = await fetch(QUEUE_URL);
  if (!queueRes.ok) { console.error(`error: queue fetch HTTP ${queueRes.status}`); process.exit(1); }
  queue = await queueRes.json();
} else {
  queue = JSON.parse(await readFile(QUEUE_URL, "utf8"));
}
const _qSources = [await _loadQueue(QUEUE_URL)];
if (QUEUE_URL !== REMOTE_QUEUE) _qSources.push(await _loadQueue(REMOTE_QUEUE));
const _qLoaded = _qSources.filter(Boolean).sort((a, b) => b.ts - a.ts);
if (!_qLoaded.length) { console.error("error: could not load any work queue"); process.exit(1); }
const queue = _qLoaded[0].q;
console.log(`[volunteer] using ${_qLoaded[0].kind} queue (gen ${queue.generatedAt})`);
const _qLabel = REVIEW
  ? `${queue.totalPagesNeedingReview || 0} pages need review`
  : `${queue.totalDocsRemaining || 0} docs · ${queue.totalPagesNeeded || 0} pages need vision OCR`;
console.log(`[volunteer] ${_qLabel}`);

// Lease windows come from leasing.json (passed through work-available.json's
// `leasing` field). OCR phase default: 3600s. Review phase default: 1800s.
const LEASING = queue.leasing || {};
const PHASE = REVIEW_MODE ? "review" : "ocr";
const PHASE_DEFAULTS = { ocr: 3600, media: 86400, review: 1800 };
const LEASE_SECS = Number(LEASING.phases?.[PHASE] ?? LEASING.default_lease_secs ?? PHASE_DEFAULTS[PHASE]);

// Fetch the review queue in --review mode. Derived from QUEUE_URL by swapping
// the trailing filename so a custom --queue-url (e.g. local file) still works.
let reviewQueue = null;
if (REVIEW_MODE) {
  const reviewUrl = QUEUE_URL.replace(/work-available\.json([^/]*)$/i, "review-queue.json$1");
  console.log(`[volunteer] --review · fetching ${reviewUrl}`);
  try {
    if (reviewUrl.startsWith("http://") || reviewUrl.startsWith("https://")) {
      const r = await fetch(reviewUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      reviewQueue = await r.json();
    } else {
      reviewQueue = JSON.parse(await readFile(reviewUrl, "utf8"));
    }
  } catch (e) {
    console.error(`error: could not fetch review queue (${e.message})`);
    process.exit(1);
  }
  if (!reviewQueue?.total) {
    console.log("[volunteer] nothing in REVIEW queue — try the OCR flow with `volunteer.mjs --my-handle=" + HANDLE + "` instead.");
    process.exit(0);
  }
  console.log(`[volunteer] review queue gen ${reviewQueue.generatedAt} · ${reviewQueue.total} disputed page(s)`);
}

// ----- step 2: pick a slice -----
// OCR mode: hash(handle) determines a stable starting event so two
// volunteers running concurrently don't both grab the same first doc.
// Within an event we just take the head of the queue.
// REVIEW mode: walk review-queue.json entries in order (already sorted
// worst-agreement-first), group by eid, honor --eid, apply R7 lease checks.
function hash(s) { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) | 0; return Math.abs(h); }

const claims = [];   // { eid, doc, pages: [pageNumbers] }

if (REVIEW_MODE) {
  // Group disputed pages by eid, preserving worst-first order; pull doc
  // metadata (pdfUrl, title, agency) from the OCR queue. A disputed page
  // can only be re-OCR'd if the underlying PDF is still discoverable.
  const byEid = new Map();
  for (const item of reviewQueue.queue) {
    if (ONLY_EID && item.eventId !== ONLY_EID) continue;
    if (!byEid.has(item.eventId)) byEid.set(item.eventId, []);
    byEid.get(item.eventId).push(item.page);
  }
  let remaining = SLICE;
  for (const [eid, pages] of byEid) {
    if (remaining <= 0) break;
    // doc may not be in work-available.json (event is fully OCR'd; only
    // disputed pages remain) — fall back to a synthesized record from the
    // review-queue entry. We still need pdfUrl to download.
    let doc = queue.byEvent[eid];
    if (!doc) {
      const sample = reviewQueue.queue.find(q => q.eventId === eid);
      // Without pdfUrl we can't render — pull it from events.js via the
      // OCR queue's notYetPulled bucket if present, else skip.
      const npull = (queue.notYetPulled || []).find(n => n.eid === eid);
      doc = {
        title: sample?.title || eid,
        agency: sample?.agency || null,
        pdfUrl: npull?.pdfUrl || null,
      };
    }
    if (!doc.pdfUrl) { console.log(`    ⊖ ${eid}: no pdfUrl, skipping`); continue; }
    const take = pages.slice(0, remaining);
    if (!take.length) continue;
    claims.push({ eid, doc, pages: take });
    remaining -= take.length;
  }
} else {
  let candidateEids = Object.keys(queue.byEvent);
  if (ONLY_EID) {
    if (!queue.byEvent[ONLY_EID]) { console.error(`error: --eid=${ONLY_EID} is not in the queue (already done?)`); process.exit(1); }
    candidateEids = [ONLY_EID];
  } else {
    // Stable rotation: start from hash(handle) % length, but always rotate
    // to favor pdfjs-render-friendly docs over the known-bad ones.
    // Removed in 2.1 — KNOWN_RENDER_HARD used to block fbi-62hq83894 and
    // skylab because of the Windows pdfjs file-URL bug. That was fixed
    // weeks ago by the pathToFileURL refactor; the block was stale code
    // keeping those 185 + 11 pages out of the volunteer rotation.
    const start = hash(HANDLE) % Math.max(1, candidateEids.length);
    candidateEids = candidateEids.slice(start).concat(candidateEids.slice(0, start));
  }

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
}

// R7 Phase 1 — drop pages held by another volunteer's unexpired claim, then
// write our own claim for the survivors. Self-owned claims are honored (we
// resume our own slice). Best-effort: a parse error on read = treat as unclaimed.
let skippedClaimed = 0;
for (const c of claims) {
  const kept = [];
  for (const p of c.pages) {
    const existing = await readClaim(c.eid, p);
    if (existing && claimIsActive(existing) && existing.handle !== HANDLE) {
      skippedClaimed++;
      continue;
    }
    kept.push(p);
    await writeClaim(c.eid, p, HANDLE, LEASE_SECS, PHASE);
  }
  c.pages = kept;
}
// Drop docs whose pages all got claimed away.
for (let i = claims.length - 1; i >= 0; i--) if (!claims[i].pages.length) claims.splice(i, 1);
if (skippedClaimed) console.log(`[volunteer] skipped ${skippedClaimed} page(s) under active claim by another handle`);

const total = claims.reduce((s, c) => s + c.pages.length, 0);
console.log(`[volunteer] claiming ${total} page(s) across ${claims.length} doc(s) · phase=${PHASE} · lease=${LEASE_SECS}s:`);
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
  // Whole-corpus page progress from work-available.json. Older builds mashed
  // records (inventoryTotal) against pages (totalPagesNeeded) with a stale 162
  // fallback; the CORPUS gauge is pages-search-ready / total-corpus-pages.
  corpus: { done: queue.corpusPagesCompleted ?? 0, target: queue.corpusPagesTotal ?? 0 },
  recent: [],
  session: { pagesOk: 0, pagesErr: 0 },
});

if (DRY) { console.log("[volunteer] --dry-run set, exiting before any work."); process.exit(0); }

// ----- step 3: download PDFs -----
await mkdir(PDF_ROOT, { recursive: true });
for (const c of claims) {
  const dest = path.join(PDF_ROOT, `${c.eid}.pdf`);
  if (existsSync(dest)) { console.log(`  ⊖ ${c.eid}.pdf already present`); continue; }
  // Release-02 PDFs ship as site-relative paths (e.g. "release_2/X.pdf")
  // because they're mirrored under public/release_2/ — resolve against the
  // deployed site so Node's fetch() (which rejects relative URLs) works.
  const absUrl = /^https?:\/\//i.test(c.doc.pdfUrl) ? c.doc.pdfUrl : new URL(c.doc.pdfUrl, "https://rizzleroc.github.io/pursue-console/").href;
  console.log(`  ↓ ${c.eid}.pdf  ${absUrl}`);
  const r = await fetch(absUrl);
  if (!r.ok) { console.error(`    HTTP ${r.status} — skipping doc`); c.skip = true; continue; }
  await writeFile(dest, Buffer.from(await r.arrayBuffer()));
}
const live = claims.filter(c => !c.skip);

// ----- step 4: render + OCR via daemon -----
// pdfjs creates `new Path2D()` from whatever is in scope; @napi-rs/canvas's
// clip/fill only accept their own Path2D class. Wire it up before import.
globalThis.Path2D = Path2D;
globalThis.DOMMatrix = DOMMatrix;
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { wasmUrl: PDFJS_WASM_URL, standardFontDataUrl: PDFJS_FONTS_URL, server: PDFJS_SERVER } = await getPdfjsAssetUrls();
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
const PROMPT_OCR_SINGLE =
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

// R10 — in --review mode use the standardized prompt (same as
// reevaluate-disputed.mjs) so the v2 transcript is directly comparable to
// the maintainer-driven reeval pipeline. Loaded once at startup.
const STANDARD_PROMPT_PATH = path.join(__dirname, "prompts", "standard-transcription.txt");
const PROMPT_STANDARD = REVIEW_MODE
  ? await readFile(STANDARD_PROMPT_PATH, "utf8")
  : null;
const PROMPT_SINGLE = REVIEW_MODE ? PROMPT_STANDARD : PROMPT_OCR_SINGLE;

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
  const body = JSON.stringify({ provider: PROVIDER, filePaths, prompt, freshChat: true, timeoutMs: 600_000 });
  // Image upload to the browser LLM is occasionally flaky (HTTP 500 "upload
  // didn't acknowledge", reply timeout, transient network drop). Retry transient
  // failures with backoff; freshChat:true re-uploads into a clean chat each time.
  // A batch section-count mismatch is NOT transient — it's thrown below and
  // propagates so the caller falls back to single-page calls.
  let raw;
  for (let n = 1; ; n++) {
    try {
      const r = await fetch(`${DAEMON}/chat-with-files`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body,
      });
      if (!r.ok) throw new Error(`daemon HTTP ${r.status}: ${(await r.text()).slice(0,200)}`);
      const j = await r.json();
      raw = j.text ?? j.result?.text ?? j.output ?? "";
      break;
    } catch (e) {
      // If the daemon itself has gone away (process died, Chrome crashed,
      // network drop), retrying is pointless — the same fetch will fail
      // identically. Probe /health once; on the first confirmed-dead probe
      // bail with a non-retriable error so the volunteer surfaces it instead
      // of grinding through retries + single-page fallback per page.
      if (/fetch failed|ECONNREFUSED|ECONNRESET|UND_ERR/i.test(e.message) && !(await daemonAlive(1500))) {
        const dead = new Error(`OCR daemon at ${DAEMON} stopped responding mid-run — restart it (cd pursue-vision-mcp && npm start)`);
        dead.daemonDown = true;
        throw dead;
      }
      if (n >= 3) throw e;
      console.log(`    ↻ upload retry ${n}/2 — ${e.message.slice(0, 70)}`);
      await new Promise(res => setTimeout(res, 2000 * n));
    }
  }
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

// Pages already MERGED to origin/main by ANY handle — so we never re-OCR work
// that's already done (by us or another volunteer). Graceful: empty set on
// offline/no-git falls back to the local existsSync(txt) check below.
// In review mode the slot is `<source>-review/`, so the same dedup applies but
// against the per-base v2 contributions.
async function publishedOcrSet() {
  const cap = (argv) => new Promise((res) => {
    const p = spawn("git", argv, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"], timeout: 8000 });
    let out = ""; p.stdout.on("data", c => out += c);
    p.on("exit", code => res(code === 0 ? out : "")); p.on("error", () => res(""));
  });
  const set = new Set();
  try {
    await cap(["fetch", "origin", "main", "--quiet"]);
    const out = await cap(["ls-tree", "-r", "origin/main", "--name-only", "--", "contributions"]);
    const re = new RegExp(`^contributions/[^/]+/${CONTRIB_SLOT}/(.+)/p0*(\\d+)\\.txt$`, "i");
    for (const line of out.split(/\r?\n/)) { const m = line.match(re); if (m) set.add(`${m[1]}|${Number(m[2])}`); }
  } catch {}
  return set;
}
const publishedDone = await publishedOcrSet();
if (publishedDone.size) console.log(`[volunteer] ${publishedDone.size} ${CONTRIB_SLOT} page(s) already on main — won't re-OCR those`);

let pagesOK = 0, pagesErr = 0;
const tAll = Date.now();
for (const c of live) {
  const pdfBuf = await readFile(path.join(PDF_ROOT, `${c.eid}.pdf`));
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuf),
    useSystemFonts: false, disableFontFace: true,
    useWorkerFetch: false,
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
    // Review mode also skips when the per-source v2 transcript already exists
    // in the local vision cache — that page's dispute has been re-OCR'd here
    // already (by us or a prior reeval pass) and committing again is churn.
    const v2Local = REVIEW_MODE
      ? path.join(ROOT, "data-raw", ".vision-cache", c.eid, `p${String(p).padStart(4,"0")}.${CONTRIB_SOURCE}.v2.txt`)
      : null;
    if (existsSync(txt) || publishedDone.has(`${c.eid}|${Number(p)}`) || (v2Local && existsSync(v2Local))) { console.log(`  ⊖ ${c.eid} p${p} already done (local or merged to main)`); continue; }
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

const elapsed = ((Date.now() - tAll) / 60_000).toFixed(1);
console.log(`\n[volunteer] done. ok=${pagesOK} err=${pagesErr}  [${elapsed} min]`);
console.log(`[volunteer] files at: ${CONTRIB_ROOT}`);

// Drain the pdfjs assets server before exit — on Windows, calling process.exit()
// while a TCP listener is still in the event loop can trip a libuv assertion
// (UV_HANDLE_CLOSING in src\win\async.c) and the process dies with exit code
// 3221226505 instead of the intended 0/2. The monitor then misclassifies the
// clean "no new work" result as a crash and re-loops.
await new Promise(r => PDFJS_SERVER.close(() => r()));

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
  const commitTitle = REVIEW_MODE
    ? `corpus: review re-OCR for ${docsTouched}`
    : `corpus: volunteer transcriptions for ${docsTouched}`;
  await run("git", ["commit", "-m", `${commitTitle}\n\nSubmitted by @${HANDLE} via scripts/volunteer.mjs${REVIEW_MODE ? " --review" : ""} (${pagesOK} pages).`]);
  await run("git", ["push", "-u", "origin", branch]);
  const body = REVIEW_MODE
    ? `## Volunteer REVIEW re-transcription\n\n` +
      `Re-OCR'd ${pagesOK} disputed page(s) across ${claims.length} document(s) using the standardized prompt ` +
      `(\`scripts/prompts/standard-transcription.txt\`). Output lands under \`${CONTRIB_SLOT}/\` and the importer ` +
      `writes it as \`p<NNN>.${CONTRIB_SOURCE}.v2.txt\` so \`compare-sources.mjs\` re-scores each dispute:\n\n` +
      claims.map(c => `- \`${c.eid}\` pages ${c.pages.join(", ")}`).join("\n") +
      `\n\nGenerated via [pursue-vision-mcp](../tree/main/pursue-vision-mcp) by @${HANDLE}.`
    : `## Volunteer contribution\n\n` +
      `Submitted ${pagesOK} vision-OCR'd pages across ${claims.length} document(s):\n\n` +
      claims.map(c => `- \`${c.eid}\` pages ${c.pages.join(", ")}`).join("\n") +
      `\n\nGenerated via [pursue-vision-mcp](../tree/main/pursue-vision-mcp) by @${HANDLE}.\n\n` +
      `CI will validate against [JUDGE-STANDARD.md](../blob/main/JUDGE-STANDARD.md). ` +
      `Pages in the \`?-review\` quality band will be checked manually.`;
  const prTitle = REVIEW_MODE
    ? `Review re-OCR contribution from @${HANDLE}`
    : `Volunteer corpus contribution from @${HANDLE}`;
  await run("gh", ["pr", "create", "--title", prTitle, "--body", body]);
  console.log("[volunteer] PR opened. Thank you!");
} catch (e) {
  console.error("[volunteer] PR step failed:", e.message);
  console.error("[volunteer] your files are still on disk — finish by hand: git add contributions/" + HANDLE + " && gh pr create");
  process.exit(2);
}
