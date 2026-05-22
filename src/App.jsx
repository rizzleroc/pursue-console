import React, { useState, useMemo, useEffect, Suspense, lazy } from "react";
import { EVENTS } from "./data/events.js";
import { parseHash, buildHash } from "./lib/route.js";

// Global handle for cross-view event lookups (MediaView, ReviewView use
// this when their deep-link buttons only have eid + title, but the
// DossierView wants the full event metadata).
if (typeof window !== "undefined") {
  window.__EVENTS_BY_ID = Object.fromEntries(EVENTS.map(e => [e.id, e]));
}
import { ScanlineOverlay } from "./components/Primitives.jsx";
import CorpusFreshness from "./components/CorpusFreshness.jsx";
import Header from "./components/Header.jsx";
import VolunteerModal from "./components/VolunteerModal.jsx";
import TimelineView from "./views/TimelineView.jsx";
import AtlasView from "./views/AtlasView.jsx";
import GlobeView from "./views/GlobeView.jsx";
import NetworkView from "./views/NetworkView.jsx";
import SearchView from "./views/SearchView.jsx";
import LiveFeedView from "./views/LiveFeedView.jsx";
import HelpView from "./views/HelpView.jsx";
import DossierView from "./views/DossierView.jsx";
import ReviewView from "./views/ReviewView.jsx";
import MediaView from "./views/MediaView.jsx";

// Semantic search pulls in transformers.js (~25MB INT8 model + ORT wasm) —
// lazy-load it so first paint isn't gated on that bundle.
const SemanticSearchView = lazy(() => import("./views/SemanticSearchView.jsx"));

export default function App() {
  // The URL hash is the source of truth for navigation — LIVE is home and
  // maps to #/live, every other view to its own route, and a drilled-down
  // record to #/dossier/<id>. State is derived from the hash so back/forward
  // and shared links work; nav actions just push a new hash.
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  const [query, setQuery] = useState("");
  const [volunteerOpen, setVolunteerOpen] = useState(false);

  // The match banner from a Semantic Search deep-link (matched chunk text +
  // query terms) can't be encoded in the URL, so we keep it in state across
  // the hash-change round-trip, tagged with the dossier id it belongs to so
  // it never bleeds onto a different record reached via back/forward.
  const [selectionMatch, setSelectionMatch] = useState(null);

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    if (!window.location.hash) window.history.replaceState(null, "", buildHash({ view: "live" }));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (target) => { window.location.hash = buildHash(target); };

  const view = route.view;
  const selected = route.eventId ? (window.__EVENTS_BY_ID?.[route.eventId] || null) : null;
  const selectionPage = route.page;
  const activeMatch = selectionMatch && selectionMatch.eventId === route.eventId
    ? { text: selectionMatch.text, terms: selectionMatch.terms }
    : null;

  const filtered = useMemo(() => {
    if (!query.trim()) return EVENTS;
    const q = query.toLowerCase();
    return EVENTS.filter(e =>
      e.title.toLowerCase().includes(q) ||
      e.summary.toLowerCase().includes(q) ||
      e.loc.toLowerCase().includes(q) ||
      e.agency.toLowerCase().includes(q) ||
      (e.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }, [query]);

  const handleSelect = (event, opts) => {
    setSelectionMatch(opts?.matchText
      ? { eventId: event.id, text: opts.matchText, terms: opts.matchTerms || [] }
      : null);
    navigate({ view: "dossier", eventId: event.id, page: opts?.page ?? null });
  };
  const handleViewChange = (v) => {
    if (v !== "dossier") setSelectionMatch(null);
    navigate({ view: v });
  };

  // Help link survives as a tab even after we cleaned up the nav — it's
  // just not in the analysis bar. Treat it like a primary so the user can
  // get to it from anywhere.
  const showHero  = view === "live";
  const showFooter = view === "live" || view === "help";

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
          query={query} onSearch={setQuery}
          onVolunteer={() => setVolunteerOpen(true)} />
        {!showHero && <CorpusFreshness compact />}

        <main>
          {view === "timeline" && <TimelineView events={filtered} onSelect={handleSelect} />}
          {view === "atlas"    && <AtlasView    events={filtered} onSelect={handleSelect} />}
          {view === "globe"    && <GlobeView    events={filtered} onSelect={handleSelect} />}
          {view === "network"  && <NetworkView  events={filtered} onSelect={handleSelect} />}
          {view === "search"   && <SearchView   onSelect={handleSelect} />}
          {view === "live"     && <LiveFeedView onSelect={handleSelect} />}
          {view === "review"   && <ReviewView   onSelect={handleSelect} />}
          {view === "media"    && <MediaView    onSelect={handleSelect} />}
          {view === "help"     && <HelpView onViewChange={handleViewChange} />}
          {view === "semantic" && (
            <Suspense fallback={
              <div className="px-3 sm:px-8 py-12 font-mono text-[11px] text-emerald-600 tracking-widest space-y-2">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  LOADING SEMANTIC SEARCH ENGINE
                </div>
                <div className="text-emerald-800 text-[10px] tracking-widest">
                  ~25 MB ORT WASM + INT8 model (first visit only — cached in IndexedDB after)
                </div>
                <div className="text-emerald-800 text-[10px] tracking-widest">
                  on a slow connection this can take 30+ seconds. SEARCH (lexical) is available now if you'd rather not wait.
                </div>
              </div>
            }>
              <SemanticSearchView onSelect={handleSelect} />
            </Suspense>
          )}
          {view === "dossier" && (
            <DossierView event={selected}
              selectionPage={selectionPage}
              selectionMatch={activeMatch}
              onClose={() => { setSelectionMatch(null); navigate({ view: "live" }); }}
              onSelect={handleSelect}
              allEvents={EVENTS} />
          )}
        </main>

        {showFooter ? (
          <footer className="border-t border-emerald-700/30 mt-10 px-3 sm:px-8 py-6">
            <div className="font-mono text-[9px] text-emerald-700 tracking-widest space-y-1">
              <div>▌ SOURCE: WAR.GOV/UFO RELEASE 01 // CLEARED MAY 8, 2026</div>
              <div>▌ ALL CASES UNRESOLVED — GOVERNMENT UNABLE TO MAKE DEFINITIVE DETERMINATION</div>
              <div>▌ INTERAGENCY: WHITE HOUSE / ODNI / DOE / AARO / NASA / FBI / DOW</div>
            </div>
          </footer>
        ) : (
          <footer className="border-t border-emerald-900/30 mt-6 px-3 sm:px-8 py-3 text-center">
            <span className="font-mono text-[9px] text-emerald-800 tracking-widest">
              ▌ war.gov/UFO · release 01 · all cases unresolved
            </span>
          </footer>
        )}
      </div>

      <VolunteerModal open={volunteerOpen} onClose={() => setVolunteerOpen(false)} onViewChange={handleViewChange} />
    </div>
  );
}
