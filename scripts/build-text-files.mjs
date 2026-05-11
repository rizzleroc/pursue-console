// Build per-event full-text files at public/text/<id>.txt.
// Sources:
//   - data-raw/.ocr-cache/<id>/p*.txt  (when OCR has run on a scanned doc)
//   - data-raw/<id>.pdf via pdfjs       (when the PDF has a text layer)
// Writes one .txt per event id; updates a manifest at public/text/manifest.json.
// Safe to re-run any time; idempotent.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(ROOT, "data-raw");
const CACHE_DIR = path.join(RAW_DIR, ".ocr-cache");
const OUT_DIR = path.join(ROOT, "public/text");

const { EVENTS } = await import("../src/data/events.js");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

await mkdir(OUT_DIR, { recursive: true });

async function fromOcrCache(id) {
  const dir = path.join(CACHE_DIR, id);
  if (!existsSync(dir)) return null;
  const files = (await readdir(dir)).filter(f => /^p\d+\.txt$/.test(f)).sort();
  if (!files.length) return null;
  const parts = [];
  for (const f of files) {
    const t = await readFile(path.join(dir, f), "utf8");
    const pageNum = Number(f.match(/^p(\d+)/)[1]);
    parts.push(`\n\n=== Page ${pageNum} ===\n\n${t.trim()}`);
  }
  return { text: parts.join("\n"), source: "ocr", pages: files.length };
}

async function fromPdfText(id) {
  const pdfPath = path.join(RAW_DIR, `${id}.pdf`);
  if (!existsSync(pdfPath)) return null;
  const buf = await readFile(pdfPath);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, disableFontFace: true }).promise;
  const parts = [];
  let totalChars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    try {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const t = tc.items.map(it => it.str || "").join(" ").replace(/\s+/g, " ").trim();
      if (t) parts.push(`\n\n=== Page ${p} ===\n\n${t}`);
      totalChars += t.length;
    } catch {}
  }
  await doc.cleanup(); await doc.destroy();
  if (totalChars < 50) return null;  // empty / scanned — caller will fall back to OCR cache if any
  return { text: parts.join("\n"), source: "pdfjs", pages: doc.numPages };
}

const manifest = {};
let wrote = 0, skipped = 0;

for (const ev of EVENTS) {
  let result = null;
  // Prefer OCR cache when present (only exists if PDF was scanned and OCR'd)
  result = await fromOcrCache(ev.id);
  // Fall back to PDF text layer
  if (!result) result = await fromPdfText(ev.id);

  if (!result) {
    skipped++;
    continue;
  }
  const header = `${ev.title}\n${"=".repeat(ev.title.length)}\n\nAgency: ${ev.agency}\nDate: ${ev.date}\nLocation: ${ev.loc}\nType: ${ev.type}\nSource extraction: ${result.source.toUpperCase()} · ${result.pages} pages\n\n---`;
  const full = header + result.text;
  await writeFile(path.join(OUT_DIR, `${ev.id}.txt`), full, "utf8");
  manifest[ev.id] = { source: result.source, pages: result.pages, chars: full.length };
  wrote++;
  console.log(`  ✓ ${ev.id.padEnd(28)} ${result.source.padEnd(6)} ${result.pages}p ${full.length}c`);
}

await writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 0), "utf8");
console.log(`\n[text-files] wrote ${wrote}, skipped ${skipped} (no PDF or unparseable).`);
