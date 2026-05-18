// Export the cross-source review queue + per-source page texts to
// public/ so the static-site REVIEW view can render side-by-side diffs
// without needing a backend.
//
// Output:
//   public/review-queue.json              — flat list of flagged pages
//                                            with agreement scores, per
//                                            source chars, comparison
//                                            metadata, contributor info
//   public/review-text/<eid>/<page>.json  — { sources: { name: text } }
//                                            for the pages in the queue
//
// We only export the TEXT for pages currently flagged needs_review, to
// keep public/ small. Other pages stay browsable via the dossier view
// from the existing canonical text-files.

import { readFile, writeFile, readdir, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VIS = path.join(ROOT, "data-raw", ".vision-cache");
const OUT_QUEUE = path.join(ROOT, "public", "review-queue.json");
const OUT_TEXT_DIR = path.join(ROOT, "public", "review-text");

async function existsDir(p) { try { return (await stat(p)).isDirectory(); } catch { return false; } }

// Clean the per-page text dir so removed pages don't linger.
if (existsSync(OUT_TEXT_DIR)) await rm(OUT_TEXT_DIR, { recursive: true });
await mkdir(OUT_TEXT_DIR, { recursive: true });

const { EVENTS } = await import(`../src/data/events.js?cb=${Date.now()}`);
const titleById = Object.fromEntries(EVENTS.map(e => [e.id, e.title]));
const agencyById = Object.fromEntries(EVENTS.map(e => [e.id, e.agency]));

const queue = [];
let exportedTextFiles = 0;

if (!(await existsDir(VIS))) {
  await writeFile(OUT_QUEUE, JSON.stringify({ generatedAt: new Date().toISOString(), queue: [] }, null, 2) + "\n");
  console.log("[review-export] no vision-cache; wrote empty queue");
  process.exit(0);
}

for (const eidEnt of await readdir(VIS, { withFileTypes: true })) {
  if (!eidEnt.isDirectory()) continue;
  const eid = eidEnt.name;
  const dir = path.join(VIS, eid);
  for (const f of await readdir(dir)) {
    const m = f.match(/^p(\d+)\.sources\.json$/);
    if (!m) continue;
    const pageNum = Number(m[1]);
    const sidecarPath = path.join(dir, f);
    let sc;
    try { sc = JSON.parse(await readFile(sidecarPath, "utf8")); }
    catch { continue; }
    if (!sc.comparison?.needs_review) continue;

    // Pull text per source from the per-source files (.gemini.txt etc.)
    const sources = {};
    for (const [name, info] of Object.entries(sc.sources || {})) {
      if (info?.text_file) {
        try { sources[name] = await readFile(path.join(dir, info.text_file), "utf8"); }
        catch {}
      }
    }
    // Skip pages where we couldn't load ≥ 2 source texts; nothing to compare
    if (Object.keys(sources).length < 2) continue;

    const eidDir = path.join(OUT_TEXT_DIR, eid);
    await mkdir(eidDir, { recursive: true });
    const textPath = path.join(eidDir, `${pageNum}.json`);
    await writeFile(textPath, JSON.stringify({
      eventId: eid,
      page: pageNum,
      best: sc.best,
      comparison: sc.comparison,
      sources,
    }, null, 2) + "\n", "utf8");
    exportedTextFiles++;

    queue.push({
      eventId: eid,
      title: titleById[eid] || eid,
      agency: agencyById[eid] || null,
      page: pageNum,
      agreement: sc.comparison.agreement_score,
      confidence: sc.comparison.confidence,
      sources: Object.fromEntries(Object.entries(sc.sources || {}).map(([n, v]) => [n, { chars: v?.chars || 0 }])),
      pairs: sc.comparison.pairs || [],
      againstHuman: sc.comparison.against_human || null,
      textUrl: `review-text/${eid}/${pageNum}.json`,
    });
  }
}

// Worst agreement first — that's where human eyes pay off most.
queue.sort((a, b) => (a.agreement ?? 1) - (b.agreement ?? 1));

await writeFile(OUT_QUEUE, JSON.stringify({
  generatedAt: new Date().toISOString(),
  total: queue.length,
  queue,
}, null, 2) + "\n", "utf8");

console.log(`[review-export] ${queue.length} flagged pages, ${exportedTextFiles} text bundles exported`);
console.log(`[review-export] queue → ${OUT_QUEUE}`);
console.log(`[review-export] texts → ${OUT_TEXT_DIR}/`);
