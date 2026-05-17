# How Can I Help?

A SETI@home-style distributed contribution model for the PURSUE corpus. Anyone with a ChatGPT Plus account, a Chrome profile, and a few hours of idle compute can take a slice of the OCR backlog and contribute it back. The maintainer's own ChatGPT quota stops being the bottleneck.

This document is the **architecture spec + quick-start.** If you just want to volunteer:

### One-command setup (lean, ~10 MB instead of the full ~1 GB repo)

**macOS / Linux**
```bash
curl -fsSL https://rizzleroc.github.io/pursue-console/install-helper.sh | bash
```

**Windows PowerShell**
```powershell
iwr https://rizzleroc.github.io/pursue-console/install-helper.ps1 | iex
```

That sparse-checkouts only the directories a helper needs (`pursue-vision-mcp/` + `scripts/volunteer.mjs` + the events catalog + the docs you're reading) and installs the daemon. Skips the static assets (90 MB of ORT WASM, the corpus text, embeddings) that helpers never need.

Then:

```bash
cd pursue-helper
npm start --prefix pursue-vision-mcp        # launches Chrome + daemon (9223) + MONITOR (9224)
# in another terminal:
node scripts/volunteer.mjs --my-handle=YOU --slice=20
```

`npm start` brings up two independent processes:

- **MCP daemon** at `http://127.0.0.1:9223` — handles ChatGPT vision OCR. Single-responsibility.
- **Helper monitor** at `http://127.0.0.1:9224` — the live progress dashboard. Auto-opens in your default browser. Persists state to `~/.pursue-helper/progress.json` so it survives daemon restarts.

You can also run them separately:
```bash
npm run daemon  --prefix pursue-vision-mcp    # MCP only
npm run monitor --prefix pursue-vision-mcp    # dashboard only (useful to inspect last session)
npm run monitor:tui --prefix pursue-vision-mcp   # terminal-only dashboard, no browser
```

### Manual setup (if you want the full repo)

```bash
git clone https://github.com/rizzleroc/pursue-console
cd pursue-console/pursue-vision-mcp
npm install
npm start
# in another terminal:
cd ..
node scripts/volunteer.mjs --my-handle=YOU --slice=20
```

That's it. The script:
1. Fetches the public `work-available.json` listing pages that still need vision OCR
2. Claims a slice of 20 unprocessed pages (configurable)
3. Downloads the source PDFs directly from `war.gov/UFO` (no auth needed)
4. Renders, batches, and OCRs them via your own ChatGPT browser session
5. Writes results to `contributions/<your-handle>/<event-id>/p<NNNN>.txt`
6. Opens a pull request

CI auto-validates against `JUDGE-STANDARD.md`. A maintainer reviews and merges. Your transcriptions are in the next deploy.

---

## Why this exists

OCR is non-deterministic and lossy. The same page run twice gives slightly different output; the same page through different OCR engines (tesseract, GPT-4o vision, Claude vision, Gemini) gives substantially different output. **Multiple independent transcriptions of the same page are higher-confidence than one.**

Also: the maintainer has one ChatGPT Plus account. Release 01 alone has 597+ pages of tesseract-noise replacement work, plus 110 records still to catalogue. At ~20 pages per hour through one account, it's a ~50-hour bottleneck. A dozen volunteers turning their own otherwise-idle compute on it for an evening clears the backlog in a week.

The deliberate design goals:
- **No central server.** Everything coordinates through GitHub. The work queue is a static JSON file on GH Pages; submissions are pull requests; review is the existing PR comment thread; the corpus is the merged main branch.
- **No API keys needed.** The bundled [`pursue-vision-mcp`](./pursue-vision-mcp/) daemon drives the volunteer's already-logged-in ChatGPT browser. The volunteer never gives us their credentials.
- **Convergent transcription.** Multiple submissions for the same page are valuable signal, not duplicates. The grading pipeline scores agreement and prefers the most-corroborated text.
- **All contributions visible.** Submitted, in-review, accepted, rejected — every interpretation is part of the public record. Rejected ones can be resubmitted; the validator gives concrete reasons.

---

## System map

```
┌──────────────────────────────────────────────────────────────────────┐
│                    THE WORK QUEUE (static, public)                   │
│         public/work-available.json   ← generated each rebuild         │
│   {                                                                  │
│     "totalPagesNeeded": 597,                                         │
│     "byEvent": {                                                     │
│       "incident-summaries": { pdfUrl, totalPages: 202,               │
│                                pagesCompleted: 41,                   │
│                                pagesQueued: [{page: 42, ...}, ...] },│
│       ...                                                            │
│     }                                                                │
│   }                                                                  │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                  ┌───────────────┼───────────────┐
                  ▼               ▼               ▼
        ┌─────────────────┐  ┌─────────┐  ┌─────────────────┐
        │  VOLUNTEER A    │  │   ...   │  │  VOLUNTEER N    │
        │  pursue-vision  │  │         │  │  pursue-vision  │
        │       mcp       │  │         │  │       mcp       │
        │  • their Chrome │  │         │  │                 │
        │  • their CHATGPT│  │         │  │                 │
        │  • their cycles │  │         │  │                 │
        └────────┬────────┘  └────┬────┘  └────────┬────────┘
                 │                 │                 │
                 │ git push        │                 │
                 ▼                 ▼                 ▼
        ┌──────────────────────────────────────────────────┐
        │  GITHUB PULL REQUESTS                            │
        │  contributions/<handle>/<eid>/p<NNNN>.txt        │
        │  + contributions/<handle>/<eid>/p<NNNN>.json     │
        │    (visual descriptions)                         │
        └────────────────────┬─────────────────────────────┘
                             │
                             ▼
        ┌──────────────────────────────────────────────────┐
        │  CI: .github/workflows/validate-contribution.yml │
        │  • Gate 1-3 (Node):  schema · safety · lexical   │
        │  • Gate 4   (FAISS): doc affinity · canonical    │
        │                       agreement · neighbor       │
        │                       continuity                 │
        │  Posts the per-file matrix as a PR comment       │
        └────────────────────┬─────────────────────────────┘
                             │
                             ▼
        ┌──────────────────────────────────────────────────┐
        │  MAINTAINER REVIEW                               │
        │  Pass band → squash + merge                      │
        │  Review band → comment, fix, re-validate         │
        │  Reject band → close (volunteer can revise)      │
        └────────────────────┬─────────────────────────────┘
                             │
                             ▼
        ┌──────────────────────────────────────────────────┐
        │  npm run corpus:rebuild + git push               │
        │  → new vision pages in embeddings.bin            │
        │  → updated work-available.json                   │
        │  → LIVE feed shows the new transcriptions        │
        └──────────────────────────────────────────────────┘
```

---

## What's needed (today)

After the latest rebuild, `public/work-available.json` lists what pages still need vision OCR. Roughly:

| Doc | Pages remaining | Difficulty |
|---|---:|---|
| `incident-summaries` | ~170 | Mid — Project Blue Book scanned forms |
| `fbi-62hq83894` | 185 | **Hard** — pdfjs renderer chokes on most pages (need BYO renderer or different approach) |
| `cometa` | ~36 | Easy — clean French scans |
| `1949-discs` | ~90 | Mid — early FBI files |
| **partial-vision docs** (apollo-17, shaef, azerbaijan, ...) | ~30 | Mid — page-by-page mop-up |
| **uncatalogued** | ~110 records | Requires curation, not just OCR — see "Cataloguing" below |

Total: **~520 pages of OCR work + 110 records to catalogue.** A volunteer doing 30 pages an evening clears their slice in an hour.

---

## How the volunteer mode works

The `pursue-vision-mcp/volunteer.mjs` command does this loop:

1. **Fetch work** — `GET https://rizzleroc.github.io/pursue-console/work-available.json`
2. **Pick a slice** — first N pages whose event id you haven't already contributed to (deterministic by your handle so two volunteers don't pick the same pages by accident)
3. **Download PDFs** — directly from `war.gov/UFO`. We never proxy your traffic; you talk to war.gov yourself.
4. **Render + batch + OCR** — same pipeline as the maintainer's. Pacing + breaks behave naturally so you don't hit ChatGPT rate limits.
5. **Write contributions** — `contributions/<your-handle>/<event-id>/p<NNNN>.txt` + `.json` for visuals
6. **Open PR** — via `gh pr create`. You'll be prompted once to authenticate the GitHub CLI.

Stop the script any time. Re-run later to pick up where you left off. Your contributions are credited to your GitHub handle in commit history and `CONTRIBUTORS.md`.

---

## What gets contributed

### Per-page text (the standard contribution)

```
contributions/<handle>/<event-id>/p<NNNN>.txt
```

Verbatim transcription of the page, identical format to the maintainer's `data-raw/.vision-cache/` cache. Validated against [JUDGE-STANDARD.md](./JUDGE-STANDARD.md) — schema, safety, lexical quality, FAISS semantic authenticity.

### Per-page visual content (optional but encouraged)

```
contributions/<handle>/<event-id>/p<NNNN>.json
```

Structured list of photographs, diagrams, sketches, maps, charts, annotations on each page:

```json
[
  { "kind": "photo", "description": "black-and-white aerial photo of a desert airstrip with two parked aircraft, no caption" },
  { "kind": "annotation", "description": "red ink arrow pointing at a small dot in the upper-right quadrant" }
]
```

These flow into the DOSSIER view's **VISUAL CONTENT** panel.

---

## Phase 2 — coming, not yet shipped

The architecture supports these naturally but they need more code:

### Image extraction with coordinates
For pages flagged as `kind: photo` or `kind: sketch`, extract the image region (bounding box) from the PDF and save it as `contributions/<handle>/<eid>/p<NNNN>-<kind>-<idx>.png`. The DOSSIER VISUAL CONTENT panel renders these inline. Lets the corpus become **visually inspectable**, not just text-searchable.

### Sketch enrichment (manual / AI-rendered)
For low-quality sketches and faded composite drawings, contributors can submit a "cleaned up" version:

```
contributions/<handle>/<eid>/p<NNNN>-sketch-<idx>-rendered.png
```

with a metadata sidecar describing the provenance:

```json
{ "method": "stable-diffusion-xl",
  "prompt": "metallic ellipsoid craft, bronze, 130-195 feet long, hovering over desert at dusk, based on FBI 302 composite",
  "rendered_at": "2026-05-20T...",
  "submitted_by": "@handle",
  "kind": "ai-rendered" }
```

These get **labeled in the UI as `AI-RENDERED`** so viewers always know what's primary-source vs. interpretive. They never overwrite the original — they're presented as inspired-by, alongside it.

### Authenticated interpretations library
Contributions go through a maintainer-graded **authentication tier**:

| Tier | Where it appears |
|---|---|
| `submitted` | Public draft area (anyone can browse, vote, comment) |
| `under-review` | Maintainer has the file open |
| `authenticated` | Merged into canonical corpus, citable |
| `rejected` | Public reject list with reason; resubmittable |

The "unauthenticated area" exists so wild but useful interpretations stay visible. The bar for authentication is high so the search index stays trustworthy.

### Voting & community review UI
PR comments are already the discussion thread. Phase 2 adds a tiny UI overlay so non-developers can vote on interpretations directly.

---

## Cataloguing (different from OCR)

110 of the 162 records in Release 01 are **not yet in `src/data/events.js`** at all. Adding a record needs human judgment — the title, the date, the location, the agency, what kind of record it is, a 1-3 sentence summary. This is harder than transcription and can't be automated.

If you want to catalogue rather than OCR:

1. Pick an unmoderated record from the war.gov inventory not in `events.js`
2. Add an entry following the existing shape (look at any current record for template)
3. Open a PR with just that addition

Once catalogued, the OCR pipeline can pick it up automatically.

---

## Credit

Every contributor is credited in:

- **Commit history** — your GitHub handle on every merged PR
- **`CONTRIBUTORS.md`** — auto-generated by maintainer after each merge wave
- **The dossier** itself — for AI-rendered contributions, the metadata shows your name + method + tools used

High-volume contributors who consistently pass on the first try get added to `TRUSTED-TRANSCRIBERS.md` and gain expedited review (their `?-review`-band files get less scrutiny).

---

## Security note

Same as `pursue-vision-mcp/SECURITY.md`. Three things to be clear about:

- **Your ChatGPT credentials never leave your machine.** The volunteer daemon drives your already-signed-in Chrome via local CDP. No credentials are sent anywhere.
- **We never touch your traffic.** PDF downloads go directly from war.gov to your machine. OCR calls go from your Chrome to chatgpt.com. The only outbound from this repo's tooling is to `github.com` (for the PR) and your daemon's loopback (for orchestration).
- **The work-available.json is a public artifact.** It contains no PII. The contributions you submit are public from the moment you push them.

---

## Questions

Open an issue tagged `help-wanted` or `contributor-question`. The model only works if the doc is honest and the bar is low to start — ask anything.
