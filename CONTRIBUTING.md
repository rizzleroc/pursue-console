# Contributing to PURSUE Console

**This is an open investigation. Pull requests are encouraged.** You don't need to be a developer to contribute — most of the highest-value contributions are sourcing claims to primary documents and adding to the entity graph.

## What needs contributors

### 1. Read the source documents and improve the data

The full release is at https://www.war.gov/UFO. We currently have **51 of the 162 records** catalogued.

- **Add a missing record.** Open `src/data/events.js`, follow the shape of an existing entry, link the primary PDF, and add it.
- **Improve a summary.** If the current summary misses something important from the PDF, edit it. Keep it source-grounded — no speculation beyond what the document says.
- **Add or correct entities.** `src/data/entities.js` is hand-curated. If you spot a person/program/platform/morphology that recurs and isn't indexed, add it. If you spot an event referencing an existing entity that isn't linked, add the event id to that entity's `events` array.

### 2. Curate a new narrative thread

`src/data/threads.js` holds the curated arcs. A good thread:

- has a clear thesis (1–3 sentences) the documents collectively support
- is an **ordered** sequence of event ids
- doesn't repeat existing threads' territory

Open an issue first if you're not sure the thread is non-redundant.

### 3. Build a new view

The view modules in `src/views/` are intentionally small and independent. Some ideas open for grabs:

- **Search view** — full-text search over event summaries with snippet highlighting
- **Compare view** — pick 2–3 events side-by-side and surface shared entities
- **Timeline-by-entity** — pick an entity, see only events that reference it on a temporal axis
- **Witness reliability matrix** — flag/elevate/anchor against agency type
- **Sensor modality matrix** — IR/EO/SWIR/radar/visual breakdown

To add a view: drop a `FooView.jsx` in `src/views/`, import it in `src/App.jsx`, and add an entry to the `VIEWS` array in `src/components/Header.jsx`.

### 4. Polish + accessibility

- Keyboard navigation (the views are click/touch-heavy)
- Reduced-motion preference (CRT flicker, radar sweep, anchor pulse)
- Screen-reader labels on the SVG graph and globe

## Ground rules

- **Cite the document.** Every claim added to `events.js` or `threads.js` should be supported by the linked PDF. We don't add speculation, theories of origin, or claims the release itself does not make.
- **All cases are UNRESOLVED.** The government's words. The console should not present any record as "confirmed" anything.
- **Don't add UFO-community lore** that isn't in Release 01. Future tranches will arrive every few weeks; that's where new material comes from.
- **Be kind in code review.** See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## Dev setup

```bash
git clone https://github.com/rizzleroc/pursue-console
cd pursue-console
npm install
npm run dev          # http://localhost:5173
npm run build        # production build to dist/
```

Stack: Vite + React 19 + Tailwind v3. No graph or chart libraries — the network view is a ~70-line force layout, the globe is a hand-rolled orthographic projection.

## Project layout

```
src/
  data/
    events.js       ← 51 records — the corpus
    entities.js     ← people, programs, commands, platforms, sensors,
                      morphologies, behaviors. The graph.
    threads.js      ← 8 curated narrative arcs
  views/
    TimelineView.jsx
    GlobeView.jsx
    AtlasView.jsx
    NetworkView.jsx      ← force-directed graph of events ↔ entities
    PatternsView.jsx     ← ranked signatures across the corpus
    ThreadsView.jsx      ← curated arcs
    ConstellationView.jsx
    DossierView.jsx      ← per-record with cross-links
  components/
    Header.jsx
    Primitives.jsx       ← scanlines, grain, glitch text, radar sweep, MiniChip
  App.jsx
  main.jsx
```

## Pull request flow

1. Fork the repo and create a topic branch (`feature/add-roswell`, `fix/globe-touch`, …).
2. Run `npm run build` locally — it should pass without warnings.
3. Open a PR with a clear title and a 1–3 sentence "why."
4. For data PRs, link the primary document(s) in the PR description.

Tiny PRs are great. Don't bundle a data correction with a new view.

## Anything else?

Open an issue. There's no central maintainer cabal — this is an open investigation. The point is to read the documents together.
