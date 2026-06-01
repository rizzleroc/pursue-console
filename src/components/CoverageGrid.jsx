import React, { useState, useMemo } from "react";

// Renders an 11×11 grid (121 cells) showing per-event coverage status, colored
// by `coverage.json`'s status field (complete / gap / no-data / mismatch). Each
// cell can be clicked to deep-link into the matching DossierView; hovering
// surfaces a small tooltip with the event id and status. Pads to exactly 121
// cells when fewer events are provided so the 11×11 silhouette stays stable.

export default function CoverageGrid({
  events = [],
  onSelect,
  className = "",
}) {
  const [hoveredEid, setHoveredEid] = useState(null);
  const [tooltipPos, setTooltipPos] = useState(null);

  const gridEvents = useMemo(() => {
    const padded = [...events];
    while (padded.length < 121) {
      padded.push({ eid: `_pad_${padded.length}`, status: "empty" });
    }
    return padded.slice(0, 121);
  }, [events]);

  const counts = useMemo(() => {
    const result = { complete: 0, partial: 0, empty: 0 };
    for (const evt of gridEvents) {
      if (evt.status === "complete") result.complete += 1;
      else if (evt.status === "gap" || evt.status === "mismatch" || evt.status === "no-data")
        result.partial += 1;
      else if (evt.status === "empty") result.empty += 1;
    }
    return result;
  }, [gridEvents]);

  function getCellClass(status) {
    switch (status) {
      case "complete":
        return "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.5)]";
      case "gap":
        return "bg-amber-500/15 border border-amber-700/40";
      case "mismatch":
        return "bg-yellow-300/25 border border-yellow-600/40";
      case "no-data":
        return "bg-[#0A120E] border border-[#16241E]";
      default:
        return "bg-emerald-950/30 border border-emerald-900/20";
    }
  }

  function handleCellHover(evt, e) {
    if (!evt || evt.status === "empty") {
      setHoveredEid(null);
      setTooltipPos(null);
      return;
    }
    setHoveredEid(evt.eid);
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltipPos({
      x: rect.left + rect.width / 2,
      y: rect.top - 8,
    });
  }

  const interactive = typeof onSelect === "function";

  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      <div className="flex items-center justify-between px-1">
        <span className="font-mono text-[11px] text-emerald-700 tracking-[0.2em]">
          RELEASE 01 · COVERAGE MAP
        </span>
        <span className="font-mono text-[11px] text-emerald-700 tracking-[0.2em]">
          {events.length} EVENTS
        </span>
      </div>

      <div
        className="inline-grid gap-3 p-2 rounded-sm border border-emerald-900/30 bg-black/20"
        style={{
          gridTemplateColumns: "repeat(11, 48px)",
          gridTemplateRows: "repeat(11, 48px)",
        }}
        role="grid"
        aria-label="Per-event coverage status"
      >
        {gridEvents.map((evt, idx) => (
          <button
            key={`${evt.eid}-${idx}`}
            type="button"
            role="gridcell"
            onClick={() => evt.status !== "empty" && onSelect?.(evt.eid)}
            onMouseEnter={(e) => handleCellHover(evt, e)}
            onMouseLeave={() => {
              setHoveredEid(null);
              setTooltipPos(null);
            }}
            className={`w-12 h-12 rounded-sm transition-all ${getCellClass(evt.status)} ${
              evt.status !== "empty" && interactive
                ? "hover:ring-2 hover:ring-emerald-400/50 cursor-pointer"
                : ""
            }`}
            aria-label={evt.status !== "empty" ? `${evt.eid} ${evt.status}` : "padding cell"}
            tabIndex={evt.status !== "empty" && interactive ? 0 : -1}
          />
        ))}
      </div>

      <div className="flex items-center gap-6 px-1 font-mono text-[11px] text-emerald-700">
        <Swatch className="bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.55)]" label="COMPLETE" count={counts.complete} />
        <Swatch className="bg-amber-500/40 border border-amber-700/40" label="PARTIAL" count={counts.partial} />
        <Swatch className="bg-[#0A120E] border border-[#16241E]" label="EMPTY" count={counts.empty} />
      </div>

      {hoveredEid && tooltipPos && (
        <div
          className="fixed z-50 px-2 py-1 bg-black/90 border border-emerald-600/40 rounded-sm font-mono text-[10px] text-emerald-300 pointer-events-none whitespace-nowrap"
          style={{
            left: `${tooltipPos.x}px`,
            top: `${tooltipPos.y}px`,
            transform: "translateX(-50%) translateY(-100%)",
            backdropFilter: "blur(4px)",
          }}
        >
          {hoveredEid}
          <span className="text-emerald-600 ml-1">
            · {gridEvents.find((e) => e.eid === hoveredEid)?.status || ""}
          </span>
        </div>
      )}
    </div>
  );
}

function Swatch({ className, label, count }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`w-3 h-3 rounded-sm ${className}`} />
      <span className="tracking-wider">
        {label} <span className="text-emerald-500">({count})</span>
      </span>
    </div>
  );
}
