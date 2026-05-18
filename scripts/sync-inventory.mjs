// Pull the real war.gov PDF inventory (~120 rows, 2.3 GB total) from
// DenisSergeevitch/UFO-USA — the upstream maintainer scraped war.gov
// directly. war.gov blocks our IPs via Akamai, so we sync the manifest
// instead of re-scraping.
//
// Writes data-raw/inventory-sync.json with the parsed manifest and a
// per-row reconciliation against EVENTS in src/data/events.js: which
// inventory rows we already have catalogued (matched by URL), which
// we haven't, and which catalogued events have no matching inventory
// row (likely the video/image side of the release).
//
// db-rebuild.mjs reads this file (when present) to populate inventory
// with REAL urls/filenames/bytes instead of placeholder rows.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MANIFEST_URL = "https://raw.githubusercontent.com/DenisSergeevitch/UFO-USA/main/metadata/pdf_manifest.tsv";
const SUMMARY_URL  = "https://raw.githubusercontent.com/DenisSergeevitch/UFO-USA/main/metadata/download_summary.json";
const OUT = path.join(ROOT, "data-raw", "inventory-sync.json");

await mkdir(path.dirname(OUT), { recursive: true });

const t0 = Date.now();

const [tsvRes, sumRes] = await Promise.all([
  fetch(MANIFEST_URL, { signal: AbortSignal.timeout(30_000) }),
  fetch(SUMMARY_URL,  { signal: AbortSignal.timeout(15_000) }),
]);
if (!tsvRes.ok) throw new Error(`manifest fetch failed: ${tsvRes.status}`);
const tsv = await tsvRes.text();
const summary = sumRes.ok ? await sumRes.json() : null;

// Columns: filename, url, source_folder, agency, date, col6, col7
// col6/col7 are usually "N/A" — preserve as `field6`/`field7` for forward
// compatibility in case Denis fills them later.
const rows = [];
for (const line of tsv.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const parts = line.split("\t");
  if (parts.length < 4) continue;
  rows.push({
    filename: parts[0],
    url: parts[1],
    source_folder: parts[2],
    agency: parts[3],
    date_released: parts[4] || null,
    field6: parts[5] || null,
    field7: parts[6] || null,
  });
}

// Reconcile against our EVENTS table by URL (case-insensitive — war.gov
// URLs are sometimes upper, sometimes lower).
const { EVENTS } = await import(`../src/data/events.js?cb=${Date.now()}`);
const eventByUrl = new Map();
for (const ev of EVENTS) {
  if (!ev.url) continue;
  eventByUrl.set(ev.url.toLowerCase(), ev);
}
let matched = 0, unmatched = 0;
for (const r of rows) {
  const ev = eventByUrl.get(r.url.toLowerCase());
  if (ev) { r.event_id = ev.id; matched++; }
  else { r.event_id = null; unmatched++; }
}

const out = {
  generatedAt: new Date().toISOString(),
  source: MANIFEST_URL,
  upstream: summary,
  matched,
  unmatched,
  totalPdfs: rows.length,
  rows,
};
await writeFile(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");

const ms = Date.now() - t0;
console.log(`[inventory-sync] ${rows.length} PDFs from upstream manifest in ${ms}ms`);
console.log(`[inventory-sync] matched ${matched} to existing events, ${unmatched} new (need cataloguing)`);
if (summary) console.log(`[inventory-sync] upstream reports ${summary.downloaded_pdfs}/${summary.manifest_pdf_rows} downloaded, ${summary.total_gib} GiB`);
console.log(`[inventory-sync] wrote ${OUT}`);
