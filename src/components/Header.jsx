import React from "react";
import useCorpusStats from "../hooks/useCorpusStats.js";
import LanguagePicker from "./LanguagePicker.jsx";
import { useT } from "../i18n/context.js";

// Filter bar (search + agency / release / type dropdowns) moved to
// components/RecordFilterBar.jsx and is rendered by App.jsx directly
// above the data area on each view, so users don't miss that those
// controls are filtering the view they're looking at.

// Two-row nav: primary actions in the top row, analysis views below.
// REVIEW gets a live count badge — it's the loudest tab on the site
// because it's the most actionable. VOLUNTEER lives in the brand row
// as a button (not a tab) since it's the actual CTA of the project.
// Labels here are i18n keys; the glyphs are decorative and locale-agnostic.
const PRIMARY = [
  { id: "live",     key: "nav.live",     glyph: "●" },
  { id: "search",   key: "nav.search",   glyph: "⌕" },
  { id: "semantic", key: "nav.semantic", glyph: "∿" },
  { id: "ask",      key: "nav.ask",      glyph: "?" },
  { id: "review",   key: "nav.review",   glyph: "⚖" },
  { id: "media",    key: "nav.media",    glyph: "▦" },
  { id: "dossier",  key: "nav.dossier",  glyph: "❒" },
];
const ANALYSIS = [
  { id: "timeline", key: "nav.timeline", glyph: "▬" },
  { id: "atlas",    key: "nav.atlas",    glyph: "▦" },
  { id: "globe",    key: "nav.globe",    glyph: "◉" },
  { id: "network",  key: "nav.network",  glyph: "✦" },
  { id: "map",      key: "nav.map",      glyph: "❋" },
];

export default function Header({ view, onViewChange, onVolunteer }) {
  const { stats } = useCorpusStats();
  const t = useT();

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
          aria-label={t("nav.go_to_live")}>
          <span className="text-emerald-400 text-xs tracking-[0.3em] font-mono">
            <span className="text-amber-400">▶</span> PURSUE
            <a href="https://github.com/rizzleroc/pursue-console/blob/main/CHANGELOG.md"
               target="_blank" rel="noreferrer"
               title={t("header.release_title")}
               className="ml-2 text-emerald-800 hover:text-emerald-400 text-[10px] tracking-[0.25em] underline-offset-2 hover:underline">
              {t("header.release_label")}
            </a>
          </span>
          {catalogued != null && totalInv != null && (
            <span className="hidden sm:inline text-emerald-700 text-[10px] font-mono"
              title={hasMultiRelease
                ? releaseEntries.map(([label, r]) => `${label}: ${r.catalogued}/${r.inventoryTotal} (${r.status})`).join(" · ")
                : undefined}>
              {hasMultiRelease
                ? <>{releaseEntries.map(([label, r]) => `${label.replace(/^Release\s+0?/i, "R")} ${r.catalogued}/${r.inventoryTotal}`).join(" · ")} records</>
                : t("header.records", { catalogued, total: totalInv })}
              {pagesTotal != null && <> · {t("header.pages", { pages: pagesTotal.toLocaleString() })}</>}
            </span>
          )}
        </button>
        <div className="flex items-center gap-2">
          <a
            href={`${import.meta.env.BASE_URL}mc/`}
            className="font-mono text-[10px] tracking-[0.25em] px-2.5 py-1 rounded-sm border border-amber-700/50 bg-amber-950/30 text-amber-300/90 hover:bg-amber-900/40 hover:border-amber-500/70 hover:text-amber-200 transition-colors"
            title="Preview the next release — Mission Control 3.0">
            ▣ MISSION CONTROL 3.0 →
          </a>
          <LanguagePicker />
          <button
            onClick={onVolunteer}
            className="font-mono text-[11px] tracking-[0.2em] px-3 py-1 rounded-sm border border-amber-500/70 bg-amber-900/20 text-amber-200 hover:bg-amber-700/30 hover:border-amber-300 transition-colors"
            title={t("header.volunteer_title")}>
            {t("header.volunteer_cta")}
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
          <NavTab key={v.id} v={v} label={t(v.key)} active={view === v.id} onClick={() => onViewChange(v.id)}
            badge={v.id === "review" && reviewN > 0 ? reviewN : null} badgeColor="amber" />
        ))}
        <span aria-hidden="true" className="mx-2 sm:mx-3 h-5 w-px bg-emerald-900/60 shrink-0" />
        <span className="font-mono text-[9px] tracking-[0.3em] text-emerald-800 px-2 py-2 flex items-center select-none shrink-0">{t("nav.analysis")}</span>
        {ANALYSIS.map(v => (
          <NavTab key={v.id} v={v} label={t(v.key)} active={view === v.id} onClick={() => onViewChange(v.id)} dim />
        ))}
      </nav>
    </header>
  );
}

function NavTab({ v, label, active, dim, badge, badgeColor, onClick }) {
  const base = dim
    ? (active ? "text-emerald-300" : "text-emerald-800 hover:text-emerald-500")
    : (active ? "text-emerald-300" : "text-emerald-700 hover:text-emerald-500");
  return (
    <button
      role="tab" aria-selected={active}
      onClick={onClick}
      className={`relative flex-shrink-0 px-3 sm:px-5 py-2 font-mono text-[10px] sm:text-xs tracking-[0.2em] transition-all ${base}`}>
      <span className="mr-1.5 opacity-70">{v.glyph}</span>{label}
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
