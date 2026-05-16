import React, { useEffect, useMemo, useState } from "react";
import { ENTITIES, ENTITY_KIND } from "../data/entities.js";
import { GlitchText, MiniChip } from "../components/Primitives.jsx";

// Lazy-load the corpus-wide text-mined patterns once (cached).
let _patternsP = null;
function usePatterns() {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!_patternsP) {
      _patternsP = fetch(`${import.meta.env.BASE_URL}patterns.json`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .catch(() => null);
    }
    _patternsP.then(setData);
  }, []);
  return data;
}

const CURATED_SECTIONS = [
  { kind: "morphology", title: "MORPHOLOGY — what the objects look like" },
  { kind: "behavior",   title: "BEHAVIOR — how they move" },
  { kind: "sensor",     title: "SENSOR MODALITY — how they were seen" },
  { kind: "platform",   title: "PLATFORM — what was looking" },
  { kind: "command",    title: "COMMAND — who filed it" },
];

const TEXT_SECTIONS = [
  { kind: "shape",    title: "SHAPE — descriptors in the actual text",       color: "#7CFFB2" },
  { kind: "behavior", title: "BEHAVIOR — how they're described as moving",   color: "#FF6B9D" },
  { kind: "sensor",   title: "SENSOR — modalities mentioned in the reports", color: "#B794F4" },
  { kind: "entity",   title: "ENTITIES — proper nouns and agencies",         color: "#82B6FF" },
  { kind: "date",     title: "DATES — references found across the corpus",   color: "#FFD93D" },
];

export default function PatternsView({ events, onSelect }) {
  const eventIds = new Set(events.map(e => e.id));
  const eventById = useMemo(() => Object.fromEntries(events.map(e => [e.id, e])), [events]);
  const [activeEntity, setActiveEntity] = useState(null);
  const [activeText, setActiveText] = useState(null);   // {kind, term}
  const [lens, setLens] = useState("text");             // 'text' | 'curated' | 'both'
  const patterns = usePatterns();

  // Curated entity-based bars (legacy)
  const curatedSections = CURATED_SECTIONS.map(s => ({
    ...s,
    rows: ENTITIES
      .filter(e => e.kind === s.kind)
      .map(e => ({ ent: e, evs: e.events.map(id => events.find(x => x.id === id)).filter(Boolean) }))
      .filter(r => r.evs.length > 0)
      .sort((a,b) => b.evs.length - a.evs.length),
  }));

  // Text-mined bars from patterns.json
  const textSections = useMemo(() => {
    if (!patterns?.byKind) return [];
    return TEXT_SECTIONS.map(s => {
      const rows = (patterns.byKind[s.kind] || [])
        // Only show rows whose events overlap our filtered set
        .map(r => ({
          ...r,
          eventsInScope: r.events.filter(({ eid }) => eventIds.has(eid)),
        }))
        .filter(r => r.eventsInScope.length > 0)
        .sort((a, b) => b.eventsInScope.length - a.eventsInScope.length || b.total - a.total);
      return { ...s, rows };
    });
  }, [patterns, eventIds]);

  const focusedEntity = activeEntity ? ENTITIES.find(e => e.id === activeEntity) : null;
  const focusedEntityEvents = focusedEntity ? focusedEntity.events.map(id => eventById[id]).filter(Boolean) : [];
  const focusedTextRow = activeText && patterns?.byKind?.[activeText.kind]?.find(r => r.term === activeText.term);
  const focusedTextEvents = focusedTextRow
    ? focusedTextRow.events.filter(({eid}) => eventIds.has(eid)).map(({eid, count}) => ({ ev: eventById[eid], count }))
    : [];

  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]"><GlitchText>┃ PATTERNS</GlitchText></h2>
        <div className="font-mono text-[10px] text-emerald-700">
          {patterns ? <>SIGNATURES THAT REPEAT · {patterns.sourceDocs} docs · gen {patterns.generatedAt?.slice(0,10)}</> : "SIGNATURES THAT REPEAT ACROSS THE CORPUS"}
        </div>
      </div>

      {/* Lens toggle */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="font-mono text-[9px] text-emerald-700 tracking-widest mr-1">LENS</span>
        {[
          { id: "text",    label: "TEXT-MINED",       c: "#82B6FF", help: "regex over the actual extracted document text" },
          { id: "curated", label: "HAND-CURATED",     c: "#7CFFB2", help: "entities written into events.js by hand" },
          { id: "both",    label: "BOTH",             c: "#FFD93D", help: "show both layers side-by-side" },
        ].map(m => (
          <button key={m.id} onClick={() => setLens(m.id)}
            title={m.help}
            style={{ transition: "all 150ms cubic-bezier(0.23,1,0.32,1)", borderColor: lens === m.id ? m.c : "#16382A", color: lens === m.id ? m.c : "#549A76" }}
            className="px-2.5 py-1 rounded-sm border font-mono text-[10px] tracking-widest active:scale-[0.97]">
            {m.label}
          </button>
        ))}
        {patterns && (
          <span className="font-mono text-[9px] text-emerald-700 ml-auto">
            text-mined from {patterns.sourceDocs} docs · regex over the actual extracted vision + OCR text
          </span>
        )}
      </div>

      <div className="grid lg:grid-cols-[1.4fr,1fr] gap-4">
        <div className="space-y-5">
          {/* TEXT-MINED SECTIONS */}
          {(lens === "text" || lens === "both") && textSections.map(s => {
            const max = Math.max(...s.rows.map(r => r.eventsInScope.length), 1);
            return (
              <div key={`text-${s.kind}`} className="border border-cyan-700/40 bg-cyan-950/10 rounded-sm p-4">
                <div className="flex items-baseline justify-between mb-3">
                  <div className="font-mono text-[10px] tracking-widest" style={{ color: s.color }}>▌ {s.title}</div>
                  <div className="font-mono text-[9px] text-emerald-700 tracking-widest">from extracted text</div>
                </div>
                {s.rows.length === 0 ? (
                  <div className="font-mono text-[10px] text-emerald-700">no occurrences in current filter</div>
                ) : (
                  <div className="space-y-1.5">
                    {s.rows.slice(0, 18).map(({ term, total, eventsInScope }) => {
                      const isActive = activeText?.kind === s.kind && activeText?.term === term;
                      const w = (eventsInScope.length / max) * 100;
                      return (
                        <button key={term}
                          onClick={() => { setActiveText(isActive ? null : { kind: s.kind, term }); setActiveEntity(null); }}
                          style={{ transition: "all 150ms cubic-bezier(0.23,1,0.32,1)" }}
                          className={`w-full text-left font-mono text-[11px] py-1 px-2 rounded-sm relative overflow-hidden hover:bg-cyan-950/40 active:scale-[0.995] ${isActive ? "outline outline-1 outline-amber-400" : ""}`}>
                          <div className="absolute inset-y-0 left-0 opacity-15" style={{ width: `${w}%`, backgroundColor: s.color }} />
                          <div className="relative flex items-center justify-between gap-2">
                            <span className="text-emerald-100 truncate">{term}</span>
                            <span className="opacity-60 text-[10px] tabular-nums" style={{ color: s.color }}>
                              {eventsInScope.length} doc{eventsInScope.length===1?"":"s"} · {total}m
                            </span>
                          </div>
                        </button>
                      );
                    })}
                    {s.rows.length > 18 && (
                      <div className="font-mono text-[9px] text-emerald-700 pt-1 pl-2">… +{s.rows.length - 18} more</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* CURATED SECTIONS */}
          {(lens === "curated" || lens === "both") && curatedSections.map(s => {
            const max = Math.max(...s.rows.map(r => r.evs.length), 1);
            const meta = ENTITY_KIND[s.kind];
            return (
              <div key={`curated-${s.kind}`} className="border border-emerald-700/40 bg-black/40 rounded-sm p-4">
                <div className="flex items-baseline justify-between mb-3">
                  <div className="font-mono text-[10px] tracking-widest" style={{ color: meta.color }}>
                    {meta.glyph} {s.title}
                  </div>
                  <div className="font-mono text-[9px] text-emerald-700 tracking-widest">hand-curated</div>
                </div>
                <div className="space-y-1.5">
                  {s.rows.map(({ ent, evs }) => {
                    const isActive = activeEntity === ent.id;
                    const w = (evs.length / max) * 100;
                    return (
                      <button key={ent.id}
                        onClick={() => { setActiveEntity(isActive ? null : ent.id); setActiveText(null); }}
                        style={{ transition: "all 150ms cubic-bezier(0.23,1,0.32,1)" }}
                        className={`w-full text-left font-mono text-[11px] py-1 px-2 rounded-sm relative overflow-hidden hover:bg-emerald-950/40 active:scale-[0.995] ${isActive ? "outline outline-1 outline-amber-400" : ""}`}>
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
          {!focusedEntity && !focusedTextRow && (
            <div className="font-mono text-[11px] text-emerald-700 leading-relaxed">
              <div className="text-amber-400 tracking-wider mb-2">▌ READING THE BARS</div>
              Each row is a <span className="text-emerald-300">signature</span> — recurring shape, behavior, sensor modality, or named entity. The bar is how many records share it.
              <div className="mt-3 text-emerald-600">
                <span className="text-cyan-300">TEXT-MINED</span> signatures come from regex scanning the actual extracted document text (vision + OCR + pdfjs). <span className="text-emerald-300">HAND-CURATED</span> signatures come from entities written into events.js by hand. Both lenses are useful — text-mined is exhaustive but noisy; curated is deliberate but limited.
              </div>
              <div className="mt-3 text-emerald-600">Click a row to see exactly which records exhibit that signature.</div>
            </div>
          )}
          {focusedTextRow && (
            <div>
              <div className="font-mono text-[9px] tracking-widest mb-1 text-cyan-300">
                ▌ {activeText.kind.toUpperCase()} · TEXT-MINED
              </div>
              <div className="font-mono text-emerald-100 text-base leading-tight mb-3">"{focusedTextRow.term}"</div>
              <div className="font-mono text-[10px] text-emerald-600 mb-3">
                {focusedTextRow.total} total mentions across {focusedTextRow.docCount} documents in the full corpus ·
                {" "}{focusedTextEvents.length} in current filter
              </div>
              <div className="font-mono text-[9px] tracking-widest text-emerald-700 mb-2">▌ MENTIONS BY RECORD</div>
              <div className="grid grid-cols-1 gap-1.5">
                {focusedTextEvents.map(({ ev, count }) => (
                  <div key={ev.id} className="relative">
                    <MiniChip event={ev} onClick={onSelect} />
                    <span className="absolute top-1 right-1 font-mono text-[9px] text-cyan-300 tabular-nums">×{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {focusedEntity && (
            <div>
              <div className="font-mono text-[9px] tracking-widest mb-1" style={{ color: ENTITY_KIND[focusedEntity.kind].color }}>
                ▌ {ENTITY_KIND[focusedEntity.kind].label} · HAND-CURATED
              </div>
              <div className="font-mono text-emerald-100 text-base leading-tight mb-3">{focusedEntity.name}</div>
              <div className="font-mono text-[9px] tracking-widest text-emerald-700 mb-2">▌ APPEARS IN ({focusedEntityEvents.length})</div>
              <div className="grid grid-cols-1 gap-1.5">
                {focusedEntityEvents.map(ev => <MiniChip key={ev.id} event={ev} onClick={onSelect} />)}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
