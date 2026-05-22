# Submission Judge Standard

**The standard a contributed transcription must meet to be merged into the canonical corpus.**

> Updated for 2.0: covers four submission paths (`human` / `gpt-vision` / `gemini` text transcriptions + `media` image-and-context submissions). Media submissions get a separate schema gate (`kind` enum, `title` ≥4 chars, `context` ≥20 chars verbatim, image present + 5KB–5MB) plus the same safety scan on text fields.

This document is the source of truth. The validators in `scripts/validate-contribution.mjs` (fast, lexical + safety) and `scripts/validate-contribution-semantic.py` (FAISS-based, semantic) implement it exactly. The GitHub Action `validate-contribution.yml` runs both on every PR touching `contributions/`.

If the validators say "pass," your work goes in. If they say "review," a maintainer reads it. If they say "reject," the standard below tells you why and how to fix it.

---

## Why a standard exists

> "To make it searchable you need to index this using FAISS. Yes there are many deep patterns, here data is complex, hence insight will not be linear after all." — *feedback that triggered this document*

The corpus is still modest (~5,584 vector chunks today) but each chunk participates in semantic search across the whole record set. A single bad submission — hallucinated text, wrong-page paste, OCR mojibake re-uploaded — polluted at the chunk level surfaces in unrelated queries. Better to gate at intake than apologize forever.

The data is also genuinely non-linear: the same UAP event is described differently by FBI, NASA, and CENTCOM. We don't enforce a single "correct" transcription. Multiple corroborating transcriptions of the same page are *additional signal*, not duplicates — the system can average them. What we DO enforce is that each individual submission is itself trustworthy.

---

## The five gates

A submission passes when it crosses all five. Any gate below the floor and the file is rejected; in the gray bands a maintainer reviews.

### Gate 1 — Schema

| Check | Required | How to fix |
|---|---|---|
| Path matches `contributions/<handle>/<source>/<eid>/p<NNNN>.txt` where `<source>` ∈ `human` / `gpt-vision` / `gemini`, OR `contributions/<handle>/media/<eid>/p<NNNN>.{json,jpg}` for image contributions | yes | rename / move |
| Filename matches `p\d{1,4}\.txt` (or `.json`/`.jpg` for media) | yes | zero-pad page numbers |
| Encoding is UTF-8 | yes | save as UTF-8 |
| File ≤ 256 KB | yes | one page per file; split if larger |
| `<event-id>` appears in `src/data/events.js` | yes | open an issue to catalog the event first |

### Gate 2 — Safety

The submission is **scanned and rejected** if it contains:

- `<script>`, `<iframe>`, `javascript:`, `data:text/html` patterns (XSS prevention)
- LLM commentary leakage: `as an AI…`, `I cannot view…`, `I apologize…`, `the image appears to be…`
- More than 5 single tokens of length ≥ 40 (URL / base64 dump heuristic)

These are non-negotiable. If your model added commentary, strip it before submitting.

### Gate 3 — Lexical quality

Real English text scores 0.5–0.8 of tokens matching the top-10K English wordlist. Tesseract OCR noise scores 0.0–0.25.

| Band | Score | Outcome |
|---|---|---|
| ✓ Pass | `q ≥ 0.40` | auto-mergeable |
| ? Review | `0.25 ≤ q < 0.40` | maintainer reads it |
| ✗ Reject | `q < 0.25` | blocked |

Quality is calculated identically to `scripts/build-embeddings.py` (deliberate — the same threshold the search index uses) over text minus an unavoidable margin for legitimate technical content (callsigns, coordinates).

### Gate 4 — Semantic authenticity (FAISS-based)

**This is the gate the FAISS feedback specifically requested.**

The validator embeds your contribution with the same `sentence-transformers/all-MiniLM-L6-v2` model the search index uses, then runs three FAISS queries against `public/embeddings.bin`:

#### 4a. **Document affinity** — does this chunk belong to its claimed event?

The top-5 nearest existing chunks in the index, by cosine similarity, are inspected. **At least one must come from the same `<event-id>` you're submitting to.** If your "page 73 of fbi-62hq83894" looks more like Apollo 17 than the rest of the FBI Vault, the submission is rejected — either you mislabeled the event-id, or the content is fabricated.

| | Outcome |
|---|---|
| ≥ 1 of top-5 is same eid | ✓ pass |
| Top-1 is same eid | ✓ pass (strongest signal) |
| 0 of top-5 are same eid, but cos to doc centroid ≥ 0.30 | ? review |
| 0 of top-5 are same eid, cos to centroid < 0.30 | ✗ reject — content does not match doc |

#### 4b. **Canonical agreement** — does this match what we already have for this page?

If `data-raw/.vision-cache/<eid>/p<NNN>.txt` already exists, the validator compares your text to it via cosine on the new embeddings.

| Cos to canonical | Outcome |
|---|---|
| ≥ 0.85 | ✓ corroborates — high confidence |
| 0.60–0.85 | ✓ overlapping but distinct — both kept as redundant transcriptions |
| 0.30–0.60 | ? review — significant divergence |
| < 0.30 | ✗ reject — substantially contradicts canonical |

#### 4c. **In-document continuity** — does this fit between its neighbours?

If pages N-1 or N+1 of the same document exist in the corpus, the cosine between your submission and their mean vector is computed. This catches "you transcribed the wrong page" mistakes.

| Cos to ±1 page mean | Outcome |
|---|---|
| ≥ 0.40 | ✓ pass |
| 0.20–0.40 | ? review |
| < 0.20 with ≥ 2 neighbors present | ✗ reject — content doesn't fit the surrounding pages |

### Gate 5 — Provenance

Optional but encouraged. The PR description should state:

- **Source PDF**: war.gov URL or other primary-source link
- **Model used**: GPT-4o / Claude 3.5 Sonnet / Gemini 1.5 Pro / hand / etc.
- **Prompt** (if applicable): the exact instruction you gave the vision model

This isn't validated automatically but **maintainer review weighs it heavily** for `? review`-band files. Submissions that disclose their pipeline transparently move through faster than opaque ones.

---

## Outcome matrix

A file passes if **all five gates** are PASS or N/A. A file is reviewed if any gate is REVIEW and no gate is REJECT. A file is rejected if **any** gate is REJECT.

```
SCHEMA     PASS / REJECT
SAFETY     PASS / REJECT
LEXICAL    PASS / REVIEW / REJECT
SEMANTIC   PASS / REVIEW / REJECT  (combination of 4a + 4b + 4c)
PROVENANCE PASS / N/A              (informational only)
```

The CI workflow posts the per-file matrix as a PR comment.

---

## Non-linearity acknowledged

The data we're transcribing is genuinely complex:

- The same UAP incident is reported by **multiple agencies** with **different details** — that's signal, not contradiction. Gate 4b's "0.60–0.85: both kept" band is deliberate.
- Some pages are **photographs with captions**, **handwritten notes**, **redacted blocks**, **diplomatic cables in foreign languages**. Different valid transcriptions exist for the same page depending on what the contributor chose to render.
- The quality wordlist is English. **Foreign-language pages will score low on Gate 3** and route to review. Maintainer judgement handles them; we don't auto-reject on language.

The standard is calibrated to **be strict on hallucination and noise, permissive on genuine multi-version transcription**.

---

## Running the validators locally

```bash
# Fast lexical + safety check (Node)
npm run contrib:validate

# Full standard including FAISS semantic gate (needs Python + faiss-cpu)
npm run contrib:validate:semantic
```

Both produce the same outcome matrix as CI. Run them before pushing a PR.

---

## Changes to the standard

The standard is itself versioned in this file. Substantive changes (thresholds, new gates) require a PR with maintainer review. Tooling changes (faster wordlist, better tokenizer) can be merged when CI is green.

---

## Credit

Contributors whose submissions pass are credited in the commit history and `CONTRIBUTORS.md`. High-volume contributors who consistently pass on the first try are recognized in `CONTRIBUTORS.md` and may gain expedited review for `? review`-band files — an informal, planned mechanism rather than a separate roster.

Reviewers are credited similarly. The goal is for the standard to be transparent enough that any reasonable reviewer reaches the same verdict as any other.
