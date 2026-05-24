// =====================================================================
// RAG client. Wires the browser-side pieces of ASK's SMART mode:
//   (1) load embeddings.bin + MiniLM model (lazy, cached)
//   (2) embed the user question
//   (3) cosine-top-K against every stored vector
//   (4) POST the question + top-K passages to /ask on the chosen backend
//   (5) return { answer, contexts, durationMs, provider } to the view
//
// Two backends, same wire protocol:
//
//   hosted    → pursue-rag-server on Railway. URL from settings.hostedUrl.
//               Optional shared bearer from settings.hostedBearer. The
//               server calls Anthropic with the maintainer's API key.
//
//   local-mcp → pursue-vision-mcp daemon on 127.0.0.1:9223. URL from
//               settings.daemonUrl. Bearer from settings.token. The
//               daemon routes through the user's logged-in Claude /
//               ChatGPT / Gemini browser tab.
// =====================================================================
import { loadVectors, loadModel, embedQuery, topK } from "./embedClient.js";

function backendConfig(settings) {
  if (settings.backend === "local-mcp") {
    return {
      url: (settings.daemonUrl || "").replace(/\/+$/, "") + "/ask",
      auth: settings.token ? `Bearer ${settings.token}` : null,
      requiresAuth: true,
      requiresUrl: !!settings.daemonUrl,
      label: "local MCP",
      providerHint: settings.provider || "claude",
    };
  }
  return {
    url: (settings.hostedUrl || "").replace(/\/+$/, "") + "/ask",
    auth: settings.hostedBearer ? `Bearer ${settings.hostedBearer}` : null,
    requiresAuth: false,
    requiresUrl: !!settings.hostedUrl,
    label: "hosted",
    providerHint: undefined,    // server decides
  };
}

// Status callbacks let the view show "embedding question…", "calling
// hosted backend…", etc. without us coupling to React state.
export async function askWithRag({ question, settings, onStatus }) {
  if (!question || !question.trim()) throw new Error("question required");
  const cfg = backendConfig(settings);
  if (!cfg.requiresUrl) throw new Error("backend URL required");
  if (cfg.requiresAuth && !cfg.auth) {
    throw new Error("MCP bearer token required (paste from ~/.pursue-vision-token)");
  }

  onStatus?.({ phase: "loading-vectors" });
  const [{ vectors, meta, info }] = await Promise.all([loadVectors()]);

  onStatus?.({ phase: "loading-model" });
  await loadModel();           // warm the in-memory cache

  onStatus?.({ phase: "embedding" });
  const qVec = await embedQuery(question);

  onStatus?.({ phase: "retrieving" });
  const K = Math.max(3, Math.min(32, Number(settings.k) || 10));
  const hits = topK(qVec, vectors, info.dim, info.count, K);

  // Hydrate each hit with its meta entry. Snippets are ~200 chars,
  // plenty to ground the LLM without blowing past the request budget.
  const contexts = hits.map(h => {
    const m = meta[h.idx] || {};
    return {
      eid: m.eventId, page: m.page, kind: m.kind,
      score: h.score,
      text: m.snippet || "",
    };
  });

  onStatus?.({
    phase: "calling-backend",
    backend: cfg.label,
    contextCount: contexts.length,
  });

  const headers = { "Content-Type": "application/json" };
  if (cfg.auth) headers["Authorization"] = cfg.auth;

  const t0 = performance.now();
  const resp = await fetch(cfg.url, {
    method: "POST",
    mode: "cors",
    headers,
    body: JSON.stringify({
      question,
      contexts,
      ...(cfg.providerHint ? { provider: cfg.providerHint } : {}),
    }),
  }).catch(e => {
    // Network-layer failure — backend not running, CORS blocked, etc.
    const hint = settings.backend === "local-mcp"
      ? "Is `npm start` running in pursue-vision-mcp/?"
      : "Is the hosted backend URL correct and the service up?";
    throw new Error(`couldn't reach ${cfg.label} at ${cfg.url}: ${e.message}. ${hint}`);
  });

  if (!resp.ok) {
    let body = ""; try { body = await resp.text(); } catch {}
    throw new Error(`backend returned ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = await resp.json();
  if (json.error) throw new Error(`backend error: ${json.error}`);

  onStatus?.({ phase: "done" });
  return {
    answer: json.text,
    contexts,
    durationMs: Math.round(performance.now() - t0),
    provider: json.provider,
    model: json.model,
    backend: cfg.label,
  };
}

// Health check — used by the view's settings panel to give the user
// fast feedback on "is the backend reachable?" before they submit.
export async function checkBackend(settings) {
  const cfg = backendConfig(settings);
  if (!cfg.requiresUrl) return { ok: false, error: "backend URL required" };
  const healthUrl = cfg.url.replace(/\/ask$/, "/health");
  try {
    const r = await fetch(healthUrl, { mode: "cors" });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = await r.json();
    return { ok: !!j.ok, model: j.model };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Back-compat alias for the previous export name. Existing callers
// imported `checkDaemon`; keep both around so the rename can land in
// the same commit without a separate refactor PR.
export { checkBackend as checkDaemon };
