# Changelog

## 2.2 — Security review sweep

Comprehensive security review (token-exposure audit + tooling/dependency risk assessment) run across the full working tree and all 91 commits of history. Headline: **no secrets are or ever were committed**, and `npm audit` is clean (0 vulns) in both `package.json` trees. The fixes below close the actionable hardening items the review surfaced; the residual/accepted items are tracked in [ROADMAP.md](./ROADMAP.md) §R8.

### Token / secret exposure — clean
- Full-tree + git-history (`-S` pickaxe) sweep for OpenAI/Anthropic/Google/AWS keys, GitHub PATs, private keys, JWTs, and connection strings: **zero real matches.** The `sk-`/`AKIA` history hits were substrings inside OCR'd corpus text ("task", "disks"), not keys.
- All auth material is read at runtime from outside the repo: the daemon mints a 192-bit bearer token to `~/.pursue-vision-token` (mode 0600); drivers attach to an already-authenticated Chrome over CDP — no cookie jars or storage-state files are committed. No `.env`/`.pem`/`.key`/service-account files are tracked or were ever added.
- Workflows use only the standard `${{ secrets.GITHUB_TOKEN }}`; no hardcoded secrets and no secret values echoed to logs.

### Hardening fixes (resolved)
- **CI install no longer runs dependency lifecycle scripts** — `.github/workflows/validate-contribution.yml` now installs with `--ignore-scripts`. A fork PR can edit `package.json`/`package-lock.json`, so an `install`/`postinstall` hook would otherwise have run attacker-controlled code on the runner (bounded by the read-only `GITHUB_TOKEN`, but still arbitrary execution).
- **Path-traversal in the PDF fetcher closed** — `scripts/fetch-missing-pdfs.mjs` derives the download filename from the upstream-synced inventory; it now `path.basename()`s that value so a crafted row can't write outside `data-raw/`.
- **SSRF guard on all corpus downloads** — new `scripts/safe-fetch.mjs` enforces https-only and blocks loopback/link-local/private-range hosts, re-validating every redirect hop. Wired into `fetch-pdfs.mjs` and `fetch-missing-pdfs.mjs`, which previously did `fetch(url, { redirect: "follow" })` against URLs from data files with no scheme/host checks. (All current event URLs are `https://www.war.gov` — no legitimate download is affected.)
- **Dashboard XSS surface tightened** — `pursue-vision-mcp/dashboard.html` now `escapeHTML()`s the live `previewUrl` (into `<img src>`) and recent-item `note` fields that arrive via `POST /progress`, matching the escaping already applied to log lines and PR titles.

## 2.2 — Punchlist sweep 2 (2026-05-21)

A second brutal-analysis pass over the daemon, the scripts, the React app, and the
docs. Three audit agents found ~40 incomplete/half-built/stale items; this release
closes every one that's closable without a third party and re-files the rest on the
[ROADMAP](./ROADMAP.md). Numbers throughout the docs were refreshed to the live
corpus: **173 inventory · 121 catalogued · 3,394 pages · 187 MEDIA tiles · review
queue 0**.

### MCP daemon (pursue-vision-mcp)
- **SIGINT handler no longer crashes.** The Ctrl-C handler called `await driver.disconnect()` on a variable that never existed; the `ReferenceError` was swallowed by an empty `catch {}`, so browser drivers were **never disconnected** on shutdown and CDP connections leaked. Now iterates the `drivers` map and disconnects each.
- **`/fanout` honors `perProviderTimeoutMs`.** `reevaluate-disputed.mjs` posts a 180s per-provider timeout, but the daemon destructured only `timeoutMs` and silently fell back to the 300s driver default — so the reeval retry logic (built around a 180s timeout) could never fire. The handler now accepts and applies it.
- **`gemini-driver.mjs` parity fixes.** Added the `disconnect()` method it was missing (ChatGPT's driver had one) and ported the `UPLOAD_FAILURE_PATTERNS` guard, so a Gemini reply where the model never saw the attachment now throws instead of being cached as a real transcript. Driver is still `@unverified` end-to-end (R2).
- Dead `mkdir`/`stat` imports removed from `daemon.mjs`.

### Scripts
- **`import-contributions.mjs` clobber guard now exists.** The header promised "won't clobber existing pages unless meaningfully better" and a `skipped_existing_better` stat — but the guard was never implemented and the stat never incremented; non-`human` sources always overwrote canonical. Now a non-`human` contribution must be longer than the existing non-empty canonical before it overwrites `p<NNN>.txt`; otherwise it's recorded and skipped. Sidecar + per-source writes are unchanged.
- **Windows `file://` bug fixed in three scripts.** `vision-visuals-augment.mjs`, `build-text-files.mjs`, and `ocr-scanned.mjs` built pdfjs asset URLs via `"file://" + path` (missing the third slash → fonts/wasm load silently fail on Windows). All three now use `pathToFileURL(...).href`, matching `vision-ocr.mjs`.
- **`db-rebuild.mjs` `has_pdfjs` now reflects reality.** The `pdfjsEvents` set was computed *after* the rows were already written, so the column was hardcoded `0` for every page. The computation moved ahead of the insert and now drives the column.
- **Stale operator guidance removed:** `vision-ocr.mjs` no longer prints a "next: update build-text-files.mjs" instruction for a migration that's already done; `validate-contribution.mjs` dropped the `VERBOSE=1` hint for a flag it never read; `build-patterns.mjs` docstring no longer lists a `totalEvents` field it doesn't emit; `extract-text.mjs` header no longer claims an `--ocr` tesseract fallback that was never built (now points at the real OCR scripts).

### UI
- **SemanticSearchView chunk-count lie fixed.** The live search status read "ranking 1,057 chunks" — the index is **5,584**. Now reads the live count from index state; stale header comment de-hardcoded.
- **`useCorpusStats` migration finished.** 2.1 shipped the shared hook but only migrated TimelineView + AtlasView. Header, CorpusFreshness, VolunteerModal, HelpView, LiveFeedView, SemanticSearchView, and NetworkView still rolled their own `let _statsP = null` corpus-stats caches — all seven are now on the hook (10 components total). Other-endpoint caches (version, similarity, patterns, extracts) intentionally left as-is. `vite build` clean.
- **Dead code removed:** DossierView's "APPEARS IN THREAD(S)" block (its `onJumpThread` prop was never passed after THREADS was deleted) + the now-orphaned `threads.js` import; DossierView empty-state copy that still named the deleted PATTERNS/THREADS/CONSTELLATION views; unused `GrainOverlay`/`VignetteOverlay`/`RadarSweep` exports in Primitives; MediaView's dead `c.bg ||` branch; LiveFeedView's permanently-zero "USER DROP" gauge; CorpusFreshness's unreachable `if (false)` block.
- **Stale fallbacks:** the `162` inventory fallback (SemanticSearchView, LiveFeedView) → `173`.
- **HelpView** no longer swallows a failed `corpus-stats.json` fetch entirely silently (warns; counts keep their placeholder).

### Volunteer cockpit (Helmsman instrument)
The live `pursue-vision-mcp/dashboard.html` panel a volunteer watches while their machine OCRs (served by `monitor.mjs` on :9224, styled per `design/HELMSMAN-PHOSPHOR.md`).
- **CORPUS (GLOBAL) gauge was showing nonsense.** `volunteer.mjs` fed it `(queue.inventoryTotal || 162) - totalPagesNeeded` — but `work-available.json` has no `inventoryTotal` field, so it always used the stale `162` and then subtracted *pages* from *records*. `build-work-available.mjs` now emits whole-corpus `corpusPagesTotal` / `corpusPagesCompleted`, and the gauge reads pages-search-ready / total-corpus-pages (currently 3,390 / 3,394 ≈ 100%).
- **Status dot now tracks daemon state.** `setStatus` computed a `dot` variable it never used (and couldn't — it tried to grab a `::after` pseudo-element via `firstChild`), so the pulsing dot stayed green even when the panel said OFFLINE/IDLE. The dot now recolors to match (green active · dim idle · rose offline) and freezes its ping when not processing — restoring the philosophy's rank-one "is it running?" signal.

### Docs reconciled to live counts
- **README, HOW-CAN-I-HELP, JUDGE-STANDARD, PLAN-VISION-COMPLETION, SQL-MIGRATION-ROADMAP** all refreshed off the pre-2.0 framing (162 records / 597 tesseract pages / ~110 uncatalogued / ~900 chunks / 3,376 pages) to the live numbers.
- **Broken `TRUSTED-TRANSCRIBERS.md` link removed (×2)** — HOW-CAN-I-HELP and JUDGE-STANDARD pointed at a file that doesn't exist (same class of bug 2.1 fixed for CONTRIBUTORS.md). Reworded to CONTRIBUTORS.md + informal/planned expedited review.
- **Wrong script path fixed:** HOW-CAN-I-HELP said `pursue-vision-mcp/volunteer.mjs`; it's `scripts/volunteer.mjs`.
- **Path-shape contradiction fixed:** HOW-CAN-I-HELP's ASCII map + example blocks used the legacy `contributions/<handle>/<eid>/...` shape; updated to the 2.0 `contributions/<handle>/<source>/<eid>/...` shape that the prose and the validator already use.
- **SQL-MIGRATION-ROADMAP** body now carries a "not the shipped design" note: the build-time consolidation shipped (`data-raw/corpus.sqlite`, 5 tables, projected to per-view JSON), but the runtime sql.js / `corpusDb.js` / browser-served `public/corpus.sqlite` / `build-corpus-db.mjs` / FTS5 sketch was never adopted.
- **ROADMAP** R2/R3/R4/R7 refreshed (live counts; R7 flagged as config-scaffolded-but-unwired).

### Still open (re-filed, not closed this round)
- `volunteer.mjs --review` **producer is missing.** `import-contributions.mjs` (`gpt-vision-review`/`gemini-review` sources) and `judge-disputed.mjs` both consume output from a documented `volunteer.mjs --review` mode that doesn't exist. The consumer side is wired; the flag was left unbuilt rather than guessed at. Needs a real review-flow design.
- **Deleted dead `src/data/threads.js`** — nothing imported it after the DossierView THREADS block was removed (THREADS view was deleted in 2.0); recoverable from git history if THREADS ever returns. (Note: `public/visuals.json` and `public/coverage.json` are **not** orphans — `visuals.json` is a build intermediate written by `build-text-files.mjs` and read by `build-dossier-extracts.mjs`; `coverage.json` is generated by `corpus:coverage` for the planned R6 per-event coverage UI. Both are regenerated by the pipeline and were left in place.)
- **Fixed stale `index.html` social meta** — the `description`/`og`/`twitter` tags advertised the deleted "patterns, threads" views and "47 declassified records"; updated to current views + 121 catalogued records (3,394 pages).
- **`volunteer.mjs --review` producer** documented as new ROADMAP **R8** (consumer wired in `import-contributions.mjs` + `judge-disputed.mjs`, producer absent) rather than built speculatively against an empty REVIEW queue.
- `@unverified` end-to-end paths unchanged: `gemini-driver.mjs` round-trip, `volunteer-media.mjs` claim/commit, `import-contributions.mjs` media branch (R2).
- **Cockpit `BREAK` status is consumer-wired, producer-absent** — `monitor.mjs` models `onBreak` (state + TUI) and `dashboard.html` renders a BREAK state, but `volunteer.mjs` never reports a break (it has no pacing-break logic). Left in place as a harmless forward hook; either wire volunteer pacing breaks to POST `onBreak`, or drop the branch. (Also: the cockpit pulls Geist/IBM Plex Mono from Google Fonts CDN — a local instrument that degrades to system monospace offline.)

## 2.1 — Punchlist sweep

Phase-2 brutal analysis identified ~30 partial features and stale code paths. This release closes the closable items, surfaces the not-yet-verifiable items via the new `@unverified` annotation system, and ships a new [ROADMAP.md](./ROADMAP.md) for the items that need a real third party (outside volunteer walking the contribution flow, etc.).

### Fixed lies
- **HELP hero** rewritten — was selling "ChatGPT quota is the bottleneck" (no longer true since the Denis Gemini sync replaced 3,370 pages). Now names the three real open priorities with live counts.
- **CONTRIBUTORS.md exists.** Auto-generated by `scripts/build-contributors.mjs` on every build from the contribution manifest + visuals sidecars. Per-handle: total pages, source breakdown, first/last contribution date, per-event detail. Previously referenced by JUDGE-STANDARD + HelpView; the file didn't exist.
- **Header search box** relabeled from misleading "grep corpus" to "filter events" with a tooltip pointing at SEARCH / SEMANTIC for full-text. Was confusing users who typed page-text phrases and got nothing.
- **`KNOWN_RENDER_HARD` dead block removed** from `volunteer.mjs`. Was hiding `fbi-62hq83894` (185 pages) + `skylab` (11 pages) from the volunteer rotation after the underlying Windows pdfjs bug was fixed weeks ago.
- **CONTRIBUTING-CORPUS.md deleted.** Its 20-line redirect existed mostly to confuse GitHub's "Contributing" surfacing. HOW-CAN-I-HELP is the entry point.
- **Stale `data-raw/.vision-visuals-cache/`** (309 empty `[]` files from the abandoned augment script) deleted along with its `.gitignore` allowlist.
- **Hardcoded `inventoryTotal: 162` in work-available.json** removed. Live count comes from `corpus-stats.json.inventory.total`.

### New scripts
- **`scripts/fetch-missing-pdfs.mjs`** (`npm run corpus:fetch-missing`). Walks `inventory-sync.json` against `data-raw/`, downloads any PDF that isn't local. Saves as `<eid>.pdf` so the classifier's filename heuristic finds it. The 81 page failures in the last classifier batch were all from one missing PDF — this prevents the next batch from hitting the same wall.
- **`scripts/setup-volunteer.mjs`** (`npm run corpus:setup`). Pre-flight check: node version, daemon health, per-provider tab connection, token presence, `gh` CLI install + auth, work-queue reachability, handle validity. Exits non-zero on any failure with a fix hint. Run before your first real contribution.
- **`scripts/build-contributors.mjs`** (`npm run corpus:contributors`). Auto-generates CONTRIBUTORS.md from manifest + visuals sidecars. Now runs on every build.
- **`scripts/find-unverified.mjs`** (`npm run corpus:unverified`). Greps the codebase for `@unverified` annotations. Exits non-zero if any are present so CI / contributors can see "we shipped this but never tested it" surface area in one shot.
- **`scripts/test-parse-template.mjs`** (`npm run test:parse-template`). 12 cases against `volunteer-media.mjs`'s template parser. Already caught a real BOM-handling bug on the first run.

### Bug fixes
- **`parseTemplate` BOM handling.** Word-processor save-as-UTF-8 prepends U+FEFF; the first heading line silently fell through. Strip BOM before parsing. Test added.
- **`safetyCheck` false-positives on media context.** The hallucination-marker regex was tuned for OCR transcripts ("the image appears to be"). Human writing context naturally uses "appears" — added a `mode` arg that scopes the soft markers to transcription-only and keeps the hard markers (explicit AI self-references) on everywhere.
- **`reevaluate-disputed.mjs` retry-on-partial.** Was leaving partials (one provider timed out) stuck forever. Now retries once before accepting; the previous partial (`1949-discs p8`) is reattempted on the next run.
- **`compare-sources.mjs` end-of-loop counter.** The "needs review: N" log used to disagree with the DB query by the count of reeval-settled pages. Now derives the final number once at the end.

### Architecture
- **New `src/hooks/useCorpusStats.js`** — shared hook with 60s revalidation + retry-on-blip. Replaces five copy-pasted `let _byEventP = null` module-level caches. TimelineView + AtlasView migrated; HelpView/VolunteerModal still use their own fetches (planned).
- **`window.__EVENTS_BY_ID` lookup** wired in App.jsx so MEDIA and REVIEW deep-links pass the full event object to DOSSIER instead of a synthetic `{id, title}` stub.
- **SEMANTIC loading skeleton** with explicit "this loads a 25MB model, SEARCH is available now if you don't want to wait" copy. Was a blank tab.
- **VolunteerModal privacy notice** — explicit "your handle becomes public in the corpus DB and in the PR" line.
- **Header brand `release 2.0` → linkified** to CHANGELOG. Was a footnote.

### Known untested code paths (flagged by `corpus:unverified`)
- `pursue-vision-mcp/gemini-driver.mjs` — bundled Gemini driver, never run end-to-end through this daemon (smoke test went via upstream)
- `scripts/volunteer-media.mjs` — claim/commit phases never run against a real third-party PR
- `scripts/import-contributions.mjs` media branch — never imported a real media PR

The new [ROADMAP.md](./ROADMAP.md) tracks these and the other items that need a real third party to verify.

### Post-2.0 patch (2026-05-19)

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
