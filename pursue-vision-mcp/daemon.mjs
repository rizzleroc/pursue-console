// pursue-vision-mcp · daemon
//
// HTTP server exposing a single route, /chat-with-files, which queues
// requests serially against an already-logged-in ChatGPT browser tab.
//
// Drop-in compatible with the pursue-console vision-OCR pipeline:
//   POST /chat-with-files
//     { filePaths: string[], prompt: string, timeoutMs?: number, freshChat?: boolean }
//   200 → { text: string, durationMs: number, fileCount: number }
//   401 → { error: "unauthorized — set bearer token from ~/.pursue-vision-token" }
//   400 → { error: "filePaths[] + prompt required" }
//   500 → { error: "<message>" }
//
// Auth:
//   - Token is read from $PURSUE_VISION_TOKEN, else generated and written
//     to ~/.pursue-vision-token on first start. Send as Authorization: Bearer.
//
// Security model:
//   - Server binds only to 127.0.0.1.
//   - File-path jail: filePaths must resolve under your home directory or
//     under the directory you started the daemon from. No reading /etc.

import http from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ChatGPTDriver } from "./chatgpt-driver.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PURSUE_VISION_PORT || 9223);
const CDP_PORT = Number(process.env.PURSUE_CDP_PORT || 9222);
const TOKEN_PATH = path.join(os.homedir(), ".pursue-vision-token");
const DASHBOARD_HTML = path.join(__dirname, "dashboard.html");

// In-memory progress state shared between the volunteer.mjs reporter
// and the dashboard. POST /progress to update, GET /progress to read.
// One-volunteer-per-daemon is the design assumption so a single slot is fine.
let progressState = {
  handle: null,
  shiftStart: null,
  idle: true,
  onBreak: null,           // null or short label like "MICRO 2.1m"
  now: null,               // { eid, page, docMeta, phase, metaLine, previewUrl }
  slice: { done: 0, total: 0 },
  corpus: { done: 0, target: 0 },
  recent: [],              // [{page, state, note, ts}], last 6 trimmed
  session: { pagesOk: 0, pagesErr: 0 },
  updatedAt: null,
};

const ALLOWED_ROOTS = [os.homedir(), process.cwd()].map(p => path.resolve(p));
function jailPath(p) {
  const abs = path.resolve(p);
  if (!ALLOWED_ROOTS.some(root => abs === root || abs.startsWith(root + path.sep))) {
    throw new Error(`forbidden path (must be under home or cwd): ${p}`);
  }
  if (!existsSync(abs)) throw new Error(`not found: ${p}`);
  return abs;
}

async function loadToken() {
  if (process.env.PURSUE_VISION_TOKEN) return process.env.PURSUE_VISION_TOKEN;
  if (existsSync(TOKEN_PATH)) return (await readFile(TOKEN_PATH, "utf8")).trim();
  const t = randomBytes(24).toString("base64url");
  await writeFile(TOKEN_PATH, t, { encoding: "utf8", mode: 0o600 });
  console.log(`[daemon] generated new token at ${TOKEN_PATH}`);
  return t;
}
const TOKEN = await loadToken();

const driver = new ChatGPTDriver({ cdpPort: CDP_PORT });

// Single-slot serial queue — only one ChatGPT round-trip at a time.
let queue = Promise.resolve();
function enqueue(fn) {
  const next = queue.then(fn, fn);
  // Don't propagate rejections to the head of the queue.
  queue = next.catch(() => {});
  return next;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => { buf += c; if (buf.length > 4 * 1024 * 1024) reject(new Error("body too large")); });
    req.on("end", () => { try { resolve(JSON.parse(buf || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
function authOk(req) {
  const h = req.headers["authorization"] || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m && m[1].trim() === TOKEN;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    // ---- UNAUTHENTICATED LOCAL ROUTES (loopback-only server already) ----
    // The dashboard runs IN the volunteer's browser on the same machine and
    // talks to this daemon over 127.0.0.1. Adding bearer-auth to it would
    // just mean injecting the token into the HTML, which leaks it to the
    // browser anyway. The token IS still required on every WRITE route.
    if (req.method === "GET" && (req.url === "/" || req.url === "/dashboard")) {
      try {
        const html = await readFile(DASHBOARD_HTML, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(html);
      } catch {
        return sendJson(res, 500, { error: "dashboard.html missing" });
      }
    }
    if (req.method === "GET" && req.url === "/progress") {
      return sendJson(res, 200, progressState);
    }
    // Stream a local PNG as a thumbnail for the dashboard preview.
    // Path is base64url'd in the URL so it doesn't tangle with query parsing.
    // Server still jails the path to the standard ALLOWED_ROOTS.
    if (req.method === "GET" && req.url.startsWith("/preview/")) {
      const b64 = req.url.slice("/preview/".length).split("?")[0];
      let p;
      try { p = jailPath(Buffer.from(b64, "base64url").toString("utf8")); }
      catch { return sendJson(res, 403, { error: "bad preview path" }); }
      if (!/\.(png|jpe?g|webp|gif)$/i.test(p)) return sendJson(res, 400, { error: "preview must be an image" });
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      return createReadStream(p).pipe(res);
    }

    if (!authOk(req)) {
      return sendJson(res, 401, { error: `unauthorized — bearer token at ${TOKEN_PATH}` });
    }

    // ---- AUTHENTICATED ROUTES ----
    // POST /progress accepts a partial update; deep-merges into state.
    if (req.method === "POST" && req.url === "/progress") {
      const body = await readBody(req);
      progressState = { ...progressState, ...body, updatedAt: Date.now() };
      // Trim recent to last 6
      if (Array.isArray(progressState.recent)) {
        progressState.recent = progressState.recent.slice(-6);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && req.url === "/status") {
      return sendJson(res, 200, {
        port: PORT,
        cdpPort: CDP_PORT,
        connected: driver.isConnected(),
        queueDepth: driver.pendingCount() + (queue ? 1 : 0),
        history: driver.callCount,
      });
    }
    if (req.method === "POST" && req.url === "/chat-with-files") {
      const body = await readBody(req);
      const { filePaths, prompt, timeoutMs, freshChat = true } = body;
      if (!Array.isArray(filePaths) || !filePaths.length || !prompt) {
        return sendJson(res, 400, { error: "filePaths[] (non-empty) + prompt required" });
      }
      let validated;
      try { validated = filePaths.map(jailPath); }
      catch (e) { return sendJson(res, 403, { error: e.message }); }
      const t0 = Date.now();
      enqueue(async () => {
        try {
          const { text } = await driver.chatWithFiles({ filePaths: validated, prompt, timeoutMs, freshChat });
          sendJson(res, 200, { text, durationMs: Date.now() - t0, fileCount: validated.length });
        } catch (e) {
          console.error(`[/chat-with-files] ${e.message}`);
          sendJson(res, 500, { error: e.message });
        }
      });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    console.error("[daemon] unhandled:", e);
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[daemon] listening on http://127.0.0.1:${PORT}`);
  console.log(`[daemon] token  →  ${TOKEN_PATH}  (Authorization: Bearer ...)`);
  console.log(`[daemon] CDP    →  http://127.0.0.1:${CDP_PORT}  (must have an authenticated ChatGPT tab)`);
});

process.on("SIGINT", async () => {
  console.log("[daemon] shutting down");
  try { await driver.disconnect(); } catch {}
  server.close(() => process.exit(0));
});
