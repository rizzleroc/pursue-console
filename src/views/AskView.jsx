import React, { useEffect, useMemo, useState, useCallback } from "react";
import { ask, ASK_EXAMPLES } from "../lib/askEngine.js";
import { askWithRag, checkBackend } from "../lib/ragClient.js";
import { loadSettings, saveSettings, BACKENDS, PROVIDERS } from "../lib/askSettings.js";
import { WEBLLM_MODELS } from "../lib/webllmClient.js";
import { AGENCY_COLORS, EVENTS } from "../data/events.js";
import { GlitchText, DocTypeBadge, flagBg } from "../components/Primitives.jsx";
import { useT } from "../i18n/context.js";

// =====================================================================
// ASK — natural-language interface over the catalogue.
//
// Two modes:
//   PATTERN — local intent classifier (lib/askEngine.js). Instant. Free.
//             Answers dataset-shape questions: changes / classified / etc.
//   SMART   — real RAG. Embeds the question via MiniLM, FAISS-style
//             cosine over public/embeddings.bin, sends top-K passages to
//             the user's local pursue-vision-mcp daemon, which routes
//             through their logged-in Claude / ChatGPT / Gemini tab.
//             Returns a synthesized answer with citations.
// =====================================================================
const eventById = Object.fromEntries(EVENTS.map(e => [e.id, e]));

export default function AskView({ onSelect, headerFilters }) {
  const t = useT();
  const [mode, setMode] = useState("smart");
  const [query, setQuery] = useState(headerFilters?.query || "");
  useEffect(() => {
    if ((headerFilters?.query ?? "") !== query) setQuery(headerFilters?.query || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerFilters?.query]);

  return (
    <div className="px-3 sm:px-8 py-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-emerald-300 text-lg sm:text-2xl tracking-[0.2em]">
          <GlitchText>{t("ask.title")}</GlitchText>
        </h2>
        <ModeSwitch mode={mode} setMode={setMode} />
      </div>

      {mode === "pattern"
        ? <PatternMode query={query} setQuery={setQuery} onSelect={onSelect} />
        : <SmartMode   query={query} setQuery={setQuery} onSelect={onSelect} />}
    </div>
  );
}

function ModeSwitch({ mode, setMode }) {
  const t = useT();
  return (
    <div className="inline-flex rounded-sm border border-emerald-700/40 overflow-hidden">
      {[
        { id: "smart",   label: t("ask.mode_smart") },
        { id: "pattern", label: t("ask.mode_pattern") },
      ].map(m => (
        <button
          key={m.id}
          onClick={() => setMode(m.id)}
          className={`px-3 py-1.5 font-mono text-[10px] tracking-[0.2em] ${
            mode === m.id
              ? "bg-emerald-900/40 text-emerald-200"
              : "text-emerald-700 hover:text-emerald-400"
          }`}>
          {m.label}
        </button>
      ))}
    </div>
  );
}

// ---- PATTERN MODE (pure local, no MCP) -------------------------------

function PatternMode({ query, setQuery, onSelect }) {
  const t = useT();
  const answer = useMemo(() => ask(query), [query]);

  return (
    <>
      <div className="mb-3">
        <input value={query} onChange={e => setQuery(e.target.value)} autoFocus
          placeholder={t("ask.pattern_placeholder")}
          className="w-full bg-black/60 border border-emerald-700/50 rounded-sm px-3 py-2 text-emerald-200 placeholder-emerald-700 font-mono text-sm focus:outline-none focus:border-amber-400 focus:shadow-[0_0_8px_rgba(255,217,61,0.4)]" />
      </div>
      {!query && <QuickChips setQuery={setQuery} />}
      <AnswerCard answer={answer} />
      {answer.groups && answer.groups.length > 0 && (
        <div className="space-y-4">
          {answer.groups.map((g, i) => <Group key={i} group={g} onSelect={onSelect} />)}
        </div>
      )}
      {answer.events && answer.events.length > 0 && (
        <div className="space-y-2">
          {answer.events.map(e => <EventRow key={e.id} event={e} onSelect={onSelect} />)}
        </div>
      )}
    </>
  );
}

// ---- SMART MODE (FAISS + MCP) ----------------------------------------

const SMART_EXAMPLES = [
  "Summarize the Apollo 17 triangular-lights case in one paragraph",
  "What evidence is there of an SWIR-only diamond UAP?",
  "Which witnesses described 90-degree turns over water?",
  "What does the COMETA report actually conclude?",
  "Quote the most striking passage from the 1963 Presidential memo",
  "Compare the Western US 2023 cluster to the USPER super-hot orb",
  "What did Borman and Lovell actually see during Gemini 7?",
];

function SmartMode({ query, setQuery, onSelect }) {
  const t = useT();
  const [settings, setSettings] = useState(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [health, setHealth] = useState(null);   // { ok, error }
  const [status, setStatus] = useState(null);   // { phase, ... }
  const [modelProgress, setModelProgress] = useState(null); // { file, status, progress }
  const [result, setResult] = useState(null);   // { answer, contexts, durationMs, provider }
  const [error, setError]   = useState(null);
  const [running, setRunning] = useState(false);

  const persist = useCallback((next) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  // Ping the active backend on first mount + whenever it changes. Cheap
  // /health probe; tells the user immediately if it isn't up. The
  // in-browser backend reports OK trivially (the LLM weights aren't
  // fetched until the user asks something).
  const backendKey =
    settings.backend === "in-browser" ? settings.modelId :
    settings.backend === "local-mcp"  ? settings.daemonUrl :
                                        settings.hostedUrl;
  useEffect(() => {
    let dead = false;
    setHealth(null);
    checkBackend(settings).then(h => { if (!dead) setHealth(h); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.backend, backendKey]);

  // First-run UX: open the settings panel automatically only for the
  // local-mcp backend (the user has to paste their token there). The
  // in-browser and hosted backends both work out of the box.
  useEffect(() => {
    if (settings.backend === "local-mcp" && !settings.token) setSettingsOpen(true);
  }, [settings.backend, settings.token]);

  const onSubmit = async () => {
    if (!query.trim()) return;
    setRunning(true); setError(null); setResult(null);
    setStatus({ phase: "starting" }); setModelProgress(null);
    try {
      const out = await askWithRag({
        question: query, settings,
        onStatus: setStatus,
        onModelProgress: setModelProgress,
      });
      setResult(out);
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
      setStatus(null); setModelProgress(null);
    }
  };

  return (
    <>
      <div className="flex items-stretch gap-2 mb-3">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !running) onSubmit(); }}
          autoFocus
          placeholder={t("ask.smart_placeholder")}
          className="flex-1 bg-black/60 border border-emerald-700/50 rounded-sm px-3 py-2 text-emerald-200 placeholder-emerald-700 font-mono text-sm focus:outline-none focus:border-amber-400 focus:shadow-[0_0_8px_rgba(255,217,61,0.4)]" />
        <button
          onClick={onSubmit}
          disabled={running || !query.trim()}
          className="px-4 py-2 font-mono text-[11px] tracking-[0.2em] rounded-sm border border-amber-500/70 bg-amber-900/20 text-amber-200 hover:bg-amber-700/30 hover:border-amber-300 disabled:opacity-40 disabled:cursor-not-allowed">
          {running ? "…" : t("ask.submit")}
        </button>
      </div>

      {/* Settings strip — collapsed by default. Opens automatically only
          when the local-mcp backend is selected without a token. */}
      <SettingsPanel
        open={settingsOpen}
        onToggle={() => setSettingsOpen(o => !o)}
        settings={settings} onChange={persist}
        health={health} onRecheck={() => checkBackend(settings).then(setHealth)} />

      {!query && <QuickChips setQuery={setQuery} examples={SMART_EXAMPLES} />}

      {running && <RunningStatus status={status} modelProgress={modelProgress} />}
      {error && <ErrorCard error={error} />}
      {result && <ResultCard result={result} onSelect={onSelect} />}
    </>
  );
}

function SettingsPanel({ open, onToggle, settings, onChange, health, onRecheck }) {
  const t = useT();
  const isInBrowser = settings.backend === "in-browser";
  const isHosted    = settings.backend === "hosted";
  const summary =
    isInBrowser ? settings.modelId :
    isHosted    ? settings.hostedUrl :
                  settings.daemonUrl;
  const backendLabel =
    isInBrowser ? t("ask.backend_in_browser") :
    isHosted    ? t("ask.backend_hosted") :
                  t("ask.backend_local_mcp");
  return (
    <div className="border border-emerald-700/30 bg-black/30 rounded-sm mb-4">
      <button
        onClick={onToggle}
        className="w-full px-3 py-1.5 flex items-center justify-between hover:bg-emerald-950/40">
        <span className="font-mono text-[10px] tracking-widest text-emerald-500">
          {t("ask.backend_label", { backend: backendLabel, summary })}
        </span>
        <span className="flex items-center gap-2">
          {health == null && <span className="font-mono text-[9px] text-emerald-700">{t("ask.checking")}</span>}
          {health?.ok && <span className="font-mono text-[9px] text-emerald-300">{t("ask.backend_up")}</span>}
          {health && !health.ok && <span className="font-mono text-[9px] text-rose-400">{t("ask.backend_unreachable")}</span>}
          <span className="font-mono text-[10px] text-emerald-700">{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open && (
        <div className="px-3 py-3 border-t border-emerald-900/40 space-y-2">
          <Row label={t("ask.row_backend")}>
            <select value={settings.backend}
              onChange={e => onChange({ ...settings, backend: e.target.value })}
              className="w-full bg-black/60 border border-emerald-800/50 rounded-sm px-2 py-1 text-emerald-200 font-mono text-[12px]">
              {BACKENDS.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
          </Row>

          {isInBrowser && (
            <>
              <Row label={t("ask.row_model")}>
                <select value={settings.modelId}
                  onChange={e => onChange({ ...settings, modelId: e.target.value })}
                  className="w-full bg-black/60 border border-emerald-800/50 rounded-sm px-2 py-1 text-emerald-200 font-mono text-[12px]">
                  {WEBLLM_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </Row>
              <div className="font-mono text-[10px] text-emerald-700 leading-relaxed pl-32">
                {t("ask.in_browser_hint")}
              </div>
            </>
          )}

          {isHosted && (
            <>
              <Row label={t("ask.row_hosted_url")}>
                <input value={settings.hostedUrl}
                  onChange={e => onChange({ ...settings, hostedUrl: e.target.value })}
                  placeholder={t("ask.hosted_url_placeholder")}
                  className="w-full bg-black/60 border border-emerald-800/50 rounded-sm px-2 py-1 text-emerald-200 placeholder-emerald-700 font-mono text-[12px]" />
              </Row>
              <Row label={t("ask.row_shared_bearer")}>
                <input type="password" value={settings.hostedBearer}
                  onChange={e => onChange({ ...settings, hostedBearer: e.target.value })}
                  placeholder={t("ask.hosted_bearer_placeholder")}
                  className="w-full bg-black/60 border border-emerald-800/50 rounded-sm px-2 py-1 text-emerald-200 placeholder-emerald-700 font-mono text-[12px]" />
              </Row>
            </>
          )}

          {!isInBrowser && !isHosted && (
            <>
              <Row label={t("ask.row_daemon_url")}>
                <input value={settings.daemonUrl}
                  onChange={e => onChange({ ...settings, daemonUrl: e.target.value })}
                  className="w-full bg-black/60 border border-emerald-800/50 rounded-sm px-2 py-1 text-emerald-200 font-mono text-[12px]" />
              </Row>
              <Row label={t("ask.row_bearer")}>
                <input type="password" value={settings.token}
                  onChange={e => onChange({ ...settings, token: e.target.value })}
                  placeholder={t("ask.bearer_placeholder")}
                  className="w-full bg-black/60 border border-emerald-800/50 rounded-sm px-2 py-1 text-emerald-200 placeholder-emerald-700 font-mono text-[12px]" />
              </Row>
              <Row label={t("ask.row_provider")}>
                <select value={settings.provider}
                  onChange={e => onChange({ ...settings, provider: e.target.value })}
                  className="w-full bg-black/60 border border-emerald-800/50 rounded-sm px-2 py-1 text-emerald-200 font-mono text-[12px]">
                  {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </Row>
            </>
          )}

          <Row label={t("ask.row_topk")}>
            <input type="number" min="3" max="32" value={settings.k}
              onChange={e => onChange({ ...settings, k: Number(e.target.value) || 10 })}
              className="w-24 bg-black/60 border border-emerald-800/50 rounded-sm px-2 py-1 text-emerald-200 font-mono text-[12px]" />
          </Row>

          {health && !health.ok && (
            <div className="font-mono text-[11px] text-rose-300 mt-2 leading-relaxed">
              {t("ask.cant_reach", { error: health.error })}{" "}
              {isHosted ? (
                <>{t("ask.cant_reach_hosted")} <button className="underline text-amber-300" onClick={onRecheck}>{t("ask.retry")}</button>{t("ask.cant_reach_hosted_tail")}</>
              ) : (
                <>{t("ask.cant_reach_local_pre")}{" "}<code className="text-amber-300">{t("ask.cant_reach_local_cmd")}</code>{" "}{t("ask.cant_reach_local_post")} <button className="underline text-amber-300" onClick={onRecheck}>{t("ask.retry")}</button>{t("ask.cant_reach_local_tail")}</>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-start gap-2">
      <div className="font-mono text-[9px] tracking-widest text-emerald-600 w-32 pt-1.5 shrink-0">{label}</div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function RunningStatus({ status, modelProgress }) {
  const t = useT();
  const PHASES = {
    "starting":            t("ask.phases.starting"),
    "loading-vectors":     t("ask.phases.loading_vectors"),
    "loading-embed-model": t("ask.phases.loading_embed_model"),
    "embedding":           t("ask.phases.embedding"),
    "retrieving":          t("ask.phases.retrieving"),
    "loading-model":       t("ask.phases.loading_model"),
    "generating":          t("ask.phases.generating"),
    "calling-backend":     t("ask.phases.calling_backend", { backend: status?.backend || "backend", n: status?.contextCount ?? "?" }),
  };
  // transformers.js emits { file, status, progress (0-100) } during
  // weight downloads. Show the current file + percentage so a long
  // first-time download doesn't feel frozen.
  const showProgress = modelProgress
    && modelProgress.status === "progress"
    && typeof modelProgress.progress === "number";
  return (
    <div className="border border-amber-500/40 bg-amber-900/10 rounded-sm p-3 mb-4 font-mono text-[12px] text-amber-200 tracking-wider space-y-2">
      <div className="flex items-center gap-2">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
        {PHASES[status?.phase] || t("ask.phases.working")}
      </div>
      {showProgress && (
        <div className="space-y-1">
          <div className="text-[10px] text-amber-300/80">
            {modelProgress.file}{" "}· {Math.round(modelProgress.progress)}%
          </div>
          <div className="h-1 w-full bg-amber-900/40 rounded-sm overflow-hidden">
            <div className="h-full bg-amber-400/70 transition-all"
              style={{ width: `${Math.min(100, Math.max(0, modelProgress.progress))}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

function ErrorCard({ error }) {
  return (
    <div className="border border-rose-400/40 bg-rose-400/5 rounded-sm p-3 mb-4 font-mono text-[12px] text-rose-300 leading-relaxed">
      ⊘ {error}
    </div>
  );
}

function ResultCard({ result, onSelect }) {
  const t = useT();
  return (
    <div className="space-y-4">
      <div className="border border-emerald-700/40 bg-black/40 rounded-sm p-3 sm:p-4">
        <div className="flex items-baseline gap-2 flex-wrap mb-2">
          <span className="font-mono text-[9px] tracking-widest text-amber-400">{t("ask.answer_label")}</span>
          <span className="font-mono text-[9px] tracking-widest text-emerald-700">
            {t("ask.answer_meta", {
              backend: result.backend || result.provider,
              model: result.model ? ` · ${result.model}` : "",
              n: result.contexts.length,
              seconds: (result.durationMs / 1000).toFixed(1),
            })}
          </span>
        </div>
        <pre className="font-mono text-[13px] text-emerald-100 leading-relaxed whitespace-pre-wrap">
          {result.answer}
        </pre>
      </div>

      <div>
        <div className="font-mono text-[10px] tracking-widest text-emerald-700 mb-2">
          {t("ask.looking_at", { n: result.contexts.length })}
        </div>
        <div className="space-y-2">
          {result.contexts.map((c, i) => {
            const ev = eventById[c.eid];
            if (!ev) {
              // User-dropped or auto-imported chunk without a curated event — show inline.
              return (
                <div key={i} className="border-l-2 border-emerald-900 bg-emerald-950/20 p-2 rounded-sm">
                  <div className="font-mono text-[10px] text-emerald-700 mb-1">{c.eid} · p{c.page} · {c.score.toFixed(3)}</div>
                  <div className="font-mono text-[11px] text-emerald-300/90">{c.text}</div>
                </div>
              );
            }
            const color = AGENCY_COLORS[ev.agency] || "#7CFFB2";
            return (
              <button
                key={i}
                onClick={() => onSelect(ev, c.page != null ? { page: c.page } : undefined)}
                className={`block w-full text-left border-l-2 ${flagBg(ev.flag)} border p-2 rounded-sm hover:bg-emerald-950/40`}
                style={{ borderLeftColor: color }}>
                <div className="flex items-baseline justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] tracking-wider" style={{ color }}>
                      {ev.agency.replace("Department of ", "DEPT/")}
                    </span>
                    <span className="font-mono text-[10px] text-emerald-100">{ev.title}</span>
                  </div>
                  <span className="font-mono text-[9px] text-emerald-700">
                    {t("ask.page_score", { page: c.page ?? "—", score: c.score.toFixed(3) })}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-emerald-300/80 mt-1 line-clamp-2">{c.text}</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---- shared bits -----------------------------------------------------

function QuickChips({ setQuery, examples }) {
  const t = useT();
  const list = examples || ASK_EXAMPLES;
  return (
    <div className="mb-4">
      <div className="font-mono text-[9px] text-emerald-700 tracking-widest mb-2">{t("ask.try")}</div>
      <div className="flex flex-wrap gap-1.5">
        {list.map(q => (
          <button
            key={q} onClick={() => setQuery(q)}
            className="px-2 py-0.5 rounded-sm font-mono text-[11px] bg-emerald-950/60 text-emerald-300 hover:bg-emerald-900/80 border border-emerald-700/40">
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

function AnswerCard({ answer }) {
  const t = useT();
  return (
    <div className="border border-emerald-700/40 bg-black/40 rounded-sm p-3 sm:p-4 mb-4">
      <div className="flex items-baseline gap-2 flex-wrap mb-2">
        <span className="font-mono text-[9px] tracking-widest text-amber-400">{t("ask.answer_label")}</span>
        {answer.intent && answer.intent !== "empty" && (
          <span className="font-mono text-[9px] tracking-widest text-emerald-700">{t("ask.intent", { intent: answer.intent.toUpperCase() })}</span>
        )}
        {answer.query?.agency && (
          <span className="font-mono text-[9px] tracking-widest"
            style={{ color: AGENCY_COLORS[answer.query.agency] || "#7CFFB2" }}>
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
      <div className="font-mono text-emerald-100 text-[14px] leading-snug">{answer.headline}</div>
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
        <div className="mt-3 font-mono text-[10px] text-emerald-700 tracking-wider">{t("ask.answer_hint", { hint: answer.hint })}</div>
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
  const t = useT();
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
          {event.redacted && <span className="font-mono text-[9px] tracking-widest text-rose-400 shrink-0">{t("ask.redacted_tag")}</span>}
          {event.videoId && <span className="font-mono text-[9px] tracking-widest text-blue-300 shrink-0">{t("ask.video_tag")}</span>}
          {event.release === "Release 02" && <span className="font-mono text-[9px] tracking-widest text-amber-300 shrink-0">{t("ask.r02_tag")}</span>}
        </div>
        <span className="font-mono text-[10px] text-amber-300 shrink-0">{event.date || "—"}</span>
      </div>
      <div className="font-mono text-emerald-100 text-[13px] mt-1 leading-snug">{event.title}</div>
      {event.summary && (
        <div className="font-mono text-[11px] text-emerald-400/80 mt-1 leading-snug line-clamp-2">{event.summary}</div>
      )}
    </button>
  );
}
