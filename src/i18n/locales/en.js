// English source dictionary. This is the canonical key set — every
// other locale falls back here when a key isn't translated yet, so
// adding a new UI string starts here.
//
// Conventions:
//   - keys are dot-pathed: nav.live, footer.source, ...
//   - placeholders use {name} (single-brace) — see i18n/index.jsx
//   - keep keys descriptive of intent, not of layout (e.g.
//     `volunteer.priority1.cta` not `volunteer.amber_button`).
//   - ALL-CAPS English values stay all-caps because the typographic
//     design depends on it; translations use natural case in their
//     own script.

export default {
  language: {
    picker_label: "Language",
    picker_aria: "Change interface language",
    current: "Current language",
  },
  nav: {
    live:     "LIVE",
    search:   "SEARCH",
    semantic: "SEMANTIC",
    ask:      "ASK",
    review:   "REVIEW",
    media:    "MEDIA",
    dossier:  "DOSSIER",
    timeline: "TIMELINE",
    atlas:    "ATLAS",
    globe:    "GLOBE",
    network:  "NETWORK",
    help:     "HELP",
    analysis: "ANALYSIS",
    go_to_live: "Go to LIVE",
  },
  header: {
    release_label: "release 2.1",
    release_title: "View 2.0 changelog",
    records: "{catalogued} / {total} records",
    pages: "{pages} pages",
    volunteer_cta: "+ VOLUNTEER",
    volunteer_title: "Help transcribe a page",
  },
  filter: {
    label: "FILTER",
    search_placeholder: "SEARCH RECORDS...",
    search_aria: "Search records",
    all_agencies: "ALL AGENCIES",
    all_releases: "ALL RELEASES",
    all_types:    "ALL TYPES",
    filtering: "FILTERING",
    clear_all: "clear all",
    clear_one_title: "Clear filter: {label}",
  },
  type: {
    document: "Document",
    video:    "Video",
    image:    "Image",
    audio:    "Audio",
  },
  app: {
    loading_ask: "LOADING ASK",
    loading_semantic_title: "LOADING SEMANTIC SEARCH ENGINE",
    loading_semantic_size: "~25 MB ORT WASM + INT8 model (first visit only — cached in IndexedDB after)",
    loading_semantic_hint: "on a slow connection this can take 30+ seconds. SEARCH (lexical) is available now if you'd rather not wait.",
  },
  footer: {
    source: "▌ SOURCE: WAR.GOV/UFO {releases} // CLEARED MAY 8 + MAY 22, 2026",
    unresolved: "▌ ALL CASES UNRESOLVED — GOVERNMENT UNABLE TO MAKE DEFINITIVE DETERMINATION",
    interagency: "▌ INTERAGENCY: WHITE HOUSE / ODNI / DOE / AARO / NASA / FBI / DOW",
    compact: "▌ war.gov/UFO · {releases} catalogued",
  },
  volunteer: {
    title: "+ VOLUNTEER",
    close: "Close",
    priority1_label: "PRIORITY 1 · DO THIS FIRST",
    priority1_lead: "Settle the {count} disputed pages where Gemini and ChatGPT disagree.",
    priority1_body: "Read both transcriptions side-by-side, type the correct version. One disputed page resolved = canonical text settled forever.",
    priority1_cta: "OPEN REVIEW QUEUE →",
    priority2_label_with_review: "PRIORITY 2 · ALSO OPEN",
    priority2_label_primary: "PRIMARY",
    transcribe_heading: "TRANSCRIBE NEW PAGES",
    transcribe_lead: "Two setup paths below — both go through the same validator and land in the search index.",
    path_a_label: "PATH A · MACHINE OCR (CHATGPT, GEMINI, OR CLAUDE ACCOUNT REQUIRED)",
    path_a_body: "Picks pages off the public queue, transcribes them via your already-logged-in ChatGPT, Gemini, or Claude browser tab, opens a PR. No API key, no payment, ~30 min of mostly-idle compute.",
    path_a_provider_hint: "Pick which logged-in tab does the OCR with {chatgpt}, {gemini}, or {claude} ({claudeLink}). Same flow: sign in once in a browser tab, the daemon attaches — no credentials shared.",
    path_a_setup_link: "full setup guide →",
    path_b_label: "PATH B · HAND-TYPED (NO TOOLS REQUIRED)",
    path_b_body: "Read a page from the source PDF, type it out word-for-word, save as {ext}, open a PR. One hand-typed page outranks every machine transcription for that page and is used as gold to calibrate every machine source.",
    path_b_hint: "Pick from the REVIEW queue first — those are the pages where machine sources currently disagree, so your eyes pay off most.",
    priority3_label: "PRIORITY 3 · OPEN NOW",
    priority3_title: "Screenshot the visuals + context",
    priority3_body: "For pages with photographs, hand-drawings, newspaper clippings, maps, or diagrams: capture the page image and write the documentary context (verbatim quotes from the surrounding pages). Two-phase: claim → fill template → commit.",
    priority3_spec_link: "full visual-extraction spec →",
    credit_note: "Every contribution gets credited to your handle in {contributorsLink} (auto-generated). The handle you pass to {flag} becomes public in the corpus DB and in the PR you open — use whatever you'd want shown. You stay in your own GitHub account; no central server holds your work.",
    sanity_check: "Before your first run, sanity-check your setup in 30 seconds: {cmd}",
  },
  launch: {
    aria_label: "PURSUE Console 2.0 launch",
    close: "Close",
    eyebrow: "INCOMING TRANSMISSION · WAR.GOV/UFO",
    title_eyebrow: "PURSUE CONSOLE",
    intro_p1_a: "The disclosure drop is",
    intro_p1_live: "live",
    intro_p1_b: ". Declassified sensor footage, full-text reading mode, the entity-network graph, semantic search — all unlocked. Start with the clips the analysts couldn't explain.",
    reel: "▌ DECLASSIFIED REEL · {count}",
    enter: "ENTER CONSOLE →",
    sub: "ALL CASES UNRESOLVED · RELEASE 01 · MAY 8 2026",
    skip: "SKIP INTRO",
    flag: {
      anchor: "ANCHOR",
      high: "HIGH",
      med: "MED",
    },
  },
  freshness: {
    loading: "LOADING…",
    error_prefix: "STATS ERR ·",
    label_age: "BUILD",
    just_now: "just now",
    seconds: "{n}s ago",
    minutes: "{n}m ago",
    hours: "{n}h ago",
    days: "{n}d ago",
  },
};
