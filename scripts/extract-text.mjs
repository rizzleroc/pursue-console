// Extract text from each PDF in data-raw/. Writes src/data/corpus.json.
// Strategy: pdfjs-dist only (fast, works on text-layer PDFs). Scanned
// PDFs that yield little/no text are left for the dedicated OCR scripts —
// run scripts/ocr-scanned.mjs (tesseract) or scripts/vision-ocr.mjs
// (ChatGPT vision) on those, then re-aggregate.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(ROOT, "data-raw");
const OUT = path.join(ROOT, "src/data/corpus.json");

// Use legacy build of pdfjs (no DOMMatrix/canvas requirement for text-only).
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const { EVENTS } = await import("../src/data/events.js");

const STOP = new Set(`a about above after again against all am an and any are as at be because been before being below between both but by can did do does doing don down during each few for from further had has have having he her here hers him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves
also one two three four five would could should may might shall must one any all every some thing things page pages document documents report reports memo memos via from etc inc co llc llp eg ie cf vs vs.`.split(/\s+/));

const tokenize = (text) => {
  // lowercase, split on non-letter except apostrophes/hyphens, drop short/long/digits-only/stop
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\-\s]/g, " ")
    .split(/\s+/)
    .map(w => w.replace(/^['-]+|['-]+$/g, ""))
    .filter(w => w.length >= 3 && w.length <= 30 && !/^\d+$/.test(w) && !STOP.has(w));
};

async function extractPdfText(buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, disableFontFace: true }).promise;
  let text = "";
  let pages = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    try {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const t = tc.items.map(it => it.str || "").join(" ");
      text += " " + t;
      pages++;
    } catch (e) {
      // skip bad page
    }
  }
  await doc.cleanup();
  await doc.destroy();
  return { text: text.trim(), pages };
}

const files = (await readdir(RAW_DIR)).filter(f => f.toLowerCase().endsWith(".pdf"));
console.log(`[extract] ${files.length} PDFs in data-raw/`);

const eventById = Object.fromEntries(EVENTS.map(e => [e.id, e]));
const perEvent = {};      // eventId -> { pages, charCount, terms: {word: count}, sample: "first 800 chars"}
const globalTerms = {};   // word -> totalCount across all events
const byTerm = {};        // word -> Set<eventId>
let processed = 0, failed = 0;

for (const file of files) {
  const id = file.replace(/\.[^.]+$/, "");
  if (!eventById[id]) { console.log(`  ? skip (no event): ${file}`); continue; }
  try {
    const buf = await readFile(path.join(RAW_DIR, file));
    const { text, pages } = await extractPdfText(buf);
    const tokens = tokenize(text);
    const terms = {};
    for (const t of tokens) terms[t] = (terms[t] || 0) + 1;

    perEvent[id] = {
      pages,
      charCount: text.length,
      terms,
      sample: text.slice(0, 800).replace(/\s+/g, " ").trim(),
    };
    for (const [w, c] of Object.entries(terms)) {
      globalTerms[w] = (globalTerms[w] || 0) + c;
      (byTerm[w] = byTerm[w] || []).push(id);
    }
    processed++;
    console.log(`  ✓ ${id.padEnd(28)} pages=${pages} chars=${text.length} terms=${Object.keys(terms).length}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${id.padEnd(28)} ${e.message}`);
  }
}

// Filter global terms: appear in >=2 events OR count >=4 in single event. Keep top 1500 by count.
const filtered = Object.entries(globalTerms)
  .filter(([w, c]) => (byTerm[w]?.length || 0) >= 2 || c >= 4)
  .sort((a,b) => b[1] - a[1])
  .slice(0, 1500);
const keepSet = new Set(filtered.map(([w]) => w));

// Trim per-event term maps to kept set
for (const id of Object.keys(perEvent)) {
  const t = perEvent[id].terms;
  perEvent[id].terms = Object.fromEntries(Object.entries(t).filter(([w]) => keepSet.has(w)));
}
// Trim byTerm to kept set, dedupe arrays
const byTermClean = {};
for (const [w, ids] of Object.entries(byTerm)) {
  if (!keepSet.has(w)) continue;
  byTermClean[w] = [...new Set(ids)];
}
const globalClean = Object.fromEntries(filtered);

const corpus = {
  generatedAt: new Date().toISOString(),
  stats: { eventsProcessed: processed, eventsFailed: failed, uniqueTerms: keepSet.size, missingPdfs: EVENTS.length - processed },
  byEvent: perEvent,
  globalTerms: globalClean,
  byTerm: byTermClean,
};

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(corpus, null, 0));
console.log(`\n[extract] wrote ${OUT} — events=${processed} failed=${failed} terms=${keepSet.size}`);
