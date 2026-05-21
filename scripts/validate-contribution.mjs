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

function safetyCheck(text, mode = "transcription") {
  const issues = [];
  // Script injection / HTML smuggling — always checked regardless of mode.
  for (const re of SCRIPT_MARKERS) if (re.test(text)) issues.push(`embedded script: /${re.source}/`);
  // Hallucination markers are scoped to transcription mode only. For
  // media-context contributions a human will naturally write things
  // like "the document appears to be a memo from August 1947" —
  // false-positive territory. Media-mode skips these and only flags
  // hard tells (the explicit "as an AI" or "I cannot view" patterns,
  // which a human would never write about a page they're holding).
  const markers = mode === "media"
    ? HALLUCINATION_MARKERS.slice(0, 3)   // only the explicit AI-confession ones
    : HALLUCINATION_MARKERS;
  for (const re of markers) if (re.test(text)) issues.push(`possible LLM commentary: /${re.source}/`);
  // single-token spam (URL / base64 dumps)
  const longToks = (text.match(/\S{40,}/g) || []).length;
  if (longToks > 5) issues.push(`${longToks} suspiciously long tokens (URL/base64 dump?)`);
  return issues;
}

// ---- 2. Walk contributions/ ----
// Path convention: contributions/<handle>/<source>/<eid>/p<NNN>.txt
//   `human`     reserved for hand-typed transcriptions only
//   `gpt-vision` what scripts/volunteer.mjs produces (ChatGPT vision)
//   `gemini`    Gemini-via-volunteer flow
//   `claude`    Claude-via-volunteer flow
// Legacy <handle>/<eid>/ shape is accepted and labeled gpt-vision.
const KNOWN_SOURCES = new Set(["human", "gpt-vision", "gemini", "claude", "ocr"]);

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

      // <handle>/media/<eid>/p<NNN>.{jpg,json} — image-extraction submissions
      if (child === "media") {
        for (const eid of await readdir(childPath)) {
          const edir = path.join(childPath, eid);
          if (!(await stat(edir)).isDirectory()) continue;
          for (const f of await readdir(edir)) {
            out.push({
              handle, source: "media", eid, file: f, fullPath: path.join(edir, f),
              relPath: `contributions/${handle}/media/${eid}/${f}`,
              isMedia: true,
            });
          }
        }
        continue;
      }

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

// ---- Media submission validation (PR-side gate) ----
// Schema: { kind ∈ MEDIA_KINDS, title (≤200), context (≤1500),
//   article_text? (only for newspaper-clipping) }
// Each .json must have a sibling .jpg of reasonable size (5KB–5MB).
const MEDIA_KINDS = new Set(["photograph", "hand-drawing", "photocopied-negative", "newspaper-clipping", "map", "diagram"]);

async function validateMediaItem(file) {
  const issues = [];
  const isJson = file.file.endsWith(".json");
  const isImg  = /\.(jpg|jpeg|png)$/i.test(file.file);
  if (!isJson && !isImg) {
    issues.push(`unrecognized media file extension (expected .json, .png, or .jpg)`);
    return issues;
  }
  if (isImg) {
    // Image-only entry: every image must have a matching .json sibling.
    const jsonSibling = file.fullPath.replace(/\.(jpe?g|png)$/i, ".json");
    if (!existsSync(jsonSibling)) issues.push(`${file.relPath}: no matching .json sibling`);
    try {
      const sz = (await stat(file.fullPath)).size;
      const isPng = /\.png$/i.test(file.file);
      // PNG renders of a single PDF page can be 1-3MB; raise the cap.
      const maxBytes = isPng ? 15_000_000 : 5_000_000;
      if (sz < 5_000)     issues.push(`${file.relPath}: image too small (${sz} bytes — likely empty/corrupt)`);
      if (sz > maxBytes)  issues.push(`${file.relPath}: image too large (${(sz/1e6).toFixed(1)} MB — please compress)`);
    } catch { issues.push(`${file.relPath}: cannot stat image`); }
    return issues;
  }
  // JSON entry: schema + matching .jpg.
  let meta;
  try { meta = JSON.parse(await readFile(file.fullPath, "utf8")); }
  catch (e) { return [`${file.relPath}: invalid JSON — ${e.message}`]; }
  if (!meta.kind || !MEDIA_KINDS.has(meta.kind)) {
    issues.push(`${file.relPath}: kind must be one of ${[...MEDIA_KINDS].join(", ")} (got "${meta.kind}")`);
  }
  if (!meta.title || meta.title.trim().length < 4) {
    issues.push(`${file.relPath}: title is required (≥4 chars)`);
  } else if (meta.title.length > 200) {
    issues.push(`${file.relPath}: title too long (${meta.title.length} chars, max 200)`);
  }
  if (!meta.context || meta.context.trim().length < 20) {
    issues.push(`${file.relPath}: context is required (≥20 chars — verbatim quote from preceding/following page)`);
  } else if (meta.context.length > 1500) {
    issues.push(`${file.relPath}: context too long (${meta.context.length} chars, max 1500)`);
  }
  if (meta.kind === "newspaper-clipping" && meta.article_text && meta.article_text.length > 50_000) {
    issues.push(`${file.relPath}: article_text > 50,000 chars — please paste just the article, not the whole edition`);
  }
  // Matching image (png preferred, jpg fallback)
  const pngSibling = file.fullPath.replace(/\.json$/, ".png");
  const jpgSibling = file.fullPath.replace(/\.json$/, ".jpg");
  if (!existsSync(pngSibling) && !existsSync(jpgSibling)) {
    issues.push(`${file.relPath}: no matching image sibling (.png or .jpg)`);
  }
  return issues;
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

  // Media submission — separate validator (schema + image presence + safety)
  if (c.isMedia) {
    const mediaIssues = await validateMediaItem(c);
    if (mediaIssues.length) {
      reject++;
      out.reject.push({ ...c, quality: 0, vsCanonical: null, issues: mediaIssues });
    } else {
      // Run the existing safety check on title/context text if json
      if (c.file.endsWith(".json")) {
        try {
          const meta = JSON.parse(await readFile(c.fullPath, "utf8"));
          const safety = safetyCheck(`${meta.title || ""}\n${meta.context || ""}\n${meta.article_text || ""}`, "media");
          if (safety.length) { reject++; out.reject.push({ ...c, quality: 0, vsCanonical: null, issues: safety }); continue; }
        } catch {}
      }
      pass++;
      out.pass.push({ ...c, quality: 1, vsCanonical: null, issues: [], note: "media:ok" });
    }
    continue;
  }

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
