// patch-r02-coords.mjs — one-shot script: assign reasonable regional
// coordinates to events whose `coords: [0.0, 0.0]` is a placeholder
// (terrestrial location string with null-island coords). Operates on
// src/data/events.js as text so the edit is targeted and reversible.
//
// Mapping uses regional centroids consistent with the existing curated
// entries (e.g. "Iraq" matches the [33.3, 44.4] Baghdad coords already
// used by iraq-may-2022 / iraq-dec-2022 in main).

import { readFile, writeFile } from "node:fs/promises";

const EVENTS_PATH = "src/data/events.js";

const LOC_COORDS = {
  "CENTCOM":                       [25.0, 50.0],     // Persian Gulf AOR centroid
  "Arabian Gulf":                  [26.5, 51.5],     // Persian Gulf
  "Arabian Sea":                   [15.0, 65.0],
  "Iraq":                          [33.3, 44.4],     // Baghdad (matches existing curated)
  "Syria":                         [35.0, 38.0],     // (matches existing curated)
  "NORTHCOM":                      [39.0, -98.0],    // US center
  "Middle East":                   [30.0, 45.0],
  "Greece":                        [38.0, 25.0],
  "Southeastern United States":    [32.0, -85.0],
  "Pacific Time Zone":             [36.0, -118.0],
  "Midwestern United States":      [41.0, -93.0],
  "United Arab Emirates":          [24.5, 54.5],     // (matches existing curated)
  "Yellow Sea":                    [36.0, 123.0],
  "AFRICOM":                       [11.6, 43.1],     // Djibouti (matches existing curated)
  "Mediterranean Sea":             [36.0, 18.0],
  "Strait of Hormuz":              [26.5, 56.5],
  "Gulf of Oman":                  [24.5, 58.5],
  "East China Sea":                [29.0, 127.0],    // (matches existing curated)
  "Pacific Ocean":                 [15.0, -150.0],
  "Aegean Sea":                    [38.0, 25.0],
  "Iran":                          [32.0, 53.0],
  "Kazakhstan":                    [48.0, 67.0],     // (matches existing curated)
  "Texas":                         [31.0, -99.0],
  "North Atlantic Ocean":          [35.0, -45.0],
  // Skip "N/A" and "(unknown)" — no good guess. Leaves [0,0] as a
  // discoverable marker rather than masking with a fake location.
};

// Load the events module dynamically to see which IDs match.
const { EVENTS } = await import(`../src/data/events.js?cb=${Date.now()}`);
const candidates = EVENTS.filter(e =>
  e.coords && e.coords[0] === 0 && e.coords[1] === 0
  && !/orbit|space|moon|low earth/i.test(e.loc || "")
  && LOC_COORDS[e.loc || ""]
);
console.log(`[patch] ${candidates.length} events with [0,0] terrestrial coords + known loc`);

let text = await readFile(EVENTS_PATH, "utf8");
let applied = 0;
let skipped = 0;
const skippedDetails = [];

for (const e of candidates) {
  const [newLat, newLon] = LOC_COORDS[e.loc];
  // Be precise: match on the exact id field followed by anything up to
  // the coords field on the SAME line. Both [0, 0] and [0.0, 0.0]
  // shapes are valid.
  const idTok = e.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match id token in either single or double quotes; the auto-generated
  // R02 PR records use single quotes, the hand-curated entries use double.
  // Both [0, 0] and [0.0, 0.0] coord shapes are valid.
  const pattern = new RegExp(
    `(\\bid:\\s*['"]${idTok}['"][^\\n]*?coords:\\s*\\[)\\s*0(?:\\.0)?\\s*,\\s*0(?:\\.0)?\\s*(\\])`,
    "g"
  );
  let count = 0;
  text = text.replace(pattern, (_m, lead, tail) => {
    count++;
    return `${lead}${newLat}, ${newLon}${tail}`;
  });
  if (count === 1) {
    applied++;
  } else {
    skipped++;
    skippedDetails.push(`${e.id} (matched ${count} times)`);
  }
}

console.log(`[patch] applied:  ${applied}`);
console.log(`[patch] skipped:  ${skipped}`);
if (skippedDetails.length) {
  console.log(`[patch] skipped details:`);
  for (const s of skippedDetails) console.log(`         ${s}`);
}

await writeFile(EVENTS_PATH, text, "utf8");
console.log(`[patch] wrote ${EVENTS_PATH}`);
