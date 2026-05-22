// Diagnostic: which events have Denis transcriptions waiting to be imported?
//
// Denis's UFO-USA repo has Gemini transcriptions for 112 of 120 PDFs.
// The current vision cache holds pages for some of those events already.
// This script computes the gap — events matched in Denis but not yet
// represented in data-raw/.vision-cache/ — and writes the list so the
// next `import-gemini-corpus` run can be previewed before it runs.
//
// Writes data-raw/.import-candidates.json with the full candidate list.
// Safe to run in CI (skips the vision-cache check gracefully if the dir
// doesn't exist).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const INVENTORY  = path.join(ROOT, "data-raw", "inventory-sync.json");
const CACHE_DIR  = path.join(ROOT, "data-raw", ".vision-cache");
const OUT        = path.join(ROOT, "data-raw", ".import-candidates.json");

// ── 1. Load Denis manifest ────────────────────────────────────────────────────
if (!existsSync(INVENTORY)) {
  console.error(`[import-candidates] no inventory at ${INVENTORY} — run \`npm run corpus:sync\` first`);
  process.exit(1);
}
const inventory = JSON.parse(await readFile(INVENTORY, "utf8"));

// Only consider rows that were matched to one of our event IDs
const matchedRows = inventory.rows.filter(r => r.event_id !== null);

// ── 2. Load EVENTS to validate IDs exist in our catalogue ────────────────────
const { EVENTS } = await import(`../src/data/events.js?cb=${Date.now()}`);
const knownIds = new Set(EVENTS.map(e => e.id));

// ── 3. Determine which matched events have a vision-cache directory ───────────
const cacheExists = existsSync(CACHE_DIR);
if (!cacheExists) {
  console.warn(`[import-candidates] .vision-cache not found at ${CACHE_DIR} — skipping cache check (CI mode)`);
}

const alreadyImported = [];
const candidates      = [];

for (const row of matchedRows) {
  const id = row.event_id;
  const hasCache = cacheExists && existsSync(path.join(CACHE_DIR, id));

  if (hasCache) {
    alreadyImported.push({ event_id: id, filename: row.filename, agency: row.agency });
  } else {
    candidates.push({ event_id: id, filename: row.filename, agency: row.agency });
  }
}

// ── 4. Print summary ──────────────────────────────────────────────────────────
console.log(`\n[import-candidates] Denis manifest: ${inventory.totalPdfs} total PDFs, ${inventory.matched} matched to our catalogue`);
console.log(`[import-candidates] Already imported (have vision cache): ${alreadyImported.length}`);
console.log(`[import-candidates] Import candidates (Denis has them, we don't): ${candidates.length}`);

if (candidates.length > 0) {
  console.log(`\nImport candidates:`);
  console.log(`  ${"event_id".padEnd(50)} ${"agency".padEnd(22)} filename`);
  console.log(`  ${"─".repeat(110)}`);
  for (const c of candidates) {
    console.log(`  ${c.event_id.padEnd(50)} ${c.agency.padEnd(22)} ${c.filename}`);
  }
} else {
  console.log(`\n[import-candidates] All Denis-matched events are already in the vision cache.`);
}

// ── 5. Write output JSON ──────────────────────────────────────────────────────
const out = {
  generatedAt: new Date().toISOString(),
  summary: {
    totalPdfs:       inventory.totalPdfs,
    denisMatched:    inventory.matched,
    alreadyImported: alreadyImported.length,
    candidates:      candidates.length,
  },
  alreadyImported,
  candidates,
};
await writeFile(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`\n[import-candidates] wrote ${OUT}`);
