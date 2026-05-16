import React, { useEffect, useMemo, useState } from "react";
import { AGENCY_COLORS, FLAG_LABEL } from "../data/events.js";
import { ENTITY_KIND, EVENT_ENTITIES, ENTITIES } from "../data/entities.js";
import { THREADS } from "../data/threads.js";
import { GlitchText, MiniChip, DocTypeBadge, DOC_TYPE_BADGE } from "../components/Primitives.jsx";
import ReadingMode from "../components/ReadingMode.jsx";

// Lazy-load the per-doc extracts JSON once. The DossierView renders excerpts
// + document profile sections when the entry for this event id exists.
let _extractsP = null;
function useExtracts(eid) {
  const [state, setState] = useState({ loading: true, data: null });
  useEffect(() => {
    if (!_extractsP) {
      _extractsP = fetch(`${import.meta.env.BASE_URL}dossier-extracts.json`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .catch(() => ({}));
    }
    let cancelled = false;
    setState({ loading: true, data: null });
    _extractsP.then(all => { if (!cancelled) setState({ loading: false, data: all?.[eid] || null }); });
    return () => { cancelled = true; };
  }, [eid]);
  return state;
}

// Source-color mapping for the per-page excerpt badges
const SOURCE_COLOR = { vision: "#82B6FF", pdfjs: "#7CFFB2", ocr: "#FFD93D" };
const FLAG_COLOR = {
  date: "#FFD93D", clock: "#FFD93D", entity: "#82B6FF",
  shape: "#7CFFB2", behavior: "#FF6B9D", sensor: "#B794F4", number: "#A0E8AF",
};
const FLAG_LABELS = { date: "DATE", clock: "TIME", entity: "ENTITY", shape: "SHAPE", behavior: "BEHAVIOR", sensor: "SENSOR", number: "NUMBER" };

export default function DossierView({ event, onClose, onSelect, onJumpThread, allEvents }) {
  const [reading, setReading] = useState(false);
  const [expandedPages, setExpandedPages] = useState(new Set());
  const { data: extracts, loading: extractsLoading } = useExtracts(event?.id || "");
  if (!event) {
    return (
      <div className="px-3 sm:px-8 py-12 text-center">
        <div className="font-mono text-emerald-700 text-sm tracking-widest">▽ NO RECORD SELECTED</div>
        <div className="font-mono text-emerald-800 text-xs mt-2">Tap any event in TIMELINE, GLOBE, ATLAS, NETWORK, PATTERNS, THREADS, or CONSTELLATION</div>
      </div>
    );
  }

  // Entities directly attached to this event
  const ents = EVENT_ENTITIES[event.id] || [];
  // Co-occurring events (sharing entities), scored by overlap
  const entIds = new Set(ents.map(e => e.id));
  const coOccur = allEvents
    .filter(e => e.id !== event.id)
    .map(e => ({ e, score: (EVENT_ENTITIES[e.id] || []).filter(x => entIds.has(x.id)).length }))
    .filter(x => x.score > 0)
    .sort((a,b) => b.score - a.score)
    .slice(0, 8);

  // Tag-overlap fallback (in case there's no entity overlap)
  const tagRelated = allEvents
    .filter(e => e.id !== event.id && !coOccur.some(x => x.e.id === e.id))
    .map(e => ({ e, score: (e.tags || []).filter(t => (event.tags || []).includes(t)).length }))
    .filter(x => x.score > 0)
    .sort((a,b) => b.score - a.score)
    .slice(0, 4);

  // Threads that contain this event
  const threadsHere = THREADS.filter(t => t.events.includes(event.id));

  const color = AGENCY_COLORS[event.agency] || "#7CFFB2";

  return (
    <div className="px-3 sm:px-8 py-6 max-w-5xl mx-auto">
      <button onClick={onClose} className="font-mono text-[11px] text-emerald-500 hover:text-amber-400 mb-4 tracking-wider">◀ BACK TO INDEX</button>

      <div className="border-l-2 pl-4 sm:pl-6 mb-6" style={{ borderColor: color }}>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-mono text-[10px] tracking-[0.2em]" style={{ color }}>▌ {event.agency.toUpperCase()}</span>
          <span className="font-mono text-[10px] text-emerald-700 tracking-wider">{event.type}</span>
          <span className={`font-mono text-[10px] tracking-wider ${event.flag === "anchor" ? "text-amber-400 animate-pulse" : "text-emerald-600"}`}>
            {event.flag === "anchor" ? "▲ " : ""}{FLAG_LABEL[event.flag]}
          </span>
          {event.redacted && <span className="font-mono text-[10px] text-rose-400">⊘ REDACTED</span>}
        </div>
        <h1 className="font-mono text-emerald-100 text-xl sm:text-3xl mt-2 leading-tight"><GlitchText>{event.title}</GlitchText></h1>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4 font-mono text-[11px]">
          <div><div className="text-emerald-700 text-[9px] tracking-widest mb-0.5">DATE</div><div className="text-amber-300">{event.date}</div></div>
          <div><div className="text-emerald-700 text-[9px] tracking-widest mb-0.5">LOCATION</div><div className="text-emerald-300">{event.loc}</div></div>
          <div><div className="text-emerald-700 text-[9px] tracking-widest mb-0.5">REGION</div><div className="text-emerald-300">{event.region}</div></div>
        </div>
      </div>

      {/* Reading-mode CTA — opens the actual PDF in an embedded viewer */}
      {event.url && (
        <button onClick={() => setReading(true)}
          className="w-full block border border-emerald-400/50 bg-emerald-400/5 hover:bg-emerald-400/10 rounded-sm p-3 mb-5 font-mono text-xs text-emerald-200 transition-colors text-left">
          <div className="text-[9px] text-emerald-400/80 tracking-widest mb-1 flex items-center gap-2">
            ▌ OPEN THE DOCUMENT
            <DocTypeBadge docType={event.docType} size="lg" />
          </div>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <span className="text-emerald-100">
              {event.docType === "photoset" ? "→ View the image set in Reading Mode"
                : event.docType === "handwritten" ? "→ View the handwritten document in Reading Mode"
                : event.docType === "sketch" ? "→ View the sketch / composite in Reading Mode"
                : event.docType === "annotated" ? "→ View the annotated image in Reading Mode"
                : "→ Open the PDF in Reading Mode"}
            </span>
            <span className="text-[10px] text-emerald-600">embeds war.gov source</span>
          </div>
        </button>
      )}

      <div className="border border-emerald-700/30 bg-black/40 rounded-sm p-4 sm:p-6 mb-5">
        <div className="font-mono text-[9px] text-emerald-700 tracking-widest mb-3">▌ SUMMARY</div>
        <p className="text-emerald-100 leading-relaxed text-sm sm:text-base font-mono">{event.summary}</p>
        {event.note && (
          <div className="mt-3 pt-3 border-t border-emerald-700/30 font-mono text-[11px] text-amber-300">◇ {event.note}</div>
        )}
      </div>

      {/* DOCUMENT PROFILE — auto-derived from the full text */}
      {extracts?.profile && (() => {
        const p = extracts.profile;
        const srcColor = SOURCE_COLOR[p.source] || "#7CFFB2";
        const sigEntries = Object.entries(p.signatures || {}).filter(([, v]) => Object.keys(v).length > 0);
        return (
          <div className="border border-emerald-700/30 bg-black/30 rounded-sm p-4 sm:p-6 mb-5">
            <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
              <div className="font-mono text-[9px] text-emerald-700 tracking-widest">▌ DOCUMENT PROFILE</div>
              <div className="font-mono text-[9px] tracking-widest" style={{ color: srcColor }}>
                {p.source?.toUpperCase()} · {p.pages}p · {p.chars?.toLocaleString()} chars
              </div>
            </div>

            {/* Signatures (shape / behavior / sensor) */}
            {sigEntries.length > 0 && (
              <div className="mb-4">
                <div className="font-mono text-[9px] text-emerald-700 tracking-widest mb-2">▌ SIGHTING SIGNATURES (from extracted text)</div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {sigEntries.map(([cat, vals]) => (
                    <div key={cat}>
                      <div className="font-mono text-[9px] text-emerald-600 tracking-widest mb-1">{cat.toUpperCase()}</div>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(vals).sort((a,b) => b[1]-a[1]).map(([term, n]) => (
                          <span key={term} className="font-mono text-[10px] px-1.5 py-0.5 rounded-sm bg-emerald-950/60 border border-emerald-700/30 text-emerald-200">
                            {term} <span className="text-emerald-700">×{n}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Entities mined from text */}
            {p.entities?.length > 0 && (
              <div className="mb-4">
                <div className="font-mono text-[9px] text-emerald-700 tracking-widest mb-2">▌ ENTITIES MENTIONED (proper nouns, agencies)</div>
                <div className="flex flex-wrap gap-1">
                  {p.entities.slice(0, 18).map(en => (
                    <span key={en.name} className="font-mono text-[10px] px-1.5 py-0.5 rounded-sm bg-blue-950/40 border border-blue-700/40 text-blue-200"
                      title={`${en.count} mentions`}>
                      {en.name} <span className="text-blue-500">×{en.count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Dates referenced */}
            {p.dates?.length > 0 && (
              <div className="mb-4">
                <div className="font-mono text-[9px] text-emerald-700 tracking-widest mb-2">▌ DATES REFERENCED</div>
                <div className="flex flex-wrap gap-1">
                  {p.dates.slice(0, 14).map((d, i) => (
                    <span key={i} className="font-mono text-[10px] px-1.5 py-0.5 rounded-sm bg-amber-950/40 border border-amber-700/40 text-amber-200">
                      {d}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Distinctive terms */}
            {p.distinctive?.length > 0 && (
              <div>
                <div className="font-mono text-[9px] text-emerald-700 tracking-widest mb-2">▌ TOP TERMS (by frequency)</div>
                <div className="flex flex-wrap gap-1">
                  {p.distinctive.slice(0, 14).map(t => (
                    <span key={t.term} className="font-mono text-[10px] text-emerald-400"
                      style={{ fontSize: `${10 + Math.min(6, t.count / 8)}px` }}
                      title={`${t.count} occurrences`}>
                      {t.term}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* VISUAL CONTENT — photos / diagrams / sketches / annotations
          identified on each page by the vision pass. Surfaces non-text
          content that the search index would otherwise underweight. */}
      {extracts?.visuals && Object.keys(extracts.visuals).length > 0 && (() => {
        const pages = Object.keys(extracts.visuals).map(Number).sort((a, b) => a - b);
        const kindColors = { photo: "#82B6FF", diagram: "#7CFFB2", sketch: "#FFD93D", map: "#B794F4", chart: "#FF9F45", annotation: "#FF6B9D" };
        return (
          <div className="border border-cyan-700/30 bg-cyan-950/10 rounded-sm p-4 sm:p-6 mb-5">
            <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
              <div className="font-mono text-[9px] text-cyan-400 tracking-widest">
                ▌ VISUAL CONTENT  <span className="text-emerald-600 ml-1">
                  ({extracts.profile?.visualCount || 0} elements across {pages.length} page{pages.length===1?"":"s"})
                </span>
              </div>
              {extracts.profile?.visualKinds && (
                <div className="flex flex-wrap gap-1">
                  {Object.entries(extracts.profile.visualKinds).sort((a,b)=>b[1]-a[1]).map(([k, n]) => (
                    <span key={k} className="font-mono text-[9px] tracking-widest px-1.5 py-0.5 rounded-sm"
                      style={{ color: kindColors[k] || "#7CFFB2", backgroundColor: (kindColors[k] || "#7CFFB2") + "15", border: `1px solid ${(kindColors[k] || "#7CFFB2")}40` }}>
                      {k.toUpperCase()} ×{n}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-2">
              {pages.map(pn => (
                <div key={pn} className="border-l border-cyan-700/40 pl-3">
                  <div className="font-mono text-[9px] tracking-widest text-cyan-700 mb-1">PAGE {pn}</div>
                  <ul className="space-y-1">
                    {extracts.visuals[pn].map((v, i) => {
                      const k = (v.kind || "image").toLowerCase();
                      return (
                        <li key={i} className="font-mono text-[11px] text-cyan-100/90 leading-relaxed">
                          <span className="text-[9px] tracking-widest mr-2 px-1 py-0.5 rounded-sm"
                            style={{ color: kindColors[k] || "#7CFFB2", backgroundColor: (kindColors[k] || "#7CFFB2") + "20" }}>
                            {k.toUpperCase()}
                          </span>
                          {v.description}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* EXCERPTS BY PAGE — the most information-dense sentences from each page */}
      {extracts?.excerptsByPage && Object.keys(extracts.excerptsByPage).length > 0 && (() => {
        const pageNums = Object.keys(extracts.excerptsByPage).map(Number).sort((a, b) => a - b);
        const allExpanded = expandedPages.size === pageNums.length;
        return (
          <div className="border border-emerald-700/30 bg-black/30 rounded-sm p-4 sm:p-6 mb-5">
            <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
              <div className="font-mono text-[9px] text-emerald-700 tracking-widest">▌ EXCERPTS BY PAGE  <span className="text-emerald-500 ml-1">({pageNums.length} pages with extractable content)</span></div>
              <button onClick={() => setExpandedPages(allExpanded ? new Set() : new Set(pageNums))}
                className="font-mono text-[10px] text-emerald-500 hover:text-amber-300 tracking-widest">
                {allExpanded ? "▽ COLLAPSE ALL" : "▷ EXPAND ALL"}
              </button>
            </div>
            <div className="space-y-1.5">
              {pageNums.map(pn => {
                const entry = extracts.excerptsByPage[pn];
                const open = expandedPages.has(pn);
                const sourceColor = SOURCE_COLOR[entry.source] || "#7CFFB2";
                const preview = entry.top[0]?.text?.slice(0, 100);
                return (
                  <div key={pn} className="border-l border-emerald-700/40 bg-black/20">
                    <button onClick={() => {
                      const next = new Set(expandedPages);
                      next.has(pn) ? next.delete(pn) : next.add(pn);
                      setExpandedPages(next);
                    }}
                      className="w-full px-3 py-1.5 text-left flex items-baseline gap-3 hover:bg-emerald-900/20">
                      <span className="font-mono text-[9px] tracking-widest text-emerald-700 w-12 shrink-0">
                        PAGE {String(pn).padStart(3)}
                      </span>
                      {entry.source && (
                        <span className="font-mono text-[8px] tracking-widest" style={{ color: sourceColor }}>
                          {entry.source.toUpperCase()}
                        </span>
                      )}
                      <span className="font-mono text-[10px] text-emerald-400/80 truncate flex-1 italic">
                        {open ? "" : `"${preview}…"`}
                      </span>
                      <span className="font-mono text-[10px] text-emerald-700 shrink-0">
                        {open ? "▽" : "▷"} {entry.top.length}
                      </span>
                    </button>
                    {open && (
                      <div className="px-3 py-2 space-y-2 bg-emerald-950/20">
                        {entry.top.map((ex, i) => (
                          <div key={i} className="font-mono text-[12px] text-emerald-100 leading-relaxed">
                            <div className="flex flex-wrap gap-1 mb-1">
                              {Object.keys(ex.flags || {}).filter(k => FLAG_LABELS[k] && ex.flags[k] === true).slice(0, 4).map(k => (
                                <span key={k} className="text-[8px] tracking-widest px-1 rounded-sm"
                                  style={{ color: FLAG_COLOR[k] || "#7CFFB2", backgroundColor: (FLAG_COLOR[k] || "#7CFFB2") + "15" }}>
                                  {FLAG_LABELS[k]}
                                </span>
                              ))}
                              <span className="text-[8px] text-emerald-700 ml-auto">score {ex.score}</span>
                            </div>
                            <div className="pl-2 border-l-2 border-amber-400/30 italic">"{ex.text}"</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {extractsLoading && (
        <div className="font-mono text-[10px] text-emerald-700 mb-5 text-center">◌ loading per-page excerpts…</div>
      )}

      {reading && <ReadingMode event={event} onClose={() => setReading(false)} />}

      {/* CONNECTIVE TISSUE — entities */}
      {ents.length > 0 && (
        <div className="mb-5 border border-emerald-700/30 bg-black/40 rounded-sm p-4">
          <div className="font-mono text-[9px] text-emerald-700 tracking-widest mb-3">▌ CONNECTS THROUGH</div>
          <div className="flex flex-wrap gap-1.5">
            {ents.map(en => (
              <span key={en.id} className="px-2 py-0.5 rounded-sm font-mono text-[11px] border"
                style={{ color: ENTITY_KIND[en.kind].color, borderColor: ENTITY_KIND[en.kind].color + "80" }}
                title={ENTITY_KIND[en.kind].label}>
                {ENTITY_KIND[en.kind].glyph} {en.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* THREADS containing this event */}
      {threadsHere.length > 0 && (
        <div className="mb-5 border border-amber-400/30 bg-amber-400/5 rounded-sm p-4">
          <div className="font-mono text-[9px] text-amber-400 tracking-widest mb-3">▌ APPEARS IN THREAD{threadsHere.length > 1 ? "S" : ""}</div>
          <div className="space-y-2">
            {threadsHere.map(t => (
              <button key={t.id} onClick={() => onJumpThread?.(t.id)} className="block w-full text-left p-2 rounded-sm hover:bg-amber-400/10 transition-colors">
                <div className="font-mono text-[11px] text-amber-200">→ {t.title}</div>
                <div className="font-mono text-[10px] text-emerald-600 mt-0.5 line-clamp-2">{t.thesis.slice(0, 160)}…</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {event.tags && event.tags.length > 0 && (
        <div className="mb-5">
          <div className="font-mono text-[9px] text-emerald-700 tracking-widest mb-2">▌ TAGS</div>
          <div className="flex flex-wrap gap-1.5">
            {event.tags.map(t => <span key={t} className="px-2 py-0.5 bg-emerald-950/60 border border-emerald-700/30 text-emerald-300 font-mono text-[10px] rounded-sm">{t}</span>)}
          </div>
        </div>
      )}

      {event.url && (
        <a href={event.url} target="_blank" rel="noopener noreferrer"
          className="block border border-amber-400/50 bg-amber-400/5 hover:bg-amber-400/10 rounded-sm p-3 mb-5 font-mono text-xs text-amber-300 transition-colors">
          <div className="text-[9px] text-amber-400/70 tracking-widest mb-1">▌ ACCESS PRIMARY SOURCE</div>
          <div className="break-all">{event.url}</div>
          <div className="mt-1 text-amber-400 text-[10px]">→ OPEN ON WAR.GOV ↗</div>
        </a>
      )}

      {event.videoId && (
        <div className="border border-blue-400/40 bg-blue-400/5 rounded-sm p-3 mb-5 font-mono text-xs text-blue-300">
          <div className="text-[9px] text-blue-400/70 tracking-widest mb-1">▌ VIDEO</div>
          <div>DVIDS Video ID: <span className="text-blue-200">{event.videoId}</span></div>
          <a href={`https://www.dvidshub.net/video/${event.videoId}`} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-blue-400 text-[10px]">→ OPEN ON DVIDS ↗</a>
        </div>
      )}

      {coOccur.length > 0 && (
        <div className="mb-5">
          <div className="font-mono text-[9px] text-emerald-700 tracking-widest mb-2">▌ CO-OCCURRING RECORDS (shared entities)</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {coOccur.map(({e, score}) => (
              <div key={e.id} className="relative">
                <MiniChip event={e} onClick={onSelect} />
                <span className="absolute top-1 right-1 font-mono text-[9px] text-amber-400">×{score}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {tagRelated.length > 0 && (
        <div>
          <div className="font-mono text-[9px] text-emerald-700 tracking-widest mb-2">▌ TAG-RELATED</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{tagRelated.map(({e}) => <MiniChip key={e.id} event={e} onClick={onSelect} />)}</div>
        </div>
      )}
    </div>
  );
}
