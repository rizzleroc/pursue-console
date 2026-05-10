import React, { useEffect, useMemo, useRef, useState } from "react";
import { AGENCY_COLORS } from "../data/events.js";
import { ENTITIES, ENTITY_KIND, EVENT_ENTITIES } from "../data/entities.js";
import { GlitchText, MiniChip } from "../components/Primitives.jsx";

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

const KIND_FILTERS = ["person","program","command","platform","weapon","sensor","morphology","behavior"];

export default function NetworkView({ events, onSelect }) {
  const [activeKinds, setActiveKinds] = useState(new Set(KIND_FILTERS));
  const [hover, setHover] = useState(null);
  const [pinnedId, setPinnedId] = useState(null);
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

  // Build nodes/links scoped to filtered events + visible entity kinds.
  const { nodes, links } = useMemo(() => {
    const ents = ENTITIES.filter(e => activeKinds.has(e.kind) && e.events.some(id => eventIds.has(id)));
    const nodes = [];
    const links = [];
    for (const ev of events) nodes.push({ id: `e:${ev.id}`, kind: "event", ref: ev });
    for (const en of ents) {
      nodes.push({ id: `n:${en.id}`, kind: en.kind, ref: en });
      for (const evId of en.events) if (eventIds.has(evId)) links.push({ a: `n:${en.id}`, b: `e:${evId}` });
    }
    return { nodes, links };
  }, [events, activeKinds]);

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

  const toggleKind = k => {
    const next = new Set(activeKinds);
    next.has(k) ? next.delete(k) : next.add(k);
    setActiveKinds(next);
  };

  // Side panel info
  const focused = focusedId ? posIdx[focusedId]?.ref : null;
  const focusedKind = focusedId ? posIdx[focusedId]?.kind : null;
  const focusedEvents = focusedKind && focusedKind !== "event" && focused
    ? focused.events.map(id => events.find(e => e.id === id)).filter(Boolean)
    : [];
  const focusedEntities = focusedKind === "event" && focused
    ? (EVENT_ENTITIES[focused.id] || []).filter(e => activeKinds.has(e.kind))
    : [];

  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]"><GlitchText>┃ NETWORK</GlitchText></h2>
        <div className="font-mono text-[10px] text-emerald-700">{nodes.length} NODES // {links.length} EDGES // CLICK TO PIN</div>
      </div>

      {/* Kind filters */}
      <div className="flex flex-wrap gap-2 mb-3">
        {KIND_FILTERS.map(k => {
          const meta = ENTITY_KIND[k];
          const active = activeKinds.has(k);
          return (
            <button key={k} onClick={() => toggleKind(k)}
              className={`px-2.5 py-1 rounded-sm border font-mono text-[10px] tracking-wider transition-all ${
                active ? "border-current" : "border-emerald-900/50 opacity-30"}`}
              style={{ color: meta.color }}>
              {meta.glyph} {meta.label}
            </button>
          );
        })}
      </div>

      <div className="grid lg:grid-cols-[1fr,320px] gap-4">
        <div className="border border-emerald-700/40 bg-black/40 rounded-sm relative overflow-hidden">
          <svg ref={svgRef} viewBox={`0 0 ${size.w} ${size.h}`} className="w-full h-auto block" onClick={() => setPinnedId(null)}>
            {/* Edges */}
            {links.map((l, i) => {
              const a = posIdx[l.a], b = posIdx[l.b];
              if (!a || !b) return null;
              const dim = focusedId && !(adjacent.has(l.a) && adjacent.has(l.b));
              return (
                <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={dim ? "#0f3a2c" : "#7CFFB2"} strokeWidth={dim ? 0.4 : 0.8} opacity={dim ? 0.25 : 0.45} />
              );
            })}
            {/* Nodes */}
            {positioned.map(n => {
              const isEvent = n.kind === "event";
              const dim = focusedId && !adjacent.has(n.id);
              const fill = isEvent ? (AGENCY_COLORS[n.ref.agency] || "#7CFFB2") : ENTITY_KIND[n.kind].color;
              const r = isEvent ? (n.ref.flag === "anchor" ? 7 : 5) : 4;
              return (
                <g key={n.id}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={(e) => { e.stopPropagation(); if (isEvent) onSelect(n.ref); else setPinnedId(pinnedId === n.id ? null : n.id); }}
                  style={{ cursor: "pointer", opacity: dim ? 0.25 : 1 }}>
                  <circle cx={n.x} cy={n.y} r={r+4} fill={fill} opacity={isEvent ? 0.15 : 0.1} />
                  <circle cx={n.x} cy={n.y} r={r} fill={fill} stroke={isEvent ? "#020806" : "transparent"} strokeWidth={isEvent ? 1 : 0} />
                  {(isEvent && n.ref.flag === "anchor") && <circle cx={n.x} cy={n.y} r={r+2} fill="none" stroke={fill} strokeWidth="0.5" />}
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
            <div className="font-mono text-[11px] text-emerald-700 leading-relaxed">
              <div className="text-amber-400 tracking-wider mb-2">▌ HOW TO READ</div>
              Each <span className="text-emerald-300">circle</span> is an event or entity. Edges connect entities to the events that reference them. Hover to highlight, click an entity to pin, click an event to open its dossier. Toggle kinds above to peel back layers.
              <div className="mt-3 text-emerald-600">The cluster you see in the middle is what the corpus actually <span className="text-amber-400">connects through</span> — the names that recur, the morphologies that reappear, the commands that file the same kinds of reports.</div>
            </div>
          )}
          {focused && focusedKind === "event" && (
            <div>
              <div className="font-mono text-[9px] tracking-widest text-amber-400 mb-1">▌ EVENT</div>
              <div className="font-mono text-emerald-100 text-sm leading-tight mb-2">{focused.title}</div>
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
          {focused && focusedKind && focusedKind !== "event" && (
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
