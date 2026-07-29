// Supported UI languages. `code` is the BCP-47 tag we persist + emit on
// <html lang>. `native` is the autonym shown in the picker so each
// language reads as itself, never transliterated. `dir` is the writing
// direction (Tailwind + browser already respond to dir="rtl").
//
// Add a language here and drop a `locales/<code>.js` next to it; the
// picker, html-lang sync, and missing-key fallback all pick it up
// automatically.

export const DEFAULT_LOCALE = "en";

export const LANGUAGES = [
  { code: "en",    native: "English",    english: "English",              dir: "ltr" },
  { code: "es",    native: "Español",    english: "Spanish",              dir: "ltr" },
  { code: "fr",    native: "Français",   english: "French",               dir: "ltr" },
  { code: "de",    native: "Deutsch",    english: "German",               dir: "ltr" },
  { code: "pt",    native: "Português",  english: "Portuguese",           dir: "ltr" },
  { code: "it",    native: "Italiano",   english: "Italian",              dir: "ltr" },
  { code: "nl",    native: "Nederlands", english: "Dutch",                dir: "ltr" },
  { code: "pl",    native: "Polski",     english: "Polish",               dir: "ltr" },
  { code: "ru",    native: "Русский",    english: "Russian",              dir: "ltr" },
  { code: "uk",    native: "Українська", english: "Ukrainian",            dir: "ltr" },
  { code: "tr",    native: "Türkçe",     english: "Turkish",              dir: "ltr" },
  { code: "vi",    native: "Tiếng Việt", english: "Vietnamese",           dir: "ltr" },
  { code: "hi",    native: "हिन्दी",       english: "Hindi",                dir: "ltr" },
  { code: "zh",    native: "中文",        english: "Chinese (Simplified)", dir: "ltr" },
  { code: "ja",    native: "日本語",      english: "Japanese",             dir: "ltr" },
  { code: "ko",    native: "한국어",      english: "Korean",               dir: "ltr" },
  { code: "ar",    native: "العربية",      english: "Arabic",               dir: "rtl" },
  { code: "he",    native: "עברית",        english: "Hebrew",               dir: "rtl" },
];

export const LANGUAGE_BY_CODE = Object.fromEntries(LANGUAGES.map(l => [l.code, l]));

// Pick the best supported locale for a raw navigator.language string
// (e.g. "pt-BR" → "pt", "zh-Hans-CN" → "zh"). Falls back to DEFAULT_LOCALE
// when nothing matches so first-paint always has a dictionary loaded.
export function pickLocale(raw) {
  if (!raw) return DEFAULT_LOCALE;
  const norm = String(raw).toLowerCase();
  if (LANGUAGE_BY_CODE[norm]) return norm;
  const base = norm.split(/[-_]/)[0];
  if (LANGUAGE_BY_CODE[base]) return base;
  return DEFAULT_LOCALE;
}
