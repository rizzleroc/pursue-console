// sync-war-gov.mjs — pull a war.gov release directly via the MCP daemon.
//
// @unverified — never run against live www.war.gov. The maintainer's
// real Chrome (with a logged-in war.gov tab that has cleared any one-time
// Akamai challenge) is the first live test. Until that happens, this
// script is scaffold-only.
//
// What it does:
//   1. Asks the daemon for the release-N file index (the daemon does
//      the in-page TLS-bypass fetch through Chrome).
//   2. Filters by file type (pdf / audio / video / other).
//   3. Asks the daemon to download every URL into
//      data-raw/war-gov/release_<n>/ (jail-checked daemon-side).
//   4. Reports per-file ok/error and prints a follow-up command for
//      whisper transcription of audio/video.
//
// Usage:
//   node scripts/sync-war-gov.mjs                                  # release 2, all types
//   node scripts/sync-war-gov.mjs --release=02 --types=pdf         # PDFs only
//   node scripts/sync-war-gov.mjs --dry-run                        # plan only, no download
//
// Options:
//   --release=02                Release number (default 02)
//   --types=pdf,audio,video     Comma-separated type filter (default all)
//   --daemon=http://127.0.0.1:9223
//   --dry-run                   Fetch index, print plan, don't download
//   --token-file=~/.pursue-vision-token
//
// Exit codes:
//   0  every file succeeded
//   1  setup error (no daemon, bad args, etc.)
//   2  partial completion (some files succeeded, some failed)

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.on("unhandledRejection", e => console.error("  ! unhandled:", e?.message || e));

// ----- args -----
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

const RELEASE = String(args.release || "02").replace(/^release[_-]?/i, "").padStart(2, "0");
const RELEASE_N = Number(RELEASE);
if (!Number.isInteger(RELEASE_N) || RELEASE_N < 1) {
  console.error(`error: --release='${args.release}' is not a valid release number`);
  process.exit(1);
}
const DAEMON = (args.daemon || "http://127.0.0.1:9223").replace(/\/+$/, "");
const DRY = !!args["dry-run"];
const TYPES_ARG = String(args.types || "pdf,audio,video,other").toLowerCase();
const TYPE_FILTER = new Set(TYPES_ARG.split(",").map(s => s.trim()).filter(Boolean));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEST_DIR = path.join(ROOT, "data-raw", "war-gov", `release_${RELEASE_N}`);
const TOKEN_FILE = (args["token-file"] || "~/.pursue-vision-token").replace(/^~/, os.homedir());

// Reuse the same token-discovery shape volunteer.mjs uses so a
// maintainer with the primary MCP already running (~/.whipgen-token)
// doesn't have to set anything.
async function loadToken() {
  if (process.env.PURSUE_VISION_TOKEN) return process.env.PURSUE_VISION_TOKEN;
  if (process.env.WHIPGEN_TOKEN) return process.env.WHIPGEN_TOKEN;
  for (const p of [path.join(os.homedir(), ".whipgen-token"), TOKEN_FILE]) {
    try { return (await readFile(p, "utf8")).trim(); } catch {}
  }
  console.error(`error: no token. Start the daemon first (it writes ${TOKEN_FILE}), or set PURSUE_VISION_TOKEN.`);
  process.exit(1);
}
const TOKEN = await loadToken();

async function jsonFetch(method, urlPath, body) {
  const url = `${DAEMON}${urlPath}`;
  const init = {
    method,
    headers: { Authorization: `Bearer ${TOKEN}` },
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  // No client-side timeout: /war-gov/download is long-running by design.
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`daemon ${method} ${urlPath} returned non-JSON (${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) {
    throw new Error(`daemon ${method} ${urlPath} → ${res.status} ${parsed?.error || ""}`);
  }
  return parsed;
}

// 1. Pull the release index. The daemon's /war-gov/index does the
//    Akamai-bypass dance through Chrome.
console.log(`[sync-war-gov] release ${RELEASE_N} · types [${[...TYPE_FILTER].join(",")}] · daemon ${DAEMON}`);
let indexRes;
try {
  indexRes = await jsonFetch("GET", `/war-gov/index?release=${RELEASE_N}`);
} catch (e) {
  console.error(`error: ${e.message}`);
  console.error("       (is the daemon up?  npm start --prefix pursue-vision-mcp)");
  process.exit(1);
}
const records = Array.isArray(indexRes.records) ? indexRes.records : [];
console.log(`[sync-war-gov] index returned ${records.length} record(s) for release ${RELEASE_N}`);

// 2. Filter by type.
const wanted = records.filter(r => TYPE_FILTER.has((r.type || "other").toLowerCase()));
const skipped = records.length - wanted.length;
if (skipped) console.log(`[sync-war-gov]   skipped ${skipped} by --types filter`);

// Group + show plan.
const byType = wanted.reduce((acc, r) => {
  const t = (r.type || "other").toLowerCase();
  (acc[t] ||= []).push(r);
  return acc;
}, {});
for (const [t, list] of Object.entries(byType)) {
  console.log(`[sync-war-gov]   ${t.padEnd(6)} ${String(list.length).padStart(3)} file(s)`);
}

if (!wanted.length) {
  console.log("[sync-war-gov] nothing to download.");
  process.exit(0);
}

if (DRY) {
  console.log(`\n[sync-war-gov] --dry-run: would download into ${DEST_DIR}`);
  for (const r of wanted) console.log(`  ${r.type.padEnd(6)} ${r.filename}  ${r.url}`);
  process.exit(0);
}

// 3. Hand off to the daemon. The daemon writes into DEST_DIR (jail
//    is enforced daemon-side, so home + cwd are the allowed roots).
console.log(`\n[sync-war-gov] downloading ${wanted.length} file(s) → ${DEST_DIR}`);
console.log("[sync-war-gov] (long-running; the daemon streams big files in 8 MB ranges)");

const t0 = Date.now();
let download;
try {
  download = await jsonFetch("POST", "/war-gov/download", {
    urls: wanted.map(r => r.url),
    destDir: DEST_DIR,
  });
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}

// 4. Per-file results.
const results = Array.isArray(download.results) ? download.results : [];
let okCount = 0, failCount = 0, byteCount = 0;
for (const r of results) {
  if (r.url === "__abort__") {
    console.log(`  ! ${r.error}`);
    continue;
  }
  if (r.ok) {
    okCount++;
    byteCount += r.bytes || 0;
    console.log(`  ok  ${(r.bytes / 1024 / 1024).toFixed(1).padStart(7)} MB  ${path.basename(new URL(r.url).pathname)}`);
  } else {
    failCount++;
    console.log(`  ERR ${path.basename(new URL(r.url).pathname)}  — ${r.error}`);
  }
}
const tookS = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n[sync-war-gov] ${okCount} ok · ${failCount} fail · ${(byteCount / 1024 / 1024).toFixed(1)} MB total · ${tookS}s`);

// 5. Follow-up suggestion: audio/video need Whisper.
const haveAudioVideo = wanted.some(r => r.type === "audio" || r.type === "video");
if (okCount && haveAudioVideo) {
  console.log("");
  console.log("Next step — transcribe audio + video:");
  console.log("  npm run corpus:transcribe-videos");
  console.log(`  (transcripts will land in public/text/, video files in data-raw/war-gov/release_${RELEASE_N}/)`);
}

if (failCount === 0) process.exit(0);
if (okCount === 0)  process.exit(1);
process.exit(2);
