import React, { useEffect, useMemo, useState } from "react";
import { GlitchText } from "../components/Primitives.jsx";
import { useT } from "../i18n/context.js";

// MEDIA — every visually-meaningful page across the corpus, categorized
// by kind. Each tile is a page screenshot (~800px JPEG), not a bbox
// crop; click → modal with the full description + a deep-link straight
// to that page in DOSSIER (no scrolling required).

// Stable kind ids used by the index (`build-media-index.mjs`) and the
// classifier sidecars — never localized, only used as keys into the
// `media.kind.*` translation tree.
const KIND_IDS = [
  "video",
  "photograph",
  "hand-drawing",
  "photocopied-negative",
  "newspaper-clipping",
  "map",
  "diagram",
  "table",
];

// kind → translation-key suffix. Hyphens in kind ids don't work as dot
// path segments, so we normalize once here.
const KIND_TKEY = {
  "video": "video",
  "photograph": "photograph",
  "hand-drawing": "hand_drawing",
  "photocopied-negative": "photocopied_negative",
  "newspaper-clipping": "newspaper_clipping",
  "map": "map",
  "diagram": "diagram",
  "table": "table",
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

const ALL_KINDS = KIND_IDS;

// Map the Header's "ALL TYPES" dropdown (Document/Video/Image/Audio) into
// the media-kind taxonomy so the header filter actually subsets the grid.
// Document = pages without a visible image (e.g. table forms), Image =
// every visual kind, Video = video tiles, Audio = nothing today (no audio
// in MEDIA yet, so the filter empties the grid honestly).
const HEADER_TYPE_TO_KINDS = {
  Image: new Set(["photograph", "hand-drawing", "photocopied-negative", "newspaper-clipping", "map", "diagram", "table"]),
  Video: new Set(["video"]),
  Document: new Set(["table", "photocopied-negative"]),
  Audio: new Set(),
};

// IR-scope poster for video tiles — reticle + scanlines + play affordance.
// DVIDS clips can't be embedded, so this stands in for a thumbnail and the
// whole tile/modal links out to dvidshub.net.
function VideoPoster({ label, big }) {
  // Caller provides the label so we don't need to thread `t` into a
  // purely-presentational SVG. Defaults to the English DVIDS CTA when
  // a caller skips the prop.
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

export default function MediaView({ onSelect, headerFilters }) {
  const t = useT();
  const kindLabel = (k) => t(`media.kind.${KIND_TKEY[k] || k}`, undefined, k);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [filterKinds, setFilterKinds] = useState(new Set(ALL_KINDS));
  const [filterEvent, setFilterEvent] = useState("all");
  const [focused, setFocused] = useState(null);
  // The Header's search input + ALL AGENCIES / ALL TYPES dropdowns drive
  // these — keeping them as props instead of local state means typing in
  // the header bar filters MEDIA immediately. The in-page kind/event
  // selectors and placeholder toggle stay local because they have no
  // counterpart in the header.
  const query        = headerFilters?.query        ?? "";
  const filterAgency = headerFilters?.filterAgency ?? "all";
  const filterType   = headerFilters?.filterType   ?? "all";
  // Default: only show tiles with a real rendered image. The
  // text-only/placeholder tiles (extracted from Denis's Gemini
  // bracket markers on pages we can't render) are useful metadata
  // but look like noise when most of the grid is empty boxes.
  const [includePlaceholders, setIncludePlaceholders] = useState(false);
  // Same idea, but for blank renders — pages where a PNG exists on
  // disk but pdf.js produced a visually-empty image (typically 50s-era
  // hand-sketch pages). Tagged missingRender:true by the index builder.
  // Kept separate from placeholders because the cause is different
  // (broken render vs. no PDF) and the user wanted them surfaced as
  // their own group.
  const [includeMissingRenders, setIncludeMissingRenders] = useState(false);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}media.json?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setData)
      .catch(e => setErr(e.message));
  }, []);

  const filtered = useMemo(() => {
    if (!data?.items) return [];
    const q = query.trim().toLowerCase();
    const typeKinds = filterType !== "all" ? HEADER_TYPE_TO_KINDS[filterType] : null;
    return data.items.filter(it => {
      // Videos have no local image but must always be visible — they're
      // the release footage, not a metadata-only placeholder.
      // Blank renders also have imagePath:null but are gated by a
      // separate toggle (different cause from regular placeholders).
      if (it.kind !== "video") {
        if (it.missingRender) {
          if (!includeMissingRenders) return false;
        } else if (!it.imagePath) {
          if (!includePlaceholders) return false;
        }
      }
      if (!filterKinds.has(it.kind)) return false;
      if (typeKinds && !typeKinds.has(it.kind)) return false;
      if (filterAgency !== "all" && (it.agency || "—") !== filterAgency) return false;
      if (filterEvent !== "all" && it.eventId !== filterEvent) return false;
      if (q && !`${it.title} ${it.description} ${it.eventTitle}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, filterKinds, filterAgency, filterType, filterEvent, query, includePlaceholders, includeMissingRenders]);

  // Counts by bucket for the toggle labels. Four groups:
  //   withImage      — a real rendered PNG/JPG is attached
  //   placeholder    — no local PDF, just Gemini-transcript metadata
  //   missingRender  — a PNG exists but is visually blank (render failed)
  //   video          — video items aren't toggle-gated (always shown when
  //                    their kind filter is on), but they ARE visible
  //                    tiles, so the "X of Y" denominator must include
  //                    them or the numerator overshoots the denominator
  //                    once any video is on screen.
  const counts = useMemo(() => {
    if (!data?.items) return { withImage: 0, placeholder: 0, missingRender: 0, video: 0 };
    return data.items.reduce((acc, it) => {
      if (it.kind === "video") { acc.video++; return acc; }
      if (it.missingRender) acc.missingRender++;
      else if (it.imagePath) acc.withImage++;
      else acc.placeholder++;
      return acc;
    }, { withImage: 0, placeholder: 0, missingRender: 0, video: 0 });
  }, [data]);

  // Per-kind counts honoring both toggles. Without this, the filter
  // pills show `data.byKind` (all items) — so PHOTOGRAPH would read
  // "82" even when the grid is hiding 64 placeholders and only showing
  // 18 actual photos. That mismatch is the "filter calls out images
  // but has none attached" confusion.
  const kindCounts = useMemo(() => {
    if (!data?.items) return {};
    const out = {};
    for (const it of data.items) {
      if (it.kind !== "video") {
        if (it.missingRender && !includeMissingRenders) continue;
        if (!it.missingRender && !it.imagePath && !includePlaceholders) continue;
      }
      out[it.kind] = (out[it.kind] || 0) + 1;
    }
    return out;
  }, [data, includePlaceholders, includeMissingRenders]);

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

  if (err) return <div className="p-4 text-rose-400 font-mono text-xs">{t("media.unavailable", { error: err })}</div>;
  if (!data) return <div className="p-4 text-emerald-700 font-mono text-xs">{t("media.loading")}</div>;
  if (!data.items.length) {
    return (
      <div className="p-8 max-w-2xl mx-auto text-center">
        <div className="text-emerald-300 font-mono text-xs tracking-widest mb-3">{t("media.empty_title")}</div>
        <div className="text-emerald-700 text-[11px] font-mono leading-relaxed">
          {t("media.empty_body", { cmd: "npm run corpus:classify" })}
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
          <GlitchText>{t("media.title")}</GlitchText>
        </h2>
        <div className="font-mono text-[10px] text-emerald-700">
          {/*
            Denominator matches whichever buckets the user has toggled
            on — without this, "X of 198" stays static even when 115
            placeholders are hidden, so the user sees "18 of 198" and
            can't tell whether their filters threw out 180 tiles or
            whether 115 were placeholders hidden by the toggle.
          */}
          {t("media.of_visuals", {
            shown: filtered.length,
            total: counts.withImage
              + counts.video
              + (includePlaceholders ? counts.placeholder : 0)
              + (includeMissingRenders ? counts.missingRender : 0),
            events: data.eventCount,
          })}
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
              title={empty ? t("media.no_pill_title", { kind: kindLabel(k) }) : undefined}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-sm border font-mono text-[10px] tracking-wider transition-colors ${
                active && !empty ? `${c.text} border-current`
                : active && empty ? "text-emerald-800 border-emerald-900/40 opacity-40"
                : "text-emerald-800 border-emerald-900/50 opacity-50"}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${c.dot} ${empty ? "opacity-40" : ""}`} />
              {kindLabel(k)} <span className="opacity-60">{n}</span>
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
            ? t("media.placeholder_title_on", { n: counts.placeholder })
            : t("media.placeholder_title_off", { with_image: counts.withImage, placeholder: counts.placeholder })}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-sm border font-mono text-[10px] tracking-wider transition-colors ${
            includePlaceholders
              ? "text-cyan-300 border-cyan-500/50 bg-cyan-950/20"
              : "text-emerald-300 border-emerald-700/50 hover:border-emerald-500/60"}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${includePlaceholders ? "bg-cyan-400" : "bg-emerald-400"}`} />
          {includePlaceholders
            ? <>{t("media.placeholders_on")} <span className="opacity-60 ml-0.5">{counts.placeholder}</span></>
            : <>{t("media.with_image_label")} <span className="opacity-60 ml-0.5">{counts.withImage}</span><span className="opacity-40 ml-1.5">{t("media.with_image_hidden", { n: counts.placeholder })}</span></>}
        </button>
        {/*
          Missing-render toggle. A separate bucket from placeholders:
          here a PNG actually exists on disk but pdf.js produced a
          visually-blank render (typical of hand-sketches in 50s-era
          reports where the visual lives in a layer pdf.js can't reach).
          The classifier still has a useful description from Gemini's
          transcript, so we surface the metadata via the same tile UI
          but flag the broken render distinctly. Hidden until the user
          opts in — only renders this affects today are 4 pages across
          Krasuski + USSR Trans-Caucasus.
        */}
        {counts.missingRender > 0 && (
          <button onClick={() => setIncludeMissingRenders(v => !v)}
            title={includeMissingRenders
              ? t("media.missing_render_title_on", { n: counts.missingRender })
              : t("media.missing_render_title_off", { n: counts.missingRender })}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-sm border font-mono text-[10px] tracking-wider transition-colors ${
              includeMissingRenders
                ? "text-amber-300 border-amber-500/50 bg-amber-950/20"
                : "text-emerald-300 border-emerald-700/50 hover:border-amber-500/60"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${includeMissingRenders ? "bg-amber-400" : "bg-amber-700"}`} />
            {includeMissingRenders
              ? <>{t("media.missing_render_on")} <span className="opacity-60 ml-0.5">{counts.missingRender}</span></>
              : <>{t("media.missing_render_off")} <span className="opacity-40 ml-1.5">{t("media.with_image_hidden", { n: counts.missingRender })}</span></>}
          </button>
        )}
        {/* Title/description search + agency dropdown have moved to the
            header filter bar so they share state across the whole site.
            The per-event selector is kept here — it's media-specific. */}
        <select value={filterEvent} onChange={(e) => setFilterEvent(e.target.value)}
          className="bg-black/60 border border-emerald-700/50 rounded-sm px-2 py-1 text-emerald-300 font-mono text-xs max-w-xs">
          <option value="all">{t("media.all_events")}</option>
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
                  <VideoPoster label={t("media.play_dvids")} />
                ) : it.thumbnailPath ? (
                  <img src={`${import.meta.env.BASE_URL}${it.thumbnailPath}`} alt={it.title || it.kind}
                    className="w-full h-full object-cover opacity-90 group-hover:opacity-100" loading="lazy" />
                ) : it.missingRender ? (
                  // PNG exists on disk but pdf.js produced a blank
                  // render — distinct amber treatment so the user can
                  // see at a glance these are broken renders, not the
                  // cyan "no PDF available" placeholders.
                  <div className="w-full h-full flex flex-col items-center justify-center p-3 bg-amber-950/20">
                    <span className="w-2 h-2 rounded-full bg-amber-400 mb-2" />
                    <span className="font-mono text-[9px] tracking-widest text-amber-300 opacity-80 mb-1">{t("media.missing_render_tag")}</span>
                    <span className="font-mono text-[10px] text-amber-200 opacity-90 text-center line-clamp-4">
                      {it.description || it.title || kindLabel(it.kind)}
                    </span>
                  </div>
                ) : (
                  // No local render available (e.g. extracted from a Gemini
                  // transcript marker for an event we don't have the PDF
                  // for). Show a placeholder + the description so the
                  // metadata is still useful.
                  <div className="w-full h-full flex flex-col items-center justify-center p-3 bg-emerald-950/30">
                    <span className={`w-2 h-2 rounded-full ${c.dot} mb-2`} />
                    <span className={`font-mono text-[9px] tracking-widest ${c.text} opacity-70 mb-1`}>{t("media.no_local_image")}</span>
                    <span className={`font-mono text-[10px] ${c.text} opacity-90 text-center line-clamp-4`}>
                      {it.description || it.title || kindLabel(it.kind)}
                    </span>
                  </div>
                )}
              </div>
              <div className="px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <span className={`w-1 h-1 rounded-full ${c.dot}`} />
                  <span className={`font-mono text-[8.5px] tracking-widest ${c.text}`}>{kindLabel(it.kind)}</span>
                </div>
                <div className="font-mono text-[11px] text-emerald-200 leading-snug mt-0.5 line-clamp-2">
                  {it.title || it.description || t("media.page_short", { n: it.page })}
                </div>
                <div className="font-mono text-[9px] text-emerald-700 mt-0.5 truncate">
                  {it.kind === "video" ? `${it.eventTitle} · DVIDS` : `${it.eventTitle} · ${t("media.page_p_short", { n: it.page })}`}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {filtered.length === 0 && (
        <div className="p-8 text-center text-emerald-700 font-mono text-xs">{t("media.no_matches")}</div>
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
                <span className={`font-mono text-[10px] tracking-widest ${KIND_COLORS[focused.kind].text}`}>{kindLabel(focused.kind)}</span>
                <span className="font-mono text-[10px] text-emerald-700">·</span>
                <span className="font-mono text-[11px] text-emerald-200 truncate">{focused.eventTitle}</span>
                <span className="font-mono text-[10px] text-emerald-700">·</span>
                <span className="font-mono text-[10px] text-emerald-500">{focused.kind === "video" ? "DVIDS" : t("media.page_p_short", { n: focused.page })}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {focused.kind === "video" && (
                  <a href={focused.dvidsUrl || `https://www.dvidshub.net/video/${focused.videoId}`}
                    target="_blank" rel="noopener noreferrer"
                    className="font-mono text-[10px] tracking-widest border border-blue-600/60 text-blue-300 hover:bg-blue-900/30 px-2 py-1 rounded-sm">
                    {t("media.play_dvids")}
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
                    {t("media.open_in_dossier")}
                  </button>
                )}
                <button onClick={() => setFocused(null)} aria-label={t("volunteer.close")}
                  className="text-emerald-700 hover:text-amber-300 font-mono text-sm px-2">×</button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-black flex items-center justify-center p-6 min-h-[40vh]">
              {focused.kind === "video" ? (
                <div className="w-full max-w-3xl aspect-video rounded-sm border border-blue-700/40 overflow-hidden bg-black">
                  <iframe
                    className="w-full h-full"
                    src={`https://www.dvidshub.net/video/embed/${focused.videoId}`}
                    title={focused.title || "DVIDS video"}
                    allow="autoplay; fullscreen; picture-in-picture"
                    allowFullScreen
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                  />
                </div>
              ) : focused.imagePath ? (
                <img src={`${import.meta.env.BASE_URL}${focused.imagePath}`} alt={focused.title || focused.kind}
                  className="max-w-full max-h-[70vh] object-contain" />
              ) : focused.missingRender ? (
                <div className="text-center max-w-xl">
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-sm border border-amber-500/40 mb-4">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                    <span className="font-mono text-[10px] tracking-widest text-amber-300">
                      {t("media.missing_render_modal_label", { kind: kindLabel(focused.kind) })}
                    </span>
                  </div>
                  <div className="font-mono text-amber-100 text-sm leading-relaxed text-left">
                    {focused.description || focused.title}
                  </div>
                  <div className="font-mono text-amber-700 text-[10px] mt-4 leading-relaxed">
                    {t("media.missing_render_explainer")}
                  </div>
                </div>
              ) : (
                <div className="text-center max-w-xl">
                  <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-sm border ${KIND_COLORS[focused.kind].ring} mb-4`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${KIND_COLORS[focused.kind].dot}`} />
                    <span className={`font-mono text-[10px] tracking-widest ${KIND_COLORS[focused.kind].text}`}>
                      {t("media.no_local_render_modal_label", { kind: kindLabel(focused.kind) })}
                    </span>
                  </div>
                  <div className="font-mono text-emerald-300 text-sm leading-relaxed text-left">
                    {focused.description || focused.title}
                  </div>
                  <div className="font-mono text-emerald-700 text-[10px] mt-4 leading-relaxed">
                    {t("media.no_local_render_explainer")}
                  </div>
                </div>
              )}
            </div>
            {(focused.title || focused.description) && (
              <div className="px-4 py-3 border-t border-emerald-900/50">
                {focused.title && <div className="font-mono text-emerald-200 text-sm leading-snug">{focused.title}</div>}
                {focused.description && <div className="font-mono text-emerald-500 text-[12px] mt-1 leading-snug">{focused.description}</div>}
                <div className="font-mono text-[9px] text-emerald-800 mt-2 tracking-widest">
                  {t("media.classified_by", { classifier: focused.classifier || "?", date: focused.classifiedAt?.slice(0, 10) || "—" })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
