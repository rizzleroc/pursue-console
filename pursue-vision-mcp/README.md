# pursue-vision-mcp

**Minimal open-source daemon that drives an already-logged-in ChatGPT browser tab to OCR pages of documents.** Drop-in compatible with the [pursue-console](../README.md) vision-OCR pipeline.

This is a focused slice — the only function it exposes is **`/chat-with-files`**: send N image paths + a prompt, get the model's reply back as text. No image generation, no API keys, no chat memory, no fancy queue, no telemetry.

If you have ChatGPT Plus and a Chrome profile already signed in, this is enough to contribute transcriptions to the corpus (see [CONTRIBUTING-CORPUS.md](../CONTRIBUTING-CORPUS.md) in the parent project).

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
1. Launch Chrome with `--remote-debugging-port=9222` (using your real profile so you stay signed in).
2. Open `chatgpt.com` — sign in once if you aren't already.
3. Start the daemon on `http://127.0.0.1:9223`.
4. Generate a bearer token at `~/.pursue-vision-token`.

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
  "filePaths": ["/abs/path/to/page1.png", "/abs/path/to/page2.png"],
  "prompt": "Transcribe each page verbatim, separated by '=== PAGE BREAK ==='.",
  "timeoutMs": 300000,
  "freshChat": true
}
```

Headers: `Authorization: Bearer <your token>`

Returns:
```json
{ "text": "<the assistant's reply>", "durationMs": 24310, "fileCount": 2 }
```

Errors:
- `401` — wrong / missing token
- `403` — `filePaths` not under your home directory or cwd
- `500` — driver error (upload didn't acknowledge, reply timed out, ChatGPT complained the file wasn't attached)

### `GET /status`

```json
{
  "port": 9223,
  "cdpPort": 9222,
  "connected": true,
  "queueDepth": 0,
  "history": 47
}
```

### `GET /health`

Unauthenticated. Returns `{ "ok": true }`.

## Concurrency

**One request at a time.** The daemon serializes everything through a single ChatGPT tab. This is intentional: parallel uploads in the same tab race on UI state. If you want throughput, batch more files per request (`filePaths.length` up to 10 per ChatGPT message), not more requests.

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
- A dashboard / UI
- An MCP-protocol stdio interface (despite the name — this is HTTP-only here)

If you want a fuller toolkit, the parent project's maintainer uses a more extensive private MCP. This release is the OCR-only slice anyone can run.

## License

MIT — see [LICENSE](./LICENSE).
