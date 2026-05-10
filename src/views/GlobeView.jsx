import React, { useState, useRef, useEffect } from "react";
import { AGENCY_COLORS } from "../data/events.js";
import { GlitchText, MiniChip, groupBy } from "../components/Primitives.jsx";

export default function GlobeView({ events, onSelect }) {
  const [rotation, setRotation] = useState({ lon: -20, lat: 15 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef({ x: 0, y: 0, lon: 0, lat: 0 });

  const earthEvents = events.filter(e => e.region !== "Space");
  const spaceEvents = events.filter(e => e.region === "Space");

  const startDrag = (x,y) => { setDragging(true); dragRef.current = { x, y, lon: rotation.lon, lat: rotation.lat }; };
  const moveDrag = (x,y) => {
    if (!dragging) return;
    setRotation({
      lon: dragRef.current.lon + (x - dragRef.current.x) * 0.4,
      lat: Math.max(-85, Math.min(85, dragRef.current.lat - (y - dragRef.current.y) * 0.4)),
    });
  };
  const endDrag = () => setDragging(false);

  useEffect(() => {
    if (dragging) return;
    const id = setInterval(() => setRotation(r => ({ ...r, lon: r.lon + 0.15 })), 50);
    return () => clearInterval(id);
  }, [dragging]);

  const project = (lat, lon) => {
    const phi = (lat * Math.PI) / 180;
    const lam = ((lon - rotation.lon) * Math.PI) / 180;
    const phi0 = (rotation.lat * Math.PI) / 180;
    const cosc = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(lam);
    if (cosc < 0) return null;
    return {
      x: Math.cos(phi) * Math.sin(lam),
      y: Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(lam),
      depth: cosc,
    };
  };
  const R = 180, cx = 200, cy = 200;

  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]"><GlitchText>┃ GEOSPATIAL</GlitchText></h2>
        <div className="font-mono text-[10px] text-emerald-700">DRAG TO ROTATE</div>
      </div>
      <div className="grid lg:grid-cols-[1fr,1fr] gap-6 items-start">
        <div onMouseDown={e => startDrag(e.clientX, e.clientY)} onMouseMove={e => moveDrag(e.clientX, e.clientY)}
          onMouseUp={endDrag} onMouseLeave={endDrag}
          onTouchStart={e => startDrag(e.touches[0].clientX, e.touches[0].clientY)}
          onTouchMove={e => moveDrag(e.touches[0].clientX, e.touches[0].clientY)} onTouchEnd={endDrag}
          className="relative aspect-square max-w-[440px] mx-auto select-none cursor-grab active:cursor-grabbing"
          style={{ touchAction: "none" }}>
          <svg viewBox="0 0 400 400" className="w-full h-full">
            <defs>
              <radialGradient id="globeGlow"><stop offset="0%" stopColor="#7CFFB2" stopOpacity="0" /><stop offset="85%" stopColor="#7CFFB2" stopOpacity="0" /><stop offset="100%" stopColor="#7CFFB2" stopOpacity="0.4" /></radialGradient>
              <radialGradient id="globeFill" cx="35%" cy="35%"><stop offset="0%" stopColor="#0a2820" /><stop offset="100%" stopColor="#020806" /></radialGradient>
            </defs>
            <circle cx={cx} cy={cy} r={R + 10} fill="url(#globeGlow)" />
            <circle cx={cx} cy={cy} r={R} fill="url(#globeFill)" stroke="#7CFFB2" strokeWidth="0.5" opacity="0.6" />
            {[-60,-30,0,30,60].map(lat => {
              const points = [];
              for (let lon = -180; lon <= 180; lon += 5) { const p = project(lat, lon); if (p) points.push(`${cx + p.x * R},${cy - p.y * R}`); }
              return points.length > 1 ? <polyline key={`lat-${lat}`} points={points.join(" ")} fill="none" stroke="#7CFFB2" strokeWidth="0.3" opacity="0.25" /> : null;
            })}
            {Array.from({length:12}).map((_,i) => {
              const lon = -180 + i*30; const points = [];
              for (let lat = -85; lat <= 85; lat += 5) { const p = project(lat, lon); if (p) points.push(`${cx + p.x * R},${cy - p.y * R}`); }
              return points.length > 1 ? <polyline key={`lon-${i}`} points={points.join(" ")} fill="none" stroke="#7CFFB2" strokeWidth="0.3" opacity="0.25" /> : null;
            })}
            {(() => { const points = [];
              for (let lon = -180; lon <= 180; lon += 3) { const p = project(0, lon); if (p) points.push(`${cx + p.x * R},${cy - p.y * R}`); }
              return <polyline points={points.join(" ")} fill="none" stroke="#FFD93D" strokeWidth="0.5" opacity="0.5" />;
            })()}
            {earthEvents.map(e => {
              const p = project(e.coords[0], e.coords[1]); if (!p) return null;
              const x = cx + p.x * R, y = cy - p.y * R;
              const color = AGENCY_COLORS[e.agency] || "#7CFFB2";
              const size = e.flag === "anchor" ? 4 : 2.5;
              return (
                <g key={e.id} onClick={() => onSelect(e)} className="cursor-pointer">
                  <circle cx={x} cy={y} r={size + 4} fill={color} opacity={0.15 * p.depth} />
                  <circle cx={x} cy={y} r={size} fill={color} opacity={p.depth}>
                    {e.flag === "anchor" && <animate attributeName="r" values={`${size};${size+3};${size}`} dur="2s" repeatCount="indefinite" />}
                  </circle>
                </g>
              );
            })}
          </svg>
          <div className="absolute bottom-1 left-1 font-mono text-[9px] text-emerald-700">
            LON {rotation.lon.toFixed(1)}° / LAT {rotation.lat.toFixed(1)}°
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
