import React from "react";
import { EVENTS } from "../data/events.js";
import { useT } from "../i18n/context.js";

// Option lists for the war.gov/UFO-style record filters. Derived from
// EVENTS so a new release or agency added in events.js shows up in the
// dropdown automatically. Falls back to "Release 01" when no release
// tag is present (legacy entries).
//
// Agencies + Releases are proper-noun strings from the dataset and stay
// in their source form across locales. Types are display labels we own,
// so they're translated via the `type.*` keys and the canonical English
// `value` stays on the wire so App.jsx's `recordType` filter still
// matches.
const AGENCY_OPTIONS  = [...new Set(EVENTS.map(e => e.agency).filter(Boolean))].sort();
const RELEASE_OPTIONS = [...new Set(EVENTS.map(e => e.release || "Release 01"))].sort();
const TYPE_VALUES     = ["Document", "Video", "Image", "Audio"];

// Record filter bar — search + agency / release / type dropdowns. Mounted
// directly above each view's content (LIVE / SEARCH / SEMANTIC / REVIEW /
// MEDIA / DOSSIER / TIMELINE / ATLAS / GLOBE / NETWORK) so it's visually
// adjacent to the data it filters. Used to live in Header.jsx, but
// floating up there with the brand + nav made users miss that it filters
// the view below — pulling it down to the data section + adding the
// active-filter summary line makes the relationship obvious.
export default function RecordFilterBar({
  query, onSearch,
  filterAgency, onFilterAgency,
  filterRelease, onFilterRelease,
  filterType, onFilterType,
  resultCount = null, totalCount = null,
}) {
  const t = useT();
  if (!onSearch) return null;
  const typeLabel = (val) => t(`type.${String(val).toLowerCase()}`, undefined, val);
  const active = [
    query && { label: `"${query}"`, clear: () => onSearch("") },
    filterAgency && filterAgency !== "all" && { label: filterAgency, clear: () => onFilterAgency?.("all") },
    filterRelease && filterRelease !== "all" && { label: filterRelease, clear: () => onFilterRelease?.("all") },
    filterType && filterType !== "all" && { label: typeLabel(filterType), clear: () => onFilterType?.("all") },
  ].filter(Boolean);
  const hasActive = active.length > 0;
  const showCount = resultCount != null && totalCount != null && hasActive;

  return (
    <div className="px-3 sm:px-6 pt-3 pb-2">
      <div className="border border-emerald-900/40 bg-black/30 rounded-sm">
        {/* row 1: search + dropdowns */}
        <div className="px-2 py-2 flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[9px] tracking-[0.3em] text-emerald-700 pl-1 pr-2 select-none">{t("filter.label")}</span>
          <div className="relative flex-1 min-w-[160px]">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-emerald-700 text-[11px]">⌕</span>
            <input
              value={query || ""}
              onChange={(e) => onSearch(e.target.value)}
              placeholder={t("filter.search_placeholder")}
              aria-label={t("filter.search_aria")}
              className="w-full bg-black/60 border border-emerald-700/40 rounded-sm pl-7 pr-2 py-1.5 text-emerald-200 placeholder-emerald-700 font-mono text-[11px] tracking-[0.15em] focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_8px_rgba(34,211,238,0.3)]" />
          </div>
          <FilterSelect label={t("filter.all_agencies")} value={filterAgency} onChange={onFilterAgency} options={AGENCY_OPTIONS} />
          <FilterSelect label={t("filter.all_releases")} value={filterRelease} onChange={onFilterRelease} options={RELEASE_OPTIONS} />
          <FilterSelect
            label={t("filter.all_types")}
            value={filterType}
            onChange={onFilterType}
            options={TYPE_VALUES}
            renderOption={typeLabel} />
        </div>
        {/* row 2: active-filter summary so the user can't miss that the
            view below is being filtered. Only renders when at least one
            filter is non-default. */}
        {hasActive && (
          <div className="px-3 py-1.5 flex items-center gap-2 flex-wrap border-t border-emerald-900/40 bg-emerald-950/30">
            <span className="font-mono text-[10px] text-emerald-300 tracking-[0.15em]">{t("filter.filtering")}</span>
            {showCount && (
              <span className="font-mono text-[10px] text-cyan-300 tabular-nums">
                {resultCount}<span className="text-emerald-700">/{totalCount}</span>
              </span>
            )}
            {active.map((a, i) => (
              <button
                key={i}
                onClick={a.clear}
                className="inline-flex items-center gap-1 px-2 py-0.5 border border-cyan-700/50 bg-cyan-950/30 hover:bg-cyan-900/40 rounded-sm font-mono text-[10px] text-cyan-200 transition-colors"
                title={t("filter.clear_one_title", { label: a.label })}>
                <span>{a.label}</span>
                <span aria-hidden="true" className="text-cyan-400">✕</span>
              </button>
            ))}
            <button
              onClick={() => {
                onSearch("");
                onFilterAgency?.("all");
                onFilterRelease?.("all");
                onFilterType?.("all");
              }}
              className="ml-auto font-mono text-[10px] text-emerald-600 hover:text-emerald-300 underline-offset-2 hover:underline">
              {t("filter.clear_all")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options, renderOption }) {
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
        {options.map(o => {
          const display = renderOption ? renderOption(o) : o;
          // Keep the loud uppercase styling for Latin-script values
          // (Tailwind .uppercase respects scripts that have no case,
          // so CJK/Arabic stay rendered naturally).
          return <option key={o} value={o}>{String(display).toUpperCase()}</option>;
        })}
      </select>
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-cyan-400 text-[8px]">▼</span>
    </div>
  );
}
