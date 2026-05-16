// One-shot entry point: ensure Chrome is up on the debug port, start the daemon.
//
// Usage:
//   npm start                    — auto-launch Chrome if needed, start daemon
//   npm start -- --no-chrome     — assume Chrome is already running on CDP port
//
// The actual ChatGPT login is your problem (and your computer's). We never
// see your credentials; we only attach to a tab you already authenticated in.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CDP_PORT = Number(process.env.PURSUE_CDP_PORT || 9222);
const NO_CHROME = process.argv.includes("--no-chrome");

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
  const userDataDir = platform() === "win32"
    ? `${process.env.LOCALAPPDATA}/Google/Chrome/User Data`
    : platform() === "darwin"
    ? `${process.env.HOME}/Library/Application Support/Google/Chrome`
    : `${process.env.HOME}/.config/google-chrome`;
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
await import(path.join(__dirname, "daemon.mjs"));

// After daemon is up, print the dashboard URL prominently and try to open it.
const DASHBOARD_URL = `http://127.0.0.1:${process.env.PURSUE_VISION_PORT || 9223}/dashboard`;
console.log("");
console.log("╭───────────────────────────────────────────────────────────╮");
console.log("│  Dashboard:  " + DASHBOARD_URL.padEnd(43) + "│");
console.log("│  Helmsman Phosphor — live progress while you contribute  │");
console.log("╰───────────────────────────────────────────────────────────╯");

if (!process.argv.includes("--no-open-dashboard")) {
  // Best-effort open. Don't fail the daemon if it doesn't work.
  const opener = platform() === "win32" ? ["cmd", ["/c", "start", "", DASHBOARD_URL]]
              : platform() === "darwin" ? ["open", [DASHBOARD_URL]]
              :                            ["xdg-open", [DASHBOARD_URL]];
  try {
    const c = spawn(opener[0], opener[1], { stdio: "ignore", detached: true });
    c.on("error", () => {});
    c.unref();
  } catch {}
}
