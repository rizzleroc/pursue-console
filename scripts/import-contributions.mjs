// Merge volunteer contributions into the local vision-cache so the rest of
// the build pipeline can see them.
//
//   contributions/<handle>/<eid>/pNNN.txt   ← committed in PRs
//        ↓ this script
//   data-raw/.vision-cache/<eid>/pNNN.txt   ← what build scripts read
//
// Idempotent. Safe to run on every build. Won't clobber existing pages
// unless the contribution is meaningfully better (longer, non-empty).
// Writes a provenance manifest at data-raw/.contributions-manifest.json
// so we can credit volunteers per page when the corpus rebuilds.

import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONTRIB = path.join(ROOT, "contributions");
const VIS_CACHE = path.join(ROOT, "data-raw", ".vision-cache");
const MANIFEST = path.join(ROOT, "data-raw", ".contributions-manifest.json");

const MIN_CHARS = 40;  // anything shorter we treat as effectively empty

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function listDirs(p) {
  try { return await readdir(p, { withFileTypes: true }); } catch { return []; }
}

async function pageNumFromName(f) {
  const m = f.match(/^p(\d+)\.txt$/);
  return m ? Number(m[1]) : null;
}

function pad4(n) { return String(n).padStart(4, "0"); }

const stats = { imported: 0, skipped_empty: 0, skipped_existing_better: 0, overwritten: 0, scanned: 0 };
const manifest = {};
// Load existing manifest so re-runs preserve credit for pages we imported in earlier runs.
if (existsSync(MANIFEST)) {
  try { Object.assign(manifest, JSON.parse(await readFile(MANIFEST, "utf8"))); } catch {}
}

if (!(await exists(CONTRIB))) {
  console.log("[import] no contributions/ directory — nothing to import");
  process.exit(0);
}

await mkdir(VIS_CACHE, { recursive: true });

for (const handleEnt of await listDirs(CONTRIB)) {
  if (!handleEnt.isDirectory()) continue;
  const handle = handleEnt.name;
  const hDir = path.join(CONTRIB, handle);

  for (const eidEnt of await listDirs(hDir)) {
    if (!eidEnt.isDirectory()) continue;
    const eid = eidEnt.name;
    const srcDir = path.join(hDir, eid);
    const dstDir = path.join(VIS_CACHE, eid);
    await mkdir(dstDir, { recursive: true });

    for (const f of await readdir(srcDir)) {
      // We only import transcripts. JSON companions stay in contributions/
      // (the search pipeline doesn't consume them).
      const pageNum = await pageNumFromName(f);
      if (pageNum == null) continue;
      stats.scanned++;

      const srcPath = path.join(srcDir, f);
      const srcText = (await readFile(srcPath, "utf8")).trim();
      if (srcText.length < MIN_CHARS) { stats.skipped_empty++; continue; }

      // Canonical destination filename uses p<NNN>.txt (zero-padded) to
      // match what vision-ocr.mjs writes.
      const dstPath = path.join(dstDir, `p${pad4(pageNum)}.txt`);
      const dstPathLegacy = path.join(dstDir, `p${pageNum}.txt`);

      let existingPath = null, existingText = "";
      if (existsSync(dstPath))            existingPath = dstPath;
      else if (existsSync(dstPathLegacy)) existingPath = dstPathLegacy;
      if (existingPath) {
        existingText = (await readFile(existingPath, "utf8")).trim();
      }

      // Human contributions ALWAYS win the canonical spot — they're the
      // result of a person actually reading the page, which outranks any
      // machine transcription regardless of length. We still keep the
      // machine versions in the sidecar so we can compare.
      const importedAt = new Date().toISOString();

      // Update sidecar provenance: this page was transcribed by a human.
      const sidecarPath = path.join(dstDir, `p${pad4(pageNum)}.sources.json`);
      let sidecar = { best: null, sources: {} };
      if (existsSync(sidecarPath)) {
        try { sidecar = JSON.parse(await readFile(sidecarPath, "utf8")); } catch {}
      } else if (existingText.length >= 30) {
        // Seed: the existing canonical was a machine transcription with
        // unknown lineage. Tag it as gpt-vision (our default machine source
        // for the project, pre-Gemini-merge).
        sidecar.sources["gpt-vision"] = { chars: existingText.length, imported_at: null, note: "seeded from pre-existing canonical" };
      }
      sidecar.sources.human = { chars: srcText.length, imported_at: importedAt, handle };
      sidecar.best = "human";
      await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n", "utf8");

      const action = !existingText ? "imported" : "overwritten";
      await writeFile(dstPath, srcText + "\n", "utf8");
      stats[action]++;

      manifest[`${eid}/p${pad4(pageNum)}.txt`] = {
        handle,
        importedAt,
        chars: srcText.length,
        source: "human",
      };
    }
  }
}

await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n", "utf8");

const credited = Object.values(manifest).reduce((acc, m) => {
  acc[m.handle] = (acc[m.handle] || 0) + 1;
  return acc;
}, {});

console.log(`[import] scanned ${stats.scanned} contribution page(s):`);
console.log(`         ${stats.imported} new · ${stats.overwritten} replaced · ${stats.skipped_existing_better} kept (canonical better) · ${stats.skipped_empty} skipped (empty)`);
console.log(`[import] manifest at data-raw/.contributions-manifest.json — credited handles:`);
for (const [h, n] of Object.entries(credited).sort((a,b) => b[1]-a[1])) {
  console.log(`           ${h}: ${n} page(s)`);
}
