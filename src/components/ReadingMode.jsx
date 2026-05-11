import React, { useEffect, useMemo, useRef, useState } from "react";

// Lazy-loads /text/<id>.txt and renders it in a focused reading pane.
// Supports: in-text search, page jump, copy, font scaling.
export default function ReadingMode({ event, onClose }) {
  const [text, setText] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [scale, setScale] = useState(1.0);
  const [meta, setMeta] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setText(null); setError(null);
    const url = `${import.meta.env.BASE_URL}text/${event.id}.txt`;
    fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(`No extracted text available yet (${r.status}). Run npm run corpus to generate.`);
        return r.text();
      })
      .then(t => {
        if (cancelled) return;
        setText(t);
        // try to parse the header
        const m = t.match(/Source extraction: (\w+).*?(\d+) pages/i);
        if (m) setMeta({ source: m[1], pages: Number(m[2]) });
      })
      .catch(e => !cancelled && setError(e.message));

    // ESC to close
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { cancelled = true; window.removeEventListener("keydown", onKey); };
  }, [event.id, onClose]);

  // Build a list of page anchors for the jump bar
  const pages = useMemo(() => {
    if (!text) return [];
    const out = [];
    const re = /=== Page (\d+) ===/g;
    let m;
    while ((m = re.exec(text))) out.push({ n: Number(m[1]), pos: m.index });
    return out;
  }, [text]);

  // Highlight query matches and return chunked nodes
  const rendered = useMemo(() => {
    if (!text) return null;
    if (!query.trim()) {
      // split by page markers for proper formatting
      const parts = text.split(/(=== Page \d+ ===)/g);
      return parts.map((part, i) => {
        if (/^=== Page \d+ ===$/.test(part)) {
          const n = Number(part.match(/\d+/)[0]);
          return (
            <div key={i} id={`page-${n}`} className="my-6 flex items-center gap-3 not-first:mt-10">
              <div className="flex-1 h-px bg-emerald-700/30" />
              <div className="font-mono text-[10px] tracking-[0.3em] text-amber-400">▌ PAGE {n}</div>
              <div className="flex-1 h-px bg-emerald-700/30" />
            </div>
          );
        }
        return <div key={i} className="whitespace-pre-wrap">{part}</div>;
      });
    }
    // Highlight mode
    try {
      const safe = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(${safe})`, "ig");
      const parts = text.split(/(=== Page \d+ ===)/g);
      return parts.map((part, i) => {
        if (/^=== Page \d+ ===$/.test(part)) {
          const n = Number(part.match(/\d+/)[0]);
          return (
            <div key={i} id={`page-${n}`} className="my-6 flex items-center gap-3">
              <div className="flex-1 h-px bg-emerald-700/30" />
              <div className="font-mono text-[10px] tracking-[0.3em] text-amber-400">▌ PAGE {n}</div>
              <div className="flex-1 h-px bg-emerald-700/30" />
            </div>
          );
        }
        const segs = part.split(re);
        return (
          <div key={i} className="whitespace-pre-wrap">
            {segs.map((s, j) => re.test(s)
              ? <mark key={j} className="bg-amber-400/40 text-amber-100 px-0.5 rounded-sm">{s}</mark>
              : <span key={j}>{s}</span>
            )}
          </div>
        );
      });
    } catch {
      return <div className="whitespace-pre-wrap">{text}</div>;
    }
  }, [text, query]);

  const matchCount = useMemo(() => {
    if (!text || !query.trim()) return 0;
    try {
      const safe = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return (text.match(new RegExp(safe, "ig")) || []).length;
    } catch { return 0; }
  }, [text, query]);

  const copy = async () => {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch {}
  };
  const download = () => {
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${event.id}.txt`;
    a.click(); URL.revokeObjectURL(url);
  };
  const jumpTo = (n) => {
    document.getElementById(`page-${n}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="fixed inset-0 z-[60] bg-[#020806]/95 backdrop-blur-sm flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 sm:px-6 py-3 border-b border-emerald-700/40 flex-wrap">
        <button onClick={onClose} className="font-mono text-[11px] text-emerald-500 hover:text-amber-400 tracking-wider">◀ CLOSE</button>
        <div className="font-mono text-[10px] text-emerald-700">▌ READING MODE</div>
        <div className="font-mono text-[11px] text-emerald-300 flex-1 min-w-0 truncate">{event.title}</div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="› SEARCH IN TEXT"
          className="bg-black/60 border border-emerald-700/50 rounded-sm px-2 py-1 text-emerald-300 placeholder-emerald-700 font-mono text-xs w-36 sm:w-48 focus:outline-none focus:border-amber-400" />
        {query && <div className="font-mono text-[10px] text-amber-300">{matchCount} hit{matchCount !== 1 && "s"}</div>}
        <div className="flex items-center gap-1">
          <button onClick={() => setScale(s => Math.max(0.7, s - 0.1))} className="font-mono text-[11px] text-emerald-500 hover:text-amber-400 px-1.5">A−</button>
          <button onClick={() => setScale(s => Math.min(1.6, s + 0.1))} className="font-mono text-[11px] text-emerald-500 hover:text-amber-400 px-1.5">A+</button>
        </div>
        <button onClick={copy} className="font-mono text-[10px] text-emerald-500 hover:text-amber-400 px-2 py-1 border border-emerald-700/40 rounded-sm">COPY</button>
        <button onClick={download} className="font-mono text-[10px] text-emerald-500 hover:text-amber-400 px-2 py-1 border border-emerald-700/40 rounded-sm">.txt</button>
      </div>

      {/* Meta strip */}
      {meta && (
        <div className="px-3 sm:px-6 py-1.5 font-mono text-[9px] text-emerald-700 border-b border-emerald-700/20 tracking-widest">
          {meta.source === "OCR" ? "▌ TEXT EXTRACTED VIA OCR — may contain typos / unrecognized characters" : "▌ TEXT EXTRACTED FROM PDF TEXT LAYER"}
          {" · "}{meta.pages} pages
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Page jump sidebar (only if multi-page) */}
        {pages.length > 1 && (
          <nav className="hidden md:block w-16 overflow-y-auto border-r border-emerald-700/20 bg-black/40 p-2">
            <div className="font-mono text-[8px] text-emerald-700 tracking-widest mb-1">PAGE</div>
            {pages.map(p => (
              <button key={p.n} onClick={() => jumpTo(p.n)}
                className="block w-full text-left font-mono text-[10px] text-emerald-500 hover:text-amber-300 py-0.5">
                {String(p.n).padStart(3, " ")}
              </button>
            ))}
          </nav>
        )}

        {/* Text body */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-8 py-6">
          {error && (
            <div className="max-w-3xl mx-auto border border-rose-400/40 bg-rose-400/5 rounded-sm p-4 font-mono text-[12px] text-rose-300">
              ⊘ {error}
            </div>
          )}
          {!text && !error && (
            <div className="max-w-3xl mx-auto font-mono text-[12px] text-emerald-700 py-12 text-center">
              ◌ Loading extracted text…
            </div>
          )}
          {text && (
            <article className="max-w-3xl mx-auto font-mono text-emerald-100 leading-relaxed"
              style={{ fontSize: `${13 * scale}px` }}>
              {rendered}
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
