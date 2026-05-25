import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_LOCALE, LANGUAGE_BY_CODE, LANGUAGES, pickLocale } from "./languages.js";
import { I18nContext } from "./context.js";

// All dictionaries are statically imported so the bundle ships every
// language together. The corpus around them is tiny (a few KB per locale
// gzipped) and avoiding a network round-trip on language switch means
// the picker feels instant — important on a console where the user
// reaches for the picker the moment they realize the UI isn't in their
// language.
import en from "./locales/en.js";
import es from "./locales/es.js";
import fr from "./locales/fr.js";
import de from "./locales/de.js";
import pt from "./locales/pt.js";
import it from "./locales/it.js";
import nl from "./locales/nl.js";
import pl from "./locales/pl.js";
import ru from "./locales/ru.js";
import uk from "./locales/uk.js";
import tr from "./locales/tr.js";
import vi from "./locales/vi.js";
import hi from "./locales/hi.js";
import zh from "./locales/zh.js";
import ja from "./locales/ja.js";
import ko from "./locales/ko.js";
import ar from "./locales/ar.js";
import he from "./locales/he.js";

const DICTIONARIES = { en, es, fr, de, pt, it, nl, pl, ru, uk, tr, vi, hi, zh, ja, ko, ar, he };

const STORAGE_KEY = "pursue:locale";

// Walk a dot-path against a dictionary; returns undefined when any
// segment is missing so the caller can fall back cleanly.
function lookup(dict, path) {
  if (!dict) return undefined;
  let node = dict;
  for (const seg of path.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = node[seg];
  }
  return node;
}

// Replace `{name}` placeholders. Values are coerced to string so callers
// can pass numbers directly. Unknown placeholders are left untouched —
// surfacing them in the UI makes missing params obvious during dev.
function interpolate(template, params) {
  if (!params || typeof template !== "string") return template;
  return template.replace(/\{(\w+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : m
  );
}

function detectInitialLocale() {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    if (stored && LANGUAGE_BY_CODE[stored]) return stored;
  } catch { /* private mode / disabled storage */ }
  const nav = window.navigator;
  const candidates = [
    ...(Array.isArray(nav?.languages) ? nav.languages : []),
    nav?.language,
  ].filter(Boolean);
  for (const c of candidates) {
    const picked = pickLocale(c);
    if (picked !== DEFAULT_LOCALE || /^en\b/i.test(c)) return picked;
  }
  return DEFAULT_LOCALE;
}

export function I18nProvider({ children }) {
  const [locale, setLocaleState] = useState(detectInitialLocale);

  // Sync <html lang> + dir so screen readers, CSS `:lang()`, font
  // rendering, and bidi all behave. Done as an effect so SSR (never used
  // here, but harmless) doesn't touch document on the server.
  useEffect(() => {
    const lang = LANGUAGE_BY_CODE[locale] || LANGUAGE_BY_CODE[DEFAULT_LOCALE];
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("lang", lang.code);
      document.documentElement.setAttribute("dir", lang.dir);
    }
  }, [locale]);

  const setLocale = useCallback((code) => {
    if (!LANGUAGE_BY_CODE[code]) return;
    setLocaleState(code);
    try { window.localStorage?.setItem(STORAGE_KEY, code); } catch { /* ignore */ }
  }, []);

  const t = useCallback((key, params, fallback) => {
    const active = DICTIONARIES[locale];
    const hit = lookup(active, key);
    if (typeof hit === "string") return interpolate(hit, params);
    // Fall back to English so an un-translated key still renders rather
    // than showing the raw key path.
    const enHit = lookup(DICTIONARIES.en, key);
    if (typeof enHit === "string") return interpolate(enHit, params);
    return interpolate(fallback ?? key, params);
  }, [locale]);

  const value = useMemo(() => {
    const lang = LANGUAGE_BY_CODE[locale] || LANGUAGE_BY_CODE[DEFAULT_LOCALE];
    return { locale, dir: lang.dir, setLocale, t, languages: LANGUAGES };
  }, [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
// Hooks (`useT`, `useI18n`) and the LANGUAGES list live in their own
// plain-JS modules so this JSX file only exports the Provider component —
// keeps Vite React Fast Refresh happy. Callers do:
//   import { I18nProvider } from "../i18n/index.jsx";
//   import { useT } from "../i18n/context.js";
