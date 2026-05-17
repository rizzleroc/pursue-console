// One-shot entry point: ensure Chrome is up on the debug port, start the daemon.
//
// Usage:
//   npm start                    — use primary MCP if running, else auto-launch Chrome + daemon
//   npm start -- --no-chrome     — assume Chrome is already running on CDP port
//   npm start -- --no-primary    — skip primary MCP check, always spin up own instance
//
// The actual ChatGPT login is your problem (and your computer's). We never
// see your credentials; we only attach to a tab you already authenticated in.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { platform } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CDP_PORT = Number(process.env.PURSUE_CDP_PORT || 9222);
const NO_CHROME = process.argv.includes("--no-chrome");
const NO_PRIMARY = process.argv.includes("--no-primary");
const PRIMARY_MCP_PORT = Number(process.env.PURSUE_PRIMARY_MCP_PORT || 9223);

async function probeMcp(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

// If the primary MCP is already running, delegate to it — no Chrome needed.
if (!NO_PRIMARY && await probeMcp(PRIMARY_MCP_PORT)) {
  console.log(`[start] primary MCP already running on :${PRIMARY_MCP_PORT} — skipping Chrome + daemon startup`);
  console.log(`[start] use DAEMON=http://127.0.0.1:${PRIMARY_MCP_PORT} in your scripts`);
  process.exit(0);
}

async function probeCdp() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

function findChrome() {
  const candidates = platform() === "win32"
    ? [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
      ]
    : platform() === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const c of candidates) {
    try { if (existsSync(c) && statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

async function ensureChrome() {
  if (await probeCdp()) {
    console.log(`[start] Chrome already listening on CDP port ${CDP_PORT}`);
    return;
  }
  if (NO_CHROME) {
    console.error(`[start] CDP port ${CDP_PORT} not reachable and --no-chrome was passed. Start Chrome yourself with --remote-debugging-port=${CDP_PORT} then re-run.`);
    process.exit(2);
  }
  const chrome = findChrome();
  if (!chrome) {
    console.error(`[start] Chrome not found in the usual locations. Install Chrome or start it yourself with --remote-debugging-port=${CDP_PORT} and pass --no-chrome.`);
    process.exit(2);
  }
  const profileSuffix = process.env.PURSUE_CHROME_PROFILE || `pursure-${CDP_PORT}`;
  const userDataDir = platform() === "win32"
    ? `${process.env.LOCALAPPDATA}/Google/Chrome/User Data - ${profileSuffix}`
    : platform() === "darwin"
    ? `${process.env.HOME}/Library/Application Support/Google/Chrome-${profileSuffix}`
    : `${process.env.HOME}/.config/google-chrome-${profileSuffix}`;
  console.log(`[start] launching Chrome with --remote-debugging-port=${CDP_PORT}`);
  console.log(`[start] using profile ${userDataDir}`);
  spawn(chrome, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "https://chatgpt.com",
  ], { detached: true, stdio: "ignore" }).unref();
  // Give Chrome a moment to bind the port
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await probeCdp()) { console.log(`[start] CDP reachable on ${CDP_PORT}`); return; }
  }
  console.error(`[start] Chrome launched but CDP port ${CDP_PORT} never became reachable. Try restarting Chrome manually.`);
  process.exit(3);
}

await ensureChrome();

// Hand off to the daemon — same Node process.
await import(pathToFileURL(path.join(__dirname, "daemon.mjs")).href);
