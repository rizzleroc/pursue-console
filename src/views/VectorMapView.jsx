import { useEffect, useMemo, useRef, useState } from "react";
import { EVENTS, AGENCY_COLORS } from "../data/events.js";
import { GlitchText, DocTypeBadge, flagBg } from "../components/Primitives.jsx";

// =====================================================================
// VECTOR MAP — Obsidian-style graph view of the corpus's semantic space.
//
// Every record is one dot. Distance between dots ≈ semantic distance
// between documents (UMAP projection of MiniLM event-mean vectors,
// precomputed at build time by scripts/build-vector-map.mjs into
// public/vector-map.json).
//
// Interactions:
//   - hover:  tooltip with title, agency, date, flag
//   - click:  opens DOSSIER at that record
//   - filter: header filters (agency / release / type / search) fade
//             non-matching dots to 15% opacity but keep them visible so
//             cluster structure stays legible
//
// Rendered as SVG (not canvas) because 150-ish dots is trivial for the
// browser and SVG gives us hit-testing, hover, and accessibility for
// free — no manual mouse math.
// =====================================================================

// LiveFeedView / SearchView filter events using this same taxonomy;
// keep it inline to avoid a tiny shared file that only two views use.
function recordType(e) {
  const t = (e.type || "").toLowerCase();
  if (e.videoId || /video/.test(t)) return "Video";
  if (/audio/.test(t)) return "Audio";
  if (/image|imagery|photo/.test(t)) return "Image";
  return "Document";
}

const eventById = Object.fromEntries(EVENTS.map(e => [e.id, e]));

export default function VectorMapView({ onSelect, headerFilters }) {
  const [map, setMap] = useState(null);
  const [error, setError] = useState(null);
  const [hover, setHover] = useState(null);          // { eid, x, y, event }
  const containerRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  // Load the precomputed coords. Small file (<10 KB) — fetch on mount.
  useEffect(() => {
    let dead = false;
    fetch(`${import.meta.env.BASE_URL}vector-map.json`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(j => { if (!dead) setMap(j); })
      .catch(e => { if (!dead) setError(e.message); });
    return () => { dead = true; };
  }, []);

  // Track container size so the SVG fills the view. ResizeObserver keeps
  // the map responsive without a window-resize listener.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const rect = entries[0].contentRect;
      // Cap height so the map never dominates viewport; 640 px is the
      // sweet spot between "big enough to click without frustration"
      // and "leaves room for the caption + filter bar."
      setSize({ w: Math.max(320, rect.width), h: Math.min(640, Math.max(360, rect.width * 0.7)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Apply the header filters (agency / release / type / search) to fade
  // non-matching dots. We don't remove them — cluster structure is the
  // whole point of the map, and hiding half the dots reads as broken.
  const isDim = useMemo(() => {
    const q = (headerFilters?.query || "").trim().toLowerCase();
    const fA = headerFilters?.filterAgency || "all";
    const fR = headerFilters?.filterRelease || "all";
    const fT = headerFilters?.filterType || "all";
    if (q === "" && fA === "all" && fR === "all" && fT === "all") {
      return () => false;   // no filter → nothing dimmed
    }
    return (event) => {
      if (fA !== "all" && event.agency !== fA) return true;
      if (fT !== "all" && recordType(event) !== fT) return true;
      if (fR !== "all" && (event.release || "Release 01") !== fR) return true;
      if (q && !(
        event.title.toLowerCase().includes(q) ||
        (event.summary || "").toLowerCase().includes(q) ||
        (event.loc || "").toLowerCase().includes(q) ||
        (event.agency || "").toLowerCase().includes(q) ||
        (event.tags || []).some(t => t.toLowerCase().includes(q))
      )) return true;
      return false;
    };
  }, [headerFilters]);

  // Hydrate each map point with its event metadata for color + tooltip.
  // Some points may reference auto-catalogued stubs not in EVENTS — skip.
  const points = useMemo(() => {
    if (!map) return [];
    // Padding leaves the border of the map visible so dots on the edges
    // aren't half-clipped by the viewport rectangle.
    const PAD = 24;
    const innerW = size.w - PAD * 2;
    const innerH = size.h - PAD * 2;
    return map.items
      .map(p => {
        const ev = eventById[p.eid];
        if (!ev) return null;
        return {
          eid: p.eid,
          event: ev,
          cx: PAD + p.x * innerW,
          cy: PAD + p.y * innerH,
          color: AGENCY_COLORS[ev.agency] || "#7CFFB2",
        };
      })
      .filter(Boolean);
  }, [map, size]);

  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]">
          <GlitchText>┃ MAP</GlitchText>
        </h2>
        <div className="font-mono text-[10px] text-emerald-700 tracking-widest">
          UMAP 2D · MiniLM EVENT-MEAN VECTORS · {points.length ? `${points.length} RECORDS` : "LOADING…"}
        </div>
      </div>

      <div className="font-mono text-[11px] text-emerald-700 leading-relaxed mb-3">
        Every record is one dot; distance ≈ semantic distance. Records that share the
        same subject matter cluster together. Hover for details, click to open the dossier.
        Header filters fade non-matching dots.
      </div>

      {error && (
        <div className="border border-rose-400/40 bg-rose-400/5 rounded-sm p-3 font-mono text-[12px] text-rose-300">
          ⊘ Vector map could not be loaded: {error}. Run <code className="text-amber-300">node scripts/build-vector-map.mjs</code>.
        </div>
      )}

      <div ref={containerRef} className="border border-emerald-700/40 bg-black/40 rounded-sm relative overflow-hidden">
        {map && (
          <svg
            width={size.w} height={size.h}
            role="img" aria-label="Semantic vector map of the corpus"
            className="block select-none">
            {/* Background grid — a subtle 10×10 lattice so the eye has
                scale reference when pointing at clusters. Doesn't imply
                any coordinate meaning (UMAP axes aren't interpretable). */}
            {Array.from({ length: 11 }).map((_, i) => (
              <g key={i}>
                <line x1={i * size.w / 10} y1={0} x2={i * size.w / 10} y2={size.h}
                  stroke="#0c2018" strokeWidth={0.5} />
                <line x1={0} y1={i * size.h / 10} x2={size.w} y2={i * size.h / 10}
                  stroke="#0c2018" strokeWidth={0.5} />
              </g>
            ))}

            {/* Dots. Order matters: render dimmed dots first, then highlighted,
                then the hovered one on top, so hover-target is always clickable. */}
            {points.filter(p => isDim(p.event)).map(p => (
              <Dot key={p.eid} p={p} dim onHover={setHover}
                onClick={() => onSelect(p.event)} />
            ))}
            {points.filter(p => !isDim(p.event)).map(p => (
              <Dot key={p.eid} p={p} onHover={setHover}
                onClick={() => onSelect(p.event)}
                anchored={p.event.flag === "anchor"} />
            ))}
          </svg>
        )}

        {hover && <Tooltip hover={hover} containerW={size.w} containerH={size.h} />}
      </div>

      <Legend />
    </div>
  );
}

function Dot({ p, onHover, onClick, dim = false, anchored = false }) {
  // Anchors get a slightly larger dot + faint halo so priority records
  // read at a glance without needing a legend lookup.
  const r = anchored ? 6 : 4.5;
  const opacity = dim ? 0.15 : 1;
  return (
    <g style={{ cursor: "pointer" }}
      onMouseEnter={() => onHover({ eid: p.eid, cx: p.cx, cy: p.cy, event: p.event, color: p.color })}
      onMouseLeave={() => onHover(null)}
      onClick={onClick}>
      {anchored && !dim && (
        <circle cx={p.cx} cy={p.cy} r={r + 4} fill="none"
          stroke={p.color} strokeOpacity={0.35} strokeWidth={1} />
      )}
      <circle cx={p.cx} cy={p.cy} r={r}
        fill={p.color} fillOpacity={opacity}
        stroke="#020806" strokeWidth={0.8} />
    </g>
  );
}

function Tooltip({ hover, containerW, containerH }) {
  const { event, cx, cy, color } = hover;
  // Position the tooltip on whichever side of the dot has more room, so
  // it never clips off the container edge.
  const W = 240;
  const H = 88;
  const left = cx + W + 16 <= containerW ? cx + 12 : cx - W - 12;
  const top = cy + H + 16 <= containerH ? cy + 12 : cy - H - 12;
  return (
    <div
      className="absolute pointer-events-none border rounded-sm p-2 bg-black/90 backdrop-blur-sm"
      style={{
        left, top, width: W,
        borderColor: color + "80",
        boxShadow: `0 0 12px ${color}30`,
      }}>
      <div className="flex items-center gap-2 mb-1">
        <span className="font-mono text-[9px] tracking-wider" style={{ color }}>
          {event.agency.replace("Department of ", "DEPT/")}
        </span>
        <DocTypeBadge docType={event.docType} />
        {event.flag === "anchor" && <span className="text-amber-400 text-[10px]">▲</span>}
        {event.videoId && <span className="font-mono text-[8px] tracking-widest text-blue-300">VIDEO</span>}
        <span className="ml-auto font-mono text-[9px] text-amber-300">{event.date || "—"}</span>
      </div>
      <div className="font-mono text-emerald-100 text-[12px] leading-snug line-clamp-2">
        {event.title}
      </div>
    </div>
  );
}

function Legend() {
  // Only show agencies that actually appear in the catalogue so newly-added
  // agencies show up here for free and dead ones aren't listed.
  const agencies = useMemo(() => {
    return [...new Set(EVENTS.map(e => e.agency).filter(Boolean))].sort();
  }, []);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px]">
      <span className="text-emerald-700 tracking-widest">LEGEND</span>
      {agencies.map(a => (
        <span key={a} className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: AGENCY_COLORS[a] || "#7CFFB2" }} />
          <span className="text-emerald-500">{a.replace("Department of ", "DEPT/")}</span>
        </span>
      ))}
      <span className="text-emerald-800 mx-1">·</span>
      <span className="flex items-center gap-1.5 text-emerald-500">
        <span className="inline-block w-3 h-3 rounded-full border border-amber-400/60" />
        <span>anchor (halo)</span>
      </span>
    </div>
  );
}
