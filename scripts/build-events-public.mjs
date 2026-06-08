// Emit public/events.json — the full EVENTS catalogue as runtime-fetchable
// JSON so the static /mc/ Mission Control pages (and anything else that
// can't import the ESM module) can read per-event metadata at runtime.
//
// src/data/events.js is a build-time ESM module; the deployed /mc/*.html
// pages can only fetch() files under public/. This bridges that gap.
//
// Output: public/events.json { generatedAt, count, events: [...] }
// Each event carries the fields the analysis surfaces need:
//   id, title, date, era, region, agency, flag, coords, type, release,
//   priority, category[], evidenceTypes[], crossRefs[], tags[]
// (priority/category/evidenceTypes/crossRefs are sparse — only events that
// have been classified carry them; everything else is null.)

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "public", "events.json");

const { EVENTS } = await import(path.join(ROOT, "src/data/events.js"));

// Agency inference for auto-imported records — events-auto.js stubs
// (slug ids like "nasa-uap-d5-apollo-17-…") arrive with agency:"Unknown"
// because the auto-cataloguer can't read it from the PDF. Infer from the
// id prefix so downstream surfaces don't render "Unknown" for events that
// clearly came from a known agency.
const AGENCY_FROM_PREFIX = {
  "nasa-uap-": "NASA",
  "dow-uap-":  "Department of War",
  "fbi-uap-":  "FBI",
  "cia-uap-":  "Central Intelligence Agency",
  "doe-uap-":  "Department of Energy",
  "dos-uap-":  "Department of State",
  "odni-uap-": "Office of the Director of National Intelligence",
};
function inferAgency(e) {
  if (e.agency && e.agency !== "Unknown") return e.agency;
  const id = (e.id || "").toLowerCase();
  for (const [pfx, ag] of Object.entries(AGENCY_FROM_PREFIX)) {
    if (id.startsWith(pfx)) return ag;
  }
  return e.agency ?? null;
}

const events = EVENTS.map((e) => ({
  id: e.id,
  title: e.title,
  date: e.date ?? null,
  era: e.era ?? null,
  region: e.region ?? null,
  agency: inferAgency(e),
  flag: e.flag ?? null,
  coords: e.coords ?? null,
  type: e.type ?? null,
  release: e.release ?? null,
  summary: e.summary ?? null,
  loc: e.loc ?? null,
  priority: e.priority ?? null,
  category: e.category ?? null,
  evidenceTypes: e.evidenceTypes ?? null,
  crossRefs: e.crossRefs ?? null,
  tags: e.tags ?? null,
}));

const payload = {
  generatedAt: new Date().toISOString(),
  count: events.length,
  events,
};

await writeFile(OUT, JSON.stringify(payload));
console.log(`[events-public] wrote ${path.relative(ROOT, OUT)} — ${events.length} events`);
