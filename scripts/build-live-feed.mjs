// Build public/live-feed.json — a chronological stream of every page
// successfully transcribed, derived from the single source of truth:
// data-raw/corpus.sqlite (the `pages` table, populated by db-rebuild.mjs).
//
// The LIVE view in the app fetches this and shows "what we just decoded"
// as a ticker — a transparency layer over the corpus pipeline. Because it
// reads the same DB that produces public/corpus-stats.json (and the
// volunteer cockpit's work-available.json), every dashboard now agrees on
// source attribution and counts — no more disagreeing numbers across views.
//
// One entry per (eventId, page). Source is the page's canonical
// `best_source`, folded into three display families:
//   human                  → "human"   (volunteer-typed truth)
//   gemini | gpt-vision     → "vision"  (machine vision OCR)
//   ocr | pdfjs | (none)    → "ocr"     (tesseract / extracted text)
// Snippet = first 280 chars of the committed cache transcript, collapsed.

import Database from "better-sqlite3";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data-raw", "corpus.sqlite");
const VIS = path.join(ROOT, "data-raw/.vision-cache");
const OCR = path.join(ROOT, "data-raw/.ocr-cache");
const OUT = path.join(ROOT, "public/live-feed.json");

const MAX_ENTRIES = Number(process.env.MAX_FEED || 200);
const MIN_CHARS   = Number(process.env.MIN_CHARS || 30);

// Bail out if the DB hasn't been built — preserves the committed JSON.
// (db-rebuild.mjs runs earlier in the build chain, so this only trips when
// the script is invoked standalone before a rebuild.)
if (!existsSync(DB_PATH)) {
  console.log("[live-feed] no data-raw/corpus.sqlite — leaving public/live-feed.json untouched.");
  process.exit(0);
}

// Fold a page's canonical best_source into a display family.
function familyOf(best, hasOcr) {
  if (best === "human") return "human";
  if (best === "gemini" || best === "gpt-vision") return "vision";
  if (best === "ocr" || best === "pdfjs") return "ocr";
  return hasOcr ? "ocr" : "vision";
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const rows = db.prepare(`
  SELECT p.event_id        AS eventId,
         p.page_num        AS page,
         p.best_source     AS bestSource,
         p.has_ocr         AS hasOcr,
         p.chars           AS chars,
         p.contributor     AS contributor,
         p.needs_review    AS needsReview,
         p.last_updated    AS lastUpdated,
         COALESCE(e.title, p.event_id) AS title,
         e.agency          AS agency,
         e.date            AS date
  FROM pages p
  LEFT JOIN events e ON e.id = p.event_id
`).all();

db.close();

// ---- corpus-wide stats (over ALL indexed pages, not the windowed feed) ----
// Counts every indexed page so feed.stats matches corpus-stats.json exactly
// (totalPages/totalChars and family counts vs bestSource). The MIN_CHARS
// floor below only gates which entries appear in the ticker.
const stats = {
  byEvent: {},
  bySource: { vision: 0, ocr: 0, human: 0 },
  totalPages: rows.length,
  totalChars: 0,
};
for (const r of rows) {
  const fam = familyOf(r.bestSource, r.hasOcr);
  stats.bySource[fam] = (stats.bySource[fam] || 0) + 1;
  stats.totalChars += r.chars;
  const b = stats.byEvent[r.eventId] || { vision: 0, ocr: 0, human: 0, chars: 0 };
  b[fam]++;
  b.chars += r.chars;
  stats.byEvent[r.eventId] = b;
}

// ---- windowed entries: most-recent first (only pages with a real transcript) ----
const sorted = rows
  .filter(r => r.chars >= MIN_CHARS)
  .map(r => ({ ...r, modifiedAt: Date.parse(r.lastUpdated) || 0, family: familyOf(r.bestSource, r.hasOcr) }))
  .sort((a, b) => b.modifiedAt - a.modifiedAt)
  .slice(0, MAX_ENTRIES);

// ---- snippet text from committed caches, only for the windowed entries ----
const dirCache = new Map(); // eid -> Map(pageNum -> absolute file path)
async function pageFileMap(eid) {
  if (dirCache.has(eid)) return dirCache.get(eid);
  const m = new Map();
  for (const root of [VIS, OCR]) {
    const dir = path.join(root, eid);
    if (!existsSync(dir)) continue;
    let files;
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files) {
      const mm = f.match(/^p(\d+)\.txt$/);
      if (!mm) continue;
      const pn = Number(mm[1]);
      if (!m.has(pn)) m.set(pn, path.join(dir, f)); // VIS scanned first → wins
    }
  }
  dirCache.set(eid, m);
  return m;
}

async function snippetFor(eid, page) {
  const fp = (await pageFileMap(eid)).get(page);
  if (!fp) return "";
  try {
    const txt = (await readFile(fp, "utf8")).trim();
    return txt.slice(0, 280).replace(/\s+/g, " ").trim();
  } catch { return ""; }
}

const entries = [];
for (const r of sorted) {
  entries.push({
    eventId: r.eventId,
    title: r.title,
    agency: r.agency || null,
    date: r.date || null,
    page: r.page,
    source: r.family,                 // "vision" | "ocr" | "human"
    sourceDetail: r.bestSource || null,
    chars: r.chars,
    contributor: r.contributor || null,
    needsReview: r.needsReview ? 1 : 0,
    modifiedAt: r.modifiedAt,
    snippet: await snippetFor(r.eventId, r.page),
  });
}

const out = {
  generatedAt: new Date().toISOString(),
  count: entries.length,
  stats,
  entries,
};

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out));
console.log(`[live-feed] wrote ${OUT} — ${entries.length} entries · corpus: ${stats.bySource.vision} vision · ${stats.bySource.ocr} ocr · ${stats.bySource.human} human · ${stats.totalPages} pages · ${stats.totalChars.toLocaleString()} chars`);
