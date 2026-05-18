import React, { useState, useMemo, useEffect, Suspense, lazy } from "react";
import { EVENTS } from "./data/events.js";
import { ScanlineOverlay } from "./components/Primitives.jsx";
import CorpusFreshness from "./components/CorpusFreshness.jsx";
import Header from "./components/Header.jsx";
import VolunteerModal from "./components/VolunteerModal.jsx";
import TimelineView from "./views/TimelineView.jsx";
import AtlasView from "./views/AtlasView.jsx";
import NetworkView from "./views/NetworkView.jsx";
import SearchView from "./views/SearchView.jsx";
import LiveFeedView from "./views/LiveFeedView.jsx";
import HelpView from "./views/HelpView.jsx";
import DossierView from "./views/DossierView.jsx";
import ReviewView from "./views/ReviewView.jsx";

// Semantic search pulls in transformers.js (~25MB INT8 model + ORT wasm) —
// lazy-load it so first paint isn't gated on that bundle.
const SemanticSearchView = lazy(() => import("./views/SemanticSearchView.jsx"));

export default function App() {
  // LIVE is home — it's where the freshly-arrived data shows up, and it's
  // the view that carries the hero band. Every other view is "instrument."
  const [view, setView] = useState("live");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [selectionPage, setSelectionPage] = useState(null);
  const [volunteerOpen, setVolunteerOpen] = useState(false);

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
    setSelected(event);
    setSelectionPage(opts?.page ?? null);
    setView("dossier");
  };
  const handleViewChange = (v) => {
    setView(v);
    if (v !== "dossier") { setSelected(null); setSelectionPage(null); }
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
          {view === "network"  && <NetworkView  events={filtered} onSelect={handleSelect} />}
          {view === "search"   && <SearchView   onSelect={handleSelect} />}
          {view === "live"     && <LiveFeedView onSelect={handleSelect} />}
          {view === "review"   && <ReviewView   onSelect={handleSelect} />}
          {view === "help"     && <HelpView />}
          {view === "semantic" && (
            <Suspense fallback={
              <div className="px-3 sm:px-8 py-12 font-mono text-[11px] text-emerald-600 tracking-widest">
                ◌ loading semantic search engine…
              </div>
            }>
              <SemanticSearchView onSelect={handleSelect} />
            </Suspense>
          )}
          {view === "dossier" && (
            <DossierView event={selected}
              selectionPage={selectionPage}
              onClose={() => { setSelected(null); setSelectionPage(null); setView("live"); }}
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

      <VolunteerModal open={volunteerOpen} onClose={() => setVolunteerOpen(false)} />
    </div>
  );
}
