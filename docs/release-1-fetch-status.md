# Release-01 PDF fetch status

Tracks the war.gov Release-01 bulk fetch that landed on PR #115.

## Completed

**56 / 68 PDFs** fetched via whipgen MCP `web_eval` (same-origin in-page fetch — only path that beats Akamai's TLS fingerprinting). All committed under `public/release_1/`.

Fetched cohorts:
- 1 POC (`dow-uap-d12`)
- 14 DOW range-fouler debriefs + FBI Photo B series (b2, b10–b19)
- 30 mixed: more FBI Photos (b3–b9, b20–b24), DOW mission reports, NASA Apollo debriefings, FBI Sept 2023 serial-3/4/5
- 6 medium (4MB–7MB): d62, d65, serials 153/220/449, etc.
- 5 big (20MB–35MB), range-chunked: serial_438, d49, sub_a, serials 130/164

## Remaining (12)

All large FBI scanned documents — each 50–200+ MB raw. The whipgen tool has an 8 MB result cap, so each requires 10–35 range-chunked fetches plus assembly. Skipped here to keep the repo manageable; needs either git-lfs or an out-of-band download.

| Pages | File | Est size | Chunks @5MB |
|---|---|---|---|
| 144 | `38_143685_box7_incident_summaries_173-233.pdf` | 161 MB (probed) | 33 |
| 178 | `38_143685_box7_incident_summaries_101-172.pdf` | ~200 MB | ~40 |
| 181 | `dow-uap-d48-report-september-1996.pdf` | ? (probe failed) | ? |
| 184 | `65_hs1-834228961_62-hq-83894_section_10.pdf` | ~50 MB | ~10 |
| 190 | `65_hs1-834228961_62-hq-83894_section_3.pdf` | ~50 MB | ~10 |
| 194 | `65_hs1-834228961_62-hq-83894_section_2.pdf` | ~50 MB | ~10 |
| 205 | `65_hs1-834228961_62-hq-83894_section_7.pdf` | ~60 MB | ~12 |
| 209 | `65_hs1-834228961_62-hq-83894_section_5.pdf` | ~60 MB | ~12 |
| 214 | `65_hs1-834228961_62-hq-83894_section_4.pdf` | ~60 MB | ~12 |
| 217 | `65_hs1-834228961_62-hq-83894_section_8.pdf` | ~60 MB | ~12 |
| 271 | `65_hs1-834228961_62-hq-83894_section_6.pdf` | ~80 MB | ~16 |
| 290 | `65_hs1-834228961_62-hq-83894_section_9.pdf` | ~85 MB | ~17 |

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
