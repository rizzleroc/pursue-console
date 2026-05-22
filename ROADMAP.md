# Roadmap

> Items that can't be closed by the maintainer working alone. Each one needs a real third party or a meaningful chunk of engineering. Updated as items land.
>
> Companion to [CHANGELOG.md](./CHANGELOG.md) (what already shipped) and [HOW-CAN-I-HELP.md](./HOW-CAN-I-HELP.md) (what a volunteer can pick up).

---

## R1 · End-to-end verification by a third party *(highest priority)*

**Status:** OPEN.
**Why:** every "volunteer can contribute in 30 minutes" claim is unverified. The maintainer is also the QA team. Until somebody who isn't the maintainer walks the install-helper / volunteer.mjs / volunteer-media.mjs flows front-to-back, the claims are aspirational.

**Definition of done:**
- One outside person runs `curl install-helper.sh | bash` on a fresh machine
- They successfully run `npm run corpus:setup` and resolve every failure
- They run `volunteer.mjs --slice=5` to completion and open a PR
- They run `volunteer-media.mjs --slice=2 → fill → --commit` and open a PR
- Every place they stumble gets logged and fixed

**Owner:** anyone willing to be patient with first-version software.

---

## R2 · Untested code path verifications

Surface via `npm run corpus:unverified`. Each one is a code path shipped but never exercised end-to-end against real input. These are *verification* gaps, not missing code — the code exists and the flags are wired; what's unverified is a real round-trip.

| Path | First real exercise |
|---|---|
| `pursue-vision-mcp/gemini-driver.mjs` (bundled, slim) | Volunteer runs `--provider=gemini` and a Gemini round-trip succeeds — or fails with selector drift that we then fix. The `--provider=gemini` flag is already implemented in `volunteer.mjs`; what's untested is a live Gemini browser round-trip. *(2.2: the driver gained a `disconnect()` and the same upload-failure guard `chatgpt-driver.mjs` has, so a reply where Gemini never saw the attachment now throws instead of poisoning the cache — still `@unverified` end-to-end.)* |
| `scripts/volunteer-media.mjs` claim+commit | First media PR through the full flow |
| `scripts/import-contributions.mjs` media branch | First media PR merges and the importer correctly writes to `data-raw/.visuals/` + `public/media/` |

Each verification removes the corresponding `@unverified` annotation.

---

## R3 · Classifier completion across the full corpus

**Status:** classifier batches have run since 2.1 — **187 visual tiles** now published to MEDIA (up from ~119 classified / 16 tiles), across 3,394 transcribed pages. Source mix is `gemini` 3,370 · `gpt-vision` 445 · `ocr` 693 (425 pages have ≥2 sources). The OCR backlog that this item was originally scoped against is effectively cleared by the Denis Gemini sync.

**OCR tail (2026-05-22 audit):** 12 pages across 7 events still need vision OCR — this is nearly done. The dominant open work has shifted to **205 visual context pages needing human annotation** (R4 territory).

**Plan (remaining):**
1. Continue the visual classifier across the not-yet-classified tail in batches; each batch ships new tiles to MEDIA on the next deploy
2. Parallelize across Gemini once `gemini-driver.mjs` is verified end-to-end (R2)

**Bottleneck:** ChatGPT Plus rate limits on the remaining classifier passes. No longer a raw-OCR bottleneck.

---

## R4 · MEDIA context capture — first 16 volunteers

**Status:** 187 visuals classified and live in MEDIA. **None have human-curated context yet** (`visualsAnnotated: 0` in corpus-stats) — the classifier writes a kind + machine description per tile, but no volunteer has hand-written documentary context for any of them.

**Plan:** the volunteer-media flow is open. First batch of submissions exercises the importer + validator + claim API. Realistic ask: one volunteer claims 5 pages, opens a PR. Iterate based on what breaks.

---

## R5 · Items deferred from the 2.1 punchlist

Things called out in the brutal analysis that we didn't close this round, with the reason.

| | What | Reason deferred |
|---|---|---|
| E3 | Split `compare-sources.mjs` (300 lines, four jobs) into three scripts | Touch-everything refactor; high risk of regression. Do when the next feature lands on this file. |
| E5 | Rollback story — documented "restore yesterday's corpus" procedure | The 6h backup workflow already snapshots to a tag. Need to write the restore steps. |
| E7 | Browser-side "we're about to download 25MB" consent prompt | Discoverable issue once anyone uses SEMANTIC on a slow connection; not blocking. |
| E8 | Bot-detection telemetry on the volunteer ChatGPT pacing | Would need a beacon endpoint; out of scope for static-site architecture. Volunteers self-report if they get rate-limited. |
| D5 | Deploy + FAISS-rebuild push race condition | Low-frequency, git's rebase handles 99% of cases. Document the recovery if it ever bites. |
| D7 | Exhaustive fetch-retry across every view | Critical fetches now have it (corpus-stats via useCorpusStats); the long tail can wait until someone reports a real failure. |
| D10 | Split deploy workflow (data-pipeline vs vite-build on different triggers) | Architecturally invasive; CI burns ~3min per push but it's not yet bad enough to chase. |
| Tests | Real unit/integration/E2E test infrastructure | Adopted ad-hoc `scripts/test-*.mjs` pattern for now. Bigger commitment when the project has more contributors. |
| CI smoke | End-to-end smoke test in CI (render one page, OCR via mock, import, validate, db-rebuild) | Mocking the MCP daemon is real work. Defer until a regression actually slips through. |
| `install-helper.sh` audit | Re-walk the sparse-checkout config against 2.0 paths | Will be exercised + fixed as part of R1. |
| Denis URL mismatches (8) | 8 Denis PDFs whose filenames differ from the corresponding `events.js` URLs even after normalization: `38_143685_box7_*`, `DOW-UAP-D44`/`D48`/`D49` (Denis uses simplified names), and 3 FBI serial-redacted files. Needs manual URL reconciliation in `events.js` to unlock those PDFs for import. | Not a script bug — genuine filename discrepancies between Denis's TSV and war.gov URLs. Low-volume; fix per-file when doing the next Denis import pass. |

---

## R6 · Pivot opportunities (not commitments)

Ideas surfaced during 2.0 + 2.1 work that are worth pursuing if/when someone has the bandwidth.

- **Article-level segmentation for newspaper clippings.** When a page is `kind: newspaper-clipping`, currently the volunteer just transcribes the article body into `article_text`. A future pass could segment the page into per-article bounding boxes via vision and emit one media row per article, so a single newspaper page lights up SEARCH for multiple distinct stories.
- **Per-source quality reports surfaced in REVIEW.** The `data-raw/.source-quality.json` log accumulates vs-human gold scores per source. Once human-typed pages exist, REVIEW could show "Gemini scored 0.91 mean vs human across N pages; GPT-vision scored 0.87 across M pages." Helps a volunteer decide which provider's transcript to trust on a given page.
- **Auto-claim-then-warn for stale claims.** Right now the volunteer rotation is deterministic per handle (hash). If two volunteers run at the same time they might overlap. A claim file in `public/claims/<handle>.json` with a TTL would let the script skip pages another volunteer already claimed in the last hour. **Now scoped in full — see R7 and [design/VOLUNTEER-LEASING.md](./design/VOLUNTEER-LEASING.md).**
- **A "what changed" feed on the corpus-stats freshness strip.** Currently just "refreshed Nm ago"; could show "+3 vision pages from @volunteer, +2 disputes settled by reeval, +1 media context from @anotherperson."
- **Per-event coverage page in the UI.** `npm run corpus:coverage` exists as a CLI report; could become a tab showing the matrix visually (this many events fully covered · this many have gaps · this many have mismatches).
- **Make the FAISS rebuild incremental.** Right now it regenerates the entire 384-D index every time. With 3,300+ chunks and growing, an incremental "embed only new chunks, append to existing index" approach would scale better.

---

## R7 · Volunteer work leasing (claim tracking + stale reclaim)

**Status — Phase 1: SHIPPED (2026-05-22).** Full design + brutal analysis in
[design/VOLUNTEER-LEASING.md](./design/VOLUNTEER-LEASING.md).

**What was built (2026-05-22):**

- `config/leasing.json` — global config: `consensus_passes: 3`, per-phase lease
  windows (vision 24 h / visual 48 h / review 24 h / revalidation 24 h).
- `scripts/claim-page.mjs` — core module: claim read, write, check, and
  garbage-collection logic.
- `scripts/build-work-available.mjs` updated — reads `public/claims/`, annotates
  every queue entry with active claim counts, and splits output into `queue`
  (open slots remain) vs `fullClaimedQueue` (consensus-full / capacity reached).
- `scripts/volunteer.mjs` updated — consults claim data from `work-available.json`
  before selecting pages; writes claim files to
  `contributions/<handle>/claims/`.
- `scripts/volunteer-media.mjs` updated — writes visual claim files before media
  capture begins.
- `scripts/import-contributions.mjs` updated — merges volunteer claim files from
  `contributions/<handle>/claims/` into `public/claims/` on PR import.
- `scripts/gc-claims.mjs` — standalone garbage-collector: expires stale claim
  files from `public/claims/`.

**Claim-concurrency rules implemented:**

| Phase | Max concurrent claimants | Behavior at cap |
|---|---|---|
| vision | 3 (consensus building) | locked after 3 |
| visual | 1 | locked after 1 |
| review | 1 | locked after 1 |
| revalidation | 2 | locked after 2 |

Different task types always coexist freely (one person vision + another visual on the same page = fine).

Volunteer claims flow via PR (`contributions/<handle>/claims/`); the maintainer writes `public/claims/` directly on merge.

**Phase 0 note:** direct PDF download from cloud runners tested against Akamai (war.gov) — HTTP 403 confirmed; the Denis mirror path remains the only viable import source.

**What's still open (Phase 1 gaps):**

- Auto-merge of claim PRs — claim PRs still require manual maintainer merge before other volunteers see the new claim in `public/claims/`. Until that's wired, there's a git-round-trip latency window where two volunteers could race.
- UI surface — claim status (how many claimants, whether a page is locked) is not yet exposed in the volunteer cockpit / dashboard.

**Phased plan:**
1. **Phase 0 — local dedup (done).** Volunteer scripts skip pages that already
   have a local contribution/staged template. Killed the "re-serves the same
   lot" bug. Zero infra.
2. **Phase 1 — static claims ledger (SHIPPED 2026-05-22).** `public/claims/`
   ledger with per-phase concurrency caps; `gc-claims.mjs` for expiry;
   `build-work-available.mjs` annotates the queue; volunteer scripts read and
   write claims. No server, no auth, no privacy regression.
3. **Phase 2 — serverless claim function (deferred behind a trigger).** A single
   stateless Worker/KV endpoint, *only* once there are ≥5 concurrent volunteers
   AND duplicate PRs are a measured maintainer burden AND Phase 1's git-latency
   is demonstrably too slow. Still advisory; still never holds the work.

**Owner:** Phase 2 — revisit when concurrent-volunteer collisions become a
measured problem.

---

## R8 · `volunteer.mjs --review` producer (consumer wired, producer absent)

**Status:** DESIGNED by its consumers, **not built**. Surfaced in the 2.2 sweep.

`import-contributions.mjs` handles `<handle>/gpt-vision-review/` and
`<handle>/gemini-review/` source folders (lands them as `p<NNN>.<base>.v2.txt` so
`compare-sources.mjs` re-scores the dispute), and `judge-disputed.mjs` references
output from "volunteer.mjs `--review`". But `volunteer.mjs` has **no `--review`
mode** — nothing produces those folders. The consumer contract is precise (path
shape + the standardized prompt), so this is buildable; it's just unbuilt.

**Why deferred (not built in 2.2):** the REVIEW queue is currently **empty** (0
disputed pages), and maintainer-side `reevaluate-disputed.mjs` already does
standardized re-eval through both providers via `/fanout`. A volunteer `--review`
mode would be a *volunteer-driven* version of that same job. Building ~150 lines
of new render+prompt+write path for an empty queue, duplicating a working
maintainer pipeline, is speculative — exactly the kind of half-feature this sweep
exists to prevent. Note the *human* "settle the REVIEW queue" path (HOW-CAN-I-HELP
priority 1) is unrelated: that produces a hand-typed `human` source, not a
`-review` re-OCR.

**Definition of done (when built):** `volunteer.mjs --review [--provider=…]` pulls
disputed pages from `review-queue.json`, renders + re-transcribes each through
`scripts/prompts/standard-transcription.txt`, and writes
`contributions/<handle>/<gpt-vision|gemini>-review/<eid>/p<NNN>.txt`. **Trigger to
build:** the REVIEW queue has real disputes AND a volunteer wants to contribute
re-OCR compute rather than hand-typing.

**Alternative:** if volunteer-driven reeval is never wanted, delete the
`gpt-vision-review`/`gemini-review` branches from `import-contributions.mjs` +
`judge-disputed.mjs` to retire the dangling contract.

---

_Updated 2026-05-22: R7 Phase 1 (volunteer work leasing) shipped — `claim-page.mjs`, `gc-claims.mjs`, updated `build-work-available.mjs` / `volunteer.mjs` / `volunteer-media.mjs` / `import-contributions.mjs`; per-phase concurrency caps (vision 3 / visual 1 / review 1 / revalidation 2); claim PRs still need manual merge (auto-merge and UI surface deferred to Phase 1 gaps)._
_Updated 2026-05-22: URL normalization bug fixed in `scripts/sync-inventory.mjs` and `scripts/import-gemini-corpus.mjs` — Denis manifest uses hyphenated filenames, `events.js` uses raw war.gov URLs with literal spaces; case-insensitive comparison never matched. Fix: normalize both sides with `.toLowerCase().replace(/[^a-z0-9.:/-]+/g, "-").replace(/-{2,}/g, "-")`. Result: Denis manifest matching improved from **68/120 → 112/120 PDFs matched**; 44 previously unlinked events are now matched, unlocking ~800 Denis pages for those events on the next import run. 8 PDFs remain genuinely mismatched due to filename discrepancies (tracked in R5 Denis URL mismatches). Corpus status at audit: 121 events catalogued (65 have pages, 56 do not); 3,394 pages transcribed; 12 pages need vision OCR (7 events, nearly done); 205 visual context pages need human annotation; 4 catalogue placeholders have no URL (japan-2023, indopacom-2024, army-2026, pursue-release-01); 0 review-queue disputes._
_Updated 2026-05-21 (2.2 sweep, follow-up): added R8 (`volunteer.mjs --review` producer is missing — consumer wired, producer absent); deleted dead `src/data/threads.js`; fixed stale index.html meta (deleted views + "47 records")._
_Updated 2026-05-21 (2.2 punchlist sweep): refreshed live counts (173 inventory · 121 catalogued · 3,394 pages · 187 MEDIA tiles · review queue 0); clarified R2 verification-vs-code gaps and the 2.2 gemini-driver guard/disconnect fix; corrected R3/R4 from the pre-sync OCR framing; flagged R7 leasing as config-scaffolded-but-unwired._
_Updated 2026-05-20: added R7 (volunteer leasing) + design doc. To propose a new roadmap item, open an issue with the `roadmap` label._
