// Resolve disputed pages by merging the union of all existing source
// texts. For pages where each source caught part of the page's content
// (e.g. one got the stamp, another got the bleed-through note, another
// got the form fields), the merge is more complete than any single
// source.
//
// Usage:
//   node scripts/resolve-by-merge.mjs <eid>:<page> [<eid>:<page> ...]
//
// e.g.:
//   node scripts/resolve-by-merge.mjs 1949-discs:88 1949-discs:127 general-1948:8
//
// Per page:
//   - Reads p<NNN>.<source>.txt for every source in the sidecar + any
//     p<NNN>.<source>.v2.txt files on disk.
//   - Sorts candidates longest-first.
//   - Builds merged text: start with the longest, append any line from
//     other sources that isn't already a substring of the merged body.
//   - Writes merged text to p<NNN>.txt + p<NNN>.merged.txt.
//   - Sets sidecar.comparison.judge = { verdict: "merged",
//       text_length, confidence: 1.0, judge: "human-merge",
//       sources_merged: [...]} so compare-sources preserves it.
//   - Clears needs_review.

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VIS = path.join(ROOT, "data-raw", ".vision-cache");

const targets = process.argv.slice(2).map(a => {
  const [eid, pStr] = a.split(":");
  if (!eid || !pStr) { console.error(`bad arg: ${a} — expected <eid>:<page>`); process.exit(1); }
  return { eid, page: Number(pStr) };
});
if (!targets.length) {
  console.error("usage: node scripts/resolve-by-merge.mjs <eid>:<page> [...]");
  process.exit(1);
}

function mergeTexts(candidates) {
  // candidates = [{label, text}]
  if (!candidates.length) return "";
  const sorted = [...candidates].sort((a, b) => b.text.length - a.text.length);
  const base = sorted[0].text.trim();
  const baseNorm = base.toLowerCase().replace(/\s+/g, " ");
  const extra = [];
  for (let i = 1; i < sorted.length; i++) {
    for (const line of sorted[i].text.split(/\r?\n/)) {
      const t = line.trim();
      if (t.length < 3) continue;
      const norm = t.toLowerCase().replace(/\s+/g, " ");
      if (baseNorm.includes(norm)) continue;
      // avoid dupes in the extra block
      if (extra.some(e => e.toLowerCase().replace(/\s+/g, " ").includes(norm))) continue;
      extra.push(t);
    }
  }
  return extra.length ? `${base}\n\n--- additional from other sources ---\n${extra.join("\n")}` : base;
}

let resolved = 0;
for (const { eid, page } of targets) {
  const pad = String(page).padStart(4, "0");
  const dir = path.join(VIS, eid);
  const sidecarPath = path.join(dir, `p${pad}.sources.json`);
  if (!existsSync(sidecarPath)) { console.log(`! ${eid} p${pad}: no sidecar`); continue; }
  const sc = JSON.parse(await readFile(sidecarPath, "utf8"));

  // Gather all candidates (v1 from sidecar.sources + any .v2.txt on disk)
  // Exclude `merged` and `judge` themselves — they're outputs of
  // resolution passes, not input transcriptions. Including them
  // would compound on re-runs (last run's merged becomes this run's
  // input). Same for any previously-merged file on disk.
  const EXCLUDED_INPUT_SOURCES = new Set(["judge", "merged"]);
  const candidates = [];
  for (const [src, info] of Object.entries(sc.sources || {})) {
    if (EXCLUDED_INPUT_SOURCES.has(src)) continue;
    if (!info?.text_file) continue;
    try {
      const t = (await readFile(path.join(dir, info.text_file), "utf8")).trim();
      if (t.length >= 5) candidates.push({ label: `${src} (v1)`, text: t });
    } catch {}
  }
  // Scope to THIS page only. Previous version's regex matched any
  // p<digits>.*.v2.txt in the directory which would mix p0088's
  // weather table into p0127's stamp transcription.
  const v2Re = new RegExp(`^p${pad}\\.([a-z-]+)\\.v2\\.txt$`);
  for (const f of await readdir(dir)) {
    const vm = f.match(v2Re);
    if (!vm) continue;
    try {
      const t = (await readFile(path.join(dir, f), "utf8")).trim();
      if (t.length >= 5) candidates.push({ label: `${vm[1]} (v2)`, text: t });
    } catch {}
  }
  if (!candidates.length) { console.log(`! ${eid} p${pad}: no candidates`); continue; }

  const merged = mergeTexts(candidates);
  await writeFile(path.join(dir, `p${pad}.txt`), merged + "\n", "utf8");
  await writeFile(path.join(dir, `p${pad}.merged.txt`), merged + "\n", "utf8");

  // Sidecar updates
  sc.sources["merged"] = {
    chars: merged.length,
    imported_at: new Date().toISOString(),
    text_file: `p${pad}.merged.txt`,
    via: "human-directed-merge",
    sources_used: candidates.map(c => c.label),
  };
  sc.best = "merged";
  sc.comparison ||= {};
  sc.comparison.judge = {
    verdict: "merged",
    best_source: null,
    confidence: 1.0,
    reasoning: `Human-directed merge of ${candidates.length} sources: ${candidates.map(c => c.label).join(", ")}`,
    judged_at: new Date().toISOString(),
    judge: "human-merge",
    text_length: merged.length,
    sources_merged: candidates.map(c => c.label),
  };
  sc.comparison.needs_review = false;
  sc.comparison.dispute_kind = "merged";
  await writeFile(sidecarPath, JSON.stringify(sc, null, 2) + "\n", "utf8");
  console.log(`✓ ${eid} p${pad}: merged ${candidates.length} sources → ${merged.length} chars canonical`);
  resolved++;
}

console.log(`\n[merge] resolved ${resolved}/${targets.length}`);
console.log(`[merge] next: node scripts/compare-sources.mjs && node scripts/db-rebuild.mjs && node scripts/export-review-queue.mjs`);
