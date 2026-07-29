import React, { useState } from "react";
import { AGENCY_COLORS } from "../data/events.js";
import { GlitchText, MiniChip } from "../components/Primitives.jsx";
import SourceMix from "../components/SourceMix.jsx";
import useCorpusStats from "../hooks/useCorpusStats.js";
import { useT } from "../i18n/context.js";

const ERAS = [
  { id: "40s", label: "1944—49" }, { id: "50s", label: "1950—59" },
  { id: "60s", label: "1960—69" }, { id: "70s", label: "1970—79" },
  { id: "80s", label: "1980—89" }, { id: "90s", label: "1990—99" },
  { id: "00s", label: "2000—09" }, { id: "10s", label: "2010—19" },
  { id: "20s", label: "2020—26" },
];
const AGENCIES = ["Department of War", "FBI", "NASA", "Department of State"];

// Stats-strip configs — `key` resolves under atlas.stats.* so the labels
// localize while the predicate (count) stays the same. Color is the
// visual signal, not the text.
const STAT_CARDS = [
  { key: "mission_reports",   color: "#7CFFB2", filter: e => e.type.includes("Mission Report") },
  { key: "range_foulers",     color: "#7CFFB2", filter: e => e.type.includes("Range Fouler") },
  { key: "witness_302",       color: "#FF8C42", filter: e => e.type.includes("302") || e.type.includes("Witness") },
  { key: "diplomatic_cables", color: "#FFD93D", filter: e => e.type.includes("Diplomatic") },
  { key: "nasa_crew",         color: "#82B6FF", filter: e => e.agency === "NASA" },
  { key: "historical_memos",  color: "#7CFFB2", filter: e => e.type.includes("Memo") || e.type.includes("Memorandum") },
  { key: "redacted",          color: "#FB7185", filter: e => e.redacted },
  { key: "priority",          color: "#FFD93D", filter: e => e.flag === "anchor" },
];

export default function AtlasView({ events, onSelect }) {
  const t = useT();
  const [activeCell, setActiveCell] = useState(null);
  const { stats } = useCorpusStats();
  const byEvent = stats?.byEvent || null;
  const cell = (agency, era) => events.filter(e => e.agency === agency && e.era === era);
  const max = Math.max(...AGENCIES.flatMap(a => ERAS.map(e => cell(a, e.id).length)));
  const cellEvents = activeCell ? cell(activeCell.agency, activeCell.era) : [];

  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]"><GlitchText>{t("atlas.title")}</GlitchText></h2>
        <div className="font-mono text-[10px] text-emerald-700">{t("atlas.sub")}</div>
      </div>
      <div className="overflow-x-auto">
        <div className="inline-block min-w-full border border-emerald-700/40 bg-black/40 rounded-sm">
          <div className="grid" style={{ gridTemplateColumns: `minmax(140px, 1fr) repeat(${ERAS.length}, minmax(56px, 1fr))` }}>
            <div className="p-2 font-mono text-[9px] text-emerald-700 border-r border-b border-emerald-700/30">{t("atlas.row_label")}</div>
            {ERAS.map(era => <div key={era.id} className="p-2 font-mono text-[9px] text-amber-400 text-center border-b border-emerald-700/30">{era.label}</div>)}
            {AGENCIES.map(agency => (
              <React.Fragment key={agency}>
                <div className="p-2 font-mono text-[10px] sm:text-xs border-r border-b border-emerald-700/30 flex items-center" style={{ color: AGENCY_COLORS[agency] }}>
                  ▌ {agency.replace("Department of ","DEPT/")}
                </div>
                {ERAS.map(era => {
                  const evs = cell(agency, era.id);
                  const intensity = max > 0 ? evs.length / max : 0;
                  const isActive = activeCell?.agency === agency && activeCell?.era === era.id;
                  return (
                    <button key={era.id} onClick={() => setActiveCell(evs.length ? { agency, era: era.id } : null)} disabled={evs.length === 0}
                      className={`relative p-2 border-b border-emerald-700/30 font-mono text-xs transition-all ${
                        evs.length === 0 ? "cursor-default opacity-40" : "hover:scale-[1.05] active:scale-95"} ${
                        isActive ? "outline outline-1 outline-amber-400 z-10" : ""}`}
                      style={{
                        backgroundColor: evs.length ? `${AGENCY_COLORS[agency]}${Math.round(intensity * 50).toString(16).padStart(2,"0")}` : "transparent",
                        color: evs.length ? AGENCY_COLORS[agency] : "#374151",
                      }}>
                      {evs.length > 0 ? evs.length : "·"}
                      {evs.some(e => e.flag === "anchor") && <span className="absolute top-0.5 right-0.5 text-amber-400 text-[8px]">▲</span>}
                    </button>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
      {activeCell && (
        <div className="mt-4 border border-amber-400/50 bg-amber-400/5 rounded-sm p-4 animate-fadein">
          <div className="font-mono text-[10px] text-amber-400 mb-3 tracking-wider">
            {t("atlas.cell_heading", {
              agency: activeCell.agency.toUpperCase(),
              era: ERAS.find(e=>e.id===activeCell.era)?.label,
            })}
            <span className="text-emerald-700 ml-2">{cellEvents.length === 1 ? t("atlas.cell_count_one") : t("atlas.cell_count_n", { n: cellEvents.length })}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {cellEvents.map(e => {
              const stat = byEvent?.[e.id];
              return (
                <div key={e.id} className="flex items-center gap-2">
                  <div className="flex-1 min-w-0"><MiniChip event={e} onClick={onSelect} /></div>
                  {stat?.sources?.length > 0 && <SourceMix sources={stat.sources} size="xs" />}
                  {stat?.needsReview > 0 && (
                    <span className="text-amber-300 text-[9px] font-mono" title={`${stat.needsReview} pages need review`}>⚖{stat.needsReview}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="mt-8 grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {STAT_CARDS.map(s => {
          const count = events.filter(s.filter).length;
          const label = t(`atlas.stats.${s.key}`);
          return (
            <div key={s.key} className="border border-emerald-700/30 bg-black/40 p-3 rounded-sm">
              <div className="font-mono text-[9px] tracking-wider opacity-70" style={{color: s.color}}>{label}</div>
              <div className="font-mono text-3xl mt-1" style={{color: s.color}}>{count}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
