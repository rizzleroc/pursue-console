# Feature request — `whipgen_web_eval`

> **STATUS: SHIPPED 2026-05-26** — whipgen-mcp commit `622b751`+ exposes `whipgen_web_eval` (Playwright `page.evaluate` wrapper) almost exactly as proposed below. The war.gov CSV was pulled end-to-end in 1.8 s on first attempt — see `data-raw/uap-data.csv` (222 records) and `docs/war-gov-scrape-state.json`. This document is preserved as the audit trail of how the requirement was scoped, why the workarounds failed, and what the API contract looks like. The "Workaround until this lands" section at the bottom is now obsolete.

**Target:** [whipgen-mcp](https://github.com/your-org/whipgen-mcp) (paste this into a new issue there)

**Filed by:** pursue-console / war.gov UFO ingest pipeline · 2026-05-25
**Shipped:** 2026-05-26 (whipgen-mcp commit `622b751`)

---

## Summary

Add a `whipgen_web_eval` tool that runs an arbitrary JavaScript expression inside the currently loaded page's context (Playwright `page.evaluate`) and returns the serialised result. This unlocks scraping for any site that hides its real data behind in-page XHRs or JS-state pagination — which is most modern .gov / SPA sites.

## Concrete blocker that prompted this

`pursue-console`'s media-library ingest needs the file index from `https://www.war.gov/UFO/` (the Presidential Unsealing and Reporting System / PURSUE archive). The page renders **222 records** across two releases, but:

| Approach | Result |
| --- | --- |
| `whipgen_web_open(https://www.war.gov/UFO/)` | Renders the page; only the first **10** records land in the DOM (`<button class="record-row">`). Pagination is pure JS state (Vue) — clicking "next" mutates an in-memory array, never the URL. |
| `whipgen_web_open(.../UFO/?page=2)` | Ignored — site has no URL-based paging. |
| `whipgen_web_open(.../UFO/uap-data.csv)` (the data source the page itself reads) | `net::ERR_ABORTED` — Akamai rejects direct navigation; the CSV only responds to same-origin in-page `fetch()`. |
| Search-engine scrape (Google, DuckDuckGo) for the record IDs | Zero hits — page is new (May 22, 2026) and crawlers haven't indexed individual records. |
| `whipgen_web_extract` with every plausible selector | Caps at 10 visible rows. No `[v-for]`, no `data-*` attribute, no inline JSON contains the full list. |

There is no path from the existing toolset to the other 212 records without page-context JS execution.

## Proposed API

```jsonc
// whipgen_web_eval
{
  "expression": "await fetch('/Portals/1/Interactive/2026/UFO/uap-data.csv').then(r => r.text())",
  "url": "https://www.war.gov/UFO/",      // optional — like web_extract, navigates first if set
  "returnType": "text",                    // 'text' | 'json' | 'base64'  (default: auto)
  "awaitPromise": true,                    // default true — `expression` may be async
  "timeoutMs": 30000,                      // default 30000
  "saveTo": "/abs/path/inside/allowed"     // optional — write result to disk instead of returning inline
}
```

**Returns:**
```jsonc
{
  "value": "Agency,Title,Release,...\nDOW-UAP-PR050,...,\n...",   // present unless saveTo set
  "valueSize": 87642,
  "savedTo": "/abs/path/...",                                      // present if saveTo set
  "durationMs": 1430,
  "jobId": "..."
}
```

## Reference implementation sketch

Roughly 30 lines on the daemon side; reuses the existing browser pool:

```ts
// pseudocode — slot into the same router as web_open / web_extract
async function webEval({ expression, url, returnType, awaitPromise, timeoutMs, saveTo, sessionId }) {
  const page = await pool.checkout(sessionId);
  try {
    if (url) await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    const wrapped = awaitPromise
      ? `(async () => { return (${expression}); })()`
      : `(() => { return (${expression}); })()`;
    const value = await page.evaluate(`(${timeoutMs} && Promise.race([${wrapped}, new Promise((_,r) => setTimeout(() => r(new Error('eval-timeout')), ${timeoutMs}))]))`);
    const serialized = serialize(value, returnType);  // string|JSON|base64
    if (saveTo) {
      assertWriteRootOk(saveTo);                       // existing helper
      await fs.writeFile(saveTo, serialized);
      return { savedTo: saveTo, valueSize: serialized.length };
    }
    return { value: serialized, valueSize: serialized.length };
  } finally {
    pool.checkin(sessionId, page);
  }
}
```

## Security / abuse considerations

- The expression runs **inside the loaded site's origin**, so anything it can read is already accessible to the operator with devtools open. No new auth boundary is crossed.
- Same `mutates-session` side-effect class as `web_open` — opt-in by callers.
- Log every invocation to the existing `~/.whipgen-history.ndjson` (the operator can audit retroactively).
- Cap `expression` length (e.g. 64 KB) and result size (e.g. 8 MB) to prevent runaway returns.
- Capture page errors via `page.on('pageerror')` during the eval window and bubble them up so the caller can distinguish "syntax error in expression" from "expression triggered a site-side failure".

## Alternatives considered

| Alternative | Why it's strictly weaker |
| --- | --- |
| `whipgen_web_click({selector})` + `whipgen_web_fill({selector, value})` | Solves pagination, but not the same-origin-fetch case (`uap-data.csv` and similar Akamai-gated endpoints). |
| Headless `curl` via daemon | Loses the WAF-bypass that the logged-in Chrome provides — Akamai is the whole reason to use the browser. |
| Make the caller poll `__doPostBack` form posts | Requires reconstructing ASP.NET viewstate each request — fragile and site-specific. |

`web_eval` subsumes both `web_click` and `web_fill` (they're 2-line eval expressions) and handles the Akamai-protected XHR case for free.

## Use cases this unblocks (beyond war.gov)

- Any DataTables / DataTable-AJAX site (most US gov agency directories).
- Vue / React / Angular SPAs whose data is in component state.
- Sites whose `/api/...` endpoints require same-origin fetches due to WAF / CSP / SameSite cookies.
- Programmatic search/filter against any UI-only search box.

---

## Workaround until this lands

~~For the war.gov ingest specifically, the operator can do this in their existing logged-in browser:~~

~~1. Open `https://www.war.gov/UFO/` in Chrome.~~
~~2. DevTools → Network tab → filter `uap-data.csv` → right-click → Save as → `data-raw/war-gov-uap-data.csv`.~~
~~3. Commit the CSV; the repo's parser can ingest it directly into `events.js` entries.~~

~~This is a one-time manual step per release, but it's the only path that works today.~~

**Obsolete.** The actual flow now is one tool call:

```js
whipgen_web_eval({
  url: "https://www.war.gov/UFO/",
  expression: "await fetch('/Portals/1/Interactive/2026/UFO/uap-data.csv').then(r => r.text())",
  returnType: "text",
  timeoutMs: 60000,
})
// → { value: "<full CSV>", valueSize: 296630, durationMs: 1833 }
```
