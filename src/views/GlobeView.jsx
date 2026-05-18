import React, { useState, useRef, useEffect, useMemo } from "react";
import { AGENCY_COLORS } from "../data/events.js";
import { GlitchText, MiniChip, groupBy } from "../components/Primitives.jsx";

// =====================================================================
// HI-DEF ORTHOGRAPHIC GLOBE — Palantir-style.
//   · Natural Earth 110m landmass (filled polygons in subtle green)
//   · Country borders as fine graticule (darker)
//   · Atmospheric glow ring + radial gradient sheen
//   · Star-field background (deterministic for stability)
//   · Pulsing event markers with halo + agency-colored core
//   · Day/night terminator hint via the orthographic depth shading
//   · Drag to rotate, auto-rotate when idle
// =====================================================================

// Deterministic PRNG for the starfield so it doesn't dance between renders
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s ^ s >>> 15, 0x2c1b3c6d) ^ s >>> 12) >>> 0; return (s & 0xffffffff) / 0x100000000; };
}
const STARS = (() => {
  const r = rng(0x424242);
  const N = 220;
  const out = [];
  for (let i = 0; i < N; i++) {
    out.push({ x: r() * 400, y: r() * 400, size: r() * 1.1 + 0.15, alpha: r() * 0.6 + 0.15 });
  }
  return out;
})();

const R = 180, CX = 200, CY = 200;

// Orthographic projection — returns null for points on the far side
function makeProjector(rotation) {
  const phi0 = (rotation.lat * Math.PI) / 180;
  const sinPhi0 = Math.sin(phi0), cosPhi0 = Math.cos(phi0);
  return (lat, lon) => {
    const phi = (lat * Math.PI) / 180;
    const lam = ((lon - rotation.lon) * Math.PI) / 180;
    const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
    const cosLam = Math.cos(lam), sinLam = Math.sin(lam);
    const cosc = sinPhi0 * sinPhi + cosPhi0 * cosPhi * cosLam;
    if (cosc < 0) return null;
    return {
      x: CX + (cosPhi * sinLam) * R,
      y: CY - (cosPhi0 * sinPhi - sinPhi0 * cosPhi * cosLam) * R,
      depth: cosc,
    };
  };
}

// Walk a GeoJSON ring [[lon,lat], …] through the projector and return an
// SVG path string. Splits the ring at antimeridian / horizon crossings so
// we don't draw straight lines across the back of the globe.
function ringToPath(coords, project) {
  let d = "";
  let prevVisible = false;
  for (const [lon, lat] of coords) {
    const p = project(lat, lon);
    if (p) {
      d += (prevVisible ? "L" : "M") + p.x.toFixed(1) + " " + p.y.toFixed(1);
      prevVisible = true;
    } else {
      prevVisible = false;
    }
  }
  return d;
}

export default function GlobeView({ events, onSelect }) {
  const [rotation, setRotation] = useState({ lon: -20, lat: 15 });
  const [dragging, setDragging] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [land, setLand] = useState(null);
  const [countries, setCountries] = useState(null);
  const dragRef = useRef({ x: 0, y: 0, lon: 0, lat: 0 });

  // Lazy-load the world geometry once
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}world-110m.json`).then(r => r.json()).then(setLand).catch(() => {});
    fetch(`${import.meta.env.BASE_URL}world-countries-110m.json`).then(r => r.json()).then(setCountries).catch(() => {});
  }, []);

  const earthEvents = events.filter(e => e.region !== "Space");
  const spaceEvents = events.filter(e => e.region === "Space");

  // Drag
  const startDrag = (x, y) => { setDragging(true); dragRef.current = { x, y, lon: rotation.lon, lat: rotation.lat }; };
  const moveDrag = (x, y) => {
    if (!dragging) return;
    setRotation({
      lon: dragRef.current.lon + (x - dragRef.current.x) * 0.4,
      lat: Math.max(-85, Math.min(85, dragRef.current.lat - (y - dragRef.current.y) * 0.4)),
    });
  };
  const endDrag = () => setDragging(false);

  // Auto-rotate when not interacting
  useEffect(() => {
    if (dragging) return;
    const id = setInterval(() => setRotation(r => ({ ...r, lon: r.lon + 0.08 })), 50);
    return () => clearInterval(id);
  }, [dragging]);

  const project = useMemo(() => makeProjector(rotation), [rotation.lon, rotation.lat]);

  // Pre-compute land paths
  const landPaths = useMemo(() => {
    if (!land?.features) return [];
    const out = [];
    for (const f of land.features) {
      const geom = f.geometry;
      const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
      for (const poly of polys) {
        for (const ring of poly) {
          const p = ringToPath(ring, project);
          if (p) out.push(p + " Z");
        }
      }
    }
    return out;
  }, [land, project]);

  const countryPaths = useMemo(() => {
    if (!countries?.features) return [];
    const out = [];
    for (const f of countries.features) {
      const geom = f.geometry;
      const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
      for (const poly of polys) {
        for (const ring of poly) {
          const p = ringToPath(ring, project);
          if (p) out.push(p);
        }
      }
    }
    return out;
  }, [countries, project]);

  // Pre-compute graticule
  const graticule = useMemo(() => {
    const lines = [];
    for (const lat of [-60,-30,0,30,60]) {
      const pts = [];
      for (let lon = -180; lon <= 180; lon += 5) {
        const p = project(lat, lon);
        if (p) pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
      }
      if (pts.length > 1) lines.push({ key: `lat-${lat}`, pts: pts.join(" "), equator: lat === 0 });
    }
    for (let i = 0; i < 12; i++) {
      const lon = -180 + i * 30;
      const pts = [];
      for (let lat = -85; lat <= 85; lat += 5) {
        const p = project(lat, lon);
        if (p) pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
      }
      if (pts.length > 1) lines.push({ key: `lon-${i}`, pts: pts.join(" "), prime: lon === 0 });
    }
    return lines;
  }, [project]);

  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]"><GlitchText>┃ GEOSPATIAL</GlitchText></h2>
        <div className="font-mono text-[10px] text-emerald-700">DRAG TO ROTATE · SCROLL TO ZOOM</div>
      </div>
      <div className="grid lg:grid-cols-[1.3fr,1fr] gap-6 items-start">
        <div
          onMouseDown={e => startDrag(e.clientX, e.clientY)}
          onMouseMove={e => moveDrag(e.clientX, e.clientY)}
          onMouseUp={endDrag} onMouseLeave={endDrag}
          onTouchStart={e => startDrag(e.touches[0].clientX, e.touches[0].clientY)}
          onTouchMove={e => moveDrag(e.touches[0].clientX, e.touches[0].clientY)}
          onTouchEnd={endDrag}
          onWheel={e => { e.preventDefault(); setZoom(z => Math.max(0.7, Math.min(2.4, z - e.deltaY * 0.001))); }}
          className="relative aspect-square max-w-[600px] mx-auto select-none cursor-grab active:cursor-grabbing"
          style={{ touchAction: "none" }}
        >
          <svg viewBox="0 0 400 400" className="w-full h-full" style={{ transform: `scale(${zoom})`, transition: dragging ? "none" : "transform .25s ease-out" }}>
            <defs>
              {/* Outer atmospheric halo */}
              <radialGradient id="atmosphere">
                <stop offset="78%" stopColor="#7CFFB2" stopOpacity="0" />
                <stop offset="93%" stopColor="#7CFFB2" stopOpacity="0.45" />
                <stop offset="100%" stopColor="#7CFFB2" stopOpacity="0" />
              </radialGradient>
              {/* Earth disc shading — bright on the sun-facing side, dim toward terminator */}
              <radialGradient id="earthDisc" cx="35%" cy="32%">
                <stop offset="0%" stopColor="#0d3a2c" stopOpacity="1" />
                <stop offset="55%" stopColor="#062018" stopOpacity="1" />
                <stop offset="100%" stopColor="#020806" stopOpacity="1" />
              </radialGradient>
              {/* Land fill — slightly brighter than oceans */}
              <radialGradient id="landFill" cx="35%" cy="32%">
                <stop offset="0%" stopColor="#1b5c47" stopOpacity="0.95" />
                <stop offset="100%" stopColor="#0a2a20" stopOpacity="0.85" />
              </radialGradient>
              {/* Marker glow */}
              <radialGradient id="markerHalo">
                <stop offset="0%" stopColor="#fff" stopOpacity="0.5" />
                <stop offset="40%" stopColor="currentColor" stopOpacity="0.6" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
              </radialGradient>
              <filter id="markerBlur" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="0.8" />
              </filter>
            </defs>

            {/* Star-field — sits behind everything */}
            {STARS.map((s, i) => (
              <circle key={`s-${i}`} cx={s.x} cy={s.y} r={s.size} fill="#7CFFB2" opacity={s.alpha} />
            ))}

            {/* Outer atmospheric halo */}
            <circle cx={CX} cy={CY} r={R + 24} fill="url(#atmosphere)" />

            {/* Earth disc */}
            <circle cx={CX} cy={CY} r={R} fill="url(#earthDisc)" stroke="#7CFFB2" strokeWidth="0.5" opacity="0.7" />

            {/* Graticule — drawn under landmass for grid-through-water look */}
            {graticule.map(l => (
              <polyline key={l.key} points={l.pts} fill="none"
                stroke={l.equator || l.prime ? "#FFD93D" : "#7CFFB2"}
                strokeWidth={l.equator || l.prime ? 0.4 : 0.25}
                opacity={l.equator || l.prime ? 0.4 : 0.18} />
            ))}

            {/* LANDMASSES — the Palantir signature */}
            {landPaths.map((d, i) => (
              <path key={`land-${i}`} d={d}
                fill="url(#landFill)" stroke="#7CFFB2" strokeWidth="0.35" strokeOpacity="0.55"
                vectorEffect="non-scaling-stroke" />
            ))}

            {/* Country borders — fine inner detail */}
            {countryPaths.map((d, i) => (
              <path key={`c-${i}`} d={d}
                fill="none" stroke="#7CFFB2" strokeWidth="0.15" strokeOpacity="0.30"
                vectorEffect="non-scaling-stroke" />
            ))}

            {/* Limb (edge highlight) */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="#7CFFB2" strokeWidth="0.6" opacity="0.55" />

            {/* EVENT MARKERS — pulsing halo + agency-colored core */}
            {earthEvents.map(e => {
              const p = project(e.coords[0], e.coords[1]);
              if (!p) return null;
              const color = AGENCY_COLORS[e.agency] || "#7CFFB2";
              const isAnchor = e.flag === "anchor";
              const size = isAnchor ? 3.4 : 2.2;
              return (
                <g key={e.id} onClick={() => onSelect(e)} className="cursor-pointer" style={{ color }}>
                  {/* Outer pulse halo for anchors */}
                  {isAnchor && (
                    <>
                      <circle cx={p.x} cy={p.y} r={size + 6} fill="url(#markerHalo)" opacity={0.9 * p.depth}>
                        <animate attributeName="r" values={`${size+3};${size+10};${size+3}`} dur="2.8s" repeatCount="indefinite" />
                        <animate attributeName="opacity" values={`${0.9*p.depth};0;${0.9*p.depth}`} dur="2.8s" repeatCount="indefinite" />
                      </circle>
                    </>
                  )}
                  {/* Glow */}
                  <circle cx={p.x} cy={p.y} r={size + 3} fill={color} opacity={0.22 * p.depth} filter="url(#markerBlur)" />
                  {/* Core */}
                  <circle cx={p.x} cy={p.y} r={size} fill={color} opacity={p.depth} />
                  {/* Inner pip */}
                  <circle cx={p.x} cy={p.y} r={size * 0.4} fill="#fff" opacity={0.85 * p.depth} />
                </g>
              );
            })}

            {/* Center reticle */}
            <g opacity="0.5">
              <line x1={CX-14} y1={CY} x2={CX-5} y2={CY} stroke="#FFD93D" strokeWidth="0.5" />
              <line x1={CX+5} y1={CY} x2={CX+14} y2={CY} stroke="#FFD93D" strokeWidth="0.5" />
              <line x1={CX} y1={CY-14} x2={CX} y2={CY-5} stroke="#FFD93D" strokeWidth="0.5" />
              <line x1={CX} y1={CY+5} x2={CX} y2={CY+14} stroke="#FFD93D" strokeWidth="0.5" />
            </g>
          </svg>

          {/* Telemetry overlay */}
          <div className="absolute bottom-1 left-1 font-mono text-[9px] text-emerald-600 leading-tight">
            <div>LON {rotation.lon.toFixed(2).padStart(7," ")}°</div>
            <div>LAT {rotation.lat.toFixed(2).padStart(7," ")}°</div>
            <div>ZM  {(zoom * 100).toFixed(0).padStart(3," ")}%</div>
          </div>
          <div className="absolute top-1 right-1 font-mono text-[8px] text-emerald-700 tracking-[0.25em]">
            <div>NE 110m · ORTHO · LIVE</div>
            <div className="text-right">RECORDS {earthEvents.length}</div>
          </div>
        </div>

        <div>
          <div className="border border-emerald-700/40 bg-black/40 rounded-sm p-3 mb-3">
            <div className="font-mono text-[10px] text-amber-400 tracking-wider mb-2">✦ EXTRA-PLANETARY ASSETS ({spaceEvents.length})</div>
            <div className="grid sm:grid-cols-2 gap-1.5">{spaceEvents.map(e => <MiniChip key={e.id} event={e} onClick={onSelect} />)}</div>
          </div>
          <div className="border border-emerald-700/40 bg-black/40 rounded-sm p-3">
            <div className="font-mono text-[10px] text-emerald-400 tracking-wider mb-2">⌂ TERRESTRIAL CLUSTERS BY REGION</div>
            {Object.entries(groupBy(earthEvents, "region")).map(([region, evs]) => (
              <details key={region} className="mb-1 group">
                <summary className="cursor-pointer font-mono text-[11px] text-emerald-300 hover:text-amber-300 py-1 list-none">
                  <span className="inline-block w-3 group-open:rotate-90 transition-transform">▶</span>
                  {region} <span className="text-emerald-700 ml-2 text-[9px]">({evs.length})</span>
                </summary>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 ml-4 mt-1">
                  {evs.map(e => <MiniChip key={e.id} event={e} onClick={onSelect} />)}
                </div>
              </details>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
