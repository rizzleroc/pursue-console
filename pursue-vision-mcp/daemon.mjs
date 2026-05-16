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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ChatGPTDriver } from "./chatgpt-driver.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PURSUE_VISION_PORT || 9223);
const CDP_PORT = Number(process.env.PURSUE_CDP_PORT || 9222);
const TOKEN_PATH = path.join(os.homedir(), ".pursue-vision-token");

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
    if (!authOk(req)) {
      return sendJson(res, 401, { error: `unauthorized — bearer token at ${TOKEN_PATH}` });
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
