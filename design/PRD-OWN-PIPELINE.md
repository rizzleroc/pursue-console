# PRD: Own Corpus Ingestion Pipeline
## Eliminate Denis Dependency · Process Future Tranches Independently

> **Status:** PROPOSAL  
> **Branch:** `claude/denis-pull-prd-TUpNW`  
> **Date:** 2026-05-22  
> **Companion:** [ROADMAP.md](../ROADMAP.md) · [design/VOLUNTEER-LEASING.md](./VOLUNTEER-LEASING.md)

---

## 1. What Denis Did (the pull we're replicating)

Denis Sergeevitch ran a one-shot local pipeline on May 8 2026 — the day war.gov published Release 01 — and pushed the results to [DenisSergeevitch/UFO-USA](https://github.com/DenisSergeevitch/UFO-USA). We pull from that repo. Here is his exact methodology:

| Step | Tool | Detail |
|---|---|---|
| 1. Download PDFs | `curl` (shell loop) | Direct HTTP GET against `war.gov/medialink/ufo/release_1/<filename>.pdf`. No auth. Sequential, skip-existing. |
| 2. Render pages | **PyMuPDF** (Python) | Each PDF page → JPEG at 200 DPI, longest edge ≤ 3000 px. |
| 3. Transcribe | **Gemini API** (`google-genai` SDK) | Model: `gemini-3.1-flash-lite`, `temperature=0`. 16 parallel workers, 10,000 req/min rate limiter. |
| 4. Write output | Markdown + YAML frontmatter | `converted/<NNN-slug>/page-NNNN.md`. 9-field YAML header per page. Resume-safe (skip existing). |
| 5. Publish | `git push` | 4,185 pages, 120 PDFs, 2.308 GiB source data. No CI — manual run. |

**What we pull from Denis today:**
- `sync-inventory.mjs` → fetches `metadata/pdf_manifest.tsv` via HTTP (CI-safe)
- `import-gemini-corpus.mjs` → reads `data-raw/upstream-gemini/converted/` which requires a `git clone --depth 1 https://github.com/DenisSergeevitch/UFO-USA data-raw/upstream-gemini` on the maintainer machine

**Why we depend on Denis:** war.gov blocks our IPs via Akamai. Denis ran his curl loop from an unblocked network (his home IP, likely European/Russian) on release day before the block was in place or before Akamai knew to block him.

---

## 2. Problem Statement

| Problem | Impact |
|---|---|
| Denis is a single point of failure | If he stops maintaining UFO-USA, new tranches never reach our corpus |
| Manual upstream import | Maintainer must manually clone Denis's repo and run `import-gemini-corpus.mjs`; this step doesn't run in CI |
| Akamai blocks us | `fetch-pdfs.mjs` and `fetch-missing-pdfs.mjs` exist but fail silently against war.gov |
| New tranche latency | When war.gov drops Release 02, we wait for Denis to run his pipeline, then we pull, then we deploy — 3 human-in-the-loop steps |
| No quality control on upstream | We have no way to re-run or verify Denis's transcriptions against our own models at ingestion time |

---

## 3. Goal

Own the full pipeline from war.gov PDF → vision-cache entry, so that:

1. When war.gov releases a new tranche, pursue-console can process it **without depending on Denis's timeline**
2. The import runs automatically in CI — no maintainer `git clone` required
3. We can run our own Gemini transcription over Denis's PDFs to produce a second source for comparison (improving the cross-source agreement layer)
4. New PDFs are detected, downloaded, transcribed, and deployed within **one GitHub Actions run**

---

## 4. Architecture

```
                ┌─────────────────────────────────────────────────────┐
                │  war.gov/UFO (Akamai-protected, flat PDF list)      │
                └─────────────────────────┬───────────────────────────┘
                                          │  Option A: direct curl from
                                          │  unblocked runner/proxy
                                          │  Option B: Gemini Files API
                                          │  Option C: Denis mirror
                                          ▼
                           ┌─────────────────────────┐
                           │  scripts/acquire-pdfs.mjs│  ← NEW
                           │  (idempotent, resumable) │
                           └────────────┬────────────┘
                                        │  data-raw/<eid>.pdf
                                        ▼
                     ┌──────────────────────────────────────┐
                     │  scripts/transcribe-gemini-api.mjs   │  ← NEW (core)
                     │  pdfjs-dist render → Gemini API      │
                     │  gemini-2.0-flash, temperature=0     │
                     │  16 workers · rate limiter           │
                     └──────────────┬───────────────────────┘
                                    │  writes vision-cache format:
                                    │  data-raw/.vision-cache/<eid>/p<NNN>.gemini.txt
                                    │  data-raw/.vision-cache/<eid>/p<NNN>.sources.json
                                    ▼
                     ┌───────────────────────────────────────┐
                     │  EXISTING pipeline (unchanged)        │
                     │  compare-sources → build-text-files   │
                     │  → db-rebuild → deploy                │
                     └───────────────────────────────────────┘
```

### Akamai bypass: option ranking

| Option | Feasibility | Cost | Notes |
|---|---|---|---|
| **A: GitHub Actions runner** | High — test first | Free | Large cloud IPs may also be blocked; needs empirical test |
| **B: Gemini Files API** | Medium | API cost | Upload PDF bytes to Gemini, ask page-by-page; avoids download to disk; no PyMuPDF needed |
| **C: Denis's mirror via git** | High | Free | Already works (we do it now). Automate in CI with sparse checkout; no new download infra |
| **D: Residential proxy** | Medium | ~$20/mo | Out of scope for now — adds external dependency |

**Recommended approach:** Test A first (30-minute experiment: run `fetch-missing-pdfs.mjs` in a GitHub Actions runner). If blocked, fall back to C (automate the sparse clone in CI) while keeping B as the target architecture.

---

## 5. Implementation Phases

### Phase 0 — Empirical Akamai test (½ day)
**Goal:** Know whether GitHub Actions runners can reach war.gov before writing any download code.

**Deliverable:** A one-off GitHub Actions workflow (`test-akamai.yml`) that runs:
```bash
curl -I https://www.war.gov/medialink/ufo/release_1/255_413270_ufo's_and_defense_what_should_we_prepare_for.pdf
```
and logs the HTTP status. If `200 OK` → proceed to Phase 2A. If `403/429` → proceed to Phase 2C.

---

### Phase 1 — Gemini API transcription script (3–4 days)
**File:** `scripts/transcribe-gemini-api.mjs`

This is the core new piece. Denis's `process_dataset_with_gemini.py` ported to Node.js using our existing stack.

**Inputs:**
- `data-raw/<eid>.pdf` (local PDF)
- `--event-id=<eid>` CLI flag (or `--all` to process every PDF in `data-raw/`)
- `GEMINI_API_KEY` env var (or `GOOGLE_API_KEY`)

**Process:**
1. Render PDF pages with `pdfjs-dist` + `@napi-rs/canvas` (both already in devDependencies) at 200 DPI → JPEG buffer
2. POST image to Gemini API using the `@google/generative-ai` npm package
   - Model: `gemini-2.0-flash-lite` (equivalent to Denis's `gemini-3.1-flash-lite`)
   - `temperature: 0`
   - Prompt: adapted from Denis's (see `scripts/prompts/standard-transcription.txt`)
3. Write output to vision cache:
   - `data-raw/.vision-cache/<eid>/p<NNN>.gemini.txt` — cleaned transcript
   - `data-raw/.vision-cache/<eid>/p<NNN>.sources.json` — sidecar updated with `gemini` entry
4. Skip pages that already have a `gemini` source in the sidecar (resumable)
5. Worker pool: 8 concurrent (conservative for API rate limits)
6. Exponential backoff on `429/503`

**Output:** identical format to what `import-gemini-corpus.mjs` produces — meaning the existing `compare-sources.mjs` + `build-text-files.mjs` pipeline works unchanged.

**New npm script:**
```json
"corpus:transcribe": "node scripts/transcribe-gemini-api.mjs"
```

**Effort:** 3–4 days. The pdfjs-dist render path and sidecar format are already proven in the codebase; the new code is the Gemini API loop + worker pool.

---

### Phase 2 — PDF acquisition (1–2 days, contingent on Phase 0)

**Path 2A — direct download (if Akamai permits from Actions):**

Extend `fetch-missing-pdfs.mjs` with:
- Retry logic with exponential backoff (currently fails silently)
- Progress tracking against `inventory-sync.json`
- GitHub Actions environment detection (set longer timeout, log more verbosely)

**Path 2C — automated Denis sparse clone (if Akamai blocks Actions):**

Add a new script `scripts/sync-upstream-pdfs.mjs` that:
```bash
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/DenisSergeevitch/UFO-USA \
  data-raw/upstream-gemini
cd data-raw/upstream-gemini
git sparse-checkout set downloads/
```
Then copies PDFs to `data-raw/<eid>.pdf` using the filename→eid mapping from `inventory-sync.json`.

Denis's `downloads/` folder is not committed to his repo (gitignored like ours). This means 2C only helps if Denis publishes a separate release artifact or we find another mirror. **Fallback: direct import from Denis's `converted/` markdown stays the primary path** (current behavior). Phase 2 is then about adding direct download capability, not replacing the working import.

**Revised Phase 2 scope if 2A and 2C both fail:**
- Document the Akamai constraint clearly in `HOW-CAN-I-HELP.md`
- Add a maintainer workflow: "download PDFs from Denis's GitHub release artifact (he posts `.tar.gz` per tranche) → unpack to `data-raw/` → run `corpus:transcribe`"

---

### Phase 3 — New tranche detection (1 day)

**File:** `scripts/detect-new-tranche.mjs`

Compares Denis's manifest against our current inventory-sync.json:
```
npm run corpus:sync     → update inventory-sync.json from Denis's TSV
node scripts/detect-new-tranche.mjs  → print new PDFs since last known state
```

Writes `data-raw/.tranche-state.json` with a hash of the last-seen manifest. If the hash changes, outputs a list of new filenames + eids to stdout so CI can act on it.

**Loop integration:** this is the script that runs on a schedule (see Phase 4).

---

### Phase 4 — CI automation + loop (1 day)

**New GitHub Actions workflow:** `.github/workflows/new-tranche.yml`

Trigger: scheduled (`cron: '0 * * * *'` — hourly) + `workflow_dispatch`.

Steps:
1. `npm run corpus:sync` → update `inventory-sync.json`
2. `node scripts/detect-new-tranche.mjs` → check if new PDFs exist
3. If new PDFs: run `corpus:fetch-missing` or `corpus:transcribe` (whichever Akamai path works)
4. Commit updated vision-cache sidecars + rebuilt corpus artifacts
5. Trigger deploy workflow

**Session-level loop (for development monitoring):**
Use `/loop 60m corpus:sync` to poll Denis's manifest during active development sessions and alert when a new tranche appears. This runs the sync check every 60 minutes in the Claude Code session without tying up CI.

---

## 6. Effort Estimate

| Phase | Work | Complexity | Days |
|---|---|---|---|
| Phase 0 | Akamai test workflow | Low | 0.5 |
| Phase 1 | `transcribe-gemini-api.mjs` | High — new core script | 3–4 |
| Phase 2 | PDF acquisition (path depends on Phase 0 result) | Medium | 1–2 |
| Phase 3 | `detect-new-tranche.mjs` | Low | 0.5–1 |
| Phase 4 | CI workflow + loop wiring | Low | 0.5–1 |
| **Total** | | | **6–9 days** |

The dominant cost is Phase 1 — writing a robust, resumable, rate-limited Gemini API transcription loop with correct pdfjs-dist page rendering. Denis's Python script is ~350 lines; our Node.js equivalent will be similar.

---

## 7. Dependencies + Risks

| Risk | Mitigation |
|---|---|
| `gemini-3.1-flash-lite` model name is non-standard (likely `gemini-2.0-flash-lite`) | Test model name against Gemini API before writing the full script |
| pdfjs-dist page render quality vs PyMuPDF | Both output raster images; run a spot-check comparison on 5 pages |
| Akamai blocks Actions runners (likely) | Phase 2C fallback; Denis mirror; maintainer manual download |
| Gemini API key management in CI | Add `GEMINI_API_KEY` to GitHub Actions secrets; skip transcription step if not present (same as Denis's CI — none) |
| Rate limit budget | 16 workers at Denis's rate = ~16 req/min sustained (much less than 10k/min cap). We use 8 workers to stay safe. |
| Dennis updates UFO-USA (good) | Our `sync-inventory.mjs` already pulls his TSV; `import-gemini-corpus.mjs` handles new converted/ pages. Phase 1 is an *addition*, not a replacement — we keep Denis as a fast-path source and add our own as second source for cross-checking. |

---

## 8. What Doesn't Change

- The existing Denis import path (`import-gemini-corpus.mjs`) stays in place — Denis is still a faster and cheaper source than running our own Gemini API at scale
- The `sync-inventory.mjs` manifest sync is unchanged
- All downstream pipeline scripts (`compare-sources`, `build-text-files`, `db-rebuild`, etc.) are unchanged — `transcribe-gemini-api.mjs` writes to the same vision cache format
- Volunteer-contributed transcriptions still win over machine sources (human > gpt-vision > gemini > ocr priority order)

---

## 9. Definition of Done

- [ ] Phase 0: Akamai test result committed to `data-raw/.akamai-test.json`
- [ ] Phase 1: `transcribe-gemini-api.mjs` runs on at least one real event end-to-end, producing sidecar-compatible output, verified against Denis's transcription for that event
- [ ] Phase 2: at least one PDF download path works in GitHub Actions (direct or Denis sparse clone)
- [ ] Phase 3: `detect-new-tranche.mjs` correctly identifies 0 new PDFs against current Denis manifest, and correctly identifies N new PDFs when fed a mock manifest with additions
- [ ] Phase 4: `new-tranche.yml` workflow runs on schedule, exits cleanly when no new PDFs detected
- [ ] R3 (classifier completion) unblocked: with our own transcription pipeline, we're no longer rate-limited solely by ChatGPT Plus tier — Gemini API can run classifier batches in parallel

---

## 10. Build Order (recommended)

1. **Phase 0** immediately — the Akamai test takes 30 minutes and determines the Phase 2 path
2. **Phase 1** next — highest value, unlocks independent transcription now (maintainer can run locally even if CI download doesn't work)
3. **Phase 3** before Phase 4 — detection logic needed to make the CI trigger meaningful
4. **Phase 2 + Phase 4** together — wire acquisition and automation once we know the download path

---

_Drafted 2026-05-22. Based on analysis of DenisSergeevitch/UFO-USA methodology (curl + PyMuPDF + gemini-3.1-flash-lite, 120 PDFs, 4,185 pages, 2.308 GiB) and pursue-console 2.2 codebase._
