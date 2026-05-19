import React, { useEffect, useMemo, useState } from "react";
import { EVENTS, AGENCY_COLORS } from "../data/events.js";
import { GlitchText } from "../components/Primitives.jsx";

// HELP view — the "How can I help?" tab.
//
// Shows the live work queue (pages still needing vision OCR), the per-doc
// breakdown, the one-command setup, links to the contributor docs, and a
// recognition strip for the people who've already pitched in.

const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
const C = {
  green:    "#7CFFB2",
  greenDim: "#549A76",
  amber:    "#FFD93D",
  cyan:     "#82B6FF",
  rose:     "#FF6B9D",
};

export default function HelpView({ onViewChange }) {
  const [queue, setQueue] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");  // "all" | "small" | "big"
  const [copied, setCopied] = useState("");

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}work-available.json?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setQueue)
      .catch(e => setError(e.message));
    fetch(`${import.meta.env.BASE_URL}corpus-stats.json?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : null).then(setStats).catch(() => {});
  }, []);

  const docs = useMemo(() => {
    if (!queue) return [];
    return Object.entries(queue.byEvent).map(([eid, d]) => ({ eid, ...d }))
      .sort((a, b) => b.pagesNeeded - a.pagesNeeded);
  }, [queue]);

  const filteredDocs = useMemo(() => {
    if (filter === "small") return docs.filter(d => d.pagesNeeded <= 20);
    if (filter === "big")   return docs.filter(d => d.pagesNeeded > 20);
    return docs;
  }, [docs, filter]);

  const totalPagesNeeded = queue?.totalPagesNeeded || 0;
  // Rough time estimate: ~2 min/page at 25s pacing with breaks
  const hoursEstimate = totalPagesNeeded * 2 / 60;

  const eventById = useMemo(() => Object.fromEntries(EVENTS.map(e => [e.id, e])), []);

  function copy(snippet, id) {
    navigator.clipboard?.writeText(snippet).then(() => {
      setCopied(id);
      setTimeout(() => setCopied(""), 1400);
    }).catch(() => {});
  }

  const QUICKSTART_BASH = [
    "# One command. Pulls only what helpers need (~10MB instead of 1GB):",
    "curl -fsSL https://rizzleroc.github.io/pursue-console/install-helper.sh | bash",
    "",
    "# Then start helping:",
    "cd pursue-helper",
    "npm start                                # launches Chrome + daemon",
    "npm run volunteer -- --my-handle=YOU     # picks 20 pages, OCRs them, opens a PR",
  ].join("\n");

  const QUICKSTART_PS = [
    "# Windows PowerShell — one command, ~10MB instead of 1GB:",
    "iwr https://rizzleroc.github.io/pursue-console/install-helper.ps1 | iex",
    "",
    "cd pursue-helper",
    "npm start",
    "npm run volunteer -- --my-handle=YOU",
  ].join("\n");

  return (
    <div className="px-3 sm:px-8 py-6">
      {/* ============ HEADER ============ */}
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]">
            <GlitchText>┃ HELP</GlitchText>
          </h2>
          <span className="font-mono text-[10px] text-amber-700 tracking-widest">SETI-STYLE · DISTRIBUTED</span>
        </div>
        <div className="font-mono text-[10px] text-emerald-700">
          {queue ? <>QUEUE GEN {queue.generatedAt?.slice(0,16).replace("T"," ")} · {Object.keys(queue.byEvent).length} DOCS · {totalPagesNeeded} PAGES</> : "LOADING…"}
        </div>
      </div>

      {/* ============ PRIORITY LADDER ============ */}
      {/* Per-event breakdowns from stats + queue — volunteers can see
          "13 in 1949-discs, 2 in incident-summaries" and pick a slice
          instead of asking "which one should I work on?" */}
      <div className="grid lg:grid-cols-3 gap-3 mb-6">
        <PriorityCard
          rank="1"
          status="OPEN NOW"
          color="amber"
          count={stats?.review?.pagesNeedingReview ?? "—"}
          unit="DISPUTED PAGES"
          title="Settle the review queue"
          body={<>Pages where Gemini and ChatGPT disagree. Read both, type the correct version. <span className="text-amber-200">One disputed page resolved = canonical text settled forever.</span></>}
          breakdown={(stats?.review?.topEventsByReviewQueue || []).map(r => ({ eid: r.event_id, n: r.n }))}
          action={onViewChange ? { label: "OPEN REVIEW →", onClick: () => onViewChange("review") } : null}
        />

        <PriorityCard
          rank="2"
          status="OPEN NOW"
          color="emerald"
          count={queue?.totalPagesNeeded ?? "—"}
          unit="PAGES NEED OCR"
          title="Transcribe new pages"
          body={<>Your own logged-in browser does the OCR via ChatGPT or Gemini. The volunteer script picks unclaimed pages, opens a PR.</>}
          breakdown={Object.entries(queue?.byEvent || {})
            .filter(([, d]) => d.pagesNeeded > 0)
            .map(([eid, d]) => ({ eid, n: d.pagesNeeded }))
            .sort((a, b) => b.n - a.n)
            .slice(0, 5)}
          action={{ label: "QUICKSTART ↓", onClick: () => document.getElementById("quickstart")?.scrollIntoView({ behavior: "smooth" }) }}
        />

        <PriorityCard
          rank="3"
          status="OPEN NOW"
          color="cyan"
          count={queue?.totalPagesNeedingVisualContext ?? "—"}
          unit="VISUALS NEED CONTEXT"
          title="Screenshot the visuals + context"
          body={<>Photographs, sketches, newspaper clippings, maps, diagrams: capture the page image and write the documentary context (verbatim from surrounding pages). Two-phase: claim → fill template → commit.</>}
          breakdown={Object.entries(queue?.byEvent || {})
            .filter(([, d]) => (d.pagesNeedingVisualContext || 0) > 0)
            .map(([eid, d]) => ({ eid, n: d.pagesNeedingVisualContext }))
            .sort((a, b) => b.n - a.n)
            .slice(0, 5)}
          action={{ label: "QUICKSTART ↓", onClick: () => document.getElementById("media-quickstart")?.scrollIntoView({ behavior: "smooth" }) }}
        />
      </div>

      {/* ============ HERO PITCH ============ */}
      <div className="border-2 border-dashed border-amber-700/50 bg-gradient-to-b from-amber-950/30 to-transparent rounded-sm p-5 mb-6">
        <div className="grid sm:grid-cols-[1fr,auto] gap-4 items-center">
          <div>
            <div className="font-mono text-[10px] tracking-[0.3em] text-amber-300 mb-2">▌ THE MAINTAINER'S CHATGPT QUOTA IS THE BOTTLENECK</div>
            <div className="font-mono text-emerald-100 text-sm leading-relaxed">
              We've got <span className="text-amber-300 tabular-nums">{totalPagesNeeded}</span> pages of scanned documents waiting for vision OCR.
              At one ChatGPT Plus account, that's roughly <span className="text-amber-300">{Math.round(hoursEstimate)} hours</span> of work to clear.
              With a dozen volunteers turning their own otherwise-idle compute on it, it's done in an evening.
              <br/><br/>
              Your transcriptions get auto-validated against the <a className="text-cyan-300 hover:text-cyan-100 underline-offset-2 hover:underline" href="https://github.com/rizzleroc/pursue-console/blob/main/JUDGE-STANDARD.md" target="_blank" rel="noopener noreferrer">JUDGE-STANDARD</a> (schema · safety · lexical quality · FAISS semantic authenticity), then merged into the canonical corpus on the next deploy. Credit lands in commit history and CONTRIBUTORS.md.
            </div>
          </div>
          <div className="text-center">
            <div className="font-mono text-7xl text-amber-300 tabular-nums leading-none">{totalPagesNeeded}</div>
            <div className="font-mono text-[10px] text-amber-700 tracking-widest mt-1">PAGES NEED VOLUNTEERS</div>
          </div>
        </div>
      </div>

      {/* ============ QUICK START ============ */}
      <div id="quickstart" className="grid lg:grid-cols-2 gap-4 mb-4">
        <QuickStart os="MACOS · LINUX" snippet={QUICKSTART_BASH} id="bash" copied={copied} onCopy={copy} />
        <QuickStart os="WINDOWS · POWERSHELL" snippet={QUICKSTART_PS} id="ps" copied={copied} onCopy={copy} />
      </div>

      {/* ============ MEDIA QUICK START (Priority 3) ============ */}
      <div id="media-quickstart" className="mb-6 border border-cyan-800/50 bg-cyan-900/10 rounded-sm p-4">
        <div className="font-mono text-[10px] tracking-[0.3em] text-cyan-300 mb-2">▌ PRIORITY 3 · IMAGE + CONTEXT CAPTURE</div>
        <div className="font-mono text-emerald-300 text-[12px] mb-3 leading-relaxed">
          Two-phase. The script renders the pages locally so you can read them while writing the context — no in-terminal typing of paragraphs.
        </div>
        <QuickStart os="CLAIM → FILL → COMMIT" id="media-cli" copied={copied} onCopy={copy} snippet={[
          "# 1. Claim 5 pages (downloads PDFs, renders each page, drops a markdown template):",
          `node scripts/volunteer-media.mjs --my-handle=YOUR_NAME --slice=5`,
          "",
          "# 2. Open ~/.pursue-helper/media-staging/YOUR_NAME/<eid>/",
          "#    Each p<NNN>.jpg has a sibling p<NNN>.md — fill in Title / Context / (Article text).",
          "#    Quote verbatim from the document; don't summarize.",
          "",
          "# 3. Commit + open a PR:",
          `node scripts/volunteer-media.mjs --my-handle=YOUR_NAME --commit`,
        ].join("\n")} />
        <div className="font-mono text-[10px] text-cyan-700 mt-2">
          Full spec: <a className="text-cyan-300 hover:text-cyan-100 underline-offset-2 hover:underline" href="https://github.com/rizzleroc/pursue-console/blob/main/VISUAL-EXTRACTION-PROCESS.md" target="_blank" rel="noreferrer">VISUAL-EXTRACTION-PROCESS.md</a>
        </div>
      </div>

      {/* ============ THE WORK QUEUE ============ */}
      <div className="border border-emerald-700/40 bg-black/40 rounded-sm p-4 mb-6">
        <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
          <div className="font-mono text-[10px] tracking-[0.3em] text-emerald-300">▌ THE WORK QUEUE</div>
          <div className="flex gap-2">
            {[
              { id: "all",   label: "ALL",       n: docs.length },
              { id: "small", label: "SMALL ≤20", n: docs.filter(d => d.pagesNeeded <= 20).length },
              { id: "big",   label: "BIG > 20",  n: docs.filter(d => d.pagesNeeded > 20).length },
            ].map(f => (
              <button key={f.id} onClick={() => setFilter(f.id)}
                style={{ transition: `all 150ms ${EASE}` }}
                className={`px-2 py-0.5 rounded-sm border font-mono text-[10px] tracking-widest active:scale-[0.97] ${
                  filter === f.id ? "border-amber-400/80 text-amber-300 bg-amber-400/10"
                                  : "border-emerald-900 text-emerald-500 hover:border-emerald-700"
                }`}>
                {f.label} <span className="opacity-50">({f.n})</span>
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="font-mono text-[11px] text-rose-300">⊘ {error}</div>
        )}
        {!queue && !error && (
          <div className="font-mono text-[11px] text-emerald-700 py-8 text-center">◌ fetching work queue…</div>
        )}

        {filteredDocs.length > 0 && (
          <div className="divide-y divide-emerald-900/40">
            {filteredDocs.map(d => {
              const ev = eventById[d.eid];
              const pctDone = d.totalPages > 0 ? (d.pagesCompleted / d.totalPages) * 100 : 0;
              const agencyColor = AGENCY_COLORS[d.agency] || C.greenDim;
              return (
                <div key={d.eid} className="py-2.5 first:pt-0">
                  <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1.5">
                    <div className="flex items-baseline gap-3 flex-wrap min-w-0">
                      <span className="font-mono text-[10px] tracking-widest" style={{ color: agencyColor }}>
                        {(d.agency || "").replace("Department of ", "DEPT/")}
                      </span>
                      <span className="font-mono text-emerald-100 text-[13px] truncate">{d.title}</span>
                      <span className="font-mono text-[9px] text-emerald-700">{d.date}</span>
                    </div>
                    <div className="font-mono text-[10px] tracking-widest tabular-nums shrink-0">
                      <span className="text-emerald-300">{d.pagesCompleted}</span>
                      <span className="text-emerald-700">/{d.totalPages}</span>
                      <span className="text-amber-300 ml-2">+{d.pagesNeeded} need vision</span>
                    </div>
                  </div>
                  {/* Progress bar */}
                  <div className="h-1.5 rounded-sm overflow-hidden bg-emerald-950">
                    <div className="h-full" style={{ width: `${pctDone}%`, backgroundColor: C.cyan }} />
                  </div>
                  <div className="mt-1 flex items-baseline justify-between">
                    <span className="font-mono text-[9px] text-emerald-700">
                      claim with: <code className="text-amber-400">--eid={d.eid}</code>
                    </span>
                    {d.pdfUrl && (
                      <a href={d.pdfUrl} target="_blank" rel="noopener noreferrer"
                        className="font-mono text-[9px] text-emerald-600 hover:text-amber-300">SOURCE PDF ↗</a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ============ DOCS + GUIDES ============ */}
      <div className="grid sm:grid-cols-3 gap-3 mb-6">
        <LinkCard
          href="https://github.com/rizzleroc/pursue-console/blob/main/HOW-CAN-I-HELP.md"
          title="HOW-CAN-I-HELP.md"
          sub="full architecture · security · phase 2 roadmap"
        />
        <LinkCard
          href="https://github.com/rizzleroc/pursue-console/blob/main/JUDGE-STANDARD.md"
          title="JUDGE-STANDARD.md"
          sub="what passes · what doesn't · how to fix rejects"
        />
        <LinkCard
          href="https://github.com/rizzleroc/pursue-console/blob/main/pursue-vision-mcp/SECURITY.md"
          title="SECURITY.md"
          sub="what the daemon does to your machine"
        />
      </div>

      {/* ============ HOW IT WORKS DIAGRAM ============ */}
      <div className="border border-emerald-900/60 bg-black/40 rounded-sm p-4 mb-6 font-mono text-[10px] text-emerald-500 leading-relaxed">
        <div className="font-mono text-[10px] tracking-[0.3em] text-emerald-300 mb-3">▌ HOW IT FLOWS</div>
        <pre className="text-emerald-500 text-[10px] leading-snug overflow-x-auto whitespace-pre">{`
   work-available.json  ─────►  YOUR DAEMON  ─────►  ChatGPT
                                      │              (your own session)
                                      │
                                      ▼
                            contributions/<you>/  ─►  gh pr create
                                      │
                                      ▼
                            CI · validate-contribution
                            • schema · safety · lexical
                            • FAISS semantic authenticity
                                      │
                                      ▼
                            MAINTAINER REVIEW
                                      │
                                      ▼
                            merged → next deploy
                            → embeddings.bin grows
                            → live feed shows your transcriptions`}</pre>
      </div>

      <div className="font-mono text-[10px] text-emerald-700 text-center tracking-widest">
        ▌ NO API KEYS · NO CREDENTIALS SHARED · NO PROXIED TRAFFIC · GITHUB-NATIVE COORDINATION
      </div>
    </div>
  );
}

function QuickStart({ os, snippet, id, copied, onCopy }) {
  return (
    <div className="border border-emerald-700/40 bg-black/40 rounded-sm">
      <div className="flex items-center justify-between px-3 py-2 border-b border-emerald-900">
        <span className="font-mono text-[10px] text-emerald-300 tracking-[0.3em]">▌ {os}</span>
        <button onClick={() => onCopy(snippet, id)}
          style={{ transition: "all 150ms cubic-bezier(0.23, 1, 0.32, 1)" }}
          className="font-mono text-[9px] text-emerald-500 hover:text-amber-300 tracking-widest px-2 py-0.5 border border-emerald-900 hover:border-amber-700 rounded-sm active:scale-[0.97]">
          {copied === id ? "✓ COPIED" : "COPY"}
        </button>
      </div>
      <pre className="font-mono text-[11px] text-emerald-200 p-3 leading-relaxed overflow-x-auto whitespace-pre">{snippet}</pre>
    </div>
  );
}

// One of the priority cards at the top — same shape regardless of rank
// so the visual ladder is obvious at a glance. Status / color signals
// open-now (amber, emerald) vs not-yet (cyan, dimmed).
function PriorityCard({ rank, status, color, count, unit, title, body, breakdown, action }) {
  // Static class lookups (Tailwind v3 strips template strings).
  const palette = {
    amber:   { border: "border-amber-500/60",   ring: "hover:border-amber-300",   ranknum: "text-amber-300",   chip: "border-amber-700/60 text-amber-300 bg-amber-900/20",   bigNum: "text-amber-300",   unit: "text-amber-700",   title: "text-emerald-100", body: "text-emerald-400", btn: "border-amber-500 text-amber-200 hover:bg-amber-700/30" },
    emerald: { border: "border-emerald-500/60", ring: "hover:border-emerald-300", ranknum: "text-emerald-300", chip: "border-emerald-700/60 text-emerald-300 bg-emerald-900/20", bigNum: "text-emerald-300", unit: "text-emerald-700", title: "text-emerald-100", body: "text-emerald-400", btn: "border-emerald-500 text-emerald-200 hover:bg-emerald-700/30" },
    cyan:    { border: "border-cyan-700/40",    ring: "",                          ranknum: "text-cyan-500",    chip: "border-cyan-800/60 text-cyan-400 bg-cyan-900/10",          bigNum: "text-cyan-500",    unit: "text-cyan-800",    title: "text-emerald-200", body: "text-emerald-600", btn: "" },
  };
  const c = palette[color] || palette.emerald;
  return (
    <div className={`relative border ${c.border} ${c.ring} bg-black/40 rounded-sm p-4 transition-colors`}>
      <div className="flex items-baseline justify-between mb-2">
        <div className="flex items-baseline gap-2">
          <span className={`font-mono text-3xl font-semibold ${c.ranknum}`}>{rank}</span>
          <span className={`font-mono text-[9px] tracking-[0.25em] px-1.5 py-0.5 rounded-sm border ${c.chip}`}>{status}</span>
        </div>
        <div className="text-right">
          <div className={`font-mono text-2xl tabular-nums ${c.bigNum}`}>{count}</div>
          <div className={`font-mono text-[9px] tracking-widest ${c.unit}`}>{unit}</div>
        </div>
      </div>
      <div className={`font-mono text-[13px] ${c.title} mb-1.5`}>{title}</div>
      <div className={`font-mono text-[11px] leading-snug ${c.body} mb-3`}>{body}</div>
      {breakdown && breakdown.length > 0 && (
        <div className="border-t border-emerald-900/30 pt-2 mb-3">
          <div className={`font-mono text-[9px] tracking-widest ${c.unit} mb-1`}>BY EVENT</div>
          <ul className="font-mono text-[10px] space-y-0.5">
            {breakdown.map(b => (
              <li key={b.eid} className="flex items-baseline justify-between gap-2">
                <span className={`${c.body} truncate`} title={b.eid}>{b.eid}</span>
                <span className={`${c.title} tabular-nums shrink-0`}>{b.n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {action && (
        <button onClick={action.onClick}
          className={`font-mono text-[10px] tracking-widest px-2.5 py-1 rounded-sm border ${c.btn}`}>
          {action.label}
        </button>
      )}
    </div>
  );
}

function LinkCard({ href, title, sub }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      style={{ transition: "all 150ms cubic-bezier(0.23, 1, 0.32, 1)" }}
      className="block border border-emerald-900 hover:border-amber-700 bg-black/40 rounded-sm p-3 active:scale-[0.99]">
      <div className="font-mono text-[11px] text-emerald-300">{title} ↗</div>
      <div className="font-mono text-[9px] text-emerald-600 mt-1 tracking-wider">{sub}</div>
    </a>
  );
}
