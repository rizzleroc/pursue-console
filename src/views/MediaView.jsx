import React, { useEffect, useMemo, useState } from "react";
import { GlitchText } from "../components/Primitives.jsx";

// MEDIA — every visually-meaningful page across the corpus, categorized
// by kind. Each tile is a page screenshot (~800px JPEG), not a bbox
// crop; click → modal with the full description + a deep-link straight
// to that page in DOSSIER (no scrolling required).

const KIND_LABELS = {
  "photograph":            "PHOTOGRAPH",
  "hand-drawing":          "HAND DRAWING",
  "photocopied-negative":  "PHOTOCOPIED NEGATIVE",
  "newspaper-clipping":    "NEWSPAPER CLIPPING",
  "map":                   "MAP",
  "diagram":               "DIAGRAM",
};

const KIND_COLORS = {
  // Distinct hues per kind so the grid reads as a color taxonomy.
  // All within the project palette (no new colors introduced).
  "photograph":            { dot: "bg-cyan-400",    text: "text-cyan-300",    ring: "ring-cyan-500/40" },
  "hand-drawing":          { dot: "bg-amber-400",   text: "text-amber-300",   ring: "ring-amber-500/40" },
  "photocopied-negative":  { dot: "bg-zinc-400",    text: "text-zinc-300",    ring: "ring-zinc-500/40" },
  "newspaper-clipping":    { dot: "bg-emerald-400", text: "text-emerald-300", ring: "ring-emerald-500/40" },
  "map":                   { dot: "bg-rose-400",    text: "text-rose-300",    ring: "ring-rose-500/40" },
  "diagram":               { dot: "bg-violet-400",  text: "text-violet-300",  ring: "ring-violet-500/40" },
};

const ALL_KINDS = Object.keys(KIND_LABELS);

export default function MediaView({ onSelect }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [filterKinds, setFilterKinds] = useState(new Set(ALL_KINDS));
  const [filterAgency, setFilterAgency] = useState("all");
  const [filterEvent, setFilterEvent] = useState("all");
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(null);

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
      if (!filterKinds.has(it.kind)) return false;
      if (filterAgency !== "all" && (it.agency || "—") !== filterAgency) return false;
      if (filterEvent !== "all" && it.eventId !== filterEvent) return false;
      if (q && !`${it.title} ${it.description} ${it.eventTitle}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, filterKinds, filterAgency, filterEvent, query]);

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
          {filtered.length} of {data.total} visuals · {data.eventCount} events
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        {ALL_KINDS.map(k => {
          const active = filterKinds.has(k);
          const c = KIND_COLORS[k];
          const n = data.byKind?.[k] || 0;
          return (
            <button key={k} onClick={() => toggleKind(k)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-sm border font-mono text-[10px] tracking-wider transition-colors ${
                active ? `${c.text} border-current` : "text-emerald-800 border-emerald-900/50 opacity-50"}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
              {KIND_LABELS[k]} <span className="opacity-60">{n}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
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
                <img src={`${import.meta.env.BASE_URL}${it.thumbnailPath}`} alt={it.title || it.kind}
                  className="w-full h-full object-cover opacity-90 group-hover:opacity-100" loading="lazy" />
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
                  {it.eventTitle} · p{it.page}
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
                <span className="font-mono text-[10px] text-emerald-500">p{focused.page}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
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
            <div className="flex-1 overflow-auto bg-black flex items-center justify-center p-2">
              <img src={`${import.meta.env.BASE_URL}${focused.imagePath}`} alt={focused.title || focused.kind}
                className="max-w-full max-h-[70vh] object-contain" />
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
