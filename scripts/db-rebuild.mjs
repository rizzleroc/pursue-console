// Source of truth for the corpus. Reads every authoritative artifact on
// disk (events.js, .vision-cache/, .ocr-cache/, .vision-visuals-cache/,
// contributions/, downloaded PDFs) and (re)populates a single SQLite
// file at data-raw/corpus.sqlite.
//
// Designed to be idempotent — safe to run every build, on every push,
// from cron. Replaces every dashboard "guess" with a SQL query.
//
// Schema (kept simple — five tables, no FKs enforced beyond INTEGER
// references; sql.js / better-sqlite3 don't gain anything from cascade
// rules here and the build is the only writer).
//
//   inventory   — every record war.gov published (TODO: scrape; for now
//                 seeded from events.js URLs + placeholder uncatalogued
//                 rows so the COUNT(*) reflects the public claim)
//   events      — curated metadata layered on inventory
//   pages       — per-page row: which source caches have content, chars,
//                 quality, last-updated
//   contributions — provenance log (handle → eid/page mapping)
//   runs        — append-only log of build/scrape/import runs
//
// The SQLite file is committed (~50KB at current corpus size, grows
// linearly with pages). Backup workflow snapshots it every 6h.

import Database from "better-sqlite3";
import { readFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data-raw", "corpus.sqlite");
const VIS_CACHE = path.join(ROOT, "data-raw", ".vision-cache");
const OCR_CACHE = path.join(ROOT, "data-raw", ".ocr-cache");
const VISUALS_CACHE = path.join(ROOT, "data-raw", ".vision-visuals-cache");
const CONTRIB_DIR = path.join(ROOT, "contributions");
const RAW_DIR = path.join(ROOT, "data-raw");
const STATS_OUT = path.join(ROOT, "public", "corpus-stats.json");

// War.gov press-release claim — kept for the corpus-stats output (so the
// UI can show "X catalogued of Y press-release-claimed") but no longer
// drives placeholder rows now that sync-inventory.mjs pulls a real
// manifest. If a future upstream scrape exceeds this number, we'll
// just stop reporting the constant.
const PRESS_RELEASE_TOTAL = 162;

await mkdir(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// =====================================================================
// SCHEMA
// =====================================================================
db.exec(`
CREATE TABLE IF NOT EXISTS inventory (
  id              TEXT PRIMARY KEY,    -- event id when known, or 'placeholder-<n>' for uncatalogued
  url             TEXT,                -- canonical war.gov URL (NULL if not yet enumerated)
  filename        TEXT,
  content_type    TEXT,                -- 'pdf' | 'video' | 'image' | 'unknown'
  bytes           INTEGER,
  num_pages       INTEGER,             -- for PDFs, from PDF metadata; NULL otherwise
  first_seen      TEXT,                -- ISO timestamp the scraper first saw it
  last_checked    TEXT,
  is_curated      INTEGER NOT NULL DEFAULT 0,   -- 1 once a corresponding events row exists
  is_placeholder  INTEGER NOT NULL DEFAULT 0    -- 1 for the synthetic "we know it exists but no URL" rows
);

CREATE TABLE IF NOT EXISTS events (
  id        TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  date      TEXT,
  agency    TEXT,
  loc       TEXT,
  region    TEXT,
  lat       REAL,
  lon       REAL,
  era       TEXT,
  type      TEXT,
  flag      TEXT,
  summary   TEXT,
  tags      TEXT,             -- JSON array
  url       TEXT
);

CREATE TABLE IF NOT EXISTS pages (
  event_id        TEXT NOT NULL,
  page_num        INTEGER NOT NULL,
  has_pdfjs       INTEGER NOT NULL DEFAULT 0,
  has_ocr         INTEGER NOT NULL DEFAULT 0,
  has_vision      INTEGER NOT NULL DEFAULT 0,
  has_visuals     INTEGER NOT NULL DEFAULT 0,
  -- Per-source flags from sidecar provenance (which transcription sources
  -- have produced text for this page). best_source names which one is
  -- canonical in p<NNN>.txt.
  has_gemini      INTEGER NOT NULL DEFAULT 0,
  has_gpt_vision  INTEGER NOT NULL DEFAULT 0,
  has_human       INTEGER NOT NULL DEFAULT 0,
  best_source     TEXT,        -- 'human' | 'gpt-vision' | 'gemini' | 'ocr' | 'pdfjs' | NULL
  chars           INTEGER NOT NULL DEFAULT 0,
  contributor     TEXT,        -- handle if a volunteer's page outranks/equals canonical
  -- Cross-source comparison (filled by scripts/compare-sources.mjs from
  -- sidecar.comparison). agreement_score is 0..1 token-jaccard+length;
  -- needs_review=1 when sources disagree enough to warrant human eyes.
  agreement_score REAL,
  confidence      TEXT,        -- 'high' | 'medium' | 'low' | NULL
  needs_review    INTEGER NOT NULL DEFAULT 0,
  -- Re-evaluation outcome (from scripts/reevaluate-disputed.mjs):
  --   'prompt-variance'      — standardized prompt across both providers resolved it
  --   'page-intrinsic'       — still disagreeing after standardized re-eval, needs human
  --   'partial-improvement'  — middle band, no clear verdict yet
  --   NULL                   — never re-evaluated
  reeval_agreement REAL,
  dispute_kind     TEXT,
  last_updated    TEXT,
  PRIMARY KEY (event_id, page_num)
);

CREATE TABLE IF NOT EXISTS contributions (
  handle      TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  page_num    INTEGER NOT NULL,
  imported_at TEXT NOT NULL,
  chars       INTEGER NOT NULL,
  PRIMARY KEY (handle, event_id, page_num)
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  kind        TEXT NOT NULL,     -- 'db-rebuild' | 'vision-ocr' | 'embeddings' | 'deploy' | etc.
  event_id    TEXT,
  pages       INTEGER,
  outcome     TEXT,              -- 'ok' | 'partial' | 'fail'
  duration_ms INTEGER,
  note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_pages_event   ON pages(event_id);
CREATE INDEX IF NOT EXISTS idx_pages_source  ON pages(best_source);
CREATE INDEX IF NOT EXISTS idx_contrib_event ON contributions(event_id);
CREATE INDEX IF NOT EXISTS idx_runs_ts       ON runs(ts);
`);

// =====================================================================
// REFRESH — wipe + repopulate the derived tables. (events, inventory,
// pages, contributions all derive from on-disk sources; runs is the
// only append-only one — never wipe it.)
// =====================================================================
const t0 = Date.now();

// ---- events table from src/data/events.js ----
db.exec("DELETE FROM events");
const { EVENTS } = await import(`../src/data/events.js?cb=${Date.now()}`);
const insEvent = db.prepare(`
  INSERT INTO events (id, title, date, agency, loc, region, lat, lon, era, type, flag, summary, tags, url)
  VALUES (@id, @title, @date, @agency, @loc, @region, @lat, @lon, @era, @type, @flag, @summary, @tags, @url)
`);
const insEventTx = db.transaction((rows) => { for (const r of rows) insEvent.run(r); });
insEventTx(EVENTS.map(e => ({
  id: e.id, title: e.title, date: e.date || null, agency: e.agency || null,
  loc: e.loc || null, region: e.region || null,
  lat: e.coords?.[0] ?? null, lon: e.coords?.[1] ?? null,
  era: e.era || null, type: e.type || null, flag: e.flag || null,
  summary: e.summary || null,
  tags: JSON.stringify(e.tags || []),
  url: e.url || null,
})));
const eventsCount = EVENTS.length;

// ---- inventory table ----
// Each event with a url = one real inventory row.
// Each event without a url (e.g. the synthetic "pursue-release-01"
// anchor) = inventory row with is_placeholder=0 but url=NULL.
// Plus N synthetic placeholder rows so COUNT(*) matches the press
// release claim until the scraper enumerates them.
db.exec("DELETE FROM inventory");
const insInv = db.prepare(`
  INSERT INTO inventory (id, url, filename, content_type, bytes, num_pages, first_seen, last_checked, is_curated, is_placeholder)
  VALUES (@id, @url, @filename, @content_type, @bytes, @num_pages, @first_seen, @last_checked, @is_curated, @is_placeholder)
`);

function classifyUrl(url) {
  if (!url) return "unknown";
  const u = url.toLowerCase();
  if (u.endsWith(".pdf")) return "pdf";
  if (/\.(mp4|mov|avi|m4v|webm)$/.test(u)) return "video";
  if (/\.(jpg|jpeg|png|gif|tif|tiff)$/.test(u)) return "image";
  return "unknown";
}

const nowIso = new Date().toISOString();
const inventoryRows = [];
for (const ev of EVENTS) {
  const filename = ev.url ? ev.url.split("/").pop() : null;
  let bytes = null, num_pages = null;
  if (filename) {
    const localPdf = path.join(RAW_DIR, filename);
    if (existsSync(localPdf)) {
      bytes = statSync(localPdf).size;
    }
  }
  // Try the pdfjs-derived page count from the existing text-files manifest
  // if we have one — much faster than re-opening every PDF.
  inventoryRows.push({
    id: ev.id,
    url: ev.url || null,
    filename,
    content_type: classifyUrl(ev.url),
    bytes,
    num_pages,
    first_seen: nowIso,
    last_checked: nowIso,
    is_curated: 1,
    is_placeholder: 0,
  });
}

// Backfill num_pages from public/text/manifest.json when present
try {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "public/text/manifest.json"), "utf8"));
  for (const r of inventoryRows) {
    if (manifest[r.id]?.pages) r.num_pages = manifest[r.id].pages;
  }
} catch {}

// Add un-catalogued PDFs from the Denis manifest sync (real war.gov URLs,
// real filenames, real upstream bytes). Each becomes an inventory row
// with is_curated=0 — when someone writes an events.js entry pointing
// at the same URL, the next rebuild flips is_curated=1.
const inventoryByUrl = new Map(inventoryRows.filter(r => r.url).map(r => [r.url.toLowerCase(), r]));
let syncedUncatalogued = 0;
try {
  const sync = JSON.parse(await readFile(path.join(RAW_DIR, "inventory-sync.json"), "utf8"));
  for (const r of sync.rows || []) {
    const u = r.url.toLowerCase();
    if (inventoryByUrl.has(u)) continue;  // already catalogued; nothing to add
    inventoryRows.push({
      id: `upstream-${r.filename.replace(/\.pdf$/i, "").toLowerCase()}`,
      url: r.url,
      filename: r.filename,
      content_type: "pdf",
      bytes: null,
      num_pages: null,
      first_seen: sync.generatedAt,
      last_checked: sync.generatedAt,
      is_curated: 0,
      is_placeholder: 0,
    });
    syncedUncatalogued++;
  }
} catch {}

// Pure placeholder rows for the press-release residual (videos + images
// + any PDFs not in either Denis's sync or our events.js). Only fired
// when even after the sync we're under the press-release total of 162.
const placeholdersNeeded = Math.max(0, PRESS_RELEASE_TOTAL - inventoryRows.length);
for (let i = 0; i < placeholdersNeeded; i++) {
  inventoryRows.push({
    id: `placeholder-${String(i+1).padStart(3, "0")}`,
    url: null, filename: null, content_type: "unknown",
    bytes: null, num_pages: null,
    first_seen: nowIso, last_checked: nowIso,
    is_curated: 0, is_placeholder: 1,
  });
}
db.transaction((rs) => { for (const r of rs) insInv.run(r); })(inventoryRows);

// ---- pages table from caches ----
db.exec("DELETE FROM pages");
// Force-rebuild the pages schema in case columns were added since the DB
// file was last written.
db.exec(`DROP TABLE IF EXISTS pages;
CREATE TABLE pages (
  event_id TEXT NOT NULL, page_num INTEGER NOT NULL,
  has_pdfjs INTEGER NOT NULL DEFAULT 0, has_ocr INTEGER NOT NULL DEFAULT 0,
  has_vision INTEGER NOT NULL DEFAULT 0, has_visuals INTEGER NOT NULL DEFAULT 0,
  has_gemini INTEGER NOT NULL DEFAULT 0, has_gpt_vision INTEGER NOT NULL DEFAULT 0,
  has_human INTEGER NOT NULL DEFAULT 0,
  agreement_score REAL, confidence TEXT, needs_review INTEGER NOT NULL DEFAULT 0,
  reeval_agreement REAL, dispute_kind TEXT,
  best_source TEXT, chars INTEGER NOT NULL DEFAULT 0,
  contributor TEXT, last_updated TEXT,
  PRIMARY KEY (event_id, page_num)
);
CREATE INDEX IF NOT EXISTS idx_pages_event   ON pages(event_id);
CREATE INDEX IF NOT EXISTS idx_pages_source  ON pages(best_source);`);
const insPage = db.prepare(`
  INSERT OR REPLACE INTO pages
    (event_id, page_num, has_pdfjs, has_ocr, has_vision, has_visuals,
     has_gemini, has_gpt_vision, has_human,
     agreement_score, confidence, needs_review,
     reeval_agreement, dispute_kind,
     best_source, chars, contributor, last_updated)
  VALUES
    (@event_id, @page_num, @has_pdfjs, @has_ocr, @has_vision, @has_visuals,
     @has_gemini, @has_gpt_vision, @has_human,
     @agreement_score, @confidence, @needs_review,
     @reeval_agreement, @dispute_kind,
     @best_source, @chars, @contributor, @last_updated)
`);

async function existsDir(p) { try { return (await stat(p)).isDirectory(); } catch { return false; } }
async function listPageFiles(dir) {
  if (!(await existsDir(dir))) return [];
  return (await readdir(dir)).filter(f => /^p\d+\.txt$/.test(f));
}

// Map event_id -> page_num -> { vision?, ocr?, visuals?, chars, last_updated }
const pageMap = new Map();
function touch(eid, pageNum) {
  if (!pageMap.has(eid)) pageMap.set(eid, new Map());
  const m = pageMap.get(eid);
  if (!m.has(pageNum)) m.set(pageNum, { has_vision: 0, has_ocr: 0, has_visuals: 0, chars: 0, mtime: 0 });
  return m.get(pageNum);
}

// OCR cache pages
for (const eidDir of (await existsDir(OCR_CACHE)) ? await readdir(OCR_CACHE) : []) {
  const dirAbs = path.join(OCR_CACHE, eidDir);
  if (!(await existsDir(dirAbs))) continue;
  for (const f of await listPageFiles(dirAbs)) {
    const pn = Number(f.match(/^p(\d+)/)[1]);
    const st = await stat(path.join(dirAbs, f));
    const text = (await readFile(path.join(dirAbs, f), "utf8")).trim();
    const row = touch(eidDir, pn);
    row.has_ocr = text.length > 0 ? 1 : 0;
    row.chars = Math.max(row.chars, text.length);
    row.mtime = Math.max(row.mtime, st.mtimeMs);
  }
}
// Vision cache pages (wins over OCR)
for (const eidDir of (await existsDir(VIS_CACHE)) ? await readdir(VIS_CACHE) : []) {
  const dirAbs = path.join(VIS_CACHE, eidDir);
  if (!(await existsDir(dirAbs))) continue;
  for (const f of await listPageFiles(dirAbs)) {
    const pn = Number(f.match(/^p(\d+)/)[1]);
    const st = await stat(path.join(dirAbs, f));
    const text = (await readFile(path.join(dirAbs, f), "utf8")).trim();
    const row = touch(eidDir, pn);
    row.has_vision = text.length > 0 ? 1 : 0;
    row.chars = Math.max(row.chars, text.length);  // pick the larger transcript's length
    row.mtime = Math.max(row.mtime, st.mtimeMs);
  }
}
// Visuals (JSON sidecars)
if (await existsDir(VISUALS_CACHE)) {
  for (const eidDir of await readdir(VISUALS_CACHE)) {
    const dirAbs = path.join(VISUALS_CACHE, eidDir);
    if (!(await existsDir(dirAbs))) continue;
    for (const f of await readdir(dirAbs)) {
      const m = f.match(/^p(\d+)\.json$/);
      if (!m) continue;
      const pn = Number(m[1]);
      const row = touch(eidDir, pn);
      row.has_visuals = 1;
    }
  }
}

// Contribution provenance — overlay on top of pages
db.exec("DELETE FROM contributions");
const insContrib = db.prepare(`
  INSERT INTO contributions (handle, event_id, page_num, imported_at, chars)
  VALUES (?, ?, ?, ?, ?)
`);
const contribRows = [];
const manifestFile = path.join(RAW_DIR, ".contributions-manifest.json");
if (existsSync(manifestFile)) {
  const m = JSON.parse(await readFile(manifestFile, "utf8"));
  for (const [key, val] of Object.entries(m)) {
    // key shape: "<eid>/p<NNN>.txt"
    const km = key.match(/^([^/]+)\/p(\d+)\.txt$/);
    if (!km) continue;
    const eid = km[1], pn = Number(km[2]);
    contribRows.push([val.handle, eid, pn, val.importedAt, val.chars]);
    // Tag the pages row so we know the contributor
    const r = touch(eid, pn);
    r._contributor = val.handle;
  }
}
db.transaction((rs) => { for (const r of rs) insContrib.run(...r); })(contribRows);

// Read sidecar JSONs (p<NNN>.sources.json) for source provenance.
// These get written by import-gemini-corpus.mjs and (future) by
// the GPT vision-ocr pipeline.
for (const eidDir of (await existsDir(VIS_CACHE)) ? await readdir(VIS_CACHE) : []) {
  const dirAbs = path.join(VIS_CACHE, eidDir);
  if (!(await existsDir(dirAbs))) continue;
  for (const f of await readdir(dirAbs)) {
    const m = f.match(/^p(\d+)\.sources\.json$/);
    if (!m) continue;
    const pn = Number(m[1]);
    try {
      const sc = JSON.parse(await readFile(path.join(dirAbs, f), "utf8"));
      const row = touch(eidDir, pn);
      row._sidecarBest = sc.best || null;
      row._hasGemini    = sc.sources?.gemini      ? 1 : 0;
      row._hasGptVision = sc.sources?.["gpt-vision"] ? 1 : 0;
      row._hasHuman     = sc.sources?.human       ? 1 : 0;
      if (sc.comparison) {
        row._agreementScore = sc.comparison.agreement_score ?? null;
        row._confidence     = sc.comparison.confidence ?? null;
        row._needsReview    = sc.comparison.needs_review ? 1 : 0;
        row._reevalAgreement = sc.comparison.reeval_agreement ?? null;
        row._disputeKind    = sc.comparison.dispute_kind ?? null;
      }
    } catch {}
  }
}

// Mark pdfjs pages: any event whose text/manifest.json source is "pdfjs"
// (or "mixed") counts each of its pages as has_pdfjs=1. We can't know which
// page-numbers without re-opening the PDF, so this is a per-event flag we
// project across that event's rows rather than enumerate per page.
const pdfjsEvents = new Set();
try {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "public/text/manifest.json"), "utf8"));
  for (const [eid, info] of Object.entries(manifest)) {
    if (info.source === "pdfjs" || info.source === "mixed") pdfjsEvents.add(eid);
  }
} catch {}

// Flush pageMap → pages table
const pageRows = [];
for (const [eid, m] of pageMap) {
  for (const [pn, r] of m) {
    // best_source priority: sidecar (if present) > vision > ocr
    const best = r._sidecarBest || (r.has_vision ? "gpt-vision" : r.has_ocr ? "ocr" : null);
    pageRows.push({
      event_id: eid, page_num: pn,
      has_pdfjs: pdfjsEvents.has(eid) ? 1 : 0,
      has_ocr: r.has_ocr, has_vision: r.has_vision, has_visuals: r.has_visuals,
      has_gemini: r._hasGemini || 0,
      has_gpt_vision: r._hasGptVision || (r.has_vision && !r._hasGemini && !r._hasHuman ? 1 : 0),
      has_human: r._hasHuman || 0,
      agreement_score: r._agreementScore ?? null,
      confidence: r._confidence ?? null,
      needs_review: r._needsReview || 0,
      reeval_agreement: r._reevalAgreement ?? null,
      dispute_kind: r._disputeKind ?? null,
      best_source: best, chars: r.chars,
      contributor: r._contributor || null,
      last_updated: new Date(r.mtime || Date.now()).toISOString(),
    });
  }
}
db.transaction((rs) => { for (const r of rs) insPage.run(r); })(pageRows);

// ---- runs: append a row for this rebuild ----
db.prepare(`
  INSERT INTO runs (ts, kind, event_id, pages, outcome, duration_ms, note)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
  nowIso, "db-rebuild", null, pageRows.length, "ok", Date.now() - t0,
  `events=${eventsCount} inventory=${inventoryRows.length} contributions=${contribRows.length}`
);

// =====================================================================
// DERIVE — produce public/corpus-stats.json with TRUE numbers
// =====================================================================
const q = (sql, ...args) => db.prepare(sql).get(...args);
const qAll = (sql, ...args) => db.prepare(sql).all(...args);

const stats = {
  generatedAt: nowIso,
  pressReleaseClaim: PRESS_RELEASE_TOTAL,
  inventory: {
    total: q("SELECT COUNT(*) AS n FROM inventory").n,
    enumerated: q("SELECT COUNT(*) AS n FROM inventory WHERE url IS NOT NULL").n,
    placeholders: q("SELECT COUNT(*) AS n FROM inventory WHERE is_placeholder=1").n,
    pdfs: q("SELECT COUNT(*) AS n FROM inventory WHERE content_type='pdf'").n,
    videos: q("SELECT COUNT(*) AS n FROM inventory WHERE content_type='video'").n,
    images: q("SELECT COUNT(*) AS n FROM inventory WHERE content_type='image'").n,
    bytesKnown: q("SELECT COALESCE(SUM(bytes), 0) AS n FROM inventory").n,
  },
  events: {
    catalogued: q("SELECT COUNT(*) AS n FROM events").n,
    withPdfDownloaded: q("SELECT COUNT(*) AS n FROM inventory WHERE bytes > 0 AND is_curated=1").n,
    withAnyPages: q("SELECT COUNT(DISTINCT event_id) AS n FROM pages").n,
    withVisionPages: q("SELECT COUNT(DISTINCT event_id) AS n FROM pages WHERE has_vision=1").n,
    fullyVision: qAll(`
      SELECT p.event_id, COUNT(*) AS total, SUM(p.has_vision) AS vision
      FROM pages p GROUP BY p.event_id HAVING total=vision
    `).length,
  },
  pages: {
    totalKnown: q("SELECT COALESCE(SUM(num_pages), 0) AS n FROM inventory WHERE num_pages IS NOT NULL").n,
    totalIndexed: q("SELECT COUNT(*) AS n FROM pages").n,
    vision: q("SELECT COUNT(*) AS n FROM pages WHERE has_vision=1").n,
    ocrOnly: q("SELECT COUNT(*) AS n FROM pages WHERE has_vision=0 AND has_ocr=1").n,
    visualsAnnotated: q("SELECT COUNT(*) AS n FROM pages WHERE has_visuals=1").n,
    totalChars: q("SELECT COALESCE(SUM(chars), 0) AS n FROM pages").n,
  },
  // Per-source breakdown — which transcription source produced each page.
  // A page can have multiple sources (e.g. both Gemini and GPT
  // transcribed it); has_X counts include overlap, best counts each page once.
  bySource: {
    gemini:    q("SELECT COUNT(*) AS n FROM pages WHERE has_gemini=1").n,
    gptVision: q("SELECT COUNT(*) AS n FROM pages WHERE has_gpt_vision=1").n,
    human:     q("SELECT COUNT(*) AS n FROM pages WHERE has_human=1").n,
    ocr:       q("SELECT COUNT(*) AS n FROM pages WHERE has_ocr=1").n,
    pagesWithMultipleSources: q(`
      SELECT COUNT(*) AS n FROM pages
      WHERE (has_gemini + has_gpt_vision + has_human) > 1
    `).n,
  },
  bestSource: {
    human:     q("SELECT COUNT(*) AS n FROM pages WHERE best_source='human'").n,
    gptVision: q("SELECT COUNT(*) AS n FROM pages WHERE best_source='gpt-vision'").n,
    gemini:    q("SELECT COUNT(*) AS n FROM pages WHERE best_source='gemini'").n,
    ocr:       q("SELECT COUNT(*) AS n FROM pages WHERE best_source='ocr'").n,
  },
  contributions: {
    total: q("SELECT COUNT(*) AS n FROM contributions").n,
    contributors: qAll("SELECT handle, COUNT(*) AS pages, SUM(chars) AS chars FROM contributions GROUP BY handle ORDER BY pages DESC").map(r => ({
      handle: r.handle, pages: r.pages, chars: r.chars,
    })),
  },
  runs: {
    last: q("SELECT ts, kind, outcome, duration_ms, note FROM runs ORDER BY id DESC LIMIT 1") || null,
    recent: qAll("SELECT ts, kind, outcome, duration_ms, note FROM runs ORDER BY id DESC LIMIT 10"),
  },
  // The most important number on the dashboard: "what's left"
  gap: {
    uncataloguedRecords: q("SELECT COUNT(*) AS n FROM inventory WHERE is_curated=0").n,
    cataloguedButNoPages: q(`
      SELECT COUNT(*) AS n FROM events e
      WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.event_id = e.id)
    `).n,
    partialOcrNeedsVision: q(`
      SELECT COUNT(DISTINCT p.event_id) AS n FROM pages p
      WHERE p.has_ocr=1 AND p.has_vision=0
    `).n,
  },
  // Cross-source iteration loop: pages with 2+ transcription sources
  // where the agreement score is low enough to warrant human eyes.
  review: {
    pagesNeedingReview: q("SELECT COUNT(*) AS n FROM pages WHERE needs_review=1").n,
    pagesHighConfidence: q("SELECT COUNT(*) AS n FROM pages WHERE confidence='high'").n,
    pagesMediumConfidence: q("SELECT COUNT(*) AS n FROM pages WHERE confidence='medium'").n,
    pagesLowConfidence: q("SELECT COUNT(*) AS n FROM pages WHERE confidence='low'").n,
    topEventsByReviewQueue: qAll(`
      SELECT event_id, COUNT(*) AS n FROM pages WHERE needs_review=1
      GROUP BY event_id ORDER BY n DESC LIMIT 10
    `),
    // Re-evaluation outcomes (from scripts/reevaluate-disputed.mjs)
    reevaluated:               q("SELECT COUNT(*) AS n FROM pages WHERE dispute_kind IS NOT NULL").n,
    resolvedByPromptStandard:  q("SELECT COUNT(*) AS n FROM pages WHERE dispute_kind='prompt-variance'").n,
    pageIntrinsicDisputes:     q("SELECT COUNT(*) AS n FROM pages WHERE dispute_kind='page-intrinsic'").n,
    partialImprovementByReeval:q("SELECT COUNT(*) AS n FROM pages WHERE dispute_kind='partial-improvement'").n,
  },
  // Per-source quality vs human (from scripts/compare-sources.mjs ->
  // data-raw/.source-quality.json). Surfaces "how accurate is each
  // transcription source against human-typed truth?" as a sorted list.
  sourceQuality: await (async () => {
    try {
      const q = JSON.parse(await readFile(path.join(RAW_DIR, ".source-quality.json"), "utf8"));
      return q.summary || {};
    } catch { return {}; }
  })(),
  // Per-event source mix + canonical best, for the NETWORK view's
  // color-by-source encoding and the ATLAS/TIMELINE row badges. Keyed
  // by event_id, lightweight enough to ship in the same JSON.
  byEvent: Object.fromEntries(qAll(`
    SELECT
      event_id,
      COUNT(*)              AS pages,
      SUM(has_gemini)       AS gemini,
      SUM(has_gpt_vision)   AS gptVision,
      SUM(has_human)        AS human,
      SUM(has_ocr)          AS ocr,
      SUM(needs_review)     AS needsReview,
      SUM(CASE WHEN best_source='human'      THEN 1 ELSE 0 END) AS bestHuman,
      SUM(CASE WHEN best_source='gpt-vision' THEN 1 ELSE 0 END) AS bestGptVision,
      SUM(CASE WHEN best_source='gemini'     THEN 1 ELSE 0 END) AS bestGemini,
      SUM(CASE WHEN best_source='ocr'        THEN 1 ELSE 0 END) AS bestOcr,
      SUM(chars)            AS chars
    FROM pages GROUP BY event_id
  `).map(r => {
    // Determine the dominant best_source for the whole event (used as
    // the event node's color in NETWORK).
    const counts = { human: r.bestHuman, "gpt-vision": r.bestGptVision, gemini: r.bestGemini, ocr: r.bestOcr };
    let dominantBest = null, max = 0;
    for (const [k, v] of Object.entries(counts)) if (v > max) { dominantBest = k; max = v; }
    return [r.event_id, {
      pages: r.pages, chars: r.chars,
      sources: Object.entries({ gemini: r.gemini, "gpt-vision": r.gptVision, human: r.human, ocr: r.ocr })
        .filter(([, n]) => n > 0).map(([k]) => k),
      dominantBest,
      needsReview: r.needsReview,
    }];
  })),
};

await mkdir(path.dirname(STATS_OUT), { recursive: true });
const { writeFile } = await import("node:fs/promises");
await writeFile(STATS_OUT, JSON.stringify(stats, null, 2) + "\n", "utf8");

db.close();

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[db] ${DB_PATH}`);
console.log(`[db] inventory ${stats.inventory.total} (${stats.inventory.enumerated} enumerated · ${stats.inventory.placeholders} placeholder)`);
console.log(`[db] events    ${stats.events.catalogued} catalogued · ${stats.events.withVisionPages} with vision pages`);
console.log(`[db] pages     ${stats.pages.totalIndexed} indexed (${stats.pages.vision} vision · ${stats.pages.ocrOnly} ocr-only · ${stats.pages.visualsAnnotated} visuals)`);
console.log(`[db] sources   gemini=${stats.bySource.gemini}  gpt-vision=${stats.bySource.gptVision}  human=${stats.bySource.human}  ocr=${stats.bySource.ocr}  multi=${stats.bySource.pagesWithMultipleSources}`);
console.log(`[db] canonical human=${stats.bestSource.human}  gpt-vision=${stats.bestSource.gptVision}  gemini=${stats.bestSource.gemini}  ocr=${stats.bestSource.ocr}`);
console.log(`[db] chars     ${stats.pages.totalChars.toLocaleString()}`);
console.log(`[db] contribs  ${stats.contributions.total} pages from ${stats.contributions.contributors.length} volunteer(s):`);
for (const c of stats.contributions.contributors) {
  console.log(`               ${c.handle}: ${c.pages} pages, ${c.chars.toLocaleString()} chars`);
}
console.log(`[db] gap       ${stats.gap.uncataloguedRecords} uncatalogued records · ${stats.gap.cataloguedButNoPages} catalogued-no-pages · ${stats.gap.partialOcrNeedsVision} need vision pass`);
console.log(`[db] wrote ${STATS_OUT}`);
console.log(`[db] rebuild took ${elapsed}s`);
