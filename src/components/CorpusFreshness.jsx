import React, { useEffect, useState } from "react";
import useCorpusStats from "../hooks/useCorpusStats.js";

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
  const { stats: s, reload: reloadStats } = useCorpusStats();
  const [refreshing, setRefreshing] = useState(false);

  async function refresh(bust = false) {
    setRefreshing(true);
    if (bust) { _versionP = null; }
    try {
      const [ver] = await Promise.all([loadVersion(bust), reloadStats(bust)]);
      setV(ver);
    } finally { setRefreshing(false); }
  }
  useEffect(() => {
    refresh(false);
    const id = setInterval(() => refresh(true), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!v && !s) return null;
  const ago = fmtAgo((s?.generatedAt) || v?.generatedAt);

  // Pull TRUE numbers from the DB-derived stats when available; fall back
  // to the version manifest. Single tooltip can explain the breakdown.
  const inventoryTotal = s?.inventory?.total ?? null;
  const catalogued     = s?.events?.catalogued ?? null;
  const withVision     = s?.events?.withVisionPages ?? null;
  const pagesIndexed   = s?.pages?.totalIndexed ?? null;
  const pagesVision    = s?.pages?.vision ?? null;
  const contribPages   = s?.contributions?.total ?? null;
  const contribCount   = s?.contributions?.contributors?.length ?? 0;
  const uncatalogued   = s?.gap?.uncataloguedRecords ?? null;

  if (compact) {
    return (
      <div className="px-3 sm:px-6 py-1.5 border-b border-emerald-900/40 bg-black/30 flex items-center justify-between gap-3 flex-wrap">
        <span className="inline-flex items-center gap-2 font-mono text-[10px] text-emerald-700 tracking-widest">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          {catalogued}/{inventoryTotal} records · {pagesIndexed?.toLocaleString()} pages · refreshed {ago}
        </span>
        <button onClick={() => refresh(true)} disabled={refreshing}
          className="text-emerald-600 hover:text-amber-300 px-1.5 py-0.5 font-mono text-[10px] tracking-widest disabled:opacity-40">
          {refreshing ? "◌" : "↻"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-emerald-900/50 bg-black/60 font-mono text-[10px] tracking-widest text-emerald-700 flex-wrap">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          REFRESHED <span className="text-emerald-400 ml-1">{ago}</span>
        </span>
        {inventoryTotal != null && (
          <span className="text-emerald-600" title="Records claimed by war.gov press release (will be a live scrape count once the scraper lands)">
            ·  <span className="text-emerald-400">{catalogued}</span> of <span className="text-emerald-400">{inventoryTotal}</span> records catalogued
          </span>
        )}
        {pagesIndexed != null && (
          <span className="text-emerald-600" title="Per-page rows in the corpus DB across all events">
            ·  <span className="text-emerald-400">{pagesIndexed.toLocaleString()}</span> pages indexed (<span className="text-cyan-300">{pagesVision.toLocaleString()}</span> vision)
          </span>
        )}
        {s?.bySource && (
          <span className="text-emerald-700" title="How many pages each transcription source has produced (a page can have multiple sources for cross-validation)">
            ·  by source:
            {s.bySource.human > 0 && <span className="text-amber-300 ml-1">{s.bySource.human}H</span>}
            {s.bySource.gptVision > 0 && <span className="text-cyan-300 ml-1">{s.bySource.gptVision.toLocaleString()}G5</span>}
            {s.bySource.gemini > 0 && <span className="text-emerald-400 ml-1">{s.bySource.gemini.toLocaleString()}Gem</span>}
            {s.bySource.claude > 0 && <span className="text-orange-300 ml-1">{s.bySource.claude.toLocaleString()}Cl</span>}
            {s.bySource.ocr > 0 && <span className="text-emerald-600 ml-1">{s.bySource.ocr.toLocaleString()}OCR</span>}
          </span>
        )}
        {contribPages > 0 && (
          <span className="text-emerald-600" title="Pages contributed by outside volunteers via PRs">
            ·  <span className="text-amber-300">{contribPages}</span> from <span className="text-amber-300">{contribCount}</span> volunteer{contribCount === 1 ? "" : "s"}
          </span>
        )}
        {uncatalogued > 0 && (
          <span className="text-rose-400/80" title="Records on war.gov not yet catalogued in src/data/events.js">
            ·  <span className="text-rose-300">{uncatalogued}</span> still uncatalogued
          </span>
        )}
        {v?.embeddingsCount != null && (
          <span className="text-emerald-700">·  FAISS <span className="text-emerald-500">{v.embeddingsCount.toLocaleString()}</span>D</span>
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
