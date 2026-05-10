import React, { useState } from "react";
import { ENTITIES, ENTITY_KIND } from "../data/entities.js";
import { GlitchText, MiniChip } from "../components/Primitives.jsx";

const SECTIONS = [
  { kind: "morphology", title: "MORPHOLOGY — what the objects look like" },
  { kind: "behavior",   title: "BEHAVIOR — how they move" },
  { kind: "sensor",     title: "SENSOR MODALITY — how they were seen" },
  { kind: "platform",   title: "PLATFORM — what was looking" },
  { kind: "command",    title: "COMMAND — who filed it" },
];

export default function PatternsView({ events, onSelect }) {
  const eventIds = new Set(events.map(e => e.id));
  const [active, setActive] = useState(null);

  const sections = SECTIONS.map(s => ({
    ...s,
    rows: ENTITIES
      .filter(e => e.kind === s.kind)
      .map(e => ({ ent: e, evs: e.events.map(id => events.find(x => x.id === id)).filter(Boolean) }))
      .filter(r => r.evs.length > 0)
      .sort((a,b) => b.evs.length - a.evs.length),
  }));

  const focused = active ? ENTITIES.find(e => e.id === active) : null;
  const focusedEvents = focused ? focused.events.map(id => events.find(x => x.id === id)).filter(Boolean) : [];

  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]"><GlitchText>┃ PATTERNS</GlitchText></h2>
        <div className="font-mono text-[10px] text-emerald-700">SIGNATURES THAT REPEAT ACROSS THE CORPUS</div>
      </div>

      <div className="grid lg:grid-cols-[1.4fr,1fr] gap-4">
        <div className="space-y-5">
          {sections.map(s => {
            const max = Math.max(...s.rows.map(r => r.evs.length), 1);
            const meta = ENTITY_KIND[s.kind];
            return (
              <div key={s.kind} className="border border-emerald-700/40 bg-black/40 rounded-sm p-4">
                <div className="font-mono text-[10px] tracking-widest mb-3" style={{ color: meta.color }}>
                  {meta.glyph} {s.title}
                </div>
                <div className="space-y-1.5">
                  {s.rows.map(({ ent, evs }) => {
                    const isActive = active === ent.id;
                    const w = (evs.length / max) * 100;
                    return (
                      <button key={ent.id} onClick={() => setActive(isActive ? null : ent.id)}
                        className={`w-full text-left font-mono text-[11px] py-1 px-2 rounded-sm relative overflow-hidden transition-all hover:bg-emerald-950/40 ${
                          isActive ? "outline outline-1 outline-amber-400" : ""}`}>
                        <div className="absolute inset-y-0 left-0 opacity-15" style={{ width: `${w}%`, backgroundColor: meta.color }} />
                        <div className="relative flex items-center justify-between gap-2">
                          <span className="text-emerald-100">{ent.name}</span>
                          <span className="opacity-60 text-[10px]" style={{ color: meta.color }}>× {evs.length}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <aside className="border border-emerald-700/40 bg-black/40 rounded-sm p-4 min-h-[260px] sticky top-24 self-start">
          {!focused ? (
            <div className="font-mono text-[11px] text-emerald-700 leading-relaxed">
              <div className="text-amber-400 tracking-wider mb-2">▌ READING THE BARS</div>
              Each row is a <span className="text-emerald-300">signature</span> — a recurring shape, behavior, sensor modality, platform, or command. The bar is how many records share it.
              <div className="mt-3 text-emerald-600">Click a row to see exactly which records exhibit that signature. Cross-section is where the case for non-prosaic explanation lives.</div>
            </div>
          ) : (
            <div>
              <div className="font-mono text-[9px] tracking-widest mb-1" style={{ color: ENTITY_KIND[focused.kind].color }}>
                ▌ {ENTITY_KIND[focused.kind].label}
              </div>
              <div className="font-mono text-emerald-100 text-base leading-tight mb-3">{focused.name}</div>
              <div className="font-mono text-[9px] tracking-widest text-emerald-700 mb-2">▌ APPEARS IN ({focusedEvents.length})</div>
              <div className="grid grid-cols-1 gap-1.5">
                {focusedEvents.map(ev => <MiniChip key={ev.id} event={ev} onClick={onSelect} />)}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
