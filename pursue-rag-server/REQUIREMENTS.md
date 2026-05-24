# pursue-rag-server — REQUIREMENTS

Hand this to your build agent. The browser code in `src/lib/ragClient.js` already speaks this protocol — if the server implements it correctly, the deployed pursue-console site at `https://rizzleroc.github.io/pursue-console/` works zero-config.

A working reference implementation lives next to this file (`server.mjs`). The agent can either deploy it as-is, or rebuild it in another stack as long as the wire protocol below is preserved.

---

## 1. Deployment target

- **Platform**: Railway (Node service, auto-deploys from a directory)
- **Node version**: ≥ 20
- **Start command**: `npm start`
- **Port**: read from `process.env.PORT` (Railway sets it), default `8080` for local dev
- **Bind**: `0.0.0.0` (Railway requires non-localhost binding)

The project root is `pursue-rag-server/` inside the `rizzleroc/pursue-console` repo. Railway should be pointed at that subdirectory.

## 2. Environment variables

| Variable                | Required | Default                            | Purpose |
|-------------------------|----------|------------------------------------|---------|
| `ANTHROPIC_API_KEY`     | **yes**  | —                                  | Maintainer's Claude key, sk-ant-...   |
| `ALLOWED_ORIGINS`       | no       | `https://rizzleroc.github.io`      | Comma-separated CORS allowlist        |
| `PURSUE_RAG_BEARER`     | no       | (none)                             | Optional shared secret. When set, browser must send `Authorization: Bearer <secret>`. Acts as a thin "only my deploy can call this" layer on top of CORS. |
| `ANTHROPIC_MODEL`       | no       | `claude-haiku-4-5`                 | Override to test other models         |
| `RATE_LIMIT_PER_MIN`    | no       | `6`                                | Per-IP requests / minute              |
| `RATE_LIMIT_PER_DAY`    | no       | `120`                              | Per-IP requests / day                 |
| `PORT`                  | no       | `8080`                             | HTTP port (Railway sets it)           |

`localhost:*` and `127.0.0.1:*` are always allowed regardless of `ALLOWED_ORIGINS` (for contributors hitting a deployed staging URL from `vite dev`).

## 3. Wire protocol

### `GET /health`
- **Auth**: none
- **Response 200**: `{ ok: true, model: string }`
- Used by the browser's settings panel to show a live DAEMON UP / UNREACHABLE pill.

### `GET /`
- **Auth**: none
- **Response 200**: `{ service: "pursue-rag-server", endpoints: [...], model: string }`
- Service banner. Useful for humans browsing the URL.

### `POST /ask`
- **Auth**: if `PURSUE_RAG_BEARER` is set, require matching `Authorization: Bearer <secret>`. Otherwise, no bearer required.
- **CORS**: reject (403) if `Origin` header is set and not in `ALLOWED_ORIGINS` (with localhost exception).
- **Rate limit**: enforce `RATE_LIMIT_PER_MIN` and `RATE_LIMIT_PER_DAY` per client IP (use `x-forwarded-for` first hop on Railway). Return `429` with `{ error: "rate limit: N/min" }` when exceeded.
- **Body**:
  ```ts
  {
    question: string,                                    // user's natural-language question
    contexts: Array<{
      eid: string,                                       // event ID, e.g. "apollo-17"
      page?: number,                                     // PDF page (0-indexed by convention)
      title?: string,                                    // optional human title
      text: string,                                      // ~200-char snippet from the corpus
    }>,
    provider?: string,                                   // ignored on this backend (server picks model)
  }
  ```
- **Validation**:
  - `question`: required, non-empty string. → 400 `{ error: "question (string) required" }`
  - `contexts`: required, non-empty array. → 400 `{ error: "contexts[] (non-empty) required" }`
  - Body size cap: 1 MB. → 400 `{ error: "body too large" }`
- **Behavior**:
  1. Build a single LLM prompt that includes the retrieved contexts followed by the question and an instruction to (a) answer using ONLY the supplied context, (b) cite each supporting passage inline as `[eid · page]`, (c) refuse if context is insufficient, (d) cap at ~300 words. See `buildPrompt()` in `server.mjs` for the exact text.
  2. Call `anthropic.messages.create({ model: ANTHROPIC_MODEL, max_tokens: 1024, messages: [{role:"user", content: prompt}] })`.
  3. Concatenate all `type: "text"` content blocks from the response.
- **Response 200**:
  ```ts
  {
    provider: "anthropic",
    text: string,                                        // the answer
    durationMs: number,
    contextCount: number,
    model: string,                                       // actual model that responded
    usage: { input_tokens, output_tokens },              // Anthropic SDK pass-through
  }
  ```
- **Errors**:
  - 400: bad input
  - 401: missing/wrong bearer (only if `PURSUE_RAG_BEARER` set)
  - 403: origin not in allowlist
  - 429: rate limited
  - 502: upstream Anthropic error (relay `error.message` from the SDK)

## 4. CORS specifics

For every response, set:

```
Access-Control-Allow-Origin: <origin>          (only if origin is in allowlist)
Vary: Origin
```

For `OPTIONS` preflight, additionally:

```
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: <echo Access-Control-Request-Headers, or "Authorization, Content-Type" if absent>
Access-Control-Max-Age: 600
```

Return 204 No Content for OPTIONS. Do **not** require auth on OPTIONS — browsers strip Authorization from preflight by design.

## 5. Rate limiting

In-memory token bucket per client IP. Reset on process restart is acceptable (Railway redeploys are infrequent enough that this is "good enough" — don't over-engineer with Redis).

- Two buckets per IP: `minStart/minCount` (60-sec window), `dayStart/dayCount` (24-hour window).
- Both must be under their respective limits.
- IP detection: prefer `x-forwarded-for` first hop, fall back to `socket.remoteAddress`.

## 6. Logging

Log to stdout. Railway captures it.

- Startup: port, model, allowed origins, rate limits, bearer-required (y/n).
- Each request: nothing (avoid logging user questions for privacy).
- Each error: provider + message. No stack traces unless `process.env.DEBUG`.

## 7. Cost expectations

Claude Haiku 4.5, default config (10 contexts × 200-char snippets, 300-word answer cap, ~1.5K input tokens + 400 output tokens):

- ~$0.001 per `/ask` call
- Default `RATE_LIMIT_PER_DAY=120` → ~$0.12/day worst case per IP
- Sensible global ceiling: ~$5-15/month at modest traffic

Tune `ANTHROPIC_MODEL` up to `claude-sonnet-4-5` for higher quality at ~10× the cost.

## 8. Reference implementation

`pursue-rag-server/server.mjs` in the parent repo is a ~200-line vanilla-Node HTTP server (no Express needed) that implements all of the above. Dependencies:

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.1"
  }
}
```

That's it — one runtime dep. Read `server.mjs` and `package.json` for the exact shape. If the build agent rewrites in another stack (Express, Hono, Bun, etc.), preserve the wire protocol above.

## 9. Browser-side default

The browser ships with `DEFAULT_HOSTED_URL = "https://pursue-rag-production.up.railway.app"` in `src/lib/askSettings.js`. After deploying, update that constant to the actual Railway URL and redeploy the site (or instruct users to override it via the ASK settings panel — which is a per-browser localStorage value).
