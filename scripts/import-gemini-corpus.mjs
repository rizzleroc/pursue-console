// Import the Gemini-transcribed Release 01 corpus from
// DenisSergeevitch/UFO-USA into our vision-cache, with source provenance.
//
//   data-raw/upstream-gemini/converted/<slug>/page-NNNN.md   (input)
//        │  (YAML frontmatter has source_url, page, page_count, model)
//        ↓
//   data-raw/.vision-cache/<eid>/p<NNN>.txt                  (best text — canonical)
//   data-raw/.vision-cache/<eid>/p<NNN>.sources.json         (who transcribed it)
//
// Source-priority order (highest wins for the canonical .txt):
//   human  >  gpt-vision  >  gemini  >  ocr
// Human always wins because someone actually read the page.
// Among machine sources we keep whichever has more characters (a crude
// completeness proxy — short transcripts usually mean the model gave up
// on a damaged page).
//
// Idempotent. Re-running won't replace a longer existing transcript with
// a shorter Gemini one, and the sidecar JSON tracks every source it has
// ever seen for that page, even when not selected as canonical.

import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const UPSTREAM = path.join(ROOT, "data-raw", "upstream-gemini", "converted");
const VIS_CACHE = path.join(ROOT, "data-raw", ".vision-cache");

const SOURCE_PRIORITY = ["human", "gpt-vision", "gemini", "ocr"];

function priorityOf(source) {
  const i = SOURCE_PRIORITY.indexOf(source);
  return i === -1 ? 99 : i;
}

// Parse YAML frontmatter. We don't need a full YAML parser — Denis writes
// flat scalar key: "value" lines between --- markers.
function parseFrontmatter(md) {
  // Normalize CRLF (Denis's repo is checked out with Windows line endings).
  md = md.replace(/\r\n/g, "\n");
  const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const km = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!km) continue;
    let v = km[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (/^\d+$/.test(v)) v = Number(v);
    meta[km[1]] = v;
  }
  return { meta, body: m[2] };
}

// Strip the markdown body of the leading "# <slug> - Page N" heading that
// Denis adds — keeps the index unaware of redundant boilerplate.
function cleanBody(body) {
  return body
    .replace(/^#\s+[^\n]+\n+/, "")   // first H1
    .replace(/^\*\*\*\s*$/gm, "")     // section separators
    .trim();
}

async function readSidecar(p) {
  if (!existsSync(p)) return { best: null, sources: {} };
  try { return JSON.parse(await readFile(p, "utf8")); }
  catch { return { best: null, sources: {} }; }
}

function pickBest(sources) {
  // Lowest priority index wins. Among same priority, longer wins.
  let best = null;
  for (const [name, info] of Object.entries(sources)) {
    if (!info?.chars) continue;
    if (!best) { best = name; continue; }
    const cmp = priorityOf(name) - priorityOf(best);
    if (cmp < 0) best = name;
    else if (cmp === 0 && info.chars > sources[best].chars) best = name;
  }
  return best;
}

// Load events.js to build url → eventId map.
const { EVENTS } = await import(`../src/data/events.js?cb=${Date.now()}`);
const urlToEid = new Map();
for (const e of EVENTS) {
  if (e.url) urlToEid.set(e.url.toLowerCase(), e.id);
}

if (!existsSync(UPSTREAM)) {
  // CI / fresh clones won't have upstream-gemini checked out. That's fine —
  // the .vision-cache/ + sidecar JSONs already contain everything Gemini
  // ever imported (they're committed). This script is for refreshing
  // when upstream Denis publishes a new tranche; without it we just
  // continue with the committed data.
  console.log(`[gemini] upstream not present at ${UPSTREAM} — skipping refresh`);
  console.log(`[gemini] (this is normal in CI; on the maintainer's machine run: git clone --depth 1 https://github.com/DenisSergeevitch/UFO-USA data-raw/upstream-gemini)`);
  process.exit(0);
}

const stats = {
  folders_scanned: 0,
  folders_matched: 0,
  folders_unmatched: 0,
  pages_imported: 0,
  pages_already_better: 0,
  pages_promoted_to_best: 0,
  pages_skipped_empty: 0,
  by_event: new Map(),
};
const unmatched = [];

await mkdir(VIS_CACHE, { recursive: true });
const folders = (await readdir(UPSTREAM, { withFileTypes: true }))
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();

const importedAt = new Date().toISOString();

for (const folder of folders) {
  stats.folders_scanned++;
  const folderPath = path.join(UPSTREAM, folder);
  const pages = (await readdir(folderPath)).filter(f => /^page-\d+\.md$/.test(f)).sort();
  if (!pages.length) continue;

  // Read the first page to discover source_url, then map to event id.
  const firstMd = await readFile(path.join(folderPath, pages[0]), "utf8");
  const { meta: firstMeta } = parseFrontmatter(firstMd);
  const sourceUrl = (firstMeta.source_url || "").toLowerCase();
  const eid = urlToEid.get(sourceUrl);

  if (!eid) {
    stats.folders_unmatched++;
    unmatched.push({ folder, source_url: firstMeta.source_url, page_count: firstMeta.page_count });
    continue;
  }
  stats.folders_matched++;

  const dstDir = path.join(VIS_CACHE, eid);
  await mkdir(dstDir, { recursive: true });
  if (!stats.by_event.has(eid)) stats.by_event.set(eid, { imported: 0, promoted: 0 });
  const evStat = stats.by_event.get(eid);

  for (const pageFile of pages) {
    const md = await readFile(path.join(folderPath, pageFile), "utf8");
    const { meta, body } = parseFrontmatter(md);
    const cleaned = cleanBody(body);
    if (cleaned.length < 30) { stats.pages_skipped_empty++; continue; }

    const pageNum = Number(meta.page) || Number(pageFile.match(/^page-(\d+)/)[1]);
    const pad4 = String(pageNum).padStart(4, "0");

    const txtPath = path.join(dstDir, `p${pad4}.txt`);
    const sidecarPath = path.join(dstDir, `p${pad4}.sources.json`);
    const geminiPath = path.join(dstDir, `p${pad4}.gemini.txt`);

    // Read existing sidecar (or seed it from whatever's currently in .txt)
    const sidecar = await readSidecar(sidecarPath);
    if (Object.keys(sidecar.sources).length === 0 && existsSync(txtPath)) {
      // Pre-existing canonical with no sidecar — tag as gpt-vision (our
      // default machine source) and stash it as its own per-source file
      // so future re-imports don't lose it.
      const existing = (await readFile(txtPath, "utf8")).trim();
      if (existing.length >= 30) {
        const gptPath = path.join(dstDir, `p${pad4}.gpt-vision.txt`);
        if (!existsSync(gptPath)) await writeFile(gptPath, existing + "\n", "utf8");
        sidecar.sources["gpt-vision"] = {
          chars: existing.length, imported_at: null,
          text_file: `p${pad4}.gpt-vision.txt`,
          note: "seeded from pre-existing canonical",
        };
      }
    }

    // Always persist Gemini's text as its own file, never to be overwritten.
    await writeFile(geminiPath, cleaned + "\n", "utf8");
    sidecar.sources.gemini = {
      chars: cleaned.length,
      imported_at: importedAt,
      model: meta.model || "gemini",
      generated_at: meta.generated_at || null,
      text_file: `p${pad4}.gemini.txt`,
    };

    // Decide canonical and sync p<NNN>.txt to the winning source's file
    const newBest = pickBest(sidecar.sources);
    const oldBest = sidecar.best;
    sidecar.best = newBest;
    const winnerInfo = sidecar.sources[newBest];
    if (winnerInfo?.text_file) {
      const winnerPath = path.join(dstDir, winnerInfo.text_file);
      if (existsSync(winnerPath)) {
        const winnerText = await readFile(winnerPath, "utf8");
        await writeFile(txtPath, winnerText, "utf8");
      }
    }

    if (newBest === "gemini") {
      if (oldBest && oldBest !== "gemini") { evStat.promoted++; stats.pages_promoted_to_best++; }
      else { stats.pages_imported++; evStat.imported++; }
    } else {
      stats.pages_already_better++;
    }

    await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
  }
}

console.log(`[gemini] scanned ${stats.folders_scanned} folders · matched ${stats.folders_matched} · unmatched ${stats.folders_unmatched}`);
console.log(`[gemini] imported ${stats.pages_imported} new pages · promoted ${stats.pages_promoted_to_best} to best · kept ${stats.pages_already_better} existing canonical · skipped ${stats.pages_skipped_empty} empty`);
console.log(`[gemini] per-event:`);
for (const [eid, s] of [...stats.by_event.entries()].sort((a,b) => (b[1].imported + b[1].promoted) - (a[1].imported + a[1].promoted))) {
  if (s.imported + s.promoted === 0) continue;
  console.log(`   ${eid.padEnd(28)} +${s.imported} new · ${s.promoted} promoted`);
}
if (unmatched.length) {
  console.log(`\n[gemini] ${unmatched.length} unmatched folders (Gemini has these but we haven't catalogued):`);
  for (const u of unmatched.slice(0, 15)) {
    console.log(`   ${u.folder}  (${u.page_count}p)`);
  }
  if (unmatched.length > 15) console.log(`   …and ${unmatched.length - 15} more.`);
  console.log(`[gemini] full list written to data-raw/.upstream-gemini-unmatched.json`);
  await writeFile(
    path.join(ROOT, "data-raw", ".upstream-gemini-unmatched.json"),
    JSON.stringify(unmatched, null, 2) + "\n",
    "utf8"
  );
}
