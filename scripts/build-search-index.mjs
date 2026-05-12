// Pre-build a MiniSearch index over every public/text/<id>.txt
// plus the curated metadata (title, summary, tags, agency, location).
// Output: public/search-index.json — loaded once by the Search view.
//
// Document granularity: one doc per *page* of each event's extracted
// PDF, so phrase hits highlight to a specific page in Reading Mode.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MiniSearch from "minisearch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TEXT_DIR = path.join(ROOT, "public/text");
const OUT = path.join(ROOT, "public/search-index.json");

const { EVENTS } = await import("../src/data/events.js");
const eventById = Object.fromEntries(EVENTS.map(e => [e.id, e]));

// Split a per-doc text dump into { pageNum, body } chunks using our
// "=== Page N ===" markers. If no markers, treat the whole thing as page 0.
function pagesOf(text) {
  if (!/=== Page \d+ ===/.test(text)) return [{ page: 0, body: text }];
  const parts = text.split(/=== Page (\d+) ===/g);
  // parts: [pre, "1", body, "2", body, ...]
  const out = [];
  for (let i = 1; i < parts.length; i += 2) {
    const page = Number(parts[i]);
    const body = (parts[i + 1] || "").trim();
    if (body.length >= 4) out.push({ page, body });
  }
  return out;
}

const documents = [];
let nextId = 1;

// 1) One synthetic "metadata" doc per event — title + summary + tags
for (const ev of EVENTS) {
  documents.push({
    id: nextId++,
    eventId: ev.id,
    page: 0,
    kind: "meta",
    title: ev.title,
    body: [ev.summary, (ev.tags || []).join(" "), ev.loc, ev.region, ev.agency, ev.type].filter(Boolean).join(" \n "),
    agency: ev.agency,
    date: ev.date,
    flag: ev.flag,
  });
}

// 2) One per page across the .txt files
const files = (await readdir(TEXT_DIR).catch(() => [])).filter(f => f.endsWith(".txt"));
let totalPages = 0;
for (const file of files) {
  const id = file.replace(/\.txt$/, "");
  const ev = eventById[id];
  if (!ev) continue;
  const raw = await readFile(path.join(TEXT_DIR, file), "utf8");
  // strip the header we wrote in build-text-files
  const trimmed = raw.includes("\n---\n") ? raw.split("\n---\n").slice(1).join("\n---\n") : raw;
  const pages = pagesOf(trimmed);
  for (const { page, body } of pages) {
    documents.push({
      id: nextId++,
      eventId: ev.id,
      page,
      kind: "page",
      title: ev.title,
      body,
      agency: ev.agency,
      date: ev.date,
      flag: ev.flag,
    });
    totalPages++;
  }
}

const mini = new MiniSearch({
  fields: ["title", "body", "agency"],
  storeFields: ["eventId", "page", "kind", "title", "agency", "date", "flag", "body"],
  searchOptions: {
    boost: { title: 3, body: 1 },
    prefix: true,
    fuzzy: 0.15,
  },
  // Slightly stricter tokenizer: keep alphanumerics + apostrophes
  tokenize: (s) => s.toLowerCase().split(/[^a-z0-9']+/).filter(t => t.length >= 2 && t.length <= 30),
});
mini.addAll(documents);

const json = mini.toJSON();
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(json));
const sz = (Buffer.byteLength(JSON.stringify(json)) / 1024).toFixed(0);
console.log(`[search-index] ${documents.length} docs (${EVENTS.length} meta + ${totalPages} pages), ${sz} KB → public/search-index.json`);
