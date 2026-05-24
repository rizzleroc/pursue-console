# pursue-vision-mcp

**Minimal open-source daemon that drives your already-logged-in ChatGPT and Gemini browser tabs to OCR pages of documents** — plus a `@unverified` war.gov collector that uses the same logged-in Chrome to bypass Akamai TLS blocking. Drop-in compatible with the [pursue-console](../README.md) vision-OCR pipeline.

Routes:

- **`POST /chat-with-files`** — send N image paths + a prompt to one provider (`chatgpt` or `gemini`), get the model's reply back as text.
- **`POST /fanout`** — send the SAME prompt + files to BOTH providers in parallel; returns both responses. Used by the corpus's cross-source re-evaluation pipeline (`scripts/reevaluate-disputed.mjs`).
- **`POST /ask`** — RAG endpoint for the browser ASK view. Body: `{ question, contexts: [{eid, page, text}], provider }`. Daemon writes the contexts to a tmp .txt, hands it to the chosen logged-in tab via the same upload flow as `/chat-with-files`, and returns the model's reply. CORS-allowlisted for `https://rizzleroc.github.io` + `localhost:*` so the deployed pursue-console can call straight in.
- **`GET /war-gov/index?release=<n>`** — fetch the war.gov/UFO release-files index for release `<n>` via in-page `fetch()` on a logged-in `www.war.gov/UFO/` tab. ***`@unverified`** — never run end-to-end against live war.gov; first live test is the maintainer's Chrome.*
- **`POST /war-gov/download`** — `{ urls: string[], destDir: string }`. Downloads each URL via Chrome (8 MB HTTP Range chunks for files >50 MB) into a path-jailed `destDir`. Returns per-file `{ ok, bytes, error? }`. **`@unverified`**.

No image generation, no API keys, no chat memory, no fancy queue, no telemetry. If you have ChatGPT Plus and/or a Gemini account, this is enough to contribute transcriptions to the corpus (see [HOW-CAN-I-HELP.md](../HOW-CAN-I-HELP.md) in the parent project).

## What it does

```
┌──────────────────────────┐
│  pursue-console pipeline │
│  scripts/vision-ocr.mjs  │
└────────────┬─────────────┘
             │ POST /chat-with-files
             ▼
┌──────────────────────────┐         ┌──────────────────┐
│  daemon.mjs              │  CDP    │  Chrome          │
│  • single-slot queue     │ ──────▶ │  • ChatGPT tab   │
│  • bearer token auth     │         │  • your login    │
│  • 127.0.0.1 only        │         │                  │
└────────────┬─────────────┘         └──────────────────┘
             │
             ▼
       chatgpt-driver.mjs
       (playwright over CDP — upload files, type prompt, wait for reply)
```

## Setup

```bash
git clone https://github.com/rizzleroc/pursue-console
cd pursue-console/pursue-vision-mcp
npm install
npm start
```

`npm start` will:
1. Launch Chrome with `--remote-debugging-port=9222` (using a dedicated profile so you stay signed in).
2. Open `chatgpt.com`, `gemini.google.com/app`, **and `www.war.gov/UFO/`** — sign in to the LLM tabs once; on the war.gov tab, solve any one-time Akamai challenge it shows (you'll see a CAPTCHA-style "Pardon Our Interruption" or similar). Once cleared, the cookie persists in the profile and the warGov driver can `fetch()` releases.
3. Start the daemon on `http://127.0.0.1:9223`.
4. Generate a bearer token at `~/.pursue-vision-token`.

A provider tab missing or signed-out just makes that provider unavailable — the other one keeps working. The war.gov tab is only required when you actually want to run `corpus:fetch-war-gov`.

If you already have Chrome running on port 9222, pass `--no-chrome`:

```bash
npm start -- --no-chrome
```

Or start Chrome yourself first (close all Chrome windows first so the flag takes effect):

```bash
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\Google\Chrome\User Data"

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

## Using it from pursue-console

The pursue-console pipeline (`scripts/vision-ocr.mjs`) already speaks this daemon's protocol. Once `pursue-vision-mcp` is running, point pursue-console at it (it defaults to `http://127.0.0.1:9223`) and run a batch:

```bash
cd ..  # back to pursue-console
PURSUE_VISION_TOKEN=$(cat ~/.pursue-vision-token) \
  ONLY=cometa node scripts/vision-ocr.mjs
```

That's it. The pipeline handles rendering, pacing, batching, retries, and caching. The daemon's only job is being the ChatGPT messenger.

## Volunteer cockpit (`monitor.mjs`)

A **separate, optional process** from the OCR daemon. It owns the volunteer-facing
progress UI — the "PURSUE · Volunteer Instrument" dashboard — so the daemon (9223)
stays single-responsibility (its only job is OCR).

```bash
node pursue-vision-mcp/monitor.mjs            # HTTP on :9224 + auto-open browser
node pursue-vision-mcp/monitor.mjs --no-open  # HTTP only, don't open a browser
node pursue-vision-mcp/monitor.mjs --tui      # terminal dashboard instead of HTTP
```

Then open <http://localhost:9224/dashboard>.

What it does:

- **Serves the cockpit** (`dashboard.html`) at `/` and `/dashboard`, re-read fresh on
  every request, plus local PNG page previews on `/preview/<base64-path>` (path-jailed
  to home + cwd).
- **Persists state** to `~/.pursue-helper/progress.json` so it can show last-known
  progress even when nothing is running. `volunteer.mjs` pushes live updates via
  `POST /progress` (bearer-authed when `PURSUE_MONITOR_TOKEN` is set).
- **Launches work runs** from the dashboard via `POST /run` / `POST /run-any`. Modes:
  `ocr` and `review` (→ `scripts/volunteer.mjs`), `visuals` (claim) and
  `visuals-commit` (→ `scripts/volunteer-media.mjs`), and `doc` (a single document).
- **Loop mode** keeps `ocr`/`review`/`doc` runs going until the queue is empty.
  The `visuals` *claim* phase is intentionally **one-shot, never looped** — it only
  stages templates that still need a separate commit step, so auto-relooping it would
  just re-claim the same pages forever.
- **Prefers the local work queue.** If `public/work-available.json` exists (freshly
  built by `scripts/build-work-available.mjs`) the cockpit and the workers it spawns
  use it instead of the GitHub Pages copy, which can lag hours behind.

### Monitor endpoints (port 9224)

| Method · path        | Purpose                                                        |
|----------------------|----------------------------------------------------------------|
| `GET /progress`      | Current `progress.json` state (idle / now / slice / corpus).   |
| `POST /progress`     | Live update from a running worker (bearer-authed if token set).|
| `GET /running`       | `{ running, meta, log, lastRun }` for the active/last run.     |
| `POST /run`          | Start a run: `{ mode, eid?, slice?, loop?, handle }`.          |
| `POST /run-any`      | Auto-pick the first queue with fresh work and run it.          |
| `POST /stop`         | Stop the current run (also clears loop so it won't restart).   |
| `GET /daemon-health` | Whether the OCR daemon on `:9223` is reachable.                |

Env: `PURSUE_MONITOR_PORT` (default `9224`), `PURSUE_HELPER_DIR` (default
`~/.pursue-helper`), `PURSUE_MONITOR_TOKEN` (if set, required on `POST /progress`).

## API

### `POST /chat-with-files`

```json
{
  "provider": "chatgpt",
  "filePaths": ["/abs/path/to/page1.png", "/abs/path/to/page2.png"],
  "prompt": "Transcribe each page verbatim, separated by '=== PAGE BREAK ==='.",
  "timeoutMs": 300000,
  "freshChat": true
}
```

Headers: `Authorization: Bearer <your token>`. `provider` defaults to `chatgpt`; the other accepted value is `gemini`.

Returns:
```json
{ "provider": "chatgpt", "text": "<the assistant's reply>", "durationMs": 24310, "fileCount": 2 }
```

### `POST /fanout`

```json
{
  "providers": ["chatgpt", "gemini"],
  "filePaths": ["/abs/path/to/page.png"],
  "prompt": "Transcribe every word visible on this page verbatim.",
  "timeoutMs": 300000
}
```

Both providers run in parallel (separate queues, separate tabs). Returns:
```json
{
  "results": [
    { "provider": "chatgpt", "ok": true,  "text": "...", "durationMs": 24310 },
    { "provider": "gemini",  "ok": true,  "text": "...", "durationMs": 42180 }
  ],
  "totalDurationMs": 42180
}
```

A provider that errors gets `{ "provider": "...", "ok": false, "error": "..." }` instead of `text` — the other provider's result still comes back.

Errors:
- `401` — wrong / missing token
- `403` — `filePaths` not under your home directory or cwd
- `500` — driver error (upload didn't acknowledge, reply timed out, the model complained the file wasn't attached)

### `GET /war-gov/index?release=<n>` *(@unverified)*

Asks the daemon to fetch the war.gov/UFO release-files index for release `<n>` by running an in-page `fetch()` on a logged-in `www.war.gov/UFO/` tab. The driver tries three discovery strategies in order: (1) intercept the XHR that loads on initial page navigation, (2) DOM-scrape anchors pointing at `/medialink/ufo/release_<n>/...`, (3) probe likely index URLs (`/UFO/api/records`, `/UFO/index.json`, `/UFO/records.csv`, etc.). Whichever yields records wins; subsequent calls reuse the cached endpoint.

Returns:
```json
{
  "release": "2",
  "count": 64,
  "records": [
    { "filename": "case-001.pdf", "url": "https://www.war.gov/medialink/ufo/release_2/case-001.pdf",
      "agency": "USAF", "type": "pdf", "sizeBytes": 1234567 }
  ]
}
```

### `POST /war-gov/download` *(@unverified)*

```json
{
  "urls": ["https://www.war.gov/medialink/ufo/release_2/case-001.pdf"],
  "destDir": "/home/you/pursue-console/data-raw/war-gov/release_2"
}
```

`destDir` is jail-checked to be under your home directory or daemon cwd. Files >50 MB are downloaded in 8 MB HTTP Range chunks; bytes flow Chrome → base64 → Node → disk via a `.part` rename. On an Akamai block (403 / 429 / challenge body) the request aborts the whole batch rather than write challenge HTML pretending it's a PDF.

Returns:
```json
{
  "destDir": "/home/you/...",
  "totalDurationMs": 187423,
  "results": [
    { "url": "https://...", "ok": true, "bytes": 1234567, "destPath": "/home/you/.../case-001.pdf", "durationMs": 4210 },
    { "url": "https://...", "ok": false, "error": "war-gov: Akamai block on ..." }
  ]
}
```

The companion CLI is `scripts/sync-war-gov.mjs` in the parent project (`npm run corpus:fetch-war-gov`).

### `GET /status`

```json
{
  "port": 9223,
  "cdpPort": 9222,
  "providers": {
    "chatgpt": { "connected": true,  "history": 47 },
    "gemini":  { "connected": true,  "history":  3 },
    "warGov":  { "connected": true,  "history":  0 }
  }
}
```

### `GET /health`

Unauthenticated. Returns `{ "ok": true }`.

## Concurrency

**One request per provider at a time, both providers in parallel.** Each provider has its own single-slot queue; `/chat-with-files` against `chatgpt` and `/chat-with-files` against `gemini` can be in flight simultaneously (different browser tabs, different network paths). Within one provider, requests serialize because parallel uploads in the same tab race on UI state. If you want throughput per provider, batch more files per request (`filePaths.length`), not more requests.

## Security model

- **Server binds to 127.0.0.1 only.** Not reachable from the LAN unless you tunnel it yourself.
- **Bearer token required** on every authenticated route (`/chat-with-files`, `/status`). Token lives at `~/.pursue-vision-token` (mode 0600).
- **File-path jail.** `filePaths` are validated to resolve under your home directory or the directory you started the daemon from. No reading `/etc`.
- **No outbound traffic except to Chrome (via CDP) and the OS-resolved DNS.** All HTTP requests from this daemon are loopback (`http://127.0.0.1:9222` for CDP). The only "remote" traffic is your own Chrome session talking to chatgpt.com on your behalf.
- **No credentials handled.** Your ChatGPT login lives in Chrome, not here.

See [SECURITY.md](./SECURITY.md) for the full posture.

## What this deliberately doesn't do

This is a focused release. It does NOT include:

- Image / video generation
- Multi-LLM fan-out (Claude / Gemini / Kimi / local)
- Browser automation for other sites
- Persistent chat threads or context
- An MCP-protocol stdio interface (despite the name — this is HTTP-only here)

(The optional volunteer cockpit — `monitor.mjs` on :9224, documented above — does add
a progress UI, but the OCR daemon itself stays headless.)

If you want a fuller toolkit, the parent project's maintainer uses a more extensive private MCP. This release is the OCR-only slice anyone can run.

## License

MIT — see [LICENSE](./LICENSE).
