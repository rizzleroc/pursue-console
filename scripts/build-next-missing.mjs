// Emit public/next-missing.json — a prioritized queue of pages that most need
// human transcription. The LIVE-view Coverage Wall CTA ("Open the next missing
// page →") deep-links to queue[0].
//
// Inputs:
//   public/coverage.json          — per-event status (complete|gap|no-data|mismatch) + gapPages
//   public/dossier-extracts.json  — chars per event (bigger doc = more impact)
//   public/review-queue.json      — existing reviewer queue (dedupe against)
//   src/data/events.js            — flag: anchor|high|med|low
//
// Output schema:
//   {
//     generatedAt: "ISO",
//     queue: [
//       { eid, page, agency, flag, reason, priority },
//       ...
//     ]
//   }
//
// Priority: flag_weight × (1 + gapPages/10) × (1 + chars/10000)
//   flag_weight = {anchor:4, high:3, med:2, low:1}

import { readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const COVERAGE = path.join(ROOT, "public/coverage.json");
const DOSSIER = path.join(ROOT, "public/dossier-extracts.json");
const REVIEW_QUEUE = path.join(ROOT, "public/review-queue.json");
const OUT = path.join(ROOT, "public/next-missing.json");

if (!existsSync(COVERAGE)) {
  console.log("[next-missing] no coverage.json yet — leaving public/next-missing.json untouched.");
  process.exit(0);
}

const { EVENTS } = await import(`${path.join(ROOT, "src/data/events.js")}`);
const eventById = Object.fromEntries(EVENTS.map((e) => [e.id, e]));
const flagWeights = { anchor: 4, high: 3, med: 2, low: 1 };

let coverage = {};
try {
  coverage = JSON.parse(await readFile(COVERAGE, "utf8"));
} catch (e) {
  console.error("[next-missing] failed to read coverage.json:", e.message);
  process.exit(1);
}

let dossier = {};
try {
  dossier = JSON.parse(await readFile(DOSSIER, "utf8"));
} catch {
  console.log("[next-missing] dossier-extracts.json not ready — proceeding with limited char data");
}

let reviewQueue = { queue: [] };
try {
  reviewQueue = JSON.parse(await readFile(REVIEW_QUEUE, "utf8"));
} catch {
  /* fine; nothing to dedupe against */
}

const existingReviewPages = new Set();
for (const item of reviewQueue.queue || []) {
  const eid = item.eid || item.eventId;
  if (eid && typeof item.page === "number") existingReviewPages.add(`${eid}:${item.page}`);
}

const queue = [];
const byEvent = coverage.byEvent || [];

for (const ev of byEvent) {
  const { eventId, status, gapPages, chars: covChars, agency } = ev;
  if (!eventId || !agency) continue;
  if (status === "complete") continue;

  const eventData = eventById[eventId];
  const flag = eventData?.flag || "low";
  const flagWeight = flagWeights[flag] || 1;
  const charCount = dossier[eventId]?.profile?.chars || covChars || 0;

  let reason = "gap";
  if (status === "no-data") reason = "no-data";
  else if (status === "mismatch") reason = "low-confidence";

  if (ev.pagesTouched === 0 || gapPages == null) {
    const impact = flagWeight * (1 + charCount / 10000);
    queue.push({
      eid: eventId,
      page: 1,
      agency,
      flag,
      reason,
      priority: Number(impact.toFixed(4)),
      _sort: impact,
    });
  } else if (gapPages > 0) {
    const pagesToQueue = Math.min(3, gapPages);
    for (let p = 1; p <= pagesToQueue; p++) {
      if (existingReviewPages.has(`${eventId}:${p}`)) continue;
      const impact = flagWeight * (1 + gapPages / 10) * (1 + charCount / 10000);
      queue.push({
        eid: eventId,
        page: p,
        agency,
        flag,
        reason,
        priority: Number(impact.toFixed(4)),
        _sort: impact,
      });
    }
  }
}

queue.sort((a, b) => b._sort - a._sort || a.eid.localeCompare(b.eid));
for (const item of queue) delete item._sort;

await writeFile(
  OUT,
  JSON.stringify({ generatedAt: new Date().toISOString(), queue }, null, 2)
);

const sz = (await stat(OUT)).size;
console.log(
  `[next-missing] wrote ${path.relative(ROOT, OUT)}  ${(sz / 1024).toFixed(1)} KB  ${queue.length} candidates`
);
for (const item of queue.slice(0, 3)) {
  console.log(
    `  ${item.eid.padEnd(40)} p${String(item.page).padStart(3)}  flag=${item.flag.padEnd(7)} reason=${item.reason.padEnd(15)} pri=${item.priority.toFixed(3)}`
  );
}
