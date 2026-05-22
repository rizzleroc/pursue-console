# How Can I Help?

A SETI@home-style distributed contribution model for the PURSUE corpus.

## Right now (live counts)

| Priority | Open | Concentrated in |
|---|---:|---|
| **P1** Settle disputed pages | **0** | queue is clear — 22 reevaluated, 3 settled by standardized prompt |
| **P2** Catalogue inventoried records | **52** | records inventoried but not yet curated into `src/data/events.js` |
| **P3** Image + context capture | live | pages classified as visuals — see the HELP tab for current counts |

Live counts on the [REVIEW tab](https://rizzleroc.github.io/pursue-console/) (with a badge in the nav) and the [HELP tab](https://rizzleroc.github.io/pursue-console/) (with per-event breakdown).

## Priority ladder — pick the highest open priority

> The corpus has three contribution paths. Please don't skip ahead — the lower numbers settle work that's blocking everything downstream.

### 1. Settle the review queue *(open now · highest leverage)*

Pages where Gemini and ChatGPT disagree on the transcription. Read both side-by-side and type the correct version. **One disputed page resolved = canonical text settled forever, used as gold to grade every machine source going forward.**

→ Open [the REVIEW tab](https://rizzleroc.github.io/pursue-console/) on the live console. The current count is shown in the nav as `⚖ N`.

To submit a settlement: drop the corrected `.txt` into `contributions/<your-handle>/human/<eid>/p<NNNN>.txt` and open a PR. No tooling required — just type the page out word-for-word from the source PDF.

### 2. Transcribe new pages *(open now · ChatGPT Plus or Gemini needed)*

Run the volunteer script — your own logged-in browser does the OCR via ChatGPT or Gemini, opens a PR with the transcripts. The setup is below.

> The script automatically writes a claim file so other volunteers skip these pages. Claims last 2 hours for OCR. No manual action needed.

### 3. Screenshot the visuals + context *(open now · ~1 hour per slice)*

Pages classified as containing visuals — photographs, hand-drawings, photocopied negatives, newspaper clippings, maps, or diagrams — need page screenshots **plus the verbatim documentary context from the surrounding pages**. What introduces this image? What's the caption? What does the page after say about it?

> The script automatically writes a claim file so other volunteers skip these pages. Claims last 24 hours for media capture. No manual action needed.

For newspaper clippings, also transcribe the article body so it becomes its own searchable doc in the corpus.

```bash
node scripts/volunteer-media.mjs --my-handle=YOU --slice=5     # claim + render
# (fill in the markdown templates at ~/.pursue-helper/media-staging/)
node scripts/volunteer-media.mjs --my-handle=YOU --commit      # commit + PR
```

Full spec: [VISUAL-EXTRACTION-PROCESS.md](./VISUAL-EXTRACTION-PROCESS.md). The two-phase flow exists because typing rich context in a terminal is miserable; doing it in a text editor with the rendered page open alongside is not.

---

## Quick-start for Priority 2 (transcribe new pages)

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
5. Writes results to `contributions/<your-handle>/gpt-vision/<event-id>/p<NNNN>.txt`
6. Opens a pull request

### Contribution path convention

```
contributions/<your-handle>/<source>/<event-id>/p<NNNN>.txt
```

`<source>` records *how* the text was produced. This is what lets the corpus separate machine OCR from human ground truth and score every machine source against the human gold over time:

| `<source>` | What it means | How to submit |
|---|---|---|
| `gpt-vision` | ChatGPT vision through the volunteer flow | Default — what `npm run volunteer` writes |
| `gemini` | Gemini vision (per Denis's pipeline) | Run a Gemini variant of the volunteer script |
| `human` | **Typed by a person, word-for-word from the source page** | Drop your `.txt` into `contributions/<handle>/human/<eid>/p<NNNN>.txt` by hand, open a PR |
| `ocr` | Plain tesseract/poppler output | Maintainer pipeline only |

`human` is reserved — automation never writes there. A page in `human/` becomes the canonical text for that page no matter how many machine sources also have it, **and is used as gold to grade every machine source.** One hand-typed page is worth more than a dozen machine passes for calibrating the pipeline.


CI auto-validates against `JUDGE-STANDARD.md`. A maintainer reviews and merges. Your transcriptions are in the next deploy.

---

## Why this exists

OCR is non-deterministic and lossy. The same page run twice gives slightly different output; the same page through different OCR engines (tesseract, GPT-4o vision, Claude vision, Gemini) gives substantially different output. **Multiple independent transcriptions of the same page are higher-confidence than one.**

The original bottleneck — a single ChatGPT Plus account grinding through a raw-OCR backlog — is gone. The 2.0 Gemini sync brought the whole corpus to vision-quality coverage, so there's no longer a wall of tesseract-noise pages to replace. The open work now is narrower and more human: settling the REVIEW queue when machine sources genuinely disagree, cataloguing the records that are inventoried but not yet curated into `src/data/events.js`, and adding human context to pages classified as visuals. Live counts for each live on the REVIEW and HELP tabs.

The deliberate design goals:
- **No central server.** Everything coordinates through GitHub. The work queue is a static JSON file on GH Pages; submissions are pull requests; review is the existing PR comment thread; the corpus is the merged main branch.
- **No API keys needed.** The bundled [`pursue-vision-mcp`](./pursue-vision-mcp/) daemon drives the volunteer's already-logged-in ChatGPT browser. The volunteer never gives us their credentials.
- **Convergent transcription.** Multiple submissions for the same page are valuable signal, not duplicates. The grading pipeline scores agreement and prefers the most-corroborated text.
- **All contributions visible.** Submitted, in-review, accepted, rejected — every interpretation is part of the public record. Rejected ones can be resubmitted; the validator gives concrete reasons.

---

## How claim tracking works

When you run a volunteer script, it writes a claim file to `contributions/<handle>/claims/<eid>/p<NNNN>.json` and includes it in your PR. After merge, other volunteers' scripts see the claim and skip those pages automatically.

Key rules:

- **Claims are advisory.** The merged PR is the final arbiter of what's in the corpus — claims just reduce redundant effort.
- **First 3 passes on any page are allowed** (consensus building — more independent transcriptions improve confidence).
- **After 3 same-type passes, that slot is considered full.** New volunteers are routed to other pages.
- **Different task types always coexist.** A vision OCR claim and a visual media claim on the same page don't block each other.
- **Propagation latency is minutes**, not instant — claims become visible to others only after your PR is merged and the next deploy runs.

Claim lifetimes: OCR/vision claims expire after **2 hours**; media/visual claims expire after **24 hours**. Expired claims are ignored.

---

## System map

```
┌──────────────────────────────────────────────────────────────────────┐
│                    THE WORK QUEUE (static, public)                   │
│         public/work-available.json   ← generated each rebuild         │
│   {                                                                  │
│     "totalPagesNeeded": 0,   // raw-OCR backlog cleared in 2.0       │
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
        │  contributions/<handle>/<source>/<eid>/p<NNNN>.txt │
        │  + contributions/<handle>/media/<eid>/p<NNNN>.json │
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
| **uncatalogued** | ~52 records | Requires curation, not just OCR — see "Cataloguing" below |

Total: **~52 records to catalogue.** The raw-OCR backlog is essentially cleared after the 2.0 vision sync; the remaining curation work needs human judgment, not a transcription pass. See the live HELP tab for current counts.

---

## How the volunteer mode works

The `scripts/volunteer.mjs` command does this loop:

1. **Fetch work** — `GET https://rizzleroc.github.io/pursue-console/work-available.json`
2. **Pick a slice** — first N pages whose event id you haven't already contributed to (deterministic by your handle so two volunteers don't pick the same pages by accident)
3. **Download PDFs** — directly from `war.gov/UFO`. We never proxy your traffic; you talk to war.gov yourself.
4. **Render + batch + OCR** — same pipeline as the maintainer's. Pacing + breaks behave naturally so you don't hit ChatGPT rate limits.
5. **Write contributions** — `contributions/<your-handle>/<source>/<event-id>/p<NNNN>.txt` + media `.json` for visuals
6. **Open PR** — via `gh pr create`. You'll be prompted once to authenticate the GitHub CLI.

Stop the script any time. Re-run later to pick up where you left off. Your contributions are credited to your GitHub handle in commit history and `CONTRIBUTORS.md`.

---

## What gets contributed

### Per-page text (the standard contribution)

```
contributions/<handle>/<source>/<event-id>/p<NNNN>.txt
```

Verbatim transcription of the page, identical format to the maintainer's `data-raw/.vision-cache/` cache. Validated against [JUDGE-STANDARD.md](./JUDGE-STANDARD.md) — schema, safety, lexical quality, FAISS semantic authenticity.

### Per-page visual content (optional but encouraged)

```
contributions/<handle>/media/<event-id>/p<NNNN>.json
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
For pages flagged as `kind: photo` or `kind: sketch`, extract the image region (bounding box) from the PDF and save it as `contributions/<handle>/media/<eid>/p<NNNN>-<kind>-<idx>.png`. The DOSSIER VISUAL CONTENT panel renders these inline. Lets the corpus become **visually inspectable**, not just text-searchable.

### Sketch enrichment (manual / AI-rendered)
For low-quality sketches and faded composite drawings, contributors can submit a "cleaned up" version:

```
contributions/<handle>/media/<eid>/p<NNNN>-sketch-<idx>-rendered.png
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

52 of the 173 records in Release 01 are **not yet in `src/data/events.js`** at all. Adding a record needs human judgment — the title, the date, the location, the agency, what kind of record it is, a 1-3 sentence summary. This is harder than transcription and can't be automated.

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

High-volume contributors who consistently pass on the first try are recognized in `CONTRIBUTORS.md` and may get expedited review — an informal, planned mechanism where their `?-review`-band files get less scrutiny.

---

## Security note

Same as `pursue-vision-mcp/SECURITY.md`. Three things to be clear about:

- **Your ChatGPT credentials never leave your machine.** The volunteer daemon drives your already-signed-in Chrome via local CDP. No credentials are sent anywhere.
- **We never touch your traffic.** PDF downloads go directly from war.gov to your machine. OCR calls go from your Chrome to chatgpt.com. The only outbound from this repo's tooling is to `github.com` (for the PR) and your daemon's loopback (for orchestration).
- **The work-available.json is a public artifact.** It contains no PII. The contributions you submit are public from the moment you push them.

---

## Questions

Open an issue tagged `help-wanted` or `contributor-question`. The model only works if the doc is honest and the bar is low to start — ask anything.
