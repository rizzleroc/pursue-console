import React, { useEffect, useMemo, useState } from "react";

// REVIEW — cross-source disagreement queue.
//
// Reads public/review-queue.json (produced by scripts/export-review-queue.mjs)
// for the list of pages where 2+ transcription sources diverged enough
// to warrant human eyes. Picks a page → loads public/review-text/<eid>/
// <page>.json → renders every source's text in a side-by-side grid with
// the comparison metadata and a CTA to fix it via the volunteer flow.
//
// No backend writes. "Mark canonical" is encoded as a copy-able
// snippet a reviewer pastes into a contribution PR.

const SOURCE_COLORS = {
  gemini:        { dot: "bg-cyan-400",   ring: "border-cyan-700/60",   text: "text-cyan-300",   label: "GEMINI"  },
  "gpt-vision":  { dot: "bg-emerald-400",ring: "border-emerald-700/60",text: "text-emerald-300",label: "GPT-VISION" },
  human:         { dot: "bg-amber-400",  ring: "border-amber-700/60",  text: "text-amber-300",  label: "HUMAN"   },
  ocr:           { dot: "bg-rose-400",   ring: "border-rose-700/60",   text: "text-rose-300",   label: "OCR"     },
};

function sourceMeta(name) {
  return SOURCE_COLORS[name] || { dot: "bg-zinc-400", ring: "border-zinc-700/60", text: "text-zinc-300", label: name.toUpperCase() };
}

function ConfidenceBadge({ confidence, agreement }) {
  const c = confidence === "low" ? "rose" : confidence === "medium" ? "amber" : "emerald";
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border border-${c}-700/60 text-${c}-300 text-[9px] tracking-widest font-mono`}>
      <span className={`w-1 h-1 rounded-full bg-${c}-400`} />
      {String(confidence || "?").toUpperCase()} · {(agreement ?? 0).toFixed(2)}
    </span>
  );
}

export default function ReviewView() {
  const [queue, setQueue] = useState(null);
  const [error, setError] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [pageData, setPageData] = useState(null);
  const [loadingPage, setLoadingPage] = useState(false);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}review-queue.json?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setQueue)
      .catch(e => setError(e.message));
  }, []);

  const selected = queue?.queue?.[selectedIdx] || null;
  useEffect(() => {
    if (!selected) { setPageData(null); return; }
    setLoadingPage(true);
    fetch(`${import.meta.env.BASE_URL}${selected.textUrl}?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => { setPageData(d); setLoadingPage(false); })
      .catch(e => { setError(e.message); setLoadingPage(false); });
  }, [selectedIdx, queue]);

  const byAgency = useMemo(() => {
    if (!queue?.queue) return {};
    const acc = {};
    for (const r of queue.queue) {
      const k = r.agency || "—";
      acc[k] = (acc[k] || 0) + 1;
    }
    return acc;
  }, [queue]);

  if (error) {
    return <div className="p-4 text-rose-400 font-mono text-xs">REVIEW unavailable: {error}</div>;
  }
  if (!queue) {
    return <div className="p-4 text-emerald-700 font-mono text-xs">LOADING REVIEW QUEUE…</div>;
  }
  if (!queue.queue.length) {
    return (
      <div className="p-8 max-w-3xl mx-auto text-center">
        <div className="text-emerald-300 font-mono text-xs tracking-widest mb-3">REVIEW QUEUE EMPTY</div>
        <div className="text-emerald-700 text-[11px] font-mono leading-relaxed">
          Every page with two or more transcription sources currently agrees within tolerance.<br/>
          New disagreements will appear here as Gemini ↔ GPT-vision ↔ human inputs continue to land.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-3 p-3 min-h-[calc(100vh-200px)]">
      {/* Left rail — queue list */}
      <aside className="lg:w-72 shrink-0 border border-emerald-900/50 bg-black/40 rounded-sm">
        <div className="px-3 py-2 border-b border-emerald-900/50 flex items-center justify-between">
          <div className="font-mono text-[10px] tracking-widest text-emerald-400">
            REVIEW QUEUE · {queue.total}
          </div>
          <div className="font-mono text-[9px] text-emerald-700">
            worst first
          </div>
        </div>
        <ul className="max-h-[60vh] lg:max-h-[calc(100vh-280px)] overflow-y-auto">
          {queue.queue.map((r, i) => (
            <li key={`${r.eventId}-${r.page}`}>
              <button
                onClick={() => setSelectedIdx(i)}
                className={`w-full text-left px-3 py-2 border-b border-emerald-900/30 transition-colors ${
                  i === selectedIdx
                    ? "bg-emerald-900/30 text-emerald-200"
                    : "text-emerald-600 hover:bg-emerald-900/10 hover:text-emerald-300"
                }`}>
                <div className="font-mono text-[11px] flex items-center justify-between gap-2">
                  <span className="truncate">{r.title}</span>
                  <ConfidenceBadge confidence={r.confidence} agreement={r.agreement} />
                </div>
                <div className="font-mono text-[9px] text-emerald-700/80 mt-0.5">
                  p{String(r.page).padStart(4, "0")} · {Object.keys(r.sources).join(" / ")}
                  {r.agency ? <span className="ml-1 text-emerald-700">· {r.agency}</span> : null}
                </div>
              </button>
            </li>
          ))}
        </ul>
        <div className="px-3 py-2 border-t border-emerald-900/50 font-mono text-[9px] text-emerald-700">
          by agency: {Object.entries(byAgency).slice(0, 4).map(([a, n]) => `${a}=${n}`).join("  ")}
        </div>
      </aside>

      {/* Right pane — sources side by side */}
      <main className="flex-1 min-w-0">
        {!selected ? (
          <div className="text-emerald-700 font-mono text-xs p-4">Select a page from the queue.</div>
        ) : (
          <>
            <div className="border border-emerald-900/50 bg-black/40 rounded-sm px-3 py-2 mb-3">
              <div className="flex items-baseline justify-between flex-wrap gap-2">
                <div>
                  <div className="font-mono text-[10px] text-emerald-700 tracking-widest">FLAGGED FOR REVIEW</div>
                  <div className="text-emerald-300 font-mono text-sm mt-0.5">{selected.title}</div>
                  <div className="text-emerald-700 font-mono text-[10px] mt-0.5">
                    {selected.agency || "—"} · page {selected.page} ·
                    {" "}canonical: <span className="text-amber-300">{pageData?.best || selected.confidence}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <ConfidenceBadge confidence={selected.confidence} agreement={selected.agreement} />
                  <a
                    href={`https://github.com/rizzleroc/pursue-console/blob/main/HOW-CAN-I-HELP.md`}
                    target="_blank" rel="noreferrer"
                    className="font-mono text-[10px] tracking-widest border border-amber-700/60 text-amber-300 hover:bg-amber-900/30 px-2 py-1 rounded-sm">
                    FIX IT →
                  </a>
                </div>
              </div>
              {/* Pairwise scores summary */}
              {selected.pairs?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-emerald-700">
                  <span className="text-emerald-700/70">pairwise:</span>
                  {selected.pairs.map(p => (
                    <span key={`${p.a}-${p.b}`}>
                      <span className={sourceMeta(p.a).text}>{sourceMeta(p.a).label}</span>
                      <span className="text-emerald-700"> ↔ </span>
                      <span className={sourceMeta(p.b).text}>{sourceMeta(p.b).label}</span>
                      <span className="text-emerald-500"> {p.score.toFixed(2)}</span>
                    </span>
                  ))}
                </div>
              )}
              {selected.againstHuman && (
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px]">
                  <span className="text-amber-500/80">vs human (gold):</span>
                  {Object.entries(selected.againstHuman).map(([n, s]) => (
                    <span key={n} className={sourceMeta(n).text}>{sourceMeta(n).label} {s.toFixed(2)}</span>
                  ))}
                </div>
              )}
            </div>

            {loadingPage && (
              <div className="text-emerald-700 font-mono text-xs p-4">LOADING PAGE SOURCES…</div>
            )}
            {pageData && (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {Object.entries(pageData.sources).map(([name, text]) => {
                  const meta = sourceMeta(name);
                  const isBest = pageData.best === name;
                  return (
                    <div key={name}
                         className={`border ${meta.ring} ${isBest ? "ring-1 ring-amber-500/40" : ""} bg-black/40 rounded-sm flex flex-col`}>
                      <div className="flex items-center justify-between px-3 py-1.5 border-b border-emerald-900/30">
                        <div className="flex items-center gap-2">
                          <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                          <span className={`font-mono text-[10px] tracking-widest ${meta.text}`}>{meta.label}</span>
                          {isBest && <span className="font-mono text-[9px] text-amber-300 tracking-widest">· CANONICAL</span>}
                        </div>
                        <span className="font-mono text-[10px] text-emerald-700">{text.length.toLocaleString()} chars</span>
                      </div>
                      <pre className="px-3 py-2 text-emerald-200/90 text-[12px] leading-snug whitespace-pre-wrap break-words max-h-[55vh] overflow-y-auto font-mono">
{text}
                      </pre>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
