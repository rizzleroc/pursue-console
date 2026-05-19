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

// Recognized transcription sources. `human` means a person literally
// typed the page out word-for-word — it's reserved, never produced by
// automation. `gpt-vision` is what the volunteer.mjs flow writes (which
// runs ChatGPT vision on rendered page images). New machine sources
// can be added here as their importers come online.
const KNOWN_SOURCES = new Set(["human", "gpt-vision", "gemini", "ocr"]);

// Review-mode sources: a volunteer re-ran a disputed page through the
// standardized prompt via volunteer.mjs --review. These do NOT replace
// the original p<NNN>.<source>.txt (the disagreement evidence) — they
// land as p<NNN>.<base>.v2.txt so compare-sources detects them as the
// v2 reeval result for that page and re-scores the dispute.
const REVIEW_SOURCES = new Map([
  ["gpt-vision-review", "gpt-vision"],
  ["gemini-review",     "gemini"],
]);

// Media submissions live at contributions/<handle>/media/<eid>/p<NNN>.{jpg,json}
// — image + context capture, NOT a text transcription. They land in
// data-raw/.visuals/<eid>/p<NNN>.json with classifier="human:<handle>"
// and the JPEG goes to public/media/<eid>/p<NNN>.jpg, identical layout
// to what the classifier produces so the MEDIA view doesn't care which
// path created the row.
const MEDIA_KINDS = new Set(["photograph", "hand-drawing", "photocopied-negative", "newspaper-clipping", "map", "diagram"]);
// @unverified — has never run against an actual contributor media PR.
// JSON-parse, image-copy, kind-enum validation are syntactically
// correct but a real submission could surface edge cases (BOM in JSON,
// trailing commas, JPEG with EXIF orientation flags, missing required
// fields). First real PR is the live test.
async function importMediaFolder(handle, eidDir) {
  const eid = path.basename(eidDir);
  const visualsDir = path.join(ROOT, "data-raw", ".visuals", eid);
  const mediaDir = path.join(ROOT, "public", "media", eid);
  await mkdir(visualsDir, { recursive: true });
  await mkdir(mediaDir, { recursive: true });
  const { copyFile } = await import("node:fs/promises");
  let imported = 0, skipped = 0, badSchema = 0, missingImage = 0;
  for (const f of await readdir(eidDir)) {
    if (!/\.json$/i.test(f)) continue;
    const pad4Match = f.match(/^p(\d+)\.json$/);
    if (!pad4Match) { skipped++; continue; }
    const pad4 = pad4Match[1].padStart(4, "0");
    const pageNum = Number(pad4Match[1]);
    const jsonPath = path.join(eidDir, f);
    const jpgPath = path.join(eidDir, `p${pad4Match[1]}.jpg`);
    const jpgPathAlt = path.join(eidDir, `p${pad4}.jpg`);
    const realJpg = existsSync(jpgPath) ? jpgPath : (existsSync(jpgPathAlt) ? jpgPathAlt : null);
    if (!realJpg) { missingImage++; continue; }
    let meta;
    try { meta = JSON.parse(await readFile(jsonPath, "utf8")); } catch { badSchema++; continue; }
    if (!meta.kind || !MEDIA_KINDS.has(meta.kind)) { badSchema++; continue; }
    if (!meta.title && !meta.context) { badSchema++; continue; }
    // Write sidecar in the same shape the classifier produces.
    const sidecar = {
      kind: meta.kind,
      title: String(meta.title || "").slice(0, 200),
      description: String(meta.context || meta.description || "").slice(0, 1500),
      article_text: meta.article_text ? String(meta.article_text) : undefined,
      classifier: `human:${handle}`,
      classifiedAt: meta.captured_at || new Date().toISOString(),
      contributor: handle,
    };
    await writeFile(path.join(visualsDir, `p${pad4}.json`), JSON.stringify(sidecar, null, 2) + "\n", "utf8");
    await copyFile(realJpg, path.join(mediaDir, `p${pad4}.jpg`));
    imported++;
  }
  return { imported, skipped, badSchema, missingImage };
}

// Path convention: contributions/<handle>/<source>/<eid>/p<NNN>.txt
//
// Backward-compat: if a directory directly under <handle>/ is NOT one
// of the known sources, we assume it's an event id from the pre-source
// path shape and label its contents as gpt-vision (the only flow that
// existed then). The fix-contribution-source-labels.mjs migration moved
// existing contributions into the new shape so this fallback should be
// dead in practice — kept only for PRs from forks that predate the
// migration.
for (const handleEnt of await listDirs(CONTRIB)) {
  if (!handleEnt.isDirectory()) continue;
  const handle = handleEnt.name;
  const hDir = path.join(CONTRIB, handle);

  // Build a flat list of (source, eid, srcDir) triples to import.
  const importTargets = [];
  for (const child of await listDirs(hDir)) {
    // <handle>/<source>-review/<eid>/p<NNN>.txt — volunteer re-OCR via
    // the --review flow. Land as v2 alongside the original; let
    // compare-sources promote canonical if the new v2 + the other
    // provider's v1 now agree.
    if (REVIEW_SOURCES.has(child.name)) {
      const baseSource = REVIEW_SOURCES.get(child.name);
      const reviewRoot = path.join(hDir, child.name);
      for (const eidEnt of await listDirs(reviewRoot)) {
        const eid = eidEnt.name;
        const srcDir = path.join(reviewRoot, eid);
        const dstDir = path.join(VIS_CACHE, eid);
        await mkdir(dstDir, { recursive: true });
        for (const f of await readdir(srcDir)) {
          const pageNum = await pageNumFromName(f);
          if (pageNum == null) continue;
          stats.scanned++;
          const srcText = (await readFile(path.join(srcDir, f), "utf8")).trim();
          if (srcText.length < MIN_CHARS) { stats.skipped_empty++; continue; }
          const pad = pad4(pageNum);
          const v2Path = path.join(dstDir, `p${pad}.${baseSource}.v2.txt`);
          await writeFile(v2Path, srcText + "\n", "utf8");
          // Update sidecar reevaluation block so compare-sources can
          // find the v2 file by metadata too (filesystem-glob also
          // catches it, but this preserves attribution).
          const sidecarPath = path.join(dstDir, `p${pad}.sources.json`);
          let sidecar = { best: null, sources: {} };
          if (existsSync(sidecarPath)) {
            try { sidecar = JSON.parse(await readFile(sidecarPath, "utf8")); } catch {}
          }
          sidecar.comparison ||= {};
          sidecar.comparison.reevaluation ||= { providers: {} };
          sidecar.comparison.reevaluation.providers[baseSource] = {
            text_file: `p${pad}.${baseSource}.v2.txt`,
            chars: srcText.length,
            imported_at: new Date().toISOString(),
            contributor: handle,
            via: "volunteer-review",
          };
          await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
          stats.imported++;
          manifest[`${eid}/p${pad}.txt`] = {
            handle, importedAt: new Date().toISOString(),
            chars: srcText.length, source: `${baseSource}-review`,
          };
        }
      }
      continue;
    }
    if (child.name === "media") {
      // <handle>/media/<eid>/p<NNN>.{jpg,json} — image + context job
      const mediaRoot = path.join(hDir, child.name);
      for (const eidEnt of await listDirs(mediaRoot)) {
        const res = await importMediaFolder(handle, path.join(mediaRoot, eidEnt.name));
        if (res.imported) console.log(`[import] media ${handle}/${eidEnt.name}: ${res.imported} imported${res.badSchema ? `, ${res.badSchema} bad-schema` : ""}${res.missingImage ? `, ${res.missingImage} missing-image` : ""}`);
        stats.imported += res.imported;
        stats.skipped_empty += res.skipped + res.badSchema + res.missingImage;
      }
      continue;
    }
    if (KNOWN_SOURCES.has(child.name)) {
      // New shape: <handle>/<source>/<eid>/files
      const srcLabel = child.name;
      const sourceDir = path.join(hDir, child.name);
      for (const eidEnt of await listDirs(sourceDir)) {
        importTargets.push({
          source: srcLabel, eid: eidEnt.name, srcDir: path.join(sourceDir, eidEnt.name),
        });
      }
    } else {
      // Legacy shape: <handle>/<eid>/files — assume gpt-vision lineage
      importTargets.push({
        source: "gpt-vision", eid: child.name, srcDir: path.join(hDir, child.name),
        legacy: true,
      });
    }
  }

  for (const t of importTargets) {
    const { source: contribSource, eid, srcDir } = t;
    const dstDir = path.join(VIS_CACHE, eid);
    await mkdir(dstDir, { recursive: true });

    for (const f of await readdir(srcDir)) {
      const pageNum = await pageNumFromName(f);
      if (pageNum == null) continue;
      stats.scanned++;

      const srcPath = path.join(srcDir, f);
      const srcText = (await readFile(srcPath, "utf8")).trim();
      if (srcText.length < MIN_CHARS) { stats.skipped_empty++; continue; }

      const pad4Page = pad4(pageNum);
      const dstPath = path.join(dstDir, `p${pad4Page}.txt`);
      const dstPathLegacy = path.join(dstDir, `p${pageNum}.txt`);

      let existingPath = null, existingText = "";
      if (existsSync(dstPath))            existingPath = dstPath;
      else if (existsSync(dstPathLegacy)) existingPath = dstPathLegacy;
      if (existingPath) {
        existingText = (await readFile(existingPath, "utf8")).trim();
      }

      const importedAt = new Date().toISOString();
      const perSourcePath = path.join(dstDir, `p${pad4Page}.${contribSource}.txt`);
      await writeFile(perSourcePath, srcText + "\n", "utf8");

      const sidecarPath = path.join(dstDir, `p${pad4Page}.sources.json`);
      let sidecar = { best: null, sources: {} };
      if (existsSync(sidecarPath)) {
        try { sidecar = JSON.parse(await readFile(sidecarPath, "utf8")); } catch {}
      } else if (existingText.length >= 30) {
        // Seed: previous canonical with unknown lineage. Tag as
        // gpt-vision (default machine source) so future imports can
        // compare against it.
        const seedPath = path.join(dstDir, `p${pad4Page}.gpt-vision.txt`);
        if (!existsSync(seedPath)) await writeFile(seedPath, existingText + "\n", "utf8");
        sidecar.sources["gpt-vision"] = {
          chars: existingText.length, imported_at: null,
          text_file: `p${pad4Page}.gpt-vision.txt`,
          note: "seeded from pre-existing canonical",
        };
      }
      sidecar.sources[contribSource] = {
        chars: srcText.length, imported_at: importedAt, handle,
        text_file: `p${pad4Page}.${contribSource}.txt`,
      };
      // Canonical priority: human always wins; otherwise longest text wins.
      if (contribSource === "human") {
        sidecar.best = "human";
      } else {
        // longest-wins among present sources
        const present = Object.keys(sidecar.sources).filter(k => sidecar.sources[k]?.chars > 0);
        present.sort((a, b) => (sidecar.sources[b].chars || 0) - (sidecar.sources[a].chars || 0));
        sidecar.best = present[0] || contribSource;
      }
      await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n", "utf8");

      // Sync canonical p<NNN>.txt to the winning source's text
      const winnerInfo = sidecar.sources[sidecar.best];
      if (winnerInfo?.text_file) {
        const winnerFull = path.join(dstDir, winnerInfo.text_file);
        if (existsSync(winnerFull)) {
          await writeFile(dstPath, await readFile(winnerFull, "utf8"), "utf8");
        }
      }

      const action = !existingText ? "imported" : "overwritten";
      stats[action]++;

      manifest[`${eid}/p${pad4Page}.txt`] = {
        handle,
        importedAt,
        chars: srcText.length,
        source: contribSource,
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
