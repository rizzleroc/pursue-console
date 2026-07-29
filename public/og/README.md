# OpenGraph card assets

Static card images referenced by the OpenGraph + Twitter Card meta tags
embedded in every /mc/*.html page (and runtime-overridden per event via
share.js). These are crawled by X/Slack/iMessage/Discord/Facebook to
generate link previews when a PURSUE Console URL is pasted.

## Current

- `default.png` — the site-wide default card. 1200×630. Used when a
  page-specific card isn't generated yet.
- _(TODO)_ `event-<eid>.png` — per-event cards rendered at build time so
  Twitter/X (which doesn't execute JS for Twitter Cards) shows a
  case-specific preview for every dossier/share/evidence URL.

## How to regenerate

The build pipeline can render these via a headless Chromium pass against
`/mc/share.html?eid=<EID>&render=card` — that page is laid out to fit a
1200×630 viewport exactly. See `scripts/build-og-cards.mjs` (TODO).

Until that ships, every page falls back to `default.png`.
