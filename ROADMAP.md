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

Surface via `npm run corpus:unverified`. Each one is a code path shipped but never exercised end-to-end against real input.

| Path | First real exercise |
|---|---|
| `pursue-vision-mcp/gemini-driver.mjs` (bundled, slim) | Volunteer runs `--provider=gemini` and a Gemini round-trip succeeds — or fails with selector drift that we then fix |
| `scripts/volunteer-media.mjs` claim+commit | First media PR through the full flow |
| `scripts/import-contributions.mjs` media branch | First media PR merges and the importer correctly writes to `data-raw/.visuals/` + `public/media/` |

Each verification removes the corresponding `@unverified` annotation.

---

## R3 · Classifier completion across the full corpus

**Status:** ~119 / 3,376 pages classified (200-page run finished). 81 of that 200 failed on missing PDFs — now fixed by `corpus:fetch-missing`.

**Plan:**
1. Run `npm run corpus:fetch-missing` to download the 50+ PDFs the inventory sync surfaced
2. Run classifier in 500-page batches; expect ~4 hours per batch through one ChatGPT account
3. Expected total: 6-8 batches, ~30 hours of throughput
4. Each batch ships visuals to MEDIA on the next deploy

**Bottleneck:** ChatGPT Plus rate limits. Could parallelize across Gemini once `gemini-driver.mjs` is verified (R2).

---

## R4 · MEDIA context capture — first 16 volunteers

**Status:** 16 visuals classified, all from `1949-discs`. None have human-curated context yet.

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

**Status:** DESIGNED, not built. Full design + brutal analysis in
[design/VOLUNTEER-LEASING.md](./design/VOLUNTEER-LEASING.md).

**Request:** a live-tracking server that records who's working on which page and
auto-reassigns a page to the next volunteer after a configurable timeout
(default 10 min, set in admin settings).

**Verdict (see design doc for the full argument):** the *need* — don't let two
volunteers duplicate a page; don't let a claim sit forever — is real and already
flagged in R6. The *requested implementation* (an always-on, authenticated,
admin-configurable tracking server) is the wrong order for a static-site /
fork-and-PR project that deliberately has no backend, no auth, and promises *"no
central server holds your work."* A lease here can only ever be advisory
(submission is a GitHub PR, which knows nothing about leases), and an advisory
lease needs a **file, not a server**. The 10-minute timeout is also
mis-calibrated: real work units run 30 min (OCR slice) to days (visuals
claim→fill→commit), so a 10-min reassign would *cause* duplicate PRs.

**Phased plan:**
1. **Phase 0 — local dedup (done).** Volunteer scripts skip pages that already
   have a local contribution/staged template. Killed the "re-serves the same
   lot" bug. Zero infra.
2. **Phase 1 — static claims ledger (recommended next).** `public/claims/<eid>/p<NNN>.json`
   with `{handle, claimed_at, lease_secs}`; default lease **24h** (matched to the
   real work unit), configurable via committed `config/leasing.json`. Delivers
   tracking + expiry + reassignment + configurable timeout with no server, no
   auth, no privacy regression. Ship when a *second* real volunteer exists (i.e.
   after R1).
3. **Phase 2 — serverless claim function (deferred behind a trigger).** A single
   stateless Worker/KV endpoint, *only* once there are ≥5 concurrent volunteers
   AND duplicate PRs are a measured maintainer burden AND Phase 1's git-latency
   is demonstrably too slow. Still advisory; still never holds the work.

**Owner:** revisit when R1 lands a second contributor.

---

_Updated 2026-05-20: added R7 (volunteer leasing) + design doc. To propose a new roadmap item, open an issue with the `roadmap` label._
