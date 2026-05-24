# pursue-rag-server

Hosted RAG proxy for the deployed [pursue-console](../README.md) ASK view. Deploys to Railway in a few minutes; the browser POSTs retrieved passages + the user's question, the server synthesizes via the Anthropic Messages API server-side, returns the answer.

Same wire protocol as the local `pursue-vision-mcp` daemon — the browser code in `src/lib/ragClient.js` doesn't care which one it's talking to.

```
POST /ask
  { question, contexts: [{eid, page, text}], provider? }
→ 200 { provider, text, durationMs, contextCount }
```

## Why a server (vs. calling Anthropic from the browser)

Anthropic *does* allow direct browser calls, but the key would have to be either (a) shipped to every visitor or (b) pasted by each visitor into a settings panel. Option (a) leaks the key; option (b) makes the deployed site useless for casual readers. A 100-line proxy keeps the key on the server, lets the site Just Work, and adds rate limits so nobody can spam it.

## Deploy on Railway

```bash
cd pursue-rag-server
# 1. Connect this dir to a Railway service (Railway CLI: `railway init`,
#    or set up via the dashboard pointing at this folder).

# 2. Set env vars in the Railway service:
#    ANTHROPIC_API_KEY   (required)
#    ALLOWED_ORIGINS     (default: https://rizzleroc.github.io)
#    PURSUE_RAG_BEARER   (optional shared secret — see below)
#    ANTHROPIC_MODEL     (default: claude-haiku-4-5)
#    RATE_LIMIT_PER_MIN  (default: 6)
#    RATE_LIMIT_PER_DAY  (default: 120)

# 3. Start command: `npm start` (already set in package.json).

# 4. Railway hands you a URL like
#    https://pursue-rag-production.up.railway.app
#    Paste it into pursue-console's ASK settings → Hosted backend URL.
```

## Endpoints

| Method | Path     | Description |
|--------|----------|-------------|
| GET    | /health  | `{ ok: true, model }` — no auth required |
| GET    | /        | Service banner, lists endpoints |
| POST   | /ask     | Synthesize an answer from the supplied contexts |

## Abuse mitigation

- **CORS** — `ALLOWED_ORIGINS` env var. Default is the GH Pages site. Localhost dev origins are always allowed for contributors. Any other origin gets a `403`.
- **Rate limit** — in-memory token bucket per client IP. `RATE_LIMIT_PER_MIN` (default 6) and `RATE_LIMIT_PER_DAY` (default 120). Both must be under the limit; otherwise `429`.
- **Optional shared bearer** — set `PURSUE_RAG_BEARER` to require the browser to send `Authorization: Bearer <secret>`. The browser-side default URL ships with the same bearer baked in (you set both to the same value at deploy time). This is security-by-obscurity, but combined with CORS + rate limits it's enough for a side project.

CORS alone doesn't prevent direct curl abuse. If you start seeing weird traffic in Railway's logs, set `PURSUE_RAG_BEARER` (you'll need to redeploy the site with the matching value).

## Costs

Claude Haiku 4.5 at the current default config (~10 contexts × 200-char snippets, 300-word answer cap) runs ~$0.001 / question. The default `RATE_LIMIT_PER_DAY=120` therefore caps each IP at ~$0.12/day worst case. Tune `RATE_LIMIT_PER_DAY` down if you're worried.

## Local dev

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm install
npm start
# → http://0.0.0.0:8080
```

Hit it from the browser by setting the ASK settings → Hosted backend URL to `http://localhost:8080`.
