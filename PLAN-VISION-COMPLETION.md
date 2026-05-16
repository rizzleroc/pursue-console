# Plan: Complete the Vision-OCR Conversion

**Goal:** replace tesseract-grade OCR with ChatGPT-vision transcription on every page where it'll meaningfully improve search precision. Ship the cleaner corpus to the live deploy in regular increments so progress is visible.

## State as of this plan

| Bucket | Docs | Pages |
|---|---:|---:|
| Clean pdfjs text-layer (no OCR ever needed) | 24 | — |
| Fully vision-OCR'd | 4 | 18 |
| Partial vision (some pages still tesseract) | 9 | 40 still tesseract |
| Pure tesseract (no vision yet) | 6 + 4 quirks | 557 still tesseract |
| **Total tesseract pages remaining** | — | **~597** |

The four heavy hitters carry the bulk: `incident-summaries` 202p, `fbi-62hq83894` 179p, `cometa` 94p, `1949-discs` 53p (528 of 597).

## Constraints

- **Pacing:** `vision-ocr.mjs` paces ChatGPT calls at `PACE_SECS=25`. Stays under the ~80 GPT-5-vision-msg / 3-hour window on ChatGPT Plus.
- **Wall-clock per page:** 30–90s (network + model + retry backoffs). Effective rate ~40 pages per 3-hour batch.
- **Render failures:** some PDFs crash the local pdfjs renderer on specific embedded images (skylab all-pages, parts of apollo-17, scattered pages in other docs). Cached as empty files, never retried. Address with BYO-API path or hand-transcribe later.
- **Cache:** every successful page persists to `data-raw/.vision-cache/<eid>/p<NNNN>.txt`. Re-runs always resume.
- **After each batch:** `node scripts/build-text-files.mjs && python scripts/build-embeddings.py && node scripts/build-dossier-extracts.mjs && node scripts/build-live-feed.mjs`, commit, push. LIVE view + semantic precision improve every deploy.

## Batch schedule

| # | Target | Pages | Est. wall-clock | Notes |
|---|---|---:|---:|---|
| 2 | **`1949-discs`** | 53 | ~1.5h | first medium doc; 1947–49 FBI flying-disc reports |
| 3 | **`cometa` part 1** (p1–47) | 47 | ~1.5h | French defense study; dense recurring radar references |
| 4 | **`cometa` part 2** (p48–94) | 47 | ~1.5h | |
| 5 | **`fbi-62hq83894` part 1** (p1–60) | 60 | ~2h | the Maury Island file; biggest single PDF in the drop |
| 6 | **`fbi-62hq83894` part 2** (p61–120) | 60 | ~2h | |
| 7 | **`fbi-62hq83894` part 3** (p121–179) | 59 | ~2h | |
| 8 | **`incident-summaries` part 1** (p1–70) | 70 | ~2.3h | Project Blue Book scan, 1948–53 case files |
| 9 | **`incident-summaries` part 2** (p71–140) | 70 | ~2.3h | |
| 10 | **`incident-summaries` part 3** (p141–209) | 69 | ~2.3h | |
| 11 | **Partial-vision mop-up** | ~40 | ~1h | apollo-17, arabian-gulf, shaef, azerbaijan, apollo-12, state, gemini, krasuski, netherlands |

**Total: ~575 pages / ~18 hours of wall-clock**, sequenced across several sessions with cooldowns to respect rate limits. Cache survives interruption.

## Skipped (for now)

- `skylab` 11p — every page crashes the pdfjs renderer (problematic embedded images). Needs the contributor BYO-API path or hand-transcribe.
- `kuwait-may-2022` 1p — single page that crashes render. Visual content only, dossier already shows it.
- `fbi-photos-2025` 1p — 32 photographs, no real text content to extract.
- `africa-2025` 7p — small doc, low search value; will pick up when convenient.

## Execution invocation

```bash
# Per batch (env knobs control scope):
PACE_SECS=25 ONLY=1949-discs node scripts/vision-ocr.mjs
PACE_SECS=25 ONLY=cometa node scripts/vision-ocr.mjs           # script naturally resumes from cache for parts 2+
PACE_SECS=25 ONLY=fbi-62hq83894 node scripts/vision-ocr.mjs
PACE_SECS=25 ONLY=incident-summaries node scripts/vision-ocr.mjs

# After each batch:
node scripts/build-text-files.mjs
python scripts/build-embeddings.py
node scripts/build-dossier-extracts.mjs
node scripts/build-live-feed.mjs
git add -A && git commit -m "Corpus: vision batch N + rebuild" && git push
```

## What gets better with each batch

- **LIVE view:** new transcription entries appear with timestamps and source = VISION (cyan badges).
- **Semantic search:** OCR-noise top-K hits get replaced with clean vision text; cosine probes climb in precision.
- **Dossier excerpts:** vision-clean pages produce visibly cleaner top-3 sentences per page (the wordlist junk filter is currently dropping a lot of tesseract excerpts).
- **FAISS validator (Gate 4):** more clean reference text per page → better agreement scores for contributor submissions.
- **Patterns analysis** (`scripts/faiss-patterns.py`): cluster cohesion improves; semantic probe top hits look less like OCR garbage.

## Stopping rule

When tesseract chunks fall below **20% of the corpus** (currently 70%), the heavy lifting is done. The remaining tesseract pages would mostly come from rendered-error docs that need the contributor path anyway.
