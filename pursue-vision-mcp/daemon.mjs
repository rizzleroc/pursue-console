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
import { GeminiDriver }  from "./gemini-driver.mjs";
import { ClaudeDriver } from "./claude-driver.mjs";
import { WarGovDriver }  from "./war-gov-driver.mjs";

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
// Like jailPath, but for output directories that don't exist yet (the
// caller will mkdir -p). Validates jail without requiring existence.
function jailDestDir(p) {
  if (!p || typeof p !== "string") throw new Error("destDir required");
  const abs = path.resolve(p);
  if (!ALLOWED_ROOTS.some(root => abs === root || abs.startsWith(root + path.sep))) {
    throw new Error(`forbidden destDir (must be under home or cwd): ${p}`);
  }
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

// Three driver instances, three single-slot queues — one per provider.
// That way a /fanout-style "send to both at the same time" call can
// really run in parallel (different browser tabs, different network
// paths). The warGov driver lives alongside the LLM drivers but talks
// to the war.gov tab instead, for raw-corpus collection (Release 02+).
const drivers = {
  chatgpt: new ChatGPTDriver({ cdpPort: CDP_PORT }),
  gemini:  new GeminiDriver({  cdpPort: CDP_PORT }),
  claude:  new ClaudeDriver({  cdpPort: CDP_PORT }),
  warGov:  new WarGovDriver({  cdpPort: CDP_PORT }),
};
const queues = {
  chatgpt: Promise.resolve(),
  gemini:  Promise.resolve(),
  claude:  Promise.resolve(),
  warGov:  Promise.resolve(),
};
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
          claude:  { connected: drivers.claude.isConnected(),  history: drivers.claude.callCount },
          warGov:  { connected: drivers.warGov.isConnected(),  history: drivers.warGov.callCount },
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
    // /war-gov/index — fetch the war.gov/UFO release-files index for one
    // release (default 2). The driver this delegates to is annotated
    // 'unverified' (see war-gov-driver.mjs header) — never run live.
    // Long-poll: keep the request open until the driver returns the
    // filtered, normalized record list.
    if (req.method === "GET" && req.url.startsWith("/war-gov/index")) {
      const u = new URL(req.url, "http://x");
      const release = u.searchParams.get("release") || "2";
      enqueue("warGov", async () => {
        try {
          const records = await drivers.warGov.fetchIndex({ release });
          sendJson(res, 200, { release, count: records.length, records });
        } catch (e) {
          console.error(`[/war-gov/index] ${e.message}`);
          sendJson(res, 500, { error: e.message });
        }
      });
      return;
    }

    // /war-gov/download — download a list of war.gov URLs into a jailed
    // destDir. Long-running: holds the connection open until every file
    // either lands or fails, then returns the per-file results.
    if (req.method === "POST" && req.url === "/war-gov/download") {
      const body = await readBody(req);
      const { urls, destDir } = body;
      if (!Array.isArray(urls) || !urls.length) {
        return sendJson(res, 400, { error: "urls[] (non-empty) required" });
      }
      let safeDestDir;
      try { safeDestDir = jailDestDir(destDir); }
      catch (e) { return sendJson(res, 403, { error: e.message }); }
      try { await mkdir(safeDestDir, { recursive: true }); }
      catch (e) { return sendJson(res, 500, { error: `mkdir failed: ${e.message}` }); }
      // Sanity-cap to keep one request from monopolizing the queue for
      // hours of opaque time. The maintainer's typical batch is ≤ 64
      // (= Release 02 total). Anything bigger should be split.
      if (urls.length > 256) {
        return sendJson(res, 400, { error: `too many urls (${urls.length}); split into batches ≤ 256` });
      }
      const t0 = Date.now();
      enqueue("warGov", async () => {
        const results = [];
        for (const url of urls) {
          // Best-effort URL → filename. We resolve filenames here (not
          // in the driver) so the driver stays single-responsibility.
          let fileName;
          try { fileName = decodeURIComponent(path.basename(new URL(url).pathname)) || "file.bin"; }
          catch { fileName = "file.bin"; }
          const destPath = path.join(safeDestDir, fileName);
          const pt0 = Date.now();
          try {
            const out = await drivers.warGov.downloadFile({ url, destPath });
            results.push({ url, ok: true, bytes: out.bytes, destPath, durationMs: Date.now() - pt0 });
          } catch (e) {
            console.error(`[/war-gov/download] ${url} → ${e.message}`);
            results.push({ url, ok: false, error: e.message, durationMs: Date.now() - pt0 });
            // Akamai blocks tend to be sticky once they fire; bail out
            // rather than burn the rest of the batch on the same block.
            if (/akamai\s*block/i.test(e.message)) {
              results.push({ url: "__abort__", ok: false, error: "aborting batch on Akamai block" });
              break;
            }
          }
        }
        sendJson(res, 200, {
          destDir: safeDestDir,
          totalDurationMs: Date.now() - t0,
          results,
        });
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
  for (const d of Object.values(drivers)) {
    try { if (typeof d?.disconnect === "function") await d.disconnect(); } catch {}
  }
  server.close(() => process.exit(0));
});
