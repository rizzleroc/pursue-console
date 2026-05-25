import React, { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/context.js";

// Compact language picker that drops into the header alongside the
// VOLUNTEER CTA. Renders the current language as its native name (so
// every option reads natively, not transliterated), and opens a popover
// list rather than a native <select> so the styling stays consistent
// with the rest of the console chrome (mono font, emerald palette).

export default function LanguagePicker() {
  const { locale, setLocale, t, languages } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close on outside-click and on Escape so it behaves like the
  // VolunteerModal / LaunchOverlay overlays the rest of the app uses.
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = languages.find(l => l.code === locale) || languages[0];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("language.picker_aria")}
        title={t("language.picker_label")}
        className="font-mono text-[11px] tracking-[0.2em] px-2.5 py-1 rounded-sm border border-emerald-700/60 bg-black/40 text-emerald-200 hover:border-emerald-400 hover:text-emerald-100 transition-colors flex items-center gap-1.5">
        <span aria-hidden="true" className="text-emerald-500">⌖</span>
        <span className="uppercase tracking-[0.18em]">{current.code}</span>
        <span aria-hidden="true" className="text-emerald-600 text-[8px]">▼</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={t("language.picker_label")}
          className="absolute right-0 mt-1 z-30 min-w-[180px] max-h-[60vh] overflow-y-auto rounded-sm border border-emerald-700/60 bg-black/95 shadow-[0_0_24px_rgba(16,185,129,0.18)] backdrop-blur-sm">
          {languages.map((lang) => {
            const active = lang.code === locale;
            return (
              <button
                key={lang.code}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => { setLocale(lang.code); setOpen(false); }}
                dir={lang.dir}
                className={`w-full text-start px-3 py-1.5 font-mono text-[11px] flex items-center justify-between gap-2 transition-colors ${
                  active
                    ? "bg-emerald-900/40 text-emerald-100"
                    : "text-emerald-300 hover:bg-emerald-950/60 hover:text-emerald-100"
                }`}>
                <span>{lang.native}</span>
                <span className={`text-[9px] tracking-[0.2em] ${active ? "text-amber-300" : "text-emerald-700"}`}>
                  {lang.code.toUpperCase()}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
