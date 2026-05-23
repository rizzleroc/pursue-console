import React from "react";

// Single source of truth for per-source coloring across the whole UI.
// When you see a colored dot anywhere — TIMELINE row, ATLAS cell, NETWORK
// event node, REVIEW header — it means the same thing: the transcription
// source that produced (or is part of) this event's text.
//
// Keep this map STATIC. Tailwind v3 strips template-string class names
// at build, which is why the early ReviewView confidence badges rendered
// uncolored. Every class used here is literal.

export const SOURCE_STYLES = {
  human: {
    label: "HUMAN",
    dot: "bg-amber-400",
    text: "text-amber-300",
    ring: "ring-amber-400",
    bg: "bg-amber-900/30",
    hex: "#fbbf24",
  },
  "gpt-vision": {
    label: "GPT-VISION",
    dot: "bg-emerald-400",
    text: "text-emerald-300",
    ring: "ring-emerald-400",
    bg: "bg-emerald-900/30",
    hex: "#34d399",
  },
  gemini: {
    label: "GEMINI",
    dot: "bg-cyan-400",
    text: "text-cyan-300",
    ring: "ring-cyan-400",
    bg: "bg-cyan-900/30",
    hex: "#22d3ee",
  },
  claude: {
    label: "CLAUDE",
    dot: "bg-orange-400",
    text: "text-orange-300",
    ring: "ring-orange-400",
    bg: "bg-orange-900/30",
    hex: "#fb923c",
  },
  ocr: {
    label: "OCR",
    dot: "bg-rose-400",
    text: "text-rose-300",
    ring: "ring-rose-400",
    bg: "bg-rose-900/30",
    hex: "#fb7185",
  },
  pdfjs: {
    label: "PDFJS",
    dot: "bg-zinc-400",
    text: "text-zinc-300",
    ring: "ring-zinc-400",
    bg: "bg-zinc-800/40",
    hex: "#a1a1aa",
  },
};

const FALLBACK = SOURCE_STYLES.pdfjs;
export function sourceStyle(name) { return SOURCE_STYLES[name] || FALLBACK; }

// Confidence band styling — used for the per-event ring in NETWORK and the
// pill in REVIEW. Static again, no template strings.
export const CONFIDENCE_STYLES = {
  high:   { label: "HIGH",   dot: "bg-emerald-400", text: "text-emerald-300", ring: "border-emerald-700/60" },
  medium: { label: "MED",    dot: "bg-amber-400",   text: "text-amber-300",   ring: "border-amber-700/60"   },
  low:    { label: "LOW",    dot: "bg-rose-400",    text: "text-rose-300",    ring: "border-rose-700/60"    },
  none:   { label: "ONE-OFF",dot: "bg-zinc-500",    text: "text-zinc-400",    ring: "border-zinc-700/60"    },
};
export function confidenceStyle(c) { return CONFIDENCE_STYLES[c] || CONFIDENCE_STYLES.none; }

// Tiny inline dot strip — drop into any event row to show "which sources
// have transcribed this." Pass an array of source names (or a sidecar
// sources object), optionally a size variant.
//
//   <SourceMix sources={["gemini", "gpt-vision"]} />
//   <SourceMix sources={page.sources} size="xs" />
export default function SourceMix({ sources, size = "sm", showLabels = false, title }) {
  if (!sources) return null;
  const names = Array.isArray(sources) ? sources : Object.keys(sources);
  if (!names.length) return null;

  const dotSize = size === "xs" ? "w-1 h-1" : size === "lg" ? "w-2.5 h-2.5" : "w-1.5 h-1.5";
  const gap = size === "xs" ? "gap-0.5" : "gap-1";

  return (
    <span
      className={`inline-flex items-center ${gap}`}
      title={title || `Transcribed by: ${names.join(", ")}`}
      aria-label={`Sources: ${names.join(", ")}`}>
      {names.map(n => {
        const s = sourceStyle(n);
        return (
          <span key={n} className="inline-flex items-center gap-1">
            <span className={`${dotSize} rounded-full ${s.dot}`} />
            {showLabels && <span className={`text-[9px] font-mono tracking-widest ${s.text}`}>{s.label}</span>}
          </span>
        );
      })}
    </span>
  );
}

// Legend block — drop once at the top of NETWORK / REVIEW. Documents
// the encoding so the dots are self-explanatory.
export function SourceLegend({ className = "" }) {
  return (
    <div className={`inline-flex items-center gap-3 font-mono text-[9px] tracking-widest text-emerald-700 ${className}`}>
      <span className="opacity-60">SOURCES:</span>
      {Object.entries(SOURCE_STYLES).filter(([k]) => k !== "pdfjs").map(([name, s]) => (
        <span key={name} className="inline-flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
          <span className={s.text}>{s.label}</span>
        </span>
      ))}
    </div>
  );
}
