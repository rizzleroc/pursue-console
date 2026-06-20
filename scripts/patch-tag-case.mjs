// patch-tag-case.mjs — normalize tag-token case across events.js to
// dedupe facet dropdowns (e.g. "FBI" + "fbi" was rendering as two
// distinct filter chips). Convention applied:
//   - Acronyms / military commands → UPPERCASE (FBI, CIA, USSR, UAP,
//     CENTCOM, AFRICOM, INDOPACOM, NORTHCOM)
//   - Person / place proper nouns  → Title Case (Borman, Lovell,
//     Conrad, Cernan, Djibouti, Army)
//   - Common nouns                  → lowercase (propulsion, radar)
//
// Operates on source text rather than reserialising the catalog so the
// patch is surgical and the diff stays readable.

import { readFile, writeFile } from "node:fs/promises";

const EVENTS_PATHS = [
  "src/data/events.js",
  "src/data/events-auto.js",
];

// Mapping: from-string → to-string. Both single- and double-quoted
// forms get replaced. Each entry is verified to be a tag token (the
// agency NAMES are full strings like "Central Intelligence Agency",
// so the short forms here only appear as tag tokens).
const TAG_FIXES = [
  // Acronyms (force uppercase)
  ["cia", "CIA"],
  ["fbi", "FBI"],
  ["dow", "DOW"],
  ["DoW", "DOW"],
  ["nasa", "NASA"],
  ["ussr", "USSR"],
  ["uap", "UAP"],
  ["centcom", "CENTCOM"],
  ["africom", "AFRICOM"],
  ["indopacom", "INDOPACOM"],
  // Names + places (Title Case)
  ["borman", "Borman"],
  ["lovell", "Lovell"],
  ["conrad", "Conrad"],
  ["cernan", "Cernan"],
  ["djibouti", "Djibouti"],
  ["army", "Army"],
  // Common nouns (lowercase)
  ["Propulsion", "propulsion"],
  ["Radar", "radar"],
];

let totalReplaced = 0;
const report = TAG_FIXES.map(([from, to]) => ({ from, to, count: 0 }));

for (const path of EVENTS_PATHS) {
  let text = await readFile(path, "utf8");
  let fileReplaced = 0;
  for (let i = 0; i < TAG_FIXES.length; i++) {
    const [from, to] = TAG_FIXES[i];
    const escFrom = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reS = new RegExp(`'${escFrom}'`, "g");
    const reD = new RegExp(`"${escFrom}"`, "g");
    let n = 0;
    text = text.replace(reS, () => { n++; return `'${to}'`; });
    text = text.replace(reD, () => { n++; return `"${to}"`; });
    report[i].count += n;
    fileReplaced += n;
  }
  await writeFile(path, text, "utf8");
  console.log(`[patch-tag-case] ${path}: ${fileReplaced} replacements`);
  totalReplaced += fileReplaced;
}
console.log(`[patch-tag-case] total: ${totalReplaced}`);
for (const r of report) console.log(`  ${JSON.stringify(r.from).padEnd(15)} → ${JSON.stringify(r.to).padEnd(15)} × ${r.count}`);
