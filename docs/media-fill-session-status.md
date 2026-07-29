# Media Library Fill — Session Status

Branch `claude/media-library-fill` (pushed). Tracks the work toward closing the 71-event media-tile gap identified in `docs/media-coverage-audit.md`.

## Summary

| Metric | Before | After | Delta |
|---|---|---|---|
| Total media tiles | 222 | **324** | **+102** |
| Events with tiles | 62 | **133** | **+71** |

Audit tasks closed in this session:
- **Task 2** — Rolled up 23 `fbi-photo-b{2..24}` auto-stubs into the curated `fbi-photos-2025` entry (+23 photograph tiles).
- **Task 3** — Verified Release-02 PDFs are already correctly handled (`DOE-UAP-D001` has 2 photograph tiles; the other 5 are correctly identified as text-only and excluded from MEDIA).
- **FBI Sept 2023 serials (Task 6 adjacent)** — Rendered + surfaced 3 events × 2 pages = 6 photograph tiles (serial-3, serial-4, serial-5).

The bulk of the gain came just from rebuilding `media.json` against the existing `.visuals/` cache (+73 tiles, +68 events from work that had been done but never re-indexed).

## Why the loop stopped short

The plan was to drive `whipgen_chat_with_files` (gemini provider) on the 418 pre-rendered PNGs at `/tmp/render-queue/` to generate per-page OCR transcripts with `[Photograph of …]` / `[Sketch of …]` / `[Diagram of …]` bracket markers that the existing `extract-media-from-gemini.mjs` pipeline reads.

The whipgen daemon wedged on the first multi-page upload attempt (gemini-pro thinking time + image upload exceeded the 60s tool-call ceiling) and never recovered for the rest of the session. Every subsequent `whipgen_*` call — including `whipgen_status` and `whipgen_health`, which are documented as instant — also timed out at 60s. Same wedge pattern as previously seen; usually clears on a fresh session start.

## What's still uncovered (44 events, ~395 pages on disk)

All PDFs are rendered to PNGs under `/tmp/render-queue/<eid>/p<NNNN>.png` (DPI 2.0) but lack the Gemini-style transcripts. `/tmp/render-worklist.json` lists them:

| Cohort | Events | Pages | Notes |
|---|---|---|---|
| DOW mission reports | 13 | 89 | Mostly text intake forms — many will classify as text-only and stay excluded from MEDIA anyway |
| DOW d48 Air Force Report 1996 | 1 | 181 | Likely diagram-rich — needs real visual analysis |
| DOW d49 Launch Summary 2000 | 1 | 113 | Likely chart/diagram-rich |
| NASA Apollo debriefings | 2 | 5 | Text-only crew debriefings — will classify out |
| DOW d44 range fouler | 1 | 1 | Text-only form |
| `fbi-photo-b*` (legacy worklist) | 23 | 23 | Already handled — these are the events I rolled up into `fbi-photos-2025` (PNGs are duplicates) |
| `fbi-september-2023-sighting-serial-*` | 3 | 6 | Done in this session |

The bottom 3 cohorts are done or won't add tiles. The high-value remaining ones are **DOW d48 + d49** (~294 pages of scanned-image-heavy government reports with embedded diagrams) which genuinely need whipgen vision to classify.

## How to resume

1. Start a fresh Claude Code session (whipgen daemon should reset).
2. Verify with one `whipgen_chat_with_files` call on `/tmp/render-queue/dow-uap-d62-mission-report-strait-of-hormuz-september-2020/p0001.png` using the prompt format documented in this session's transcript (OCR + bracketed visual markers, page separators).
3. Loop through the remaining worklist events, writing each page's response to `data-raw/.vision-cache/<eid>/p<NNNN>.gemini.txt`.
4. Run `node scripts/extract-media-from-gemini.mjs && node scripts/classify-visuals.mjs && node scripts/build-media-index.mjs`.
5. Commit + push.

For d48 / d49 specifically — given they're 113+181pp and the whipgen 60s ceiling, batch in groups of ~5 pages per call to fit each response under the 8 MB result cap.

## Other audit work not yet done

- **Task 4** — Sanity-check 9 curated text-only events for buried sketches/maps. Low impact since the audit notes "most are genuinely text-only by design."
- **Task 6** — Reconcile CSV `Serial 003` vs catalogue `serial-5` title discrepancy. The catalogue resolves the URL correctly; the CSV side appears to have a typo. Cosmetic.
- **Task 7** — Resolve `59_64634_711.5612[7-2852.pdf` (1952 DOS memo) as new entry or duplicate of `state-1952`. Needs cross-checking against war.gov.

## Commits

- `9478dfc9d` — feat(media): roll up fbi-photo B-series into fbi-photos-2025 (+23 tiles)
- `2df6af532` — feat(media): surface 3 FBI Sept 2023 serial photo sets (+6 tiles)

Plus the baseline-rebuild commit `6203a0ab8` from earlier in the session (+73 tiles from the existing visuals cache).
