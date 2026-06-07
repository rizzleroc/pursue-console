// Emit public/entities.json — the hand-curated entity catalogue
// (src/data/entities.js) as runtime-fetchable JSON for the static
// /mc/ surfaces.
//
// Each entity has { id, name, kind, events: [eventId,…] }; kinds carry
// display metadata { color, glyph, label }. The Network surface consumes
// this to render entity nodes and bipartite event↔entity edges.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "public", "entities.json");

const { ENTITIES, ENTITY_KIND } = await import(path.join(ROOT, "src/data/entities.js"));

const payload = {
  generatedAt: new Date().toISOString(),
  count: ENTITIES.length,
  kinds: ENTITY_KIND,
  entities: ENTITIES.map((e) => ({
    id: e.id,
    name: e.name,
    kind: e.kind,
    events: e.events,
  })),
};

await writeFile(OUT, JSON.stringify(payload));
console.log(`[entities-public] wrote ${path.relative(ROOT, OUT)} — ${ENTITIES.length} entities · ${Object.keys(ENTITY_KIND).length} kinds`);
