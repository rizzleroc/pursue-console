import { createContext, useContext } from "react";
import { DEFAULT_LOCALE, LANGUAGES } from "./languages.js";

// Context shape and hooks live here (a plain .js file) so the JSX
// Provider module in index.jsx only exports components — keeps Vite's
// React Fast Refresh happy. The Provider in index.jsx wraps this
// context with the actual locale state.

export const I18nContext = createContext({
  locale: DEFAULT_LOCALE,
  dir: "ltr",
  setLocale: () => {},
  t: (key, _params, fallback) => fallback ?? key,
  languages: LANGUAGES,
});

export function useI18n() {
  return useContext(I18nContext);
}

export function useT() {
  return useContext(I18nContext).t;
}
