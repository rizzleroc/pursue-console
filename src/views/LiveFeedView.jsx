import React, { useEffect, useMemo, useState, useRef } from "react";
import { EVENTS, AGENCY_COLORS, RELEASES_LABEL } from "../data/events.js";
import useCorpusStats from "../hooks/useCorpusStats.js";
import { useT } from "../i18n/context.js";

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

// Stable source ids → color. Display labels come from t("live.signals.*")
// via SOURCE_LABEL_KEY so they localize without losing the color encoding
// that runs through the bearing dial and the per-signal row.
const SOURCE = {
  vision: { color: COLORS.cyan,  labelKey: "live.signals.filter_vision" },
  human:  { color: COLORS.green, labelKey: "live.signals.filter_human" },
  ocr:    { color: COLORS.amber, labelKey: "live.signals.filter_tesseract" },
};

// Relative-time helper. Units stay compact (s/m/h/d) regardless of locale —
// CJK/Arabic users still recognize "5h" as a duration, and translating the
// suffix would push the column wider than the design tolerates.
const TIME_AGO = (ts, nowTs = Date.now()) => {
  const s = Math.max(0, (nowTs - ts) / 1000);
  if (s < 60)    return `${Math.round(s)}s`;
  if (s < 3600)  return `${Math.round(s/60)}m`;
  if (s < 86400) return `${Math.round(s/3600)}h`;
  return `${Math.round(s/86400)}d`;
};

const eventById = Object.fromEntries(EVENTS.map(e => [e.id, e]));

// =================================================================
// Sub-components
// =================================================================

function UtcClock({ utcLabel }) {
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
      <span className="ml-3 text-emerald-700 text-[9px]">{utcLabel}</span>
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
        color: (SOURCE[e.source] || SOURCE.ocr).color,
        r: e.source === "ocr" ? 1.2 : 1.6,
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
// Match the Header's "ALL TYPES" dropdown (Document/Video/Image/Audio) to
// LiveFeedView's mediaTypeOf taxonomy (document/photo/video/audio).
const HEADER_TYPE_TO_MEDIA = {
  Document: "document", Image: "photo", Video: "video", Audio: "audio",
};

// Media-type classification per event (from type + docType fields).
// Hoisted outside the component so the header-filter useMemo above can
// share the same taxonomy as the per-signal classifier below.
function mediaTypeOf(ev) {
  const t  = (ev.type    || "").toLowerCase();
  const dt = (ev.docType || "").toLowerCase();
  if (/video/.test(t)) return "video";
  if (/audio/.test(t)) return "audio";
  if (/image|imagery|photo|composite|sketch|still/.test(t)) return "photo";
  if (["photoset", "sketch", "annotated"].includes(dt)) return "photo";
  return "document";
}

export default function LiveFeedView({ onSelect, headerFilters }) {
  const t = useT();
  const [feed, setFeed] = useState(null);
  const { stats: dbStats } = useCorpusStats();  // public/corpus-stats.json — TRUE numbers from the DB
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");
  const [reloadAt, setReloadAt] = useState(Date.now());
  const [now, setNow] = useState(() => Date.now());

  // Tick `now` every second so TIME_AGO and the ACTIVE indicator stay live
  // even between feed re-fetches.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Re-fetch the feed every 30s so the strip updates without a page reload.
  // Manual REFRESH button still works by bumping reloadAt.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`${import.meta.env.BASE_URL}live-feed.json?t=${Date.now()}`)
        .then(r => r.ok ? r.json() : null)
        .then(f => {
          if (cancelled) return;
          if (!f) { setError("HTTP fetching live-feed"); return; }
          setFeed(f); setError(null);
        }).catch(e => { if (!cancelled) setError(e.message); });
    };
    load();
    const id = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [reloadAt]);

  // Pre-compute the set of event IDs that pass the Header's search/agency/
  // type filters so the per-signal filter below is a quick set lookup.
  // Re-runs only when the header filters change.
  const allowedEventIds = useMemo(() => {
    const q = (headerFilters?.query || "").trim().toLowerCase();
    const agency = headerFilters?.filterAgency || "all";
    const type   = headerFilters?.filterType   || "all";
    const typeMedia = type !== "all" ? HEADER_TYPE_TO_MEDIA[type] : null;
    if (!q && agency === "all" && !typeMedia) return null;  // null = pass-through
    const set = new Set();
    for (const ev of EVENTS) {
      if (agency !== "all" && ev.agency !== agency) continue;
      if (typeMedia && mediaTypeOf(ev) !== typeMedia) continue;
      if (q && !(
        (ev.title    || "").toLowerCase().includes(q) ||
        (ev.summary  || "").toLowerCase().includes(q) ||
        (ev.loc      || "").toLowerCase().includes(q) ||
        (ev.agency   || "").toLowerCase().includes(q) ||
        (ev.tags || []).some(t => t.toLowerCase().includes(q))
      )) continue;
      set.add(ev.id);
    }
    return set;
  }, [headerFilters?.query, headerFilters?.filterAgency, headerFilters?.filterType]);

  const entries = useMemo(() => {
    if (!feed) return [];
    return feed.entries.filter(e => {
      if (filter !== "all" && e.source !== filter) return false;
      if (allowedEventIds && !allowedEventIds.has(e.eventId)) return false;
      return true;
    });
  }, [feed, filter, allowedEventIds]);

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
  //   uncatalogued — beyond our 52 (records inventoried but not yet catalogued)
  const docProgress = useMemo(() => {
    if (!feed) return null;
    // Classify from stats.byEvent (full per-event totals across the whole
    // indexed corpus). The previous version classified from feed.entries,
    // but that list is windowed (most-recent ~200 entries — often only the
    // event the OCR script is currently working through), which left every
    // other indexed event falsely classified as MISSING.
    const byEvent = feed.stats?.byEvent || {};
    // Pull recency from feed.entries (which entries it has are still real
    // signals of "what just streamed in"); fall back to feed.generatedAt.
    const recencyByEvent = new Map();
    let feedNewest = 0;
    for (const e of feed.entries || []) {
      const cur = recencyByEvent.get(e.eventId) || 0;
      if (e.modifiedAt > cur) recencyByEvent.set(e.eventId, e.modifiedAt);
      if (e.modifiedAt > feedNewest) feedNewest = e.modifiedAt;
    }
    // "Active" = an event whose newest entry is within the last 90 minutes
    // of wall-clock time. Anchoring to `now` (not feedNewest) means the
    // ACTIVE chip naturally goes idle if the daemon stops feeding pages,
    // even before the next file regeneration.
    const ACTIVE_WINDOW_MS = 90 * 60_000;
    const activeCutoff = now - ACTIVE_WINDOW_MS;
    let ready = 0, improving = 0, queued = 0, missing = 0;
    const activeIds = [];
    for (const ev of EVENTS) {
      const row = byEvent[ev.id];
      if (!row) { missing++; continue; }
      const v = row.vision || 0;
      const o = row.ocr || 0;
      const h = row.human || 0;
      if (v === 0 && o === 0 && h === 0) { missing++; continue; }
      const lastSeen = recencyByEvent.get(ev.id) || 0;
      if (lastSeen > activeCutoff) activeIds.push(ev.id);
      if ((v > 0 || h > 0) && o > 0) improving++;
      else if (v > 0 || h > 0) ready++;
      else queued++;
    }
    // TRUE totals — pulled from public/corpus-stats.json (DB-backed) when
    // available, fall back to the press-release claim only if stats hasn't
    // loaded yet. Single source of truth, not three hardcodes.
    const totalInventory = dbStats?.inventory?.total ?? 162;
    const cataloguedTotal = dbStats?.events?.catalogued ?? EVENTS.length;
    const uncatalogued = dbStats?.gap?.uncataloguedRecords ?? Math.max(0, totalInventory - cataloguedTotal);
    return {
      ready, improving, queued, missing, cataloguedTotal, uncatalogued,
      totalInventory,
      active: activeIds.length,
      activeIds,
      feedNewest,
    };
  }, [feed, now, dbStats]);

  // Source counters
  const sourceRates = useMemo(() => {
    if (!feed) return { vision: 0, ocr: 0, human: 0 };
    const cut = now - 3600_000;
    let v = 0, o = 0, h = 0;
    for (const e of feed.entries) {
      if (e.modifiedAt < cut) continue;
      if (e.source === "vision") v++;
      else if (e.source === "ocr") o++;
      else if (e.source === "human") h++;
    }
    return { vision: v, ocr: o, human: h };
  }, [feed, now]);

  // Stale-feed detection — when the newest entry in live-feed.json is more
  // than 24h old, the LIVE page is "live" only in name. Without this banner
  // the IngestHistogram (empty bars) and Oscilloscope (synthetic noise that
  // keeps moving regardless of activity) make a frozen pipeline look healthy.
  // Threshold = 24h: any longer than that means at least one batch was
  // expected but didn't arrive.
  const feedNewest = docProgress?.feedNewest || 0;
  const feedStaleHours = feedNewest ? (now - feedNewest) / 3_600_000 : null;
  const isStale = feedStaleHours != null && feedStaleHours >= 24;

  return (
    <div className="relative" style={{ backgroundColor: "#020806" }}>
      <div className="relative z-20 px-4 sm:px-8 py-6">
        {/* ── HERO (LIVE is home; this is the only view that carries it) ── */}
        <div className="flex items-baseline justify-between flex-wrap gap-3 mb-2">
          <div className="flex items-center gap-3">
            <LivePulse active />
            <h1 className="font-mono font-semibold text-emerald-200 tracking-[0.25em] text-xl sm:text-3xl"
              style={{ textShadow: `0 0 12px ${COLORS.green}44` }}>
              {t("live.title")}
            </h1>
          </div>
          <div className="font-mono text-[11px] text-emerald-500 tracking-[0.2em]">
            <UtcClock utcLabel={t("live.utc")} /> <span className="text-emerald-800 mx-2">·</span> {t("live.source_label", { releases: RELEASES_LABEL.toUpperCase() })}
          </div>
        </div>
        <div className="font-mono text-[11px] text-emerald-700 max-w-2xl leading-relaxed mb-6">
          {t("live.lead")}
        </div>

        {/* Stale-feed banner. Surfaces when no new pages have landed in >24h
            so the empty histogram + drifting oscilloscope don't read as
            "everything's running." */}
        {isStale && (
          <div className="mb-6 px-3 py-2 border rounded-sm font-mono text-[10px] tracking-widest flex items-center justify-between flex-wrap gap-2"
            style={{ borderColor: `${COLORS.amber}55`, backgroundColor: `${COLORS.amber}0A`, color: COLORS.amber }}>
            <span>
              {t("live.stale_warning", { hours: Math.round(feedStaleHours) })}
            </span>
            <span className="text-emerald-700">
              {t("live.stale_sub")}
            </span>
          </div>
        )}

        {/* ── TELEMETRY ── halved scale, no more billboard ── */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 mb-6 border-y border-emerald-900/40">
            {[
              { key: "pages",     label: t("live.tel.pages"),     sub: t("live.tel.pages_sub"),     color: COLORS.green, value: stats.totalPages.toLocaleString() },
              { key: "chars",     label: t("live.tel.chars"),     sub: t("live.tel.chars_sub"),     color: COLORS.green,
                value: stats.totalChars >= 1e6 ? `${(stats.totalChars/1e6).toFixed(2)}M` : `${(stats.totalChars/1000).toFixed(0)}K` },
              { key: "vision",    label: t("live.tel.vision"),    sub: t("live.tel.vision_sub"),    color: COLORS.green, value: (stats.bySource.vision || 0).toLocaleString() },
              { key: "tesseract", label: t("live.tel.tesseract"), sub: t("live.tel.tesseract_sub"), color: COLORS.amber, value: (stats.bySource.ocr || 0).toLocaleString() },
            ].map((c, i) => (
              <div key={c.key} className={`px-4 py-3 ${i > 0 ? "border-l border-emerald-950" : ""}`}>
                <div className="font-mono text-[9px] tracking-[0.3em] text-emerald-700/80">{c.label}</div>
                <div className="font-mono font-semibold tabular-nums leading-none mt-2 text-2xl sm:text-3xl"
                  style={{ color: c.color }}>
                  {c.value}
                </div>
                <div className="font-mono text-[9px] tracking-widest text-emerald-700 mt-2">{c.sub}</div>
              </div>
            ))}
          </div>
        )}

        {/* ============ DOCUMENT PROGRESS STRIP ============ */}
        {docProgress && (() => {
          const dp = docProgress;
          // Segment labels + subs translate via t(); the color, value and
          // key stay structural so the bar tooltip + per-segment grid
          // stay aligned regardless of locale string length.
          const segs = [
            { key: "ready",        label: t("live.doc_progress.ready"),        value: dp.ready,        color: COLORS.cyan,     sub: t("live.doc_progress.ready_sub") },
            { key: "improving",    label: t("live.doc_progress.improving"),    value: dp.improving,    color: COLORS.green,    sub: t("live.doc_progress.improving_sub") },
            { key: "queued",       label: t("live.doc_progress.queued"),       value: dp.queued,       color: COLORS.amber,    sub: t("live.doc_progress.queued_sub") },
            { key: "missing",      label: t("live.doc_progress.missing"),      value: dp.missing,      color: COLORS.greenDim, sub: t("live.doc_progress.missing_sub") },
            { key: "uncatalogued", label: t("live.doc_progress.uncatalogued"), value: dp.uncatalogued, color: COLORS.rose,     sub: t("live.doc_progress.uncatalogued_sub") },
          ];
          const totalSegs = segs.reduce((s, x) => s + x.value, 0) || 1;
          const indexed = dp.ready + dp.improving + dp.queued;
          const pctReady = Math.round(((dp.ready + dp.improving * 0.5) / dp.totalInventory) * 100);
          return (
            <div className="mb-8 border border-emerald-900/60 bg-black/40 rounded-sm p-4">
              <div className="flex items-baseline justify-between flex-wrap gap-3 mb-3">
                <div className="font-mono text-[10px] tracking-[0.3em] text-emerald-300">
                  {t("live.doc_progress.title")}
                  <span className="ml-3 text-emerald-700 text-[9px] tracking-widest">{t("live.doc_progress.inventory", { releases: RELEASES_LABEL.toUpperCase(), total: dp.totalInventory })}</span>
                </div>
                <div className="flex items-center gap-4 font-mono text-[10px] tracking-widest text-emerald-700">
                  {/* ACTIVE indicator — pulses when something is being worked on */}
                  {dp.active > 0 && (
                    <span className="inline-flex items-center gap-2 px-2 py-0.5 rounded-sm border" style={{ borderColor: `${COLORS.cyan}55`, color: COLORS.cyan }}>
                      <span className="relative inline-flex items-center justify-center w-2 h-2">
                        <span className="absolute inset-0 rounded-full animate-ping" style={{ backgroundColor: COLORS.cyan, opacity: 0.4 }} />
                        <span className="relative inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: COLORS.cyan }} />
                      </span>
                      {t("live.doc_progress.active")} <span className="tabular-nums text-emerald-100">{dp.active}</span>
                    </span>
                  )}
                  <span>
                    <span className="text-cyan-300 text-base mr-1 tabular-nums">{pctReady}%</span>
                    {t("live.doc_progress.pct_search_ready")}
                  </span>
                </div>
              </div>

              {/* Stacked horizontal bar */}
              <div className="h-3 flex rounded-sm overflow-hidden mb-3 bg-emerald-950 border border-emerald-950">
                {segs.map(seg => seg.value > 0 && (
                  <div key={seg.key}
                    title={t("live.doc_progress.bar_title", { label: seg.label, n: seg.value, pct: Math.round((seg.value/totalSegs)*100) })}
                    style={{ width: `${(seg.value / totalSegs) * 100}%`, backgroundColor: seg.color }} />
                ))}
              </div>

              {/* Active processing — which doc the OCR script is currently on */}
              {dp.active > 0 && (
                <div className="mb-3 font-mono text-[10px] tracking-widest">
                  <span className="text-cyan-300 mr-2">{t("live.doc_progress.processing_now")}</span>
                  {dp.activeIds.slice(0, 4).map((id, i) => (
                    <span key={id} className="text-emerald-300 mr-2">
                      {i > 0 && <span className="text-emerald-700 mr-2">·</span>}
                      {id.toUpperCase()}
                    </span>
                  ))}
                  {dp.activeIds.length > 4 && <span className="text-emerald-700">{t("live.doc_progress.processing_more", { n: dp.activeIds.length - 4 })}</span>}
                  <span className="text-emerald-700 ml-2">{t("live.doc_progress.processing_hint")}</span>
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
                        <span className="text-emerald-700 ml-1 text-[10px]">{t("live.doc_progress.of_total", { total: dp.totalInventory })}</span>
                      </div>
                      <div className="font-mono text-[9px] text-emerald-600 mt-1 leading-tight">{seg.sub}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Sub-line: how many of catalogued have any indexed text */}
              <div className="mt-3 pt-2 border-t border-emerald-950 font-mono text-[10px] text-emerald-700 tracking-widest">
                {t("live.doc_progress.summary", {
                  catalogued: dp.cataloguedTotal,
                  indexed,
                  ready: dp.ready,
                  queued: dp.queued,
                  pages: (stats?.totalPages || 0).toLocaleString(),
                })}
              </div>

              {/* Media-type breakdown across the catalogued events */}
              <div className="mt-2 pt-2 border-t border-emerald-950">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="font-mono text-[9px] tracking-[0.3em] text-emerald-700">{t("live.doc_progress.media_types")}</div>
                  <div className="flex flex-wrap gap-3 font-mono text-[10px]">
                    {[
                      { key: "document", glyph: "▤", color: COLORS.green, label: t("live.doc_progress.mt_document"), note: t("live.doc_progress.mt_document_note") },
                      { key: "photo",    glyph: "◫", color: COLORS.cyan,  label: t("live.doc_progress.mt_photo"),    note: t("live.doc_progress.mt_photo_note") },
                      { key: "video",    glyph: "▶", color: COLORS.amber, label: t("live.doc_progress.mt_video"),    note: t("live.doc_progress.mt_video_note") },
                      { key: "audio",    glyph: "◉", color: COLORS.rose,  label: t("live.doc_progress.mt_audio"),    note: t("live.doc_progress.mt_audio_note") },
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
            <Panel title={t("live.panel.ingest_rate")} sub={t("live.panel.ingest_rate_sub")}>
              <IngestHistogram entries={feed?.entries || []} />
              <Axis labels={["00", "12", "24"]} />
            </Panel>
            <Panel title={t("live.panel.oscillation")} sub={t("live.panel.oscillation_sub")}>
              <Oscilloscope entries={feed?.entries || []} />
              <Axis labels={["−60s", "", "NOW"]} accentRight />
            </Panel>
            <Panel title={t("live.panel.channels")}>
              <div className="space-y-1.5">
                <ChannelRow label={t("live.panel.channel_vision")}    rate={sourceRates.vision} color={COLORS.cyan}  perHour={t("live.panel.per_hour_suffix")} />
                {(stats?.bySource?.human || 0) > 0 && (
                  <ChannelRow label={t("live.panel.channel_human")}   rate={sourceRates.human}  color={COLORS.green} perHour={t("live.panel.per_hour_suffix")} />
                )}
                <ChannelRow label={t("live.panel.channel_tesseract")} rate={sourceRates.ocr}    color={COLORS.amber} perHour={t("live.panel.per_hour_suffix")} />
              </div>
            </Panel>
          </aside>

          {/* ---- CENTER: arriving signals rail ---- */}
          <main className="col-span-12 lg:col-span-6 min-w-0">
            <div className="flex items-baseline justify-between mb-2 pb-2 border-b border-emerald-900/60">
              <div className="font-mono text-[10px] tracking-[0.3em] text-emerald-300">{t("live.signals.title")}</div>
              <div className="font-mono text-[9px] tracking-widest text-emerald-700">
                {filter !== "all" && <span className="text-amber-400 mr-2">[{t(`live.signals.filter_${filter === "ocr" ? "tesseract" : filter}`)}]</span>}
                {t("live.signals.meta")}
              </div>
            </div>

            {/* filter row */}
            <div className="flex gap-2 mb-3">
              {["all", "vision", ...((stats?.bySource?.human || 0) > 0 ? ["human"] : []), "ocr"].map(f => {
                const labelKey = f === "all" ? "live.signals.filter_all"
                  : f === "vision" ? "live.signals.filter_vision"
                  : f === "human" ? "live.signals.filter_human"
                  : "live.signals.filter_tesseract";
                return (
                  <button key={f} onClick={() => setFilter(f)}
                    style={{ transition: `all 150ms ${EASE_OUT}` }}
                    className={`px-2 py-1 rounded-sm border font-mono text-[10px] tracking-widest active:scale-[0.97] ${
                      filter === f
                        ? "border-amber-400/80 text-amber-300 bg-amber-400/10"
                        : "border-emerald-900 text-emerald-500 hover:border-emerald-700"}`}>
                    {t(labelKey)}
                    <span className="ml-1 opacity-50">{f==="all" ? feed?.entries.length || 0 : (stats?.bySource[f] || 0)}</span>
                  </button>
                );
              })}
              <button onClick={() => setReloadAt(Date.now())}
                style={{ transition: `all 150ms ${EASE_OUT}` }}
                className="ml-auto px-2 py-1 rounded-sm border border-emerald-900 text-emerald-500 hover:border-emerald-700 font-mono text-[10px] tracking-widest active:scale-[0.97]">
                {t("live.signals.refresh")}
              </button>
            </div>

            {error && (
              <div className="border border-rose-400/40 bg-rose-400/5 rounded-sm p-3 font-mono text-[11px] text-rose-300">
                ⊘ {error}
              </div>
            )}
            {!feed && !error && (
              <div className="font-mono text-[11px] text-emerald-700 py-16 text-center">{t("live.signals.acquiring")}</div>
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
                            {t("live.signals.t_plus", { ago: TIME_AGO(e.modifiedAt, now) })}
                          </span>
                          <span className="text-[11px] tracking-widest font-bold"
                            style={{ color: src.color }}>
                            {t(src.labelKey)}
                          </span>
                          <span className="text-[11px] tracking-wider text-emerald-300">
                            {(e.eventId || "").toUpperCase()}
                          </span>
                          <span className="text-[9px] tracking-widest" style={{ color: agencyColor }}>
                            {ev?.agency?.replace("Department of ", "DEPT/")}
                          </span>
                          {e.contributor && (
                            <span className="text-[9px] tracking-widest" style={{ color: COLORS.green }}>
                              ✦ {e.contributor}
                            </span>
                          )}
                          <span className="ml-auto text-[10px] text-emerald-700 tabular-nums">{t("live.signals.page_n", { n: String(e.page).padStart(3, " ") })}</span>
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
            <Panel title={t("live.panel.agency_distribution")}>
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
            <Panel title={t("live.panel.bearing")} sub={t("live.panel.bearing_sub")}>
              <BearingDial entries={feed?.entries || []} />
            </Panel>
            <HelpWantedPanel />
          </aside>
        </div>

        {/* ============ FOOTER ============ */}
        <div className="h-px bg-emerald-900/60 mt-12" />
        <div className="flex items-baseline justify-between mt-6 font-mono text-[9px] tracking-[0.35em] text-emerald-700">
          <div>{t("live.footer_left")}</div>
          <div>{t("live.footer_right")}</div>
        </div>
        <div className="mt-2 font-mono text-[9px] tracking-widest text-emerald-800 text-center">
          {feed ? t("live.feed_gen", { at: feed.generatedAt?.slice(0,16).replace("T", " · ") || "—" }) : ""}
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
  const t = useT();
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
  const notPulled = queue?.notYetPulled?.slice(0, 6) || [];
  return (
    <div className="border-2 border-dashed border-amber-700/50 bg-amber-950/20 rounded-sm p-3">
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-mono text-[10px] tracking-[0.3em] text-amber-300">{t("live.help.title")}</div>
        {queue && (
          <div className="font-mono text-[9px] text-amber-700 text-right">
            <span className="text-amber-300 tabular-nums text-base mr-1">{queue.totalPagesNeeded}</span>
            {t("live.help.pages_need")}
            {queue.totalDocsNotPulled > 0 && (
              <div className="text-emerald-700 mt-0.5">
                {t("live.help.backlog_pre")} <span className="text-emerald-400 tabular-nums">{queue.totalDocsNotPulled}</span> {t("live.help.backlog_docs")}
                {" · "}
                <span className="text-emerald-400 tabular-nums">{queue.totalPagesNotPulled}</span> {t("live.help.backlog_pages")}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="font-mono text-[10px] text-emerald-400/90 leading-relaxed mb-3">
        {t("live.help.daemon_lead_pre")} <span className="text-amber-300">{t("live.help.daemon_lead_emph")}</span>
      </div>
      {top.length > 0 && (
        <div className="mb-3">
          <div className="font-mono text-[9px] tracking-widest text-emerald-700 mb-1">{t("live.help.top_needs")}</div>
          <div className="space-y-1">
            {top.map(([eid, d]) => (
              <div key={eid} className="font-mono text-[10px] text-emerald-300 flex justify-between gap-2">
                <span className="truncate">{eid}</span>
                <span className="text-amber-300 tabular-nums shrink-0">{d.pagesNeeded}{t("live.help.pages_suffix")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {notPulled.length > 0 && (
        <div className="mb-3">
          <div className="font-mono text-[9px] tracking-widest text-emerald-700 mb-1">{t("live.help.awaiting_first_pull")}</div>
          <div className="space-y-1">
            {notPulled.map(d => (
              <div key={d.eid} className="font-mono text-[10px] text-emerald-400/80 flex justify-between gap-2">
                <span className="truncate">{d.title}</span>
                <span className="text-emerald-500 tabular-nums shrink-0">{d.pages}{t("live.help.pages_suffix")}</span>
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
        {t("live.help.read_full_guide")}
      </a>
    </div>
  );
}

function ChannelRow({ label, rate, color, perHour = "/hr" }) {
  return (
    <div className="flex items-center justify-between font-mono text-[11px] py-1 border-b border-emerald-950 last:border-0">
      <span className="tracking-wider" style={{ color }}>{label}</span>
      <span className="tabular-nums text-emerald-700">
        <span className="text-emerald-400">{rate}</span> <span className="text-[9px]">{perHour}</span>
      </span>
    </div>
  );
}
