// Coverage matrix per catalogued doc, answering three questions:
//
//   1. COMPLETE — every page has both Gemini AND GPT-vision
//   2. GAP      — at least one page is missing one or both sources
//   3. MISMATCH — both sources present but cross-source comparison
//                 flagged needs_review=true (low agreement, candidate
//                 for re-evaluation with a standardized prompt)
//
// Output:
//   - Stdout table sorted by gap+mismatch count (worst-need-attention first)
//   - public/coverage.json — flat per-doc matrix the UI can read
//   - Aggregate footer with totals
//
// Run after each db-rebuild. Cheap; queries existing corpus.sqlite.

import Database from "better-sqlite3";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DB = path.join(ROOT, "data-raw", "corpus.sqlite");
const OUT = path.join(ROOT, "public", "coverage.json");

if (!existsSync(DB)) {
  console.error(`[coverage] no corpus DB at ${DB} — run \`npm run corpus:db\` first`);
  process.exit(1);
}

const db = new Database(DB, { readonly: true });

// Per-event matrix: union pages-table rows with inventory.num_pages so
// docs whose later pages haven't been touched yet still report a TRUE
// total page count (vs the count of "pages we attempted").
const rows = db.prepare(`
  SELECT
    e.id           AS event_id,
    e.title        AS title,
    e.agency       AS agency,
    i.num_pages    AS pdf_pages,
    COUNT(p.page_num) AS pages_touched,
    SUM(p.has_gemini)     AS gemini,
    SUM(p.has_gpt_vision) AS gptVision,
    SUM(p.has_human)      AS human,
    SUM(p.has_ocr)        AS ocr,
    SUM(CASE WHEN p.has_gemini=1 AND p.has_gpt_vision=1 THEN 1 ELSE 0 END) AS bothMachineSources,
    SUM(CASE WHEN p.needs_review=1 THEN 1 ELSE 0 END)                       AS needsReview,
    SUM(p.chars) AS chars
  FROM events e
  LEFT JOIN inventory i ON i.id = e.id
  LEFT JOIN pages p     ON p.event_id = e.id
  GROUP BY e.id
  ORDER BY e.id
`).all();

const out = rows.map(r => {
  const totalPages = r.pdf_pages || r.pages_touched || 0;
  // "Gap pages" — pages that exist in the PDF but for which we have
  // neither Gemini nor GPT (and not even tesseract OCR text). If
  // pdf_pages is null we can only say "pages_touched" but flag the
  // gap as unknown.
  const pagesWithAnySource = (r.gemini || 0) + (r.gptVision || 0) + (r.human || 0) + (r.ocr || 0) > 0
    ? r.pages_touched
    : 0;
  const gapPages = totalPages > 0 ? Math.max(0, totalPages - pagesWithAnySource) : null;
  const completeMachinePages = r.bothMachineSources || 0;
  const mismatchPages = r.needsReview || 0;

  // Verdict for the dashboard
  let status;
  if (totalPages === 0) status = "no-data";
  else if (gapPages === 0 && completeMachinePages === totalPages && mismatchPages === 0) status = "complete";
  else if (gapPages > 0 || completeMachinePages < totalPages) status = "gap";
  else if (mismatchPages > 0) status = "mismatch";
  else status = "partial";

  return {
    eventId: r.event_id,
    title: r.title,
    agency: r.agency,
    totalPages,
    pagesTouched: r.pages_touched,
    bothMachineSources: completeMachinePages,
    geminiOnly: Math.max(0, (r.gemini || 0) - completeMachinePages),
    gptVisionOnly: Math.max(0, (r.gptVision || 0) - completeMachinePages),
    humanPages: r.human || 0,
    ocrOnlyPages: Math.max(0, (r.ocr || 0) - (r.gemini || 0) - (r.gptVision || 0)),
    gapPages,
    mismatchPages,
    chars: r.chars || 0,
    status,
  };
});

// Aggregate
const agg = out.reduce((a, r) => {
  a.byStatus[r.status] = (a.byStatus[r.status] || 0) + 1;
  a.totalPages       += r.totalPages || 0;
  a.bothMachine      += r.bothMachineSources || 0;
  a.geminiOnly       += r.geminiOnly || 0;
  a.gptOnly          += r.gptVisionOnly || 0;
  a.human            += r.humanPages || 0;
  a.gap              += r.gapPages || 0;
  a.mismatch         += r.mismatchPages || 0;
  return a;
}, { byStatus: {}, totalPages: 0, bothMachine: 0, geminiOnly: 0, gptOnly: 0, human: 0, gap: 0, mismatch: 0 });

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  events: out.length,
  aggregate: agg,
  byEvent: out,
}, null, 2) + "\n", "utf8");

// Stdout report
const need = out.filter(r => r.status === "gap" || r.status === "mismatch")
                .sort((a, b) => (b.gapPages + b.mismatchPages) - (a.gapPages + a.mismatchPages));

console.log(`\n[coverage] ${out.length} catalogued events, ${agg.totalPages.toLocaleString()} total pages across the corpus`);
console.log(`\n  ✓ complete  ${(agg.byStatus.complete || 0).toString().padStart(3)}  every page has both Gemini and GPT-vision`);
console.log(`  ◔ partial   ${(agg.byStatus.partial  || 0).toString().padStart(3)}  some single-source-only pages, no gaps, no mismatches`);
console.log(`  ▢ gap       ${(agg.byStatus.gap      || 0).toString().padStart(3)}  at least one page missing one or both machine sources`);
console.log(`  ⚖ mismatch  ${(agg.byStatus.mismatch || 0).toString().padStart(3)}  both machines present but disagree on ≥1 page`);
console.log(`  − no-data   ${(agg.byStatus["no-data"] || 0).toString().padStart(3)}  catalogued event with no extracted pages yet`);

console.log(`\n[pages] both-machine=${agg.bothMachine}  gemini-only=${agg.geminiOnly}  gpt-only=${agg.gptOnly}  human=${agg.human}  gap=${agg.gap}  mismatch=${agg.mismatch}`);

if (need.length) {
  console.log(`\nNeeds attention (worst first):`);
  console.log(`  status     event                                        pages  gem-only  gpt-only  gaps  ⚖review`);
  console.log(`  ──────────────────────────────────────────────────────────────────────────────────────────────`);
  for (const r of need.slice(0, 30)) {
    console.log(
      `  ${r.status.padEnd(9)} ${r.eventId.padEnd(44)} ${String(r.totalPages).padStart(5)}  ${String(r.geminiOnly).padStart(8)}  ${String(r.gptVisionOnly).padStart(8)}  ${String(r.gapPages ?? "?").padStart(4)}  ${String(r.mismatchPages).padStart(7)}`
    );
  }
  if (need.length > 30) console.log(`  … and ${need.length - 30} more`);
}

console.log(`\n[coverage] wrote ${OUT}`);
db.close();
