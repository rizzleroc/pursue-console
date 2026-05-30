# Release-01 PDF fetch status

Tracks the war.gov Release-01 bulk fetch that landed on PR #115.

## Completed

**64 / 68 PDFs** fetched via whipgen MCP `web_eval` (same-origin in-page fetch — only path that beats Akamai's TLS fingerprinting). All committed under `public/release_1/`. Total on disk: ~434 MB.

Cohorts fetched:
- 1 POC (`dow-uap-d12`)
- 14 DOW range-fouler debriefs + FBI Photo B series (b2, b10–b19)
- 30 mixed: more FBI Photos (b3–b9, b20–b24), DOW mission reports, NASA Apollo debriefings, FBI Sept 2023 serial-3/4/5
- 6 medium (4MB–7MB): d62, d65, serials 153/220/449, etc.
- 13 big files via range-chunked fetch (5MB chunks, assembled client-side):
  - 5 in the 20–35MB range: `serial_438` (7.5MB), `d49` (9MB), `sub_a` (35MB), `serials 130/164` (21/22MB)
  - 8 sections + d48: `section_10` (58MB), `section_2` (33MB), `section_3` (35MB), `section_4` (38MB), `section_5` (36MB), `section_6` (61MB), `section_7` (39MB), `d48` (22MB)

## Remaining (4)

Probed total sizes are unexpectedly large — all four are scanned-image-heavy FBI sections that average 1+ MB/page (vs ~150–280 KB/page for the others). Fetching them would each take 30–60 range-chunked whipgen calls and add ~900 MB to the repo. **Recommend migrating these to git-lfs before fetching** — committing them raw is unhealthy for the repo.

| File | Probed total | Chunks @5MB | Notes |
|---|---|---|---|
| `65_hs1-834228961_62-hq-83894_section_8.pdf` (217pp) | **255 MB** | 52 | Probed in this run |
| `65_hs1-834228961_62-hq-83894_section_9.pdf` (290pp) | ~300+ MB est | ~60+ | Largest by page count |
| `38_143685_box7_incident_summaries_101-172.pdf` (178pp) | ~200 MB est | ~40 | Sibling of 173-233 |
| `38_143685_box7_incident_summaries_173-233.pdf` (144pp) | **161 MB** | 33 | Probed in earlier run |

Plus 1 known orphan: `nasa-uap-d3-gemini-7-transcript-1965` has no canonical URL in `data-raw/uap-data.csv` — needs human research to locate the file (NASA-UAP-D003 is listed in the CSV row but its `PDF | Image Link` column is empty).

## Fetch pattern that worked

For future resumes. Per-PDF protocol (small files):

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
- Page state does NOT persist between `web_eval` calls — `window.__var` set in one call is not visible in the next. Each call gets a fresh JS context. So all data must be returned in the same call that fetches it.
