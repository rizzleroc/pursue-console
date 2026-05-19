// Compare every count + freshness signal between LOCAL build artifacts
// and the LIVE github.io deploy. Surfaces any drift in one screen so
// "review numbers aren't going down" debugging is a 2-second check, not
// a guessing game.
//
// Compares:
//   public/corpus-stats.json       review queue, source breakdown, gaps
//   public/work-available.json     volunteer queues
//   public/corpus-version.json     last-build timestamp
//
// Run: node scripts/diagnose-deploy-sync.mjs
//      (or `npm run corpus:sync-check`)

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LIVE = "https://rizzleroc.github.io/pursue-console";

const FILES = [
  { name: "corpus-stats.json",   keys: ["review.pagesNeedingReview", "review.resolvedByPromptStandard", "review.reevaluated", "events.catalogued", "pages.totalIndexed", "pages.vision", "pages.ocrOnly", "contributions.total", "bySource.gemini", "bySource.human"] },
  { name: "work-available.json", keys: ["totalPagesNeeded", "totalPagesNeedingReview", "totalPagesNeedingVisualContext"] },
  { name: "corpus-version.json", keys: ["generatedAt"] },
];

function getPath(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

async function loadLocal(name) {
  return JSON.parse(await readFile(path.join(ROOT, "public", name), "utf8"));
}
async function loadLive(name) {
  const r = await fetch(`${LIVE}/${name}?cb=${Date.now()}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
  return r.json();
}

let drift = 0;
for (const f of FILES) {
  const [local, live] = await Promise.all([
    loadLocal(f.name).catch(() => ({ _err: "missing" })),
    loadLive(f.name).catch(e => ({ _err: e.message })),
  ]);
  console.log(`\n  ${f.name}`);
  if (local._err) { console.log(`    LOCAL: ${local._err}`); continue; }
  if (live._err)  { console.log(`    LIVE:  ${live._err}`); drift++; continue; }
  for (const k of f.keys) {
    const lv = getPath(local, k);
    const wv = getPath(live, k);
    const same = JSON.stringify(lv) === JSON.stringify(wv);
    const mark = same ? "✓" : "✗";
    if (!same) drift++;
    console.log(`    ${mark} ${k.padEnd(38)} local=${String(lv).padStart(8)}   live=${String(wv).padStart(8)}`);
  }
}

console.log();
if (drift === 0) {
  console.log(`[sync] LOCAL and LIVE agree across every audited count.`);
} else {
  console.log(`[sync] ${drift} value(s) drift between LOCAL and LIVE.`);
  console.log(`[sync] Likely cause: a push hasn't deployed yet, or the CI build re-ran a step that overwrote local-only state.`);
  console.log(`[sync] If you just pushed, give it ~90s for the Pages deploy and re-run.`);
}
