import React, { useEffect, useMemo, useState, useRef } from "react";
import { pipeline, env } from "@huggingface/transformers";
import { EVENTS, AGENCY_COLORS } from "../data/events.js";
import { GlitchText, DocTypeBadge, flagBg } from "../components/Primitives.jsx";

// =====================================================================
// SEMANTIC SEARCH — dense-vector search over the corpus.
//
// Build side (Python): scripts/build-embeddings.py — sentence-transformers
//   /all-MiniLM-L6-v2 encodes every page chunk + every event-meta blob,
//   L2-normalizes, exports raw float32 binary + metadata JSON.
//
// Runtime: load the same model via @huggingface/transformers (INT8
// quantized, ~25 MB, cached in IndexedDB after first download), embed
// the query, brute-force cosine against the stored vectors.
// At 1057 vectors × 384 dim the search is < 5 ms.
// =====================================================================

const MODEL = "Xenova/all-MiniLM-L6-v2";
const eventById = Object.fromEntries(EVENTS.map(e => [e.id, e]));

// Make transformers.js fetch from a CDN; we don't ship the model weights.
env.allowLocalModels = false;
env.useBrowserCache = true;

// ORT ships 8 wasm/mjs variants — Vite only bundles whichever one its static
// analysis happens to resolve, so on GH Pages the loader 404s the others
// (jsep, jspi, plain simd-threaded). Pin the WASM root to a CDN so every
// variant is reachable. The actual model weights still come from HF Hub.
const ORT_VERSION = "1.22.0";
env.backends.onnx.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
// Single-threaded keeps us away from cross-origin-isolation requirements
// (GH Pages doesn't send COOP/COEP headers).
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

// ---- one-time loaders (module-level cache) ----
let _vectorsP = null;
function loadVectors() {
  if (!_vectorsP) {
    _vectorsP = Promise.all([
      fetch(`${import.meta.env.BASE_URL}embeddings.bin`).then(r => r.arrayBuffer()),
      fetch(`${import.meta.env.BASE_URL}embeddings-meta.json`).then(r => r.json()),
      fetch(`${import.meta.env.BASE_URL}embeddings-info.json`).then(r => r.json()),
    ]).then(([buf, meta, info]) => {
      const vectors = new Float32Array(buf);
      if (vectors.length !== info.count * info.dim) throw new Error(`size mismatch ${vectors.length} vs ${info.count}*${info.dim}`);
      return { vectors, meta, info };
    });
  }
  return _vectorsP;
}

let _modelP = null;
function loadModel(onProgress) {
  if (!_modelP) {
    _modelP = pipeline("feature-extraction", MODEL, {
      // transformers.js v3+: `quantized: true` was replaced by `dtype`.
      // q8 keeps the model small (~25 MB) and runs cleanly on CPU+wasm.
      dtype: "q8",
      device: "wasm",
      progress_callback: onProgress,
    }).catch(err => {
      _modelP = null;        // allow retries after a failed first load
      throw err;
    });
  }
  return _modelP;
}

function topK(qVec, vectors, dim, count, K = 30) {
  // vectors is N*dim float32, already L2-normalized.
  // qVec is dim float32, normalize then dot product.
  let norm = 0; for (let i = 0; i < dim; i++) norm += qVec[i] * qVec[i];
  norm = Math.sqrt(norm) || 1;
  const q = new Float32Array(dim);
  for (let i = 0; i < dim; i++) q[i] = qVec[i] / norm;
  // Min-heap of size K (track lowest of the top-K)
  const scores = new Float32Array(K).fill(-Infinity);
  const idxs = new Int32Array(K).fill(-1);
  let minScore = -Infinity, minPos = 0;
  for (let r = 0; r < count; r++) {
    let s = 0;
    const base = r * dim;
    for (let i = 0; i < dim; i++) s += vectors[base + i] * q[i];
    if (s > minScore) {
      scores[minPos] = s; idxs[minPos] = r;
      // recompute min
      minScore = scores[0]; minPos = 0;
      for (let i = 1; i < K; i++) if (scores[i] < minScore) { minScore = scores[i]; minPos = i; }
    }
  }
  const out = [];
  for (let i = 0; i < K; i++) if (idxs[i] >= 0) out.push({ idx: idxs[i], score: scores[i] });
  out.sort((a, b) => b.score - a.score);
  return out;
}

function highlightQuery(text, qTerms) {
  if (!qTerms.length) return text;
  try {
    const safe = qTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const re = new RegExp(`(${safe})`, "ig");
    return text.split(re).map((s, i) =>
      re.test(s) ? <mark key={i} className="bg-amber-400/40 text-amber-100 px-0.5 rounded-sm">{s}</mark> : <span key={i}>{s}</span>
    );
  } catch { return text; }
}

const SAMPLE_QUERIES = [
  "object that materialized and disappeared instantly",
  "intelligent life on other planets",
  "instrument readings inconsistent with conventional aircraft",
  "object visible only through a single sensor modality",
  "witness saw a craft hovering then accelerating away",
  "swarm of lights moving in formation",
  "what happened during the 1952 Washington flap",
  "objects making 90-degree turns over water",
  "policy decisions if alien intelligence is confirmed",
  "operator unable to positively identify the contact",
];

export default function SemanticSearchView({ onSelect }) {
  const [query, setQuery] = useState("");
  const [committed, setCommitted] = useState("");      // query that triggered last search
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  const [vecLoaded, setVecLoaded] = useState(false);
  const [vecState, setVecState] = useState(null);      // { vectors, meta, info }
  const [modelLoading, setModelLoading] = useState(false);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [progress, setProgress] = useState(null);      // { file, status, progress }
  const [searching, setSearching] = useState(false);
  const embedderRef = useRef(null);

  // Load vectors immediately (small)
  useEffect(() => {
    loadVectors()
      .then(state => { setVecState(state); setVecLoaded(true); })
      .catch(e => setError(`Failed to load embeddings: ${e.message}`));
  }, []);

  async function ensureModel() {
    if (embedderRef.current) return embedderRef.current;
    setModelLoading(true);
    setProgress({ status: "downloading", file: MODEL, progress: 0 });
    try {
      const pipe = await loadModel(p => { setProgress(p); });
      embedderRef.current = pipe;
      setModelLoaded(true);
      return pipe;
    } finally {
      setModelLoading(false);
    }
  }

  async function runSearch(q) {
    setError(null);
    if (!q.trim()) { setResults(null); return; }
    if (!vecState) { setError("Vectors not yet loaded"); return; }
    setSearching(true);
    setCommitted(q);
    try {
      const pipe = await ensureModel();
      const output = await pipe(q, { pooling: "mean", normalize: true });
      const qVec = output.data; // Float32Array
      const t0 = performance.now();
      const hits = topK(qVec, vecState.vectors, vecState.info.dim, vecState.info.count, 40);
      const elapsedMs = performance.now() - t0;
      // Group by eventId, keep best hit per event but remember all pages
      const groups = new Map();
      for (const h of hits) {
        const m = vecState.meta[h.idx];
        if (!m) continue;
        const ev = eventById[m.eventId];
        if (!ev) continue;
        if (!groups.has(m.eventId)) groups.set(m.eventId, { event: ev, best: h.score, hits: [] });
        const g = groups.get(m.eventId);
        if (h.score > g.best) g.best = h.score;
        g.hits.push({ ...h, page: m.page, kind: m.kind, snippet: m.snippet });
      }
      const grouped = Array.from(groups.values()).sort((a, b) => b.best - a.best).slice(0, 12);
      setResults({ grouped, elapsedMs });
    } catch (e) {
      console.error("[semantic] search failed:", e);
      setError({
        msg: e.message || String(e),
        stack: e.stack ? e.stack.split("\n").slice(0, 4).join("\n") : null,
      });
    } finally {
      setSearching(false);
    }
  }

  const qTerms = useMemo(() => committed.toLowerCase().split(/\s+/).filter(t => t.length >= 3), [committed]);

  const onSubmit = (e) => { e?.preventDefault?.(); runSearch(query); };

  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]"><GlitchText>┃ SEMANTIC</GlitchText></h2>
        <div className="font-mono text-[10px] text-emerald-700">
          DENSE VECTORS · {vecState ? `${vecState.info.count} CHUNKS · ${vecState.info.dim}D · MINI-LM` : "LOADING…"}
        </div>
      </div>

      <form onSubmit={onSubmit} className="mb-3">
        <input value={query} onChange={e => setQuery(e.target.value)} autoFocus
          placeholder="› describe the pattern you're looking for, not just keywords…"
          className="w-full bg-black/60 border border-emerald-700/50 rounded-sm px-3 py-2 text-emerald-200 placeholder-emerald-700 font-mono text-sm focus:outline-none focus:border-amber-400 focus:shadow-[0_0_8px_rgba(255,217,61,0.4)]" />
        <div className="font-mono text-[10px] text-emerald-700 mt-1.5">
          Press <span className="text-amber-300">Enter</span> to search. First query downloads a ~25MB model once.
        </div>
      </form>

      {/* Sample queries */}
      {!results && !modelLoading && (
        <div className="mb-4">
          <div className="font-mono text-[9px] text-emerald-700 tracking-widest mb-2">▌ TRY A CONCEPTUAL QUERY</div>
          <div className="flex flex-wrap gap-1.5">
            {SAMPLE_QUERIES.map(q => (
              <button key={q} onClick={() => { setQuery(q); runSearch(q); }}
                className="px-2 py-1 rounded-sm font-mono text-[11px] bg-emerald-950/60 text-emerald-300 hover:bg-emerald-900/80 border border-emerald-700/40 text-left">
                "{q}"
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Model load progress */}
      {(modelLoading || (searching && !modelLoaded)) && (
        <div className="mb-4 border border-amber-400/50 bg-amber-400/5 rounded-sm p-3 font-mono text-[11px] text-amber-200">
          <div className="text-amber-400 tracking-widest mb-1">▌ DOWNLOADING MODEL (one-time, cached afterwards)</div>
          <div className="text-emerald-400">{progress?.file || MODEL}</div>
          {progress?.progress != null && (
            <div className="mt-2 h-1.5 bg-emerald-950 rounded-full overflow-hidden">
              <div className="h-full bg-amber-400 transition-all" style={{ width: `${Math.round(progress.progress || 0)}%` }} />
            </div>
          )}
          {progress?.status && <div className="text-[10px] text-emerald-600 mt-1">{progress.status} {progress.loaded ? `· ${(progress.loaded/1024/1024).toFixed(1)}/${(progress.total/1024/1024).toFixed(1)} MB` : ""}</div>}
        </div>
      )}

      {error && (
        <div className="border border-rose-400/40 bg-rose-400/5 rounded-sm p-3 font-mono text-[11px] text-rose-300 mb-4 space-y-1">
          <div className="text-rose-200 tracking-widest">⊘ SEMANTIC SEARCH FAILED</div>
          <div className="break-words">{typeof error === "string" ? error : error.msg}</div>
          {error?.stack && (
            <pre className="text-[10px] text-rose-400/80 mt-2 whitespace-pre-wrap leading-tight">{error.stack}</pre>
          )}
          <div className="text-[10px] text-emerald-700 pt-2">
            Open the browser console for the full stack trace. If this is the first time you tried semantic search and the model download timed out, retry — files are cached after success.
          </div>
        </div>
      )}

      {searching && modelLoaded && (
        <div className="font-mono text-[11px] text-emerald-500 mb-3">⏳ embedding query and ranking 1,057 chunks…</div>
      )}

      {results && results.grouped.length === 0 && (
        <div className="font-mono text-[12px] text-emerald-700 py-8 text-center">No semantically similar passages found.</div>
      )}

      {results && results.grouped.length > 0 && (
        <div>
          <div className="font-mono text-[10px] text-emerald-700 tracking-widest mb-3 flex items-center gap-3">
            <span>▌ {results.grouped.length} RECORDS · TOP COSINE = {results.grouped[0].best.toFixed(3)} · {results.elapsedMs.toFixed(1)} MS</span>
          </div>
          <div className="space-y-3">
            {results.grouped.map(({ event, best, hits }) => {
              const color = AGENCY_COLORS[event.agency] || "#7CFFB2";
              // dedupe pages
              const pageHits = [...new Map(hits.map(h => [h.page, h])).values()].sort((a, b) => b.score - a.score).slice(0, 4);
              return (
                <div key={event.id}
                  className={`rounded-sm border-l-2 ${flagBg(event.flag)} border p-3`}
                  style={{ borderLeftColor: color }}>
                  <button onClick={() => onSelect(event)} className="text-left w-full">
                    <div className="flex items-baseline justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] tracking-wider" style={{ color }}>
                          {event.agency.replace("Department of ","DEPT/")}
                        </span>
                        <DocTypeBadge docType={event.docType} />
                        {event.flag === "anchor" && <span className="text-amber-400 text-[10px]">▲</span>}
                      </div>
                      <div className="flex items-center gap-3 font-mono text-[10px]">
                        <span className="text-amber-300">{event.date}</span>
                        <span className="text-emerald-500 tracking-widest">cos {best.toFixed(3)}</span>
                      </div>
                    </div>
                    <div className="font-mono text-emerald-100 text-[14px] mt-1 leading-snug">
                      {highlightQuery(event.title, qTerms)}
                    </div>
                  </button>
                  {pageHits.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      {pageHits.map((h, i) => (
                        <div key={i} className="border-l border-emerald-700/30 pl-2.5 font-mono text-[11px] text-emerald-300/90 leading-relaxed">
                          <span className="text-amber-400/80 text-[9px] tracking-widest mr-2">
                            {h.kind === "meta" ? "SUMMARY" : `PAGE ${h.page}`}
                            <span className="ml-2 text-emerald-700">cos {h.score.toFixed(3)}</span>
                          </span>
                          {highlightQuery(h.snippet, qTerms)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
