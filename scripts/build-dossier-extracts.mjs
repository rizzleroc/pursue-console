// Build per-event excerpts + document profile from public/text/*.txt.
// Output: public/dossier-extracts.json keyed by event id.
//
// The DossierView fetches this and renders:
//   • DOCUMENT PROFILE — pages, source, entities, signatures, distinctive
//     terms — a structured summary that "shows full understanding" of
//     what's in the document.
//   • EXCERPTS BY PAGE — top 2-3 most information-dense sentences per
//     page, with highlights for entities, times, and descriptors.
//
// "Information-dense" is scored by heuristics rather than via an LLM at
// build time:
//   +2 contains a date / time / clock
//   +2 contains a proper-noun phrase (Capitalized Multi-Word)
//   +2 contains a shape / behavior / sensor descriptor
//   +1 contains a number > 100 (altitudes, speeds, ranges)
//   +1 length 8-30 words (avoids gibberish fragments)
//
// Heuristics > LLM here because: deterministic, no API cost, works
// offline, results stay stable across deploys. An LLM can be layered
// in later for an extra-detailed pass on long docs.

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TEXT_DIR = path.join(ROOT, "public/text");
const OUT = path.join(ROOT, "public/dossier-extracts.json");
const WORDLIST_PATH = path.join(ROOT, "scripts/.words.txt");

// Load the 10K wordlist used by the FAISS-quality filter. We use it
// here too so excerpts never show OCR junk: a sentence has to have at
// least 50% of its alphabetic tokens be real English to even be considered.
let WORDS = new Set();
if (existsSync(WORDLIST_PATH)) {
  const txt = await readFile(WORDLIST_PATH, "utf8");
  for (const w of txt.split(/\r?\n/)) {
    const s = w.trim().toLowerCase();
    if (s.length >= 3) WORDS.add(s);
  }
} else {
  console.warn("[extracts] warning: scripts/.words.txt missing — junk filter disabled");
}
function realWordRatio(s) {
  const toks = s.match(/[A-Za-z']+/g) || [];
  if (toks.length < 3) return 0;
  let hits = 0;
  for (const t of toks) {
    if (t.length >= 3 && t.length <= 20 && WORDS.has(t.toLowerCase())) hits++;
  }
  return hits / toks.length;
}

const { EVENTS } = await import("../src/data/events.js");
const eventById = Object.fromEntries(EVENTS.map(e => [e.id, e]));

// Regex toolkit
const PATTERNS = {
  clock: /\b(?:[01]?\d|2[0-3])[:.]?[0-5]\d\s?(?:hrs?|hours|z|zulu|local|gmt|a\.?m\.?|p\.?m\.?)\b/i,
  dateYear: /\b(19|20)\d{2}\b/,
  dateLong: /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{2,4})?\b/i,
  bigNumber: /\b\d{3,}\b/,
  // proper-noun: ≥2 consecutive Capitalized words (or 1 word with internal cap like McDonnell)
  properNoun: /\b[A-Z][a-z]+(?:[\s-][A-Z][a-z]+){1,}\b/,
};
const SHAPE_RX    = /\b(disc|disk|saucer|sphere|spherical|orb|cylinder|cylindrical|cigar|triangle|triangular|delta|chevron|oval|ellipsoid|elliptical|egg-shaped|elongated|globe)\b/i;
const BEHAVIOR_RX = /\b(hover|stationary|motionless|silent|noiseless|vertical|ascend|accelerat|instantaneous|materializ|vanished|zigzag|right.angle)\b/i;
const SENSOR_RX   = /\b(radar|infrared|\bir\b|flir|thermal|telescope|camera|skin paint|electro.optical|eo|optical)\b/i;
const AGENCY_PROPER = /\b(NORAD|NASA|FBI|CIA|DIA|USAF|USCENTCOM|INDOPACOM|EUCOM|CENTCOM|AAR[OB]|AATIP|UAP TASK FORCE|UAPTF|DOD|DoD|DOE|FAA|JCS|NRO|NSA|R&E)\b/;

// UAP-relevance markers — the strongest signal. A sentence with any of
// these is almost certainly worth surfacing on a UAP corpus regardless of
// what else it contains.
const UAP_RX = /\b(unidentified|UAP|UFO|unknown object|anomal\w+|saucer|flying disc|flying disk|disk-shaped|disc-shaped|disk shaped|flying object|unknown craft|unknown aircraft|bright object|strange object|odd object|object in the sky|metallic object|aerial phenomen\w*|cigar-shaped|triangle-shaped|something glowing|something hovering|something descending|appeared (?:to be |out of )|materializ\w+ (?:out|from|in)|vanished|instantaneous(?:ly)?|hovered (?:then|over|for|silently)|red satellite|bogey|orb(?:s)? in (?:the )?(?:sky|formation))\b/i;

// Witness / observational phrasing — first-person or eyewitness tone.
const WITNESS_RX = /\b(I saw|we saw|I observed|we observed|witness(?:es|ed)? (?:saw|observed|reported)|looked like|appeared to be|appeared like|seemed to be|moved like|the object|the craft|the light(?:s)?|that thing|saw an?|sighted an?|observed an?|reported (?:seeing|observing))\b/i;

// Routine chatter / mission logistics — penalize hard. These dominate
// space-mission transcripts and FBI cover-letter pages but contribute
// nothing to the UAP signal.
const CHATTER_RX = /\b(Flight Plan|LOI card|tape \d+|tape [A-Z]{1,3}\/?\d+|tape \d+[A-Z]\/\d+|frame \d+|frame number|standby|stand by|copy that|copy all|copy you|Roger that|Roger\.|that's affirmative|that's affirm|over and out|standing by|will do|press on|all systems|nominal|telemetry check|circuit breaker|update the|verify the|confirm the|FROM\s*:|SUBJECT\s*:|page \d+ of \d+|continued on|cont'd|see attached|please find|please advise|please respond|cc:|enclosure|attachment|fax to|wire to)\b/i;
const HEADER_RX = /^\s*(?:DECLASSIFIED|CONFIDENTIAL|SECRET|UNCLASSIFIED|FOR OFFICIAL USE|UNITED STATES|DEPARTMENT OF|MEMORANDUM)\b/i;

// ----- sentence splitter -----
function splitSentences(text) {
  // Page-marker safe: caller passes one page's body without === markers.
  const clean = text.replace(/\s+/g, " ").trim();
  // Split on . ! ? followed by space + capital letter; preserve abbrevs like "Mr." imperfectly
  const raw = clean.split(/(?<=[.!?])\s+(?=[A-Z\("\[])/);
  return raw.flatMap(s => s.split(/(?<=[.!?])\s+(?=\d)/))
            .map(s => s.trim())
            .filter(s => s.length >= 12 && s.length <= 600);
}

// ----- per-sentence interestingness score -----
// Scoring philosophy: this is a UAP corpus. Sentences earn points by being
// observational, phenomenological, or descriptive of the actual subject.
// Generic high-info sentences (dates, proper nouns, numbers) get a small
// nudge but cannot dominate. Routine mission/cover-letter chatter is
// heavily penalized so it falls below the cutoff.
function scoreSentence(s) {
  let score = 0;
  const flags = {};

  // Strong primary signals — these are why a sentence is worth surfacing
  if (UAP_RX.test(s))             { score += 6; flags.uap = true; }
  if (WITNESS_RX.test(s))         { score += 4; flags.witness = true; }
  if (SHAPE_RX.test(s))           { score += 3; flags.shape = true; }
  if (BEHAVIOR_RX.test(s))        { score += 3; flags.behavior = true; }
  if (SENSOR_RX.test(s))          { score += 2; flags.sensor = true; }

  // Secondary signals — useful but small
  if (PATTERNS.clock.test(s))     { score += 1; flags.clock = true; }
  if (PATTERNS.dateLong.test(s))  { score += 1; flags.date = true; }
  if (PATTERNS.bigNumber.test(s)) { score += 0.5; flags.number = true; }
  const propNoun = PATTERNS.properNoun.test(s) || AGENCY_PROPER.test(s);
  if (propNoun)                   { score += 0.5; flags.entity = true; }
  const wc = s.split(/\s+/).length;
  if (wc >= 8 && wc <= 30)        { score += 0.5; flags.goodlen = true; }

  // Penalties — routine chatter, headers, junk OCR
  if (CHATTER_RX.test(s))         { score -= 6; flags.chatter = true; }
  if (HEADER_RX.test(s))          { score -= 4; flags.header = true; }
  const alpha = (s.match(/[A-Za-z]/g) || []).length;
  if (alpha / s.length < 0.4)     { score -= 8; flags.junk = true; }
  // wordRatio quality filter: skip the penalty when a strong observational
  // signal is present, since first-person UAP descriptions are often built
  // out of short common words ('it is a bright object, and it's flashing').
  // Pure-junk OCR text doesn't trigger UAP_RX/WITNESS_RX so still gets
  // caught — this only spares legitimate eyewitness dialogue.
  const wordRatio = realWordRatio(s);
  const strongSignal = flags.uap || flags.witness || flags.shape || flags.behavior;
  if (wordRatio < 0.35 || (wordRatio < 0.5 && !strongSignal)) {
    score -= 8; flags.junk = true;
  }
  // Sentences that are entity-name dumps without verbs are usually
  // metadata rows / table headers — punish.
  if (propNoun && !strongSignal && !/\b(is|was|were|are|saw|observed|appeared|moved|hovered|tracked|reported|seen|noted|sighted|approached|departed|disappeared)\b/i.test(s)) {
    score -= 2; flags.metaonly = true;
  }
  flags.wordRatio = Math.round(wordRatio * 100) / 100;
  return { score, flags };
}

// ----- page-marker aware split -----
function splitByPage(text) {
  const stripped = text.includes("\n---\n") ? text.split("\n---\n", 2)[1] : text;
  const re = /=== Page (\d+)(?:\s*\((\w+)\))? ===/g;
  const out = [];
  let m, prev = null;
  while ((m = re.exec(stripped))) {
    if (prev) {
      out.push({ page: prev.page, source: prev.source, body: stripped.slice(prev.bodyStart, m.index).trim() });
    }
    prev = { page: Number(m[1]), source: m[2] || null, bodyStart: m.index + m[0].length };
  }
  if (prev) out.push({ page: prev.page, source: prev.source, body: stripped.slice(prev.bodyStart).trim() });
  if (!out.length) out.push({ page: 0, source: null, body: stripped.trim() });
  return out;
}

// ----- top excerpts per page -----
// Bias toward fewer-but-better. Default n=2 since most pages don't have
// 3 genuinely UAP-relevant sentences; padding to 3 forces in chatter.
// Threshold raised — sentences need at least one strong UAP/witness signal
// (score ≥ 5) to make the cut. Pages with no qualifying sentences are
// omitted entirely (better to show nothing than mislead the reader).
function pageExcerpts(body, n = 2, minScore = 5) {
  const sentences = splitSentences(body);
  const scored = sentences.map(s => ({ s, ...scoreSentence(s) }))
                          .filter(x => x.score >= minScore);
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const out = [];
  for (const x of scored) {
    const key = x.s.slice(0, 30).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: x.s, score: Number(x.score.toFixed(1)), flags: x.flags });
    if (out.length >= n) break;
  }
  return out;
}

// ----- proper-noun mining for doc profile -----
function mineEntities(allText) {
  const counts = new Map();
  const re = /\b[A-Z][a-z]{2,}(?:[\s-][A-Z][a-z]{2,}){0,3}\b/g;
  let m;
  while ((m = re.exec(allText))) {
    const norm = m[0];
    // filter common false positives (page headers, mid-sentence caps)
    if (/^(The|This|These|That|Those|We|They|He|She|It|And|But|Or|So|Yes|No|Page|Department|Office|Memo|Subject|From|To|Date|Report|Section|Chapter)\s*$/i.test(norm)) continue;
    if (norm.length < 4) continue;
    counts.set(norm, (counts.get(norm) || 0) + 1);
  }
  // Agency-acronym pass (need /g for matchAll)
  const agencyG = new RegExp(AGENCY_PROPER.source, "g");
  for (const m of allText.matchAll(agencyG)) {
    const a = m[0].toUpperCase();
    counts.set(a, (counts.get(a) || 0) + 1);
  }
  return [...counts.entries()].filter(([k, v]) => v >= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, 30)
    .map(([name, count]) => ({ name, count }));
}

// ----- aggregate signatures across doc -----
function aggregateSignatures(allText) {
  const sig = { shape: {}, behavior: {}, sensor: {} };
  const SHAPE = {
    "disc":     /\b(disc|disk|saucer)\b/gi,
    "sphere":   /\b(sphere|spherical|orb|globe)\b/gi,
    "cylinder": /\b(cylinder|cylindrical|cigar)\b/gi,
    "triangle": /\b(triangle|triangular|delta|chevron)\b/gi,
    "oval":     /\b(oval|ellipsoid|elliptical|egg-shaped|elongated)\b/gi,
    "light":    /\b(light|lights|glow|glowing|luminous|bright)\b/gi,
  };
  const BEHAVIOR = {
    "hover":         /\b(hover|hovering|stationary|motionless)\b/gi,
    "high-speed":    /\b(high.speed|tremendous speed|rapid|extreme velocity)\b/gi,
    "vertical":      /\b(vertical|straight up|ascend|climb)\b/gi,
    "silent":        /\b(silent|noiseless|no sound|soundless)\b/gi,
    "instantaneous": /\b(instantaneous|vanished|disappeared instantly|materializ)\b/gi,
    "erratic":       /\b(erratic|zigzag|abrupt|right.angle)\b/gi,
  };
  const SENSOR = {
    "radar":    /\b(radar|skin paint)\b/gi,
    "infrared": /\b(infrared|\bir\b|flir|thermal)\b/gi,
    "optical":  /\b(electro.optical|telescope|camera|photograph)\b/gi,
    "visual":   /\b(visual|eyewitness|sighted by|naked eye)\b/gi,
  };
  for (const [k, rx] of Object.entries(SHAPE))    sig.shape[k]    = (allText.match(rx) || []).length;
  for (const [k, rx] of Object.entries(BEHAVIOR)) sig.behavior[k] = (allText.match(rx) || []).length;
  for (const [k, rx] of Object.entries(SENSOR))   sig.sensor[k]   = (allText.match(rx) || []).length;
  // Strip zero entries
  for (const cat of ["shape", "behavior", "sensor"]) {
    sig[cat] = Object.fromEntries(Object.entries(sig[cat]).filter(([_, v]) => v > 0));
  }
  return sig;
}

// ----- dates referenced -----
function mineDates(allText) {
  const found = new Set();
  for (const m of allText.matchAll(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{2,4})?\b/gi)) {
    found.add(m[0]);
  }
  for (const m of allText.matchAll(/\b(?:1[89]|20)\d{2}\b/g)) {
    found.add(m[0]);
  }
  return [...found].slice(0, 20);
}

// ----- distinctive terms (TF only — TF-IDF would need corpus state; tag low-stopword tokens) -----
const STOP = new Set(`a an the and or but if then so as at by for from in into of on out over to up with which that this these those is are was were be been being have has had had having do does did doing for from etc inc llc co page document report memo not no all any some other will would could should may might can about above after before below between during through before after some thing things one two three years year month day days time times`.split(/\s+/));
function distinctiveTerms(allText) {
  const counts = new Map();
  for (const w of allText.toLowerCase().match(/[a-z]{4,}/g) || []) {
    if (STOP.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([term, count]) => ({ term, count }));
}

// ----- main -----
const manifest = JSON.parse(await readFile(path.join(TEXT_DIR, "manifest.json"), "utf8"));
const files = (await readdir(TEXT_DIR)).filter(f => f.endsWith(".txt"));
// Visual descriptions, if any, were written alongside the manifest by
// scripts/build-text-files.mjs. Keyed by eventId → { page: [{kind, description}] }.
let visualsByEvent = {};
try {
  visualsByEvent = JSON.parse(await readFile(path.join(ROOT, "public/visuals.json"), "utf8"));
} catch {}

const out = {};
let totalExcerpts = 0, totalDocs = 0;
for (const f of files) {
  const eid = f.replace(/\.txt$/, "");
  if (eid === "manifest") continue;
  const ev = eventById[eid];
  if (!ev) continue;
  const raw = await readFile(path.join(TEXT_DIR, f), "utf8");
  const pages = splitByPage(raw);
  const allBody = pages.map(p => p.body).join("\n\n");

  // per-page excerpts
  const excerptsByPage = {};
  for (const p of pages) {
    // Visual-content pages produce their own listing instead of running
    // through the prose-sentence heuristic — every bullet is intentional.
    if (p.source === "visual") {
      const items = p.body.split(/\n+/).map(s => s.trim()).filter(s => /^[-•*]\s*\[/.test(s)).map(s => ({ text: s.replace(/^[-•*]\s*/, ""), score: 5, flags: { visual: true } }));
      if (items.length) {
        excerptsByPage[p.page] = { source: "visual", top: items.slice(0, 6) };
        totalExcerpts += items.length;
      }
      continue;
    }
    const top = pageExcerpts(p.body, 3);
    if (top.length) {
      excerptsByPage[p.page] = { source: p.source || null, top };
      totalExcerpts += top.length;
    }
  }

  // doc profile
  const pageVisuals = visualsByEvent[eid] || {};
  const allVisuals = Object.values(pageVisuals).flat();
  const visualKinds = {};
  for (const v of allVisuals) {
    const k = (v.kind || "image").toLowerCase();
    visualKinds[k] = (visualKinds[k] || 0) + 1;
  }
  const profile = {
    source: manifest[eid]?.source || "unknown",
    pages: manifest[eid]?.pages || pages.length,
    chars: manifest[eid]?.chars || allBody.length,
    entities: mineEntities(allBody),
    dates: mineDates(allBody),
    signatures: aggregateSignatures(allBody),
    distinctive: distinctiveTerms(allBody),
    visualKinds,                              // { photo: 3, diagram: 1, ... }
    visualCount: allVisuals.length,           // total visual elements
    visualPages: Object.keys(pageVisuals).length, // pages with at least one visual
  };

  out[eid] = { profile, excerptsByPage, visuals: pageVisuals };
  totalDocs++;
}

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out));
const { stat } = await import("node:fs/promises");
const sizeKb = ((await stat(OUT)).size / 1024).toFixed(0);
console.log(`[extracts] wrote ${OUT} — ${totalDocs} docs · ${totalExcerpts} excerpts · ${sizeKb} KB`);
