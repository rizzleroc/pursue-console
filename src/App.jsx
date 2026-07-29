import React, { useState, useMemo, useEffect, Suspense, lazy } from "react";
import { EVENTS, RELEASES_LABEL } from "./data/events.js";
import { useT } from "./i18n/context.js";

// Global handle for cross-view event lookups (MediaView, ReviewView use
// this when their deep-link buttons only have eid + title, but the
// DossierView wants the full event metadata).
if (typeof window !== "undefined") {
  window.__EVENTS_BY_ID = Object.fromEntries(EVENTS.map(e => [e.id, e]));
}
import { ScanlineOverlay } from "./components/Primitives.jsx";
import CorpusFreshness from "./components/CorpusFreshness.jsx";
import Header from "./components/Header.jsx";
import RecordFilterBar from "./components/RecordFilterBar.jsx";
import VolunteerModal from "./components/VolunteerModal.jsx";
import LaunchOverlay from "./components/LaunchOverlay.jsx";
import TimelineView from "./views/TimelineView.jsx";
import AtlasView from "./views/AtlasView.jsx";
import GlobeView from "./views/GlobeView.jsx";
import NetworkView from "./views/NetworkView.jsx";
import VectorMapView from "./views/VectorMapView.jsx";
import SearchView from "./views/SearchView.jsx";
import LiveFeedView from "./views/LiveFeedView.jsx";
import HelpView from "./views/HelpView.jsx";
import DossierView from "./views/DossierView.jsx";
import ReviewView from "./views/ReviewView.jsx";
import MediaView from "./views/MediaView.jsx";

// ASK pulls in @huggingface/transformers (~25 MB ORT wasm + INT8 model)
// for its SMART/RAG mode. Lazy-load so first paint isn't gated on it —
// users who never click ASK don't pay the cost.
const AskView = lazy(() => import("./views/AskView.jsx"));

// Semantic search pulls in transformers.js (~25MB INT8 model + ORT wasm) —
// lazy-load it so first paint isn't gated on that bundle.
const SemanticSearchView = lazy(() => import("./views/SemanticSearchView.jsx"));

// Collapse the free-form `type` field into the four record categories
// war.gov/UFO filters by (the "ALL TYPES" dropdown). Mirrors LiveFeedView's
// mediaTypeOf so the taxonomy is consistent across the app.
// Exported so views (SearchView, SemanticSearchView, AskView, etc.) can
// reuse the same bucketing instead of duplicating regex.
export function recordType(e) {
  const t = (e.type || "").toLowerCase();
  if (e.videoId || /video/.test(t)) return "Video";
  if (/audio/.test(t)) return "Audio";
  if (/image|imagery|photo/.test(t)) return "Image";
  return "Document";
}

// Apply the header filters (agency/release/type/query) against any
// events-like array. Views that hit the EVENTS catalogue directly
// (SearchView, SemanticSearchView results, AskView results) call this
// instead of just filtering on `query`. The query is a substring match
// over title + summary + loc + agency + tags; if you pass a different
// query (e.g. a semantic-search hit body), include it in the haystack
// via the `extraHaystack` callback.
export function matchesHeaderFilters(e, headerFilters) {
  if (!e) return false;
  const { filterAgency, filterRelease, filterType } = headerFilters || {};
  if (filterAgency && filterAgency !== "all" && e.agency !== filterAgency) return false;
  if (filterType   && filterType   !== "all" && recordType(e) !== filterType) return false;
  if (filterRelease && filterRelease !== "all" && (e.release || "Release 01") !== filterRelease) return false;
  return true;
}

export default function App() {
  const t = useT();
  // LIVE is home — it's where the freshly-arrived data shows up, and it's
  // the view that carries the hero band. Every other view is "instrument."
  const [view, setView] = useState("live");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [selectionPage, setSelectionPage] = useState(null);
  // When a deep-link arrives from Semantic Search, carry the matched chunk
  // text + the active query terms so DossierView can show "this is what
  // your search hit" inline on the deep-linked page. Cleared on close /
  // view change so subsequent dossier visits don't show a stale banner.
  const [selectionMatch, setSelectionMatch] = useState(null);
  const [volunteerOpen, setVolunteerOpen] = useState(false);
  // war.gov/UFO-style record filters (Header dropdowns). Release is a single
  // value today (Release 01) but kept as a filter so future tranches slot in.
  const [filterAgency, setFilterAgency] = useState("all");
  const [filterRelease, setFilterRelease] = useState("all");
  const [filterType, setFilterType] = useState("all");
  // One-time 2.0 launch overlay. Gate is read once on mount; closing the
  // overlay writes the localStorage flag so it never returns on reload.
  const [showLaunch, setShowLaunch] = useState(() => {
    try { return localStorage.getItem("pursue:launch-2.0-seen") !== "1"; }
    catch { return true; }
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hf = { filterAgency, filterRelease, filterType };
    return EVENTS.filter(e => {
      if (!matchesHeaderFilters(e, hf)) return false;
      if (q && !(
        e.title.toLowerCase().includes(q) ||
        e.summary.toLowerCase().includes(q) ||
        e.loc.toLowerCase().includes(q) ||
        e.agency.toLowerCase().includes(q) ||
        (e.tags || []).some(t => t.toLowerCase().includes(q))
      )) return false;
      return true;
    });
  }, [query, filterAgency, filterRelease, filterType]);

  const handleSelect = (event, opts) => {
    setSelected(event);
    setSelectionPage(opts?.page ?? null);
    setSelectionMatch(opts?.matchText
      ? { text: opts.matchText, terms: opts.matchTerms || [] }
      : null);
    setView("dossier");
  };
  const handleViewChange = (v) => {
    setView(v);
    if (v !== "dossier") { setSelected(null); setSelectionPage(null); setSelectionMatch(null); }
  };

  // Help link survives as a tab even after we cleaned up the nav — it's
  // just not in the analysis bar. Treat it like a primary so the user can
  // get to it from anywhere.
  const showHero  = view === "live";
  const showFooter = view === "live" || view === "help";
  // Catalogue views — these consume App.filtered directly, so the
  // RecordFilterBar can render a "showing N / total" count for them.
  // Other views drive their own datasets (media.json, live-feed.json,
  // review-queue.json) and surface counts in their own UI; the bar
  // hides the count there to avoid showing a wrong "N / total".
  const CATALOGUE_VIEWS = new Set(["timeline", "atlas", "globe", "network"]);
  // Bundle the header filter state so each view can apply whatever subset
  // is relevant to its dataset (LIVE filters live-feed.json signals,
  // MEDIA filters media.json items, REVIEW filters the review queue, etc).
  const headerFilters = { query, filterAgency, filterType, filterRelease };

  return (
    <div className="min-h-screen bg-[#020806] text-emerald-300 relative overflow-x-hidden" style={{
      fontFamily: "'IBM Plex Mono', 'JetBrains Mono', 'Fira Code', monospace",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Major+Mono+Display&display=swap');
        @keyframes radarSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes fadein { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fadein { animation: fadein 0.4s ease-out; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        body { background: #020806; }
      `}</style>

      {/* One overlay layer. Vignette + grain are gone — they made everything
          look foggy and inverted the legibility-first principle. */}
      <ScanlineOverlay />

      <div className="relative z-10">
        <Header
          view={view} onViewChange={handleViewChange}
          onVolunteer={() => setVolunteerOpen(true)} />
        {!showHero && <CorpusFreshness compact />}

        {/* The filter bar moved out of the header chrome and sits here,
            directly above the view content, so the search input + agency /
            release / type dropdowns are visually adjacent to the data
            they filter. Hidden in DOSSIER (single-record view; the
            filters wouldn't change anything) and HELP. */}
        {view !== "dossier" && view !== "help" && (
          <RecordFilterBar
            query={query} onSearch={setQuery}
            filterAgency={filterAgency} onFilterAgency={setFilterAgency}
            filterRelease={filterRelease} onFilterRelease={setFilterRelease}
            filterType={filterType} onFilterType={setFilterType}
            // Only show "X / Y" counts on catalogue views where App.filtered
            // is the source of truth. Other views (MEDIA / LIVE / etc) drive
            // their own datasets and surface counts in their own UI.
            resultCount={CATALOGUE_VIEWS.has(view) ? filtered.length : null}
            totalCount={CATALOGUE_VIEWS.has(view) ? EVENTS.length : null}
          />
        )}

        <main>
          {view === "timeline" && <TimelineView events={filtered} onSelect={handleSelect} />}
          {view === "atlas"    && <AtlasView    events={filtered} onSelect={handleSelect} />}
          {view === "globe"    && <GlobeView    events={filtered} onSelect={handleSelect} />}
          {view === "network"  && <NetworkView  events={filtered} onSelect={handleSelect} />}
          {view === "map"      && <VectorMapView onSelect={handleSelect} headerFilters={headerFilters} />}
          {view === "search"   && <SearchView   onSelect={handleSelect} headerFilters={headerFilters} />}
          {view === "live"     && <LiveFeedView onSelect={handleSelect} headerFilters={headerFilters} />}
          {view === "review"   && <ReviewView   onSelect={handleSelect} headerFilters={headerFilters} />}
          {view === "media"    && <MediaView    onSelect={handleSelect} headerFilters={headerFilters} />}
          {view === "ask" && (
            <Suspense fallback={
              <div className="px-3 sm:px-8 py-12 font-mono text-[11px] text-emerald-600 tracking-widest">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse mr-2" />
                {t("app.loading_ask")}
              </div>
            }>
              <AskView onSelect={handleSelect} headerFilters={headerFilters} />
            </Suspense>
          )}
          {view === "help"     && <HelpView onViewChange={handleViewChange} />}
          {view === "semantic" && (
            <Suspense fallback={
              <div className="px-3 sm:px-8 py-12 font-mono text-[11px] text-emerald-600 tracking-widest space-y-2">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  {t("app.loading_semantic_title")}
                </div>
                <div className="text-emerald-800 text-[10px] tracking-widest">
                  {t("app.loading_semantic_size")}
                </div>
                <div className="text-emerald-800 text-[10px] tracking-widest">
                  {t("app.loading_semantic_hint")}
                </div>
              </div>
            }>
              <SemanticSearchView onSelect={handleSelect} headerFilters={headerFilters} />
            </Suspense>
          )}
          {view === "dossier" && (
            <DossierView event={selected}
              selectionPage={selectionPage}
              selectionMatch={selectionMatch}
              onClose={() => { setSelected(null); setSelectionPage(null); setSelectionMatch(null); setView("live"); }}
              onSelect={handleSelect}
              allEvents={EVENTS} />
          )}
        </main>

        {showFooter ? (
          <footer className="border-t border-emerald-700/30 mt-10 px-3 sm:px-8 py-6">
            <div className="font-mono text-[9px] text-emerald-700 tracking-widest space-y-1">
              <div>{t("footer.source", { releases: RELEASES_LABEL.toUpperCase() })}</div>
              <div>{t("footer.unresolved")}</div>
              <div>{t("footer.interagency")}</div>
            </div>
          </footer>
        ) : (
          <footer className="border-t border-emerald-900/30 mt-6 px-3 sm:px-8 py-3 text-center">
            <span className="font-mono text-[9px] text-emerald-800 tracking-widest">
              {t("footer.compact", { releases: RELEASES_LABEL.toLowerCase() })}
            </span>
          </footer>
        )}
      </div>

      <VolunteerModal open={volunteerOpen} onClose={() => setVolunteerOpen(false)} onViewChange={handleViewChange} />

      {showLaunch && <LaunchOverlay onClose={() => setShowLaunch(false)} />}
    </div>
  );
}
