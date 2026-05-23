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

**Status:** DESIGNED + config scaffolded, **not wired**. Full design + brutal
analysis in [design/VOLUNTEER-LEASING.md](./design/VOLUNTEER-LEASING.md). The
Phase-1 config artifact `config/leasing.json` is already committed
(`default_lease_secs: 86400` + per-phase ocr/media/review windows), but nothing
consumes it yet: `scripts/build-work-available.mjs` does not read it and no
`public/claims/<eid>/p<NNN>.json` ledger is written. So Phase 1 is half-landed —
the knob exists, the mechanism doesn't.

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
2. **Phase 1 — static claims ledger (recommended next; config already committed).**
   `public/claims/<eid>/p<NNN>.json` with `{handle, claimed_at, lease_secs}`;
   default lease **24h** (matched to the real work unit), configurable via the
   already-committed `config/leasing.json`. **What's left:** wire
   `build-work-available.mjs` (or the volunteer scripts) to read `leasing.json`,
   write/read the `public/claims/` ledger, and skip pages another volunteer
   claimed inside the lease window. Delivers tracking + expiry + reassignment +
   configurable timeout with no server, no auth, no privacy regression. Wire it
   when a *second* real volunteer exists (i.e. after R1).
3. **Phase 2 — serverless claim function (deferred behind a trigger).** A single
   stateless Worker/KV endpoint, *only* once there are ≥5 concurrent volunteers
   AND duplicate PRs are a measured maintainer burden AND Phase 1's git-latency
   is demonstrably too slow. Still advisory; still never holds the work.

**Owner:** revisit when R1 lands a second contributor.

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

## R9 · Release 02 ingestion (MCP-based collector landed, `@unverified`)

**Status:** MCP-based collection landed, **`@unverified` (awaiting first live run
against the maintainer's Chrome).**

war.gov/UFO published its **Second Release (Release 02) on 2026-05-22** — 64 files:
**6 PDFs, 7 audio, 51 videos** ([DoW press release](https://www.war.gov/News/Releases/Release/Article/4499305/department-of-war-publishes-second-release-of-unidentified-anomalous-phenomena/)).
It's the next drop in the rolling PURSUE program.

**The blocker:** war.gov blocks our IPs via Akamai TLS-fingerprint detection. Every
Node-side HTTP client we tried (`curl`, `wget`, Playwright `page.request`, native
`fetch`) fails. The ONLY path that works is `fetch()` called from JavaScript running
INSIDE a page already loaded on www.war.gov — that request inherits the real
browser's TLS handshake and slips past the check. We previously waited on the
community mirror [`DenisSergeevitch/UFO-USA`](https://github.com/DenisSergeevitch/UFO-USA);
that wait is no longer the critical path.

**What's landed this round (`@unverified`):**
- `pursue-vision-mcp/war-gov-driver.mjs` — Playwright driver that connects to the
  user's logged-in Chrome over CDP, finds (or opens) a `www.war.gov/UFO/` tab, and
  exposes `fetchIndex({ release })` + `downloadFile({ url, destPath })`. Big files
  (>50 MB videos) stream in 8 MB HTTP Range chunks; bytes shuttle browser → Node
  via base64.
- `pursue-vision-mcp/daemon.mjs` — new endpoints `GET /war-gov/index?release=N` and
  `POST /war-gov/download {urls, destDir}`. Same single-slot queue pattern as the
  LLM drivers (`queues.warGov`), same bearer-token auth, same path-jail enforcement.
- `pursue-vision-mcp/start.mjs` — opens the war.gov tab alongside chatgpt + gemini.
  First visit may show a one-time Akamai challenge to solve in the browser.
- `scripts/sync-war-gov.mjs` (+ `npm run corpus:fetch-war-gov`) — CLI orchestrator
  that calls the daemon, filters by type, downloads into
  `data-raw/war-gov/release_<n>/`.
- `config/releases.json` — added `paths.localDir` per release; pass-through into
  `work-available.json`.

**Why `@unverified`:** the entire war.gov-driver path has never been run end-to-end.
Akamai blocks our IPs, so neither the agent nor the maintainer's CI can test the
collector — only the maintainer's real Chrome can. The driver compiles, the daemon
queues it, the script reaches the daemon, but the live behavior (does the index
actually live at `/UFO/api/records`? does the network intercept catch the right
XHR? does Range chunking work on war.gov's CDN?) is unknown until the first run.
`scripts/find-unverified.mjs` surfaces both files in `corpus:unverified`.

**Plan from here:**
1. Maintainer runs `npm start --prefix pursue-vision-mcp`, solves the Akamai
   challenge once in the war.gov tab, runs `npm run corpus:fetch-war-gov -- --dry-run`
   to verify the index discovery, then `npm run corpus:fetch-war-gov` for real.
2. Patch whichever discovery strategy in `war-gov-driver.mjs` actually matched
   (network intercept / DOM scrape / candidate URL); remove `@unverified` annotations.
3. Audio + video files use the existing Whisper transcription path:
   `npm run corpus:transcribe-videos`. The 7 audio + 51 video files in Release 02
   flow through `scripts/transcribe-videos.mjs` (which already exists for the
   release-01 DVIDS clips).
4. Flip `release-02` to `status: "mirrored"` in `config/releases.json` once ingested.
5. Denis's mirror, if it materializes, becomes a redundant cross-check rather than
   the critical path.

**Owner:** maintainer (live test), then auto from there.

---

_Updated 2026-05-22 (later): R9 — MCP-based war.gov collector landed (`pursue-vision-mcp/war-gov-driver.mjs`, daemon endpoints, `scripts/sync-war-gov.mjs`, `npm run corpus:fetch-war-gov`). Marked `@unverified` pending the maintainer's first live run against their real Chrome; Akamai blocks our IPs so neither the agent nor CI can test it._
_Updated 2026-05-22: added R9 (Release 02 published on war.gov; scaffolded as "incoming", ingest blocked on the DenisSergeevitch/UFO-USA mirror — watch loop polls the upstream manifest)._
_Updated 2026-05-21 (2.2 sweep, follow-up): added R8 (`volunteer.mjs --review` producer is missing — consumer wired, producer absent); deleted dead `src/data/threads.js`; fixed stale index.html meta (deleted views + "47 records")._
_Updated 2026-05-21 (2.2 punchlist sweep): refreshed live counts (173 inventory · 121 catalogued · 3,394 pages · 187 MEDIA tiles · review queue 0); clarified R2 verification-vs-code gaps and the 2.2 gemini-driver guard/disconnect fix; corrected R3/R4 from the pre-sync OCR framing; flagged R7 leasing as config-scaffolded-but-unwired._
_Updated 2026-05-20: added R7 (volunteer leasing) + design doc. To propose a new roadmap item, open an issue with the `roadmap` label._
