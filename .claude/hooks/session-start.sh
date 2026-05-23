#!/usr/bin/env bash
# Claude Code on the Web — SessionStart hook for pursue-console.
#
# Purpose: get the sandbox ready for the pipeline scripts (build, lint,
# and especially the war.gov ingestion flow that needs Playwright +
# bundled Chromium). Never blocks a session — always exits 0, even if
# parts of setup couldn't complete. The agent can re-run any missing
# step on demand.
#
# What it does (in order):
#   1. `npm install` at repo root if node_modules is missing — needed
#      for `npm run lint`, the build, and the corpus:* scripts.
#   2. `npm install` in pursue-vision-mcp/ if its node_modules is
#      missing — needed before `npm start --prefix pursue-vision-mcp`
#      can connect-over-CDP to drive war.gov.
#   3. Check for the bundled Playwright Chromium binary at
#      /opt/pw-browsers/chromium-1194/chrome-linux/chrome and expose
#      PLAYWRIGHT_BROWSERS_PATH via $CLAUDE_ENV_FILE so the MCP picks
#      it up without re-downloading.
#
# What it deliberately doesn't do:
#   - Launch Chrome. The browser is opt-in; sync-war-gov.mjs only
#     needs it when actually pulling release files. Starting it here
#     would leak processes across compactions.
#   - Launch the MCP daemon (`npm start --prefix pursue-vision-mcp`).
#     Same reason — opt-in, and it expects an already-logged-in tab
#     anyway which a headless sandbox doesn't have.
#   - Add hostnames to the egress allowlist. That's an environment-
#     level setting in the Claude Code Web UI, not something a hook
#     can mutate. See docs/war-gov-setup.md for the list.

set -uo pipefail

# Only run in the remote (Claude Code on the Web) sandbox — local
# clones already have their own dev setup, and we don't want to
# stomp on a contributor's existing node_modules.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
MCP_DIR="$PROJECT_DIR/pursue-vision-mcp"
CHROMIUM_BIN="/opt/pw-browsers/chromium-1194/chrome-linux/chrome"

# Tag every line so the session log shows which step is talking.
log() { printf '[session-start] %s\n' "$*"; }

# 1. Top-level deps.
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  log "installing top-level deps (npm install)..."
  ( cd "$PROJECT_DIR" && npm install --no-audit --no-fund --loglevel=error ) \
    || log "WARN: top-level npm install failed; lint/build will be unavailable until rerun"
else
  log "top-level node_modules present, skipping npm install"
fi

# 2. MCP deps (playwright).
if [ -d "$MCP_DIR" ] && [ ! -d "$MCP_DIR/node_modules" ]; then
  log "installing pursue-vision-mcp deps (playwright)..."
  ( cd "$MCP_DIR" && npm install --no-audit --no-fund --loglevel=error ) \
    || log "WARN: pursue-vision-mcp npm install failed; war.gov sync via MCP will be unavailable until rerun"
elif [ -d "$MCP_DIR/node_modules" ]; then
  log "pursue-vision-mcp node_modules present, skipping npm install"
fi

# 3. Verify bundled Chromium + persist its location for the session.
if [ -x "$CHROMIUM_BIN" ]; then
  log "bundled Chromium found at $CHROMIUM_BIN"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers" >> "$CLAUDE_ENV_FILE"
    log "PLAYWRIGHT_BROWSERS_PATH exported via CLAUDE_ENV_FILE"
  fi
else
  log "WARN: bundled Chromium not found at $CHROMIUM_BIN"
  log "      a fresh \`npx playwright install chromium\` requires cdn.playwright.dev"
  log "      to be on the env allowlist (see docs/war-gov-setup.md)"
fi

log "ready (war.gov ingestion still needs *.war.gov in the egress allowlist;"
log " see docs/war-gov-setup.md)"
exit 0
