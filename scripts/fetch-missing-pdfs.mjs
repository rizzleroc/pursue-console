// Auto-download any PDF from the Denis-synced inventory that isn't yet
// in data-raw/ locally. The classifier + reeval pipelines need the
// source PDFs to render pages; missing PDFs silently cause page
// failures (e.g. "SKIP (render): no local PDF for <eid>" in the last
// classifier batch dropped 81/200 pages).
//
// Run before any classifier / reeval / volunteer-media batch:
//   npm run corpus:fetch-missing
//
// Idempotent. Only downloads files not already present. Honors
// --dry-run to preview what would be downloaded.

import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeFetch } from "./safe-fetch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SYNC = path.join(ROOT, "data-raw", "inventory-sync.json");
const RAW = path.join(ROOT, "data-raw");

const DRY = process.argv.includes("--dry-run");

if (!existsSync(SYNC)) {
  console.error(`[fetch-missing] no inventory at ${SYNC} — run \`npm run corpus:sync\` first`);
  process.exit(1);
}

await mkdir(RAW, { recursive: true });

const inv = JSON.parse(await readFile(SYNC, "utf8"));
const rows = inv.rows || [];

// Build the set of filenames already on disk
const onDisk = new Set();
try {
  const { readdir } = await import("node:fs/promises");
  for (const f of await readdir(RAW)) if (/\.pdf$/i.test(f)) onDisk.add(f.toLowerCase());
} catch {}

const missing = [];
for (const r of rows) {
  if (!r.filename || !r.url) continue;
  // The classifier matches by eid via fuzzy filename lookup, so we want
  // BOTH the upstream Denis filename AND the catalogued <eid>.pdf name
  // to be present if the eid is known. Simpler approach: just save with
  // an <eid>.pdf alias when matched.
  const lowerName = r.filename.toLowerCase();
  const eidAlias = r.event_id ? `${r.event_id}.pdf`.toLowerCase() : null;
  if (onDisk.has(lowerName) || (eidAlias && onDisk.has(eidAlias))) continue;
  missing.push(r);
}

console.log(`[fetch-missing] inventory: ${rows.length} PDFs · on disk: ${onDisk.size} · missing: ${missing.length}`);
if (!missing.length) { console.log(`[fetch-missing] nothing to download`); process.exit(0); }

if (DRY) {
  console.log(`[fetch-missing] dry-run — would download:`);
  for (const r of missing.slice(0, 50)) console.log(`    ${r.event_id || "(uncatalogued)"} → ${r.filename}`);
  if (missing.length > 50) console.log(`    … and ${missing.length - 50} more`);
  process.exit(0);
}

let ok = 0, failed = 0, totalBytes = 0;
for (let i = 0; i < missing.length; i++) {
  const r = missing[i];
  // Save under <eid>.pdf when we have a catalogued event id (so the
  // classifier's filename heuristic finds it). Fall back to the
  // upstream filename.
  // basename() strips any directory components from the upstream-supplied
  // filename so a crafted inventory row can't write outside data-raw/.
  const dstName = path.basename(r.event_id ? `${r.event_id}.pdf` : r.filename);
  const dst = path.join(RAW, dstName);
  process.stdout.write(`[${i+1}/${missing.length}] ${dstName.padEnd(50)} `);
  try {
    const res = await safeFetch(r.url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dst, buf);
    totalBytes += buf.length;
    ok++;
    console.log(`${(buf.length / 1024).toFixed(0).padStart(7)} KB`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${e.message}`);
  }
}

console.log(`\n[fetch-missing] downloaded ${ok} · failed ${failed} · ${(totalBytes / 1e6).toFixed(1)} MB total`);
