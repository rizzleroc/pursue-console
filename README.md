# PURSUE Console — Release 01

![PURSUE Console](./public/og-card.png)

> **An open, community-built investigation unit for the [war.gov/UFO Release 01](https://www.war.gov/UFO) disclosure.**
> *Department of War, May 8 2026 — 162 records. All cases UNRESOLVED.*

[![Deploy](https://github.com/rizzleroc/pursue-console/actions/workflows/deploy.yml/badge.svg)](https://github.com/rizzleroc/pursue-console/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-7CFFB2.svg)](./CONTRIBUTING.md)
[![Live site](https://img.shields.io/badge/live-rizzleroc.github.io%2Fpursue--console-FFD93D)](https://rizzleroc.github.io/pursue-console/)

**Live:** https://rizzleroc.github.io/pursue-console/

---

## What this is

The official Release 01 site is a flat directory of PDFs and videos. **Reading the documents one by one tells you each story. Reading them as a system tells you what the corpus is actually saying.** This console adds the connective tissue:

- a **chronological** view (1944 → 2026)
- a **geospatial** view (drag-rotate globe + extra-planetary sidebar)
- an **agency × decade** heatmap
- a **force-directed graph** of events ↔ entities (people, programs, commands, platforms, sensors, morphologies, behaviors)
- a **patterns** view ranking the signatures that recur across cases
- **curated narrative threads** with theses (Foo Fighters → Project Sign, the NASA Arc, the CENTCOM Cluster, the Hard Cases…)
- a **dossier** per record cross-linking attached entities, threads it appears in, and co-occurring records ranked by shared-entity overlap

Currently **51 of 162** records are catalogued. Help us get to 162.

---

## 📡 Live feed of new transcriptions

The corpus grows page by page. Every time a vision-OCR batch runs the **LIVE** view shows the latest transcribed pages with timestamps, quality, and source (ChatGPT vision vs. tesseract). See `public/live-feed.json` or open the LIVE tab in the app.

**Anyone who clones can contribute transcriptions** — see [CONTRIBUTING-CORPUS.md](./CONTRIBUTING-CORPUS.md). PRs touching `contributions/` are auto-validated for quality + safety before merge.

The repo includes a minimal open-source vision-OCR daemon at [`pursue-vision-mcp/`](./pursue-vision-mcp/) (~600 lines, MIT). If you have ChatGPT Plus and a Chrome profile signed in, that's all you need to run vision OCR locally — no API keys required.

### 📡 SETI-style distributed contributions — [HOW-CAN-I-HELP.md](./HOW-CAN-I-HELP.md)

We publish a live work queue at `public/work-available.json`. Run the volunteer script and your machine pulls a slice from the queue, OCRs it through your own ChatGPT session, and opens a PR back. The maintainer's one ChatGPT Plus account stops being the bottleneck.

```bash
git clone https://github.com/rizzleroc/pursue-console
cd pursue-console/pursue-vision-mcp && npm install && npm start
cd .. && npm run volunteer -- --my-handle=YOU --slice=20
```

---

## 🌍 Open project — contributions welcome

**You don't need to be a developer.** The highest-value contributions are reading the actual primary documents and improving the data:

- **Add a missing record** from the official inventory ([`src/data/events.js`](./src/data/events.js))
- **Improve a summary** by grounding it more tightly to the source PDF
- **Add or correct entities** in the connective-tissue index ([`src/data/entities.js`](./src/data/entities.js))
- **Propose a new narrative thread** ([`src/data/threads.js`](./src/data/threads.js))
- **Build a new view** — search, compare, witness-reliability matrix, sensor-modality matrix — see [CONTRIBUTING.md](./CONTRIBUTING.md) for ideas
- **A11y + polish** — keyboard nav, reduced-motion preference, screen-reader labels

**→ Start with [CONTRIBUTING.md](./CONTRIBUTING.md).** It has concrete how-tos for each kind of contribution.
**→ Read [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).** The short version: discuss claims, not contributors.

If you're poking around for the first time, the [`good first issue`](https://github.com/rizzleroc/pursue-console/labels/good%20first%20issue) and [`data`](https://github.com/rizzleroc/pursue-console/labels/data) labels are good starting points.

---

## Project structure

The structure makes the contribution surfaces obvious. Most data contributions touch one file:

```
pursue-console/
├── src/
│   ├── data/                      ← the corpus + the graph (most PRs land here)
│   │   ├── events.js              ← 51 records — add a record, fix a summary
│   │   ├── entities.js            ← people · programs · commands · platforms
│   │   │                            sensors · morphologies · behaviors
│   │   │                            (the connective tissue — add an entity,
│   │   │                            link an event id)
│   │   └── threads.js             ← curated narrative arcs (propose a thread)
│   │
│   ├── views/                     ← one file per view — drop in a new one
│   │   ├── TimelineView.jsx       ← chronology by decade
│   │   ├── GlobeView.jsx          ← drag-rotate orthographic globe
│   │   ├── AtlasView.jsx          ← agency × decade heatmap
│   │   ├── NetworkView.jsx        ← force-directed entity graph
│   │   ├── PatternsView.jsx       ← ranked signatures
│   │   ├── ThreadsView.jsx        ← curated arcs
│   │   ├── ConstellationView.jsx  ← keyword cloud
│   │   └── DossierView.jsx        ← per-record reading + cross-links
│   │
│   ├── components/                ← shared primitives
│   │   ├── Header.jsx             ← register a new view here
│   │   └── Primitives.jsx         ← MiniChip, GlitchText, RadarSweep, etc.
│   │
│   ├── App.jsx                    ← view router + filter pipeline
│   └── main.jsx
│
├── .github/
│   ├── workflows/deploy.yml       ← Pages deploy on push to main
│   ├── ISSUE_TEMPLATE/            ← bug · data correction · feature
│   └── pull_request_template.md
│
├── CONTRIBUTING.md                ← how to contribute (read this first)
├── CODE_OF_CONDUCT.md
├── LICENSE                        ← MIT
└── README.md
```

**Adding a record** = edit one file. **Adding a view** = add one file + one import + one nav entry. **Adding an entity** = append one object to a list.

---

## Run locally

```bash
git clone https://github.com/rizzleroc/pursue-console
cd pursue-console
npm install
npm run dev          # http://localhost:5173
```

Build a production bundle:

```bash
npm run build        # → dist/
```

### Full-text corpus (powers the Constellation view)

`src/data/corpus.json` is the extracted full-text index of the primary PDFs. It's committed so the app works out of the box. To regenerate or extend it:

```bash
npm run corpus:fetch      # downloads every event's PDF into data-raw/ (gitignored, ~800 MB)
npm run corpus:extract    # pdfjs-dist text extraction → src/data/corpus.json
npm run corpus:ocr        # OCR pass for image-only/scanned PDFs (slow; tesseract.js)
                          #   env: MAX_PAGES=40 ONLY=id1,id2 SKIP=id3
```

The text-extraction step is fast (seconds). The OCR step is slow (~5–10 s per page) — many of the older records (FBI Vault sections, COMETA, Project Blue Book incident summaries) are scanned page images. Run, walk away.

Stack: Vite + React 19 + Tailwind v3. **No graph or chart libraries** — the network view is a ~70-line force-directed layout, the globe is a hand-rolled orthographic projection, the heatmap and patterns view are CSS grid + computed widths.

---

## Deploys automatically

Every push to `main` runs [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml), which builds and ships to GitHub Pages. After your PR merges, your change is live in ~40 seconds.

---

## Source posture

Every record cites back to `https://www.war.gov/medialink/ufo/release_1/...`. Videos link to DVIDS. **All cases marked UNRESOLVED by the originating agencies.** This console is an unofficial mirror with hand-curated structure on top; nothing here adds claims beyond the primary documents. See the rules in [CONTRIBUTING.md](./CONTRIBUTING.md#ground-rules).

Release 01 is the first of rolling tranches arriving every few weeks. When the next tranche drops, that's where new event records come from.

---

## License

[MIT](./LICENSE) © 2026 PURSUE Console contributors.
