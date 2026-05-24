// =====================================================================
// RAG client. Wires the browser-side pieces of ASK's SMART mode:
//   (1) load embeddings.bin + MiniLM model (lazy, cached)
//   (2) embed the user question
//   (3) cosine-top-K against every stored vector
//   (4) POST the question + top-K passages to pursue-vision-mcp's /ask
//   (5) return { answer, contexts, durationMs, provider } to the view
//
// Step 4 talks to the user's local daemon. The daemon adds the prompt
// scaffold + calls the chosen logged-in browser tab (Claude/ChatGPT/
// Gemini) and streams back the text. We don't re-implement the LLM
// call here.
// =====================================================================
import { loadVectors, loadModel, embedQuery, topK } from "./embedClient.js";

// Status callbacks let the view show "embedding question…", "calling
// claude.ai…", etc. without us coupling to React state.
export async function askWithRag({ question, settings, onStatus }) {
  if (!question || !question.trim()) throw new Error("question required");
  if (!settings?.token) throw new Error("MCP token required (paste from ~/.pursue-vision-token)");
  if (!settings?.daemonUrl) throw new Error("daemon URL required");

  onStatus?.({ phase: "loading-vectors" });
  const [{ vectors, meta, info }] = await Promise.all([loadVectors()]);

  onStatus?.({ phase: "loading-model" });
  await loadModel();           // warm the in-memory cache; subsequent calls free

  onStatus?.({ phase: "embedding" });
  const qVec = await embedQuery(question);

  onStatus?.({ phase: "retrieving" });
  const K = Math.max(3, Math.min(32, Number(settings.k) || 10));
  const hits = topK(qVec, vectors, info.dim, info.count, K);

  // Hydrate each hit with its meta entry (snippet, eid, page, kind).
  // The snippet is ~200 chars — plenty for the LLM to ground on without
  // blowing past the upload size limit. For richer answers we could
  // fetch the full text/<eid>.txt page text here, but that multiplies
  // bytes-per-context by 10×; keep the simple snippet path for now.
  const contexts = hits.map(h => {
    const m = meta[h.idx] || {};
    return {
      eid: m.eventId, page: m.page, kind: m.kind,
      score: h.score,
      text: m.snippet || "",
    };
  });

  onStatus?.({ phase: "calling-daemon", provider: settings.provider, contextCount: contexts.length });

  const t0 = performance.now();
  const resp = await fetch(`${settings.daemonUrl.replace(/\/+$/, "")}/ask`, {
    method: "POST",
    mode: "cors",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.token}`,
    },
    body: JSON.stringify({
      question,
      contexts,
      provider: settings.provider || "claude",
    }),
  }).catch(e => {
    // Network-layer failure — daemon not running, CORS blocked, etc.
    throw new Error(`couldn't reach daemon at ${settings.daemonUrl}: ${e.message}. Is \`npm start\` running in pursue-vision-mcp/?`);
  });

  if (!resp.ok) {
    let body = ""; try { body = await resp.text(); } catch {}
    throw new Error(`daemon returned ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = await resp.json();
  if (json.error) throw new Error(`daemon error: ${json.error}`);

  onStatus?.({ phase: "done" });
  return {
    answer: json.text,
    contexts,
    durationMs: Math.round(performance.now() - t0),
    provider: json.provider,
  };
}

// Health check — used by the view's settings panel to give the user
// fast feedback on "is the daemon reachable?" before they submit a query.
export async function checkDaemon(settings) {
  if (!settings?.daemonUrl) return { ok: false, error: "daemon URL required" };
  try {
    const r = await fetch(`${settings.daemonUrl.replace(/\/+$/, "")}/health`, { mode: "cors" });
    if (!r.ok) return { ok: false, error: `daemon HTTP ${r.status}` };
    const j = await r.json();
    return { ok: !!j.ok };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
