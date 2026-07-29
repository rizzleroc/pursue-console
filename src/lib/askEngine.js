// =====================================================================
// ASK — a tiny natural-language processor for the corpus.
//
// Not an LLM. Pattern-matches a question against a fixed set of intents
// (changes / classified / agency-distinctives / where / when / count /
// keyword) and runs the matching query against EVENTS. Returns a
// structured answer the AskView renders.
//
// Why pattern-match instead of a model? Two reasons. (1) The questions
// we want to answer — "what's new", "what was classified before",
// "what's different about NASA" — are about *the shape of the dataset*,
// not about the documents' contents (SEMANTIC search already covers
// that). (2) Browser-side LLMs aren't free. A 25 MB transformer is
// already pulled in for SEMANTIC; bolting a second one on for chat
// would double the cold-load cost for a feature that boils down to
// "filter EVENTS by a couple of fields."
// =====================================================================
import { EVENTS, AGENCY_COLORS } from "../data/events.js";

// Agency aliases → canonical record.agency string. "war" matches DoW,
// "intelligence" matches ODNI (the only agency with "intelligence" in
// the full name; CIA is matched by the "cia" alias).
const AGENCY_ALIASES = [
  ["nasa",         "NASA"],
  ["fbi",          "FBI"],
  ["dow",          "Department of War"],
  ["dod",          "Department of War"],
  ["defense",      "Department of War"],
  ["war",          "Department of War"],
  ["state",        "Department of State"],
  ["dos",          "Department of State"],
  ["cia",          "Central Intelligence Agency"],
  ["doe",          "Department of Energy"],
  ["energy",       "Department of Energy"],
  ["odni",         "Office of the Director of National Intelligence"],
  ["intelligence", "Office of the Director of National Intelligence"],
];

const STOPWORDS = new Set([
  "the","a","an","what","was","is","are","were","does","did","do","about",
  "data","on","of","in","to","from","for","by","or","and","that","which",
  "whats","this","these","those","with","like","just","get","back","you",
  "so","can","be","been","has","have","had","there","its","any","i","me",
  "tell","show","find","list","all","into","across","records","record",
  "documents","document","docs","doc","files","file","reports","report",
  "anything","everything","things","stuff","please","me","us",
  // Interrogatives + comparators (added by /loop iter — these words
  // leaked into keyword AND-match and forced no-result on real questions):
  "how","why","when","where","who","whom","whose","which",
  "differ","different","differs","compare","compared","comparing",
  "vs","versus","between","summarize","summary","describe","described",
  "discussed","discusses","mean","actually","really","still"
]);

function lc(q) { return (q || "").toLowerCase().trim(); }

function tokens(q) {
  return lc(q).replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
}

function detectAgency(qLower) {
  for (const [alias, canonical] of AGENCY_ALIASES) {
    if (new RegExp(`\\b${alias}\\b`).test(qLower)) return canonical;
  }
  return null;
}

function detectRelease(qLower) {
  if (/\brelease[\s-]*(?:0?2|two|ii)\b|\br[\s-]*02\b|\brel[\s-]*2\b/.test(qLower)) return "Release 02";
  if (/\brelease[\s-]*(?:0?1|one|i)\b|\br[\s-]*01\b|\brel[\s-]*1\b/.test(qLower))  return "Release 01";
  return null;
}

function detectEra(qLower) {
  // "60s", "1960s", "the sixties"
  const m = qLower.match(/\b(?:19|20)?(\d0)s\b/);
  if (m) return m[1] + "s";
  const decades = { sixties:"60s", seventies:"70s", eighties:"80s", nineties:"90s", forties:"40s", fifties:"50s" };
  for (const [w, era] of Object.entries(decades)) if (qLower.includes(w)) return era;
  return null;
}

function detectYear(qLower) {
  const m = qLower.match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : null;
}

function detectMedia(qLower) {
  if (/\bvideos?\b|\bfootage\b|\bflir\b|\bir video\b/.test(qLower)) return "video";
  if (/\baudios?\b|\brecordings?\b|\btranscripts?\b/.test(qLower))   return "audio";
  if (/\bphotos?\b|\bimagery?\b|\bimages?\b|\bsketch(?:es)?\b/.test(qLower)) return "image";
  return null;
}

// Pull "content words" out of the question for keyword fallback / topic
// matching against title + summary + tags.
function topicTerms(qLower) {
  return tokens(qLower).filter(t => !STOPWORDS.has(t) && t.length > 2);
}

// ---- Intent triggers -------------------------------------------------

// Stem-match prefixes (no trailing \b) so "changed", "changing", "updated",
// "newest" all hit. The leading \b keeps "ranch" from matching "chang".
function isChanges(q) {
  // Bare "new" was too greedy — "Papua New Guinea" matched and routed
  // to Release 02 deltas. Require "new" in a "what's new" / "anything
  // new" / "what is new" context so proper nouns containing it slide by.
  return /\b(chang|added|since|latest|recently|updated?|fresh|just dropped|incoming|release 02|release 2|release ii|r02|rel 2|whats new|what'?s new|anything new|new in|new since)/.test(q);
}
function isClassifiedBefore(q) {
  return /\b(classified before|classified beforehand|previously classified|was classified|still classified|still redacted|still secret|redacted|secret|withheld|blacked out|black bars|censored)\b/.test(q);
}
function isUnclassified(q) {
  return /\b(unclassified|unredacted|not redacted|fully released|fully declassified|public|no redactions|clean)\b/.test(q);
}
function isDifferent(q) {
  return /\b(differ|distinct|unique|stand[- ]?out|odd|unusual|special|peculiar|notable)/.test(q);
}
function isCount(q) {
  return /\b(how many|count|total|number of)\b/.test(q);
}
// ---- Helpers ---------------------------------------------------------

const FLAG_RANK = { anchor: 3, high: 2, med: 1, low: 0 };

function sortByPriority(arr) {
  return [...arr].sort((a, b) => {
    const fa = FLAG_RANK[a.flag] ?? 0, fb = FLAG_RANK[b.flag] ?? 0;
    if (fa !== fb) return fb - fa;
    return (b.sort || 0) - (a.sort || 0);
  });
}

function byAgency(events) {
  const m = new Map();
  for (const e of events) {
    const a = e.agency || "Unknown";
    if (!m.has(a)) m.set(a, []);
    m.get(a).push(e);
  }
  return Array.from(m.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .map(([agency, list]) => ({ label: `${agency} (${list.length})`, agency, events: sortByPriority(list) }));
}

function pct(n, total) {
  if (!total) return "0%";
  return Math.round((n / total) * 100) + "%";
}

// ---- Intent handlers -------------------------------------------------

function answerChanges({ events }) {
  const r02 = events.filter(e => e.release === "Release 02");
  const r01 = events.filter(e => (e.release || "Release 01") === "Release 01");
  const r02Agencies = new Set(r02.map(e => e.agency));
  const r01Agencies = new Set(r01.map(e => e.agency));
  const newAgencies = [...r02Agencies].filter(a => !r01Agencies.has(a));

  const r02Redacted = r02.filter(e => e.redacted).length;
  const r02Videos = r02.filter(e => e.videoId).length;

  return {
    intent: "changes",
    headline: `Release 02 added ${r02.length} records to the catalogue (Release 01: ${r01.length}).`,
    notes: [
      newAgencies.length
        ? `New agencies in Release 02: ${newAgencies.join(", ")} — first appearance in the public corpus.`
        : `No new agencies in Release 02.`,
      `${r02Redacted} of ${r02.length} Release 02 records still bear redactions; ${r02Videos} are video.`,
      `Release 02 PDFs are mirrored locally under /release_2/ — the war.gov WAF rejects automated fetches.`,
    ],
    stats: [
      { label: "RELEASE 02", value: r02.length },
      { label: "RELEASE 01", value: r01.length },
      { label: "NEW AGENCIES", value: newAgencies.length },
      { label: "STILL REDACTED", value: r02Redacted },
    ],
    groups: byAgency(r02),
    hint: "Try also: \"what was classified before\" · \"different about NASA\" · \"records from the 70s\"",
  };
}

function answerClassifiedBefore({ events }) {
  const redacted = events.filter(e => e.redacted);
  const total = events.length;
  return {
    intent: "classified-before",
    headline: `${redacted.length} of ${total} records (${pct(redacted.length, total)}) were declassified for this release but still carry visible redactions.`,
    notes: [
      `These are the documents that were classified beforehand. Black bars, withheld names, sanitized locations — the unredacted material is what war.gov decided to release.`,
      `Use SEARCH to find specific redacted passages; the search index includes everything the OCR could read around the bars.`,
    ],
    stats: [
      { label: "STILL REDACTED", value: redacted.length },
      { label: "FULLY RELEASED", value: total - redacted.length },
      { label: "TOTAL", value: total },
    ],
    groups: byAgency(redacted),
    hint: "Compare: \"what is unredacted\" · \"different about NASA\"",
  };
}

function answerUnclassified({ events }) {
  const clean = events.filter(e => !e.redacted);
  const total = events.length;
  return {
    intent: "unclassified",
    headline: `${clean.length} of ${total} records (${pct(clean.length, total)}) released without visible redactions — fully declassified.`,
    notes: [
      `These records carry no black bars in the released copy. Historical material (40s–60s) dominates: anything sensitive about Cold War sources has aged out.`,
      `Modern fully-clean records are rare — most post-2000 mission reports still redact unit identifiers and personnel names.`,
    ],
    stats: [
      { label: "FULLY RELEASED", value: clean.length },
      { label: "STILL REDACTED", value: total - clean.length },
      { label: "TOTAL", value: total },
    ],
    groups: byAgency(clean),
    hint: "Compare: \"what was classified before\" · \"records from the 40s\"",
  };
}

// "Different about X" — surface the facts that distinguish a slice from
// the rest of the catalogue. For agencies that becomes: where do these
// docs live (region, era, flag), and what types are over-represented?
function answerDifferent({ events, agency }) {
  const slice = agency ? events.filter(e => e.agency === agency) : null;
  if (!slice || slice.length === 0) {
    return {
      intent: "different",
      headline: "I need an agency or topic to compare against the rest of the catalogue.",
      notes: ["Try: \"what's different about NASA\" or \"what's different about FBI\"."],
      stats: [],
      events: [],
    };
  }
  const others = events.filter(e => e.agency !== agency);
  const total = events.length;

  const sliceAnchor = slice.filter(e => e.flag === "anchor").length;
  const otherAnchor = others.filter(e => e.flag === "anchor").length;

  const sliceSpace = slice.filter(e => e.region === "Space" || /space|orbit|lunar|moon|cislunar/i.test(e.loc || "")).length;
  const otherSpace = others.filter(e => e.region === "Space" || /space|orbit|lunar|moon|cislunar/i.test(e.loc || "")).length;

  const sliceVideo = slice.filter(e => e.videoId).length;
  const sliceRedacted = slice.filter(e => e.redacted).length;

  // Spread of eras for this slice
  const eras = {};
  for (const e of slice) if (e.era) eras[e.era] = (eras[e.era] || 0) + 1;
  const eraList = Object.entries(eras).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}:${v}`).join(" · ");

  const notes = [];
  notes.push(
    `${pct(sliceAnchor, slice.length)} of ${agency} records are PRIORITY-flagged (anchor), versus ${pct(otherAnchor, others.length)} of the rest of the corpus.`
  );
  if (sliceSpace > 0) {
    notes.push(
      `${sliceSpace} of ${slice.length} ${agency} records are set in space / orbit / on the moon — the rest of the catalogue has ${otherSpace} space-set records combined.`
    );
  }
  if (sliceVideo > 0) {
    notes.push(`${sliceVideo} ${agency} record${sliceVideo === 1 ? "" : "s"} include${sliceVideo === 1 ? "s" : ""} declassified DVIDS video / audio.`);
  }
  if (sliceRedacted > 0) {
    notes.push(`${sliceRedacted} of ${slice.length} ${agency} records still carry redactions; ${slice.length - sliceRedacted} are released fully clean.`);
  }
  if (eraList) {
    notes.push(`Era spread: ${eraList}.`);
  }
  // Highlight any single-record outliers (e.g. COMETA under NASA)
  if (agency === "NASA") {
    const cometa = slice.find(e => e.id === "cometa");
    if (cometa) notes.push(`Outlier: COMETA is filed under NASA but contains French intelligence material hand-delivered to Washington. The filing choice is itself revealing.`);
  }

  return {
    intent: "different",
    headline: `What's distinctive about the ${agency} slice (${slice.length} of ${total} records).`,
    notes,
    stats: [
      { label: agency.toUpperCase().replace(/DEPARTMENT OF /, "DEPT/"), value: slice.length },
      { label: "PRIORITY", value: sliceAnchor },
      { label: "VIDEO", value: sliceVideo },
      { label: "REDACTED", value: sliceRedacted },
    ],
    groups: null,
    events: sortByPriority(slice),
    hint: `Try also: "${agency} records from the 70s" · "NASA video footage"`,
  };
}

function answerCount({ events, agency, release, era, media }) {
  let slice = events;
  const filters = [];
  if (agency)  { slice = slice.filter(e => e.agency === agency); filters.push(agency); }
  if (release) { slice = slice.filter(e => (e.release || "Release 01") === release); filters.push(release); }
  if (era)     { slice = slice.filter(e => e.era === era); filters.push(era); }
  if (media === "video") { slice = slice.filter(e => e.videoId); filters.push("video"); }
  if (media === "audio") { slice = slice.filter(e => /audio|transcript|debrief/i.test(e.type || "")); filters.push("audio"); }
  if (media === "image") { slice = slice.filter(e => /image|imagery|photo|sketch/i.test(e.type || "")); filters.push("image"); }
  return {
    intent: "count",
    headline: filters.length
      ? `${slice.length} record${slice.length === 1 ? "" : "s"} match: ${filters.join(" · ")}.`
      : `${events.length} records total in the catalogue.`,
    notes: [
      `Each record is a single declassified PDF, video, or audio file from war.gov/UFO.`,
    ],
    stats: [{ label: "MATCHED", value: slice.length }, { label: "TOTAL", value: events.length }],
    groups: agency ? null : byAgency(slice),
    events: agency ? sortByPriority(slice) : null,
  };
}

// Filter-only (agency / release / era / media / topic) — no aggregation,
// just "show me these records."
function answerFilter({ events, agency, release, era, media, terms }) {
  let slice = events;
  const filters = [];
  if (agency)  { slice = slice.filter(e => e.agency === agency); filters.push(agency); }
  if (release) { slice = slice.filter(e => (e.release || "Release 01") === release); filters.push(release); }
  if (era)     { slice = slice.filter(e => e.era === era); filters.push(`${era}`); }
  if (media === "video") { slice = slice.filter(e => e.videoId); filters.push("video"); }
  if (media === "audio") { slice = slice.filter(e => /audio|transcript|debrief/i.test(e.type || "")); filters.push("audio"); }
  if (media === "image") { slice = slice.filter(e => /image|imagery|photo|sketch/i.test(e.type || "")); filters.push("image"); }
  if (terms && terms.length) {
    // Include `date` so year terms hit records whose year is only in
    // metadata. Strict AND-match by default — that's the right
    // precision for "FBI 1958". But if AND returns nothing, fall back
    // to ranked OR: count how many terms each record hits, keep the
    // top-N. This rescues comparative / multi-topic questions like
    // "How does the SWIR diamond differ from the bouncy ball Syria
    // report?" where no single record matches every term.
    const hayOf = (e) => (e.title + " " + (e.summary || "") + " "
      + (e.tags || []).join(" ") + " " + (e.loc || "") + " "
      + (e.date || "")).toLowerCase();
    const andHit = slice.filter(e => terms.every(t => hayOf(e).includes(t)));
    if (andHit.length > 0) {
      slice = andHit;
      filters.push(`matching "${terms.join(" ")}"`);
    } else {
      // OR-fallback: at least 2 terms (or all of them, if fewer) must hit.
      const minHits = Math.min(terms.length, 2);
      const scored = slice
        .map(e => {
          const hay = hayOf(e);
          const hits = terms.filter(t => hay.includes(t)).length;
          return { e, hits };
        })
        .filter(x => x.hits >= minHits)
        .sort((a, b) => b.hits - a.hits);
      slice = scored.map(x => x.e);
      filters.push(`mentioning "${terms.join(" ")}" (any)`);
    }
  }
  return {
    intent: "filter",
    headline: slice.length
      ? `${slice.length} record${slice.length === 1 ? "" : "s"} — ${filters.join(" · ") || "all records"}.`
      : `No records match: ${filters.join(" · ")}.`,
    notes: slice.length === 0
      ? [`Nothing matched. Try broader terms — or check SEARCH for full-text hits.`]
      : [],
    stats: [{ label: "MATCHED", value: slice.length }],
    events: sortByPriority(slice).slice(0, 60),
    hint: filters.length ? null : "Try: \"NASA records from the 70s\" · \"redacted Iraq reports\"",
  };
}

// ---- Top-level dispatch ----------------------------------------------

export function ask(question, opts = {}) {
  const allEvents = opts.events || EVENTS;
  // Drop the auto-imported FBI section stubs from quantitative answers
  // unless the question is explicitly about them — they're not really
  // "records" in the curatorial sense, they're the unprocessed long tail.
  const events = allEvents.filter(e => !e.auto);

  const original = (question || "").trim();
  if (!original) {
    return {
      intent: "empty",
      headline: "Ask the dataset a question.",
      notes: [
        "I parse questions like \"what changed in Release 02\", \"what was classified before\", \"what's different about NASA\", or \"FBI records from the 50s\" and run them against the local catalogue.",
        "I don't read inside the documents — for that, use SEARCH (full-text) or SEMANTIC (meaning-based).",
      ],
      stats: [],
      events: [],
    };
  }
  const q = lc(original);

  const agency  = detectAgency(q);
  const release = detectRelease(q);
  const era     = detectEra(q);
  const year    = detectYear(q);
  const media   = detectMedia(q);

  let answer;
  if (isClassifiedBefore(q))     answer = answerClassifiedBefore({ events });
  else if (isUnclassified(q))    answer = answerUnclassified({ events });
  else if (isChanges(q))         answer = answerChanges({ events });
  else if (isDifferent(q) && agency) answer = answerDifferent({ events, agency });
  else if (isCount(q))           answer = answerCount({ events, agency, release, era, media });
  else if (agency || release || era || media || year) {
    const terms = year ? [year] : [];
    answer = answerFilter({ events, agency, release, era, media, terms });
  } else {
    // Fallback: keyword search over title / summary / tags / location.
    const terms = topicTerms(q);
    if (terms.length === 0) {
      answer = {
        intent: "unknown",
        headline: "I didn't recognize that question.",
        notes: [
          "Try one of: \"what's new in Release 02\" · \"what was classified beforehand\" · \"what's different about the NASA document\" · \"how many videos\" · \"FBI records from the 50s\".",
        ],
        stats: [], events: [],
      };
    } else {
      answer = answerFilter({ events, agency: null, release: null, era: null, media: null, terms });
      // Mark intent as keyword so the UI can label it
      answer.intent = "keyword";
    }
  }

  answer.query = { original, normalized: q, agency, release, era, year, media };
  return answer;
}

// Example questions for the UI's quick-start chips.
export const ASK_EXAMPLES = [
  "what changed in Release 02",
  "what was classified beforehand",
  "what is unredacted",
  "what's different about the NASA documents",
  "how many videos",
  "FBI records from the 50s",
  "Syria 2024",
  "anything from the 60s",
];

export { AGENCY_COLORS };
