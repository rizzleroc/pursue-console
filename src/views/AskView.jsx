import React, { useEffect, useMemo, useState } from "react";
import { ask, ASK_EXAMPLES } from "../lib/askEngine.js";
import { AGENCY_COLORS } from "../data/events.js";
import { GlitchText, DocTypeBadge, flagBg } from "../components/Primitives.jsx";

// =====================================================================
// ASK — natural-language interface over the catalogue.
//
// The engine in lib/askEngine.js does the parsing; this view is just the
// terminal-styled shell. Mirrors the look-and-feel of SearchView /
// SemanticSearchView so it slots in alongside them in the nav.
// =====================================================================
export default function AskView({ onSelect, headerFilters }) {
  const [query, setQuery] = useState(headerFilters?.query || "");
  // Honor a question pushed in from the header search box — typing
  // "what's new" up there and switching to ASK should land on the answer.
  useEffect(() => {
    if ((headerFilters?.query ?? "") !== query) setQuery(headerFilters?.query || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerFilters?.query]);

  // The engine is pure + synchronous; recompute on every keystroke is fine.
  const answer = useMemo(() => ask(query), [query]);

  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]">
          <GlitchText>┃ ASK</GlitchText>
        </h2>
        <div className="font-mono text-[10px] text-emerald-700 tracking-widest">
          NATURAL-LANGUAGE QUERY · DATASET-LEVEL · LOCAL
        </div>
      </div>

      <div className="mb-3">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
          placeholder="› ask the dataset — e.g. what's different about the NASA documents"
          className="w-full bg-black/60 border border-emerald-700/50 rounded-sm px-3 py-2 text-emerald-200 placeholder-emerald-700 font-mono text-sm focus:outline-none focus:border-amber-400 focus:shadow-[0_0_8px_rgba(255,217,61,0.4)]"
        />
      </div>

      {!query && (
        <div className="mb-4">
          <div className="font-mono text-[9px] text-emerald-700 tracking-widest mb-2">▌ TRY</div>
          <div className="flex flex-wrap gap-1.5">
            {ASK_EXAMPLES.map(q => (
              <button
                key={q} onClick={() => setQuery(q)}
                className="px-2 py-0.5 rounded-sm font-mono text-[11px] bg-emerald-950/60 text-emerald-300 hover:bg-emerald-900/80 border border-emerald-700/40">
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Headline + parsed-intent badge */}
      <div className="border border-emerald-700/40 bg-black/40 rounded-sm p-3 sm:p-4 mb-4">
        <div className="flex items-baseline gap-2 flex-wrap mb-2">
          <span className="font-mono text-[9px] tracking-widest text-amber-400">▌ ANSWER</span>
          {answer.intent && answer.intent !== "empty" && (
            <span className="font-mono text-[9px] tracking-widest text-emerald-700">
              · INTENT: {answer.intent.toUpperCase()}
            </span>
          )}
          {answer.query?.agency && (
            <span className="font-mono text-[9px] tracking-widest" style={{ color: AGENCY_COLORS[answer.query.agency] || "#7CFFB2" }}>
              · {answer.query.agency.replace("Department of ", "DEPT/")}
            </span>
          )}
          {answer.query?.release && (
            <span className="font-mono text-[9px] tracking-widest text-emerald-500">· {answer.query.release.toUpperCase()}</span>
          )}
          {answer.query?.era && (
            <span className="font-mono text-[9px] tracking-widest text-emerald-500">· {answer.query.era}</span>
          )}
        </div>
        <div className="font-mono text-emerald-100 text-[14px] leading-snug">
          {answer.headline}
        </div>
        {answer.notes && answer.notes.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {answer.notes.map((n, i) => (
              <li key={i} className="font-mono text-[12px] text-emerald-300/90 leading-relaxed pl-3 border-l border-emerald-700/30">
                {n}
              </li>
            ))}
          </ul>
        )}
        {answer.stats && answer.stats.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-3">
            {answer.stats.map((s, i) => (
              <div key={i} className="border border-emerald-700/40 bg-emerald-950/30 rounded-sm px-2.5 py-1.5">
                <div className="font-mono text-[9px] tracking-widest text-emerald-600">{s.label}</div>
                <div className="font-mono text-emerald-200 text-base">{s.value}</div>
              </div>
            ))}
          </div>
        )}
        {answer.hint && (
          <div className="mt-3 font-mono text-[10px] text-emerald-700 tracking-wider">
            ▌ {answer.hint}
          </div>
        )}
      </div>

      {/* Groups (e.g. "by agency") or flat event list */}
      {answer.groups && answer.groups.length > 0 && (
        <div className="space-y-4">
          {answer.groups.map((g, i) => (
            <Group key={i} group={g} onSelect={onSelect} />
          ))}
        </div>
      )}
      {answer.events && answer.events.length > 0 && (
        <div className="space-y-2">
          {answer.events.map(e => <EventRow key={e.id} event={e} onSelect={onSelect} />)}
        </div>
      )}
    </div>
  );
}

function Group({ group, onSelect }) {
  const color = AGENCY_COLORS[group.agency] || "#7CFFB2";
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="h-px flex-1 bg-emerald-900/50" />
        <span className="font-mono text-[10px] tracking-widest" style={{ color }}>
          {group.label.replace("Department of ", "DEPT/")}
        </span>
        <span className="h-px flex-1 bg-emerald-900/50" />
      </div>
      <div className="space-y-2">
        {group.events.map(e => <EventRow key={e.id} event={e} onSelect={onSelect} />)}
      </div>
    </div>
  );
}

function EventRow({ event, onSelect }) {
  const color = AGENCY_COLORS[event.agency] || "#7CFFB2";
  return (
    <button
      onClick={() => onSelect(event)}
      className={`text-left w-full rounded-sm border-l-2 ${flagBg(event.flag)} border p-2.5 hover:bg-emerald-950/40`}
      style={{ borderLeftColor: color }}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[10px] tracking-wider shrink-0" style={{ color }}>
            {event.agency.replace("Department of ", "DEPT/")}
          </span>
          <DocTypeBadge docType={event.docType} />
          {event.flag === "anchor" && <span className="text-amber-400 text-[10px] shrink-0">▲</span>}
          {event.redacted && <span className="font-mono text-[9px] tracking-widest text-rose-400 shrink-0">REDACTED</span>}
          {event.videoId && <span className="font-mono text-[9px] tracking-widest text-blue-300 shrink-0">VIDEO</span>}
          {event.release === "Release 02" && <span className="font-mono text-[9px] tracking-widest text-amber-300 shrink-0">R02</span>}
        </div>
        <span className="font-mono text-[10px] text-amber-300 shrink-0">{event.date || "—"}</span>
      </div>
      <div className="font-mono text-emerald-100 text-[13px] mt-1 leading-snug">{event.title}</div>
      {event.summary && (
        <div className="font-mono text-[11px] text-emerald-400/80 mt-1 leading-snug line-clamp-2">
          {event.summary}
        </div>
      )}
    </button>
  );
}
