import React, { useState } from "react";
import { GlitchText, MiniChip, RadarSweep } from "../components/Primitives.jsx";

export default function ConstellationView({ events, onSelect }) {
  const counts = {};
  events.forEach(e => (e.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
  const top = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, 28);
  const [activeKw, setActiveKw] = useState(null);
  const matched = activeKw ? events.filter(e => (e.tags || []).includes(activeKw)) : [];

  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]"><GlitchText>┃ CONSTELLATION</GlitchText></h2>
        <div className="font-mono text-[10px] text-emerald-700">PIVOT BY SHARED TAG</div>
      </div>
      <div className="border border-emerald-700/40 bg-black/40 rounded-sm p-4 sm:p-6 mb-5 relative overflow-hidden">
        <div className="absolute -top-8 -right-8 opacity-30"><RadarSweep size={140} /></div>
        <div className="flex flex-wrap gap-2 sm:gap-3 items-center justify-center relative">
          {top.map(([kw, count]) => {
            const size = 12 + count * 2.5;
            const isActive = activeKw === kw;
            return (
              <button key={kw} onClick={() => setActiveKw(isActive ? null : kw)}
                className={`px-2.5 py-1 rounded-sm font-mono transition-all ${
                  isActive ? "bg-amber-400 text-black scale-110 shadow-[0_0_20px_rgba(255,217,61,0.6)]"
                    : "bg-emerald-950/60 text-emerald-300 hover:bg-emerald-900/80 hover:scale-105"}`}
                style={{ fontSize: `${size}px` }}>
                {kw} <span className="opacity-50 text-[0.7em]">×{count}</span>
              </button>
            );
          })}
        </div>
      </div>
      {activeKw ? (
        <div className="border border-amber-400/50 bg-amber-400/5 rounded-sm p-4 animate-fadein">
          <div className="font-mono text-[11px] text-amber-400 mb-3 tracking-wider">
            ▌ MATCHED ON "{activeKw.toUpperCase()}" — {matched.length} record{matched.length !== 1 && "s"}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">{matched.map(e => <MiniChip key={e.id} event={e} onClick={onSelect} />)}</div>
        </div>
      ) : (
        <div className="text-center py-12 font-mono text-emerald-700 text-xs tracking-wider">▽ TAP A KEYWORD TO SEE WHAT BINDS THE ARCHIVE</div>
      )}
    </div>
  );
}
