import React, { useEffect, useMemo, useRef, useState } from "react";
import { AGENCY_COLORS } from "../data/events.js";
import { ENTITIES, ENTITY_KIND, EVENT_ENTITIES } from "../data/entities.js";
import { GlitchText, MiniChip } from "../components/Primitives.jsx";
import { sourceStyle, SourceLegend } from "../components/SourceMix.jsx";
import useCorpusStats from "../hooks/useCorpusStats.js";

// FAISS-derived event-event similarity, loaded once and cached.
let _simP = null;
function useSimilarity() {
  const [sim, setSim] = useState(null);
  useEffect(() => {
    if (!_simP) {
      _simP = fetch(`${import.meta.env.BASE_URL}event-similarity.json`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .catch(() => ({ events: {}, dim: 0, eventCount: 0, minCos: 0, topK: 0, generatedAt: null }));
    }
    _simP.then(setSim);
  }, []);
  return sim;
}

// Patterns (shapes / behaviors / sensors) + per-event source mix.
// Loaded once. Patterns gives us a separate spine of nodes from the
// hand-curated entities — the corpus's own text-mined vocabulary.
let _patP = null;
function usePatterns() {
  const [patterns, setPatterns] = useState(null);
  useEffect(() => {
    if (!_patP) _patP = fetch(`${import.meta.env.BASE_URL}patterns.json`).then(r => r.ok ? r.json() : null).catch(() => null);
    _patP.then(setPatterns);
  }, []);
  return patterns;
}

// How many pattern terms per kind to put on the canvas. Higher = richer
// graph but more visual hairball. 8 keeps shape/behavior/sensor
// individually readable while still letting the cluster shape emerge.
const TOP_N_PER_PATTERN_KIND = 8;

const PATTERN_KIND_STYLE = {
  shape:    { label: "SHAPE",    color: "#82B6FF", glyph: "◆" },   // blue
  behavior: { label: "BEHAVIOR", color: "#FFD93D", glyph: "↯" },   // amber
  sensor:   { label: "SENSOR",   color: "#FF87B7", glyph: "◉" },   // pink
};

// Simple force-directed simulator. No deps.
// Nodes have {id, x, y, vx, vy, kind, ref}. Links {a, b}.
// Forces: repulsion (Coulomb-ish), spring on links, mild center pull.

function useForceLayout(nodes, links, opts = {}) {
  const { width = 900, height = 620, iterations = 320 } = opts;
  return useMemo(() => {
    if (!nodes.length) return [];
    // Stable seed via id hash
    const hash = s => { let h = 2166136261; for (let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);} return h>>>0; };
    const N = nodes.map((n,i) => ({
      ...n,
      x: (hash(n.id+"x") % 1000) / 1000 * width,
      y: (hash(n.id+"y") % 1000) / 1000 * height,
      vx: 0, vy: 0,
    }));
    const idx = Object.fromEntries(N.map((n,i) => [n.id, i]));
    const L = links.map(l => ({ a: idx[l.a], b: idx[l.b] })).filter(l => l.a != null && l.b != null);

    const cx = width/2, cy = height/2;
    for (let it = 0; it < iterations; it++) {
      const alpha = 1 - it / iterations;
      // Repulsion
      for (let i = 0; i < N.length; i++) {
        for (let j = i+1; j < N.length; j++) {
          let dx = N[j].x - N[i].x, dy = N[j].y - N[i].y;
          let d2 = dx*dx + dy*dy + 0.01;
          let d = Math.sqrt(d2);
          const k = 1400 / d2; // repulsion strength
          const fx = (dx/d) * k, fy = (dy/d) * k;
          N[i].vx -= fx; N[i].vy -= fy;
          N[j].vx += fx; N[j].vy += fy;
        }
      }
      // Spring along links
      for (const l of L) {
        const a = N[l.a], b = N[l.b];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx*dx + dy*dy) + 0.01;
        const targetLen = 90;
        const force = (d - targetLen) * 0.04;
        const fx = (dx/d) * force, fy = (dy/d) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
      // Center pull + damping
      for (const n of N) {
        n.vx += (cx - n.x) * 0.003;
        n.vy += (cy - n.y) * 0.003;
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += n.vx * alpha;
        n.y += n.vy * alpha;
        n.x = Math.max(20, Math.min(width-20, n.x));
        n.y = Math.max(20, Math.min(height-20, n.y));
      }
    }
    return N;
  }, [nodes, links, width, height, iterations]);
}

const ENTITY_KIND_FILTERS = ["person","program","command","platform","weapon","morphology"];
const PATTERN_KIND_FILTERS = ["shape", "behavior", "sensor"];

export default function NetworkView({ events, onSelect }) {
  const [activeEntityKinds, setActiveEntityKinds] = useState(new Set(ENTITY_KIND_FILTERS));
  const [activePatternKinds, setActivePatternKinds] = useState(new Set(PATTERN_KIND_FILTERS));
  const [hover, setHover] = useState(null);
  const [pinnedId, setPinnedId] = useState(null);
  // entity   = bipartite events↔entities
  // semantic = event↔event edges from FAISS cosine
  // patterns = events↔shapes/behaviors/sensors (text-mined)
  // all      = everything overlaid
  const [graphMode, setGraphMode] = useState("all");
  // Minimum cosine for a semantic edge to appear (tunable)
  const [minCos, setMinCos] = useState(0.55);
  const sim = useSimilarity();
  const patterns = usePatterns();
  const { stats } = useCorpusStats();
  const byEvent = stats?.byEvent || {};
  const svgRef = useRef(null);
  const [size, setSize] = useState({ w: 900, h: 620 });

  useEffect(() => {
    const onResize = () => {
      const el = svgRef.current?.parentElement;
      if (!el) return;
      const w = Math.max(360, el.clientWidth);
      setSize({ w, h: Math.max(420, Math.min(720, w * 0.7)) });
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const eventIds = new Set(events.map(e => e.id));

  // Build nodes/links scoped to filtered events + visible entity/pattern
  // kinds. Edge `kind` ∈ {'entity', 'pattern', 'semantic'}.
  const { nodes, links } = useMemo(() => {
    const nodes = [];
    const links = [];
    for (const ev of events) nodes.push({ id: `e:${ev.id}`, kind: "event", ref: ev });

    // Entity edges
    if (graphMode === "entity" || graphMode === "all") {
      const ents = ENTITIES.filter(e => activeEntityKinds.has(e.kind) && e.events.some(id => eventIds.has(id)));
      for (const en of ents) {
        nodes.push({ id: `n:${en.id}`, kind: en.kind, ref: en });
        for (const evId of en.events)
          if (eventIds.has(evId))
            links.push({ a: `n:${en.id}`, b: `e:${evId}`, kind: "entity", weight: 1 });
      }
    }
    // Pattern edges — text-mined shape/behavior/sensor vocabulary
    if ((graphMode === "patterns" || graphMode === "all") && patterns?.byKind) {
      for (const pk of PATTERN_KIND_FILTERS) {
        if (!activePatternKinds.has(pk)) continue;
        const top = (patterns.byKind[pk] || []).slice(0, TOP_N_PER_PATTERN_KIND);
        for (const row of top) {
          const linked = (row.events || []).filter(e => eventIds.has(e.eid));
          if (!linked.length) continue;
          const nid = `p:${pk}:${row.term}`;
          nodes.push({
            id: nid, kind: `pattern:${pk}`,
            ref: { name: row.term, kind: `pattern:${pk}`, docCount: row.docCount, total: row.total },
          });
          for (const e of linked) {
            links.push({ a: nid, b: `e:${e.eid}`, kind: "pattern", weight: Math.min(1, e.count / 50) });
          }
        }
      }
    }
    // Semantic edges — FAISS event↔event, dedup undirected pairs
    if ((graphMode === "semantic" || graphMode === "all") && sim?.events) {
      const seen = new Set();
      for (const ev of events) {
        const ns = sim.events[ev.id]?.neighbors || [];
        for (const n of ns) {
          if (!eventIds.has(n.eid) || n.cos < minCos) continue;
          const key = ev.id < n.eid ? `${ev.id}|${n.eid}` : `${n.eid}|${ev.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          links.push({ a: `e:${ev.id}`, b: `e:${n.eid}`, kind: "semantic", weight: n.cos });
        }
      }
    }
    return { nodes, links };
  }, [events, activeEntityKinds, activePatternKinds, graphMode, sim, minCos, patterns]);

  const positioned = useForceLayout(nodes, links, { width: size.w, height: size.h });
  const posIdx = useMemo(() => Object.fromEntries(positioned.map(n => [n.id, n])), [positioned]);

  const focusedId = pinnedId || hover;
  const adjacent = useMemo(() => {
    if (!focusedId) return new Set();
    const set = new Set([focusedId]);
    for (const l of links) {
      if (l.a === focusedId) set.add(l.b);
      if (l.b === focusedId) set.add(l.a);
    }
    return set;
  }, [focusedId, links]);

  const toggleEntityKind = k => {
    const next = new Set(activeEntityKinds);
    next.has(k) ? next.delete(k) : next.add(k);
    setActiveEntityKinds(next);
  };
  const togglePatternKind = k => {
    const next = new Set(activePatternKinds);
    next.has(k) ? next.delete(k) : next.add(k);
    setActivePatternKinds(next);
  };

  // Side panel info
  const focused = focusedId ? posIdx[focusedId]?.ref : null;
  const focusedKind = focusedId ? posIdx[focusedId]?.kind : null;
  const isPatternNode = focusedKind?.startsWith("pattern:");

  // Events connected to a focused entity/pattern node
  const focusedEvents = useMemo(() => {
    if (!focused || focusedKind === "event") return [];
    if (isPatternNode) {
      // pull from links
      const evIds = new Set();
      for (const l of links) {
        if (l.a === focusedId && l.b.startsWith("e:")) evIds.add(l.b.slice(2));
        if (l.b === focusedId && l.a.startsWith("e:")) evIds.add(l.a.slice(2));
      }
      return events.filter(e => evIds.has(e.id));
    }
    return (focused.events || []).map(id => events.find(e => e.id === id)).filter(Boolean);
  }, [focused, focusedKind, focusedId, isPatternNode, links, events]);

  const focusedEntities = focusedKind === "event" && focused
    ? (EVENT_ENTITIES[focused.id] || []).filter(e => activeEntityKinds.has(e.kind))
    : [];

  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]"><GlitchText>┃ NETWORK</GlitchText></h2>
        <div className="font-mono text-[10px] text-emerald-700">
          {nodes.length} NODES // {links.length} EDGES
          {sim?.eventCount > 0 && <> // FAISS sim · {sim.eventCount}ev · ≥{sim.minCos} cos · gen {sim.generatedAt?.slice(0,10)}</>}
          {" // CLICK TO PIN"}
        </div>
      </div>

      {/* Graph mode + semantic threshold */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="font-mono text-[9px] text-emerald-700 tracking-widest mr-1">EDGES</span>
        {[
          { id: "entity",   label: "ENTITY",   c: "#7CFFB2" },
          { id: "patterns", label: "PATTERNS", c: "#FFD93D" },
          { id: "semantic", label: "SEMANTIC", c: "#82B6FF" },
          { id: "all",      label: "ALL",      c: "#7CFFB2" },
        ].map(m => (
          <button key={m.id} onClick={() => setGraphMode(m.id)}
            style={{ transition: "all 150ms cubic-bezier(0.23,1,0.32,1)", borderColor: graphMode === m.id ? m.c : "#16382A", color: graphMode === m.id ? m.c : "#549A76" }}
            className="px-2.5 py-1 rounded-sm border font-mono text-[10px] tracking-widest active:scale-[0.97]">
            {m.label}
          </button>
        ))}
        {(graphMode === "semantic" || graphMode === "all") && (
          <span className="font-mono text-[10px] text-emerald-700 ml-3 flex items-center gap-2">
            <span className="tracking-widest text-[9px]">SIM ≥</span>
            <input type="range" min="0.40" max="0.85" step="0.05" value={minCos}
              onChange={(e) => setMinCos(Number(e.target.value))}
              className="accent-cyan-400 w-24" />
            <span className="text-cyan-400 tabular-nums">{minCos.toFixed(2)}</span>
          </span>
        )}
      </div>

      {/* Kind filters — entities + patterns side by side */}
      <div className="flex flex-wrap gap-x-3 gap-y-2 mb-2">
        <div className="flex flex-wrap gap-2 items-center">
          <span className="font-mono text-[9px] text-emerald-700 tracking-widest">ENT</span>
          {ENTITY_KIND_FILTERS.map(k => {
            const meta = ENTITY_KIND[k];
            const active = activeEntityKinds.has(k);
            return (
              <button key={k} onClick={() => toggleEntityKind(k)}
                className={`px-2 py-0.5 rounded-sm border font-mono text-[10px] tracking-wider transition-all ${
                  active ? "border-current" : "border-emerald-900/50 opacity-30"}`}
                style={{ color: meta.color }}>
                {meta.glyph} {meta.label}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <span className="font-mono text-[9px] text-emerald-700 tracking-widest">PAT</span>
          {PATTERN_KIND_FILTERS.map(k => {
            const meta = PATTERN_KIND_STYLE[k];
            const active = activePatternKinds.has(k);
            return (
              <button key={k} onClick={() => togglePatternKind(k)}
                className={`px-2 py-0.5 rounded-sm border font-mono text-[10px] tracking-wider transition-all ${
                  active ? "border-current" : "border-emerald-900/50 opacity-30"}`}
                style={{ color: meta.color }}>
                {meta.glyph} {meta.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Source legend — event color encoding key */}
      <div className="mb-3"><SourceLegend /></div>

      <div className="grid lg:grid-cols-[1fr,320px] gap-4">
        <div className="border border-emerald-700/40 bg-black/40 rounded-sm relative overflow-hidden">
          <svg ref={svgRef} viewBox={`0 0 ${size.w} ${size.h}`} className="w-full h-auto block" onClick={() => setPinnedId(null)}>
            {/* Edges */}
            {links.map((l, i) => {
              const a = posIdx[l.a], b = posIdx[l.b];
              if (!a || !b) return null;
              const dim = focusedId && !(adjacent.has(l.a) && adjacent.has(l.b));
              const isSem  = l.kind === "semantic";
              const isPat  = l.kind === "pattern";
              const stroke = isSem ? "#82B6FF" : isPat ? "#FFD93D" : "#7CFFB2";
              const width  = isSem ? Math.max(0.4, (l.weight - 0.4) * 4)
                           : isPat ? Math.max(0.4, l.weight * 1.6)
                           : 0.8;
              const baseOp = isSem ? Math.min(0.7, l.weight * 0.7)
                           : isPat ? Math.min(0.55, 0.25 + l.weight * 0.4)
                           : 0.45;
              return (
                <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={dim ? "#0f3a2c" : stroke}
                  strokeWidth={dim ? 0.3 : width}
                  opacity={dim ? 0.18 : baseOp} />
              );
            })}
            {/* Nodes */}
            {positioned.map(n => {
              const isEvent = n.kind === "event";
              const isPattern = n.kind?.startsWith("pattern:");
              const dim = focusedId && !adjacent.has(n.id);

              // Event node: color by dominant best_source, size by chars
              // (log-scaled), ring if any pages need review.
              let fill, r, reviewRing = false;
              if (isEvent) {
                const ev = n.ref;
                const stat = byEvent?.[ev.id];
                const src = stat?.dominantBest;
                fill = src ? sourceStyle(src).hex : (AGENCY_COLORS[ev.agency] || "#7CFFB2");
                const chars = stat?.chars || 0;
                // 4–10 px; log scale so a 200k-char event isn't 30x bigger than a 2k one.
                r = Math.max(4, Math.min(10, 3 + Math.log10(Math.max(1, chars / 200))));
                if (ev.flag === "anchor") r = Math.max(r, 7.5);
                reviewRing = (stat?.needsReview || 0) > 0;
              } else if (isPattern) {
                const pk = n.kind.split(":")[1];
                fill = PATTERN_KIND_STYLE[pk]?.color || "#FFD93D";
                r = 4 + Math.min(3, Math.log10(Math.max(1, n.ref.docCount || 1)));
              } else {
                fill = ENTITY_KIND[n.kind]?.color || "#7CFFB2";
                r = 4;
              }
              return (
                <g key={n.id}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={(e) => { e.stopPropagation(); if (isEvent) onSelect(n.ref); else setPinnedId(pinnedId === n.id ? null : n.id); }}
                  style={{ cursor: "pointer", opacity: dim ? 0.25 : 1 }}>
                  <circle cx={n.x} cy={n.y} r={r+4} fill={fill} opacity={isEvent ? 0.15 : 0.1} />
                  <circle cx={n.x} cy={n.y} r={r} fill={fill} stroke={isEvent ? "#020806" : "transparent"} strokeWidth={isEvent ? 1 : 0} />
                  {(isEvent && n.ref.flag === "anchor") && <circle cx={n.x} cy={n.y} r={r+2} fill="none" stroke={fill} strokeWidth="0.5" />}
                  {/* Review ring — amber dashed outline when this event has
                      pages needing human review. Loud on purpose. */}
                  {isEvent && reviewRing && (
                    <circle cx={n.x} cy={n.y} r={r+2.5} fill="none" stroke="#fbbf24" strokeWidth="1" strokeDasharray="2 2" opacity="0.85" />
                  )}
                  {focusedId === n.id && (
                    <text x={n.x + r + 4} y={n.y + 3} fill={fill} fontSize="10" fontFamily="monospace" pointerEvents="none">
                      {isEvent ? n.ref.title.slice(0, 36) : n.ref.name}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        {/* Side panel */}
        <aside className="border border-emerald-700/40 bg-black/40 rounded-sm p-3 min-h-[280px]">
          {!focused && (
            <div className="font-mono text-[11px] text-emerald-700 leading-relaxed space-y-3">
              <div>
                <div className="text-amber-400 tracking-wider mb-1">▌ HOW TO READ</div>
                Each circle is an <span className="text-emerald-300">event</span>, hand-curated <span className="text-emerald-300">entity</span>, or text-mined <span style={{color: "#FFD93D"}}>pattern</span> (shape, behavior, sensor). Hover to highlight; click an event to open its dossier.
              </div>
              <div className="border-t border-emerald-900/40 pt-2">
                <div className="text-emerald-700 tracking-wider mb-1 text-[10px]">▌ EVENT NODES</div>
                <div className="text-emerald-700 text-[10px]">
                  Colored by <span className="text-emerald-300">dominant best source</span>. Sized by char count (log scale). <span className="text-amber-300">Amber dashed ring</span> = pages need human review.
                </div>
              </div>
              {patterns?.byKind && (
                <div className="border-t border-emerald-900/40 pt-2">
                  <div className="text-emerald-700 tracking-wider mb-2 text-[10px]">▌ TOP PATTERNS</div>
                  {PATTERN_KIND_FILTERS.map(pk => (
                    <div key={pk} className="mb-1.5">
                      <div className="text-[9px] tracking-widest" style={{color: PATTERN_KIND_STYLE[pk].color}}>
                        {PATTERN_KIND_STYLE[pk].glyph} {PATTERN_KIND_STYLE[pk].label}
                      </div>
                      <div className="text-emerald-700 text-[10px] mt-0.5">
                        {(patterns.byKind[pk] || []).slice(0, 5).map(r => (
                          <span key={r.term} className="mr-2"><span className="text-emerald-300">{r.term}</span><span className="opacity-50">·{r.docCount}d</span></span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {focused && focusedKind === "event" && (
            <div>
              <div className="font-mono text-[9px] tracking-widest text-amber-400 mb-1">▌ EVENT</div>
              <div className="font-mono text-emerald-100 text-sm leading-tight mb-1">{focused.title}</div>
              {(() => {
                const stat = byEvent?.[focused.id];
                if (!stat) return null;
                return (
                  <div className="font-mono text-[10px] text-emerald-700 mb-2 flex items-center gap-1.5 flex-wrap">
                    {stat.sources.map(s => (
                      <span key={s} className={`inline-flex items-center gap-1 ${sourceStyle(s).text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${sourceStyle(s).dot}`} />{sourceStyle(s).label}
                      </span>
                    ))}
                    <span className="opacity-50">·</span>
                    <span>{stat.pages}p</span>
                    <span className="opacity-50">·</span>
                    <span>{(stat.chars/1000).toFixed(0)}K</span>
                    {stat.needsReview > 0 && <span className="text-amber-300">· {stat.needsReview} need review</span>}
                  </div>
                );
              })()}
              <button onClick={() => onSelect(focused)} className="font-mono text-[10px] text-amber-300 hover:text-amber-100 mb-3">→ OPEN DOSSIER</button>
              <div className="font-mono text-[9px] tracking-widest text-emerald-700 mb-2">▌ CONNECTS THROUGH ({focusedEntities.length})</div>
              <div className="space-y-1">
                {focusedEntities.map(en => (
                  <button key={en.id} onClick={() => setPinnedId(`n:${en.id}`)} className="block w-full text-left font-mono text-[11px] hover:bg-emerald-950/40 rounded px-1 py-0.5"
                    style={{ color: ENTITY_KIND[en.kind].color }}>
                    {ENTITY_KIND[en.kind].glyph} {en.name} <span className="opacity-50 text-[9px]">×{en.events.length}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {focused && isPatternNode && (
            <div>
              <div className="font-mono text-[9px] tracking-widest mb-1" style={{ color: PATTERN_KIND_STYLE[focusedKind.split(":")[1]].color }}>
                ▌ {PATTERN_KIND_STYLE[focusedKind.split(":")[1]].label}
              </div>
              <div className="font-mono text-emerald-100 text-base leading-tight mb-1">{focused.name}</div>
              <div className="font-mono text-[10px] text-emerald-700 mb-3">
                in {focused.docCount} events · {focused.total?.toLocaleString()} total mentions
              </div>
              <div className="font-mono text-[9px] tracking-widest text-emerald-700 mb-2">▌ APPEARS IN ({focusedEvents.length})</div>
              <div className="space-y-1.5">
                {focusedEvents.map(ev => <MiniChip key={ev.id} event={ev} onClick={onSelect} />)}
              </div>
            </div>
          )}
          {focused && focusedKind && focusedKind !== "event" && !isPatternNode && (
            <div>
              <div className="font-mono text-[9px] tracking-widest mb-1" style={{ color: ENTITY_KIND[focusedKind].color }}>
                ▌ {ENTITY_KIND[focusedKind].label}
              </div>
              <div className="font-mono text-emerald-100 text-base leading-tight mb-3">{focused.name}</div>
              <div className="font-mono text-[9px] tracking-widest text-emerald-700 mb-2">▌ APPEARS IN ({focusedEvents.length})</div>
              <div className="space-y-1.5">
                {focusedEvents.map(ev => <MiniChip key={ev.id} event={ev} onClick={onSelect} />)}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
