import React, { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { pipeline, env } from "@huggingface/transformers";
import { EVENTS, AGENCY_COLORS, RELEASES_LABEL } from "../data/events.js";
import { GlitchText, DocTypeBadge, flagBg } from "../components/Primitives.jsx";
import { ingestFile, listDocs, deleteDoc, clearAll, loadAllChunks } from "../lib/dropCorpus.js";
import { highlightQuery } from "../lib/highlightQuery.jsx";
import useCorpusStats from "../hooks/useCorpusStats.js";

// Fallback inventory total — only used if public/corpus-stats.json hasn't
// loaded yet (or 404s on dev). The real number comes from the corpus DB
// (scripts/db-rebuild.mjs writes corpus-stats.json on every build).
const INVENTORY_TOTAL_FALLBACK = 173;

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
// The index holds a few thousand 384-dim vectors (see embeddings-info.json
// for the live count); brute-force cosine over them is < 5 ms.
// =====================================================================

const MODEL = "Xenova/all-MiniLM-L6-v2";
const eventById = Object.fromEntries(EVENTS.map(e => [e.id, e]));

// Make transformers.js fetch from a CDN; we don't ship the model weights.
env.allowLocalModels = false;
env.useBrowserCache = true;

// ORT ships 8 wasm/mjs variants — Vite only bundles whichever one its
// static analysis happens to resolve at build time, so on GH Pages the
// loader 404s the others (jsep, jspi, plain simd-threaded, asyncify…).
// Self-host every variant from node_modules/onnxruntime-web/dist/ —
// scripts/copy-ort-assets.mjs runs in npm `build` and drops them into
// public/ort/, deployed alongside the app.
env.backends.onnx.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`;
// Single-threaded keeps us away from cross-origin-isolation requirements
// (GH Pages doesn't send COOP/COEP headers).
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

// ---- one-time loaders (module-level cache) ----
let _vectorsP = null;
// forceBust=true bypasses module + HTTP cache so the LIVE-deployed index is
// reread (every batch ships a fresh embeddings.bin; without bust the browser
// keeps serving the stale one).
function loadVectors(forceBust = false) {
  if (forceBust || !_vectorsP) {
    const t = forceBust ? `?t=${Date.now()}` : "";
    _vectorsP = Promise.all([
      fetch(`${import.meta.env.BASE_URL}embeddings.bin${t}`, { cache: forceBust ? "reload" : "default" }).then(r => r.arrayBuffer()),
      fetch(`${import.meta.env.BASE_URL}embeddings-meta.json${t}`).then(r => r.json()),
      fetch(`${import.meta.env.BASE_URL}embeddings-info.json${t}`).then(r => r.json()),
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
      // transformers.js v4 dtype → file mapping is { q8 → model_q8.onnx,
      // int8 → model_int8.onnx, … }. Xenova/all-MiniLM-L6-v2 ships
      // model_int8.onnx but NOT model_q8.onnx — so dtype:"q8" 404s the
      // model file silently and the loader 'no available backend found'.
      // int8 gets us the same ~25 MB quantized weights, just from a file
      // that actually exists.
      dtype: "int8",
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

// HYBRID SCORING.
//
// MiniLM cosine top-outs around 0.5 for short keyword queries ('area 51')
// because the model needs sentence-level context to differentiate. Pure
// cosine therefore can't separate a real literal match from any other
// thematically-adjacent chunk — they all land in the 0.4-0.5 band.
//
// Solution: combine cosine with a literal-match boost.
//   • exact phrase substring  → +0.50  (essentially marks the result EXACT)
//   • all-query-tokens present → +0.20 (probably-relevant)
//   • any-token present        → +0.05 per token, capped at +0.15
//
// Boost is computed against snippet + title + agency string when available.
// The numbers are chosen so a true literal hit beats a thematic-only hit at
// any reasonable cosine value, but a strong cosine match without literal
// support still appears for genuinely semantic queries.
function literalBoost(query, hayText) {
  if (!query || !hayText) return 0;
  const q = query.toLowerCase().trim();
  const h = hayText.toLowerCase();
  const tokens = q.split(/\s+/).filter(t => t.length >= 2);
  let boost = 0;
  // exact substring of the whole query
  if (q.length >= 3 && h.includes(q)) boost += 0.50;
  // word-boundary match of the whole query as a phrase
  else {
    try {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${safe}\\b`).test(h)) boost += 0.40;
    } catch {}
  }
  if (boost > 0) return Math.min(boost, 0.55);
  // partial credit: token coverage
  let hits = 0;
  for (const t of tokens) {
    if (t.length < 2) continue;
    if (h.includes(t)) hits++;
  }
  if (tokens.length && hits === tokens.length) boost += 0.20;
  else if (hits > 0) boost += Math.min(0.05 * hits, 0.15);
  return boost;
}

// Strength bands map a hybrid score to a visible quality label.
function strengthBand(final) {
  if (final >= 0.85) return { label: "EXACT",  pct: 100, color: "#7CFFB2", glyph: "●●●●" };
  if (final >= 0.65) return { label: "STRONG", pct: 80,  color: "#FFD93D", glyph: "●●●○" };
  if (final >= 0.50) return { label: "MEDIUM", pct: 60,  color: "#82B6FF", glyph: "●●○○" };
  if (final >= 0.40) return { label: "WEAK",   pct: 40,  color: "#B794F4", glyph: "●○○○" };
  return                    { label: "NOISE",  pct: 20,  color: "#FF6B9D", glyph: "○○○○" };
}

// highlightQuery lives in src/lib/highlightQuery.jsx so DossierView can
// reuse it when rendering search-deep-link banners.

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

export default function SemanticSearchView({ onSelect, headerFilters }) {
  // Pre-seed from the Header's search box. SEMANTIC needs the user to
  // click Search (it's an expensive vector search), so we only update
  // the input — we don't auto-trigger a query.
  const [query, setQuery] = useState(headerFilters?.query || "");
  useEffect(() => {
    if ((headerFilters?.query ?? "") !== query) setQuery(headerFilters?.query || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerFilters?.query]);
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

  // User-dropped corpus (IndexedDB-backed, ephemeral to this browser)
  const [droppedDocs, setDroppedDocs] = useState([]);
  const [droppedVecs, setDroppedVecs] = useState({ vectors: new Float32Array(0), meta: [], dim: 384 });
  const [ingestProgress, setIngestProgress] = useState(null);
  const [ingestQueue, setIngestQueue] = useState([]);   // [{ name, status, chunks }]
  const [dragOver, setDragOver] = useState(false);
  // Hide WEAK / NOISE matches by default — they're the bulk of the "why is
  // this in my results?" noise on keyword queries.
  const [showWeak, setShowWeak] = useState(false);

  // First-load: list dropped docs + load their vectors
  const refreshDropped = useCallback(async () => {
    const [docs, packed] = await Promise.all([listDocs(), loadAllChunks()]);
    setDroppedDocs(docs);
    setDroppedVecs(packed);
  }, []);
  useEffect(() => { refreshDropped(); }, [refreshDropped]);

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
      const dim = vecState.info.dim;

      // Score static + dropped vectors against the same query
      const staticHitsByCos = topK(qVec, vecState.vectors, dim, vecState.info.count, 40);
      const droppedHitsByCos = droppedVecs.meta.length
        ? topK(qVec, droppedVecs.vectors, dim, droppedVecs.meta.length, 40)
        : [];

      // ALSO: full-corpus literal scan. MiniLM's cosine doesn't reliably
      // rank short keyword queries (e.g. 'john lear') because 2 tokens
      // give little context to embed against. Without a separate literal
      // pass, a chunk whose snippet literally contains 'john lear' never
      // shows up unless it happens to land in the top-40 cosine slots,
      // which it usually doesn't. So we scan every snippet for literal
      // substring / word matches, score those with cos=0 + boost, then
      // union with the cosine candidates. This is the proper hybrid
      // retrieval pattern; the previous version only boosted cosine hits.
      const ql = q.toLowerCase().trim();
      const literalStatic = [];
      if (ql.length >= 3) {
        const cosIdxSet = new Set(staticHitsByCos.map(h => h.idx));
        for (let i = 0; i < vecState.meta.length; i++) {
          if (cosIdxSet.has(i)) continue;
          const m = vecState.meta[i];
          const hay = (m.snippet || "").toLowerCase();
          if (hay.includes(ql)) literalStatic.push({ idx: i, score: 0 });
          if (literalStatic.length >= 80) break;
        }
      }
      const literalDropped = [];
      if (ql.length >= 3 && droppedVecs.meta.length) {
        const cosIdxSet = new Set(droppedHitsByCos.map(h => h.idx));
        for (let i = 0; i < droppedVecs.meta.length; i++) {
          if (cosIdxSet.has(i)) continue;
          const m = droppedVecs.meta[i];
          const hay = (m.snippet || "").toLowerCase();
          if (hay.includes(ql)) literalDropped.push({ idx: i, score: 0 });
          if (literalDropped.length >= 40) break;
        }
      }
      const staticHits  = [...staticHitsByCos,  ...literalStatic ].map(h => ({ ...h, source: "official" }));
      const droppedHits = [...droppedHitsByCos, ...literalDropped].map(h => ({ ...h, source: "dropped" }));
      const elapsedMs = performance.now() - t0;

      // Apply hybrid literal-boost to each hit.
      // Haystack = snippet + (for official) event title + agency.
      const scoreHit = (hit, hay) => {
        const boost = literalBoost(q, hay);
        return { ...hit, cos: hit.score, boost, final: hit.score + boost };
      };

      // Group by record (event id for static, docId for dropped)
      const groups = new Map();
      for (const h of staticHits) {
        const m = vecState.meta[h.idx];
        if (!m) continue;
        const ev = eventById[m.eventId];
        if (!ev) continue;
        const hay = `${m.snippet || ""} ${ev.title} ${ev.agency || ""} ${(ev.tags || []).join(" ")}`;
        const sh = scoreHit(h, hay);
        const key = `official:${m.eventId}`;
        if (!groups.has(key)) groups.set(key, { kind: "official", event: ev, best: sh.final, bestCos: sh.cos, hits: [] });
        const g = groups.get(key);
        if (sh.final > g.best) { g.best = sh.final; g.bestCos = sh.cos; }
        g.hits.push({ ...sh, page: m.page, snippet: m.snippet, chunkKind: m.kind, chunkSource: m.source, chunkQuality: m.quality });
      }
      for (const h of droppedHits) {
        const m = droppedVecs.meta[h.idx];
        if (!m) continue;
        const sh = scoreHit(h, `${m.snippet || ""} ${m.docName || ""}`);
        const key = `dropped:${m.docId}`;
        if (!groups.has(key)) groups.set(key, { kind: "dropped", docName: m.docName, docId: m.docId, best: sh.final, bestCos: sh.cos, hits: [] });
        const g = groups.get(key);
        if (sh.final > g.best) { g.best = sh.final; g.bestCos = sh.cos; }
        g.hits.push({ ...sh, page: m.page, snippet: m.snippet });
      }
      // Within each group: drop curated meta-chunks if there's any body-chunk
      // hit that beats them — meta-only matches are noisy on keyword queries.
      for (const g of groups.values()) {
        const hasBodyHit = g.hits.some(h => h.chunkKind !== "meta");
        if (hasBodyHit) g.hits = g.hits.filter(h => h.chunkKind !== "meta");
        g.hits.sort((a, b) => b.final - a.final);
      }
      // Filter: hide groups whose best final score is below the WEAK floor.
      // (the UI still has a toggle to surface them when the user wants noise.)
      const allGroups = Array.from(groups.values()).sort((a, b) => b.best - a.best);
      setResults({
        grouped: allGroups,
        elapsedMs,
        staticChunks: vecState.info.count,
        droppedChunks: droppedVecs.meta.length,
      });
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

  // ---- drag + drop ingestion ----
  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter(f => /\.(pdf|txt|md)$/i.test(f.name));
    if (!files.length) { setError({ msg: "Drop PDF or .txt files only.", stack: null }); return; }
    setError(null);
    let pipe;
    try { pipe = await ensureModel(); }
    catch (e) { setError({ msg: "Model load failed before ingest: " + (e.message || e), stack: e.stack?.split("\n").slice(0,3).join("\n") }); return; }

    const queue = files.map(f => ({ name: f.name, status: "queued", chunks: 0 }));
    setIngestQueue(queue);

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setIngestQueue(q => q.map((r, j) => j === i ? { ...r, status: "running" } : r));
      try {
        const res = await ingestFile(f, pipe, p => setIngestProgress({ idx: i, ...p }));
        setIngestQueue(q => q.map((r, j) => j === i ? { ...r, status: res.skipped ? "exists" : "done", chunks: res.chunkCount } : r));
      } catch (e) {
        console.error("[ingest]", f.name, e);
        setIngestQueue(q => q.map((r, j) => j === i ? { ...r, status: "error", error: e.message || String(e) } : r));
      }
    }
    setIngestProgress(null);
    await refreshDropped();
  }

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  };
  const onDragOver = (e) => { e.preventDefault(); setDragOver(true); };
  const onDragLeave = (e) => { e.preventDefault(); setDragOver(false); };

  async function onRemoveDropped(docId) {
    await deleteDoc(docId);
    await refreshDropped();
  }
  async function onClearAllDropped() {
    if (!confirm("Remove all dropped documents from your browser?")) return;
    await clearAll();
    await refreshDropped();
  }

  // Coverage numbers — derives from the DB stats when loaded.
  const { stats } = useCorpusStats();
  const coverage = useMemo(() => {
    const inventoryTotal = stats?.inventory?.total ?? INVENTORY_TOTAL_FALLBACK;
    const catalogued = stats?.events?.catalogued ?? EVENTS.length;
    const withText = vecState ? new Set(vecState.meta.map(m => m.eventId)).size : 0;
    return {
      inventoryTotal,
      catalogued,
      withText,
      missingFromCatalog: stats?.gap?.uncataloguedRecords ?? Math.max(0, inventoryTotal - catalogued),
      droppedDocs: droppedDocs.length,
      droppedChunks: droppedVecs.meta.length,
      staticChunks: vecState?.info.count || 0,
    };
  }, [vecState, droppedDocs, droppedVecs, stats]);

  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]"><GlitchText>┃ SEMANTIC</GlitchText></h2>
        <div className="font-mono text-[10px] text-emerald-700 flex items-center gap-3 flex-wrap">
          {vecState ? (
            <>
              <span>DENSE VECTORS · {(vecState.info.count + droppedVecs.meta.length).toLocaleString()} CHUNKS · {vecState.info.dim}D · MINI-LM</span>
              {vecState.info.generatedAt && (
                <span className="text-emerald-600">INDEX GEN {vecState.info.generatedAt.slice(0, 16).replace("T", " ")}</span>
              )}
              <button onClick={async () => {
                setVecLoaded(false); setVecState(null);
                _vectorsP = null;
                try {
                  const next = await loadVectors(true);
                  setVecState(next); setVecLoaded(true);
                } catch (e) { setError({ msg: e.message, stack: null }); }
              }}
                style={{ transition: "all 150ms cubic-bezier(0.23,1,0.32,1)" }}
                className="px-2 py-0.5 rounded-sm border border-emerald-700/50 text-emerald-400 hover:border-amber-400 hover:text-amber-300 tracking-widest active:scale-[0.97]">
                ↻ REFRESH INDEX
              </button>
            </>
          ) : "LOADING…"}
        </div>
      </div>

      {/* COVERAGE STRIPS — two halves: repo scope above, FAISS scope below */}
      <div className="mb-4 space-y-3">
        {/* REPO SCOPE */}
        <div className="border border-emerald-700/40 bg-black/40 rounded-sm p-3 font-mono text-[11px]">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-2">
            <div className="text-emerald-700 tracking-widest text-[9px]">▌ REPOSITORY SCOPE — {RELEASES_LABEL.toUpperCase()}</div>
            {coverage.droppedDocs > 0 && (
              <button onClick={onClearAllDropped} className="text-[9px] text-rose-400 hover:text-rose-200 tracking-widest">CLEAR DROPPED ({coverage.droppedDocs})</button>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-emerald-200">
            <div>
              <div className="text-[9px] text-emerald-700 tracking-widest">INVENTORY</div>
              <div className="text-amber-300 text-base">{coverage.inventoryTotal}</div>
              <div className="text-[9px] text-emerald-600">records on war.gov</div>
            </div>
            <div>
              <div className="text-[9px] text-emerald-700 tracking-widest">CATALOGUED</div>
              <div className="text-emerald-200 text-base">{coverage.catalogued}</div>
              <div className="text-[9px] text-emerald-600">events in this repo</div>
            </div>
            <div>
              <div className="text-[9px] text-emerald-700 tracking-widest">INDEXED</div>
              <div className="text-emerald-200 text-base">{coverage.withText} <span className="text-[9px] text-emerald-700">events</span></div>
              <div className="text-[9px] text-emerald-600">have searchable text</div>
            </div>
            <div>
              <div className="text-[9px] text-emerald-700 tracking-widest">YOU ADDED</div>
              <div className={coverage.droppedDocs > 0 ? "text-amber-300 text-base" : "text-emerald-700 text-base"}>
                {coverage.droppedDocs} <span className="text-[9px] text-emerald-700">→ {coverage.droppedChunks.toLocaleString()} chunks</span>
              </div>
              <div className="text-[9px] text-emerald-600">local-only, this browser</div>
            </div>
            <div>
              <div className="text-[9px] text-emerald-700 tracking-widest">AWAITING</div>
              <div className="text-rose-300 text-base">{Math.max(0, coverage.inventoryTotal - coverage.catalogued)}</div>
              <div className="text-[9px] text-emerald-600">records to catalogue</div>
            </div>
          </div>
        </div>

        {/* FAISS INDEX SCOPE — what's actually queryable, broken down by source */}
        {vecState && (() => {
          const total = vecState.info.count + droppedVecs.meta.length;
          const bs = vecState.info.bySource || {};
          const rejected = (vecState.info.rejectedByQuality?.ocr || 0) + (vecState.info.rejectedByQuality?.pdfjs || 0);
          const gen = vecState.info.generatedAt ? new Date(vecState.info.generatedAt) : null;
          const ago = gen ? Math.max(0, (Date.now() - gen.getTime()) / 1000) : null;
          const agoStr = ago == null ? "—"
            : ago < 60 ? `${Math.round(ago)}s ago`
            : ago < 3600 ? `${Math.round(ago/60)}m ago`
            : ago < 86400 ? `${Math.round(ago/3600)}h ago`
            : `${Math.round(ago/86400)}d ago`;
          // Build the per-source bar visualization
          const bars = [
            { key: "vision",  label: "VISION",     color: "#82B6FF", note: "GPT-transcribed" },
            { key: "pdfjs",   label: "TEXT-LAYER", color: "#7CFFB2", note: "pdfjs clean" },
            { key: "ocr",     label: "TESSERACT",  color: "#FFD93D", note: "noisier, queued for vision" },
            { key: "curated", label: "CURATED",    color: "#B794F4", note: "hand-written summaries" },
          ].map(b => ({ ...b, count: bs[b.key]?.count || 0, q: bs[b.key]?.meanQuality }));
          const sumChunks = bars.reduce((s, b) => s + b.count, 0) || 1;
          return (
            <div className="border border-cyan-700/40 bg-cyan-950/10 rounded-sm p-3 font-mono text-[11px]">
              <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
                <div className="text-cyan-400/80 tracking-widest text-[9px]">▌ FAISS INDEX · {total.toLocaleString()} chunks · {vecState.info.dim}D Mini-LM</div>
                <div className="flex items-center gap-3">
                  <span className="text-emerald-700 text-[9px] tracking-widest">{agoStr}</span>
                  <button onClick={async () => {
                    setVecLoaded(false); setVecState(null);
                    _vectorsP = null;
                    try { const next = await loadVectors(true); setVecState(next); setVecLoaded(true); }
                    catch (e) { setError({ msg: e.message, stack: null }); }
                  }}
                    style={{ transition: "all 150ms cubic-bezier(0.23,1,0.32,1)" }}
                    className="px-2 py-0.5 rounded-sm border border-cyan-700/50 text-cyan-300 hover:border-amber-400 hover:text-amber-300 tracking-widest text-[10px] active:scale-[0.97]">
                    ↻ REFRESH FAISS
                  </button>
                </div>
              </div>

              {/* Stacked horizontal bar */}
              <div className="h-2 flex rounded-sm overflow-hidden mb-3 bg-emerald-950">
                {bars.map(b => b.count > 0 && (
                  <div key={b.key}
                    title={`${b.label} · ${b.count} chunks · ${Math.round(b.count/sumChunks*100)}%`}
                    style={{ width: `${(b.count / sumChunks) * 100}%`, backgroundColor: b.color }} />
                ))}
              </div>

              {/* Per-source legend */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {bars.map(b => (
                  <div key={b.key} className="flex items-baseline gap-2">
                    <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: b.color }} />
                    <div className="min-w-0">
                      <div className="tracking-widest text-[9px]" style={{ color: b.color }}>{b.label}</div>
                      <div className="text-emerald-200 text-[11px] tabular-nums">
                        {b.count.toLocaleString()}
                        {b.q != null && <span className="text-emerald-700 ml-1 text-[9px]">q {b.q.toFixed(2)}</span>}
                      </div>
                      <div className="text-[9px] text-emerald-600">{b.note}</div>
                    </div>
                  </div>
                ))}
              </div>

              {rejected > 0 && (
                <div className="mt-3 pt-2 border-t border-emerald-700/20 text-[10px] text-emerald-600">
                  <span className="text-rose-400 tracking-widest text-[9px] mr-2">QUALITY-FILTERED</span>
                  {rejected} chunks dropped below q≥{vecState.info.minQuality} (the tesseract noise band) before reaching the index.
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* DROP ZONE */}
      <div
        onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}
        className={`mb-4 border-2 border-dashed rounded-sm p-4 transition-all ${dragOver
          ? "border-amber-400 bg-amber-400/10"
          : "border-emerald-700/40 bg-emerald-950/30 hover:border-emerald-500/60"}`}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="font-mono text-[11px] text-emerald-300 tracking-widest">▤ DROP PDFs OR .TXT FILES HERE</div>
            <div className="font-mono text-[10px] text-emerald-600 mt-0.5">
              Files stay in your browser — extracted with pdfjs, embedded with the same Mini-LM model, persisted to IndexedDB. Nothing leaves your machine.
            </div>
          </div>
          <label className="cursor-pointer font-mono text-[10px] text-amber-300 hover:text-amber-100 px-3 py-1.5 border border-amber-400/50 rounded-sm tracking-widest">
            CHOOSE FILES
            <input type="file" multiple accept=".pdf,.txt,.md" className="hidden"
              onChange={e => e.target.files && handleFiles(e.target.files)} />
          </label>
        </div>

        {/* Ingestion progress */}
        {ingestQueue.length > 0 && (
          <div className="mt-3 space-y-1">
            {ingestQueue.map((r, i) => (
              <div key={i} className="flex items-center justify-between gap-2 font-mono text-[10px] border-t border-emerald-700/20 pt-1">
                <span className={`tracking-wider ${r.status === "error" ? "text-rose-400" :
                  r.status === "done" ? "text-emerald-400" :
                  r.status === "exists" ? "text-emerald-700" :
                  r.status === "running" ? "text-amber-300" : "text-emerald-600"}`}>
                  {r.status === "done" ? "✓" : r.status === "error" ? "⊘" : r.status === "exists" ? "·" : r.status === "running" ? "◌" : "□"} {r.name}
                </span>
                <span className="text-emerald-600 text-right text-[9px]">
                  {r.status === "running" && ingestProgress?.idx === i ? (
                    ingestProgress.phase === "embedding" ? `embed ${ingestProgress.done}/${ingestProgress.total}` :
                    ingestProgress.phase === "extracting" ? "extracting…" :
                    ingestProgress.phase === "storing" ? "writing…" : ingestProgress.phase
                  ) : r.status === "done" ? `${r.chunks} chunks indexed` :
                     r.status === "exists" ? "already indexed" :
                     r.status === "error" ? r.error : ""}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Already-ingested docs */}
        {droppedDocs.length > 0 && (
          <div className="mt-3 pt-2 border-t border-emerald-700/20">
            <div className="font-mono text-[9px] text-emerald-700 tracking-widest mb-1">▌ YOUR LIBRARY (PERSISTED, THIS BROWSER ONLY)</div>
            <div className="flex flex-wrap gap-1.5">
              {droppedDocs.map(d => (
                <div key={d.id} className="group flex items-center gap-1 font-mono text-[10px] px-2 py-0.5 bg-emerald-950/60 border border-emerald-700/30 rounded-sm">
                  <span className="text-emerald-300 truncate max-w-[260px]">{d.name}</span>
                  <span className="text-emerald-700">{d.pages}p · {d.chunkCount}c</span>
                  <button onClick={() => onRemoveDropped(d.id)} className="text-rose-400/60 hover:text-rose-300 text-[10px] ml-0.5">×</button>
                </div>
              ))}
            </div>
          </div>
        )}
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
        <div className="font-mono text-[11px] text-emerald-500 mb-3">⏳ embedding query and ranking {(vecState?.info?.count ?? 0).toLocaleString()} chunks…</div>
      )}

      {results && (() => {
        // Filter by strength bands. WEAK shown only on toggle, NOISE never.
        const strong = results.grouped.filter(g => g.best >= 0.50);
        const weak   = results.grouped.filter(g => g.best >= 0.40 && g.best < 0.50);
        const visible = showWeak ? [...strong, ...weak] : strong;

        if (results.grouped.length === 0) {
          return <div className="font-mono text-[12px] text-emerald-700 py-8 text-center">No semantically similar passages found.</div>;
        }
        if (visible.length === 0) {
          return (
            <div className="font-mono text-[11px] text-emerald-700 py-8 text-center space-y-2">
              <div>No high-confidence matches.</div>
              <div className="text-[10px]">Best score was <span className="text-amber-400">{results.grouped[0].best.toFixed(3)}</span> ({strengthBand(results.grouped[0].best).label}) — below the relevance floor.</div>
              {weak.length > 0 && (
                <button onClick={() => setShowWeak(true)}
                  className="mt-2 px-3 py-1 rounded-sm border border-purple-400/50 text-purple-300 hover:bg-purple-400/10 tracking-widest text-[10px]">
                  show {weak.length} weak match{weak.length === 1 ? "" : "es"}
                </button>
              )}
            </div>
          );
        }
        return (
        <div>
          <div className="font-mono text-[10px] text-emerald-700 tracking-widest mb-3 flex items-center gap-3 flex-wrap">
            <span>▌ {visible.length} RECORDS · TOP {strengthBand(results.grouped[0].best).label} = {results.grouped[0].best.toFixed(3)} · {results.elapsedMs.toFixed(1)} MS</span>
            <span className="text-emerald-600">scored against {results.staticChunks.toLocaleString()} official + {results.droppedChunks.toLocaleString()} dropped chunks</span>
            {weak.length > 0 && (
              <button onClick={() => setShowWeak(v => !v)}
                className={`ml-auto px-2 py-0.5 rounded-sm border tracking-widest transition-all ${
                  showWeak ? "border-purple-400/70 text-purple-200 bg-purple-400/10"
                  : "border-emerald-700/50 text-emerald-500 hover:border-purple-400/50 hover:text-purple-300"}`}>
                {showWeak ? `▼ HIDING NOISE` : `▸ SHOW ${weak.length} WEAK`}
              </button>
            )}
          </div>
          <div className="space-y-3">
            {visible.map((g, gi) => {
              const pageHits = [...new Map(g.hits.map(h => [`${h.page}-${h.snippet?.slice(0,40)}`, h])).values()]
                .sort((a, b) => b.final - a.final).slice(0, 4);
              const band = strengthBand(g.best);

              if (g.kind === "dropped") {
                return (
                  <div key={`d-${g.docId}`}
                    className="rounded-sm border border-amber-400/40 bg-amber-400/5 border-l-2 p-3"
                    style={{ borderLeftColor: "#FFD93D" }}>
                    <div className="flex items-baseline justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] tracking-wider text-amber-300">YOUR LIBRARY</span>
                        <span className="font-mono text-[9px] text-emerald-700 tracking-widest">LOCAL · NOT IN OFFICIAL CATALOG</span>
                      </div>
                      <div className="flex items-center gap-3 font-mono text-[10px]">
                        <span style={{ color: band.color }} className="tracking-widest" title={`final ${g.best.toFixed(3)} (cos ${g.bestCos.toFixed(3)})`}>
                          {band.glyph} {band.label} {Math.round(g.best * 100)}%
                        </span>
                      </div>
                    </div>
                    <div className="font-mono text-amber-100 text-[14px] mt-1 leading-snug break-all">
                      {highlightQuery(g.docName, qTerms)}
                    </div>
                    {pageHits.length > 0 && (
                      <div className="mt-2 space-y-1.5">
                        {pageHits.map((h, i) => (
                          <div key={i} className="border-l border-amber-400/30 pl-2.5 font-mono text-[11px] text-amber-100/90 leading-relaxed">
                            <span className="text-amber-400/80 text-[9px] tracking-widest mr-2">
                              PAGE {h.page}
                              <span className="ml-2 text-emerald-700">
                                cos {h.cos.toFixed(3)}{h.boost > 0 ? ` +${h.boost.toFixed(2)} match` : ""}
                              </span>
                            </span>
                            {highlightQuery(h.snippet, qTerms)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              }

              const event = g.event;
              const color = AGENCY_COLORS[event.agency] || "#7CFFB2";
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
                        <span style={{ color: band.color }} className="tracking-widest" title={`final ${g.best.toFixed(3)}  cos ${g.bestCos.toFixed(3)}`}>
                          {band.glyph} {band.label} {Math.round(g.best * 100)}%
                        </span>
                      </div>
                    </div>
                    <div className="font-mono text-emerald-100 text-[14px] mt-1 leading-snug">
                      {highlightQuery(event.title, qTerms)}
                    </div>
                  </button>
                  {pageHits.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      {pageHits.map((h, i) => {
                        // Source-aware badge: vision (clean GPT-transcription) > pdfjs
                        // (text layer) > curated (events.js) > OCR (noisy tesseract).
                        const qColor = h.chunkKind === "meta" || h.chunkSource === "curated" ? "text-emerald-400"
                          : h.chunkSource === "vision" ? "text-cyan-300"
                          : h.chunkSource === "pdfjs" ? "text-emerald-400"
                          : (h.chunkQuality ?? 1) >= 0.55 ? "text-amber-300"
                          : "text-amber-600";
                        const qLabel = h.chunkKind === "meta" ? "CURATED"
                          : h.chunkSource === "vision" ? "VISION"
                          : h.chunkSource === "pdfjs" ? "TEXT-LAYER"
                          : h.chunkSource === "ocr" ? `OCR q${(h.chunkQuality ?? 0).toFixed(2)}`
                          : "";
                        const clickable = h.chunkKind !== "meta" && h.page;
                        return (
                          <button key={i}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              // Pass the matched chunk text + the active query terms
                              // so DossierView can show "this is what your search
                              // hit" inline on the deep-linked page. Without this
                              // the dossier only shows its top-N curated extracts
                              // for the page, which usually don't include the
                              // chunk the user just clicked on.
                              clickable && onSelect(event, {
                                page: h.page,
                                matchText: h.snippet,
                                matchTerms: qTerms,
                              });
                            }}
                            disabled={!clickable}
                            className={`block w-full text-left border-l border-emerald-700/30 pl-2.5 font-mono text-[11px] text-emerald-300/90 leading-relaxed rounded-sm ${clickable ? "hover:bg-emerald-900/30 hover:border-amber-400 active:scale-[0.995]" : ""}`}
                            style={{ transition: "background-color 150ms cubic-bezier(0.23,1,0.32,1), border-color 150ms cubic-bezier(0.23,1,0.32,1)" }}>
                            <span className="text-amber-400/80 text-[9px] tracking-widest mr-2">
                              {clickable ? `→ PAGE ${h.page}` : "SUMMARY"}
                              <span className="ml-2 text-emerald-700">
                                cos {h.cos.toFixed(3)}{h.boost > 0 ? ` +${h.boost.toFixed(2)} match` : ""}
                              </span>
                              {qLabel && <span className={`ml-2 ${qColor}`}>{qLabel}</span>}
                            </span>
                            {highlightQuery(h.snippet, qTerms)}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        );
      })()}
    </div>
  );
}
