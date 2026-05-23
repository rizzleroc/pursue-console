// sync-war-gov.mjs — pull a war.gov release. Prefers the MCP daemon on
// :9223 (Chrome / in-page fetch, Akamai-bypass) when it's running; falls
// back to a direct Node-side fetch otherwise. The fallback uses
// scripts/lib/war-gov-direct.mjs and will fail loudly with a clear
// "Akamai block" message when run against live war.gov from an
// IP/TLS-fingerprint the WAF rejects.
//
// @unverified — the live-test gate still applies. Neither path has been
// run end-to-end against a real release. The MCP path needs the
// maintainer's logged-in Chrome with a cleared Akamai challenge; the
// direct path needs an egress that war.gov's WAF doesn't reject.
//
// Usage:
//   node scripts/sync-war-gov.mjs                                  # release 2, all types, auto-pick path
//   node scripts/sync-war-gov.mjs --release=02 --types=pdf         # PDFs only
//   node scripts/sync-war-gov.mjs --dry-run                        # plan only, no download
//   node scripts/sync-war-gov.mjs --prefer-direct                  # skip daemon probe, use Node fetch
//   node scripts/sync-war-gov.mjs --prefer-mcp                     # require the daemon (error if missing)
//   node scripts/sync-war-gov.mjs --base-url=https://example.com/  # point the direct path at a mirror
//
// Options:
//   --release=02                Release number (default 02)
//   --types=pdf,audio,video     Comma-separated type filter (default all)
//   --daemon=http://127.0.0.1:9223
//   --dry-run                   Fetch index, print plan, don't download
//   --token-file=~/.pursue-vision-token
//   --prefer-direct             Skip the daemon and go straight to Node fetch
//   --prefer-mcp                Require the daemon; exit 1 if it isn't healthy
//   --base-url=<url>            Override war.gov base for the direct path (e.g. a mirror)
//
// Exit codes:
//   0  every file succeeded
//   1  setup error (no daemon AND prefer-mcp, bad args, etc.)
//   2  partial completion (some files succeeded, some failed)

import { readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchIndexDirect, downloadFileDirect } from "./lib/war-gov-direct.mjs";

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
const PREFER_DIRECT = !!args["prefer-direct"];
const PREFER_MCP = !!args["prefer-mcp"];
const BASE_URL = args["base-url"] || "https://www.war.gov";

if (PREFER_DIRECT && PREFER_MCP) {
  console.error("error: --prefer-direct and --prefer-mcp are mutually exclusive");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEST_DIR = path.join(ROOT, "data-raw", "war-gov", `release_${RELEASE_N}`);
const TOKEN_FILE = (args["token-file"] || "~/.pursue-vision-token").replace(/^~/, os.homedir());

// ----- daemon probe -----
async function isDaemonHealthy() {
  try {
    const r = await fetch(`${DAEMON}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

// Token discovery — same shape volunteer.mjs uses so a maintainer with
// the primary MCP already running (~/.whipgen-token) doesn't have to set
// anything. Only required when we actually go through the daemon.
async function loadToken() {
  if (process.env.PURSUE_VISION_TOKEN) return process.env.PURSUE_VISION_TOKEN;
  if (process.env.WHIPGEN_TOKEN) return process.env.WHIPGEN_TOKEN;
  for (const p of [path.join(os.homedir(), ".whipgen-token"), TOKEN_FILE]) {
    try { return (await readFile(p, "utf8")).trim(); } catch {}
  }
  return null;
}

// ----- pick a path -----
const daemonUp = !PREFER_DIRECT && await isDaemonHealthy();
const usingMcp = daemonUp && !PREFER_DIRECT;

if (PREFER_MCP && !daemonUp) {
  console.error(`error: --prefer-mcp set but daemon at ${DAEMON} is not healthy.`);
  console.error("       start it with:  npm start --prefix pursue-vision-mcp");
  process.exit(1);
}

console.log(
  `[sync-war-gov] release ${RELEASE_N} · types [${[...TYPE_FILTER].join(",")}] · ` +
  `via ${usingMcp ? `MCP daemon ${DAEMON}` : `direct fetch (${BASE_URL})`}`
);
if (!usingMcp && !PREFER_DIRECT) {
  console.log(
    "[sync-war-gov] note: MCP daemon not reachable on " + DAEMON + " — falling back to direct fetch.\n" +
    "               Direct fetch usually trips Akamai on live war.gov; if that happens, start the daemon."
  );
}

// ----- MCP path: HTTP calls into the daemon -----
let TOKEN = null;
async function jsonFetchDaemon(method, urlPath, body) {
  const url = `${DAEMON}${urlPath}`;
  const init = {
    method,
    headers: { Authorization: `Bearer ${TOKEN}` },
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
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

async function fetchIndexViaMcp() {
  const indexRes = await jsonFetchDaemon("GET", `/war-gov/index?release=${RELEASE_N}`);
  return Array.isArray(indexRes.records) ? indexRes.records : [];
}

async function downloadViaMcp(urls) {
  const download = await jsonFetchDaemon("POST", "/war-gov/download", {
    urls, destDir: DEST_DIR,
  });
  return Array.isArray(download.results) ? download.results : [];
}

// ----- Direct path: Node fetch via scripts/lib/war-gov-direct.mjs -----
async function fetchIndexViaDirect() {
  return await fetchIndexDirect({ release: RELEASE_N, baseUrl: BASE_URL });
}

async function downloadViaDirect(records) {
  await mkdir(DEST_DIR, { recursive: true });
  const results = [];
  for (const rec of records) {
    const destPath = path.join(DEST_DIR, rec.filename);
    try {
      const { bytes, durationMs } = await downloadFileDirect({
        url: rec.url, destPath,
      });
      results.push({ url: rec.url, ok: true, bytes, destPath, durationMs });
    } catch (e) {
      results.push({ url: rec.url, ok: false, error: e.message || String(e) });
    }
  }
  return results;
}

// ----- run -----
if (usingMcp) {
  TOKEN = await loadToken();
  if (!TOKEN) {
    console.error(
      `error: daemon is up but no token found.\n` +
      `       Restart the daemon to regenerate ${TOKEN_FILE}, or set PURSUE_VISION_TOKEN.`
    );
    process.exit(1);
  }
}

let records;
try {
  records = usingMcp ? await fetchIndexViaMcp() : await fetchIndexViaDirect();
} catch (e) {
  console.error(`error: ${e.message}`);
  if (usingMcp) {
    console.error("       (is the daemon up?  npm start --prefix pursue-vision-mcp)");
  } else {
    console.error("       (direct fetch likely hit Akamai; try the daemon path instead)");
  }
  process.exit(1);
}
console.log(`[sync-war-gov] index returned ${records.length} record(s) for release ${RELEASE_N}`);

// Filter by type.
const wanted = records.filter(r => TYPE_FILTER.has((r.type || "other").toLowerCase()));
const skipped = records.length - wanted.length;
if (skipped) console.log(`[sync-war-gov]   skipped ${skipped} by --types filter`);

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
  for (const r of wanted) console.log(`  ${(r.type || "other").padEnd(6)} ${r.filename}  ${r.url}`);
  process.exit(0);
}

console.log(`\n[sync-war-gov] downloading ${wanted.length} file(s) → ${DEST_DIR}`);
if (usingMcp) {
  console.log("[sync-war-gov] (long-running; the daemon streams big files in 8 MB ranges)");
} else {
  console.log("[sync-war-gov] (direct fetch; big files stream via Range chunks)");
}

const t0 = Date.now();
let results;
try {
  if (usingMcp) {
    results = await downloadViaMcp(wanted.map(r => r.url));
  } else {
    results = await downloadViaDirect(wanted);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}

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
