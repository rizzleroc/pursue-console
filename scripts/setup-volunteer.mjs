// First-time volunteer setup smoke test. Run before your first
// real contribution to catch every common setup failure in 30s
// instead of 30 minutes:
//
//   npm run corpus:setup
//
// Checks:
//   - node version >= 20
//   - daemon at :9223 is up + healthy
//   - daemon /status reports per-provider connection state
//   - token file present
//   - `gh` CLI is installed AND authenticated
//   - work-available.json is reachable from live deploy
//   - --my-handle is a valid GitHub handle (if provided)
//
// Exit code 0 only if everything passes.

import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const HANDLE = args["my-handle"] ? String(args["my-handle"]).replace(/^@/, "") : null;
const DAEMON = args.daemon || process.env.DAEMON || "http://127.0.0.1:9223";

function ok(msg)   { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); failures++; }
function info(msg) { console.log(`    ${msg}`); }
let failures = 0;

console.log("[setup] running volunteer pre-flight checks\n");

// Node version
console.log("[node]");
const nodeMajor = Number(process.version.slice(1).split(".")[0]);
if (nodeMajor >= 20) ok(`node ${process.version}`);
else fail(`node ${process.version} — need ≥ 20`);

// Token file
console.log("\n[token]");
const tokenPaths = [path.join(os.homedir(), ".pursue-vision-token"), path.join(os.homedir(), ".whipgen-token")];
const tokenPath = tokenPaths.find(existsSync);
let token = null;
if (tokenPath) {
  token = (await readFile(tokenPath, "utf8")).trim();
  if (token.length >= 16) ok(`found at ${tokenPath} (${token.length} chars)`);
  else fail(`token at ${tokenPath} looks empty/short`);
} else if (process.env.PURSUE_VISION_TOKEN || process.env.WHIPGEN_TOKEN) {
  token = process.env.PURSUE_VISION_TOKEN || process.env.WHIPGEN_TOKEN;
  ok(`found in env`);
} else {
  fail(`no token`);
  info(`fix: start the daemon at least once — it writes ~/.pursue-vision-token`);
  info(`     cd pursue-vision-mcp && npm start`);
}

// Daemon health
console.log("\n[daemon]");
try {
  const r = await fetch(`${DAEMON}/health`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  ok(`/health responds at ${DAEMON}`);
} catch (e) {
  fail(`/health unreachable at ${DAEMON}: ${e.message}`);
  info(`fix: start the daemon — cd pursue-vision-mcp && npm start`);
  info(`     or set DAEMON=<url> if you're running it elsewhere`);
}

// Provider status
if (token) {
  try {
    const r = await fetch(`${DAEMON}/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const j = await r.json();
      const providers = j.providers || (j.connected != null ? { chatgpt: { connected: j.connected } } : null);
      if (providers) {
        for (const [name, p] of Object.entries(providers)) {
          if (p.connected) ok(`${name} tab connected (${p.history || 0} prior calls)`);
          else { fail(`${name} tab NOT connected`); info(`fix: sign in at ${name === "gemini" ? "https://gemini.google.com/app" : "https://chatgpt.com"} in the CDP Chrome window`); }
        }
      } else {
        info(`unknown /status shape — daemon may be older than 0.2`);
      }
    } else {
      fail(`/status returned HTTP ${r.status} (token may be wrong)`);
    }
  } catch (e) {
    fail(`/status errored: ${e.message}`);
  }
}

// gh CLI
console.log("\n[gh CLI]");
async function exec(cmd, argv) {
  return new Promise(resolve => {
    let stdout = "", stderr = "";
    const p = spawn(cmd, argv, { shell: process.platform === "win32" });
    p.stdout.on("data", d => stdout += d);
    p.stderr.on("data", d => stderr += d);
    p.on("close", code => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    p.on("error", e => resolve({ code: -1, stdout: "", stderr: e.message }));
  });
}
const ghVer = await exec("gh", ["--version"]);
if (ghVer.code === 0) {
  ok(`installed: ${ghVer.stdout.split("\n")[0]}`);
  const auth = await exec("gh", ["auth", "status"]);
  if (auth.code === 0) ok(`authenticated`);
  else { fail(`not authenticated`); info(`fix: gh auth login`); }
} else {
  fail(`'gh' not found in PATH`);
  info(`fix: install GitHub CLI from https://cli.github.com — required for opening contribution PRs`);
}

// Work queue reachability
console.log("\n[work queue]");
try {
  const r = await fetch("https://rizzleroc.github.io/pursue-console/work-available.json", { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const q = await r.json();
  ok(`reachable · ${q.totalPagesNeeded} OCR · ${q.totalPagesNeedingReview} review · ${q.totalPagesNeedingVisualContext} media`);
} catch (e) {
  fail(`live work queue unreachable: ${e.message}`);
  info(`fix: check internet, or pass --queue-url=<local file URL> if testing offline`);
}

// Handle validation
if (HANDLE) {
  console.log("\n[handle]");
  if (/^[A-Za-z0-9_-]{1,39}$/.test(HANDLE)) ok(`'${HANDLE}' is a valid GitHub handle shape`);
  else fail(`'${HANDLE}' is not a valid GitHub handle (alnum, _, -, ≤39 chars)`);
}

console.log();
if (failures === 0) {
  console.log("[setup] ALL CHECKS PASSED — you're ready. Next:");
  console.log("        npm run volunteer -- --my-handle=YOU --slice=20");
  console.log("    or  node scripts/volunteer-media.mjs --my-handle=YOU --slice=5");
  process.exit(0);
} else {
  console.log(`[setup] ${failures} check(s) failed — fix and re-run.`);
  process.exit(1);
}
