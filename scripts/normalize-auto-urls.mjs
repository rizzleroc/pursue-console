// normalize-auto-urls.mjs — fix events-auto.js URLs against war.gov canonical paths.
//
// The auto-importer (auto-catalogue-from-gemini.mjs) wrote some URL fields
// using "_ word _ word _" punctuation derived from the Gemini transcription
// manifest, but war.gov actually serves these as hyphenated, lowercase
// filenames. Bulk fetching against the broken URLs 404s silently. This
// script rewrites the url field in src/data/events-auto.js to whatever
// data-raw/uap-data.csv lists as the canonical war.gov URL, matching by
// normalized basename (lowercase, [_\s-]+ → -, trailing - stripped, .pdf
// dropped). A small override map covers cases where the title differs
// between the auto-catalogue and the canonical CSV row.
//
// Dry-run by default; pass --apply to write changes.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const CSV = path.join(ROOT, "data-raw/uap-data.csv");
const AUTO = path.join(ROOT, "src/data/events-auto.js");

// Filenames war.gov serves that differ from what the auto-catalogue guessed.
// Keyed by events-auto `id`; value is the bare filename (no path).
const OVERRIDES = {
  "dow-uap-d44-range-fouler-reporting-form-gulf-of-aden-october-202":
    "dow-uap-d44-range-fouler-arabian-sea-october-2020.pdf",
  "dow-uap-d48-department-of-the-air-force-report-1996":
    "dow-uap-d48-report-september-1996.pdf",
  "dow-uap-d49-launch-summary-vandenberg-afb-2000":
    "dow-uap-d49-launch-summary-february-2000.pdf",
};

// IDs known to have no canonical war.gov URL — reported as orphans.
const ORPHANS = new Set([
  "nasa-uap-d3-gemini-7-transcript-1965",
]);

function norm(fn) {
  return String(fn).toLowerCase()
    .replace(/\.pdf$/, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function loadCsvCanonicalUrls(csvText) {
  // The CSV column we care about ("PDF | Image Link") contains absolute
  // war.gov URLs. We don't need a full CSV parser to harvest them — a
  // greedy regex over the whole file is enough and survives the quoted-cell
  // multi-line records.
  const re = /https:\/\/www\.war\.gov\/medialink\/ufo\/release_1\/[^,"|\s]+\.pdf/gi;
  const urls = new Set();
  let m;
  while ((m = re.exec(csvText)) !== null) urls.add(m[0]);
  const lookup = new Map();
  for (const u of urls) {
    const fn = decodeURIComponent(u.split("/").pop());
    lookup.set(norm(fn), fn);
  }
  return lookup;
}

function parseAuto(text) {
  // The file is hand-edited JS but every record is a single-line JSON object
  // wrapped in { ... }, between the export-array `[` and `]`. We rewrite
  // by line so we don't have to re-emit the whole file.
  return text.split("\n").map((line, idx) => {
    const m = line.match(/^(\s*)(\{".*\})(,?)\s*$/);
    if (!m) return { kind: "raw", line };
    let obj;
    try { obj = JSON.parse(m[2]); } catch { return { kind: "raw", line }; }
    return { kind: "rec", indent: m[1], obj, trailing: m[3], lineNo: idx + 1 };
  });
}

function emitAuto(parsed) {
  return parsed.map(p => {
    if (p.kind === "raw") return p.line;
    return `${p.indent}${JSON.stringify(p.obj)}${p.trailing}`;
  }).join("\n");
}

const apply = process.argv.includes("--apply");
const csvText = fs.readFileSync(CSV, "utf8");
const autoText = fs.readFileSync(AUTO, "utf8");
const lookup = loadCsvCanonicalUrls(csvText);
const parsed = parseAuto(autoText);

const report = { total: 0, ok: 0, normalized: 0, overridden: 0, orphan: [], skipped: 0, stillBroken: [] };

for (const p of parsed) {
  if (p.kind !== "rec" || !p.obj.url) continue;
  report.total++;
  const id = p.obj.id;
  const current = p.obj.url;

  // Entries whose `url` is already an absolute URL aren't in scope — the
  // normalizer only fixes bare-filename auto-import URLs.
  if (/^https?:\/\//i.test(current)) {
    report.skipped++;
    continue;
  }

  if (ORPHANS.has(id)) {
    report.orphan.push({ id, current });
    continue;
  }

  if (OVERRIDES[id]) {
    if (current !== OVERRIDES[id]) {
      p.obj.url = OVERRIDES[id];
      report.overridden++;
    } else {
      report.ok++;
    }
    continue;
  }

  // Already canonical? Look it up directly.
  if (lookup.has(norm(current)) && lookup.get(norm(current)) === current) {
    report.ok++;
    continue;
  }

  // Try to normalize: same normalized key as a CSV URL?
  const key = norm(current);
  if (lookup.has(key)) {
    const canonical = lookup.get(key);
    if (canonical !== current) {
      p.obj.url = canonical;
      report.normalized++;
    } else {
      report.ok++;
    }
    continue;
  }

  report.stillBroken.push({ id, current, normKey: key });
}

console.log(`scanned ${report.total} auto entries`);
console.log(`  already canonical : ${report.ok}`);
console.log(`  normalized by map : ${report.normalized}`);
console.log(`  fixed by override : ${report.overridden}`);
console.log(`  orphans (no URL)  : ${report.orphan.length}`);
console.log(`  full-URL skipped  : ${report.skipped}`);
console.log(`  still broken      : ${report.stillBroken.length}`);

if (report.orphan.length) {
  console.log("\norphans — these have no war.gov URL and need a human:");
  for (const o of report.orphan) console.log(`  - ${o.id}  (current: ${o.current})`);
}
if (report.stillBroken.length) {
  console.log("\nstill broken — no CSV match and no override:");
  for (const o of report.stillBroken) console.log(`  - ${o.id}\n      current: ${o.current}\n      normKey: ${o.normKey}`);
}

if (apply && (report.normalized + report.overridden) > 0) {
  fs.writeFileSync(AUTO, emitAuto(parsed));
  console.log(`\nwrote ${AUTO}`);
} else if (!apply) {
  console.log("\ndry-run only — pass --apply to write changes");
}
