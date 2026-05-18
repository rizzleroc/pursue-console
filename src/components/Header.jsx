import React, { useEffect, useState } from "react";

// Two-row nav: primary actions in the top row, analysis views below.
// REVIEW gets a live count badge — it's the loudest tab on the site
// because it's the most actionable. VOLUNTEER lives in the brand row
// as a button (not a tab) since it's the actual CTA of the project.
const PRIMARY = [
  { id: "live",     label: "LIVE",     glyph: "●" },
  { id: "search",   label: "SEARCH",   glyph: "⌕" },
  { id: "semantic", label: "SEMANTIC", glyph: "∿" },
  { id: "review",   label: "REVIEW",   glyph: "⚖" },
  { id: "dossier",  label: "DOSSIER",  glyph: "❒" },
];
const ANALYSIS = [
  { id: "timeline", label: "TIMELINE", glyph: "▬" },
  { id: "atlas",    label: "ATLAS",    glyph: "▦" },
  { id: "network",  label: "NETWORK",  glyph: "✦" },
];

let _statsP = null;
function loadStats() {
  if (!_statsP) {
    _statsP = fetch(`${import.meta.env.BASE_URL}corpus-stats.json?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : null).catch(() => null);
  }
  return _statsP;
}

export default function Header({ view, onViewChange, onVolunteer, query, onSearch }) {
  const [stats, setStats] = useState(null);
  useEffect(() => { loadStats().then(setStats); }, []);

  const catalogued = stats?.events?.catalogued ?? null;
  const totalInv   = stats?.inventory?.total ?? null;
  const pagesTotal = stats?.pages?.totalIndexed ?? null;
  const reviewN    = stats?.review?.pagesNeedingReview ?? null;

  return (
    <header className="border-b border-emerald-700/40 bg-black/40 backdrop-blur-sm sticky top-0 z-20">
      {/* brand + counts + volunteer CTA */}
      <div className="px-3 sm:px-6 py-2 flex items-center justify-between gap-3 flex-wrap">
        <button
          onClick={() => onViewChange("live")}
          className="flex items-center gap-3 hover:opacity-90"
          aria-label="Go to LIVE">
          <span className="text-emerald-400 text-xs tracking-[0.3em] font-mono">
            <span className="text-amber-400">▶</span> PURSUE
            <span className="ml-2 text-emerald-800 text-[10px] tracking-[0.25em]">release 2.0</span>
          </span>
          {catalogued != null && totalInv != null && (
            <span className="hidden sm:inline text-emerald-700 text-[10px] font-mono">
              {catalogued} / {totalInv} records
              {pagesTotal != null && <> · {pagesTotal.toLocaleString()} pages</>}
            </span>
          )}
        </button>
        <div className="flex items-center gap-2">
          {/* Top search — filters the EVENTS feed via App.filtered. Lightweight
              substring match against title/summary/loc/agency/tags; SEARCH and
              SEMANTIC tabs do the heavier full-text + dense work. */}
          {onSearch && (
            <input
              value={query || ""}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="› grep corpus"
              aria-label="Filter events"
              className="bg-black/60 border border-emerald-700/50 rounded-sm px-2 py-1 text-emerald-300 placeholder-emerald-800 font-mono text-xs w-36 sm:w-56 focus:outline-none focus:border-amber-400 focus:shadow-[0_0_8px_rgba(255,217,61,0.4)]" />
          )}
          <button
            onClick={onVolunteer}
            className="font-mono text-[11px] tracking-[0.2em] px-3 py-1 rounded-sm border border-amber-500/70 bg-amber-900/20 text-amber-200 hover:bg-amber-700/30 hover:border-amber-300 transition-colors"
            title="Help transcribe a page">
            + VOLUNTEER
          </button>
        </div>
      </div>

      {/* primary nav */}
      <nav className="px-1 sm:px-4 flex overflow-x-auto no-scrollbar border-t border-emerald-700/30" role="tablist">
        {PRIMARY.map(v => (
          <NavTab key={v.id} v={v} active={view === v.id} onClick={() => onViewChange(v.id)}
            badge={v.id === "review" && reviewN > 0 ? reviewN : null} badgeColor="amber" />
        ))}
      </nav>

      {/* analysis nav — same row pattern, dimmer */}
      <nav className="px-1 sm:px-4 flex overflow-x-auto no-scrollbar border-t border-emerald-900/30 bg-black/20" role="tablist">
        <span className="font-mono text-[9px] tracking-[0.3em] text-emerald-800 px-3 py-2 flex items-center select-none">ANALYSIS</span>
        {ANALYSIS.map(v => (
          <NavTab key={v.id} v={v} active={view === v.id} onClick={() => onViewChange(v.id)} dim />
        ))}
      </nav>
    </header>
  );
}

function NavTab({ v, active, dim, badge, badgeColor, onClick }) {
  const base = dim
    ? (active ? "text-emerald-300" : "text-emerald-800 hover:text-emerald-500")
    : (active ? "text-emerald-300" : "text-emerald-700 hover:text-emerald-500");
  return (
    <button
      role="tab" aria-selected={active}
      onClick={onClick}
      className={`relative flex-shrink-0 px-3 sm:px-5 py-2 font-mono text-[10px] sm:text-xs tracking-[0.2em] transition-all ${base}`}>
      <span className="mr-1.5 opacity-70">{v.glyph}</span>{v.label}
      {badge != null && (
        <span className={`ml-2 inline-flex items-center justify-center min-w-[1.25rem] px-1 py-px text-[9px] font-mono rounded-sm border ${
          badgeColor === "amber"
            ? "border-amber-500/70 bg-amber-900/30 text-amber-200"
            : "border-emerald-700/60 bg-emerald-900/30 text-emerald-200"
        }`}>
          {badge}
        </span>
      )}
      {active && <span className="absolute bottom-0 left-2 right-2 h-px bg-emerald-400 shadow-[0_0_8px_rgba(124,255,178,0.8)]" />}
    </button>
  );
}
