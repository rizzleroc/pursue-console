# Media-Library Coverage Audit

_Generated 2026-05-29 from `data-raw/uap-data.csv` (222 rows) vs
`src/data/events.js` + `src/data/events-auto.js` + `public/media.json`._

## TL;DR

| Layer                                             | Total  | Covered | Gap   |
|---------------------------------------------------|--------|---------|-------|
| CSV rows present in events catalogue (any form)   | 222    | 211     | **11** |
| Catalogued events with extracted visuals or video | 128    | 57      | **71** |
| `public/media.json` tiles                         | 288    | —       | —     |

**No videos or audio are missing.** All 78 VID rows and 8 AUD rows in the
war.gov CSV resolve to a catalogued event with a `videoId` or asset link.

## CSV → catalogue gaps (11 rows)

### 7 IMG: FBI Photo A002–A008 _(orphaned PNGs)_

The curated `fbi-photos-2025` entry in `events.js:78` summarizes "A1–A8 +
B1–B24 (32 stills)" but its `url` field only points to `fbi-photo-b1.pdf`.
A1's PNG is implicitly covered by that summary; A2–A8's PNGs have no
individual catalogue entry and no asset link anywhere.

Action: expand `fbi-photos-2025` with a `urls` array of all 32 stills.

### 2 PDF: `38_143685_box_…` URL bug

`events-auto.js` lines 26-27 catalogue these but the `url` field reads
`38_143685_box_incident_summaries_…` (without the `7`). The actual
war.gov path is `38_143685_box7_incident_summaries_…`. Trivial fix —
this is the only reason they showed up as orphans in the audit.

### 1 PDF: `59_64634_711.5612[7-2852.pdf`

A 1952 DOS State Dept memo. The curated `state-1952` entry uses a
different file (`59_214434_sp_16_7.18.1963.pdf`). Possibly the same
underlying record series but a different PDF — needs a fresh
auto-stub or a new curated entry.

### 1 PDF: `FBI September 2023 Sighting - Serial 003`

CSV title says "Serial 003" but its asset URL is `serial 5
redacted_redacted.pdf`. The events-auto entry
`fbi-september-2023-sighting-serial-5` catalogues the right URL but
under the "Serial 5" title. Looks like a CSV-side typo (Serial 3 vs
Serial 5) rather than a catalogue gap; sanity-check against war.gov.

## Catalogue → media tiles gaps (71 events)

71 catalogued events have no extracted visuals
(`data-raw/.visuals/<eid>/`) and no `videoId` linking them to DVIDS.
They live in the catalogue as text-only entries with no presence in
the MEDIA tab.

### A. Release-02 stubs (6) — PDFs in `public/release_2/`, awaiting visual extraction

```
CIA-UAP-D001    Intelligence Information Report, USSR, 1973
DOE-UAP-D001    Enhanced PANTEX Imagery
DOE-UAP-D002    James Tuck Correspondence, 1970s
DOE-UAP-D003    Pajarito Astronomers Invitation, 1986
DOW-UAP-D017    UAP Reported at Sandia Base, 1948-1950
ODNI-UAP-D001   USPER Narrative, Senior USIC Official
```

These PDFs are already in the repo (`public/release_2/*.pdf`). Run
`extract-media-from-gemini.mjs` / `classify-visuals.mjs` against them
and the tiles populate.

### B. FBI Photo B-series duplicates (23)

`events-auto.js` filed `fbi-photo-b2` through `fbi-photo-b24` as 23
separate placeholder events with single-page Gemini summaries. They
duplicate the curated `fbi-photos-2025` entry which already advertises
"A1–A8 + B1–B24" in its title. The right answer is to roll them up
into `fbi-photos-2025` (along with A2–A8) and drop the auto-stubs.

### C. Events.js entries with no extracted visuals (9 curated events)

```
georgia-2001         Russia Blames UFOs for Kodori Gorge Bombing
gulf-aden-sept-2020  Gulf of Aden — 8-Minute IR Track
indopacom-april-2025 INDOPACOM April 2025 — Email Correspondence
iraq-sept-2024       Iraq — Lens Flare Post-Missile Launch
netherlands-1948     Netherlands Air Force Intel Report
papua-1985           Papua New Guinea — High-Speed Aircraft
pursue-release-01    PURSUE Release 01 — Public Disclosure
pursue-release-02    PURSUE Release 02 — Public Disclosure
skylab               Skylab Crews — Light Flashes & Red Satellite
```

For most of these the PDF is genuinely text-only (diplomatic cable,
email correspondence) and there's nothing visually meaningful to
extract — `curate()` in `build-media-index.mjs` would reject them
anyway. Worth sanity-checking page-by-page that no maps or sketches
are buried in there.

`pursue-release-01` / `pursue-release-02` are meta-entries for the
disclosure events themselves — text-only by design.

### D. events-auto.js stubs with no extracted visuals (33)

```
38-143685-box-incident-summaries-101-172     178pp DoW
38-143685-box-incident-summaries-173-233     144pp DoW
dow-uap-d12-mission-report-iraq-may-2022     6pp
dow-uap-d35-mission-report-greece-october-2023  7pp
dow-uap-d4-mission-report-arabian-gulf-2020  5pp
dow-uap-d42-range-fouler-debrief-japan-2023  1pp
dow-uap-d44-range-fouler-reporting-form-gulf-of-aden-october-2020  1pp
dow-uap-d48-department-of-the-air-force-report-1996  181pp
dow-uap-d49-launch-summary-vandenberg-afb-2000       113pp
dow-uap-d5-mission-report-arabian-gulf-2020  6pp
dow-uap-d51-email-correspondence-pacific-time-zone-march-2023  6pp
dow-uap-d52-email-correspondance-na-august-2024   2pp
dow-uap-d54-mission-report-mediterranean-sea-na   7pp
dow-uap-d56-range-fouler-debrief-arabian-sea-august-2020  1pp
dow-uap-d58-range-fouler-debrief-na-october-2020  1pp
dow-uap-d6-mission-report-arabian-gulf-2020  7pp
dow-uap-d60-mission-report-persian-gulf-august-2020  6pp
dow-uap-d61-mission-report-persian-gulf-august-2020  7pp
dow-uap-d62-mission-report-strait-of-hormuz-september-2020  9pp
dow-uap-d63-mission-report-strait-of-hormuz-october-2020  8pp
dow-uap-d64-mission-report-iran-november-2020  7pp
dow-uap-d65-mission-report-persian-gulf-july-2020  8pp
dow-uap-d7-mission-report-arabian-gulf-2020  6pp
fbi-september-2023-sighting-serial-3
fbi-september-2023-sighting-serial-4
fbi-september-2023-sighting-serial-5
nasa-uap-d3-gemini-7-transcript-1965  3pp
nasa-uap-d5-apollo-17-crew-debriefing-for-science-1973  3pp
nasa-uap-d6-apollo-17-technical-crew-debriefing-1973  2pp
```

The longer ones — `dow-uap-d48` (181pp), `dow-uap-d49` (113pp),
`38_143685_box7_incident_summaries_101-172` (178pp),
`38_143685_box7_incident_summaries_173-233` (144pp) — likely have
embedded diagrams or annotated stills worth surfacing.

The 1-pagers are mostly range-fouler reporting forms (text-only
intake forms — `curate()` will drop them).

### Why these are missing

Each one corresponds to a PDF that was catalogued from
`DenisSergeevitch/UFO-USA`'s `pdf_manifest.tsv` via
`auto-catalogue-from-gemini.mjs` (1-line stub per file with a page
count) but the visuals classifier (`classify-visuals.mjs`,
`extract-media-from-gemini.mjs`) was never re-run against the new IDs.
That pipeline reads from `data-raw/.visuals/<eid>/` which doesn't exist
for these — and to populate it, the pipeline needs either the actual
PDF (not in the repo for Release 01) or Gemini's per-page visual
descriptions for those documents.

The session-start hook notes that `*.war.gov` is not in the egress
allowlist, so direct PDF fetches are blocked. Filling these gaps
requires either (a) adding war.gov egress, (b) sourcing the PDFs from
the upstream `DenisSergeevitch/UFO-USA` mirror, or (c) routing
extraction through the whipgen `web_eval` MCP tool which already proved
viable for the CSV pull.

## Plan to close

| # | Task                                                                                          | Risk | Status |
|---|-----------------------------------------------------------------------------------------------|------|--------|
| 1 | Fix `38_143685_box_` → `38_143685_box7_` URL typo in events-auto.js (2 rows)                  | Low  | Done in this commit |
| 2 | Roll A2–A8 + B2–B24 into `fbi-photos-2025` curated entry; drop the 23 B-series auto-stubs     | Med  | TODO |
| 3 | Run visuals pipeline against the 6 Release-02 PDFs in `public/release_2/`                     | Low  | TODO |
| 4 | Sanity-check the 9 curated events-js entries in category C for buried sketches/maps           | Low  | TODO |
| 5 | Decide war.gov egress vs. UFO-USA mirror for the 33 Release-01 events-auto stubs in category D | Med  | TODO — needs decision |
| 6 | Reconcile CSV `Serial 003` vs catalogue `serial-5` title discrepancy                          | Low  | TODO |
| 7 | Resolve `59_64634_711.5612[7-2852.pdf` (1952 DOS) — new entry or duplicate?                   | Low  | TODO |
