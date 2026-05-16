import React, { useEffect, useState } from "react";

// Single source of truth for "how fresh is the data on screen right now."
// Polls public/corpus-version.json every 60s and shows a compact strip
// you can drop into any view header. Cache-busts the fetch so users on
// the deployed site see updates as soon as a new build lands.

let _versionP = null;
function loadVersion(bust = false) {
  if (bust || !_versionP) {
    const t = bust ? `?t=${Date.now()}` : "";
    _versionP = fetch(`${import.meta.env.BASE_URL}corpus-version.json${t}`, { cache: bust ? "reload" : "default" })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .catch(() => null);
  }
  return _versionP;
}

function fmtAgo(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "now";
  if (ms < 60_000)        return `${Math.round(ms/1000)}s ago`;
  if (ms < 3_600_000)     return `${Math.round(ms/60_000)}m ago`;
  if (ms < 86_400_000)    return `${Math.round(ms/3_600_000)}h ago`;
  return `${Math.round(ms/86_400_000)}d ago`;
}

export default function CorpusFreshness({ compact = false }) {
  const [v, setV] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  async function refresh(bust = false) {
    setRefreshing(true);
    if (bust) _versionP = null;
    try { setV(await loadVersion(bust)); } finally { setRefreshing(false); }
  }
  useEffect(() => {
    refresh(false);
    const id = setInterval(() => refresh(true), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!v) return null;
  const ago = fmtAgo(v.generatedAt);

  if (compact) {
    return (
      <span className="inline-flex items-center gap-2 font-mono text-[10px] text-emerald-700 tracking-widest">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        CORPUS · {ago}
        {v.embeddingsCount && <span className="text-emerald-600">· {v.embeddingsCount.toLocaleString()} chunks</span>}
        {v.pagesNeeded != null && <span className="text-amber-600">· {v.pagesNeeded} pages queued</span>}
      </span>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-emerald-900/50 bg-black/60 font-mono text-[10px] tracking-widest text-emerald-700 flex-wrap">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          CORPUS REFRESHED <span className="text-emerald-400 ml-1">{ago}</span>
        </span>
        {v.embeddingsCount != null && (
          <span className="text-emerald-600">·  FAISS <span className="text-emerald-400">{v.embeddingsCount.toLocaleString()}</span> chunks {v.embeddingsDim}D</span>
        )}
        {v.docsIndexed != null && (
          <span className="text-emerald-600">·  <span className="text-emerald-400">{v.docsIndexed}</span> docs indexed</span>
        )}
        {v.pagesNeeded != null && (
          <span className="text-amber-600">·  <span className="text-amber-300">{v.pagesNeeded}</span> pages need volunteers</span>
        )}
      </div>
      <button
        onClick={() => refresh(true)}
        disabled={refreshing}
        style={{ transition: "all 150ms cubic-bezier(0.23, 1, 0.32, 1)" }}
        className="text-emerald-500 hover:text-amber-300 px-2 py-0.5 border border-emerald-900 hover:border-amber-700 rounded-sm active:scale-[0.97] disabled:opacity-40">
        {refreshing ? "◌" : "↻"} REFRESH
      </button>
    </div>
  );
}
