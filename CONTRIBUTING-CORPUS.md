# Contributing Transcriptions

The corpus is grown by hand. **You can help.** Anyone who clones the repo can run vision-OCR on the source documents and submit transcriptions back. Submissions are validated automatically and reviewed before merging.

Tracked on the **LIVE FEED** view in the deployed app: https://rizzleroc.github.io/pursue-console/

---

## What we need

The corpus is 162 records on war.gov/UFO. The current state is broken down on the live feed:

- **Clean text-layer PDFs** — 24 docs done automatically by pdfjs, no work needed
- **Vision-transcribed** — pages re-OCR'd by ChatGPT vision, high quality
- **Tesseract-only** — pages where tesseract OCR produced text; we want to replace these with vision transcription

**The biggest tesseract-noise sources** (these dominate the corpus and want vision passes most):

| Doc | Pages still on tesseract |
|---|---:|
| `incident-summaries` | ~200 |
| `fbi-62hq83894` | ~180 |
| `cometa` | ~94 |
| `1949-discs` | ~53 |
| `apollo-17` | ~10 |

The full list updates on every deploy — see `public/live-feed.json` or the LIVE view.

---

## How to contribute

### 1. Fork & clone

```bash
git clone https://github.com/<your-handle>/pursue-console
cd pursue-console
npm install
```

### 2. Get the source PDFs

You need the original PDFs locally. Two ways:

- **Download from war.gov** — `npm run corpus:fetch` pulls everything we have URLs for into `data-raw/` (~774 MB)
- **Already have them** — drop them at `data-raw/<event-id>.pdf` matching event ids in `src/data/events.js`

### 3. Run vision transcription

You have three options for the vision model:

**a) ChatGPT-Plus via the whipgen MCP daemon (what the maintainer uses)**

If you have ChatGPT Plus and a Chrome profile signed in, [whipgen-mcp](https://github.com/rizzleroc/whipgen-mcp) drives your browser to do GPT-vision OCR with no API keys.

```bash
cd ../whipgen-mcp && npm start
cd ../pursue-console
PACE_SECS=25 ONLY=fbi-62hq83894 node scripts/vision-ocr.mjs
```

**b) Bring your own vision API**

The pipeline accepts any per-page text source. Write text into `data-raw/.vision-cache/<event-id>/p<NNNN>.txt` (zero-padded 4 digits) using any model you have access to — Claude Vision, GPT-4o API, Gemini, local LLaVA, anything. The validator just reads the .txt files.

**c) Hand-transcribe**

For short docs or single pages, type the text yourself. Quality scoring doesn't care where the words came from, only that they're English.

### 4. Move your files into `contributions/`

After running OCR, your transcriptions live in `data-raw/.vision-cache/`. To submit them, copy or symlink into `contributions/<your-handle>/<event-id>/p<NNNN>.txt`:

```bash
mkdir -p contributions/yourname/fbi-62hq83894
cp data-raw/.vision-cache/fbi-62hq83894/p*.txt contributions/yourname/fbi-62hq83894/
```

### 5. Validate locally before pushing

```bash
# Fast lexical + safety + schema (Gates 1-3, Node)
npm run contrib:validate

# Full standard including FAISS Gate 4 (needs Python + faiss-cpu)
pip install faiss-cpu sentence-transformers
npm run contrib:validate:all
```

You'll see per-file output like:

```
✓ contributions/yourname/fbi-62hq83894/p0001.txt   q=0.512  vs-canon=0.84
? contributions/yourname/fbi-62hq83894/p0002.txt   q=0.337                · needs maintainer review
✗ contributions/yourname/fbi-62hq83894/p0003.txt   q=0.122                · below quality floor
```

- `✓ pass` — q ≥ 0.40 — auto-mergeable
- `? review` — q in 0.25–0.40 — flagged for human review
- `✗ reject` — q < 0.25 or schema/safety violation — fix or drop the file

Re-run with `VERBOSE=1` for full diagnostics.

### 6. Open a PR

```bash
git checkout -b transcribe-fbi-vault
git add contributions/yourname
git commit -m "Vision-transcribe fbi-62hq83894 pages 1-40"
git push origin transcribe-fbi-vault
gh pr create
```

The GH Actions workflow `validate-contribution.yml` re-runs the validator on your PR and posts the report as a check. **A maintainer reviews the `? review`-band files manually**, then merges. After merge, `npm run corpus:rebuild` regenerates `public/text/`, `public/embeddings.bin`, `public/live-feed.json` and your transcription is live in the next deploy.

---

## Validation: the JUDGE STANDARD

**The full standard is in [JUDGE-STANDARD.md](./JUDGE-STANDARD.md) — read that for the authoritative rules.** Quick recap:

Five gates run on every PR (CI workflow `.github/workflows/validate-contribution.yml`):

| Gate | What | Tool |
|---|---|---|
| **1 — Schema** | path layout, filename, UTF-8, ≤256 KB, eid exists | Node |
| **2 — Safety** | no XSS markers, no LLM commentary leakage, no URL/base64 dumps | Node |
| **3 — Lexical quality** | fraction of real English words. q≥0.40 pass · 0.25–0.40 review · <0.25 reject | Node |
| **4 — Semantic authenticity** | FAISS top-5 should hit same eid · cos to canonical (if any) banded · cos to neighbor pages banded | **Python + FAISS** |
| **5 — Provenance** | source PDF, model used, prompt (PR body) | informational |

Gate 4 is the FAISS-based judgment. It loads `public/embeddings.bin` into a real `faiss.IndexFlatIP`, embeds your contribution with the same `sentence-transformers/all-MiniLM-L6-v2` the search uses, and refuses content that:
- semantically belongs to a different event than you claimed,
- substantively contradicts a canonical transcription we already have,
- doesn't fit between its neighbour pages.

The CI workflow posts the per-file matrix as a PR comment. Read [JUDGE-STANDARD.md](./JUDGE-STANDARD.md) for the exact thresholds and how to fix each kind of rejection.

**Why we don't auto-accept everything:** the index is small enough (~900 vector chunks today) that one polluting contribution measurably degrades semantic search. Better to gate than to apologize.

---

## What gets merged & what doesn't

- ✓ `pass` files **auto-merge** after CI green + maintainer review
- ? `review` files merge after a maintainer reads them
- ✗ `reject` files don't merge; the validator output tells you why

For pages we already have in `data-raw/.vision-cache/`, your contribution **augments** the dataset — multiple corroborating transcriptions of the same page are valuable signal. The corpus build picks the highest-quality version per page; future work will average across transcriptions for cross-source confidence.

---

## What you get

- Your contributions are credited in the commit history.
- High-volume contributors are added to a `CONTRIBUTORS.md`.
- The LIVE view shows transcription events with timestamps — your work appears there as soon as the next deploy lands.
- The semantic search gets better page by page, and you helped.

Questions? Open an issue tagged `corpus`.
