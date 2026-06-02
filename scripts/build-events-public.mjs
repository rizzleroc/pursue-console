// Emit public/events.json — the full EVENTS catalogue as runtime-fetchable
// JSON so the static /mc/ Mission Control pages (and anything else that
// can't import the ESM module) can read per-event metadata at runtime.
//
// src/data/events.js is a build-time ESM module; the deployed /mc/*.html
// pages can only fetch() files under public/. This bridges that gap.
//
// Output: public/events.json { generatedAt, count, events: [...] }
// Each event carries the fields the analysis surfaces need:
//   id, title, date, era, region, agency, flag, coords, type, release

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "public", "events.json");

const { EVENTS } = await import(path.join(ROOT, "src/data/events.js"));

const events = EVENTS.map((e) => ({
  id: e.id,
  title: e.title,
  date: e.date ?? null,
  era: e.era ?? null,
  region: e.region ?? null,
  agency: e.agency ?? null,
  flag: e.flag ?? null,
  coords: e.coords ?? null,
  type: e.type ?? null,
  release: e.release ?? null,
}));

const payload = {
  generatedAt: new Date().toISOString(),
  count: events.length,
  events,
};

await writeFile(OUT, JSON.stringify(payload));
console.log(`[events-public] wrote ${path.relative(ROOT, OUT)} — ${events.length} events`);
