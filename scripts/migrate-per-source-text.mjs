// One-time migration: for every page sidecar that doesn't yet have a
// per-source text file for its `best` source, snapshot the canonical
// p<NNN>.txt into p<NNN>.<best>.txt. This means future re-imports of
// other sources can do full text comparison instead of falling back to
// chars-only proxy.
//
// Safe to re-run: skips pages where the per-source text already exists.

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VIS_CACHE = path.join(ROOT, "data-raw", ".vision-cache");

async function listDirs(p) {
  try { return (await readdir(p, { withFileTypes: true })).filter(d => d.isDirectory()); }
  catch { return []; }
}

let snapshotted = 0, alreadyHad = 0, skipped = 0;

for (const eidEnt of await listDirs(VIS_CACHE)) {
  const dir = path.join(VIS_CACHE, eidEnt.name);
  for (const f of await readdir(dir)) {
    const m = f.match(/^p(\d+)\.sources\.json$/);
    if (!m) continue;
    const sidecarPath = path.join(dir, f);
    let sc;
    try { sc = JSON.parse(await readFile(sidecarPath, "utf8")); }
    catch { skipped++; continue; }
    const best = sc.best;
    if (!best || !sc.sources?.[best]) { skipped++; continue; }

    const pad4 = m[1];
    const canonical = path.join(dir, `p${pad4}.txt`);
    const perSource = path.join(dir, `p${pad4}.${best}.txt`);
    if (!existsSync(canonical)) { skipped++; continue; }
    if (existsSync(perSource)) { alreadyHad++; continue; }

    const text = await readFile(canonical, "utf8");
    await writeFile(perSource, text, "utf8");
    sc.sources[best].text_file = `p${pad4}.${best}.txt`;
    await writeFile(sidecarPath, JSON.stringify(sc, null, 2) + "\n", "utf8");
    snapshotted++;
  }
}

console.log(`[migrate] snapshotted ${snapshotted} pages into per-source files`);
console.log(`[migrate] already had ${alreadyHad}, skipped ${skipped} (no canonical or no sidecar)`);
