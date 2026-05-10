import React, { useState } from "react";
import { THREADS } from "../data/threads.js";
import { AGENCY_COLORS } from "../data/events.js";
import { GlitchText, flagBg } from "../components/Primitives.jsx";

export default function ThreadsView({ events, onSelect }) {
  const [activeId, setActiveId] = useState(THREADS[0].id);
  const eventIdx = Object.fromEntries(events.map(e => [e.id, e]));
  const active = THREADS.find(t => t.id === activeId);
  const seq = active.events.map(id => eventIdx[id]).filter(Boolean);

  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]"><GlitchText>┃ THREADS</GlitchText></h2>
        <div className="font-mono text-[10px] text-emerald-700">CURATED NARRATIVE ARCS</div>
      </div>

      <div className="grid lg:grid-cols-[280px,1fr] gap-4">
        <nav className="space-y-1.5">
          {THREADS.map(t => {
            const isActive = t.id === activeId;
            return (
              <button key={t.id} onClick={() => setActiveId(t.id)}
                className={`w-full text-left rounded-sm border p-2.5 transition-all ${
                  isActive ? "border-amber-400/60 bg-amber-400/5" : "border-emerald-700/30 bg-black/30 hover:border-emerald-500/50"}`}>
                <div className="font-mono text-[9px] tracking-widest mb-1" style={{ color: t.color }}>
                  ▌ {t.events.length} EVENTS
                </div>
                <div className="font-mono text-emerald-100 text-[12px] leading-tight">{t.title}</div>
              </button>
            );
          })}
        </nav>

        <div className="border border-emerald-700/40 bg-black/40 rounded-sm p-4 sm:p-6">
          <div className="font-mono text-[9px] tracking-widest mb-2" style={{ color: active.color }}>▌ THESIS</div>
          <h3 className="font-mono text-emerald-100 text-lg sm:text-xl leading-tight mb-3">{active.title}</h3>
          <p className="font-mono text-[12px] sm:text-[13px] text-emerald-300 leading-relaxed mb-6">{active.thesis}</p>

          {/* Trail */}
          <div className="font-mono text-[9px] tracking-widest text-emerald-700 mb-3">▌ TRAIL ({seq.length} STOPS)</div>
          <ol className="relative space-y-3 pl-6">
            <span className="absolute left-2 top-1 bottom-1 w-px" style={{ backgroundColor: active.color, opacity: 0.4 }} />
            {seq.map((ev, i) => (
              <li key={ev.id} className="relative">
                <span className="absolute -left-[18px] top-2 w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: ev.flag === "anchor" ? "#FFD93D" : (AGENCY_COLORS[ev.agency] || "#7CFFB2"), boxShadow: ev.flag === "anchor" ? "0 0 8px #FFD93D" : "none" }} />
                <button onClick={() => onSelect(ev)}
                  className={`w-full text-left rounded-sm border-l-2 p-3 transition-all hover:bg-emerald-950/40 ${flagBg(ev.flag)}`}
                  style={{ borderLeftColor: AGENCY_COLORS[ev.agency] || "#7CFFB2" }}>
                  <div className="flex items-baseline justify-between gap-2 flex-wrap">
                    <div className="font-mono text-emerald-100 text-[13px] leading-snug">
                      <span className="text-emerald-700 mr-2">{String(i+1).padStart(2,"0")}</span>{ev.title}
                    </div>
                    <div className="font-mono text-[10px] text-amber-300">{ev.date}</div>
                  </div>
                  <div className="font-mono text-[11px] text-emerald-500 mt-1.5 leading-relaxed line-clamp-2">{ev.summary}</div>
                </button>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
