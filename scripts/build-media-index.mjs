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
// `table` is the indexer's own kind (the classifier never emits it) —
// see curate() below. It captures typewritten checklists/forms which
// the vision pass categorized as photocopied-negative because of the
// inverted-tone scan style, but which the user asked to see grouped
// separately from real photo negatives.
const VISIBLE_KINDS = new Set(["photograph", "hand-drawing", "photocopied-negative", "newspaper-clipping", "map", "diagram", "table"]);

// Curate raw classifier output for the MEDIA grid.
//
// The vision classifier (chatgpt) is a strict per-kind labeler — it
// emits photocopied-negative for any inverted-tone scan, including
// pages that are pure typed memos with no actual photographic image.
// That's correct from a "what does the scan look like" standpoint but
// wrong for MEDIA, where the user wants visual artifacts (sketches,
// photos, clippings, charts, tables, maps, handwriting) — not typed
// documents that merely happen to be photocopied.
//
// This function is the one place that translates classifier output
// into MEDIA semantics. Sidecars stay as classifier ground-truth; the
// presentation layer applies rules. Returns { kind, reason } where
// kind === null means "exclude from MEDIA" (treat as text-only).
function curate(sc) {
  const k = sc.kind;
  const d = (sc.description || "").toLowerCase();
  const t = (sc.title || "").toLowerCase();
  const desc = `${d} ${t}`;
  const has = (re) => re.test(desc);

  // Visual cues — if any of these are present we're looking at real
  // media regardless of typed-text noise on the page.
  const hasVisual = has(/(photograph|photo of|sketch|drawing|diagram|illustration|figure|hand-?drawn|aerial view|imagery)/);

  // 1. Folder covers / scanned backings — not media in any sense.
  if (has(/^\s*(a |an )?(tan|brown|manila|scanned) (folder|backing)/) ||
      has(/folder (or |with |cover)/) && !hasVisual) {
    return { kind: null, reason: "folder-cover" };
  }

  // 2. Pure typed memos/reports — described as "typewritten memo /
  //    typewritten report / typewritten page" without any visual cue.
  //    These pages are interesting for TEXT search but they're not
  //    media. Demote to text-only.
  if (k === "photocopied-negative" &&
      has(/(typewritten|typed) (memo|memorandum|report|note|page|confidential)/) &&
      !hasVisual &&
      !has(/(checklist|form|table|stamp|seal)/)) {
    return { kind: null, reason: "typed-memo-only" };
  }

  // 3a. Project Blue Book / AAF UFO incident checklists. These are a
  //     recurring form template (~11 instances of the same page layout
  //     in incident-summaries, with different sighting details typed
  //     into the same blank). Interesting as text — they're findable
  //     in SEARCH — but useless as MEDIA: 11 nearly-identical tiles is
  //     clutter, not browsable visual content.
  if (has(/\b(ufo|unidentified flying objects?|incident)[\s-]*(incident\s+)?checklist/) ||
      has(/restricted (?:ufo|incident) checklist/)) {
    return { kind: null, reason: "blue-book-checklist-template" };
  }

  // 3b. Other typewritten checklist/form pages — kept as the "table"
  //     kind. Currently empty in this corpus once the Blue Book
  //     template is excluded, but the kind stays defined for future
  //     unique tabular content (sightings statistics, comparison
  //     tables, structured reference data — the things the user
  //     actually means by "table").
  if (k === "photocopied-negative" && has(/(checklist|form\b)/)) {
    return { kind: "table", reason: "form-or-checklist" };
  }

  // 4. Maps mislabeled as photograph because Gemini described them as
  //    "Image: A map of …".
  if (k === "photograph" && has(/(map of|weather map|map showing|geographic map)/)) {
    return { kind: "map", reason: "map-misclassified-as-photo" };
  }

  // 5. Artistic illustrations mislabeled as photograph.
  if (k === "photograph" && has(/(artistic illustration|illustration of|drawing of)/) &&
      !has(/photograph/)) {
    return { kind: "hand-drawing", reason: "illustration-misclassified-as-photo" };
  }

  // Default — accept the classifier's call.
  return { kind: k, reason: null };
}

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
const curationStats = { excluded: {}, remapped: {} };
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
    // First pass: filter on the raw classifier kind (text-only stays out).
    if (!["photograph", "hand-drawing", "photocopied-negative", "newspaper-clipping", "map", "diagram"].includes(sc.kind)) continue;
    // Second pass: presentation-layer curation. See curate() above.
    const { kind: curatedKind, reason } = curate(sc);
    if (curatedKind === null) {
      curationStats.excluded[reason] = (curationStats.excluded[reason] || 0) + 1;
      continue;
    }
    if (curatedKind !== sc.kind) {
      const key = `${sc.kind}→${curatedKind}`;
      curationStats.remapped[key] = (curationStats.remapped[key] || 0) + 1;
    }
    const effectiveKind = curatedKind;
    const pad4 = String(pageNum).padStart(4, "0");
    // Prefer PNG (lossless — what classify-visuals writes since 2.1).
    // Fall back to legacy JPEG from the early batch.
    const pngAbs = path.join(MEDIA_DIR, eid, `p${pad4}.png`);
    const jpgAbs = path.join(MEDIA_DIR, eid, `p${pad4}.jpg`);
    const imageAbsPath = existsSync(pngAbs) ? pngAbs : (existsSync(jpgAbs) ? jpgAbs : null);
    // imagePath may be null — that's fine for entries derived from
    // Denis's Gemini bracket markers where we have rich text metadata
    // but no local PDF to render. The UI shows a placeholder tile +
    // the description.
    const ext = imageAbsPath ? path.extname(imageAbsPath) : null;
    const imagePath = imageAbsPath ? `media/${eid}/p${pad4}${ext}` : null;
    items.push({
      id: `${eid}-p${pad4}`,
      eventId: eid,
      eventTitle: event?.title || eid,
      agency: event?.agency || null,
      era: event?.era || null,
      page: pageNum,
      kind: effectiveKind,
      // Preserve the raw classifier output for debugging — useful when
      // a tile shows up under an unexpected kind and we want to know
      // whether the model lied or the curator remapped it.
      rawKind: sc.kind !== effectiveKind ? sc.kind : undefined,
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
if (Object.keys(curationStats.excluded).length || Object.keys(curationStats.remapped).length) {
  console.log(`[media-index] curation:`);
  for (const [reason, n] of Object.entries(curationStats.excluded)) {
    console.log(`               excluded · ${reason.padEnd(28)} ${n}`);
  }
  for (const [pair, n] of Object.entries(curationStats.remapped)) {
    console.log(`               remapped · ${pair.padEnd(28)} ${n}`);
  }
}
console.log(`[media-index] wrote ${OUT}`);
