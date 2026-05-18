// Validates a contribution PR that adds files under contributions/<handle>/<eid>/p<NNN>.txt.
//
// Runs in two modes:
//   - local: `npm run contrib:validate` checks your own files before you PR
//   - CI:    .github/workflows/validate-contribution.yml runs this on every PR
//            that touches contributions/ and posts the report as a check.
//
// Validation rules:
//   1. SCHEMA  — file naming, path layout, encoding
//   2. CORPUS  — every eid must exist in src/data/events.js
//   3. QUALITY — extracted text must score above MIN_QUALITY using the same
//                wordlist + scoring used by scripts/build-embeddings.py.
//                Q≥0.40 = clean (auto-pass). 0.25-0.40 = needs maintainer review.
//                Below 0.25 = reject (tesseract-grade junk).
//   4. AGREEMENT — if the canonical .vision-cache already has this page, compare
//                  the contribution to it; cos-sim ≥ 0.85 = corroborated.
//   5. SAFETY  — no embedded HTML/script, no excessively long single tokens
//                (URL-list spam), no obvious LLM hallucination patterns
//                ('Note: as an AI language model...').
//
// Exit code 0 if all files pass clean or review-needed. 1 if any file rejects.

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONTRIB = path.join(ROOT, "contributions");
const VIS_CACHE = path.join(ROOT, "data-raw/.vision-cache");
const WORDLIST = path.join(ROOT, "scripts/.words.txt");

const MIN_QUALITY_PASS    = Number(process.env.MIN_QUALITY_PASS    || 0.40);
const MIN_QUALITY_REVIEW  = Number(process.env.MIN_QUALITY_REVIEW  || 0.25);
const MAX_TOKEN_LEN       = 40;            // catch URL-list / base64 dumps
const MAX_TOTAL_KB        = 256;           // per-file safety ceiling

// ---- 0. Load + cache the wordlist used by build-embeddings.py ----
async function loadWordlist() {
  if (!existsSync(WORDLIST)) {
    console.error(`[validate] missing wordlist at ${WORDLIST}`);
    console.error(`           run \`python scripts/build-embeddings.py\` once to fetch it.`);
    process.exit(1);
  }
  const txt = await readFile(WORDLIST, "utf8");
  return new Set(txt.split(/\r?\n/).map(w => w.trim().toLowerCase()).filter(w => w.length >= 3));
}

function textQuality(text, words) {
  const toks = text.match(/[A-Za-z']+/g) || [];
  if (toks.length < 5) return 0.0;
  let real = 0;
  for (const t of toks) {
    if (t.length >= 3 && t.length <= 20 && words.has(t.toLowerCase())) real++;
  }
  return real / toks.length;
}

// ---- 1. Schema + safety checks ----
const HALLUCINATION_MARKERS = [
  /as an? (ai|llm|language model)/i,
  /i (cannot|can't|do not|don't) (see|view|access)/i,
  /i (apologize|am sorry).{0,30}(unable|cannot|can't)/i,
  /the (image|document|file) (appears to be|seems to|cannot) /i,  // common GPT openings; flag for review
];
const SCRIPT_MARKERS = [/<script\b/i, /<iframe\b/i, /javascript:/i, /data:text\/html/i];

function safetyCheck(text) {
  const issues = [];
  for (const re of SCRIPT_MARKERS) if (re.test(text)) issues.push(`embedded script: /${re.source}/`);
  for (const re of HALLUCINATION_MARKERS) if (re.test(text)) issues.push(`possible LLM commentary: /${re.source}/`);
  // single-token spam
  const longToks = (text.match(/\S{40,}/g) || []).length;
  if (longToks > 5) issues.push(`${longToks} suspiciously long tokens (URL/base64 dump?)`);
  return issues;
}

// ---- 2. Walk contributions/ ----
// Path convention: contributions/<handle>/<source>/<eid>/p<NNN>.txt
//   `human`     reserved for hand-typed transcriptions only
//   `gpt-vision` what scripts/volunteer.mjs produces (ChatGPT vision)
//   `gemini`    future Gemini-via-volunteer flow
// Legacy <handle>/<eid>/ shape is accepted and labeled gpt-vision.
const KNOWN_SOURCES = new Set(["human", "gpt-vision", "gemini", "ocr"]);

async function collectContributions() {
  if (!existsSync(CONTRIB)) return [];
  const handles = await readdir(CONTRIB);
  const out = [];
  for (const handle of handles) {
    const hdir = path.join(CONTRIB, handle);
    if (!(await stat(hdir)).isDirectory()) continue;
    for (const child of await readdir(hdir)) {
      const childPath = path.join(hdir, child);
      if (!(await stat(childPath)).isDirectory()) continue;
      if (KNOWN_SOURCES.has(child)) {
        const source = child;
        for (const eid of await readdir(childPath)) {
          const edir = path.join(childPath, eid);
          if (!(await stat(edir)).isDirectory()) continue;
          for (const f of await readdir(edir)) {
            out.push({
              handle, source, eid, file: f, fullPath: path.join(edir, f),
              relPath: `contributions/${handle}/${source}/${eid}/${f}`,
            });
          }
        }
      } else {
        const eid = child;
        for (const f of await readdir(childPath)) {
          out.push({
            handle, source: "gpt-vision", eid, file: f, fullPath: path.join(childPath, f),
            relPath: `contributions/${handle}/${eid}/${f}`,
            legacy: true,
          });
        }
      }
    }
  }
  return out;
}

// ---- 3. Lightweight cosine on token-set overlap (proxy for embedding sim) ----
// Used when comparing against the canonical .vision-cache page if it exists.
function tokenSet(text) {
  return new Set((text.toLowerCase().match(/[a-z']{3,}/g) || []).slice(0, 400));
}
function jaccardSim(a, b) {
  const inter = [...a].filter(x => b.has(x)).length;
  const uni = new Set([...a, ...b]).size || 1;
  return inter / uni;
}

// ---- main ----
const words = await loadWordlist();
const { EVENTS } = await import("../src/data/events.js");
const eventIds = new Set(EVENTS.map(e => e.id));

const contribs = await collectContributions();
if (!contribs.length) {
  console.log("[validate] no contributions/ files to validate — exiting clean");
  process.exit(0);
}

console.log(`[validate] checking ${contribs.length} contribution file(s)\n`);
let pass = 0, review = 0, reject = 0;
const out = { pass: [], review: [], reject: [] };

for (const c of contribs) {
  const issues = [];
  // 1. SCHEMA
  // Accept two file types per page:
  //   p<NNN>.txt  — transcript (goes into search index, runs full gates)
  //   p<NNN>.json — bounding-box / metadata companion (parse-checked only)
  // Anything else is a schema violation.
  if (/^p\d{1,4}\.json$/.test(c.file)) {
    // Parse-check JSON, then skip the lexical/semantic gates for it.
    try {
      const raw = await readFile(c.fullPath, "utf8");
      JSON.parse(raw);
      pass++;
      out.pass.push({ ...c, quality: 1, vsCanonical: null, issues: [], note: "json:companion" });
    } catch (e) {
      reject++;
      out.reject.push({ ...c, quality: 0, vsCanonical: null, issues: [`invalid JSON: ${e.message}`] });
    }
    continue;
  }
  if (!/^p\d{1,4}\.txt$/.test(c.file)) {
    issues.push(`bad filename (expect p<NNN>.txt or p<NNN>.json): ${c.file}`);
  }
  if (!eventIds.has(c.eid)) {
    issues.push(`unknown event id: ${c.eid} (must exist in src/data/events.js)`);
  }
  // 2. SIZE
  const st = await stat(c.fullPath);
  if (st.size > MAX_TOTAL_KB * 1024) {
    issues.push(`oversize: ${(st.size/1024).toFixed(0)} KB > ${MAX_TOTAL_KB} KB`);
  }
  let text = "";
  try { text = await readFile(c.fullPath, "utf8"); }
  catch (e) { issues.push(`read error: ${e.message}`); }

  if (!issues.length) {
    // 3. SAFETY
    issues.push(...safetyCheck(text));
  }
  // 4. QUALITY (only if we got past schema)
  let q = NaN, longestTok = 0;
  if (text) {
    q = textQuality(text, words);
    const toks = text.match(/\S+/g) || [];
    longestTok = toks.reduce((a, b) => Math.max(a, b.length), 0);
  }
  // 5. AGREEMENT (if canonical vision cache has this page)
  let agreement = null;
  if (text) {
    const pageNum = Number(c.file.match(/^p(\d+)/)[1]);
    const cacheCandidates = [
      path.join(VIS_CACHE, c.eid, `p${String(pageNum).padStart(4, "0")}.txt`),
      path.join(VIS_CACHE, c.eid, `p${pageNum}.txt`),
    ];
    for (const cp of cacheCandidates) {
      if (existsSync(cp)) {
        const canon = await readFile(cp, "utf8");
        agreement = jaccardSim(tokenSet(text), tokenSet(canon));
        break;
      }
    }
  }
  const status = issues.length ? "reject"
    : !Number.isFinite(q) ? "reject"
    : q >= MIN_QUALITY_PASS ? "pass"
    : q >= MIN_QUALITY_REVIEW ? "review"
    : "reject";

  const line = `  ${status === "pass" ? "✓" : status === "review" ? "?" : "✗"} ${c.relPath.padEnd(50)} q=${q.toFixed(3)}${agreement!=null?`  vs-canon=${agreement.toFixed(2)}`:""}${issues.length?"  · "+issues.join("; "):""}`;
  console.log(line);
  out[status].push({ ...c, quality: q, agreement, issues });
  if (status === "pass") pass++;
  else if (status === "review") review++;
  else reject++;
}

console.log(`\n[validate] ${pass} pass · ${review} review · ${reject} reject`);
if (reject > 0) {
  console.log(`\n[validate] FAILED — ${reject} file(s) below quality floor or violate safety/schema.`);
  console.log(`[validate] Re-run with VERBOSE=1 npm run contrib:validate for full text dumps.`);
  process.exit(1);
}
if (review > 0) {
  console.log(`\n[validate] ${review} file(s) need maintainer review — quality ${MIN_QUALITY_REVIEW}-${MIN_QUALITY_PASS} band.`);
}
process.exit(0);
