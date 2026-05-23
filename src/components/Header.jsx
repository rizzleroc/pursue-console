import React from "react";
import useCorpusStats from "../hooks/useCorpusStats.js";
import { EVENTS } from "../data/events.js";

// Option lists for the war.gov/UFO-style record filters. Agencies are
// derived from the catalogue; types are the four collapsed categories
// (see App.recordType); releases is single today but list-driven so
// future tranches slot in.
const AGENCY_OPTIONS = [...new Set(EVENTS.map(e => e.agency).filter(Boolean))].sort();
const RELEASE_OPTIONS = ["Release 01"];
const TYPE_OPTIONS = ["Document", "Video", "Image", "Audio"];

// Two-row nav: primary actions in the top row, analysis views below.
// REVIEW gets a live count badge — it's the loudest tab on the site
// because it's the most actionable. VOLUNTEER lives in the brand row
// as a button (not a tab) since it's the actual CTA of the project.
const PRIMARY = [
  { id: "live",     label: "LIVE",     glyph: "●" },
  { id: "search",   label: "SEARCH",   glyph: "⌕" },
  { id: "semantic", label: "SEMANTIC", glyph: "∿" },
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

export default function Header({
  view, onViewChange, onVolunteer, query, onSearch,
  filterAgency, onFilterAgency, filterRelease, onFilterRelease, filterType, onFilterType,
  showFilters,
}) {
  const { stats } = useCorpusStats();

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
            <a href="https://github.com/rizzleroc/pursue-console/blob/main/CHANGELOG.md"
               target="_blank" rel="noreferrer"
               title="View 2.0 changelog"
               className="ml-2 text-emerald-800 hover:text-emerald-400 text-[10px] tracking-[0.25em] underline-offset-2 hover:underline">
              release 2.1
            </a>
          </span>
          {catalogued != null && totalInv != null && (
            <span className="hidden sm:inline text-emerald-700 text-[10px] font-mono">
              {catalogued} / {totalInv} records
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

      {/* Record filter bar — mirrors war.gov/UFO: search + agency / release /
          type dropdowns. Drives App.filtered (the catalogued-records views).
          Hidden on views that don't honor App.filtered (LIVE / SEARCH /
          SEMANTIC / REVIEW / MEDIA / DOSSIER / HELP) — those either have
          their own in-page search input (MEDIA, SEARCH, SEMANTIC) or
          aren't filterable by EVENTS metadata at all — so showing a dead
          control on them made the user think the bar was broken. */}
      {showFilters && onSearch && (
        <div className="px-3 sm:px-6 py-2 flex items-center gap-2 flex-wrap border-t border-emerald-900/40 bg-black/20">
          <div className="relative flex-1 min-w-[160px]">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-emerald-700 text-[11px]">⌕</span>
            <input
              value={query || ""}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="SEARCH RECORDS..."
              aria-label="Search records"
              className="w-full bg-black/60 border border-emerald-700/40 rounded-sm pl-7 pr-2 py-1.5 text-emerald-200 placeholder-emerald-700 font-mono text-[11px] tracking-[0.15em] focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_8px_rgba(34,211,238,0.3)]" />
          </div>
          <FilterSelect label="ALL AGENCIES" value={filterAgency} onChange={onFilterAgency} options={AGENCY_OPTIONS} />
          <FilterSelect label="ALL RELEASES" value={filterRelease} onChange={onFilterRelease} options={RELEASE_OPTIONS} />
          <FilterSelect label="ALL TYPES" value={filterType} onChange={onFilterType} options={TYPE_OPTIONS} />
        </div>
      )}

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

// Styled native <select> — keeps keyboard/screen-reader behaviour while
// matching the war.gov/UFO look (uppercase label, cyan chevron, dark fill).
function FilterSelect({ label, value, onChange, options }) {
  const active = value && value !== "all";
  return (
    <div className="relative">
      <select
        value={value || "all"}
        onChange={(e) => onChange?.(e.target.value)}
        aria-label={label}
        className={`appearance-none cursor-pointer bg-black/60 border rounded-sm pl-3 pr-7 py-1.5 font-mono text-[11px] tracking-[0.15em] focus:outline-none focus:border-cyan-400 ${
          active ? "border-cyan-500/60 text-cyan-200" : "border-emerald-700/40 text-emerald-300"
        }`}>
        <option value="all">{label}</option>
        {options.map(o => <option key={o} value={o}>{o.toUpperCase()}</option>)}
      </select>
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-cyan-400 text-[8px]">▼</span>
    </div>
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
