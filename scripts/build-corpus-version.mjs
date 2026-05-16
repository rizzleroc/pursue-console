// One small file the UI can fetch to know how fresh ANY of the corpus
// artifacts are. Single source of truth for the "data was last refreshed
// at X" strip we render in every tab.

import { readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUB = path.join(ROOT, "public");
const OUT = path.join(PUB, "corpus-version.json");

const artifacts = [
  "embeddings-info.json",
  "embeddings-meta.json",
  "embeddings.bin",
  "search-index.json",
  "dossier-extracts.json",
  "patterns.json",
  "event-similarity.json",
  "visuals.json",
  "work-available.json",
  "live-feed.json",
  "text/manifest.json",
];

const out = { generatedAt: new Date().toISOString(), artifacts: {} };
for (const a of artifacts) {
  const p = path.join(PUB, a);
  if (!existsSync(p)) continue;
  const st = await stat(p);
  let inner = null;
  if (a.endsWith(".json")) {
    try {
      const j = JSON.parse(await readFile(p, "utf8"));
      inner = j.generatedAt || null;
    } catch {}
  }
  out.artifacts[a] = {
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    generatedAt: inner,
  };
}
// Carry through the most important top-level corpus stats so the UI
// can render '910 chunks, 47 docs indexed, …' without a second fetch.
try {
  const info = JSON.parse(await readFile(path.join(PUB, "embeddings-info.json"), "utf8"));
  out.embeddingsCount = info.count;
  out.embeddingsDim   = info.dim;
} catch {}
try {
  const m = JSON.parse(await readFile(path.join(PUB, "text/manifest.json"), "utf8"));
  out.docsIndexed = Object.keys(m).length;
} catch {}
try {
  const w = JSON.parse(await readFile(path.join(PUB, "work-available.json"), "utf8"));
  out.pagesNeeded = w.totalPagesNeeded;
} catch {}

await writeFile(OUT, JSON.stringify(out));
console.log(`[corpus-version] wrote ${OUT} — ${Object.keys(out.artifacts).length} artifact(s)`);
