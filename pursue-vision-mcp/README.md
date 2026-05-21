# pursue-vision-mcp

**Minimal open-source daemon that drives your already-logged-in ChatGPT, Gemini, and Claude browser tabs to OCR pages of documents.** Drop-in compatible with the [pursue-console](../README.md) vision-OCR pipeline.

Two routes:

- **`POST /chat-with-files`** — send N image paths + a prompt to one provider (`chatgpt`, `gemini`, or `claude`), get the model's reply back as text.
- **`POST /fanout`** — send the SAME prompt + files to multiple providers in parallel; returns all responses. Used by the corpus's cross-source re-evaluation pipeline (`scripts/reevaluate-disputed.mjs`).

No image generation, no API keys, no chat memory, no fancy queue, no telemetry. If you have a ChatGPT Plus, Gemini, and/or Claude account, this is enough to contribute transcriptions to the corpus (see [HOW-CAN-I-HELP.md](../HOW-CAN-I-HELP.md) in the parent project).

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
2. Open `chatgpt.com`, `gemini.google.com/app`, and `claude.ai/new` — sign in once in each (or skip any you don't have).
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

Headers: `Authorization: Bearer <your token>`. `provider` defaults to `chatgpt`; the other accepted values are `gemini` and `claude`.

Returns:
```json
{ "provider": "chatgpt", "text": "<the assistant's reply>", "durationMs": 24310, "fileCount": 2 }
```

### `POST /fanout`

```json
{
  "providers": ["chatgpt", "gemini", "claude"],
  "filePaths": ["/abs/path/to/page.png"],
  "prompt": "Transcribe every word visible on this page verbatim.",
  "timeoutMs": 300000
}
```

`providers` defaults to `["chatgpt", "gemini"]` when omitted. All listed providers run in parallel (separate queues, separate tabs). Returns:
```json
{
  "results": [
    { "provider": "chatgpt", "ok": true,  "text": "...", "durationMs": 24310 },
    { "provider": "gemini",  "ok": true,  "text": "...", "durationMs": 42180 },
    { "provider": "claude",  "ok": true,  "text": "...", "durationMs": 38120 }
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
    "gemini":  { "connected": true,  "history":  3 },
    "claude":  { "connected": true,  "history":  5 }
  }
}
```

### `GET /health`

Unauthenticated. Returns `{ "ok": true }`.

## Concurrency

**One request per provider at a time, all providers in parallel.** Each provider has its own single-slot queue; `/chat-with-files` against `chatgpt`, `gemini`, and `claude` can all be in flight simultaneously (different browser tabs, different network paths). Within one provider, requests serialize because parallel uploads in the same tab race on UI state. If you want throughput per provider, batch more files per request (`filePaths.length`), not more requests.

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
- Additional providers beyond chatgpt / gemini / claude (e.g. Kimi / local)
- Browser automation for other sites
- Persistent chat threads or context
- A dashboard / UI
- An MCP-protocol stdio interface (despite the name — this is HTTP-only here)

If you want a fuller toolkit, the parent project's maintainer uses a more extensive private MCP. This release is the OCR-only slice anyone can run.

## License

MIT — see [LICENSE](./LICENSE).
