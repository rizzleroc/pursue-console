import React from "react";

const VIEWS = [
  { id: "search", label: "SEARCH", glyph: "⌕" },
  { id: "timeline", label: "TIMELINE", glyph: "▬" },
  { id: "globe", label: "GLOBE", glyph: "◉" },
  { id: "atlas", label: "ATLAS", glyph: "▦" },
  { id: "network", label: "NETWORK", glyph: "✦" },
  { id: "patterns", label: "PATTERNS", glyph: "◬" },
  { id: "threads", label: "THREADS", glyph: "↯" },
  { id: "constellation", label: "TAGS", glyph: "✺" },
  { id: "dossier", label: "DOSSIER", glyph: "❒" },
];

export default function Header({ ticker, view, onViewChange, onSearch, query }) {
  return (
    <header className="border-b border-emerald-700/40 bg-black/40 backdrop-blur-sm sticky top-0 z-20">
      <div className="px-3 sm:px-6 py-2 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="text-emerald-400 text-xs tracking-[0.3em] font-mono"><span className="text-amber-400">▶</span> PURSUE</div>
          <div className="hidden sm:block text-emerald-700 text-[10px] font-mono">REL.01 // 51 ASSETS // {ticker}</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input value={query} onChange={(e) => onSearch(e.target.value)} placeholder="› GREP CORPUS"
            className="bg-black/60 border border-emerald-700/50 rounded-sm px-2 py-1 text-emerald-300 placeholder-emerald-700 font-mono text-xs w-32 sm:w-48 focus:outline-none focus:border-amber-400 focus:shadow-[0_0_8px_rgba(255,217,61,0.4)]" />
        </div>
      </div>
      <nav className="px-1 sm:px-4 flex overflow-x-auto no-scrollbar border-t border-emerald-700/30">
        {VIEWS.map((v) => (
          <button key={v.id} onClick={() => onViewChange(v.id)}
            className={`relative flex-shrink-0 px-3 sm:px-5 py-2 font-mono text-[10px] sm:text-xs tracking-[0.2em] transition-all ${
              view === v.id ? "text-emerald-300" : "text-emerald-700 hover:text-emerald-500"}`}>
            <span className="mr-1.5 opacity-70">{v.glyph}</span>{v.label}
            {view === v.id && <span className="absolute bottom-0 left-2 right-2 h-px bg-emerald-400 shadow-[0_0_8px_rgba(124,255,178,0.8)]" />}
          </button>
        ))}
      </nav>
    </header>
  );
}
