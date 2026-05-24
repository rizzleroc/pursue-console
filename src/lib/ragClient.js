// =====================================================================
// RAG client. Wires the browser-side pieces of ASK's SMART mode:
//   (1) load embeddings.bin + MiniLM model (lazy, cached)
//   (2) embed the user question
//   (3) cosine-top-K against every stored vector
//   (4) synthesize an answer via the chosen backend
//   (5) return { answer, contexts, durationMs, provider } to the view
//
// Three backends:
//
//   in-browser → loadGenerator + generateAnswer in webllmClient.js.
//                Default — no server required. Model weights cached in
//                IndexedDB after first download.
//
//   hosted     → pursue-rag-server on Railway. URL from settings.hostedUrl.
//                Optional shared bearer from settings.hostedBearer. The
//                server calls Anthropic with the maintainer's API key.
//
//   local-mcp  → pursue-vision-mcp daemon on 127.0.0.1:9223. URL from
//                settings.daemonUrl. Bearer from settings.token. The
//                daemon routes through the user's logged-in Claude /
//                ChatGPT / Gemini browser tab.
// =====================================================================
import { loadVectors, loadModel, embedQuery, topK } from "./embedClient.js";

function backendConfig(settings) {
  if (settings.backend === "in-browser") {
    return {
      kind: "in-browser",
      label: "in-browser model",
      requiresUrl: false, requiresAuth: false,
    };
  }
  if (settings.backend === "local-mcp") {
    return {
      kind: "remote",
      url: (settings.daemonUrl || "").replace(/\/+$/, "") + "/ask",
      auth: settings.token ? `Bearer ${settings.token}` : null,
      requiresAuth: true,
      requiresUrl: !!settings.daemonUrl,
      label: "local MCP",
      providerHint: settings.provider || "claude",
    };
  }
  return {
    kind: "remote",
    url: (settings.hostedUrl || "").replace(/\/+$/, "") + "/ask",
    auth: settings.hostedBearer ? `Bearer ${settings.hostedBearer}` : null,
    requiresAuth: false,
    requiresUrl: !!settings.hostedUrl,
    label: "hosted",
    providerHint: undefined,    // server decides
  };
}

// Status callbacks let the view show "embedding question…", "calling
// backend…", etc. without us coupling to React state.
export async function askWithRag({ question, settings, onStatus, onModelProgress }) {
  if (!question || !question.trim()) throw new Error("question required");
  const cfg = backendConfig(settings);
  if (cfg.kind === "remote") {
    if (!cfg.requiresUrl) throw new Error("backend URL required");
    if (cfg.requiresAuth && !cfg.auth) {
      throw new Error("MCP bearer token required (paste from ~/.pursue-vision-token)");
    }
  }

  onStatus?.({ phase: "loading-vectors" });
  const [{ vectors, meta, info }] = await Promise.all([loadVectors()]);

  onStatus?.({ phase: "loading-embed-model" });
  await loadModel();           // MiniLM, ~25 MB — separate from the chat LLM

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

  const t0 = performance.now();
  let result;
  if (cfg.kind === "in-browser") {
    onStatus?.({ phase: "calling-backend", backend: cfg.label, contextCount: contexts.length });
    // Dynamic import keeps the text-generation pipeline out of the
    // hot path when the user picks a remote backend. transformers.js
    // is already in the chunk graph via embedClient; this just adds
    // the generation head.
    const { generateAnswer } = await import("./webllmClient.js");
    const out = await generateAnswer({
      question, contexts,
      modelId: settings.modelId,
      onStatus,
      onProgress: onModelProgress,
    });
    result = {
      answer: out.text,
      provider: "in-browser",
      model: out.model,
    };
  } else {
    onStatus?.({ phase: "calling-backend", backend: cfg.label, contextCount: contexts.length });
    const headers = { "Content-Type": "application/json" };
    if (cfg.auth) headers["Authorization"] = cfg.auth;
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
    result = {
      answer: json.text,
      provider: json.provider,
      model: json.model,
    };
  }

  onStatus?.({ phase: "done" });
  return {
    ...result,
    contexts,
    durationMs: Math.round(performance.now() - t0),
    backend: cfg.label,
  };
}

// Health check — used by the view's settings panel to give the user
// fast feedback on "is the backend reachable?" before they submit.
// The in-browser backend reports OK iff transformers.js itself loaded
// (which it must have, since we got here); the model isn't fetched
// until the user actually asks something.
export async function checkBackend(settings) {
  const cfg = backendConfig(settings);
  if (cfg.kind === "in-browser") {
    return { ok: true, model: settings.modelId };
  }
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
