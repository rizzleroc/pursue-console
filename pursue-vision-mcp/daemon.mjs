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
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ChatGPTDriver } from "./chatgpt-driver.mjs";
import { GeminiDriver }  from "./gemini-driver.mjs";
import { ClaudeDriver } from "./claude-driver.mjs";
import { WarGovDriver }  from "./war-gov-driver.mjs";
import { DVIDSDriver }   from "./dvids-driver.mjs";

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
  dvids:   new DVIDSDriver({   cdpPort: CDP_PORT }),
};
const queues = {
  chatgpt: Promise.resolve(),
  gemini:  Promise.resolve(),
  claude:  Promise.resolve(),
  warGov:  Promise.resolve(),
  dvids:   Promise.resolve(),
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

// CORS — the pursue-console static site (deployed at rizzleroc.github.io
// or run locally on vite's dev port) is HTTPS / cross-origin to this
// localhost daemon. Without these headers, the browser blocks the response.
//
// Allowlist: github.io deploys + any localhost:* / 127.0.0.1:* during dev.
// Any other origin: no ACAO sent → request blocked. Safer than "*".
//
// Private-Network-Access: Chrome 113+ requires Access-Control-Allow-
// Private-Network on the preflight when a public-origin page (https GH
// Pages) fetches a private-IP target (127.0.0.1). Without it the fetch
// fails before the actual request even leaves the browser.
function allowedOrigin(origin) {
  if (!origin) return null;
  if (origin === "https://rizzleroc.github.io") return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}
function setCors(req, res) {
  const origin = allowedOrigin(req.headers["origin"]);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "false");
  }
}
function handlePreflight(req, res) {
  setCors(req, res);
  // Echo back the headers the browser said it wants to send, so any custom
  // header (X-Pursue-Trace, etc.) works without us hard-coding a list.
  const reqHeaders = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", reqHeaders || "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  // Chrome PNA: explicitly opt in to being fetched from a public site.
  if (req.headers["access-control-request-private-network"] === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  res.writeHead(204);
  res.end();
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
    // CORS preflight runs without auth (the browser strips Authorization
    // from preflight by design). Real requests still go through authOk.
    if (req.method === "OPTIONS") return handlePreflight(req, res);
    setCors(req, res);
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
          dvids:   { connected: drivers.dvids.isConnected(),   history: drivers.dvids.callCount },
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

    // /ask — RAG-style endpoint for the browser ASK view. The browser does
    // FAISS-style cosine over public/embeddings.bin locally, picks the top
    // K passages, and POSTs them here with the user's question. We bundle
    // them into a single .txt context file, hand it to the chosen driver
    // (which uploads it to its logged-in browser tab the same way
    // /chat-with-files does), and stream back the model's reply.
    //
    // Body: {
    //   question:  string,                                  // user query
    //   contexts:  [{ eid, page, title?, agency?, text }],  // top-K snippets
    //   provider:  "chatgpt" | "claude" | "gemini" (default "claude"),
    //   timeoutMs: number?,
    //   freshChat: boolean? (default true)
    // }
    if (req.method === "POST" && req.url === "/ask") {
      const body = await readBody(req);
      const { question, contexts, timeoutMs, freshChat = true } = body;
      if (!question || typeof question !== "string") {
        return sendJson(res, 400, { error: "question (string) required" });
      }
      if (!Array.isArray(contexts) || contexts.length === 0) {
        return sendJson(res, 400, { error: "contexts[] (non-empty) required" });
      }
      let provider;
      try { provider = normalizeProvider(body.provider || "claude"); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }

      // Build a single prompt containing the retrieved passages + the
      // question + answer instructions. The text-only context goes to a
      // tmpfile so we can reuse the existing chat-with-files upload flow
      // (no driver changes needed).
      const lines = [];
      lines.push("CONTEXT — these are the top retrieved passages from the");
      lines.push("PURSUE corpus (war.gov/UFO declassified documents). Each");
      lines.push("passage shows EID, page, and a snippet of the source text.");
      lines.push("");
      for (const c of contexts.slice(0, 32)) {
        lines.push(`--- ${c.eid || "?"}${c.page != null ? ` · p${c.page}` : ""}${c.title ? ` · ${c.title}` : ""} ---`);
        lines.push(String(c.text || c.snippet || "").trim());
        lines.push("");
      }
      const contextBlob = lines.join("\n");
      const tmpPath = path.join(os.tmpdir(), `pursue-ask-${randomBytes(8).toString("hex")}.txt`);
      await writeFile(tmpPath, contextBlob, "utf8");

      const prompt = [
        `Question from the user: "${question}"`,
        "",
        `Answer the question using ONLY the attached context file (top retrieved`,
        `passages from the PURSUE corpus). When you reference a passage, cite it`,
        `inline as [eid · page] using the EID exactly as it appears in the file.`,
        `If the context doesn't contain enough to answer, say so plainly — do not`,
        `invent facts. Keep it under 300 words, terse and analytic.`,
      ].join("\n");

      const t0 = Date.now();
      enqueue(provider, async () => {
        try {
          const { text } = await drivers[provider].chatWithFiles({
            filePaths: [tmpPath], prompt, timeoutMs, freshChat,
          });
          sendJson(res, 200, {
            provider, text,
            durationMs: Date.now() - t0,
            contextCount: contexts.length,
          });
        } catch (e) {
          console.error(`[/ask ${provider}] ${e.message}`);
          sendJson(res, 500, { provider, error: e.message });
        } finally {
          // Best-effort cleanup. If unlink races with the driver still
          // holding the upload open, we'd see EBUSY on Windows — ignore.
          unlink(tmpPath).catch(() => {});
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

    // /dvids/resolve — given a numeric DVIDS asset ID, return the direct
    // mp4 URL (plus title + best-effort duration/size). The driver this
    // delegates to is annotated 'unverified' (see dvids-driver.mjs
    // header) — Akamai-style TLS-fingerprint block at dvidshub.net means
    // only the maintainer's real Chrome can verify the round-trip.
    if (req.method === "GET" && req.url.startsWith("/dvids/resolve")) {
      const u = new URL(req.url, "http://x");
      const videoId = u.searchParams.get("videoId") || "";
      if (!/^\d+$/.test(videoId)) {
        return sendJson(res, 400, { error: "videoId (numeric DVIDS asset id) required" });
      }
      enqueue("dvids", async () => {
        try {
          const info = await drivers.dvids.resolveVideoUrl({ videoId });
          sendJson(res, 200, info);
        } catch (e) {
          console.error(`[/dvids/resolve] ${e.message}`);
          sendJson(res, 500, { error: e.message });
        }
      });
      return;
    }

    // /dvids/download — resolve + download a batch of DVIDS videos into
    // per-item destPath. Long-running: holds the connection open until
    // every video either lands or fails. Per-item destPath is path-jailed
    // (under home or cwd) just like /war-gov/download's destDir.
    if (req.method === "POST" && req.url === "/dvids/download") {
      const body = await readBody(req);
      const { videos } = body;
      if (!Array.isArray(videos) || !videos.length) {
        return sendJson(res, 400, { error: "videos[] (non-empty) required" });
      }
      // Sanity-cap; the maintainer's realistic batch is the ~51 video
      // count of Release 02. 32 is below that on purpose so we serialize
      // smaller chunks — if a batch dies mid-way the user can resume.
      if (videos.length > 32) {
        return sendJson(res, 400, { error: `too many videos (${videos.length}); split into batches ≤ 32` });
      }
      // Validate each item up front so we don't start a long-running
      // download and then realize item 17 has a bogus destPath.
      const items = [];
      for (const v of videos) {
        const vid = v?.videoId != null ? String(v.videoId).trim() : "";
        const dest = v?.destPath || "";
        if (!/^\d+$/.test(vid)) {
          return sendJson(res, 400, { error: `each video needs a numeric videoId (got '${vid}')` });
        }
        if (!dest || typeof dest !== "string") {
          return sendJson(res, 400, { error: `each video needs a destPath (videoId=${vid})` });
        }
        let safeDest;
        try { safeDest = jailDestDir(path.dirname(dest)); }
        catch (e) { return sendJson(res, 403, { error: `${e.message} (for videoId=${vid})` }); }
        const absDest = path.join(safeDest, path.basename(dest));
        items.push({ videoId: vid, destPath: absDest });
      }
      const t0 = Date.now();
      enqueue("dvids", async () => {
        const results = [];
        for (const { videoId, destPath } of items) {
          const pt0 = Date.now();
          try {
            const info = await drivers.dvids.resolveVideoUrl({ videoId });
            await drivers.dvids.downloadFile({ url: info.mp4Url, destPath });
            const { statSync } = await import("node:fs");
            let bytes = null;
            try { bytes = statSync(destPath).size; } catch {}
            results.push({
              videoId, ok: true, bytes, mp4Url: info.mp4Url, title: info.title,
              destPath, durationMs: Date.now() - pt0,
            });
          } catch (e) {
            console.error(`[/dvids/download] videoId=${videoId} → ${e.message}`);
            results.push({ videoId, ok: false, error: e.message, durationMs: Date.now() - pt0 });
            // CDN blocks tend to be sticky once they fire; bail the
            // batch rather than burn the rest on the same block.
            if (/\bblock\b/i.test(e.message)) {
              results.push({ videoId: "__abort__", ok: false, error: "aborting batch on CDN block" });
              break;
            }
          }
        }
        sendJson(res, 200, {
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
