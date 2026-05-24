import React from "react";
import useCorpusStats from "../hooks/useCorpusStats.js";

// Filter bar (search + agency / release / type dropdowns) moved to
// components/RecordFilterBar.jsx and is rendered by App.jsx directly
// above the data area on each view, so users don't miss that those
// controls are filtering the view they're looking at.

// Two-row nav: primary actions in the top row, analysis views below.
// REVIEW gets a live count badge — it's the loudest tab on the site
// because it's the most actionable. VOLUNTEER lives in the brand row
// as a button (not a tab) since it's the actual CTA of the project.
const PRIMARY = [
  { id: "live",     label: "LIVE",     glyph: "●" },
  { id: "search",   label: "SEARCH",   glyph: "⌕" },
  { id: "semantic", label: "SEMANTIC", glyph: "∿" },
  { id: "ask",      label: "ASK",      glyph: "?" },
  { id: "review",   label: "REVIEW",   glyph: "⚖" },
  { id: "media",    label: "MEDIA",    glyph: "▦" },
  { id: "dossier",  label: "DOSSIER",  glyph: "❒" },
];
const ANALYSIS = [
  { id: "timeline", label: "TIMELINE", glyph: "▬" },
  { id: "atlas",    label: "ATLAS",    glyph: "▦" },
  { id: "globe",    label: "GLOBE",    glyph: "◉" },
  { id: "network",  label: "NETWORK",  glyph: "✦" },
];

export default function Header({ view, onViewChange, onVolunteer }) {
  const { stats } = useCorpusStats();

  const catalogued = stats?.events?.catalogued ?? null;
  const totalInv   = stats?.inventory?.total ?? null;
  const pagesTotal = stats?.pages?.totalIndexed ?? null;
  const reviewN    = stats?.review?.pagesNeedingReview ?? null;
  // When the corpus spans multiple releases, render per-release ratios
  // instead of a mixed-release total. The legacy "catalogued/inventoryTotal"
  // pair compares all-releases events against just the Release 01 ceiling,
  // which silently overstates Release 01 progress.
  const releaseEntries = stats?.byRelease ? Object.entries(stats.byRelease) : [];
  const hasMultiRelease = releaseEntries.length >= 2;

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
            <a href="https://github.com/rizzleroc/pursue-console/blob/main/CHANGELOG.md"
               target="_blank" rel="noreferrer"
               title="View 2.0 changelog"
               className="ml-2 text-emerald-800 hover:text-emerald-400 text-[10px] tracking-[0.25em] underline-offset-2 hover:underline">
              release 2.1
            </a>
          </span>
          {catalogued != null && totalInv != null && (
            <span className="hidden sm:inline text-emerald-700 text-[10px] font-mono"
              title={hasMultiRelease
                ? releaseEntries.map(([label, r]) => `${label}: ${r.catalogued}/${r.inventoryTotal} (${r.status})`).join(" · ")
                : undefined}>
              {hasMultiRelease
                ? releaseEntries.map(([label, r]) => `${label.replace(/^Release\s+0?/i, "R")} ${r.catalogued}/${r.inventoryTotal}`).join(" · ")
                : `${catalogued} / ${totalInv}`} records
              {pagesTotal != null && <> · {pagesTotal.toLocaleString()} pages</>}
            </span>
          )}
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={onVolunteer}
            className="font-mono text-[11px] tracking-[0.2em] px-3 py-1 rounded-sm border border-amber-500/70 bg-amber-900/20 text-amber-200 hover:bg-amber-700/30 hover:border-amber-300 transition-colors"
            title="Help transcribe a page">
            + VOLUNTEER
          </button>
        </div>
      </div>

      {/* Unified nav — primary tabs first, then a thin divider, then the
          analysis tabs. Combined into a single row so the order of tabs
          reads left-to-right without the user wondering why there are
          two rails. The filter bar lives below the header, directly
          above the view content. */}
      <nav className="px-1 sm:px-4 flex items-center overflow-x-auto no-scrollbar border-t border-emerald-700/30" role="tablist">
        {PRIMARY.map(v => (
          <NavTab key={v.id} v={v} active={view === v.id} onClick={() => onViewChange(v.id)}
            badge={v.id === "review" && reviewN > 0 ? reviewN : null} badgeColor="amber" />
        ))}
        <span aria-hidden="true" className="mx-2 sm:mx-3 h-5 w-px bg-emerald-900/60 shrink-0" />
        <span className="font-mono text-[9px] tracking-[0.3em] text-emerald-800 px-2 py-2 flex items-center select-none shrink-0">ANALYSIS</span>
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
