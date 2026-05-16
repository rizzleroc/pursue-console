import React, { useEffect, useMemo, useState, useRef } from "react";
import { EVENTS, AGENCY_COLORS } from "../data/events.js";

// LIVE WATCH — immersive Phosphor Vigil dashboard.
// See design/PHOSPHOR-VIGIL.md for the visual philosophy. Composition:
//   • Top header band: eyebrow / ID slug / monumental room name / UTC clock
//   • Telemetry stratum: 4 monumental totals separated by hairlines
//   • Three-column body: signal viz (L) · arriving signals rail (C) · agency gauges + bearing dial (R)
//   • Footer: watchkeeper line
//   • CRT scanlines + barely-there grain overlay, scoped to this view

// ---- design tokens ----
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const COLORS = {
  bg:       "#03090707",
  green:    "#7CFFB2",
  greenDim: "#367658",
  greenGhost: "#0c2018",
  amber:    "#FFD93D",
  amberDim: "#766018",
  cyan:     "#82B6FF",
  rose:     "#FF6B9D",
  whisper:  "#549A76",
  hair:     "#16382A",
};

const SOURCE = {
  vision: { color: COLORS.cyan,  label: "VISION" },
  ocr:    { color: COLORS.amber, label: "OCR"    },
};

const TIME_AGO = (ts) => {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60)    return `${Math.round(s)}s`;
  if (s < 3600)  return `${Math.round(s/60)}m`;
  if (s < 86400) return `${Math.round(s/3600)}h`;
  return `${Math.round(s/86400)}d`;
};

const eventById = Object.fromEntries(EVENTS.map(e => [e.id, e]));

// =================================================================
// Sub-components
// =================================================================

function UtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const fmt = (n) => String(n).padStart(2, "0");
  return (
    <span className="tabular-nums">
      {now.getUTCFullYear()} <span className="text-emerald-800">·</span> {fmt(now.getUTCMonth()+1)} <span className="text-emerald-800">·</span> {fmt(now.getUTCDate())}
      <span className="mx-3 text-emerald-800">/</span>
      {fmt(now.getUTCHours())} <span className="text-emerald-800">:</span> {fmt(now.getUTCMinutes())} <span className="text-emerald-800">:</span> {fmt(now.getUTCSeconds())}
      <span className="ml-3 text-emerald-700 text-[9px]">U T C</span>
    </span>
  );
}

function LivePulse({ active = true }) {
  return (
    <span className="relative inline-flex items-center justify-center w-3.5 h-3.5">
      {active && <span className="absolute inset-0 rounded-full animate-ping" style={{ backgroundColor: COLORS.green, opacity: 0.25 }} />}
      <span className="relative inline-block w-2 h-2 rounded-full" style={{ backgroundColor: COLORS.green, boxShadow: `0 0 8px ${COLORS.green}` }} />
    </span>
  );
}

// 24-bar histogram of entries-per-hour over the last 24 hours
function IngestHistogram({ entries }) {
  const bars = useMemo(() => {
    const buckets = new Array(24).fill(0);
    const now = Date.now();
    for (const e of entries) {
      const hAgo = (now - e.modifiedAt) / 3_600_000;
      if (hAgo < 0 || hAgo >= 24) continue;
      buckets[23 - Math.floor(hAgo)]++;
    }
    return buckets;
  }, [entries]);
  const max = Math.max(1, ...bars);
  return (
    <svg viewBox="0 0 240 80" className="w-full h-20" preserveAspectRatio="none">
      {bars.map((b, i) => {
        const h = (b / max) * 70;
        const x = (i / 24) * 240 + 1;
        const w = 240 / 24 - 2;
        const y = 75 - h;
        const isLatest = i === 23 && b > 0;
        return <rect key={i} x={x} y={y} width={w} height={h}
          fill={isLatest ? COLORS.green : COLORS.greenDim}
          opacity={b > 0 ? 1 : 0.3} />;
      })}
      <line x1="0" y1="75" x2="240" y2="75" stroke={COLORS.hair} strokeWidth="1" />
    </svg>
  );
}

// Synthetic oscilloscope — drives off ingest rate so it actually reflects activity
function Oscilloscope({ entries }) {
  // Determine "recent activity" intensity from last 5 min of entries
  const recentCount = useMemo(() => {
    const cut = Date.now() - 5 * 60_000;
    return entries.filter(e => e.modifiedAt > cut).length;
  }, [entries]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 90);
    return () => clearInterval(id);
  }, []);
  // Generate a 200-pt waveform that drifts each tick (slow horizontal scroll)
  const points = useMemo(() => {
    const N = 200;
    const amp = 14 + Math.min(recentCount, 6) * 2;
    return Array.from({ length: N }, (_, i) => {
      const phase = (i + tick) * 0.08;
      const y = 40
        + Math.sin(phase) * amp
        + Math.sin(phase * 2.3 + 1.7) * (amp * 0.4)
        + (i === N - 8 || i === N - 7 ? -16 : 0);  // recent spike
      return `${(i / N) * 240},${y.toFixed(1)}`;
    }).join(" ");
  }, [tick, recentCount]);
  return (
    <svg viewBox="0 0 240 80" className="w-full h-20" preserveAspectRatio="none">
      <line x1="0" y1="75" x2="240" y2="75" stroke={COLORS.hair} strokeWidth="1" />
      <polyline points={points} fill="none" stroke={COLORS.green} strokeWidth="1.2" opacity="0.9" />
      <polyline points={points} fill="none" stroke={COLORS.cyan} strokeWidth="0.8" opacity="0.4"
        style={{ transform: "translateY(0.5px)" }} />
    </svg>
  );
}

// Bearing dial — events plotted by longitude (angle) and freshness (radius)
function BearingDial({ entries }) {
  const points = useMemo(() => {
    const cut = Date.now() - 7 * 86_400_000;  // last 7 days
    const recent = entries.filter(e => e.modifiedAt > cut).slice(0, 60);
    return recent.map(e => {
      const ev = eventById[e.eventId];
      if (!ev?.coords) return null;
      const [lat, lon] = ev.coords;
      // angle: longitude → 0..360 with W on left, E on right, N at top.
      // We map lon directly: lon=0 → top, lon=180 → bottom, lon=-180 → bottom.
      // Use cos(lat) for radius emphasis so equatorial = outer, poles = inner.
      const ageHr = (Date.now() - e.modifiedAt) / 3_600_000;
      const freshness = Math.max(0.3, 1 - ageHr / (24 * 7));
      const rad = (lon * Math.PI) / 180 - Math.PI / 2;
      return {
        x: 50 + Math.cos(rad) * (40 * freshness),
        y: 50 + Math.sin(rad) * (40 * freshness),
        color: e.source === "vision" ? COLORS.cyan : COLORS.amber,
        r: e.source === "vision" ? 1.6 : 1.2,
      };
    }).filter(Boolean);
  }, [entries]);
  return (
    <svg viewBox="0 0 100 100" className="w-full h-44">
      <circle cx="50" cy="50" r="44" fill="none" stroke={COLORS.hair} strokeWidth="0.4" />
      <circle cx="50" cy="50" r="28" fill="none" stroke={COLORS.greenGhost} strokeWidth="0.3" />
      <circle cx="50" cy="50" r="14" fill="none" stroke={COLORS.greenGhost} strokeWidth="0.3" />
      {/* cardinal ticks */}
      {[
        { a: 0, l: "N" }, { a: 90, l: "E" }, { a: 180, l: "S" }, { a: 270, l: "W" },
      ].map(({ a, l }) => {
        const rad = ((a - 90) * Math.PI) / 180;
        const x1 = 50 + Math.cos(rad) * 44;
        const y1 = 50 + Math.sin(rad) * 44;
        const x2 = 50 + Math.cos(rad) * 40;
        const y2 = 50 + Math.sin(rad) * 40;
        const lx = 50 + Math.cos(rad) * 48 - 1;
        const ly = 50 + Math.sin(rad) * 48 + 2;
        return <g key={l}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={COLORS.greenDim} strokeWidth="0.5" />
          <text x={lx} y={ly} fill={COLORS.greenDim} fontSize="3.5"
            fontFamily="ui-monospace, monospace" textAnchor="middle">{l}</text>
        </g>;
      })}
      {/* sweep wedge */}
      <SweepWedge />
      {/* signal points */}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={p.r} fill={p.color} />
      ))}
      {/* crosshair */}
      <line x1="47" y1="50" x2="53" y2="50" stroke={COLORS.greenDim} strokeWidth="0.4" />
      <line x1="50" y1="47" x2="50" y2="53" stroke={COLORS.greenDim} strokeWidth="0.4" />
    </svg>
  );
}

function SweepWedge() {
  const [ang, setAng] = useState(0);
  useEffect(() => {
    let raf;
    let last = performance.now();
    const tick = (t) => {
      const dt = t - last; last = t;
      setAng(a => (a + dt * 0.03) % 360);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const segments = 24;
  return (
    <g transform={`rotate(${ang} 50 50)`}>
      {Array.from({ length: segments }, (_, i) => {
        const a = (-i * 2 - 90) * Math.PI / 180;
        const x = 50 + Math.cos(a) * 44;
        const y = 50 + Math.sin(a) * 44;
        const opacity = Math.max(0, 0.25 - i * 0.011);
        return <line key={i} x1="50" y1="50" x2={x} y2={y}
          stroke={COLORS.green} strokeWidth="0.4" opacity={opacity} />;
      })}
    </g>
  );
}

// =================================================================
// Main view
// =================================================================
export default function LiveFeedView({ onSelect }) {
  const [feed, setFeed] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");
  const [reloadAt, setReloadAt] = useState(Date.now());

  useEffect(() => {
    setFeed(null); setError(null);
    fetch(`${import.meta.env.BASE_URL}live-feed.json?t=${reloadAt}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setFeed)
      .catch(e => setError(e.message));
  }, [reloadAt]);

  const entries = useMemo(() => {
    if (!feed) return [];
    return feed.entries.filter(e => filter === "all" || e.source === filter);
  }, [feed, filter]);

  const stats = feed?.stats;

  // Agency distribution from entries (not from stats — finer-grained)
  const agencyDist = useMemo(() => {
    if (!feed) return [];
    const c = new Map();
    for (const e of feed.entries) {
      const ev = eventById[e.eventId];
      const a = ev?.agency || "OTHER";
      c.set(a, (c.get(a) || 0) + 1);
    }
    const total = [...c.values()].reduce((a, b) => a + b, 0) || 1;
    return [...c.entries()]
      .map(([name, n]) => ({ name, n, pct: (n / total) * 100, color: AGENCY_COLORS[name] || COLORS.greenDim }))
      .sort((a, b) => b.n - a.n).slice(0, 7);
  }, [feed]);

  // Media-type classification per event (from type + docType fields).
  // Returns one of: video | photo | audio | document
  function mediaTypeOf(ev) {
    const t = (ev.type || "").toLowerCase();
    const dt = (ev.docType || "").toLowerCase();
    if (/video/.test(t)) return "video";
    if (/audio/.test(t)) return "audio";
    if (/image|imagery|photo|composite|sketch|still/.test(t)) return "photo";
    if (["photoset", "sketch", "annotated"].includes(dt)) return "photo";
    return "document";
  }
  const mediaSplit = useMemo(() => {
    const c = { document: 0, photo: 0, video: 0, audio: 0 };
    for (const ev of EVENTS) c[mediaTypeOf(ev)]++;
    return c;
  }, []);

  // Per-doc progress — classify each catalogued event by source mix in the feed.
  // Categories:
  //   ready    — fully pdfjs-clean OR every page is vision (high-quality, queryable)
  //   improving — has some vision pages AND some tesseract/missing pages (partial coverage)
  //   queued    — has only tesseract pages indexed (or just curated meta, no body text)
  //   missing   — no body chunks at all (not yet OCR'd / not yet downloaded)
  //   uncatalogued — beyond our 52 (the 110 records still on war.gov we haven't catalogued)
  const docProgress = useMemo(() => {
    if (!feed) return null;
    // Tally per-event source counts + the most-recent activity timestamp.
    const perEvent = new Map();
    let feedNewest = 0;
    for (const e of feed.entries) {
      const row = perEvent.get(e.eventId) || { vision: 0, ocr: 0, newest: 0 };
      row[e.source] = (row[e.source] || 0) + 1;
      if (e.modifiedAt > row.newest) row.newest = e.modifiedAt;
      if (e.modifiedAt > feedNewest) feedNewest = e.modifiedAt;
      perEvent.set(e.eventId, row);
    }
    // "Active" = an event with new entries within 90 minutes of the most
    // recent activity in the feed. This catches the doc the OCR script is
    // currently working through (its pages stream in over 1-3 hours).
    const ACTIVE_WINDOW_MS = 90 * 60_000;
    const activeCutoff = feedNewest - ACTIVE_WINDOW_MS;
    let ready = 0, improving = 0, queued = 0, missing = 0;
    const activeIds = [];
    for (const ev of EVENTS) {
      const row = perEvent.get(ev.id);
      if (!row) { missing++; continue; }
      if (row.newest > activeCutoff && (row.vision + row.ocr) > 0) activeIds.push(ev.id);
      if (row.vision > 0 && row.ocr > 0) improving++;
      else if (row.vision > 0) ready++;
      else if (row.ocr > 0) queued++;
      else missing++;
    }
    const cataloguedTotal = EVENTS.length;
    const uncatalogued = Math.max(0, 162 - cataloguedTotal);
    return {
      ready, improving, queued, missing, cataloguedTotal, uncatalogued,
      totalInventory: 162,
      active: activeIds.length,
      activeIds,
      feedNewest,
    };
  }, [feed]);

  // Source counters
  const sourceRates = useMemo(() => {
    if (!feed) return { vision: 0, ocr: 0 };
    const cut = Date.now() - 3600_000;
    let v = 0, o = 0;
    for (const e of feed.entries) {
      if (e.modifiedAt < cut) continue;
      if (e.source === "vision") v++;
      else if (e.source === "ocr") o++;
    }
    return { vision: v, ocr: o };
  }, [feed]);

  return (
    <div className="relative overflow-hidden" style={{ backgroundColor: "#020806" }}>
      {/* CRT scanlines overlay (view-scoped) */}
      <div className="pointer-events-none absolute inset-0 z-10 opacity-60"
        style={{
          backgroundImage: "repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0px, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 2px)",
        }} />
      {/* radial vignette */}
      <div className="pointer-events-none absolute inset-0 z-10"
        style={{ background: "radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.7) 100%)" }} />
      {/* faint grain */}
      <div className="pointer-events-none absolute inset-0 z-10 opacity-[0.04]"
        style={{
          backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='0.9' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }} />

      <div className="relative z-20 px-6 sm:px-12 py-8">
        {/* ============ TOP HEADER BAND ============ */}
        <div className="text-center mb-2">
          <div className="font-mono text-[10px] tracking-[0.4em] text-amber-700/80">
            ◇ &nbsp; P R E S I D E N T I A L &nbsp; U N S E A L I N G &nbsp;·&nbsp; R E P O R T I N G &nbsp; S Y S T E M &nbsp; F O R &nbsp; U A P &nbsp; E N C O U N T E R S &nbsp; ◇
          </div>
          <div className="mt-2 mx-auto h-px w-72 bg-emerald-900/60" />
        </div>

        <div className="grid grid-cols-3 items-start mb-1">
          <div className="font-mono text-[12px] text-emerald-400 tracking-[0.3em] mt-3">
            <div>P U R S U E &nbsp;//&nbsp; W A T C H</div>
            <div className="text-emerald-700 text-[9px] tracking-[0.4em] mt-1">
              S E C T I O N &nbsp;A &nbsp;·&nbsp; L I N K &nbsp;N O M I N A L
            </div>
          </div>

          {/* Monumental room name */}
          <div className="flex items-center justify-center gap-4 mt-1">
            <LivePulse active />
            <h1 className="font-mono font-bold text-emerald-300 tracking-[0.4em] text-2xl sm:text-4xl"
              style={{ textShadow: `0 0 18px ${COLORS.green}55, 0 0 4px ${COLORS.green}aa` }}>
              L I V E &nbsp; W A T C H
            </h1>
          </div>

          {/* UTC clock + channel */}
          <div className="font-mono text-[12px] text-emerald-400 tracking-[0.25em] mt-3 text-right">
            <UtcClock />
            <div className="text-emerald-700 text-[9px] tracking-[0.4em] mt-1">
              C H A N N E L &nbsp; R E L E A S E &nbsp; 0 1
            </div>
          </div>
        </div>

        {/* full-width rule */}
        <div className="h-px bg-emerald-900/60 mt-6 mb-8" />

        {/* ============ TELEMETRY STRATUM ============ */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 mb-2 relative">
            {[
              { label: "P A G E S",        value: stats.totalPages.toLocaleString(),         sub: "decoded · cumulative", color: COLORS.green },
              { label: "C H A R A C T E R S", value: stats.totalChars >= 1e6 ? `${(stats.totalChars/1e6).toFixed(2)}M` : `${(stats.totalChars/1000).toFixed(0)}K`, sub: "indexed corpus text", color: COLORS.green },
              { label: "V I S I O N",      value: (stats.bySource.vision || 0).toLocaleString(), sub: "GPT-transcribed pages", color: COLORS.green },
              { label: "T E S S E R A C T", value: (stats.bySource.ocr || 0).toLocaleString(),    sub: "awaiting vision re-pass", color: COLORS.amber },
            ].map((c, i) => (
              <div key={c.label} className={`relative px-4 sm:px-6 ${i > 0 ? "border-l border-emerald-950" : ""}`}>
                <div className="font-mono text-[9px] tracking-[0.35em] text-emerald-700/80">{c.label}</div>
                <div className="font-mono font-bold tabular-nums leading-none mt-3 text-5xl sm:text-7xl"
                  style={{ color: c.color, textShadow: `0 0 18px ${c.color}33` }}>
                  {c.value}
                </div>
                <div className="font-mono text-[9px] tracking-widest text-emerald-700 mt-4">{c.sub}</div>
              </div>
            ))}
          </div>
        )}

        <div className="h-px bg-emerald-900/60 mt-10 mb-6" />

        {/* ============ DOCUMENT PROGRESS STRIP ============ */}
        {docProgress && (() => {
          const dp = docProgress;
          const segs = [
            { key: "ready",        label: "READY",       value: dp.ready,        color: COLORS.cyan,     sub: "fully vision-OCR'd" },
            { key: "improving",    label: "IMPROVING",   value: dp.improving,    color: COLORS.green,    sub: "partial vision · in-flight" },
            { key: "queued",       label: "QUEUED",      value: dp.queued,       color: COLORS.amber,    sub: "tesseract-only · awaiting vision" },
            { key: "missing",      label: "MISSING",     value: dp.missing,      color: COLORS.greenDim, sub: "no body text yet (or pdfjs-clean)" },
            { key: "uncatalogued", label: "UNCATALOGUED",value: dp.uncatalogued, color: COLORS.rose,     sub: "records to catalogue" },
          ];
          const totalSegs = segs.reduce((s, x) => s + x.value, 0) || 1;
          const indexed = dp.ready + dp.improving + dp.queued;
          const pctReady = Math.round(((dp.ready + dp.improving * 0.5) / dp.totalInventory) * 100);
          return (
            <div className="mb-8 border border-emerald-900/60 bg-black/40 rounded-sm p-4">
              <div className="flex items-baseline justify-between flex-wrap gap-3 mb-3">
                <div className="font-mono text-[10px] tracking-[0.3em] text-emerald-300">
                  ▌ D O C U M E N T &nbsp; P R O G R E S S
                  <span className="ml-3 text-emerald-700 text-[9px] tracking-widest">RELEASE 01 · {dp.totalInventory} INVENTORY</span>
                </div>
                <div className="flex items-center gap-4 font-mono text-[10px] tracking-widest text-emerald-700">
                  {/* ACTIVE indicator — pulses when something is being worked on */}
                  {dp.active > 0 && (
                    <span className="inline-flex items-center gap-2 px-2 py-0.5 rounded-sm border" style={{ borderColor: `${COLORS.cyan}55`, color: COLORS.cyan }}>
                      <span className="relative inline-flex items-center justify-center w-2 h-2">
                        <span className="absolute inset-0 rounded-full animate-ping" style={{ backgroundColor: COLORS.cyan, opacity: 0.4 }} />
                        <span className="relative inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: COLORS.cyan }} />
                      </span>
                      ACTIVE <span className="tabular-nums text-emerald-100">{dp.active}</span>
                    </span>
                  )}
                  <span>
                    <span className="text-cyan-300 text-base mr-1 tabular-nums">{pctReady}%</span>
                    toward fully search-ready
                  </span>
                </div>
              </div>

              {/* Stacked horizontal bar */}
              <div className="h-3 flex rounded-sm overflow-hidden mb-3 bg-emerald-950 border border-emerald-950">
                {segs.map(seg => seg.value > 0 && (
                  <div key={seg.key}
                    title={`${seg.label} · ${seg.value} docs · ${Math.round((seg.value/totalSegs)*100)}%`}
                    style={{ width: `${(seg.value / totalSegs) * 100}%`, backgroundColor: seg.color }} />
                ))}
              </div>

              {/* Active processing — which doc the OCR script is currently on */}
              {dp.active > 0 && (
                <div className="mb-3 font-mono text-[10px] tracking-widest">
                  <span className="text-cyan-300 mr-2">▸ PROCESSING NOW</span>
                  {dp.activeIds.slice(0, 4).map((id, i) => (
                    <span key={id} className="text-emerald-300 mr-2">
                      {i > 0 && <span className="text-emerald-700 mr-2">·</span>}
                      {id.toUpperCase()}
                    </span>
                  ))}
                  {dp.activeIds.length > 4 && <span className="text-emerald-700">+ {dp.activeIds.length - 4} more</span>}
                  <span className="text-emerald-700 ml-2">(last 90 min of feed activity)</span>
                </div>
              )}

              {/* Per-segment counts */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {segs.map(seg => (
                  <div key={seg.key} className="flex items-baseline gap-2">
                    <span className="inline-block w-2 h-2 rounded-sm shrink-0 mt-1" style={{ backgroundColor: seg.color }} />
                    <div className="min-w-0">
                      <div className="font-mono text-[9px] tracking-widest" style={{ color: seg.color }}>{seg.label}</div>
                      <div className="font-mono text-emerald-100 text-lg tabular-nums leading-none mt-0.5">
                        {seg.value}
                        <span className="text-emerald-700 ml-1 text-[10px]">of {dp.totalInventory}</span>
                      </div>
                      <div className="font-mono text-[9px] text-emerald-600 mt-1 leading-tight">{seg.sub}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Sub-line: how many of catalogued have any indexed text */}
              <div className="mt-3 pt-2 border-t border-emerald-950 font-mono text-[10px] text-emerald-700 tracking-widest">
                <span className="text-emerald-300">{dp.cataloguedTotal}</span> docs catalogued ·
                <span className="text-emerald-300 ml-1">{indexed}</span> with body text indexed ·
                <span className="text-cyan-300 ml-1">{dp.ready}</span> at vision quality ·
                <span className="text-amber-300 ml-1">{dp.queued}</span> still tesseract-only ·
                <span className="text-emerald-300 ml-1">{(stats?.totalPages || 0).toLocaleString()}</span> pages decoded total
              </div>

              {/* Media-type breakdown across the catalogued events */}
              <div className="mt-2 pt-2 border-t border-emerald-950">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="font-mono text-[9px] tracking-[0.3em] text-emerald-700">▌ M E D I A &nbsp; T Y P E S</div>
                  <div className="flex flex-wrap gap-3 font-mono text-[10px]">
                    {[
                      { key: "document", label: "DOCUMENT", glyph: "▤", color: COLORS.green,  note: "memos · reports · cables · interviews" },
                      { key: "photo",    label: "PHOTO",    glyph: "◫", color: COLORS.cyan,   note: "stills · sketches · annotated images" },
                      { key: "video",    label: "VIDEO",    glyph: "▶", color: COLORS.amber,  note: "DVIDS sensor footage · mission video" },
                      { key: "audio",    label: "AUDIO",    glyph: "◉", color: COLORS.rose,   note: "radio / transcript" },
                    ].map(m => {
                      const n = mediaSplit[m.key] || 0;
                      return (
                        <div key={m.key}
                          title={m.note}
                          className="flex items-center gap-1.5 px-2 py-0.5 rounded-sm border"
                          style={{ borderColor: n > 0 ? `${m.color}55` : "#0c2018", color: n > 0 ? m.color : COLORS.greenDim }}>
                          <span className="text-[11px] leading-none">{m.glyph}</span>
                          <span className="tracking-widest text-[9px]">{m.label}</span>
                          <span className="text-emerald-200 tabular-nums">{n}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        <div className="h-px bg-emerald-900/60 mb-6" />

        {/* ============ THREE-COLUMN BODY ============ */}
        <div className="grid grid-cols-12 gap-6">
          {/* ---- LEFT: ingest rate + oscillation + channels ---- */}
          <aside className="col-span-12 lg:col-span-3 space-y-6">
            <Panel title="INGEST RATE / 24H" sub="pages per hour">
              <IngestHistogram entries={feed?.entries || []} />
              <Axis labels={["00", "12", "24"]} />
            </Panel>
            <Panel title="OSCILLATION · LAST 60s" sub="recent activity">
              <Oscilloscope entries={feed?.entries || []} />
              <Axis labels={["−60s", "", "NOW"]} accentRight />
            </Panel>
            <Panel title="CHANNELS">
              <div className="space-y-1.5">
                <ChannelRow label="VISION"    rate={sourceRates.vision} color={COLORS.cyan} />
                <ChannelRow label="TESSERACT" rate={sourceRates.ocr}    color={COLORS.amber} />
                <ChannelRow label="USER DROP" rate={0}                  color={COLORS.greenDim} />
              </div>
            </Panel>
          </aside>

          {/* ---- CENTER: arriving signals rail ---- */}
          <main className="col-span-12 lg:col-span-6 min-w-0">
            <div className="flex items-baseline justify-between mb-2 pb-2 border-b border-emerald-900/60">
              <div className="font-mono text-[10px] tracking-[0.3em] text-emerald-300">▌ A R R I V I N G &nbsp; S I G N A L S</div>
              <div className="font-mono text-[9px] tracking-widest text-emerald-700">
                {filter !== "all" && <span className="text-amber-400 mr-2">[{filter.toUpperCase()}]</span>}
                VISION × OCR · UTC · MOST RECENT FIRST
              </div>
            </div>

            {/* filter row */}
            <div className="flex gap-2 mb-3">
              {["all", "vision", "ocr"].map(f => (
                <button key={f} onClick={() => setFilter(f)}
                  style={{ transition: `all 150ms ${EASE_OUT}` }}
                  className={`px-2 py-1 rounded-sm border font-mono text-[10px] tracking-widest active:scale-[0.97] ${
                    filter === f
                      ? "border-amber-400/80 text-amber-300 bg-amber-400/10"
                      : "border-emerald-900 text-emerald-500 hover:border-emerald-700"}`}>
                  {f === "all" ? "ALL" : f === "vision" ? "VISION" : "TESSERACT"}
                  <span className="ml-1 opacity-50">{f==="all" ? feed?.entries.length || 0 : (stats?.bySource[f] || 0)}</span>
                </button>
              ))}
              <button onClick={() => setReloadAt(Date.now())}
                style={{ transition: `all 150ms ${EASE_OUT}` }}
                className="ml-auto px-2 py-1 rounded-sm border border-emerald-900 text-emerald-500 hover:border-emerald-700 font-mono text-[10px] tracking-widest active:scale-[0.97]">
                ↻ REFRESH
              </button>
            </div>

            {error && (
              <div className="border border-rose-400/40 bg-rose-400/5 rounded-sm p-3 font-mono text-[11px] text-rose-300">
                ⊘ {error}
              </div>
            )}
            {!feed && !error && (
              <div className="font-mono text-[11px] text-emerald-700 py-16 text-center">◌ acquiring telemetry…</div>
            )}

            {feed && (
              <div>
                {entries.map((e, i) => {
                  const ev = eventById[e.eventId];
                  const src = SOURCE[e.source] || SOURCE.ocr;
                  const isFresh = i === 0;
                  const agencyColor = AGENCY_COLORS[ev?.agency] || COLORS.greenDim;
                  return (
                    <button key={`${e.eventId}-${e.page}`}
                      onClick={() => ev && onSelect?.(ev, { page: e.page })}
                      style={{ transition: `background-color 150ms ${EASE_OUT}` }}
                      className="group w-full text-left flex gap-4 py-3 border-b border-emerald-950 hover:bg-emerald-950/40 active:bg-emerald-900/30">
                      {/* left rail — bright on fresh */}
                      <div className="w-[3px] shrink-0 self-stretch ml-0"
                        style={{
                          backgroundColor: isFresh ? COLORS.cyan : COLORS.greenGhost,
                          boxShadow: isFresh ? `0 0 8px ${COLORS.cyan}66` : undefined,
                        }} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-3 flex-wrap font-mono">
                          <span className="text-[11px] tracking-widest tabular-nums"
                            style={{ color: isFresh ? COLORS.amber : COLORS.greenDim }}>
                            T + {TIME_AGO(e.modifiedAt)}
                          </span>
                          <span className="text-[11px] tracking-widest font-bold"
                            style={{ color: src.color }}>
                            {src.label}
                          </span>
                          <span className="text-[11px] tracking-wider text-emerald-300">
                            {(e.eventId || "").toUpperCase()}
                          </span>
                          <span className="text-[9px] tracking-widest" style={{ color: agencyColor }}>
                            {ev?.agency?.replace("Department of ", "DEPT/")}
                          </span>
                          <span className="ml-auto text-[10px] text-emerald-700 tabular-nums">PAGE {String(e.page).padStart(3, " ")}</span>
                        </div>
                        {e.snippet && (
                          <div className="font-mono text-[12px] mt-1 leading-relaxed pr-4 line-clamp-2"
                            style={{ color: isFresh ? COLORS.green : COLORS.whisper }}>
                            “{e.snippet}”
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </main>

          {/* ---- RIGHT: agency distribution + bearing dial ---- */}
          <aside className="col-span-12 lg:col-span-3 space-y-6">
            <Panel title="AGENCY DISTRIBUTION">
              <div className="space-y-2">
                {agencyDist.map(a => (
                  <div key={a.name} className="font-mono">
                    <div className="flex justify-between text-[10px] tracking-widest mb-0.5">
                      <span style={{ color: a.color }}>{a.name.replace("Department of ", "DEPT/").toUpperCase()}</span>
                      <span className="text-emerald-700 tabular-nums">{Math.round(a.pct)} %</span>
                    </div>
                    <div className="h-[3px] bg-emerald-950 rounded-sm overflow-hidden">
                      <div className="h-full rounded-sm" style={{ width: `${a.pct}%`, backgroundColor: a.color }} />
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="GEOSPATIAL BEARING" sub="last 7 days · by event coordinates">
              <BearingDial entries={feed?.entries || []} />
            </Panel>
            <HelpWantedPanel />
          </aside>
        </div>

        {/* ============ FOOTER ============ */}
        <div className="h-px bg-emerald-900/60 mt-12" />
        <div className="flex items-baseline justify-between mt-6 font-mono text-[9px] tracking-[0.35em] text-emerald-700">
          <div>W A T C H K E E P E R &nbsp;·&nbsp; A U T O M A T E D &nbsp;V I G I L &nbsp;·&nbsp; H U M A N - I N - L O O P</div>
          <div>P H O S P H O R - V I G I L &nbsp;·&nbsp; S E C T I O N &nbsp;A &nbsp;·&nbsp; P A G E &nbsp;0 1</div>
        </div>
        <div className="mt-2 font-mono text-[9px] tracking-widest text-emerald-800 text-center">
          {feed ? <>FEED GEN {feed.generatedAt?.slice(0,16).replace("T", " · ")} UTC · regenerated each deploy</> : ""}
        </div>
      </div>
    </div>
  );
}

// =================================================================
// Shared panel + axis primitives
// =================================================================
function Panel({ title, sub, children }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2 pb-1.5 border-b border-emerald-950">
        <div className="font-mono text-[10px] tracking-[0.3em] text-emerald-700">{title}</div>
        {sub && <div className="font-mono text-[9px] tracking-widest text-emerald-800">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function Axis({ labels, accentRight }) {
  return (
    <div className="flex justify-between font-mono text-[9px] tracking-widest text-emerald-800 mt-1">
      {labels.map((l, i) => (
        <span key={i} style={{ color: accentRight && i === labels.length - 1 ? COLORS.amber : undefined }}>
          {l}
        </span>
      ))}
    </div>
  );
}

// HELP-WANTED — fetches the public work queue and shows volunteers what's open.
function HelpWantedPanel() {
  const [queue, setQueue] = useState(null);
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}work-available.json?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setQueue)
      .catch(() => setQueue(null));
  }, []);
  // Show top 5 docs by pages-needed
  const top = queue ? Object.entries(queue.byEvent)
    .sort((a,b) => b[1].pagesNeeded - a[1].pagesNeeded)
    .slice(0, 5) : [];
  return (
    <div className="border-2 border-dashed border-amber-700/50 bg-amber-950/20 rounded-sm p-3">
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-mono text-[10px] tracking-[0.3em] text-amber-300">▌ H O W &nbsp; C A N &nbsp; I &nbsp; H E L P ?</div>
        {queue && (
          <div className="font-mono text-[9px] text-amber-700">
            <span className="text-amber-300 tabular-nums text-base mr-1">{queue.totalPagesNeeded}</span>
            pages need volunteers
          </div>
        )}
      </div>
      <div className="font-mono text-[10px] text-emerald-400/90 leading-relaxed mb-3">
        Run the pursue-vision-mcp daemon on your own machine with your own ChatGPT Plus account. The volunteer script picks pages from this queue, OCRs them, and opens a PR with your transcriptions. <span className="text-amber-300">No API keys, no credentials shared.</span>
      </div>
      {top.length > 0 && (
        <div className="mb-3">
          <div className="font-mono text-[9px] tracking-widest text-emerald-700 mb-1">▌ TOP NEEDS</div>
          <div className="space-y-1">
            {top.map(([eid, d]) => (
              <div key={eid} className="font-mono text-[10px] text-emerald-300 flex justify-between gap-2">
                <span className="truncate">{eid}</span>
                <span className="text-amber-300 tabular-nums shrink-0">{d.pagesNeeded}p</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="font-mono text-[10px] mb-2 p-2 bg-black/40 rounded-sm text-emerald-300 break-all">
        npm install --prefix pursue-vision-mcp<br/>
        npm start --prefix pursue-vision-mcp<br/>
        npm run volunteer -- --my-handle=YOU --slice=20
      </div>
      <a href="https://github.com/rizzleroc/pursue-console/blob/main/HOW-CAN-I-HELP.md"
        target="_blank" rel="noopener noreferrer"
        style={{ transition: "all 150ms cubic-bezier(0.23, 1, 0.32, 1)" }}
        className="block text-center font-mono text-[10px] tracking-widest px-3 py-2 border border-amber-400/60 bg-amber-400/5 text-amber-200 hover:bg-amber-400/15 hover:border-amber-400 rounded-sm active:scale-[0.97]">
        ＋ &nbsp; R E A D &nbsp; T H E &nbsp; F U L L &nbsp; G U I D E
      </a>
    </div>
  );
}

function ChannelRow({ label, rate, color }) {
  return (
    <div className="flex items-center justify-between font-mono text-[11px] py-1 border-b border-emerald-950 last:border-0">
      <span className="tracking-wider" style={{ color }}>{label}</span>
      <span className="tabular-nums text-emerald-700">
        <span className="text-emerald-400">{rate}</span> <span className="text-[9px]">/hr</span>
      </span>
    </div>
  );
}
