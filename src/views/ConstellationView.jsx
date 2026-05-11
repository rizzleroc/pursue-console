import React, { useMemo, useState } from "react";
import { GlitchText, MiniChip, RadarSweep } from "../components/Primitives.jsx";
import corpus from "../data/corpus.json";

// CONSTELLATION (corpus-powered).
// Term cloud is built from full-text extraction of the primary PDFs
// (scripts/fetch-pdfs.mjs + scripts/extract-text.mjs). Hand-curated
// tags from events.js are folded in as a separate, elevated band.

const MODES = [
  { id: "all",    label: "ALL TERMS",   help: "every term that appears in ≥ 2 documents" },
  { id: "names",  label: "PROPER NOUNS", help: "capitalized-in-source-context terms (heuristic)" },
  { id: "tags",   label: "CURATED TAGS", help: "hand-picked tags from event records" },
  { id: "rare",   label: "RARE TERMS",   help: "terms that appear in exactly one document — the strange signal" },
];

// Light heuristic: a term that always co-occurs with a capital letter in its
// raw form is more likely a proper noun. We don't have casing in the index
// (it was lowercased for tokenization), so we use a proxy: high relative
// frequency in a single document. Good-enough for surfacing the names.
function isLikelyProperNoun(term, byTerm, byEvent) {
  if (term.length < 4) return false;
  const events = byTerm[term] || [];
  if (events.length === 0) return false;
  // Concentration: max count in any one doc / total count
  let total = 0, max = 0;
  for (const eid of events) {
    const c = byEvent[eid]?.terms?.[term] || 0;
    total += c; if (c > max) max = c;
  }
  if (total < 3) return false;
  // a real name tends to repeat *within* a single doc
  return max >= 3 && (max / total) >= 0.55;
}

export default function ConstellationView({ events, onSelect }) {
  const corpusLoaded = corpus && corpus.globalTerms && Object.keys(corpus.globalTerms).length > 0;

  // Curated tags (existing behaviour, kept as a band)
  const tagCounts = useMemo(() => {
    const c = {};
    events.forEach(e => (e.tags || []).forEach(t => { c[t] = (c[t] || 0) + 1; }));
    return c;
  }, [events]);

  // Eligible event ids for filtering
  const eventIds = useMemo(() => new Set(events.map(e => e.id)), [events]);

  const [mode, setMode] = useState("all");
  const [activeTerm, setActiveTerm] = useState(null);
  const [activeKind, setActiveKind] = useState(null); // "term" | "tag"

  // Build the term list based on mode, scoped to filtered events
  const termList = useMemo(() => {
    if (!corpusLoaded && mode !== "tags") return [];
    const filterToFilteredEvents = (term) => {
      const docs = (corpus.byTerm[term] || []).filter(id => eventIds.has(id));
      if (!docs.length) return null;
      const total = docs.reduce((s, id) => s + (corpus.byEvent[id]?.terms?.[term] || 0), 0);
      return { term, total, docs };
    };
    if (mode === "tags") {
      return Object.entries(tagCounts).sort((a,b) => b[1]-a[1]).slice(0, 60).map(([term, total]) => ({ term, total, docs: [] }));
    }
    let entries = Object.keys(corpus.globalTerms).map(filterToFilteredEvents).filter(Boolean);
    if (mode === "names") entries = entries.filter(e => isLikelyProperNoun(e.term, corpus.byTerm, corpus.byEvent));
    if (mode === "rare")  entries = entries.filter(e => (corpus.byTerm[e.term] || []).length === 1);
    return entries.sort((a,b) => b.total - a.total).slice(0, mode === "all" ? 220 : 140);
  }, [mode, eventIds, tagCounts, corpusLoaded]);

  const maxCount = termList.length ? termList[0].total : 1;
  const matched = useMemo(() => {
    if (!activeTerm) return [];
    if (activeKind === "tag") return events.filter(e => (e.tags || []).includes(activeTerm));
    const ids = new Set((corpus.byTerm?.[activeTerm] || []).filter(id => eventIds.has(id)));
    return events.filter(e => ids.has(e.id));
  }, [activeTerm, activeKind, events, eventIds]);

  // Find context snippets for the active term inside each matched doc
  const snippetsFor = (eventId, term) => {
    const sample = corpus.byEvent?.[eventId]?.sample || "";
    if (!sample) return null;
    const re = new RegExp(`(\\b\\w{0,12}\\s+){0,4}\\b${term.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b(\\s+\\w{0,12}){0,4}`, "i");
    const m = sample.match(re);
    return m ? m[0].trim() : null;
  };

  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]"><GlitchText>┃ CONSTELLATION</GlitchText></h2>
        <div className="font-mono text-[10px] text-emerald-700">
          {corpusLoaded ? (
            <>FULL-TEXT CORPUS · {corpus.stats.eventsProcessed} DOCS · {corpus.stats.uniqueTerms} TERMS · GEN {corpus.generatedAt?.slice(0,10)}</>
          ) : <>CURATED TAGS ONLY · run <span className="text-amber-300">npm run corpus</span> to load full text</>}
        </div>
      </div>

      {/* Mode selector */}
      <div className="flex flex-wrap gap-2 mb-3">
        {MODES.map(m => {
          const disabled = !corpusLoaded && m.id !== "tags";
          const active = mode === m.id;
          return (
            <button key={m.id} onClick={() => { setMode(m.id); setActiveTerm(null); }} disabled={disabled}
              title={m.help}
              className={`px-3 py-1 rounded-sm border font-mono text-[10px] tracking-wider transition-all ${
                disabled ? "border-emerald-900/40 opacity-30 cursor-not-allowed"
                : active ? "border-amber-400/80 text-amber-300 bg-amber-400/10"
                : "border-emerald-700/40 text-emerald-400 hover:border-emerald-500/70"}`}>
              {m.label}
              <span className="ml-1 opacity-50">({m.id === "tags" ? Object.keys(tagCounts).length : (termList.length || 0)})</span>
            </button>
          );
        })}
      </div>

      <div className="border border-emerald-700/40 bg-black/40 rounded-sm p-4 sm:p-6 mb-5 relative overflow-hidden">
        <div className="absolute -top-8 -right-8 opacity-30 pointer-events-none"><RadarSweep size={140} /></div>
        <div className="flex flex-wrap gap-1.5 sm:gap-2 items-center justify-center relative">
          {termList.length === 0 && (
            <div className="font-mono text-[11px] text-emerald-700 py-12">
              {mode === "tags" ? "No curated tags in this filter." : (
                <>Corpus not built yet — from the project root run:
                <div className="text-amber-300 mt-2"><code>npm run corpus</code></div>
                <div className="opacity-60 mt-1 text-[10px]">Downloads source PDFs into data-raw/, extracts text, writes src/data/corpus.json.</div></>
              )}
            </div>
          )}
          {termList.map(({ term, total, docs }) => {
            const ratio = total / maxCount;
            const size = 10 + Math.pow(ratio, 0.5) * 22;
            const isActive = activeTerm === term;
            const kind = mode === "tags" ? "tag" : "term";
            const docCount = mode === "tags" ? total : docs.length;
            return (
              <button key={term} onClick={() => { setActiveTerm(isActive ? null : term); setActiveKind(kind); }}
                className={`px-2 py-0.5 rounded-sm font-mono transition-all ${
                  isActive ? "bg-amber-400 text-black scale-110 shadow-[0_0_20px_rgba(255,217,61,0.6)]"
                    : "bg-emerald-950/60 text-emerald-300 hover:bg-emerald-900/80 hover:scale-105"}`}
                style={{ fontSize: `${size}px`, lineHeight: 1.2 }}
                title={`${total} occurrences across ${docCount} record${docCount===1?"":"s"}`}>
                {term} <span className="opacity-50 text-[0.6em]">×{total}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Matches */}
      {activeTerm && (
        <div className="border border-amber-400/50 bg-amber-400/5 rounded-sm p-4 animate-fadein">
          <div className="font-mono text-[11px] text-amber-400 mb-3 tracking-wider">
            ▌ "{activeTerm.toUpperCase()}" — {matched.length} record{matched.length !== 1 && "s"}
            {activeKind === "term" && <span className="text-emerald-700 ml-2 normal-case">from full-text extraction</span>}
            {activeKind === "tag"  && <span className="text-emerald-700 ml-2 normal-case">from curated tags</span>}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {matched.map(e => {
              const snip = activeKind === "term" ? snippetsFor(e.id, activeTerm) : null;
              return (
                <div key={e.id} className="space-y-1">
                  <MiniChip event={e} onClick={onSelect} />
                  {snip && (
                    <div className="px-2 text-[10px] font-mono text-emerald-600 leading-relaxed italic line-clamp-2">
                      …{snip.replace(new RegExp(activeTerm, "ig"), s => `‹${s}›`)}…
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {!activeTerm && (
        <div className="text-center py-10 font-mono text-emerald-700 text-xs tracking-wider">▽ TAP A TERM TO SEE WHICH RECORDS CONTAIN IT</div>
      )}
    </div>
  );
}
