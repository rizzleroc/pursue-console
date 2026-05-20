// Cross-source comparison + iteration loop.
//
// For every page that has 2+ transcription sources, compute an agreement
// score and write the result back to the page's sidecar JSON. Pages
// where the sources strongly disagree are flagged needs_review=true,
// which the work-available queue uses to surface them to human reviewers.
//
// When a human reviewer types up the page (becoming source='human',
// which always wins canonical), the comparison also records how each
// machine source scored against the human version — over time this
// becomes a per-source quality signal we can act on (e.g. "Gemini is
// 0.93 against human on typed docs but 0.71 on handwritten").
//
// Idempotent. Safe to re-run on every build.

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VIS_CACHE = path.join(ROOT, "data-raw", ".vision-cache");
const QUALITY_LOG = path.join(ROOT, "data-raw", ".source-quality.json");

// Tunable thresholds. agreement_score is 0..1; higher = more agreement.
//   >= 0.85  — sources agree strongly; canonical is solid, no review needed
//   0.5–0.85 — partial agreement; review optional
//   < 0.5    — significant disagreement; flag needs_review=true so the
//              volunteer queue can prioritize it
const HIGH_CONFIDENCE = 0.85;
const REVIEW_THRESHOLD = 0.50;

function tokens(text) {
  // Lowercase ASCII tokens of length >= 3, capped to first 600 tokens to
  // keep comparison costs bounded on long pages.
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || []).slice(0, 600)
  );
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function lengthRatio(a, b) {
  const [lo, hi] = a.length <= b.length ? [a.length, b.length] : [b.length, a.length];
  if (hi === 0) return 0;
  return lo / hi;
}

// Combined score: token overlap is most informative, length ratio
// penalizes one source giving up on a damaged page.
function agreementScore(textA, textB) {
  const tA = tokens(textA), tB = tokens(textB);
  const j = jaccard(tA, tB);
  const l = lengthRatio(textA, textB);
  return Math.round((j * 0.75 + l * 0.25) * 1000) / 1000;
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }
async function listDirs(p) {
  try { return (await readdir(p, { withFileTypes: true })).filter(d => d.isDirectory()); }
  catch { return []; }
}

// Per-source quality tally: when human is present, score every machine
// source against it. Aggregate over the whole corpus → "how often does
// each model match the human-typed truth, on average?"
const quality = { byMachineSource: {}, total: 0, generatedAt: new Date().toISOString() };
function recordAgainstHuman(machine, score) {
  const k = machine;
  if (!quality.byMachineSource[k]) quality.byMachineSource[k] = { n: 0, sum: 0 };
  quality.byMachineSource[k].n++;
  quality.byMachineSource[k].sum += score;
}

const stats = {
  events: 0,
  pages_scanned: 0,
  pages_compared: 0,
  high_confidence: 0,
  medium_confidence: 0,
  needs_review: 0,
  human_vs_machine_pairs: 0,
};

for (const eidEnt of await listDirs(VIS_CACHE)) {
  stats.events++;
  const dir = path.join(VIS_CACHE, eidEnt.name);
  for (const f of await readdir(dir)) {
    const m = f.match(/^p(\d+)\.sources\.json$/);
    if (!m) continue;
    stats.pages_scanned++;

    const sidecarPath = path.join(dir, f);
    let sidecar;
    try { sidecar = JSON.parse(await readFile(sidecarPath, "utf8")); }
    catch { continue; }
    const sources = sidecar.sources || {};
    const names = Object.keys(sources);
    if (names.length < 2) continue;

    // Load actual text per source from the p<NNN>.<source>.txt files
    // that the importers write. Falls back to chars-only proxy when a
    // source predates the per-source-text architecture.
    const textBySource = {};
    for (const n of names) {
      const info = sources[n] || {};
      if (info.text_file) {
        try {
          textBySource[n] = (await readFile(path.join(dir, info.text_file), "utf8")).trim();
        } catch {}
      }
    }
    const haveRealText = Object.keys(textBySource).length >= 2;

    // Pairwise agreement across every (i, j) source combo.
    const pairs = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = names[i], b = names[j];
        const tA = textBySource[a], tB = textBySource[b];
        let score;
        if (tA != null && tB != null) {
          score = agreementScore(tA, tB);
        } else {
          // chars-only proxy when one source predates per-source text
          const cA = sources[a]?.chars || 0, cB = sources[b]?.chars || 0;
          const hi = Math.max(cA, cB);
          score = hi > 0 ? Math.round((Math.min(cA, cB) / hi) * 1000) / 1000 : 0;
        }
        pairs.push({ a, b, score });
      }
    }
    // Overall: take the MIN pairwise score (a single bad source drags
    // confidence down — by design, since divergence anywhere is worth a
    // human look).
    const overall = pairs.length ? Math.min(...pairs.map(p => p.score)) : 1;

    const cmp = {
      computed_at: new Date().toISOString(),
      method: haveRealText ? "token-jaccard+length-ratio" : "char-length-proxy",
      sources_count: names.length,
      canonical: sidecar.best,
      agreement_score: overall,
      pairs,
    };

    if (overall >= HIGH_CONFIDENCE) {
      cmp.confidence = "high";
      cmp.needs_review = false;
      stats.high_confidence++;
    } else if (overall >= REVIEW_THRESHOLD) {
      cmp.confidence = "medium";
      cmp.needs_review = false;
      stats.medium_confidence++;
    } else {
      cmp.confidence = "low";
      cmp.needs_review = true;
      stats.needs_review++;
    }

    // When a human transcription exists, score every machine source
    // against it specifically — this is the gold per-source quality
    // signal we aggregate to compare model accuracy.
    if (textBySource.human) {
      cmp.against_human = {};
      for (const n of names) {
        if (n === "human") continue;
        const tM = textBySource[n];
        if (tM == null) continue;
        const score = agreementScore(textBySource.human, tM);
        cmp.against_human[n] = score;
        recordAgainstHuman(n, score);
        stats.human_vs_machine_pairs++;
      }
    }

    // Re-evaluation pass: if scripts/reevaluate-disputed.mjs has dropped
    // .v2 files via the standardized prompt across both providers, score
    // them and decide whether the original mismatch was prompt-variance
    // (settled by re-eval) or page-intrinsic (still disagreeing, needs
    // human eyes).
    //
    // The reeval block on the sidecar is metadata that points at .v2.txt
    // files. But sidecar.comparison gets fully replaced at the end of
    // this function, so any reevaluation block we read but don't write
    // back gets wiped. Trigger off the FILES on disk so this stays
    // idempotent across runs even if the metadata pointer is lost.
    const pnumForReeval = Number(m[1]);
    const padForReeval = String(pnumForReeval).padStart(4, "0");
    const reevalCandidates = (await readdir(dir)).filter(f => new RegExp(`^p${padForReeval}\\.[a-z-]+\\.v2\\.txt$`).test(f));
    const v2Text = {};
    for (const f of reevalCandidates) {
      const sm = f.match(/^p\d+\.([a-z-]+)\.v2\.txt$/);
      if (!sm) continue;
      try { v2Text[sm[1]] = (await readFile(path.join(dir, f), "utf8")).trim(); } catch {}
    }
    // Preserve the existing reevaluation metadata (computed_at, prompt sha,
    // durations) if it exists, so we can show provenance even after later
    // recomputes.
    const priorReeval = sidecar.comparison?.reevaluation;

    // Asymmetric re-evaluation: if exactly ONE v2 source exists (e.g.
    // a volunteer re-ran via volunteer.mjs --review which is ChatGPT-only),
    // score it against the OTHER provider's v1 text. Same intent: "the
    // disputed page was re-run with a standardized prompt; does it now
    // agree with what the other source originally said?"
    if (Object.keys(v2Text).length === 1) {
      const v2Src = Object.keys(v2Text)[0];           // e.g. "gpt-vision"
      const v2Body = v2Text[v2Src];
      const otherSrc = Object.keys(textBySource).find(n => n !== v2Src);  // e.g. "gemini"
      if (otherSrc && textBySource[otherSrc]) {
        const asym = agreementScore(v2Body, textBySource[otherSrc]);
        cmp.reevaluation = priorReeval || { providers: {} };
        cmp.reevaluation.providers[v2Src] ||= {
          text_file: `p${padForReeval}.${v2Src}.v2.txt`, chars: v2Body.length,
        };
        cmp.reevaluation.asymmetric = { v2: v2Src, vsV1Of: otherSrc, score: asym };
        cmp.reeval_agreement = asym;
        cmp.reeval_pairs = [{ a: `${v2Src}-v2`, b: `${otherSrc}-v1`, score: asym }];
        if (asym >= HIGH_CONFIDENCE) {
          cmp.dispute_kind = "prompt-variance";
          cmp.needs_review = false;
          cmp.confidence = "high";
          stats.disputes_resolved_by_reeval = (stats.disputes_resolved_by_reeval || 0) + 1;
          // Promote v2 (the re-OCR'd version) as canonical — it's the
          // more careful read of the page.
          sidecar.best = v2Src;
          try {
            await writeFile(path.join(dir, `p${padForReeval}.txt`), v2Body + "\n", "utf8");
          } catch {}
        } else if (asym < REVIEW_THRESHOLD) {
          cmp.dispute_kind = "page-intrinsic";
          cmp.needs_review = true;
          stats.disputes_page_intrinsic = (stats.disputes_page_intrinsic || 0) + 1;
        } else {
          cmp.dispute_kind = "partial-improvement";
          stats.disputes_partial = (stats.disputes_partial || 0) + 1;
        }
      }
    }

    if (Object.keys(v2Text).length >= 2) {
      const reeval = priorReeval || { providers: {} };
      for (const src of Object.keys(v2Text)) {
        if (!reeval.providers[src]) {
          reeval.providers[src] = { text_file: `p${padForReeval}.${src}.v2.txt`, chars: v2Text[src].length };
        }
      }
      // Round-trip the block so it survives the cmp overwrite
      cmp.reevaluation = reeval;
      const v2Names = Object.keys(v2Text);
      if (v2Names.length >= 2) {
        // Min pairwise agreement across re-evaluated sources
        let v2Min = 1;
        const v2Pairs = [];
        for (let i = 0; i < v2Names.length; i++) {
          for (let j = i + 1; j < v2Names.length; j++) {
            const a = v2Names[i], b = v2Names[j];
            const score = agreementScore(v2Text[a], v2Text[b]);
            v2Pairs.push({ a, b, score });
            if (score < v2Min) v2Min = score;
          }
        }
        cmp.reeval_agreement = v2Min;
        cmp.reeval_pairs = v2Pairs;
        const v1Score = cmp.agreement_score;
        const delta = v2Min - v1Score;
        cmp.reeval_delta = Math.round(delta * 1000) / 1000;
        // Classify the dispute
        if (v2Min >= HIGH_CONFIDENCE) {
          cmp.dispute_kind = "prompt-variance";   // standardized prompt resolved it
          cmp.needs_review = false;
          cmp.confidence = "high";
          stats.disputes_resolved_by_reeval = (stats.disputes_resolved_by_reeval || 0) + 1;
          // Promote the longest v2 text as canonical
          const winner = v2Names.sort((a, b) => v2Text[b].length - v2Text[a].length)[0];
          sidecar.best = winner;
          // Write canonical p<NNN>.txt to the winning v2 text
          try {
            const pn = Number(m[1]);
            const padPN = String(pn).padStart(4, "0");
            await writeFile(path.join(dir, `p${padPN}.txt`), v2Text[winner] + "\n", "utf8");
          } catch {}
        } else if (v2Min < REVIEW_THRESHOLD) {
          cmp.dispute_kind = "page-intrinsic";    // same prompt, still disagreeing → human
          cmp.needs_review = true;
          stats.disputes_page_intrinsic = (stats.disputes_page_intrinsic || 0) + 1;
        } else {
          cmp.dispute_kind = "partial-improvement";
          stats.disputes_partial = (stats.disputes_partial || 0) + 1;
        }
      }
    }

    // Honor a prior judge verdict — once a page has been judged with
    // high confidence, the verdict survives all subsequent re-runs of
    // compare-sources. Without this round-trip, the next build would
    // clobber dispute_kind="judged" and re-flag the page for review.
    const priorJudge = sidecar.comparison?.judge;
    if (priorJudge && priorJudge.confidence >= 0.7) {
      cmp.judge = priorJudge;
      cmp.dispute_kind = "judged";
      cmp.needs_review = false;
      cmp.confidence = "high";
      stats.disputes_resolved_by_judge = (stats.disputes_resolved_by_judge || 0) + 1;
    }

    sidecar.comparison = cmp;
    await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
    stats.pages_compared++;
  }
}

// Finalize per-source quality averages
const summary = {};
for (const [k, v] of Object.entries(quality.byMachineSource)) {
  summary[k] = { samples: v.n, meanScoreVsHuman: Math.round((v.sum / v.n) * 1000) / 1000 };
}
quality.summary = summary;
await writeFile(QUALITY_LOG, JSON.stringify(quality, null, 2) + "\n", "utf8");

console.log(`[compare] scanned ${stats.pages_scanned} sidecars across ${stats.events} events`);
console.log(`[compare] compared ${stats.pages_compared} multi-source pages`);
console.log(`[compare]   high confidence  ${stats.high_confidence}`);
console.log(`[compare]   medium           ${stats.medium_confidence}`);
// Final count = initially-flagged minus EVERY resolution path that
// flipped needs_review back to false. Reeval (prompt-variance) and
// judge (vision-judge synthesis) both settle disputes; page-intrinsic
// does NOT settle and stays in the queue (it's the "machines can't
// resolve, needs human" verdict). Keep this in sync with the DB
// query in db-rebuild.mjs — the two should always agree.
const finalNeedsReview = stats.needs_review
  - (stats.disputes_resolved_by_reeval || 0)
  - (stats.disputes_resolved_by_judge  || 0);
const breakdownBits = [
  `${stats.needs_review} initially flagged`,
  (stats.disputes_resolved_by_reeval || 0) && `${stats.disputes_resolved_by_reeval} settled by reeval`,
  (stats.disputes_resolved_by_judge  || 0) && `${stats.disputes_resolved_by_judge} settled by judge`,
].filter(Boolean).join(" · ");
console.log(`[compare]   needs review     ${finalNeedsReview} (${breakdownBits})`);
if (stats.disputes_resolved_by_reeval || stats.disputes_page_intrinsic || stats.disputes_partial || stats.disputes_resolved_by_judge) {
  console.log(`[compare] resolution outcomes:`);
  console.log(`            resolved by reeval     ${stats.disputes_resolved_by_reeval || 0}  (prompt-variance: same prompt across both providers now agrees)`);
  console.log(`            resolved by judge      ${stats.disputes_resolved_by_judge || 0}  (vision judge picked / merged / corrected / called blank)`);
  console.log(`            still page-intrinsic   ${stats.disputes_page_intrinsic || 0}  (no resolution path worked — needs human)`);
  console.log(`            partial improvement    ${stats.disputes_partial || 0}  (helped a bit but still in medium band)`);
}
if (stats.human_vs_machine_pairs) {
  console.log(`[compare] human-vs-machine comparisons: ${stats.human_vs_machine_pairs}`);
  for (const [k, v] of Object.entries(summary)) {
    console.log(`            ${k.padEnd(14)} mean=${v.meanScoreVsHuman}  (n=${v.samples})`);
  }
}
console.log(`[compare] per-source quality log: ${QUALITY_LOG}`);
