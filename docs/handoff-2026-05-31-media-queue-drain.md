# Handoff: Media Library Queue Drain (2026-05-31)

This document is a self-contained brief for the next Claude Code session
to pick up where this one stopped. Read it top-to-bottom before touching
anything — the failure modes below ate ~5 sessions of progress.

---

## TL;DR

- **PR #260 is merged** → media library is at **324 tiles / 133 events**
  (+102 tiles, +71 events vs. the start of this workstream).
- **Remaining target:** drain the **418-PNG render queue** to extract
  ~15–25 more tiles. The high-value PDFs are `dow-uap-d48` (181 pp,
  scanned-image-heavy) and `dow-uap-d49` (113 pp). The rest is
  predominantly text-only mission-report forms that will classify out
  of MEDIA anyway.
- **Hard blocker this session:** the whipgen MCP server transport
  wedged repeatedly, then disconnected, then required OAuth re-auth
  — and the OAuth callback flow could not be completed end-to-end.
  See [the OAuth gotcha](#the-oauth-gotcha-read-this-first) below.

---

## Where to start (resume sequence)

1. **Read this entire doc.** Don't skip the OAuth section.
2. **Check git state** — confirm branch and that PR #260 is in `main`:
   ```bash
   git fetch origin main
   git log origin/main --oneline -5  # should include "Merge pull request #260"
   git branch --show-current          # expected: claude/dreamy-ptolemy-6Afl8 (or new branch)
   ```
3. **Probe whipgen** — call `whipgen_help` (no args, instant, no daemon
   round-trip). Three outcomes:
   - Returns the landing page → daemon is alive, jump to step 6.
   - Returns `No such tool available` → MCP server is in
     "requires authentication" state. Go to step 4.
   - Hangs 60s and times out → transport is wedged. Stop, do not retry
     more than twice. Tell the user the MCP server itself needs
     restarting on their end (Claude Code panel → MCP servers → kill /
     reconnect). No amount of session restarting from your side fixes
     this — confirmed across 4 consecutive restarts in the previous
     session.
4. **Run OAuth** if needed:
   ```
   call mcp__7912963c-66a7-4bc5-908d-244ffe2ad265__authenticate
   ```
   Share the returned `https://api.anthropic.com/authorize?...` URL with
   the user. **READ [the OAuth gotcha](#the-oauth-gotcha-read-this-first)
   before doing anything else.**
5. **Verify whipgen with one cheap call** after auth:
   `whipgen_status` should return instantly.
6. **Regenerate the render queue if `/tmp/render-queue/` is empty**
   (likely — `/tmp` is ephemeral and gets reclaimed when the container
   is torn down). See [Regenerating the queue](#regenerating-the-queue).
7. **Drain the queue.** See [Drain protocol](#drain-protocol).
8. Commit, push, open a draft PR titled something like
   `Media library fill — final 5% (d48 + d49 vision drain)`.

---

## The OAuth gotcha (READ THIS FIRST)

The whipgen MCP server is at
`https://whipgen-proxy-production.up.railway.app/mcp` and uses OAuth.
Auth state is **per session** — every new Claude Code session must
re-authenticate. The OAuth flow has a pitfall that wasted a full session:

### The flow

1. Claude calls `authenticate` and gets back a URL like
   `https://api.anthropic.com/authorize?response_type=code&client_id=...&redirect_uri=http%3A%2F%2Flocalhost%3A<port>%2Fcallback&state=...`.
2. User opens that URL in their browser and clicks **Authorize**.
3. Browser redirects to `http://localhost:<port>/callback?code=...&state=...`
   — and **this fails with a "page can't load" / connection-refused
   error**, because the user is not running an HTTP server on their
   laptop's `localhost:<port>`.
4. **The MCP server cannot detect that the user authorized.** Authorization
   does not auto-propagate. The user must copy the full URL from the
   browser address bar (the `http://localhost:<port>/callback?code=...&state=...`
   one — the one whose page failed to load) and paste it back into chat.
5. Claude then calls `complete_authentication` with that URL as
   `callback_url`. Only then do the whipgen tools register.

### What does NOT work

- Refreshing the Claude Code MCP panel / tools list. The user tried
  this repeatedly. It does nothing for OAuth completion.
- Telling Claude "it's reconnected" or "good to go" without pasting
  the callback URL. The server is still unauthorized; the tools will
  still show as `No such tool available`.
- Re-running `authenticate`. That just generates a new URL; doesn't
  help if the user won't paste the callback.

### How to coach the user

When you send the auth URL, be explicit:
> After you authorize, the browser will redirect to `http://localhost:<port>/callback?code=...&state=...`
> and that page **will fail to load — that is expected**. I need you
> to copy the entire URL from the browser's address bar (including
> `?code=...&state=...`) and paste it here. The MCP server has no
> way to know you authorized without that URL.

If they say "it's good" without pasting, verify by calling `whipgen_help`
before believing them.

---

## Mission context

The pursue-console media library surfaces visuals (photos, diagrams,
sketches, maps, transcripts) extracted from war.gov / FBI / NASA UAP
release PDFs. Coverage is tracked in `docs/media-coverage-audit.md`.

This workstream is about closing the gap between PDFs we have on disk
and tiles surfaced in `public/media.json`. The bulk of the gap was
closed by **PR #260** (`feat(media): rebuild media.json + roll up
fbi-photo B-series + surface FBI Sept 2023 serials`, merged 2026-05-31).

What's left is the long tail: events where the source PDF is on disk
but Gemini vision hasn't yet been run to classify each page's visuals.
The pipeline expects per-page Gemini transcripts in
`data-raw/.vision-cache/<eid>/p<NNNN>.gemini.txt` containing bracketed
visual markers like `[Photograph of …]`, `[Diagram of …]`, `[Sketch of
…]`, `[Map of …]`. From those, `extract-media-from-gemini.mjs` produces
`data-raw/.visuals/<eid>/p<NNNN>.json` records, `classify-visuals.mjs`
buckets them, and `build-media-index.mjs` emits `public/media.json`.

---

## Current branch + git state

- **Assigned branch:** `claude/dreamy-ptolemy-6Afl8` (per task spec).
- **Heads up:** this branch has a bunch of *unrelated* commits ahead
  of `main` (release_1 bulk PDF fetches, war.gov CSV ingestion fixes,
  events-auto normalization, etc.). Those are in-flight separate work,
  not part of the media library fill. If you commit the queue-drain
  output here, the eventual PR will conflate the two workstreams.
  **Recommendation:** branch off `main` for the queue-drain work
  (e.g. `claude/media-queue-drain-final`) and leave `claude/dreamy-ptolemy-6Afl8`
  alone unless the user explicitly says otherwise.
- **Recent media commits already in `main` (PR #260):**
  - `6203a0ab8` build(media): rebuild media.json — +73 tiles, +68 events
  - `9478dfc9d` feat(media): roll up fbi-photo B-series into fbi-photos-2025 (+23)
  - `2df6af532` feat(media): surface 3 FBI Sept 2023 serial photo sets (+6)
  - `82457d692` docs(media): session status — +102 tiles, +71 events
  - `beac50314` Merge PR #260

---

## Render queue — what was in `/tmp/render-queue/`

`/tmp` is ephemeral. By the time you read this it is probably gone.
The contents at the time of this handoff:

```
418 PNGs across 44 event directories, ~232 MB total
```

Top events by page count (the only ones likely to add tiles):

| Pages | Event ID | Notes |
|---:|---|---|
| 181 | `dow-uap-d48-department-of-the-air-force-report-1996` | **HIGH VALUE** — scanned Air Force report, expected diagram-rich |
| 113 | `dow-uap-d49-launch-summary-vandenberg-afb-2000` | **HIGH VALUE** — launch summary, likely chart/diagram-rich |
| 9 | `dow-uap-d62-mission-report-strait-of-hormuz-september-2020` | mission report form, probably text-only |
| 8 | `dow-uap-d65-mission-report-persian-gulf-july-2020` | mission report form |
| 8 | `dow-uap-d63-mission-report-strait-of-hormuz-october-2020` | mission report form |
| 7 each | `d54`, `d35`, `d61`, `d6`, `d64` | mission report forms |
| 6 each | `d12`, `d60`, `d5`, `d7` | mission report forms |
| 5 | `d4` | mission report form |
| 3 | `nasa-uap-d5-apollo-17-crew-debriefing-for-science-1973` | text-only crew debrief |
| 2 | `nasa-uap-d6-apollo-17-technical-crew-debriefing-1973` | text-only crew debrief |
| 23 | `fbi-photo-b{2..24}` | **ALREADY HANDLED** — rolled up into `fbi-photos-2025` in PR #260, PNGs are duplicates, skip |
| 6 | `fbi-september-2023-sighting-serial-{3,4,5}` | **ALREADY HANDLED** in PR #260, skip |

**Realistic remaining MEDIA tile gain:** ~15–25 tiles, almost all from
**d48 + d49** (~294 pages). Every other DOW mission-report cohort is
text-only intake forms (range fouler reports, sighting questionnaires)
that classify out of MEDIA. NASA Apollo debriefings are text-only.

---

## Regenerating the queue

The worklist is at `/tmp/render-worklist.json` (also ephemeral). To
recreate it from in-repo PDFs:

The source PDFs live at `public/release_1/*.pdf` (committed). The
worklist JSON had this shape:

```json
[
  { "eid": "dow-uap-d48-department-of-the-air-force-report-1996",
    "pdfPath": "/home/user/pursue-console/public/release_1/dow-uap-d48-report-september-1996.pdf",
    "pageCount": 181 },
  { "eid": "dow-uap-d49-launch-summary-vandenberg-afb-2000",
    "pdfPath": "/home/user/pursue-console/public/release_1/dow-uap-d49-launch-summary-february-2000.pdf",
    "pageCount": 113 }
]
```

To render PNGs from the PDFs at DPI 2.0 (what we used), the pattern from
`scripts/render-page-intrinsic.mjs` works — it uses
`pdfjs-dist/node_modules/@napi-rs/canvas/index.js` for canvas creation
(critical — the top-level @napi-rs/canvas package has a broken native
binding in this env). Adapt it to read a worklist instead of the
disputed-pages query.

**Shortcut for the next session:** if you only care about d48 + d49
(the only events that will add meaningful tiles), skip the worklist
and just render those two PDFs directly into
`/tmp/render-queue/<eid>/p<NNNN>.png`.

---

## Drain protocol

Once whipgen is alive and the queue is rendered:

1. **Per-page prompt template** (the previous session got 1 page
   through before the wedge — this prompt produced clean output):

   ```
   Transcribe the visible text on this scanned page. Preserve line
   breaks. For every distinct non-text visual element, insert on its
   own line a bracket marker in one of these forms:
     [Photograph of <subject>]
     [Sketch of <subject>]
     [Diagram of <subject>]
     [Map of <subject>]
     [Chart of <subject>]
     [Form field: <label>]   (use sparingly — only if a form is
                              visually distinctive, otherwise omit)
   Markers go inline at the point in the text where they appear.
   ```

2. **Tool call:** `whipgen_chat_with_files` with `provider: "gemini"`,
   files = array of PNG absolute paths, prompt = above. **Batch in
   groups of ~5 pages per call** to fit each response under the 8 MB
   result cap and the 60 s tool-call ceiling.

3. **Write per-page output** to
   `data-raw/.vision-cache/<eid>/p<NNNN>.gemini.txt`. The Gemini
   response will be concatenated for the whole batch — split on page
   separators (the prompt above doesn't enforce them; you may want to
   add `--- PAGE <N> ---` separator instructions and split on those).

4. **Build the index:**
   ```bash
   node scripts/extract-media-from-gemini.mjs
   node scripts/classify-visuals.mjs
   node scripts/build-media-index.mjs
   ```
   Sanity-check the diff in `public/media.json` — expected: ~15–25 new
   tile entries clustered under d48 + d49 events.

5. **Commit + push + draft PR.** Title like:
   `Media library fill — final 5% (d48 + d49 vision drain, +N tiles)`.

---

## Things that wasted time last session — do not repeat

- **Don't retry whipgen calls in a loop when wedged.** Two timeouts is
  enough signal. The transport will not self-heal during your session.
  Tell the user, stop, wait.
- **Don't restart the daemon as a heartbeat probe.** The MCP server
  instructions are explicit: restart drops every in-flight job. Use
  `whipgen_status` to check liveness; never use restart as a probe.
- **Don't believe "it's reconnected" without verifying.** Call
  `whipgen_help` after any reported reconnect/refresh. If it errors
  with `No such tool available`, OAuth still isn't complete.
- **Don't ask the user to "just paste the callback URL" without
  explaining what URL.** Quote the exact `http://localhost:<port>/callback?code=...&state=...`
  pattern, tell them it's the URL their browser tried to load and
  failed on, tell them the page error is expected.
- **Don't commit queue-drain output to `claude/dreamy-ptolemy-6Afl8`.**
  Branch off `main`.

---

## Files / paths cheat-sheet

| Path | What it is |
|---|---|
| `public/media.json` | The live media library that the UI reads |
| `public/release_1/*.pdf` | Source PDFs (committed, survives container) |
| `data-raw/.visuals/<eid>/p<NNNN>.json` | Per-page extracted-visual records |
| `data-raw/.vision-cache/<eid>/p<NNNN>.gemini.txt` | Gemini vision transcripts (input to extract step) |
| `scripts/render-page-intrinsic.mjs` | Reference for PDF→PNG rendering (uses pdfjs-dist nested canvas) |
| `scripts/extract-media-from-gemini.mjs` | Reads `.gemini.txt`, writes `.visuals/` JSONs |
| `scripts/classify-visuals.mjs` | Buckets visuals into media types |
| `scripts/build-media-index.mjs` | Emits `public/media.json` |
| `scripts/backfill-media-renders.mjs` | Generates the actual PNG tile files served by UI |
| `docs/media-coverage-audit.md` | Original audit identifying the gap |
| `docs/media-fill-session-status.md` | Earlier mid-session status doc (still accurate for pre-PR#260 state) |
| `/tmp/render-queue/<eid>/p<NNNN>.png` | Ephemeral render queue (gone after container reclaim) |
| `/tmp/render-worklist.json` | Ephemeral worklist of what to render |

---

## If the user just wants this DONE without the OAuth dance

A pragmatic alternative if the OAuth flow keeps failing: run a CLI
Gemini call locally (outside Claude Code's MCP transport) against the
d48 + d49 PNGs, write the transcripts to `data-raw/.vision-cache/`,
commit them, then have a Claude Code session run the
`extract → classify → build` pipeline on the committed transcripts.
That decouples the high-latency vision step from the MCP wedge. The
session can confirm + PR in a few minutes once the transcripts are in.
