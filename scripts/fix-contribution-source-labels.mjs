// One-time correctness fix:
//
// The volunteer flow runs ChatGPT vision on rendered page images on the
// volunteer's own machine. The resulting transcripts are STILL machine
// OCR — they just happen to flow through a volunteer's PR. They are
// NOT human-typed transcriptions, but the importer was labeling them
// `source: "human"`. That poisoned the cross-source agreement gold
// signal (Gemini "vs human" was really Gemini vs ChatGPT-vision).
//
// This script:
//   1. Moves contributions/<handle>/<eid>/  →  contributions/<handle>/gpt-vision/<eid>/
//      (the volunteer flow's actual source)
//   2. Rewrites every affected sidecar in data-raw/.vision-cache/:
//        - rename sources.human → sources["gpt-vision"]
//        - if best="human", recompute best
//        - rename p<NNN>.human.txt → p<NNN>.gpt-vision.txt
//        - drop comparison.against_human entries (the gold was fake)
//   3. Updates data-raw/.contributions-manifest.json handles → handle+source
//   4. Wipes data-raw/.source-quality.json (it's quality-vs-gpt-vision,
//      not quality-vs-human; let it regen empty until real hand-typed
//      contributions land)
//
// Idempotent. Safe to re-run.

import { readFile, writeFile, readdir, rename, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONTRIB = path.join(ROOT, "contributions");
const VIS = path.join(ROOT, "data-raw", ".vision-cache");
const MANIFEST = path.join(ROOT, "data-raw", ".contributions-manifest.json");
const QUALITY = path.join(ROOT, "data-raw", ".source-quality.json");

// Known source folders that should NOT be migrated (they're already in
// the new <handle>/<source>/<eid>/ shape, or are tooling dirs).
const KNOWN_SOURCES = new Set(["human", "gpt-vision", "gemini", "ocr", "pdfjs"]);

async function listDirs(p) {
  try { return (await readdir(p, { withFileTypes: true })).filter(d => d.isDirectory()); }
  catch { return []; }
}

// =====================================================================
// 1. Migrate contributions/<handle>/<eid>/ → <handle>/gpt-vision/<eid>/
// =====================================================================
let migratedDirs = 0;
for (const handleEnt of await listDirs(CONTRIB)) {
  const hDir = path.join(CONTRIB, handleEnt.name);
  for (const child of await listDirs(hDir)) {
    if (KNOWN_SOURCES.has(child.name)) continue;   // already source-tagged
    const eid = child.name;
    const oldDir = path.join(hDir, eid);
    const newParent = path.join(hDir, "gpt-vision");
    const newDir = path.join(newParent, eid);
    await mkdir(newParent, { recursive: true });
    if (existsSync(newDir)) {
      // Merge: copy files over, drop oldDir
      for (const f of await readdir(oldDir)) {
        const src = path.join(oldDir, f);
        const dst = path.join(newDir, f);
        if (!existsSync(dst)) await rename(src, dst);
      }
      await rm(oldDir, { recursive: true, force: true });
    } else {
      await rename(oldDir, newDir);
    }
    migratedDirs++;
  }
}
console.log(`[fix] migrated ${migratedDirs} contribution event-folders → <handle>/gpt-vision/`);

// =====================================================================
// 2. Rewrite sidecars in .vision-cache: human → gpt-vision
// =====================================================================
let sidecarsRewritten = 0, filesRenamed = 0, bestRecomputed = 0;
const SOURCE_RANK = ["human", "gpt-vision", "gemini", "ocr"];   // ties broken by rank order

function pickBest(sources) {
  const present = Object.keys(sources).filter(k => sources[k]?.chars > 0);
  if (!present.length) return null;
  // Longest text wins; ties broken by rank.
  present.sort((a, b) => {
    const da = sources[a].chars || 0, db = sources[b].chars || 0;
    if (db !== da) return db - da;
    return SOURCE_RANK.indexOf(a) - SOURCE_RANK.indexOf(b);
  });
  return present[0];
}

for (const eidEnt of await listDirs(VIS)) {
  const dir = path.join(VIS, eidEnt.name);
  for (const f of await readdir(dir)) {
    const m = f.match(/^p(\d+)\.sources\.json$/);
    if (!m) continue;
    const sidecarPath = path.join(dir, f);
    let sc;
    try { sc = JSON.parse(await readFile(sidecarPath, "utf8")); } catch { continue; }
    if (!sc.sources?.human) continue;

    const pad4 = m[1];
    const humanInfo = sc.sources.human;
    const humanTxt = path.join(dir, `p${pad4}.human.txt`);
    const gptTxt   = path.join(dir, `p${pad4}.gpt-vision.txt`);

    // Move text file: human.txt → gpt-vision.txt. If gpt-vision.txt
    // already exists (e.g. seeded earlier), the human one was likely
    // the same content from a re-import; just drop it.
    if (existsSync(humanTxt)) {
      if (existsSync(gptTxt)) {
        await rm(humanTxt);
      } else {
        await rename(humanTxt, gptTxt);
        filesRenamed++;
      }
    }

    // Rewrite sidecar source entry
    sc.sources["gpt-vision"] = {
      ...humanInfo,
      text_file: `p${pad4}.gpt-vision.txt`,
      // preserve `handle` so contributor credit is still tracked
    };
    delete sc.sources.human;
    if (sc.best === "human") {
      sc.best = pickBest(sc.sources);
      bestRecomputed++;
    }

    // Drop the fake against_human entries — they were vs gpt-vision
    if (sc.comparison?.against_human) delete sc.comparison.against_human;

    await writeFile(sidecarPath, JSON.stringify(sc, null, 2) + "\n", "utf8");
    sidecarsRewritten++;
  }
}
console.log(`[fix] rewrote ${sidecarsRewritten} sidecars · renamed ${filesRenamed} per-source files · recomputed ${bestRecomputed} best-source picks`);

// =====================================================================
// 3. Update contributions manifest: add source field
// =====================================================================
if (existsSync(MANIFEST)) {
  const m = JSON.parse(await readFile(MANIFEST, "utf8"));
  let touched = 0;
  for (const [key, val] of Object.entries(m)) {
    if (val.source) continue;
    val.source = "gpt-vision";   // every existing contribution was volunteer-flow / ChatGPT
    touched++;
  }
  await writeFile(MANIFEST, JSON.stringify(m, null, 2) + "\n", "utf8");
  console.log(`[fix] manifest: tagged ${touched} legacy entries with source="gpt-vision"`);
}

// =====================================================================
// 4. Wipe source-quality.json — it was scoring vs ChatGPT-vision, not
//    vs human. Let it regenerate empty until real hand-typed
//    contributions land.
// =====================================================================
if (existsSync(QUALITY)) {
  await rm(QUALITY);
  console.log(`[fix] wiped .source-quality.json (vs-human gold was fake — no human-typed pages yet)`);
}

console.log(`[fix] done. Re-run: node scripts/compare-sources.mjs && node scripts/db-rebuild.mjs && node scripts/export-review-queue.mjs`);
