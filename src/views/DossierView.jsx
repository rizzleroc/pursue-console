import React from "react";
import { AGENCY_COLORS, FLAG_LABEL } from "../data/events.js";
import { ENTITY_KIND, EVENT_ENTITIES, ENTITIES } from "../data/entities.js";
import { THREADS } from "../data/threads.js";
import { GlitchText, MiniChip } from "../components/Primitives.jsx";

export default function DossierView({ event, onClose, onSelect, onJumpThread, allEvents }) {
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

      <div className="border border-emerald-700/30 bg-black/40 rounded-sm p-4 sm:p-6 mb-5">
        <div className="font-mono text-[9px] text-emerald-700 tracking-widest mb-3">▌ SUMMARY</div>
        <p className="text-emerald-100 leading-relaxed text-sm sm:text-base font-mono">{event.summary}</p>
        {event.note && (
          <div className="mt-3 pt-3 border-t border-emerald-700/30 font-mono text-[11px] text-amber-300">◇ {event.note}</div>
        )}
      </div>

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
