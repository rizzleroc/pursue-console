import React, { useEffect, useMemo, useState } from "react";
import MiniSearch from "minisearch";
import { EVENTS, AGENCY_COLORS } from "../data/events.js";
import { GlitchText, DocTypeBadge, flagBg } from "../components/Primitives.jsx";
import { useT } from "../i18n/context.js";

const eventById = Object.fromEntries(EVENTS.map(e => [e.id, e]));

// Module-level cache — load + parse the index once per session.
let _miniPromise = null;
function loadIndex() {
  if (!_miniPromise) {
    _miniPromise = fetch(`${import.meta.env.BASE_URL}search-index.json`)
      .then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(t => MiniSearch.loadJSON(t, {
        fields: ["title", "body", "agency"],
        storeFields: ["eventId", "page", "kind", "title", "agency", "date", "flag", "body"],
        searchOptions: { boost: { title: 3, body: 1 }, prefix: true, fuzzy: 0.15 },
        tokenize: (s) => s.toLowerCase().split(/[^a-z0-9']+/).filter(t => t.length >= 2 && t.length <= 30),
      }));
  }
  return _miniPromise;
}

// Highlight every query token in a snippet
function highlight(body, terms) {
  if (!body || !terms.length) return body;
  try {
    const safe = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const re = new RegExp(`(${safe})`, "ig");
    return body.split(re).map((s, i) =>
      re.test(s) ? <mark key={i} className="bg-amber-400/40 text-amber-100 px-0.5 rounded-sm">{s}</mark> : <span key={i}>{s}</span>
    );
  } catch { return body; }
}

// Make a centered ~280-char snippet around the first occurrence of any term
function snippetAround(body, terms, span = 140) {
  if (!body) return "";
  const lower = body.toLowerCase();
  let bestPos = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (bestPos === -1 || i < bestPos)) bestPos = i;
  }
  if (bestPos === -1) return body.slice(0, span * 2).replace(/\s+/g, " ").trim();
  const start = Math.max(0, bestPos - span);
  const end = Math.min(body.length, bestPos + span);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < body.length ? "…" : "";
  return prefix + body.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}

const QUICK_QUERIES = [
  "borman", "uap", "cernan", "centcom", "swir", "fvey", "carol rosin",
  "ellipsoid", "bouncy ball", "orb", "diamond", "bronze", "saucer",
];

export default function SearchView({ onSelect, headerFilters }) {
  const t = useT();
  // Pre-seed from the Header's search box so typing "fbi" up there and
  // clicking SEARCH lands you on the results immediately. Header changes
  // push through; editing the in-page input doesn't push back.
  const [query, setQuery] = useState(headerFilters?.query || "");
  useEffect(() => {
    if ((headerFilters?.query ?? "") !== query) setQuery(headerFilters?.query || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerFilters?.query]);
  const [mini, setMini] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [agencyFilter, setAgencyFilter] = useState(null);
  const [eraFilter, setEraFilter] = useState(null);

  useEffect(() => {
    let dead = false;
    loadIndex()
      .then(m => { if (!dead) { setMini(m); setLoading(false); } })
      .catch(e => { if (!dead) { setError(e.message); setLoading(false); } });
    return () => { dead = true; };
  }, []);

  const tokens = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const results = useMemo(() => {
    if (!mini || !query.trim()) return null;
    const raw = mini.search(query, { combineWith: "AND" });
    let filtered = raw;
    if (agencyFilter) filtered = filtered.filter(r => r.agency === agencyFilter);
    if (eraFilter) {
      filtered = filtered.filter(r => {
        const ev = eventById[r.eventId];
        return ev?.era === eraFilter;
      });
    }
    return filtered.slice(0, 200);
  }, [mini, query, agencyFilter, eraFilter]);

  // Group hits by event for cleaner display
  const grouped = useMemo(() => {
    if (!results) return null;
    const m = new Map();
    for (const r of results) {
      const k = r.eventId;
      if (!m.has(k)) m.set(k, { event: eventById[r.eventId], hits: [] });
      m.get(k).hits.push(r);
    }
    return Array.from(m.values());
  }, [results]);

  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]"><GlitchText>{t("search.title")}</GlitchText></h2>
        <div className="font-mono text-[10px] text-emerald-700">
          {loading ? t("search.loading_index") : error ? t("search.index_unavailable") : t("search.sub")}
        </div>
      </div>

      <div className="mb-3">
        <input value={query} onChange={e => setQuery(e.target.value)} autoFocus
          placeholder={t("search.placeholder")}
          className="w-full bg-black/60 border border-emerald-700/50 rounded-sm px-3 py-2 text-emerald-200 placeholder-emerald-700 font-mono text-sm focus:outline-none focus:border-amber-400 focus:shadow-[0_0_8px_rgba(255,217,61,0.4)]" />
      </div>

      {/* Quick queries */}
      {!query && (
        <div className="mb-4">
          <div className="font-mono text-[9px] text-emerald-700 tracking-widest mb-2">{t("search.try_heading")}</div>
          <div className="flex flex-wrap gap-1.5">
            {QUICK_QUERIES.map(q => (
              <button key={q} onClick={() => setQuery(q)}
                className="px-2 py-0.5 rounded-sm font-mono text-[11px] bg-emerald-950/60 text-emerald-300 hover:bg-emerald-900/80 border border-emerald-700/40">
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      {results && results.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3 text-[10px] font-mono">
          <span className="text-emerald-700 tracking-widest">{t("search.filter")}</span>
          {["Department of War", "FBI", "NASA", "Department of State"].map(a => (
            <button key={a} onClick={() => setAgencyFilter(agencyFilter === a ? null : a)}
              className={`px-2 py-0.5 rounded-sm border tracking-wider ${agencyFilter === a ? "border-current" : "border-emerald-900/50 opacity-60"}`}
              style={{ color: AGENCY_COLORS[a] }}>
              {a.replace("Department of ","").toUpperCase()}
            </button>
          ))}
          <span className="text-emerald-700 ml-2">·</span>
          {["40s","50s","60s","70s","80s","90s","00s","10s","20s"].map(e => (
            <button key={e} onClick={() => setEraFilter(eraFilter === e ? null : e)}
              className={`px-2 py-0.5 rounded-sm border tracking-wider ${eraFilter === e ? "border-amber-400 text-amber-300" : "border-emerald-900/50 text-emerald-500 opacity-60"}`}>
              {e}
            </button>
          ))}
          {(agencyFilter || eraFilter) && (
            <button onClick={() => { setAgencyFilter(null); setEraFilter(null); }} className="text-rose-400 ml-2">{t("search.clear")}</button>
          )}
        </div>
      )}

      {error && (
        <div className="border border-rose-400/40 bg-rose-400/5 rounded-sm p-3 font-mono text-[12px] text-rose-300">
          ⊘ {t("search.index_error", { error })}
        </div>
      )}

      {grouped && grouped.length === 0 && !loading && (
        <div className="font-mono text-[12px] text-emerald-700 py-8 text-center">{t("search.no_matches", { query })}</div>
      )}

      {grouped && grouped.length > 0 && (
        <div>
          <div className="font-mono text-[10px] text-emerald-700 tracking-widest mb-3">
            {t("search.summary", {
              records: grouped.length === 1 ? t("search.records_one") : t("search.records_n", { n: grouped.length }),
              hits: results.length === 1 ? t("search.hits_one") : t("search.hits_n", { n: results.length }),
            })}
          </div>
          <div className="space-y-3">
            {grouped.map(({ event, hits }) => {
              if (!event) return null;
              const color = AGENCY_COLORS[event.agency] || "#7CFFB2";
              const pageHits = hits.filter(h => h.kind === "page");
              return (
                <div key={event.id}
                  className={`rounded-sm border-l-2 ${flagBg(event.flag)} border p-3`}
                  style={{ borderLeftColor: color }}>
                  <button onClick={() => onSelect(event)} className="text-left w-full">
                    <div className="flex items-baseline justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] tracking-wider" style={{ color }}>
                          {event.agency.replace("Department of ","DEPT/")}
                        </span>
                        <DocTypeBadge docType={event.docType} />
                        {event.flag === "anchor" && <span className="text-amber-400 text-[10px]">▲</span>}
                      </div>
                      <span className="font-mono text-[10px] text-amber-300">{event.date}</span>
                    </div>
                    <div className="font-mono text-emerald-100 text-[14px] mt-1 leading-snug">
                      {highlight(event.title, tokens)}
                    </div>
                  </button>
                  {pageHits.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      {pageHits.slice(0, 4).map((h, i) => (
                        <div key={i} className="border-l border-emerald-700/30 pl-2.5 font-mono text-[11px] text-emerald-300/90 leading-relaxed">
                          <span className="text-amber-400/80 text-[9px] tracking-widest mr-2">{t("search.page_label", { n: h.page || "?" })}</span>
                          {highlight(snippetAround(h.body || "", tokens), tokens)}
                        </div>
                      ))}
                      {pageHits.length > 4 && (
                        <div className="font-mono text-[10px] text-emerald-700 pl-2.5">
                          {pageHits.length - 4 === 1 ? t("search.more_page") : t("search.more_pages", { n: pageHits.length - 4 })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
