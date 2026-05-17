// pursue-vision-mcp · MONITOR
//
// A separate process from the MCP daemon. Owns the helper progress UI on
// its own port (default 9224, configurable via PURSUE_MONITOR_PORT). The
// MCP daemon (9223) stays single-responsibility — its only job is OCR.
//
// Design:
//   • Persists state to ~/.pursue-helper/progress.json so the monitor
//     can show last-known state even when nothing is actively running.
//   • Accepts live updates via POST /progress (bearer-authed) and writes
//     them to the file atomically. volunteer.mjs talks to this port.
//   • Serves dashboard.html on / and /dashboard for the browser UI.
//   • Streams local PNGs as preview thumbnails on /preview/<base64-path>,
//     jailed to home + cwd like the daemon.
//   • Optional --tui mode prints stats to the terminal instead of HTTP.
//
// Usage:
//   node pursue-vision-mcp/monitor.mjs            # HTTP + auto-open browser
//   node pursue-vision-mcp/monitor.mjs --tui      # terminal mode
//   node pursue-vision-mcp/monitor.mjs --no-open  # HTTP, don't open browser
//
// Env:
//   PURSUE_MONITOR_PORT  default 9224
//   PURSUE_HELPER_DIR    default ~/.pursue-helper
//   PURSUE_MONITOR_TOKEN if set, required on POST /progress (default: no auth)

import http from "node:http";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PURSUE_MONITOR_PORT || 9224);
const HELPER_DIR = process.env.PURSUE_HELPER_DIR || path.join(os.homedir(), ".pursue-helper");
const STATE_PATH = path.join(HELPER_DIR, "progress.json");
const STATE_TMP  = path.join(HELPER_DIR, "progress.json.tmp");
const DASHBOARD_HTML = path.join(__dirname, "dashboard.html");
const TOKEN = process.env.PURSUE_MONITOR_TOKEN || null;

const argv = new Set(process.argv.slice(2));
const TUI_MODE = argv.has("--tui");
const NO_OPEN = argv.has("--no-open");

await mkdir(HELPER_DIR, { recursive: true });

// ----- state -----
const blankState = () => ({
  handle: null,
  shiftStart: null,
  idle: true,
  onBreak: null,
  now: null,
  slice: { done: 0, total: 0 },
  corpus: { done: 0, target: 0 },
  recent: [],
  session: { pagesOk: 0, pagesErr: 0 },
  updatedAt: null,
  daemonPort: Number(process.env.PURSUE_VISION_PORT || 9223),
});

let state = blankState();
try {
  if (existsSync(STATE_PATH)) state = { ...blankState(), ...JSON.parse(await readFile(STATE_PATH, "utf8")) };
} catch {}

async function persistState() {
  try {
    await writeFile(STATE_TMP, JSON.stringify(state, null, 0), "utf8");
    await rename(STATE_TMP, STATE_PATH);
  } catch {} // non-fatal
}

// ----- TUI mode -----
async function tuiLoop() {
  process.stdout.write("\x1b[?25l"); // hide cursor
  process.on("SIGINT", () => { process.stdout.write("\x1b[?25h\n"); process.exit(0); });
  const c = {
    green: s => `\x1b[38;5;121m${s}\x1b[0m`,
    cyan:  s => `\x1b[38;5;117m${s}\x1b[0m`,
    amber: s => `\x1b[38;5;221m${s}\x1b[0m`,
    rose:  s => `\x1b[38;5;211m${s}\x1b[0m`,
    dim:   s => `\x1b[2;38;5;71m${s}\x1b[0m`,
    bold:  s => `\x1b[1m${s}\x1b[0m`,
  };
  const fmt = n => String(n).padStart(2, "0");
  while (true) {
    try {
      if (existsSync(STATE_PATH)) state = { ...blankState(), ...JSON.parse(await readFile(STATE_PATH, "utf8")) };
    } catch {}
    process.stdout.write("\x1b[2J\x1b[H");  // clear + home
    const now = new Date();
    const elapsed = state.shiftStart ? Math.max(0, (Date.now() - state.shiftStart) / 1000) : 0;
    const h = Math.floor(elapsed / 3600), m = Math.floor((elapsed % 3600) / 60), s = Math.floor(elapsed % 60);
    const slicePct = state.slice.total ? Math.round(state.slice.done / state.slice.total * 100) : 0;
    const corpusPct = state.corpus.target ? Math.round(state.corpus.done / state.corpus.target * 100) : 0;
    const statusColor = state.idle ? c.dim : state.onBreak ? c.amber : c.green;

    console.log(c.green(c.bold("  P U R S U E   V O L U N T E E R   I N S T R U M E N T")));
    console.log(c.dim(`  operator @${state.handle || "—"}     ${now.toUTCString()}`));
    console.log("");
    console.log(`  ${statusColor("●")} ${state.idle ? "IDLE" : state.onBreak ? `BREAK · ${state.onBreak}` : "ACTIVE"}      shift ${fmt(h)}:${fmt(m)}:${fmt(s)}`);
    console.log("");
    if (state.now) {
      console.log(c.cyan(`  NOW PROCESSING  ${state.now.eid || ""}`));
      console.log(c.cyan(`  ${c.bold("page " + (state.now.page || "—"))}`));
      console.log(c.dim(`  ${state.now.phase || ""}`));
      console.log(c.dim(`  ${state.now.metaLine || ""}`));
    } else {
      console.log(c.dim("  awaiting first batch…"));
    }
    console.log("");
    const barW = 40;
    const sliceFill = "█".repeat(Math.round(slicePct * barW / 100)) + "░".repeat(barW - Math.round(slicePct * barW / 100));
    const corpusFill = "█".repeat(Math.round(corpusPct * barW / 100)) + "░".repeat(barW - Math.round(corpusPct * barW / 100));
    console.log(`  YOUR SLICE   ${c.amber(sliceFill)}  ${state.slice.done}/${state.slice.total}  ${slicePct}%`);
    console.log(`  CORPUS       ${c.green(corpusFill)}  ${state.corpus.done.toLocaleString()}/${state.corpus.target.toLocaleString()}  ${corpusPct}%`);
    console.log("");
    if (state.recent.length) {
      console.log(c.dim("  LAST SIX COMPLETIONS"));
      for (const r of state.recent.slice(-6)) {
        const stateC = r.state === "ok" ? c.green : r.state === "fallback" ? c.amber : r.state === "pending" ? c.cyan : c.rose;
        console.log(`    p${String(r.page).padStart(3)}   ${stateC((r.state || "ok").toUpperCase().padEnd(10))}   ${c.dim(r.note || "")}`);
      }
    }
    console.log("");
    console.log(c.dim(`  state at ${STATE_PATH}    ctrl-c to exit`));
    await new Promise(r => setTimeout(r, 1000));
  }
}

if (TUI_MODE) {
  await tuiLoop();
  process.exit(0);
}

// ----- jail helper (shared idea with daemon, kept lightweight here) -----
const ALLOWED_ROOTS = [os.homedir(), process.cwd(), HELPER_DIR].map(p => path.resolve(p));
function jailPath(p) {
  const abs = path.resolve(p);
  if (!ALLOWED_ROOTS.some(root => abs === root || abs.startsWith(root + path.sep))) {
    throw new Error("path outside allowed roots");
  }
  if (!existsSync(abs)) throw new Error("not found");
  return abs;
}

// ----- HTTP server -----
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => { buf += c; if (buf.length > 1024 * 1024) reject(new Error("body too large")); });
    req.on("end", () => { try { resolve(JSON.parse(buf || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return sendJson(res, 200, { ok: true });

    if (req.method === "GET" && (req.url === "/" || req.url === "/dashboard")) {
      try {
        const html = await readFile(DASHBOARD_HTML, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(html);
      } catch { return sendJson(res, 500, { error: "dashboard.html missing" }); }
    }
    if (req.method === "GET" && req.url === "/progress") return sendJson(res, 200, state);

    if (req.method === "GET" && req.url.startsWith("/preview/")) {
      const b64 = req.url.slice("/preview/".length).split("?")[0];
      let p;
      try { p = jailPath(Buffer.from(b64, "base64url").toString("utf8")); }
      catch { return sendJson(res, 403, { error: "bad preview path" }); }
      if (!/\.(png|jpe?g|webp|gif)$/i.test(p)) return sendJson(res, 400, { error: "preview must be an image" });
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      return createReadStream(p).pipe(res);
    }

    if (req.method === "POST" && req.url === "/progress") {
      if (TOKEN) {
        const h = req.headers["authorization"] || "";
        const m = h.match(/^Bearer\s+(.+)$/i);
        if (!m || m[1].trim() !== TOKEN) return sendJson(res, 401, { error: "monitor token mismatch" });
      }
      const body = await readBody(req);
      state = { ...state, ...body, updatedAt: Date.now() };
      if (Array.isArray(state.recent)) state.recent = state.recent.slice(-6);
      persistState();   // fire and forget
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log("");
  console.log("╭───────────────────────────────────────────────────────────╮");
  console.log("│  PURSUE MONITOR (separate from MCP daemon)               │");
  console.log("│  " + url.padEnd(57) + "│");
  console.log("│  state file: " + STATE_PATH.slice(-43).padStart(43) + "│");
  console.log("╰───────────────────────────────────────────────────────────╯");
  if (NO_OPEN) return;
  const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
              : process.platform === "darwin" ? ["open", [url]]
              :                                  ["xdg-open", [url]];
  try {
    const c = spawn(opener[0], opener[1], { stdio: "ignore", detached: true });
    c.on("error", () => {});
    c.unref();
  } catch {}
});
