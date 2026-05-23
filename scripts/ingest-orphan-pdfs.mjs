// Ingest orphan PDFs: catalogue PDFs sitting at the repo root that nobody added
// to events.js, so they enter the OCR queue.
//
// Why this exists: data drops sometimes commit PDFs (e.g. release-02's
// DOW-UAP-D017_Sandia.pdf, CIA-UAP-D001_*.pdf, …) at the repo root without an
// events-auto.js entry or a public/text/manifest.json record. build-text-files
// and build-work-available BOTH iterate from events.js + manifest, so an
// uncatalogued PDF is invisible to the pipeline and the OCR queue never lists
// its pages. This script closes that loop:
//
//   for each PDF arg (or each top-level *.pdf if --scan):
//     • derive an event id (kebab-case from filename)
//     • derive an agency from the filename prefix (CIA/DOE/DOW/ODNI/…)
//     • open with pdfjs to count pages
//     • print the proposed events-auto.js entry + the manifest.json patch
//     • with --apply: copy the PDF to data-raw/<id>.pdf, append the entry to
//       events-auto.js, and merge the patch into public/text/manifest.json
//
// Usage:
//   node scripts/ingest-orphan-pdfs.mjs --scan                          # dry run
//   node scripts/ingest-orphan-pdfs.mjs file1.pdf file2.pdf             # dry run, named files
//   node scripts/ingest-orphan-pdfs.mjs --scan --apply                  # actually write
//
// After --apply: run `node scripts/build-text-files.mjs && node scripts/build-work-available.mjs`
// to (re)build the manifest text + the work queue so the new pages appear in
// `public/work-available.json` and the dashboard's OCR queue picks them up.

import { readFile, writeFile, readdir, copyFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPdfjsAssetUrls } from "./lib/pdfjs-assets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(ROOT, "data-raw");
const EVENTS_AUTO = path.join(ROOT, "src/data/events-auto.js");
const MANIFEST = path.join(ROOT, "public/text/manifest.json");

const args = new Set(process.argv.slice(2));
const APPLY = args.delete("--apply");
const SCAN = args.delete("--scan");
let pdfPaths = [...args].filter(a => a.endsWith(".pdf"));
if (SCAN) {
  // top-level *.pdf — the documented "orphan" location for new drops
  const top = await readdir(ROOT);
  for (const f of top) if (f.endsWith(".pdf")) pdfPaths.push(path.join(ROOT, f));
}
if (!pdfPaths.length) {
  console.error("usage: node scripts/ingest-orphan-pdfs.mjs [--scan] [file1.pdf file2.pdf ...] [--apply]");
  process.exit(1);
}

// filename → kebab-case id, e.g. "DOW-UAP-D017_General_Correspondence_Of_Sandia.pdf"
// becomes "dow-uap-d017-general-correspondence-of-sandia".
function deriveId(filename) {
  return filename
    .replace(/\.pdf$/i, "")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Agency from filename prefix. Falls through to "Other".
const AGENCY_PREFIX = {
  CIA: "CIA",
  FBI: "FBI",
  DOE: "Department of Energy",
  DOW: "Department of War",
  NSA: "NSA",
  ODNI: "ODNI",
  NASA: "NASA",
};
function deriveAgency(filename) {
  const p = filename.split(/[-_]/)[0].toUpperCase();
  return AGENCY_PREFIX[p] || "Other";
}

// Open the PDF and return its page count (pdfjs).
const { wasmUrl: PDFJS_WASM, standardFontDataUrl: PDFJS_FONTS } = getPdfjsAssetUrls();
let _pdfjs = null;
async function pageCount(absPath) {
  if (!_pdfjs) _pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const buf = await readFile(absPath);
  const doc = await _pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false, disableFontFace: true, useWorkerFetch: false,
    wasmUrl: PDFJS_WASM, standardFontDataUrl: PDFJS_FONTS,
  }).promise;
  return doc.numPages;
}

// Build the events-auto.js entry shape used elsewhere in the file (page_count,
// agency, type=Document, flag=low, auto:true). url is the on-disk filename so
// existing fetch/download logic can find it under data-raw/<id>.pdf.
function makeEventEntry({ id, title, agency, url, pages }) {
  return {
    id, title,
    date: null, sort: 99999999, era: null,
    loc: "Unknown", region: "—", coords: [0, 0],
    agency, type: "Document", flag: "low", auto: true,
    summary: `Auto-ingested orphan PDF (${pages} pages). Awaiting human curation of date, location, and summary.`,
    url, tags: ["auto-imported", "orphan-pdf", agency.split(" ")[0]],
    page_count: pages,
  };
}

const proposed = [];
for (const pdfPath of pdfPaths) {
  const filename = path.basename(pdfPath);
  const id = deriveId(filename);
  const agency = deriveAgency(filename);
  // human-readable title from filename: replace separators with spaces, strip ext.
  const title = filename.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
  let pages;
  try { pages = await pageCount(pdfPath); }
  catch (e) { console.error(`  ✗ ${filename}: cannot count pages — ${e.message.slice(0, 120)}`); continue; }
  proposed.push({ pdfPath, filename, id, agency, title, pages });
  const entry = makeEventEntry({ id, title, agency, url: filename, pages });
  console.log(`\n── ${filename} ─────────────────────────────────────────────`);
  console.log(`  id:      ${id}`);
  console.log(`  agency:  ${agency}`);
  console.log(`  pages:   ${pages}`);
  console.log(`  → would copy to:  data-raw/${id}.pdf`);
  console.log(`  → would append to src/data/events-auto.js:`);
  console.log("    " + JSON.stringify(entry));
  console.log(`  → would patch public/text/manifest.json with:`);
  console.log(`    "${id}": { "source": "ocr", "pages": ${pages}, "chars": 0 }`);
}

console.log(`\n${proposed.length} PDF(s) ready to ingest.`);
if (!APPLY) {
  console.log("DRY RUN — re-run with --apply to actually write changes.");
  process.exit(0);
}

// ----- APPLY -----
await mkdir(RAW_DIR, { recursive: true });
// 1) copy each PDF to data-raw/<id>.pdf
for (const p of proposed) {
  const dst = path.join(RAW_DIR, `${p.id}.pdf`);
  await copyFile(p.pdfPath, dst);
  console.log(`  ✓ copied ${p.filename} → ${path.relative(ROOT, dst)}`);
}
// 2) append entries to events-auto.js. We don't try to parse the JS array; we
// append before the trailing `];` so the file stays valid. Comment marks the
// insertion so the maintainer can find/curate later.
const eventsSrc = await readFile(EVENTS_AUTO, "utf8");
const closeIdx = eventsSrc.lastIndexOf("];");
if (closeIdx < 0) { console.error("error: events-auto.js doesn't end with `];` — refusing to append"); process.exit(1); }
const insertion = proposed.map(p => `  ${JSON.stringify(makeEventEntry({ id: p.id, title: p.title, agency: p.agency, url: p.filename, pages: p.pages }))},  // orphan-ingest`).join("\n");
const newEventsSrc = eventsSrc.slice(0, closeIdx) + "\n  // ----- orphan-ingest " + new Date().toISOString() + " -----\n" + insertion + "\n" + eventsSrc.slice(closeIdx);
await writeFile(EVENTS_AUTO, newEventsSrc, "utf8");
console.log(`  ✓ appended ${proposed.length} entries to ${path.relative(ROOT, EVENTS_AUTO)}`);
// 3) patch manifest.json with stub OCR entries so build-work-available picks them up
const manifest = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, "utf8")) : {};
for (const p of proposed) manifest[p.id] = manifest[p.id] || { source: "ocr", pages: p.pages, chars: 0 };
await mkdir(path.dirname(MANIFEST), { recursive: true });
await writeFile(MANIFEST, JSON.stringify(manifest, null, 0), "utf8");
console.log(`  ✓ patched ${path.relative(ROOT, MANIFEST)} with ${proposed.length} stub entries`);
console.log(`\nNext: node scripts/build-text-files.mjs && node scripts/build-work-available.mjs`);
console.log(`Then commit + redeploy so the dashboard's OCR queue includes the new docs.`);
