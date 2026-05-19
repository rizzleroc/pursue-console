# Contributing to PURSUE Console

**This is an open investigation. Pull requests are encouraged.** Most of the highest-value contributions are reading the actual primary documents and improving the data — you don't need to be a developer.

Before anything else, please read [HOW-CAN-I-HELP.md](./HOW-CAN-I-HELP.md). It documents the **three-priority ladder**: settle the REVIEW queue first, then transcribe new pages, then image + context capture. The order matters because lower-numbered priorities settle work that's blocking everything downstream.

---

## Quick reference — where contributions land

```
contributions/<your-handle>/
├── human/<eid>/p<NNNN>.txt              ← hand-typed transcription (always wins canonical)
├── gpt-vision/<eid>/p<NNNN>.txt         ← ChatGPT OCR via scripts/volunteer.mjs
├── gemini/<eid>/p<NNNN>.txt             ← Gemini OCR via scripts/volunteer.mjs
└── media/<eid>/p<NNNN>.{json,jpg}       ← image + verbatim context
```

The validator runs on every PR. Verdicts post as a PR comment. See [JUDGE-STANDARD.md](./JUDGE-STANDARD.md) for the gates.

---

## What needs contributors

### 1. Settle a disputed page *(highest leverage · no tooling)*

Open the [REVIEW tab](https://rizzleroc.github.io/pursue-console/). Pick a page where machine sources disagree. Read the source PDF (linked from DOSSIER). Type the correct version. Drop it at `contributions/<your-handle>/human/<eid>/p<NNNN>.txt` and open a PR.

**Why this is the highest-leverage thing you can do:** a human-typed page becomes the canonical text for that page no matter what any machine produced, AND becomes gold against which every machine source is scored going forward. One disputed page resolved → calibrates the whole pipeline.

### 2. Transcribe new pages *(needs ChatGPT Plus or Gemini · ~30 min)*

Anyone with a logged-in browser tab can OCR a slice of unprocessed pages.

```bash
curl -fsSL https://rizzleroc.github.io/pursue-console/install-helper.sh | bash    # macOS/Linux
iwr https://rizzleroc.github.io/pursue-console/install-helper.ps1 | iex            # Windows
cd pursue-helper
npm start --prefix pursue-vision-mcp
npm run volunteer -- --my-handle=YOU --slice=20                                    # ChatGPT
npm run volunteer -- --my-handle=YOU --slice=20 --provider=gemini                  # or Gemini
```

The script claims pages off the live queue (`public/work-available.json`), runs them through your own browser tab, opens a PR.

### 3. Image + context capture *(NEW in 2.0 · ~1 hour)*

For pages with photographs, hand-drawings, newspaper clippings, maps, or diagrams. Two-phase script:

```bash
node scripts/volunteer-media.mjs --my-handle=YOU --slice=5         # claim + render
# (fill the per-page markdown templates at ~/.pursue-helper/media-staging/)
node scripts/volunteer-media.mjs --my-handle=YOU --commit          # commit + PR
```

Spec: [VISUAL-EXTRACTION-PROCESS.md](./VISUAL-EXTRACTION-PROCESS.md).

### 4. Add a missing record from the official inventory

We have 121 of 173 records catalogued. The remaining 52 have URLs (from the Denis manifest sync) but no metadata. Edit [`src/data/events.js`](./src/data/events.js):

```js
{
  id: "kebab-case-id",
  title: "Short human title",
  date: "1948-03-14",          // or "1947–1949" for ranges
  era: "40s",                  // 40s|50s|...|20s
  agency: "FBI",               // FBI · NASA · Department of War · Department of State
  loc: "Roswell, NM",
  region: "Americas",          // or Europe/Asia/MidEast/Africa/Oceania/ExtraPlanetary
  coords: [33.39, -104.52],    // [lat, lon], or null for extra-planetary
  type: "Mission Report",      // free-form
  flag: "anchor",              // "anchor" for the highest-impact items, else omit
  summary: "Two paragraphs grounded to the PDF. No speculation beyond the document.",
  tags: ["disc", "radar", "witness"],
  url: "https://www.war.gov/medialink/ufo/release_1/<file>.pdf",
}
```

Run `npm run dev` to verify the record renders, then PR.

### 5. Add or correct entities in the connective-tissue index

[`src/data/entities.js`](./src/data/entities.js) is hand-curated. If you spot a person/program/platform/morphology/behavior that recurs and isn't indexed, add it. If you spot an event referencing an existing entity that isn't linked, add the event id to that entity's `events` array.

### 6. Build a new view

Add a file under `src/views/`, import it in `src/App.jsx`, register it in `src/components/Header.jsx`. The deploy ships in ~40 seconds after merge.

---

## Ground rules

- **Source every claim to the primary documents.** No speculation beyond what the PDFs say.
- **Discuss claims, not contributors.** See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
- **Don't paste model speculation into transcripts.** The validator looks for telltale LLM-commentary patterns ("I would interpret this as…", "this appears to show…") and rejects them.
- **Match the existing path convention** for transcriptions. `human` is reserved for hand-typed text — never write to it from an automated script.

---

## Run locally

```bash
git clone https://github.com/rizzleroc/pursue-console
cd pursue-console
npm install
npm run dev          # http://localhost:5173
```

The build pipeline (`npm run build`) runs the full data chain — synced inventory, imported transcripts, cross-source comparison, DB rebuild, search index, embeddings, dossier extracts, MEDIA index — then `vite build`. See [`package.json`](./package.json) for the full chain and [README.md](./README.md) for the architecture diagram.

For maintainer batches (vision OCR via the MCP, FAISS rebuild, visual classification, re-evaluation), see the **Maintainer batches** section of the README.

---

## Asking before building

If you're not sure your contribution fits, open an issue first. The [`good first issue`](https://github.com/rizzleroc/pursue-console/labels/good%20first%20issue) and [`data`](https://github.com/rizzleroc/pursue-console/labels/data) labels are good starting points.

**Thank you for helping.** Every record catalogued, every page transcribed, every disputed page settled improves what a person looking at this corpus can find.
