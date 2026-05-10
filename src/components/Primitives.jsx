import React from "react";
import { AGENCY_COLORS } from "../data/events.js";

export function ScanlineOverlay() {
  return <div className="pointer-events-none fixed inset-0 z-50" style={{
    backgroundImage: "repeating-linear-gradient(0deg, rgba(0,0,0,0.15) 0px, rgba(0,0,0,0.15) 1px, transparent 1px, transparent 3px)",
    mixBlendMode: "multiply",
  }} />;
}
export function GrainOverlay() {
  return <div className="pointer-events-none fixed inset-0 z-40 opacity-[0.06]" style={{
    backgroundImage: 'url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/></filter><rect width="200" height="200" filter="url(%23n)" opacity="0.5"/></svg>\')',
  }} />;
}
export function VignetteOverlay() {
  return <div className="pointer-events-none fixed inset-0 z-30" style={{
    background: "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.6) 100%)",
  }} />;
}

export function GlitchText({ children, className = "" }) {
  return <span className={`relative inline-block ${className}`} style={{
    textShadow: "0 0 1px #7CFFB2, 0.5px 0 0 rgba(255,140,66,0.5), -0.5px 0 0 rgba(130,182,255,0.5)",
  }}>{children}</span>;
}

export function RadarSweep({ size = 220 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className="opacity-50">
      <defs>
        <radialGradient id="sweepGrad">
          <stop offset="0%" stopColor="#7CFFB2" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#7CFFB2" stopOpacity="0" />
        </radialGradient>
      </defs>
      {[48,36,24,12].map(r => <circle key={r} cx="50" cy="50" r={r} fill="none" stroke="#7CFFB2" strokeWidth="0.3" opacity="0.35" />)}
      <line x1="50" y1="50" x2="50" y2="2" stroke="#7CFFB2" strokeWidth="0.3" opacity="0.4" />
      <line x1="50" y1="50" x2="98" y2="50" stroke="#7CFFB2" strokeWidth="0.3" opacity="0.4" />
      <g style={{ transformOrigin: "50px 50px", animation: "radarSpin 6s linear infinite" }}>
        <path d="M 50 50 L 50 2 A 48 48 0 0 1 89.4 23 Z" fill="url(#sweepGrad)" />
      </g>
    </svg>
  );
}

export function flagBg(flag) {
  if (flag === "anchor") return "bg-amber-400/15 border-amber-400/60";
  if (flag === "high")   return "bg-emerald-400/10 border-emerald-400/50";
  if (flag === "med")    return "bg-blue-400/8 border-blue-400/30";
  return "bg-emerald-700/10 border-emerald-700/30";
}

export function MiniChip({ event, onClick }) {
  const color = AGENCY_COLORS[event.agency] || "#7CFFB2";
  return (
    <button onClick={() => onClick(event)}
      className={`text-left rounded-sm border px-2 py-1.5 hover:scale-[1.02] active:scale-[0.98] transition-all ${flagBg(event.flag)}`}>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[9px] tracking-wider opacity-70" style={{ color }}>
          {event.agency.replace("Department of ","DEPT/").toUpperCase().slice(0,7)}
        </span>
        {event.flag === "anchor" && <span className="text-amber-400 text-[8px]">●</span>}
      </div>
      <div className="text-emerald-100 text-[11px] leading-tight mt-0.5 line-clamp-2 font-mono">{event.title}</div>
      <div className="text-emerald-600 text-[9px] mt-0.5 font-mono">{event.date}</div>
    </button>
  );
}

export function groupBy(arr, key) {
  return arr.reduce((acc, x) => {
    const k = typeof key === "function" ? key(x) : x[key];
    (acc[k] = acc[k] || []).push(x);
    return acc;
  }, {});
}
