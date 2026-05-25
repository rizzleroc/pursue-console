// Ingest the 6 Release 02 PDFs that sit at public/release_2/ but never
// got transcribed. The existing volunteer + vision-MCP path can't run
// here (no logged-in Chrome on :9222), and Denis's upstream archive only
// mirrors Release 01. This is the local-only fallback: render every
// page with pdftoppm, OCR with tesseract, write per-source caches +
// sidecars, then let the standard build chain (db-rebuild,
// build-media-index, build-search-index) pick them up.
//
// Idempotent. Re-run with FORCE=1 to redo cached pages.
//
// What gets written per R02 event:
//   data-raw/.vision-cache/<eid>/p<NNNN>.ocr.txt        (per-source text)
//   data-raw/.vision-cache/<eid>/p<NNNN>.txt            (canonical pointer)
//   data-raw/.vision-cache/<eid>/p<NNNN>.sources.json   (provenance)
//   data-raw/.visuals/<eid>/p<NNNN>.json                (kind for MEDIA)
//   public/media/<eid>/p<NNNN>.png                      (800px thumbnail)

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RELEASE_2_DIR = path.join(ROOT, "public", "release_2");
const OCR_CACHE = path.join(ROOT, "data-raw", ".ocr-cache");
const VIS_CACHE = path.join(ROOT, "data-raw", ".vision-cache");
const VISUALS_DIR = path.join(ROOT, "data-raw", ".visuals");
const MEDIA_DIR = path.join(ROOT, "public", "media");

const DPI = Number(process.env.DPI || 200);
const THUMB_PX = 800;
const FORCE = process.env.FORCE === "1";

const { EVENTS } = await import("../src/data/events.js");
const R02 = EVENTS.filter(e => e.release === "Release 02" && e.url && e.url.includes("release_2"));

// Per-file kind hint. DOE-UAP-D001 is the only one that's actually a
// photograph (its filename says "_Image"); the rest are scanned typed
// correspondence/reports — the existing classifier labels those
// "photocopied-negative" by convention (see build-media-index curate()).
function kindFor(eid, filename) {
  const lower = filename.toLowerCase();
  if (/image|photo|pantex/.test(lower)) return "photograph";
  return "photocopied-negative";
}

async function pageCount(pdfPath) {
  const { stdout } = await execFileP("pdfinfo", [pdfPath], { windowsHide: true });
  const m = stdout.match(/Pages:\s+(\d+)/);
  return m ? Number(m[1]) : 0;
}

async function renderPage(pdfPath, pageNum, outPath) {
  // First render at DPI to a temp PNG, then ImageMagick-style resize via
  // pdftoppm's -scale-to flag would also work, but the simplest path is
  // pdftoppm directly with -scale-to-x for the thumbnail max-edge.
  const tmpBase = path.join(tmpdir(), `r02-${randomBytes(4).toString("hex")}`);
  await execFileP("pdftoppm", [
    "-r", String(DPI),
    "-f", String(pageNum), "-l", String(pageNum),
    "-png",
    "-scale-to", String(THUMB_PX),
    pdfPath, tmpBase,
  ], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const dir = path.dirname(tmpBase);
  const prefix = path.basename(tmpBase);
  const f = (await readdir(dir)).find(name => name.startsWith(prefix) && name.endsWith(".png"));
  if (!f) throw new Error("pdftoppm produced no PNG");
  const tmpPng = path.join(dir, f);
  await execFileP("cp", [tmpPng, outPath], { windowsHide: true });
  return tmpPng;
}

async function unlink(p) {
  try { await (await import("node:fs/promises")).unlink(p); } catch {}
}

if (!R02.length) {
  console.log("[r02-ingest] no Release 02 events with release_2 URLs in events.js — nothing to do.");
  process.exit(0);
}

console.log(`[r02-ingest] ${R02.length} R02 events targeted, DPI=${DPI}, FORCE=${FORCE}`);

// Use the system `tesseract` binary. tesseract.js wants to fetch
// eng.traineddata from a CDN at runtime which the egress allowlist
// blocks; the apt-installed binary ships its own traineddata.
async function ocrPng(pngPath) {
  const { stdout } = await execFileP("tesseract", [pngPath, "stdout", "-l", "eng"], {
    windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  return (stdout || "").trim();
}

const t0 = Date.now();
let pagesDone = 0, pagesSkipped = 0;

for (const ev of R02) {
  const filename = ev.url.split("/").pop();
  const pdfPath = path.join(RELEASE_2_DIR, filename);
  if (!existsSync(pdfPath)) { console.log(`  · ${ev.id} — PDF missing at ${pdfPath}`); continue; }
  const pp = await pageCount(pdfPath);
  console.log(`  · ${ev.id} (${filename}) — ${pp} pages`);

  // Canonical OCR text lives in .ocr-cache (db-rebuild flags .vision-cache
  // p<NNNN>.txt as has_vision=1, which would mislabel these tesseract-only
  // pages as having gpt-vision coverage). Provenance sidecar stays in
  // .vision-cache so the existing multi-source machinery can find it.
  const ocrDir     = path.join(OCR_CACHE, ev.id);
  const cacheDir   = path.join(VIS_CACHE, ev.id);
  const visualsDir = path.join(VISUALS_DIR, ev.id);
  const mediaDir   = path.join(MEDIA_DIR, ev.id);
  await mkdir(ocrDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await mkdir(visualsDir, { recursive: true });
  await mkdir(mediaDir, { recursive: true });

  const kind = kindFor(ev.id, filename);
  const nowIso = new Date().toISOString();

  for (let p = 1; p <= pp; p++) {
    const tag = `p${String(p).padStart(4, "0")}`;
    const thumbPath    = path.join(mediaDir,   `${tag}.png`);
    const canonOcrPath = path.join(ocrDir,     `${tag}.txt`);
    const perSrcPath   = path.join(cacheDir,   `${tag}.ocr.txt`);
    const sidecarPath  = path.join(cacheDir,   `${tag}.sources.json`);
    const visualPath   = path.join(visualsDir, `${tag}.json`);

    if (!FORCE && existsSync(canonOcrPath) && existsSync(thumbPath) && existsSync(sidecarPath) && existsSync(visualPath)) {
      pagesSkipped++;
      continue;
    }

    let tmp = null;
    try {
      tmp = await renderPage(pdfPath, p, thumbPath);
      const text = await ocrPng(thumbPath);
      await writeFile(canonOcrPath, text, "utf8");
      await writeFile(perSrcPath, text, "utf8");
      await writeFile(sidecarPath, JSON.stringify({
        best: "ocr",
        sources: {
          ocr: {
            chars: text.length,
            imported_at: nowIso,
            note: "tesseract eng @ 200dpi via ingest-release-02-pdfs.mjs",
            text_file: `${tag}.ocr.txt`,
          },
        },
        comparison: {
          computed_at: nowIso,
          method: "single-source",
          sources_count: 1,
          canonical: "ocr",
          agreement_score: null,
          pairs: [],
          confidence: "low",
          needs_review: false,
        },
      }, null, 2) + "\n", "utf8");
      await writeFile(visualPath, JSON.stringify({
        kind,
        title: `${ev.title} · page ${p}`,
        description: text.slice(0, 200).replace(/\s+/g, " ").trim(),
        classifiedAt: nowIso,
        classifier: "ingest-release-02-pdfs (filename-heuristic)",
      }, null, 2) + "\n", "utf8");
      pagesDone++;
      process.stdout.write(`    ${tag} ocr ${text.length}c kind=${kind}                \r`);
    } catch (e) {
      console.log(`\n    ${tag} ERR ${e.message.slice(0, 80)}`);
    } finally {
      if (tmp) await unlink(tmp);
    }
  }
  process.stdout.write(`\n`);
}

const dt = ((Date.now() - t0) / 60000).toFixed(1);
console.log(`[r02-ingest] done. ${pagesDone} pages ingested, ${pagesSkipped} cached, ${dt}m`);
