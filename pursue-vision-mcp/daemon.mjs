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
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ChatGPTDriver } from "./chatgpt-driver.mjs";
import { GeminiDriver }  from "./gemini-driver.mjs";
import { ClaudeDriver } from "./claude-driver.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PURSUE_VISION_PORT || 9223);
const CDP_PORT = Number(process.env.PURSUE_CDP_PORT || 9222);
const TOKEN_PATH = path.join(os.homedir(), ".pursue-vision-token");

// Progress UI is a separate concern — see pursue-vision-mcp/monitor.mjs
// on port 9224. This daemon stays focused on /chat-with-files only.

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

// Two driver instances, two single-slot queues — one per provider. That
// way a /fanout-style "send to both at the same time" call can really
// run in parallel (different browser tabs, different network paths).
const drivers = {
  chatgpt: new ChatGPTDriver({ cdpPort: CDP_PORT }),
  gemini:  new GeminiDriver({  cdpPort: CDP_PORT }),
  claude: new ClaudeDriver({ cdpPort: CDP_PORT }),
};
const queues = { chatgpt: Promise.resolve(), gemini: Promise.resolve(), claude: Promise.resolve() };
function enqueue(provider, fn) {
  const cur = queues[provider] ?? Promise.resolve();
  const next = cur.then(fn, fn);
  queues[provider] = next.catch(() => {});
  return next;
}
function normalizeProvider(p) {
  const v = (p || "chatgpt").toLowerCase();
  if (v === "openai" || v === "gpt" || v === "chatgpt") return "chatgpt";
  if (v === "gemini" || v === "google" || v === "bard") return "gemini";
  if (v === "claude" || v === "anthropic" || v === "claude.ai") return "claude";
  throw new Error(`unknown provider: ${p}`);
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
    // Friendly redirect: anyone who hits the daemon root looking for the
    // dashboard gets pointed at the monitor.
    if (req.method === "GET" && (req.url === "/" || req.url === "/dashboard")) {
      res.writeHead(302, { Location: `http://127.0.0.1:${process.env.PURSUE_MONITOR_PORT || 9224}/` });
      return res.end();
    }
    if (!authOk(req)) {
      return sendJson(res, 401, { error: `unauthorized — bearer token at ${TOKEN_PATH}` });
    }

    if (req.method === "GET" && req.url === "/status") {
      return sendJson(res, 200, {
        port: PORT,
        cdpPort: CDP_PORT,
        providers: {
          chatgpt: { connected: drivers.chatgpt.isConnected(), history: drivers.chatgpt.callCount },
          gemini:  { connected: drivers.gemini.isConnected(),  history: drivers.gemini.callCount },
          claude:  { connected: drivers.claude.isConnected(), history: drivers.claude.callCount },
        },
      });
    }
    if (req.method === "POST" && req.url === "/chat-with-files") {
      const body = await readBody(req);
      const { filePaths, prompt, timeoutMs, freshChat = true } = body;
      if (!Array.isArray(filePaths) || !filePaths.length || !prompt) {
        return sendJson(res, 400, { error: "filePaths[] (non-empty) + prompt required" });
      }
      let provider;
      try { provider = normalizeProvider(body.provider); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
      let validated;
      try { validated = filePaths.map(jailPath); }
      catch (e) { return sendJson(res, 403, { error: e.message }); }
      const t0 = Date.now();
      enqueue(provider, async () => {
        try {
          const { text } = await drivers[provider].chatWithFiles({ filePaths: validated, prompt, timeoutMs, freshChat });
          sendJson(res, 200, { provider, text, durationMs: Date.now() - t0, fileCount: validated.length });
        } catch (e) {
          console.error(`[/chat-with-files ${provider}] ${e.message}`);
          sendJson(res, 500, { provider, error: e.message });
        }
      });
      return;
    }

    // /fanout — send the SAME prompt + files to BOTH providers in parallel
    // and return both responses for side-by-side comparison. The maintainer
    // uses this for re-evaluating disputed pages with a standardized prompt.
    if (req.method === "POST" && req.url === "/fanout") {
      const body = await readBody(req);
      const { filePaths, prompt, timeoutMs, perProviderTimeoutMs, freshChat = true } = body;
      if (!Array.isArray(filePaths) || !filePaths.length || !prompt) {
        return sendJson(res, 400, { error: "filePaths[] (non-empty) + prompt required" });
      }
      const fanoutTimeoutMs = perProviderTimeoutMs ?? timeoutMs;
      const requested = Array.isArray(body.providers) && body.providers.length
        ? body.providers.map(normalizeProvider)
        : ["chatgpt", "gemini", "claude"];
      let validated;
      try { validated = filePaths.map(jailPath); }
      catch (e) { return sendJson(res, 403, { error: e.message }); }
      const t0 = Date.now();
      const results = await Promise.all(requested.map(provider => new Promise(resolve => {
        const pt0 = Date.now();
        enqueue(provider, async () => {
          try {
            const { text } = await drivers[provider].chatWithFiles({ filePaths: validated, prompt, timeoutMs: fanoutTimeoutMs, freshChat });
            resolve({ provider, ok: true, text, durationMs: Date.now() - pt0 });
          } catch (e) {
            console.error(`[/fanout ${provider}] ${e.message}`);
            resolve({ provider, ok: false, error: e.message, durationMs: Date.now() - pt0 });
          }
        });
      })));
      return sendJson(res, 200, { results, totalDurationMs: Date.now() - t0 });
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
  for (const d of Object.values(drivers)) {
    try { if (typeof d?.disconnect === "function") await d.disconnect(); } catch {}
  }
  server.close(() => process.exit(0));
});
