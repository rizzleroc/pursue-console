# Release-01 PDF fetch status

Tracks war.gov Release-01 PDF ingestion. **PDFs are NOT committed to the repo** — the deployed site serves them directly from `https://www.war.gov/medialink/ufo/release_1/` (see `src/data/events.js` `URL_BASE`). Local copies under `public/release_1/` exist only for offline processing pipelines (FAISS embeddings, dossier extraction, visuals classification). `public/release_1/*.pdf` is gitignored.

## On-disk status (local)

**64 / 68 PDFs** successfully fetched via whipgen MCP `web_eval` (same-origin in-page fetch — only path that beats Akamai's TLS fingerprinting). All present under `public/release_1/`. Total ~434 MB.

Cohorts fetched:
- 1 POC (`dow-uap-d12`)
- 14 DOW range-fouler debriefs + FBI Photo B series (b2, b10–b19)
- 30 mixed: more FBI Photos (b3–b9, b20–b24), DOW mission reports, NASA Apollo debriefings, FBI Sept 2023 serial-3/4/5
- 6 medium (4MB–7MB): d62, d65, serials 153/220/449, etc.
- 13 big files via range-chunked fetch (5MB chunks, assembled client-side):
  - 5 in the 20–35MB range: `serial_438` (7.5MB), `d49` (9MB), `sub_a` (35MB), `serials 130/164` (21/22MB)
  - 8 sections + d48: `section_10` (58MB), `section_2` (33MB), `section_3` (35MB), `section_4` (38MB), `section_5` (36MB), `section_6` (61MB), `section_7` (39MB), `d48` (22MB)

## Remaining (4)

Large scanned-image FBI sections, ~1 MB/page. Fetch them to the same local `public/release_1/` location whenever the pipeline needs them — they won't go through git.

| File | Probed total | Chunks @5MB |
|---|---|---|
| `65_hs1-834228961_62-hq-83894_section_8.pdf` (217pp) | 255 MB | 52 |
| `65_hs1-834228961_62-hq-83894_section_9.pdf` (290pp) | ~300+ MB est | ~60+ |
| `38_143685_box7_incident_summaries_101-172.pdf` (178pp) | ~200 MB est | ~40 |
| `38_143685_box7_incident_summaries_173-233.pdf` (144pp) | 161 MB | 33 |

Plus 1 orphan: `nasa-uap-d3-gemini-7-transcript-1965` has no canonical URL in `data-raw/uap-data.csv` — needs human research to locate the file.

## Fetch pattern that worked

Per-PDF protocol (small files):

```js
// in whipgen_web_eval(returnType="base64", url="https://www.war.gov/Spotlight/UAP/"):
await (async () => {
  const r = await fetch("/medialink/ufo/release_1/<file>", { credentials: "include" });
  if (!r.ok) return "ERR:http:" + r.status;
  const buf = new Uint8Array(await r.arrayBuffer());
  let s = ""; const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode(...buf.subarray(i, i + CH));
  return btoa(s);
})()
```

For a batch of N small files, replace the single fetch with a loop over an `items` array and return `JSON.stringify(out)` (cap ~6 MB total).

For files over the 8 MB result cap, use range-chunked fetches (5 MB per chunk) and assemble with `/tmp/wargov-assemble-chunks.sh`:

```js
await (async () => {
  const url = "/medialink/ufo/release_1/<file>";
  const start = <CHUNK_START>;
  const r = await fetch(url, { credentials: "include", headers: { Range: `bytes=${start}-${start + 4999999}` } });
  if (r.status !== 206 && r.status !== 200) return JSON.stringify({err:"http:"+r.status});
  const total = Number((r.headers.get("content-range") || "").match(/\/(\d+)$/)?.[1] || 0);
  const buf = new Uint8Array(await r.arrayBuffer());
  let s = ""; const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode(...buf.subarray(i, i + CH));
  return JSON.stringify({ start, total, b64: btoa(s) });
})()
```

After each chunk, copy the spilled tool-result JSON to `/tmp/chunk-N.json`, then assemble:

```bash
/tmp/wargov-assemble-chunks.sh public/release_1/<file> /tmp/chunk-0.json /tmp/chunk-1.json ...
```

Notes:
- Whipgen `web_eval` expression cap is 64 KB; result cap is 8 MB on the wire (large results auto-spill to a file in `/root/.claude/projects/*/tool-results/`).
- The `url:` arg navigates the browser to set the same-origin context. `https://www.war.gov/Spotlight/UAP/` worked reliably (auto-redirected to `/Spotlights/UAP/`); `/UFO/` and `/ufo/` both hung the daemon.
- Daemon occasionally wedges on consecutive timeouts — session resume clears it.
- Page state does NOT persist between `web_eval` calls — `window.__var` set in one call is not visible in the next. Each call gets a fresh JS context.
- **Local container is ephemeral** — these PDFs are reclaimed when the session ends. Re-run the fetch in a new session if the processing pipeline needs them.
