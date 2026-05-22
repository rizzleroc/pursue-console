import React, { useEffect, useMemo, useState } from "react";
import { GlitchText } from "../components/Primitives.jsx";

// MEDIA — every visually-meaningful page across the corpus, categorized
// by kind. Each tile is a page screenshot (~800px JPEG), not a bbox
// crop; click → modal with the full description + a deep-link straight
// to that page in DOSSIER (no scrolling required).

const KIND_LABELS = {
  // Release videos (DVIDS sensor footage). Listed first so the footage is
  // the first thing the library surfaces. These tiles link out to DVIDS.
  "video":                 "VIDEO / FOOTAGE",
  "photograph":            "PHOTOGRAPH",
  "hand-drawing":          "HAND DRAWING",
  "photocopied-negative":  "PHOTOCOPIED NEGATIVE",
  "newspaper-clipping":    "NEWSPAPER CLIPPING",
  "map":                   "MAP",
  "diagram":               "DIAGRAM",
  // `table` is created by the indexer's curate() pass — it scoops up
  // the typewritten checklists and forms that the vision classifier
  // labels as photocopied-negative because of the inverted-tone scan
  // style. See scripts/build-media-index.mjs.
  "table":                 "TABLE / FORM",
};

const KIND_COLORS = {
  // Distinct hues per kind so the grid reads as a color taxonomy.
  // All within the project palette (no new colors introduced).
  "video":                 { dot: "bg-blue-400",    text: "text-blue-300",    ring: "ring-blue-500/40" },
  "photograph":            { dot: "bg-cyan-400",    text: "text-cyan-300",    ring: "ring-cyan-500/40" },
  "hand-drawing":          { dot: "bg-amber-400",   text: "text-amber-300",   ring: "ring-amber-500/40" },
  "photocopied-negative":  { dot: "bg-zinc-400",    text: "text-zinc-300",    ring: "ring-zinc-500/40" },
  "newspaper-clipping":    { dot: "bg-emerald-400", text: "text-emerald-300", ring: "ring-emerald-500/40" },
  "map":                   { dot: "bg-rose-400",    text: "text-rose-300",    ring: "ring-rose-500/40" },
  "diagram":               { dot: "bg-violet-400",  text: "text-violet-300",  ring: "ring-violet-500/40" },
  "table":                 { dot: "bg-sky-400",     text: "text-sky-300",     ring: "ring-sky-500/40" },
};

const ALL_KINDS = Object.keys(KIND_LABELS);

// IR-scope poster for video tiles — reticle + scanlines + play affordance.
// DVIDS clips can't be embedded, so this stands in for a thumbnail and the
// whole tile/modal links out to dvidshub.net.
function VideoPoster({ label, big }) {
  return (
    <div className="relative w-full h-full bg-[#020806] overflow-hidden">
      <div className="absolute inset-0" style={{
        backgroundImage:
          "radial-gradient(circle at 50% 46%, rgba(59,130,246,0.16), rgba(2,8,6,0) 62%)," +
          "repeating-linear-gradient(0deg, rgba(59,130,246,0.05) 0px, rgba(59,130,246,0.05) 1px, transparent 1px, transparent 3px)",
      }} />
      <svg className="absolute inset-0 w-full h-full text-blue-400/25" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <line x1="50" y1="0" x2="50" y2="100" stroke="currentColor" strokeWidth="0.4" />
        <line x1="0" y1="50" x2="100" y2="50" stroke="currentColor" strokeWidth="0.4" />
        <circle cx="50" cy="50" r="22" fill="none" stroke="currentColor" strokeWidth="0.5" />
      </svg>
      <span className="absolute top-1.5 left-1.5 w-3 h-3 border-t border-l border-blue-400/50" />
      <span className="absolute top-1.5 right-1.5 w-3 h-3 border-t border-r border-blue-400/50" />
      <span className="absolute bottom-1.5 left-1.5 w-3 h-3 border-b border-l border-blue-400/50" />
      <span className="absolute bottom-1.5 right-1.5 w-3 h-3 border-b border-r border-blue-400/50" />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
        <span className={`flex items-center justify-center rounded-full border border-blue-400/60 bg-blue-950/40 transition-all group-hover:scale-110 group-hover:border-blue-300 ${big ? "w-16 h-16" : "w-10 h-10"}`}>
          <svg width={big ? 20 : 13} height={big ? 22 : 15} viewBox="0 0 22 24" aria-hidden="true">
            <path d="M2 2 L20 12 L2 22 Z" fill="#93c5fd" />
          </svg>
        </span>
        <span className={`tracking-[0.25em] text-blue-300 group-hover:text-blue-100 transition-colors ${big ? "text-[10px]" : "text-[8px]"}`}>{label || "PLAY ON DVIDS ↗"}</span>
      </div>
    </div>
  );
}

export default function MediaView({ onSelect }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [filterKinds, setFilterKinds] = useState(new Set(ALL_KINDS));
  const [filterAgency, setFilterAgency] = useState("all");
  const [filterEvent, setFilterEvent] = useState("all");
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(null);
  // Default: only show tiles with a real rendered image. The
  // text-only/placeholder tiles (extracted from Denis's Gemini
  // bracket markers on pages we can't render) are useful metadata
  // but look like noise when most of the grid is empty boxes.
  const [includePlaceholders, setIncludePlaceholders] = useState(false);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}media.json?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setData)
      .catch(e => setErr(e.message));
  }, []);

  const filtered = useMemo(() => {
    if (!data?.items) return [];
    const q = query.trim().toLowerCase();
    return data.items.filter(it => {
      // Videos have no local image but must always be visible — they're
      // the release footage, not a metadata-only placeholder.
      if (!includePlaceholders && !it.imagePath && it.kind !== "video") return false;
      if (!filterKinds.has(it.kind)) return false;
      if (filterAgency !== "all" && (it.agency || "—") !== filterAgency) return false;
      if (filterEvent !== "all" && it.eventId !== filterEvent) return false;
      if (q && !`${it.title} ${it.description} ${it.eventTitle}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, filterKinds, filterAgency, filterEvent, query, includePlaceholders]);

  // Counts of with-image vs placeholder-only for the toggle label.
  const counts = useMemo(() => {
    if (!data?.items) return { withImage: 0, placeholder: 0 };
    return data.items.reduce((acc, it) => {
      if (it.imagePath) acc.withImage++;
      else if (it.kind !== "video") acc.placeholder++;   // videos aren't placeholders
      return acc;
    }, { withImage: 0, placeholder: 0 });
  }, [data]);

  // Per-kind counts honoring the placeholder toggle. Without this, the
  // filter pills show `data.byKind` (all items) — so PHOTOGRAPH would
  // read "82" even when the grid is hiding 64 placeholders and only
  // showing 18 actual photos. That mismatch is the "filter calls out
  // images but has none attached" confusion.
  const kindCounts = useMemo(() => {
    if (!data?.items) return {};
    const out = {};
    for (const it of data.items) {
      if (!includePlaceholders && !it.imagePath && it.kind !== "video") continue;
      out[it.kind] = (out[it.kind] || 0) + 1;
    }
    return out;
  }, [data, includePlaceholders]);

  // Kinds that have any items at all (image OR placeholder) across the
  // full dataset. Used to suppress filter pills for kinds that aren't
  // represented in the current corpus — e.g. `table` stays defined for
  // future tabular content but won't render a "0" pill until something
  // actually populates the bucket.
  const kindsWithAnyItem = useMemo(() => {
    if (!data?.items) return new Set();
    const out = new Set();
    for (const it of data.items) out.add(it.kind);
    return out;
  }, [data]);

  const eventList = useMemo(() => {
    if (!data?.items) return [];
    const map = new Map();
    for (const it of data.items) {
      if (!map.has(it.eventId)) map.set(it.eventId, { id: it.eventId, title: it.eventTitle, n: 0 });
      map.get(it.eventId).n++;
    }
    return [...map.values()].sort((a, b) => b.n - a.n);
  }, [data]);

  if (err) return <div className="p-4 text-rose-400 font-mono text-xs">MEDIA unavailable: {err}</div>;
  if (!data) return <div className="p-4 text-emerald-700 font-mono text-xs">LOADING MEDIA LIBRARY…</div>;
  if (!data.items.length) {
    return (
      <div className="p-8 max-w-2xl mx-auto text-center">
        <div className="text-emerald-300 font-mono text-xs tracking-widest mb-3">MEDIA LIBRARY EMPTY</div>
        <div className="text-emerald-700 text-[11px] font-mono leading-relaxed">
          No pages classified as visual yet.<br/>
          Maintainer kicks off classification with: <code className="text-amber-300">npm run corpus:classify</code>
        </div>
      </div>
    );
  }

  function toggleKind(k) {
    const next = new Set(filterKinds);
    next.has(k) ? next.delete(k) : next.add(k);
    setFilterKinds(next);
  }

  return (
    <div className="px-3 sm:px-6 py-4">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]">
          <GlitchText>▦ MEDIA</GlitchText>
        </h2>
        <div className="font-mono text-[10px] text-emerald-700">
          {/*
            Denominator matches the placeholder toggle — without this,
            "X of 198" stays static even when 115 placeholders are
            hidden, so the user sees "18 of 198" and can't tell whether
            their filters threw out 180 tiles or whether 115 were
            placeholders hidden by the toggle.
          */}
          {filtered.length} of {includePlaceholders ? counts.withImage + counts.placeholder : counts.withImage} visuals · {data.eventCount} events
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        {ALL_KINDS.filter(k => kindsWithAnyItem.has(k)).map(k => {
          const active = filterKinds.has(k);
          const c = KIND_COLORS[k];
          // kindCounts respects the placeholder toggle so the number on
          // each pill matches what the grid actually shows. When the
          // user toggles "include placeholders" on, these jump to the
          // larger raw totals.
          const n = kindCounts[k] || 0;
          // Kinds with zero visible tiles get dimmed even when the
          // filter is "active" — the toggle is still meaningful (will
          // flip them on/off when placeholders come back) but the
          // visual weight matches the empty grid.
          const empty = n === 0;
          return (
            <button key={k} onClick={() => toggleKind(k)}
              title={empty ? `no ${KIND_LABELS[k]} tiles visible — try toggling "include placeholders"` : undefined}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-sm border font-mono text-[10px] tracking-wider transition-colors ${
                active && !empty ? `${c.text} border-current`
                : active && empty ? "text-emerald-800 border-emerald-900/40 opacity-40"
                : "text-emerald-800 border-emerald-900/50 opacity-50"}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${c.dot} ${empty ? "opacity-40" : ""}`} />
              {KIND_LABELS[k]} <span className="opacity-60">{n}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {/*
          Placeholder toggle. Default OFF — most users want to see only
          tiles backed by a rendered PNG. Placeholders are visuals we
          know about (extracted from Denis's Gemini transcripts) for
          pages where we don't have the source PDF locally; useful as
          metadata but read as visual noise when grids are dominated by
          empty boxes. Toggle ON to surface them anyway.
        */}
        <button onClick={() => setIncludePlaceholders(v => !v)}
          title={includePlaceholders
            ? `showing all ${counts.withImage + counts.placeholder} visuals (incl. ${counts.placeholder} metadata-only placeholders)`
            : `showing only ${counts.withImage} pages with a rendered image · click to also show ${counts.placeholder} placeholder entries (no local PDF available)`}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-sm border font-mono text-[10px] tracking-wider transition-colors ${
            includePlaceholders
              ? "text-cyan-300 border-cyan-500/50 bg-cyan-950/20"
              : "text-emerald-300 border-emerald-700/50 hover:border-emerald-500/60"}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${includePlaceholders ? "bg-cyan-400" : "bg-emerald-400"}`} />
          {includePlaceholders
            ? <>ALL <span className="opacity-60 ml-0.5">{counts.withImage + counts.placeholder}</span></>
            : <>WITH IMAGE <span className="opacity-60 ml-0.5">{counts.withImage}</span><span className="opacity-40 ml-1.5">+ {counts.placeholder} hidden</span></>}
        </button>
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="search title / description"
          className="bg-black/60 border border-emerald-700/50 rounded-sm px-2 py-1 text-emerald-300 placeholder-emerald-800 font-mono text-xs w-48 focus:outline-none focus:border-amber-400" />
        <select value={filterAgency} onChange={(e) => setFilterAgency(e.target.value)}
          className="bg-black/60 border border-emerald-700/50 rounded-sm px-2 py-1 text-emerald-300 font-mono text-xs">
          <option value="all">all agencies</option>
          {Object.entries(data.byAgency || {}).sort((a, b) => b[1] - a[1]).map(([a, n]) => (
            <option key={a} value={a}>{a} ({n})</option>
          ))}
        </select>
        <select value={filterEvent} onChange={(e) => setFilterEvent(e.target.value)}
          className="bg-black/60 border border-emerald-700/50 rounded-sm px-2 py-1 text-emerald-300 font-mono text-xs max-w-xs">
          <option value="all">all events</option>
          {eventList.map(e => <option key={e.id} value={e.id}>{e.title} ({e.n})</option>)}
        </select>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
        {filtered.map(it => {
          const c = KIND_COLORS[it.kind];
          return (
            <button key={it.id} onClick={() => setFocused(it)}
              className={`group block text-left bg-black/40 border border-emerald-900/40 hover:${c.ring} hover:ring-2 hover:border-transparent rounded-sm overflow-hidden transition-all`}>
              <div className="aspect-[3/4] bg-black overflow-hidden">
                {it.kind === "video" ? (
                  <VideoPoster />
                ) : it.thumbnailPath ? (
                  <img src={`${import.meta.env.BASE_URL}${it.thumbnailPath}`} alt={it.title || it.kind}
                    className="w-full h-full object-cover opacity-90 group-hover:opacity-100" loading="lazy" />
                ) : (
                  // No local render available (e.g. extracted from a Gemini
                  // transcript marker for an event we don't have the PDF
                  // for). Show a placeholder + the description so the
                  // metadata is still useful.
                  <div className="w-full h-full flex flex-col items-center justify-center p-3 bg-emerald-950/30">
                    <span className={`w-2 h-2 rounded-full ${c.dot} mb-2`} />
                    <span className={`font-mono text-[9px] tracking-widest ${c.text} opacity-70 mb-1`}>NO LOCAL IMAGE</span>
                    <span className={`font-mono text-[10px] ${c.text} opacity-90 text-center line-clamp-4`}>
                      {it.description || it.title || it.kind}
                    </span>
                  </div>
                )}
              </div>
              <div className="px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <span className={`w-1 h-1 rounded-full ${c.dot}`} />
                  <span className={`font-mono text-[8.5px] tracking-widest ${c.text}`}>{KIND_LABELS[it.kind]}</span>
                </div>
                <div className="font-mono text-[11px] text-emerald-200 leading-snug mt-0.5 line-clamp-2">
                  {it.title || it.description || `page ${it.page}`}
                </div>
                <div className="font-mono text-[9px] text-emerald-700 mt-0.5 truncate">
                  {it.kind === "video" ? `${it.eventTitle} · DVIDS` : `${it.eventTitle} · p${it.page}`}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {filtered.length === 0 && (
        <div className="p-8 text-center text-emerald-700 font-mono text-xs">no media matches current filters</div>
      )}

      {/* Modal */}
      {focused && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm"
             onClick={() => setFocused(null)}
             role="dialog" aria-modal="true">
          <div onClick={e => e.stopPropagation()}
               className="max-w-5xl w-full bg-black border border-emerald-700/50 rounded-sm max-h-[92vh] overflow-hidden flex flex-col">
            <div className="px-4 py-2 border-b border-emerald-900/50 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-1.5 h-1.5 rounded-full ${KIND_COLORS[focused.kind].dot}`} />
                <span className={`font-mono text-[10px] tracking-widest ${KIND_COLORS[focused.kind].text}`}>{KIND_LABELS[focused.kind]}</span>
                <span className="font-mono text-[10px] text-emerald-700">·</span>
                <span className="font-mono text-[11px] text-emerald-200 truncate">{focused.eventTitle}</span>
                <span className="font-mono text-[10px] text-emerald-700">·</span>
                <span className="font-mono text-[10px] text-emerald-500">{focused.kind === "video" ? "DVIDS" : `p${focused.page}`}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {focused.kind === "video" && (
                  <a href={focused.dvidsUrl || `https://www.dvidshub.net/video/${focused.videoId}`}
                    target="_blank" rel="noopener noreferrer"
                    className="font-mono text-[10px] tracking-widest border border-blue-600/60 text-blue-300 hover:bg-blue-900/30 px-2 py-1 rounded-sm">
                    PLAY ON DVIDS ↗
                  </a>
                )}
                {onSelect && (
                  <button
                    onClick={() => onSelect(
                      // Pass the full EVENTS-table entry so the dossier
                      // renders with date/agency/coords/etc. The MEDIA
                      // tile only carries id+title; the dossier wants
                      // the rest. The lookup falls back to the partial
                      // object if the eid isn't in EVENTS (shouldn't
                      // happen since media is keyed off catalogued
                      // events, but cheap to guard).
                      (window.__EVENTS_BY_ID || {})[focused.eventId] || { id: focused.eventId, title: focused.eventTitle },
                      { page: focused.page }
                    )}
                    className="font-mono text-[10px] tracking-widest border border-amber-700/60 text-amber-300 hover:bg-amber-900/30 px-2 py-1 rounded-sm">
                    OPEN IN DOSSIER →
                  </button>
                )}
                <button onClick={() => setFocused(null)} aria-label="Close"
                  className="text-emerald-700 hover:text-amber-300 font-mono text-sm px-2">×</button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-black flex items-center justify-center p-6 min-h-[40vh]">
              {focused.kind === "video" ? (
                <a href={focused.dvidsUrl || `https://www.dvidshub.net/video/${focused.videoId}`}
                  target="_blank" rel="noopener noreferrer"
                  aria-label={`Play ${focused.title} on DVIDS`}
                  className="group block w-full max-w-3xl aspect-video rounded-sm border border-blue-700/40 overflow-hidden">
                  <VideoPoster big label="PLAY ON DVIDS ↗" />
                </a>
              ) : focused.imagePath ? (
                <img src={`${import.meta.env.BASE_URL}${focused.imagePath}`} alt={focused.title || focused.kind}
                  className="max-w-full max-h-[70vh] object-contain" />
              ) : (
                <div className="text-center max-w-xl">
                  <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-sm border ${KIND_COLORS[focused.kind].ring} mb-4`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${KIND_COLORS[focused.kind].dot}`} />
                    <span className={`font-mono text-[10px] tracking-widest ${KIND_COLORS[focused.kind].text}`}>
                      {KIND_LABELS[focused.kind]} · NO LOCAL RENDER
                    </span>
                  </div>
                  <div className="font-mono text-emerald-300 text-sm leading-relaxed text-left">
                    {focused.description || focused.title}
                  </div>
                  <div className="font-mono text-emerald-700 text-[10px] mt-4 leading-relaxed">
                    This visual reference was extracted from Gemini's transcript of the source PDF. We don't have the PDF locally to render it. Open the original document at war.gov/UFO to view the actual image; the OPEN IN DOSSIER button above jumps to this event's record.
                  </div>
                </div>
              )}
            </div>
            {(focused.title || focused.description) && (
              <div className="px-4 py-3 border-t border-emerald-900/50">
                {focused.title && <div className="font-mono text-emerald-200 text-sm leading-snug">{focused.title}</div>}
                {focused.description && <div className="font-mono text-emerald-500 text-[12px] mt-1 leading-snug">{focused.description}</div>}
                <div className="font-mono text-[9px] text-emerald-800 mt-2 tracking-widest">
                  classified by {focused.classifier || "?"} · {focused.classifiedAt?.slice(0, 10)}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
