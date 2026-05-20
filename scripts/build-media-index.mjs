// Aggregate per-page classifications into public/media.json, the
// MEDIA tab's read API.
//
// Sources of truth: data-raw/.visuals/<eid>/p<NNN>.json (one per page)
// Output:
//   public/media.json                            // flat catalog
//   { generatedAt, total, byKind, items: [
//       { id, eventId, title, agency, page, kind, title, description,
//         imagePath, thumbnailPath, classifier, classifiedAt }
//     ]
//   }
//
// Idempotent. Safe to run on every build. Cheap (just glob + read).

import { readFile, readdir, writeFile, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VISUALS_DIR = path.join(ROOT, "data-raw", ".visuals");
const MEDIA_DIR = path.join(ROOT, "public", "media");
const OUT = path.join(ROOT, "public", "media.json");

// Pages classified as text-only don't appear in the media library.
const VISIBLE_KINDS = new Set(["photograph", "hand-drawing", "photocopied-negative", "newspaper-clipping", "map", "diagram"]);

await mkdir(path.dirname(OUT), { recursive: true });

let eventsMap = {};
try {
  const { EVENTS } = await import(`../src/data/events.js?cb=${Date.now()}`);
  eventsMap = Object.fromEntries(EVENTS.map(e => [e.id, e]));
} catch {}

async function existsDir(p) { try { return (await stat(p)).isDirectory(); } catch { return false; } }
async function listDirs(p) {
  if (!(await existsDir(p))) return [];
  return (await readdir(p, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
}

const items = [];
for (const eid of await listDirs(VISUALS_DIR)) {
  const dir = path.join(VISUALS_DIR, eid);
  const event = eventsMap[eid] || null;
  for (const f of await readdir(dir)) {
    const m = f.match(/^p(\d+)\.json$/);
    if (!m) continue;
    const pageNum = Number(m[1]);
    let sc;
    try { sc = JSON.parse(await readFile(path.join(dir, f), "utf8")); }
    catch { continue; }
    if (!VISIBLE_KINDS.has(sc.kind)) continue;
    const pad4 = String(pageNum).padStart(4, "0");
    // Prefer PNG (lossless — what classify-visuals writes since 2.1).
    // Fall back to legacy JPEG from the early batch.
    const pngAbs = path.join(MEDIA_DIR, eid, `p${pad4}.png`);
    const jpgAbs = path.join(MEDIA_DIR, eid, `p${pad4}.jpg`);
    const imageAbsPath = existsSync(pngAbs) ? pngAbs : (existsSync(jpgAbs) ? jpgAbs : null);
    if (!imageAbsPath) continue;   // metadata without pixels = skip
    const ext = path.extname(imageAbsPath);
    const imagePath = `media/${eid}/p${pad4}${ext}`;
    items.push({
      id: `${eid}-p${pad4}`,
      eventId: eid,
      eventTitle: event?.title || eid,
      agency: event?.agency || null,
      era: event?.era || null,
      page: pageNum,
      kind: sc.kind,
      title: sc.title || "",
      description: sc.description || "",
      classifier: sc.classifier || null,
      classifiedAt: sc.classifiedAt || null,
      imagePath,
      thumbnailPath: imagePath,   // same file for now; reserved for future smaller thumbs
    });
  }
}

// Default sort: most recent classification first
items.sort((a, b) => (b.classifiedAt || "").localeCompare(a.classifiedAt || ""));

const byKind = items.reduce((acc, it) => { acc[it.kind] = (acc[it.kind] || 0) + 1; return acc; }, {});
const byEvent = items.reduce((acc, it) => { acc[it.eventId] = (acc[it.eventId] || 0) + 1; return acc; }, {});
const byAgency = items.reduce((acc, it) => { acc[it.agency || "—"] = (acc[it.agency || "—"] || 0) + 1; return acc; }, {});

await writeFile(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  total: items.length,
  byKind, byAgency, eventCount: Object.keys(byEvent).length,
  items,
}, null, 2) + "\n", "utf8");

console.log(`[media-index] ${items.length} media items across ${Object.keys(byEvent).length} events`);
console.log(`[media-index] by kind:`);
for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`               ${k.padEnd(22)} ${n}`);
}
console.log(`[media-index] wrote ${OUT}`);
