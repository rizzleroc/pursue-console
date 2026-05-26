import React from "react";
import { AGENCY_COLORS } from "../data/events.js";
import { useT } from "../i18n/context.js";

export function ScanlineOverlay() {
  return <div className="pointer-events-none fixed inset-0 z-50" style={{
    backgroundImage: "repeating-linear-gradient(0deg, rgba(0,0,0,0.15) 0px, rgba(0,0,0,0.15) 1px, transparent 1px, transparent 3px)",
    mixBlendMode: "multiply",
  }} />;
}
export function GlitchText({ children, className = "" }) {
  return <span className={`relative inline-block ${className}`} style={{
    textShadow: "0 0 1px #7CFFB2, 0.5px 0 0 rgba(255,140,66,0.5), -0.5px 0 0 rgba(130,182,255,0.5)",
  }}>{children}</span>;
}

// Doc-type badge — for records that are primarily visual (photos, sketches,
// handwritten letters) rather than typed text. Tells the reader: don't expect
// transcribed prose; open the PDF to look at the actual evidence.
//
// The badge map keeps `glyph` + `color` (the visual encoding) baked in; the
// `label` is resolved at render time via t("doctype.<id>") so it localizes.
export const DOC_TYPE_BADGE = {
  photoset:    { glyph: "▣", color: "#FF6B9D" },
  handwritten: { glyph: "✎", color: "#FFD93D" },
  sketch:      { glyph: "✦", color: "#FFD93D" },
  annotated:   { glyph: "◎", color: "#82B6FF" },
  mixed:       { glyph: "▥", color: "#B794F4" },
};

export function DocTypeBadge({ docType, size = "sm" }) {
  const t = useT();
  if (!docType || !DOC_TYPE_BADGE[docType]) return null;
  const b = DOC_TYPE_BADGE[docType];
  const label = t(`doctype.${docType}`);
  const cls = size === "lg"
    ? "px-2 py-0.5 text-[10px] tracking-widest"
    : "px-1.5 py-0.5 text-[8px] tracking-wider";
  return (
    <span className={`inline-flex items-center gap-1 font-mono rounded-sm border ${cls}`}
      style={{ color: b.color, borderColor: b.color + "60", backgroundColor: b.color + "12" }}
      title={t("doctype.title_prefix", { label: label.toLowerCase() })}>
      <span>{b.glyph}</span>{label}
    </span>
  );
}

export function flagBg(flag) {
  if (flag === "anchor") return "bg-amber-400/15 border-amber-400/60";
  if (flag === "high")   return "bg-emerald-400/10 border-emerald-400/50";
  if (flag === "med")    return "bg-blue-400/8 border-blue-400/30";
  return "bg-emerald-700/10 border-emerald-700/30";
}

export function MiniChip({ event, onClick }) {
  const t = useT();
  const color = AGENCY_COLORS[event.agency] || "#7CFFB2";
  return (
    <button onClick={() => onClick(event)}
      className={`text-left rounded-sm border px-2 py-1.5 hover:scale-[1.02] active:scale-[0.98] transition-all ${flagBg(event.flag)}`}>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[9px] tracking-wider opacity-70" style={{ color }}>
          {event.agency.replace("Department of ","DEPT/").toUpperCase().slice(0,7)}
        </span>
        {event.flag === "anchor" && <span className="text-amber-400 text-[8px]">●</span>}
        {event.docType && DOC_TYPE_BADGE[event.docType] && (
          <span className="ml-auto text-[8px]" style={{ color: DOC_TYPE_BADGE[event.docType].color }}
            title={t(`doctype.${event.docType}`)}>
            {DOC_TYPE_BADGE[event.docType].glyph}
          </span>
        )}
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
