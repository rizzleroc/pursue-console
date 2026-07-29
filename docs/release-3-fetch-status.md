# Release-03 staging status

Tracks war.gov Release-03 ingestion. Like Release-01, **PDFs are NOT committed to the repo** — the deployed site serves them directly from `https://www.war.gov/medialink/ufo/061226/release_03/documents/` (see `src/data/events.js` `URL_BASE`). Local copies under `public/release_3/` are for offline processing only and are gitignored.

## What's staged in this PR

- `data-raw/uap-data.csv` — refreshed canonical master CSV (294 rows, sha256 `71d53f68c859850d6721f3bc84a7415d21de91c68d331e4ab4625112ece43515`, 366,386 bytes). Replaces the May 27 snapshot (222 rows).
- `data-raw/war-gov/release-03-manifest.json` — the 72 Release-03 rows pre-filtered into a release-bounded JSON manifest. Downstream pipelines (events.js stub generation, FAISS, dossier extraction) can iterate this without re-parsing the master CSV.
- `docs/war-gov-scrape-state.json` — rolled forward to reflect the new totals and a new `release03` block.

## Release 03 summary (2026-06-12)

72 new records:

| Type | Count | Notes |
| --- | --- | --- |
| PDF  | 53    | CIA Cold War archive (CIA-UAP-002 through 019), DOW/Army narrative statements for the Western US Event, FBI Colorado Springs + Northeastern Orb dossiers, NASA Gemini debriefings, USG congressional correspondence |
| IMG  | 10    | Digital renderings of the Western US Event (FBI-UAP-D014..D023) |
| VID  |  6    | FBI orb videos (PR001–PR006, DVIDS-hosted) |
| AUD  |  3    | NASA astronaut interviews (D023–D025, DVIDS-hosted) |

Agencies:

| Agency | Count |
| --- | --- |
| FBI                              | 29 |
| CIA                              | 18 |
| Department of War                | 12 |
| NASA                             | 11 |
| Intelligence Community Agency    |  1 |
| U.S. Government                  |  1 |

**Two new agency codes** that don't appear in the Release-01/02 ingestion scripts: `ICA` (Intelligence Community Agency, single record `ICA-UAP-D001`) and `USG` (U.S. Government, single record `USG-UAP-D001`). `scripts/scrape-release-02-via-whipgen.mjs` `AGENCY_FROM_PREFIX` + the ID regex need updating before that script can be re-pointed at Release 03.

## URL pattern (changed in Release 03)

Release 01 lived under `/medialink/ufo/release_1/<basename>.pdf`. Release 03 introduced a new path:

```
https://www.war.gov/medialink/ufo/061226/release_03/documents/<basename>.{pdf,jpg}
```

The dated segment (`061226`) matches the press-release date and also shows up in the homepage rotator (`/portals/1/Interactive/2026/UFO/061226/Rotator/`). Treat the dated segment as part of the canonical URL — these aren't redirects from a flat `/release_3/` path.

Videos and audio are DVIDS-hosted (column `DVIDS Video ID`) rather than war.gov-hosted; the canonical embed lives at `https://www.dvidshub.net/video/<id>` and ingestion goes through `scripts/lib/dvids-driver.mjs` the same way Release 01/02 video paths did.

## Source-of-truth CSV — case sensitivity gotcha

The previous scrape probed `/Portals/1/Interactive/2026/UFO/uap-data.csv` (capital P). That path still returns a stale 297,953-byte file pinned to Release 02. The live, current CSV is at the **lowercase** path:

```
https://www.war.gov/portals/1/Interactive/2026/UFO/uap-data.csv   # 364,375 bytes, Release 03 included
```

Both paths return HTTP 200 with different file lengths — the two are distinct files, not case-insensitive aliases. `scripts/sync-war-gov.mjs` and any downstream tooling should pin to the lowercase URL going forward.

A schema change came with this release: the master CSV now starts with a `Featured` column ahead of `Redaction`. The 17 named columns are otherwise unchanged.

## How this was pulled (no Claude credits)

Same protocol as Release 01:

1. `whipgen_web_open` → navigate the daemon's logged-in Chrome to `https://www.war.gov/UFO/` (sets same-origin context, clears the Akamai challenge).
2. `whipgen_web_eval` → in-page `fetch("/portals/1/Interactive/2026/UFO/uap-data.csv", { credentials: "include" })` → returns the CSV text. Total wall-clock: ~6.3 s (3.9 s navigation + 1.9 s eval + 0.5 s daemon overhead).
3. Parse + filter for `Release Date == "6/12/26"` to extract the 72 R3 rows.
4. Write the master CSV, the R3 manifest, and the scrape state doc.

No LLM tokens were spent — the heavy lifting is browser-driven on the whipgen daemon.

## Not done in this PR (follow-up work)

- **Stub records in `src/data/events.js`** — the 72 new IDs are not yet in the events catalogue. They can be machine-generated from the manifest by an updated version of `scripts/scrape-release-02-via-whipgen.mjs` (after adding the `ICA` / `USG` agency codes and bumping `release` to "Release 03"); each stub still needs a human pass to fill the `summary` / `coords` / `flag` fields.
- **PDF prefetch** — none of the 53 R3 PDFs are mirrored locally yet. The `public/release_3/` directory and fetch protocol mirror Release 01; large files (50MB+) will need the same range-chunked path that `docs/release-1-fetch-status.md` describes.
- **DVIDS video metadata** — the 6 VID + 3 AUD rows carry DVIDS IDs only. Title / DVIDS publication dates need a follow-up `whipgen_web_open` pass through each DVIDS asset page (or the existing `pursue-vision-mcp` DVIDS driver).
- **GitHub `label:cataloguing` issues** — the 72 new IDs aren't tracked yet. The existing pattern is one issue per missing record; ~72 issues need filing.
