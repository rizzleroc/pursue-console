// =====================================================================
// pursue-rag-server — Railway-deployable RAG proxy.
//
// Same /ask wire protocol as pursue-vision-mcp's local daemon, so the
// browser code in src/lib/ragClient.js doesn't care which one it's
// talking to.
//
//   POST /ask
//     { question, contexts: [{eid, page, text}], provider? }
//   200 → { provider, text, durationMs, contextCount }
//
// Differences from the local MCP:
//   • Uses the Anthropic Messages API server-side (the maintainer's
//     ANTHROPIC_API_KEY env var). The browser never sees the key.
//   • IP rate-limited so a casual visitor can't burn credits.
//   • CORS allowlisted to the deployed GH Pages origin + localhost dev.
//   • Optional shared bearer (PURSUE_RAG_BEARER env) — when set, the
//     browser must include it in Authorization. Useful for adding a
//     thin layer of "only my deploy can call this" on top of CORS.
//
// Deploy on Railway:
//   1. `railway init` from this folder (or attach a service to this
//      directory in the Railway dashboard).
//   2. Set env vars:
//        ANTHROPIC_API_KEY       (required)
//        ALLOWED_ORIGINS         (comma-separated, default GH Pages site)
//        PURSUE_RAG_BEARER       (optional shared secret)
//        ANTHROPIC_MODEL         (optional; default claude-haiku-4-5)
//        RATE_LIMIT_PER_MIN      (optional; default 6)
//        RATE_LIMIT_PER_DAY      (optional; default 120)
//   3. Set the start command to `npm start` (default in package.json).
//   4. Railway gives you a public URL; paste it into the browser's ASK
//      settings as the Hosted backend URL.
// =====================================================================
import http from "node:http";
import Anthropic from "@anthropic-ai/sdk";

const PORT = Number(process.env.PORT || 8080);

// ---- config ---------------------------------------------------------
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const SHARED_BEARER = process.env.PURSUE_RAG_BEARER || "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  || "https://rizzleroc.github.io")
  .split(",").map(s => s.trim()).filter(Boolean);

const RPM = Number(process.env.RATE_LIMIT_PER_MIN || 6);
const RPD = Number(process.env.RATE_LIMIT_PER_DAY || 120);

if (!ANTHROPIC_KEY) {
  console.error("[fatal] ANTHROPIC_API_KEY env var is required");
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ---- CORS -----------------------------------------------------------
function allowedOrigin(origin) {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  // Always permit localhost dev so contributors can hit a deployed
  // staging proxy from their vite dev server without touching env vars.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}
function setCors(req, res) {
  const origin = allowedOrigin(req.headers["origin"]);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
}
function handlePreflight(req, res) {
  setCors(req, res);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] || "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  res.writeHead(204); res.end();
}

// ---- in-memory rate limit ------------------------------------------
// Token bucket per client IP. Two buckets — per-minute and per-day —
// so a quick burst is allowed but a sustained crawler is throttled.
// Reset by process restart; sufficient for a side-project free tier.
const buckets = new Map();   // ip → { minStart, minCount, dayStart, dayCount }
function rateOk(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { minStart: now, minCount: 0, dayStart: now, dayCount: 0 };
  if (now - b.minStart > 60_000) { b.minStart = now; b.minCount = 0; }
  if (now - b.dayStart > 24 * 60 * 60_000) { b.dayStart = now; b.dayCount = 0; }
  if (b.minCount >= RPM) return { ok: false, reason: `rate limit: ${RPM}/min` };
  if (b.dayCount >= RPD) return { ok: false, reason: `rate limit: ${RPD}/day` };
  b.minCount++; b.dayCount++;
  buckets.set(ip, b);
  return { ok: true };
}

function clientIp(req) {
  // Railway puts the real IP in x-forwarded-for. Take the first hop.
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

// ---- helpers --------------------------------------------------------
function sendJson(res, status, body) {
  if (!res.headersSent) res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => {
      buf += c;
      if (buf.length > 1_000_000) reject(new Error("body too large (>1MB)"));
    });
    req.on("end", () => { try { resolve(JSON.parse(buf || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

// ---- LLM call -------------------------------------------------------
// Build the same instruction shape the local MCP daemon uses, but
// inline (no file upload — the Messages API takes the context directly
// in the prompt). Cap context size so a wild K doesn't OOM the request.
function buildPrompt(question, contexts) {
  const lines = [];
  lines.push("CONTEXT — top retrieved passages from the PURSUE corpus");
  lines.push("(declassified war.gov/UFO documents). Each shows EID, page,");
  lines.push("and the snippet of source text.");
  lines.push("");
  for (const c of contexts.slice(0, 20)) {
    const head = `--- ${c.eid || "?"}${c.page != null ? ` · p${c.page}` : ""}${c.title ? ` · ${c.title}` : ""} ---`;
    lines.push(head);
    lines.push(String(c.text || c.snippet || "").slice(0, 2000).trim());
    lines.push("");
  }
  lines.push(`QUESTION: ${question}`);
  lines.push("");
  lines.push("Answer the question using ONLY the context above. Cite each");
  lines.push("supporting passage inline as [eid · page] using the EID");
  lines.push("exactly as it appears above. If the context doesn't contain");
  lines.push("enough to answer, say so plainly — do not invent facts. Keep");
  lines.push("it under 300 words, terse and analytic.");
  return lines.join("\n");
}

async function callAnthropic(question, contexts) {
  const t0 = Date.now();
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: buildPrompt(question, contexts) }],
  });
  // Concat all text blocks; ignore tool blocks (we don't use tools here).
  const text = (msg.content || [])
    .filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  return { text, durationMs: Date.now() - t0, model: msg.model, usage: msg.usage };
}

// ---- HTTP server ----------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return handlePreflight(req, res);
    setCors(req, res);

    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true, model: MODEL });
    }
    if (req.method === "GET" && req.url === "/") {
      return sendJson(res, 200, {
        service: "pursue-rag-server",
        endpoints: ["GET /health", "POST /ask"],
        model: MODEL,
      });
    }

    if (req.method === "POST" && req.url === "/ask") {
      // Optional shared bearer — when SHARED_BEARER is set, require it.
      if (SHARED_BEARER) {
        const h = req.headers["authorization"] || "";
        const m = h.match(/^Bearer\s+(.+)$/i);
        if (!m || m[1].trim() !== SHARED_BEARER) {
          return sendJson(res, 401, { error: "unauthorized" });
        }
      }
      const origin = req.headers["origin"];
      if (origin && !allowedOrigin(origin)) {
        return sendJson(res, 403, { error: `origin not allowed: ${origin}` });
      }
      const ip = clientIp(req);
      const rate = rateOk(ip);
      if (!rate.ok) {
        return sendJson(res, 429, { error: rate.reason });
      }

      let body;
      try { body = await readBody(req); }
      catch (e) { return sendJson(res, 400, { error: `bad body: ${e.message}` }); }

      const { question, contexts } = body;
      if (!question || typeof question !== "string") {
        return sendJson(res, 400, { error: "question (string) required" });
      }
      if (!Array.isArray(contexts) || contexts.length === 0) {
        return sendJson(res, 400, { error: "contexts[] (non-empty) required" });
      }

      try {
        const out = await callAnthropic(question, contexts);
        return sendJson(res, 200, {
          provider: "anthropic",
          text: out.text,
          durationMs: out.durationMs,
          contextCount: contexts.length,
          model: out.model,
          usage: out.usage,
        });
      } catch (e) {
        console.error(`[/ask] ${e.message}`);
        const status = e.status || 502;
        return sendJson(res, status, { error: e.message });
      }
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    console.error("[server] unhandled:", e);
    if (!res.headersSent) return sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[pursue-rag-server] listening on 0.0.0.0:${PORT}`);
  console.log(`[pursue-rag-server] model = ${MODEL}`);
  console.log(`[pursue-rag-server] allowed origins = ${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`[pursue-rag-server] rate limit = ${RPM}/min, ${RPD}/day per IP`);
  if (SHARED_BEARER) console.log(`[pursue-rag-server] shared bearer required`);
});
