# PURSUE Console — Release 01

Interactive investigation unit for **war.gov/UFO Release 01** (Department of War, May 8 2026 — 162 records). The official site is a flat directory of PDFs and videos. This console adds the connective tissue: an entity graph, recurring signatures, and curated narrative threads through 51 source records.

## Why this exists

The raw release is a haystack. Reading the documents one by one tells you each story. Reading them as a system — same names recurring, same morphologies recurring, same commands filing the same kinds of reports — tells you what the corpus is actually saying.

## Views

| View | What it shows |
|------|---------------|
| **TIMELINE** | Chronology, 1944 → 2026, by decade, color-coded by agency |
| **GLOBE** | Orthographic projection with drag-to-rotate; terrestrial events plotted, extra-planetary cases in a sidebar |
| **ATLAS** | Agency × decade heatmap with type-of-record counters |
| **NETWORK** | Force-directed graph — events ↔ entities (people, programs, commands, platforms, sensors, morphologies, behaviors). Pin an entity to see every record that references it. **The connective tissue.** |
| **PATTERNS** | Ranked signatures: which morphologies, behaviors, sensor modalities, platforms, commands recur — and exactly which records exhibit them |
| **THREADS** | Eight curated narrative arcs (Foo Fighters → Project Sign, the NASA Arc, the CENTCOM Cluster, the Hard Cases, etc.) |
| **TAGS** | Keyword cloud sized by frequency; pivot to find shared tags |
| **DOSSIER** | Per-record reading view with primary-source link, DVIDS video, attached entities, threads-it-appears-in, and co-occurring records ranked by shared-entity overlap |

## How the connective tissue works

- `src/data/events.js` — the 51 records, in structured form.
- `src/data/entities.js` — hand-curated index of people, programs, commands, platforms, weapons, sensors, morphologies, and behaviors. Each entity points to the event ids that reference it. The reverse index is computed at load.
- `src/data/threads.js` — eight narrative arcs, each an ordered sequence of event ids plus a thesis.

That's the whole graph. The Network view runs a small in-process force-directed layout over it.

## Run

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

## Source

All records cite back to `https://www.war.gov/medialink/ufo/release_1/...`. Videos link to DVIDS. **All cases marked UNRESOLVED by the originating agencies.** This console is an unofficial mirror with derived structure; nothing here adds claims beyond the primary documents.

## Stack

Vite + React + Tailwind v3. No external graph or chart library — the network view is ~70 lines of force-layout, the globe is hand-rolled orthographic projection, the heatmap and patterns view are CSS grid + computed widths.
