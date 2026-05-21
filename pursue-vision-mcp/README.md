# pursue-vision-mcp

**Minimal open-source daemon that drives your already-logged-in ChatGPT and Gemini browser tabs to OCR pages of documents.** Drop-in compatible with the [pursue-console](../README.md) vision-OCR pipeline.

Two routes:

- **`POST /chat-with-files`** — send N image paths + a prompt to one provider (`chatgpt` or `gemini`), get the model's reply back as text.
- **`POST /fanout`** — send the SAME prompt + files to BOTH providers in parallel; returns both responses. Used by the corpus's cross-source re-evaluation pipeline (`scripts/reevaluate-disputed.mjs`).

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
2. Open BOTH `chatgpt.com` and `gemini.google.com/app` — sign in once in each (or skip the one you don't have).
3. Start the daemon on `http://127.0.0.1:9223`.
4. Generate a bearer token at `~/.pursue-vision-token`.

A provider tab missing or signed-out just makes that provider unavailable — the other one keeps working.

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

### `GET /status`

```json
{
  "port": 9223,
  "cdpPort": 9222,
  "providers": {
    "chatgpt": { "connected": true,  "history": 47 },
    "gemini":  { "connected": true,  "history":  3 }
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
