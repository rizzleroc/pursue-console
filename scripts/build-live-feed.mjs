// Build public/live-feed.json — a chronological stream of every page
// successfully transcribed, derived from data-raw/.vision-cache/ and
// data-raw/.ocr-cache/ file mtimes.
//
// The LIVE view in the app fetches this and shows "what we just decoded"
// as a ticker — a transparency layer over the corpus pipeline.
//
// One entry per (eventId, page, source) tuple. Sorted by mtime desc.
// Snippet = first 280 chars, whitespace-collapsed.

import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VIS = path.join(ROOT, "data-raw/.vision-cache");
const OCR = path.join(ROOT, "data-raw/.ocr-cache");
const OUT = path.join(ROOT, "public/live-feed.json");

const MAX_ENTRIES = Number(process.env.MAX_FEED || 200);
const MIN_CHARS   = Number(process.env.MIN_CHARS || 30);

const { EVENTS } = await import("../src/data/events.js");
const eventById = Object.fromEntries(EVENTS.map(e => [e.id, e]));

const entries = [];

async function scanCache(root, source) {
  if (!existsSync(root)) return;
  for (const eid of await readdir(root)) {
    const dir = path.join(root, eid);
    let stEid;
    try { stEid = await stat(dir); } catch { continue; }
    if (!stEid.isDirectory()) continue;
    const ev = eventById[eid];
    for (const f of await readdir(dir)) {
      if (!/^p\d+\.txt$/.test(f)) continue;
      const fp = path.join(dir, f);
      let st, txt;
      try { st = await stat(fp); txt = await readFile(fp, "utf8"); }
      catch { continue; }
      const trimmed = txt.trim();
      if (trimmed.length < MIN_CHARS) continue;
      const page = Number(f.match(/^p(\d+)/)[1]);
      const snippet = trimmed.slice(0, 280).replace(/\s+/g, " ").trim();
      entries.push({
        eventId: eid,
        title: ev?.title || eid,
        agency: ev?.agency || null,
        date: ev?.date || null,
        page,
        source,                              // "vision" | "ocr"
        chars: trimmed.length,
        modifiedAt: st.mtimeMs,
        snippet,
      });
    }
  }
}

await scanCache(VIS, "vision");
await scanCache(OCR, "ocr");

// If both a vision and OCR page exist for the same (eid, page), prefer vision.
const byKey = new Map();
for (const e of entries) {
  const k = `${e.eventId}-${e.page}`;
  const prev = byKey.get(k);
  if (!prev || (e.source === "vision" && prev.source !== "vision")) byKey.set(k, e);
}
const merged = [...byKey.values()].sort((a, b) => b.modifiedAt - a.modifiedAt);

// Aggregate stats — what's in the corpus right now
const stats = {
  byEvent: {},
  bySource: { vision: 0, ocr: 0 },
  totalPages: merged.length,
  totalChars: 0,
};
for (const e of merged) {
  stats.bySource[e.source] = (stats.bySource[e.source] || 0) + 1;
  stats.totalChars += e.chars;
  const b = stats.byEvent[e.eventId] || { vision: 0, ocr: 0, chars: 0 };
  b[e.source]++;
  b.chars += e.chars;
  stats.byEvent[e.eventId] = b;
}

const feed = merged.slice(0, MAX_ENTRIES);
const out = {
  generatedAt: new Date().toISOString(),
  count: feed.length,
  stats,
  entries: feed,
};

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out));
console.log(`[live-feed] wrote ${OUT} — ${feed.length} entries (${stats.bySource.vision} vision · ${stats.bySource.ocr} ocr)  total chars=${stats.totalChars.toLocaleString()}`);
