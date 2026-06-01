# Coverage Wall — Implementation Plan

The Coverage Wall direction won a fanout+judge concept evaluation (see
PR #264 audit + concept thread). This document is its implementation
plan against the **existing** codebase. Nothing in here is greenfield —
every change is a small, additive patch on the current React + Vite +
Tailwind app.

Produced by 16 parallel subagent investigations covering:
LiveFeedView mapping · Header nav merge · coverage.json schema ·
corpus-stats reconciliation · next-missing computation · i18n keys ·
DossierView entity wiring · Tailwind theme tokens · mobile nav fix ·
SearchView merge · CoverageGrid component draft · Header patch draft ·
build-next-missing.mjs draft · PR ordering · perf budget · design lab.

## TL;DR

12 ordered PRs over a week. Each PR <500 LOC. Critical path to ship
Coverage Wall on the LIVE view is **6 PRs**. The other 6 are
polish/safety nets.

| Critical | Title | Type | Files | LOC |
|:-:|---|---|---|---:|
| ✓ | 1. Wire `diagnose-coverage` into `npm run build` | pure-add | `package.json` | ~5 |
| ✓ | 2. Add `useCoverage()` hook | pure-add | `src/hooks/useCoverage.js` (new) | ~60 |
| ✓ | 3. i18n keys: `coverage.*` namespace | pure-add | `src/i18n/locales/*.js` (18 files) | ~120 |
|   | 4. `CoverageGrid` + `CoverageLegend` + tooltip | pure-add | `src/components/CoverageGrid.jsx` (new — drafted in this branch) | ~250 |
|   | 5. Empty-state and a11y for the grid | pure-add | same | ~80 |
| ✓ | 6. Standalone `CoverageView` behind `?cw=1` URL flag | pure-add | `src/views/CoverageView.jsx` (new), `App.jsx` | ~120 |
|   | 7. Cell-click → DossierView deep-link | pure-add | `src/components/CoverageGrid.jsx` | ~30 |
|   | 8. Keyboard + ARIA grid roles | pure-add | same | ~80 |
|   | 9. Snapshot + interaction tests | pure-add | new test file | ~120 |
|   | 10. Add COVERAGE tab to PRIMARY nav (gated) | destructive-soft | `Header.jsx` + locales | ~40 |
| ✓ | 11. Replace `LiveFeedView` hero with Coverage Wall mini-strip | destructive | `LiveFeedView.jsx` (hero block) | ~200 |
|   | 12. Drop the `?cw=1` gate after 48h soak | destructive | `App.jsx`, `Header.jsx` | ~20 |

Critical path ⇒ 1 · 2 · 3(en-only) · 4 · 6 · 11 — six PRs, ~755 LOC.

## What lands in this PR (the plan PR)

Pure additions. No changes to live code. Safe to merge anytime.

- `docs/coverage-wall-plan.md` — this document.
- `docs/coverage-wall-design-lab.html` — self-contained visual demo
  (Tailwind via CDN, Google Fonts, no build step). Open in browser.
- `src/components/CoverageGrid.jsx` — drafted component, exported but
  **not yet imported anywhere**. Ready for PR 4 to wire in.
- `scripts/build-next-missing.mjs` — drafted build script, **not yet
  invoked** by `npm run build`. Ready for PR 6 to wire in via the
  CoverageView CTA.

## Key findings from the agent sweep

### LiveFeedView (885 LOC) — hero swap surface

- Hero is at `LiveFeedView.jsx:431-462` (UtcClock + LivePulse + title +
  lead + stale-feed banner). Coverage Wall replaces lines 431-447.
  Lines 452-462 (stale-feed banner) stay.
- Sub-components in scope: `UtcClock` (55-70), `LivePulse` (72-79),
  `IngestHistogram` (82-109), `Oscilloscope` (112-144), `BearingDial`
  (147-202). All stay; only the hero band changes.
- Existing state: `[feed, error, filter, reloadAt, now]`. Need to add
  `[coverage, setCoverage]` and a parallel useEffect (mirror the
  live-feed fetch at line 272).
- i18n: existing keys under `live.*` namespace. New keys live under
  `coverage.*`.

### Header (Nav merge)

- PRIMARY tabs array at `Header.jsx:16-24`.
- Two surgical patches (full diffs in agent transcripts):
  1. Remove `semantic` and `dossier` lines from `PRIMARY` — SEARCH
     absorbs the mode toggle (PR 4 wires the EXACT/MEANING toggle
     inside SearchView), DOSSIER stays reachable via cell-clicks but
     drops from the tab row.
  2. Add `relative` to the `<nav>` element and a `before:...gradient`
     pseudo-element fading to black on the right at the `<sm`
     breakpoint, so mobile users see content is scrollable.
- App.jsx routing keeps `view === "semantic"` (line 186) and
  `view === "dossier"` (line 204) — both still rendered, just no
  longer surfaced as top-level tabs.

### Data plumbing

- `public/coverage.json` (50 KB, already shipping) has `byEvent[]`
  with `{eventId, status: complete|gap|no-data|mismatch, gapPages,
  chars, pagesTouched, ...}`. Total `events: 121`.
- `public/corpus-stats.json` shows `byRelease.Release 01.inventoryTotal
  = 162` and `Release 02.inventoryTotal = 64` with R1 catalogued = 121,
  R2 catalogued = 7. The header band today reads "R1 121/162 · R2 7/64
  · 3,530 pages" — accurate but ambiguous (looks like R2 is at 144%
  because the 92 is pages, the 64 is inventory).
- `scripts/diagnose-coverage.mjs` produces `coverage.json` but **isn't
  invoked by `npm run build`** today. PR 1 just adds it to the chain.
- `scripts/build-next-missing.mjs` (drafted in this branch) reads
  `coverage.json` + `dossier-extracts.json` + `review-queue.json`,
  scores `flag_weight × (1 + gapPages/10) × (1 + chars/10000)`, emits
  `public/next-missing.json` for the CTA target.

### i18n

- Canonical: `src/i18n/locales/en.js` (`.js`, not `.json`).
- Convention: dot-pathed lowercase keys with ALL-CAPS English values
  for HUD strings; `{name}` single-brace placeholders.
- 18 locales total (16 LTR + 2 RTL: ar, he). RTL handled at the
  document root via `setAttribute("dir", lang.dir)` in
  `src/i18n/index.jsx:84` — no per-component changes needed.
- New namespace `coverage.*` with 10 keys (see PR 3 details below).

### Theme tokens

- `tailwind.config.js` currently has empty `theme.extend`. All Coverage
  Wall hex values map to or extend Tailwind's defaults:
  - `complete #34D399` → `bg-emerald-400` (exact match).
  - `partial #C99A2E` → close to `amber-700`, slightly muted.
  - `no-data bg #16241E` → no exact Tailwind equivalent (custom).
  - Recommend: add `theme.extend.colors.coverage = { complete,
    partial, empty }` in PR 4 alongside the component, plus
    `theme.extend.fontFamily.sans = ['Space Grotesk', 'Inter', ...]`
    and `fontFamily.mono = ['JetBrains Mono', 'IBM Plex Mono', ...]`.
- Font load: extend the existing `@import` in `App.jsx:128` to add
  Space Grotesk + JetBrains Mono. Subset `&subset=latin` to keep
  payload to ~25 KB.

### Mobile nav fix

- `Header.jsx:92` uses `overflow-x-auto no-scrollbar` (defined at
  `App.jsx:132-133`). 11 tabs scroll right with **zero affordance** on
  mobile.
- Fix: add `relative` to `<nav>` + a `before:` gradient overlay
  fading right-edge to black on `<sm` only. ~10 LOC patch.

### SearchView merge

- `SearchView.jsx:85-96` returns `null` for empty query AND for empty
  results, suppressing even the empty-state UI — that's the blank-page
  bug.
- `SemanticSearchView` already lazy-loads the 25 MB model on first
  interaction, not on mount (`SemanticSearchView.jsx:69-88`). Module-
  level promise caches (`_modelP`, `_vectorsP`) are session-singletons
  and survive mode toggling — safe to flip back and forth.
- PR 4 unifies state shape:
  ```
  { mode: 'exact'|'meaning', query, results, semanticLoaded }
  ```
  EXACT mode default. Toggle to MEANING triggers `ensureModel()`.

### DossierView entity wiring

- Existing signatures section: `DossierView.jsx:168-187`.
- Insertion point: line 289 (between visuals 238-288 and excerpts
  290-388). Adds a "ENTITIES & DATES MENTIONED" panel.
- Filter: `patterns.byKind.entity[].docs` (or `events[].eid` depending
  on shape) contains the eid list per entity — filter to the current
  event's entities only.
- Semantic neighbors at `DossierView.jsx:447-448` is hardcoded
  `slice(0, 6)`. Bump to `slice(0, 10)` — single-character change.
- Reuse existing color schemes (`FLAG_COLOR`, `SOURCE_COLOR` at
  `DossierView.jsx:47-51`). One new i18n key `dossier.mined_patterns`.

## i18n keys to add (PR 3)

```js
// src/i18n/locales/en.js
coverage: {
  eyebrow: "DEPT. OF WAR · DECLASSIFIED UAP · RELEASE 01–02",
  headline: "The archive of what the Department of War released — and what's still dark.",
  subhead: "Community-run. Every page transcribed in the open, catalogued event by event.",
  status: "{catalogued}/{inventory} CATALOGUED · {complete} COMPLETE · {pct}% AWAITING TRANSCRIPTION",
  cta: "Open the next missing page →",
  microcopy: "No account needed · {n} transcribers online",
  grid: {
    title: "RELEASE 01 · COVERAGE MAP",
    legend_complete: "COMPLETE",
    legend_partial: "PARTIAL",
    legend_empty: "EMPTY",
  },
  footer: {
    index: "INDEX · {entities} ENTITIES · {dates} DATES · CROSS-LINKED",
    r2: "RELEASE 02 · {catalogued}/{inventory}",
  },
}
```

17 non-en locales get the same shape with values left empty or
machine-translated as a starting point; fallback to en is automatic.

## Performance budget

- New JSON: `next-missing.json` ~10 KB, `coverage.json` 50 KB (already
  shipping). Total added payload **<25 KB** if fonts subsetted.
- Fonts: +25 KB Latin subset (Space Grotesk + JetBrains Mono), or +70
  KB unsubset. **Subset.**
- 121-cell grid: 121 DOM nodes, no canvas, no SVG-per-cell. <5 ms
  render on modern hardware.
- Targets: hero LCP <85 ms, CoverageGrid mount-to-paint <150 ms.
- Existing 25 MB semantic model stays lazy (no change).

## Rollback ladder

Three layers, cheapest first:

1. **URL flag** — PRs 6–11 are gated by `?cw=1` or
   `localStorage["pursue:coverage"]`. To kill instantly: don't pass
   the flag. The new feature is at `/?cw=1` for engineers to keep
   iterating; the live LIVE view is untouched.
2. **Single-line constant flip** in `App.jsx` next to the
   launch-overlay gate (`App.jsx:69-72`):
   `const COVERAGE_ENABLED = ...`. Flip to `false` in a 1-line revert
   PR to disable the whole feature.
3. **Hard revert** — PR 11 is the only truly destructive commit (it
   replaces `LiveFeedView` hero). Keep it small, self-contained,
   unsquashed so `git revert <sha>` works cleanly.

## Sequencing rules

- Days 1–4: land PRs 1–9. None changes user-visible UI.
- Day 5 morning: PR 10 (nav adds COVERAGE tab; still flag-gated). Soak
  half a day.
- Day 5 afternoon: PR 11. **Only commit that mutates LIVE.** Watch
  deploy.
- Day 7: PR 12 lands only after 48 h soak with no rollback signal.

## Drafted files in this branch

- `src/components/CoverageGrid.jsx` — the component PR 4 will wire in.
  Default export. Props: `events` (array), `onSelect` (callback),
  `className`. Pads to 121 cells, 4 status colors, tooltip on hover,
  legend below. ARIA grid role + tabIndex hooks ready for PR 8.
- `scripts/build-next-missing.mjs` — the build script PR 6 will hook
  into `package.json`'s `"build"` chain. Writes `public/next-missing.json`
  sorted by `flag_weight × (1 + gapPages/10) × (1 + chars/10000)`. Bails
  silently if `coverage.json` doesn't exist yet (safe to land before
  PR 1).
- `docs/coverage-wall-design-lab.html` — self-contained visual demo of
  the hero + CoverageGrid + status line. Open in any browser, no build
  step.

## Files NOT touched in this PR

- `src/views/LiveFeedView.jsx` (hero swap is PR 11)
- `src/components/Header.jsx` (nav merge is PR 4/10)
- `src/views/SearchView.jsx` and `SemanticSearchView.jsx`
  (merge is PR 4)
- `src/views/DossierView.jsx` (entity strip + neighbor 6→10 are
  separate audit PR not in this critical path)
- `src/i18n/locales/*.js` (PR 3)
- `tailwind.config.js` (PR 4 adds tokens alongside the component)
- `package.json` (PR 1)

This PR is **plan + drafts only.** Merging it does not change the
live site.
