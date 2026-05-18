import React, { useEffect, useState } from "react";
import { AGENCY_COLORS } from "../data/events.js";
import { GlitchText, flagBg, DocTypeBadge } from "../components/Primitives.jsx";
import SourceMix from "../components/SourceMix.jsx";

// Per-event source mix from corpus-stats.json (DB-backed). Cached.
let _byEventP = null;
function useByEvent() {
  const [be, setBe] = useState(null);
  useEffect(() => {
    if (!_byEventP) {
      _byEventP = fetch(`${import.meta.env.BASE_URL}corpus-stats.json`)
        .then(r => r.ok ? r.json() : null)
        .then(j => j?.byEvent || {})
        .catch(() => ({}));
    }
    _byEventP.then(setBe);
  }, []);
  return be;
}

const ERAS = [
  { id: "40s", label: "1944–1949" }, { id: "50s", label: "1950–1959" },
  { id: "60s", label: "1960–1969" }, { id: "70s", label: "1970–1979" },
  { id: "80s", label: "1980–1989" }, { id: "90s", label: "1990–1999" },
  { id: "00s", label: "2000–2009" }, { id: "10s", label: "2010–2019" },
  { id: "20s", label: "2020–2026" },
];

export default function TimelineView({ events, onSelect }) {
  const sorted = [...events].sort((a,b) => a.sort - b.sort);
  const byEvent = useByEvent();
  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-6 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]">
          <GlitchText>┃ CHRONOLOGY</GlitchText>
        </h2>
        <div className="font-mono text-[10px] text-emerald-700">{sorted.length} RECORDS // 1944—2026</div>
      </div>
      <div className="space-y-10">
        {ERAS.map((era) => {
          const eraEvents = sorted.filter(e => e.era === era.id);
          if (eraEvents.length === 0) return null;
          return (
            <div key={era.id}>
              <div className="flex items-center gap-3 mb-3">
                <div className="font-mono text-amber-400 text-xs sm:text-sm tracking-[0.3em]">▌{era.label}</div>
                <div className="flex-1 h-px bg-gradient-to-r from-amber-400/60 via-emerald-700/30 to-transparent" />
                <div className="font-mono text-emerald-700 text-[10px]">{eraEvents.length}</div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {eraEvents.map((event) => (
                  <button key={event.id} onClick={() => onSelect(event)}
                    className={`group text-left rounded-sm border-l-2 p-3 transition-all hover:bg-emerald-950/40 active:scale-[0.99] ${flagBg(event.flag)}`}
                    style={{ borderLeftColor: AGENCY_COLORS[event.agency] || "#7CFFB2" }}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-mono text-[9px] tracking-[0.2em]" style={{ color: AGENCY_COLORS[event.agency] }}>
                        {event.agency === "Department of War" ? "DOW" : event.agency === "Department of State" ? "DOS" : event.agency.toUpperCase()}
                      </div>
                      <div className="flex items-center gap-1">
                        <DocTypeBadge docType={event.docType} />
                        {event.flag === "anchor" && <span className="text-amber-400 text-[10px]">▲</span>}
                        {event.redacted && <span className="font-mono text-[8px] text-rose-400/70">REDACT</span>}
                      </div>
                    </div>
                    <div className="text-emerald-100 text-[13px] leading-snug mt-1 group-hover:text-amber-200 transition-colors">{event.title}</div>
                    <div className="flex items-center gap-2 mt-2 text-[10px] font-mono">
                      <span className="text-emerald-500">{event.date}</span>
                      <span className="text-emerald-800">·</span>
                      <span className="text-emerald-700 truncate flex-1">{event.loc}</span>
                      {byEvent?.[event.id]?.sources?.length > 0 && (
                        <SourceMix sources={byEvent[event.id].sources} size="xs" />
                      )}
                      {byEvent?.[event.id]?.needsReview > 0 && (
                        <span className="text-amber-300 text-[9px]" title={`${byEvent[event.id].needsReview} pages need review`}>⚖{byEvent[event.id].needsReview}</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
