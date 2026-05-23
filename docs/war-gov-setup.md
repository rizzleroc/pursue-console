# war.gov ingestion — environment setup

The pipeline pulls war.gov UAP release files through `scripts/sync-war-gov.mjs`. The script auto-picks between two paths:

- **MCP daemon path** (preferred): drives a logged-in Chrome tab via the [`pursue-vision-mcp`](../pursue-vision-mcp/) daemon on `:9223`. In-page `fetch()` inherits the browser's TLS handshake, which is the only thing Akamai's fingerprinting on war.gov reliably accepts.
- **Direct path** (`scripts/lib/war-gov-direct.mjs`): plain Node `fetch`, used when the daemon isn't running. Usually trips Akamai against live war.gov; mainly useful for mirrors via `--base-url`.

## Network allowlist

Claude Code on the Web sandboxes restrict outbound traffic to a per-environment allowlist. For the war.gov flow to work end-to-end inside a sandbox, the following hosts have to be added to the environment's network policy in the web UI (this can't be configured from inside the sandbox):

| Host | Why |
| --- | --- |
| `*.war.gov` | The release files and the `/UFO/` landing page. |
| `cdn.playwright.dev` | Only if Playwright needs to download Chromium fresh. The current sandbox image ships a bundled binary at `/opt/pw-browsers/chromium-1194/`; if that's still there, this entry is optional. |
| `*.akamaihd.net`, `*.akamai.net` | War.gov serves some assets via Akamai's CDN. Add as a wildcard to avoid one-off failures on specific releases. |

Docs for the env config UI: https://code.claude.com/docs/en/claude-code-on-the-web

## Running the sync

Once the allowlist is set:

```bash
# Auto-pick (daemon if up on :9223, else direct):
node scripts/sync-war-gov.mjs --release=02 --dry-run

# Force the MCP path (errors out if the daemon isn't healthy):
node scripts/sync-war-gov.mjs --release=02 --prefer-mcp

# Force the direct path (skip the daemon probe entirely):
node scripts/sync-war-gov.mjs --release=02 --prefer-direct

# Point the direct path at a mirror:
node scripts/sync-war-gov.mjs --release=02 --prefer-direct --base-url=https://example.com
```

To start the MCP daemon (it expects an already-authenticated Chrome tab and won't help in a headless sandbox by itself):

```bash
npm start --prefix pursue-vision-mcp
```

## What the SessionStart hook does

`.claude/hooks/session-start.sh` runs on every sandbox boot and only inside Claude Code on the Web (`CLAUDE_CODE_REMOTE=true`). It:

1. Installs top-level `node_modules` if missing.
2. Installs `pursue-vision-mcp/node_modules` if missing.
3. Verifies the bundled Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` and exports `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` for the session.

It deliberately does **not** launch Chrome or the MCP daemon — those are opt-in and would leak processes across compactions.
