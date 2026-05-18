# Visual Extraction — Process Spec

> **Status:** PROCESS BEING DEFINED · volunteer flow not yet open.
> Until this is finalized, please help with [the REVIEW queue](https://rizzleroc.github.io/pursue-console/) first (disputed pages).

## What this job is

Many pages in the corpus contain visual content embedded inside scanned documents:

- **Photographs** (incl. surveillance imagery)
- **Hand-drawings** (witness sketches, hand-drawn diagrams)
- **Photocopied negatives** (high-contrast or tonally-inverted photocopies of film)
- **Newspaper clippings** (articles reproduced as part of an FBI file or evidence packet)
- **Maps** (geographic, floor plan)
- **Diagrams** (technical, mechanical, schematic)

A page-level OCR transcript captures the text, but it strips away the visual. For research use the visual + its context is often the entire point — a witness's sketch of a craft, a photograph of an alleged landing site, a newspaper headline. The job is to capture **both the image AND the surrounding documentary context** so a researcher viewing the media library sees:

> _"Photograph of an aerial sighting over Roswell, NM — appears on page 47 of FBI file 62-HQ-83894 Section 3. Caption on facing page: 'Subject of report dated August 11, 1947. Distance approximately 1500 ft.' Referenced in the agent's narrative on page 46: 'The witness produced the attached photograph…'"_

## What the volunteer is asked to do (per claimed page)

For each page in your slice that the queue marks as having a visual element:

1. **Identify the visual.** Confirm whether the page truly contains a photo / sketch / newspaper clipping / map / diagram, or whether the classifier was wrong (text-only). Pick the most specific kind.

2. **Capture a screenshot** of the page at a readable resolution. The volunteer script will render this for you at 800px max-edge JPEG — you don't need image-editing tools.

3. **Write a one-line title.**
   - For a photograph: subject + location/context (e.g. `"aerial photograph of disc-shaped object over snowy field"`)
   - For a newspaper clipping: the actual headline, verbatim
   - For a sketch: what the witness was depicting (e.g. `"witness sketch of cylindrical craft with three lights"`)
   - For a map: the area depicted
   - For a diagram: what's being illustrated

4. **Write the documentary context (max ~3 sentences).** This is the bit that takes time but is the whole point. Look at:
   - The page **before** the visual: is there a paragraph that introduces it? (`"see attached photograph"`, `"Subject sketched the following…"`)
   - The page **with** the visual: is there a caption? A typed annotation? A handwritten note?
   - The page **after** the visual: is there commentary or analysis?

   Write the most informative thing you can — verbatim quotes from the document where possible. Don't summarize the article body itself; just the connective tissue that explains why the visual is there.

5. **For newspaper clippings only — also capture the article copy.** If the visual IS the newspaper article, transcribe the article text itself (not the surrounding newspaper page) so the article becomes its own searchable document in the corpus. Headline, byline if any, full body text, caption of any photo within the clipping.

6. **Open a PR.** The volunteer script does this for you; the maintainer merges after the JUDGE-STANDARD validator passes.

## Submission shape

```
contributions/<your-handle>/media/<eid>/p<NNNN>.json
contributions/<your-handle>/media/<eid>/p<NNNN>.jpg    # the screenshot
```

JSON shape:

```json
{
  "kind": "newspaper-clipping",
  "title": "FLYING DISCS REPORTED OVER PUGET SOUND",
  "context": "Reproduced from the Seattle Post-Intelligencer, June 26, 1947 — clipping affixed to FBI memo of June 27 (preceding page). Memo lead reads: 'Bureau attention is directed to the attached news article…'. Article cited as evidence of widespread public reporting; agent's analysis on following page.",
  "article_text": "<full body of the article, only for kind=newspaper-clipping>",
  "captured_at": "2026-05-18T14:00:00Z"
}
```

The image lives next to the JSON at `p<NNNN>.jpg`.

## What the maintainer pipeline does with it

1. Validates schema + safety (same JUDGE-STANDARD gates as text contributions)
2. Imports JSON + image into `data-raw/.visuals/<eid>/` (manifest update via `scripts/import-contributions.mjs`)
3. Re-indexes the MEDIA library and search index
4. Surfaces the article text (when present) as its own document in SEARCH/SEMANTIC, attributed to the source event

## Quality bar

- **Don't include the whole newspaper page** if only one article is the visual of interest. The screenshot should be the article + image, not the surrounding ad copy.
- **Don't summarize.** The context field is for verbatim quotes from the document explaining why the visual is there. Your job is connective tissue, not interpretation.
- **Pick the most specific kind.** A hand-drawn map is `hand-drawing`, not `map`, if the page caption calls it a "sketch by witness."
- **Mark unreadable text** in any transcription block as `[illegible]`, same convention as text-only transcription.

## What's blocking the volunteer flow opening

| Block | Status |
|---|---|
| Page classifier identifies which pages have visuals | ✓ working (maintainer batch in progress) |
| `contributions/<handle>/media/<eid>/` path convention in the importer | not yet |
| Validator gate for media submissions (schema, image present, image readable) | not yet |
| Claim API — work-available.json publishes a `visualsNeedingContext` array | not yet |
| Per-page context-capture UI in the volunteer flow | not yet |

When all five are in place, the +VOLUNTEER button gets a new Path C: **Image extraction + context capture**.

---

Until then: please help with [the REVIEW queue](https://rizzleroc.github.io/pursue-console/) or [transcribe new pages](HOW-CAN-I-HELP.md) first. Both are open now.
