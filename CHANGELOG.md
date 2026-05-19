# Changelog

## 2.0 — Blended-data investigation desk

The reframing release. The console stops being "twelve visualizations over a shared corpus" and starts being **"every page has 1–4 transcription sources, the system tells you where they agree, surfaces where they don't, and routes disputes to humans."**

### Data architecture

- **Single source of truth: `data-raw/corpus.sqlite`.** New `scripts/db-rebuild.mjs` regenerates a SQLite DB from on-disk truth (sidecars, caches, contributions) on every build. Five tables: `inventory`, `events`, `pages`, `contributions`, `runs`. Every dashboard count derives from one SQL query — no more disagreeing numbers across views.
- **Per-source provenance per page.** Every page now has a sidecar `p<NNN>.sources.json` recording which sources (`gemini`, `gpt-vision`, `human`, `ocr`) have transcribed it, plus a per-source text file `p<NNN>.<source>.txt`. Nothing is overwritten when a new source arrives; the winning source becomes canonical (`p<NNN>.txt`).
- **Cross-source agreement scoring** (`scripts/compare-sources.mjs`). Token Jaccard + length ratio across every pair of sources. Pages with agreement <0.50 get `needs_review=1` and bubble to the REVIEW queue.
- **Standardized re-evaluation** (`scripts/reevaluate-disputed.mjs`). Disputed pages get re-run through both providers via the new MCP `/fanout` endpoint with one canonical prompt. Outcomes get classified: `prompt-variance` (resolved), `page-intrinsic` (escalate to human), `partial-improvement`.
- **Per-page visual classification** (`scripts/classify-visuals.mjs`). Each transcribed page goes through a kind classifier (`photograph` / `hand-drawing` / `photocopied-negative` / `newspaper-clipping` / `map` / `diagram` / `text-only`). Non-text pages get a screenshot saved to `public/media/<eid>/p<NNN>.jpg`.
- **Inventory sync from upstream.** `scripts/sync-inventory.mjs` pulls the war.gov PDF manifest from [DenisSergeevitch/UFO-USA](https://github.com/DenisSergeevitch/UFO-USA) (war.gov blocks our IPs via Akamai). Inventory total jumped from a press-release guess (162) to a real reconciled count (173).

### MCP daemon (pursue-vision-mcp 0.1 → 0.2)

- **Gemini support** via new `gemini-driver.mjs` — slim port of the upstream driver. Same lifecycle as ChatGPT: connect, upload, prompt, wait. ~220 LoC.
- **`POST /chat-with-files` accepts `provider`** (`chatgpt` or `gemini`). Per-provider single-slot queues run in parallel (different tabs, different network paths).
- **`POST /fanout`** sends the same prompt + files to both providers concurrently for side-by-side comparison. Used by the re-evaluation pipeline.
- **`start.mjs` opens both tabs** on launch (chatgpt.com + gemini.google.com/app). Sign in once per provider.

### UI editorial pass

- **Nav consolidated.** 13 flat tabs → 5 primary (LIVE · SEARCH · SEMANTIC · REVIEW · DOSSIER) + 4 analysis (TIMELINE · ATLAS · GLOBE · NETWORK). MEDIA + HELP land between primary and analysis. Old views deleted: PATTERNS (folded into NETWORK), THREADS, CONSTELLATION.
- **REVIEW tab.** New cross-source disagreement queue. Worst-first. Side-by-side pane per source with pairwise agreement scores and vs-human gold scores. Count badge in the nav (`⚖ 19`).
- **MEDIA tab.** New visual library. Grid view of every page classified as non-text. Filter by kind / agency / event. Click → modal with description + "OPEN IN DOSSIER" deep-link.
- **NETWORK upgrade.** Pattern nodes (shape/behavior/sensor from `patterns.json`). Event nodes colored by dominant best transcription source. Sized by log(chars). Amber dashed ring if pages need review.
- **Hero only on LIVE.** Other views go header → CorpusFreshness → view. Saves ~250 px above the fold everywhere.
- **One-line CorpusFreshness strip** on non-LIVE views: `121/173 records · 3,376 pages · refreshed Nm ago`.
- **Reusable `SourceMix` component** with static Tailwind classes (fixes the v3 template-string stripping bug that left ReviewView badges colorless). Dropped into TIMELINE, ATLAS, REVIEW, NETWORK.
- **+ VOLUNTEER button** pinned to the header brand row. Opens a modal with the three-priority ladder (REVIEW first, transcribe second, image+context third).
- **Header stamps `release 2.0`**; `package.json` bumped 0.0.0 → 2.0.0.
- **Bundle size:** main JS chunk dropped 893 KB → 400 KB (gzip 224 → 114).

### Volunteer flow

- **Three-priority ladder** mirrored across HELP view, VolunteerModal, HOW-CAN-I-HELP.md:
  1. Settle the REVIEW queue (no tooling)
  2. Transcribe new pages (`scripts/volunteer.mjs`, now with `--provider=gemini`)
  3. Image + context capture (`scripts/volunteer-media.mjs`, two-phase claim/commit)
- **Reserved `human` source.** Only hand-typed-word-for-word pages get `source: "human"` and become canonical-by-default. The volunteer OCR flow now writes to `contributions/<handle>/gpt-vision/<eid>/` or `.../gemini/<eid>/` instead. One-time migration moved the 18 existing volunteer pages out of the `human` slot.
- **Media submission path.** `contributions/<handle>/media/<eid>/p<NNN>.{json,jpg}` — image + verbatim documentary context. Importer + validator + claim API + volunteer flow all land in 2.0.

### Diagnostics + scheduled jobs

- **`scripts/diagnose-coverage.mjs`** — per-event matrix (complete · gap · mismatch · no-data).
- **`scripts/diagnose-page-alignment.mjs`** — off-by-one sanity check between sources (passes cleanly on all 11 multi-source events).
- **`.github/workflows/faiss-rebuild.yml`** — every 4h, only when input hash changed. No commit pollution.
- **`.github/workflows/backup.yml`** extended to snapshot `corpus.sqlite` + media artifacts every 6h.

### Validator + CI

- **PR validator handles media submissions** (`validateMediaItem`): kind enum, title ≥4, context ≥20 verbatim chars, image present + 5KB–5MB, safety scan on text fields.
- **Path-aware walker** in both Node + Python validators accepts the new `<handle>/<source>/<eid>/` and `<handle>/media/<eid>/` shapes; legacy `<handle>/<eid>/` still accepted, labeled `gpt-vision`.
- **`actions/setup-python@v5 cache: pip` removed** from `validate-contribution.yml` — it required a manifest we don't ship and was silently failing every validator run before any gate fired.

### Post-2.0 patch (2026-05-19)

- **fix: reeval block was being wiped from sidecars on every recompute.**
  `compare-sources.mjs` read `sidecar.comparison.reevaluation` then overwrote
  the whole `comparison` object without restoring the field. The .v2.txt
  files stayed on disk but the metadata pointer was lost, so subsequent
  builds couldn't re-detect the resolved disputes — REVIEW kept showing 22
  instead of 19. Fix: detect .v2 files directly via filesystem glob (idempotent),
  preserve + write back the reevaluation block.
- **new: `npm run corpus:sync-check`** (`scripts/diagnose-deploy-sync.mjs`).
  Diffs every count + freshness signal between local build artifacts and the
  live github.io deploy. One-screen audit so "the numbers aren't going down"
  is a 2-second check, not a manual `curl` exercise.

### Stats at release

- 173 records inventoried · 121 catalogued · 3,376 pages transcribed
- 425 pages have ≥2 source transcriptions · 19 currently flagged for review
- 3 disputed pages already settled by standardized re-evaluation (`prompt-variance`)
- Page-alignment sanity check passes on all 11 multi-source events (aligned Jaccard 0.77–0.99 vs shift-by-1 0.07–0.23)

---

## 1.x — Pre-2.0 (archived)

The pre-rebrand console. Twelve visualization tabs, hand-curated everything, no cross-source comparison, no DB. Worked for getting the first 52 records online; couldn't keep its numbers consistent across views.

See git history pre-`9bb60c9` for the original architecture.
