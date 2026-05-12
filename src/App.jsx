import React, { useState, useMemo, useEffect, Suspense, lazy } from "react";
import { EVENTS } from "./data/events.js";
import { ScanlineOverlay, GrainOverlay, VignetteOverlay, RadarSweep } from "./components/Primitives.jsx";
import Header from "./components/Header.jsx";
import TimelineView from "./views/TimelineView.jsx";
import GlobeView from "./views/GlobeView.jsx";
import AtlasView from "./views/AtlasView.jsx";
import NetworkView from "./views/NetworkView.jsx";
import PatternsView from "./views/PatternsView.jsx";
import ThreadsView from "./views/ThreadsView.jsx";
import ConstellationView from "./views/ConstellationView.jsx";
import SearchView from "./views/SearchView.jsx";
import DossierView from "./views/DossierView.jsx";

// Semantic search pulls in transformers.js (~25MB INT8 model + ORT wasm) —
// lazy-load it so first paint isn't gated on that bundle.
const SemanticSearchView = lazy(() => import("./views/SemanticSearchView.jsx"));

export default function App() {
  const [view, setView] = useState("timeline");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [tickerIdx, setTickerIdx] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTickerIdx(i => (i + 1) % EVENTS.length), 3500);
    return () => clearInterval(id);
  }, []);

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

  const handleSelect = (event) => { setSelected(event); setView("dossier"); };
  const handleViewChange = (v) => { setView(v); if (v !== "dossier") setSelected(null); };
  const tickerEvent = EVENTS[tickerIdx];

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
        @keyframes flicker { 0%,100% { opacity: 1; } 50% { opacity: 0.97; } }
        .crt-flicker { animation: flicker 5s infinite; }
      `}</style>

      <ScanlineOverlay />
      <GrainOverlay />
      <VignetteOverlay />

      <div className="crt-flicker relative z-10">
        <Header
          ticker={tickerEvent ? `LIVE: ${tickerEvent.title.slice(0,40)}…` : ""}
          view={view} onViewChange={handleViewChange} onSearch={setQuery} query={query}
        />

        {view !== "dossier" && (
          <div className="px-3 sm:px-8 pt-6 pb-4 border-b border-emerald-700/20">
            <div className="grid lg:grid-cols-[1fr,auto] gap-5 items-start">
              <div>
                <div className="font-mono text-[10px] text-amber-400 tracking-[0.4em] mb-2">
                  ◊ PRESIDENTIAL UNSEALING & REPORTING SYSTEM FOR UAP ENCOUNTERS ◊
                </div>
                <h1 className="font-mono text-emerald-100 text-2xl sm:text-4xl lg:text-5xl leading-none tracking-tight" style={{
                  fontFamily: "'Major Mono Display', monospace",
                  textShadow: "0 0 30px rgba(124,255,178,0.3)",
                }}>
                  CONSOLE<span className="text-amber-400 ml-2">/</span>
                  <span className="text-emerald-500 text-base sm:text-2xl"> RELEASE 01</span>
                </h1>
                <div className="font-mono text-[11px] text-emerald-500 mt-3 max-w-2xl leading-relaxed">
                  Department of War. May 8, 2026. 162 records released — 120 PDFs, 28 videos, 14 images. All cases UNRESOLVED.
                  This console adds connective tissue: <span className="text-amber-300">NETWORK</span> shows the entity graph, <span className="text-amber-300">PATTERNS</span> the recurring signatures, <span className="text-amber-300">THREADS</span> the curated narrative arcs. Tap any record to read the dossier.
                </div>
              </div>
              <div className="hidden lg:block"><RadarSweep size={120} /></div>
            </div>
          </div>
        )}

        <main>
          {view === "timeline" && <TimelineView events={filtered} onSelect={handleSelect} />}
          {view === "globe" && <GlobeView events={filtered} onSelect={handleSelect} />}
          {view === "atlas" && <AtlasView events={filtered} onSelect={handleSelect} />}
          {view === "network" && <NetworkView events={filtered} onSelect={handleSelect} />}
          {view === "patterns" && <PatternsView events={filtered} onSelect={handleSelect} />}
          {view === "threads" && <ThreadsView events={filtered} onSelect={handleSelect} />}
          {view === "constellation" && <ConstellationView events={filtered} onSelect={handleSelect} />}
          {view === "search" && <SearchView onSelect={handleSelect} />}
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
              onClose={() => { setSelected(null); setView("timeline"); }}
              onSelect={handleSelect}
              onJumpThread={() => setView("threads")}
              allEvents={EVENTS} />
          )}
        </main>

        <footer className="border-t border-emerald-700/30 mt-10 px-3 sm:px-8 py-6">
          <div className="font-mono text-[9px] text-emerald-700 tracking-widest space-y-1">
            <div>▌ SOURCE: WAR.GOV/UFO RELEASE 01 // CLEARED MAY 8, 2026</div>
            <div>▌ ALL CASES UNRESOLVED — GOVERNMENT UNABLE TO MAKE DEFINITIVE DETERMINATION</div>
            <div>▌ INTERAGENCY: WHITE HOUSE / ODNI / DOE / AARO / NASA / FBI / DOW</div>
            <div>▌ CONSOLE BUILT FROM OFFICIAL INVENTORY MIRROR — ENTITIES + THREADS HAND-CURATED FROM PRIMARY DOCS</div>
          </div>
        </footer>
      </div>
    </div>
  );
}
