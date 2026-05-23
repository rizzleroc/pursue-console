// pursue-vision-mcp · MONITOR
//
// A separate process from the MCP daemon. Owns the helper progress UI on
// its own port (default 9224, configurable via PURSUE_MONITOR_PORT). The
// MCP daemon (9223) stays single-responsibility — its only job is OCR.
//
// Design:
//   • Persists state to ~/.pursue-helper/progress.json so the monitor
//     can show last-known state even when nothing is actively running.
//   • Accepts live updates via POST /progress (bearer-authed) and writes
//     them to the file atomically. volunteer.mjs talks to this port.
//   • Serves dashboard.html on / and /dashboard for the browser UI.
//   • Streams local PNGs as preview thumbnails on /preview/<base64-path>,
//     jailed to home + cwd like the daemon.
//   • Optional --tui mode prints stats to the terminal instead of HTTP.
//
// Usage:
//   node pursue-vision-mcp/monitor.mjs            # HTTP + auto-open browser
//   node pursue-vision-mcp/monitor.mjs --tui      # terminal mode
//   node pursue-vision-mcp/monitor.mjs --no-open  # HTTP, don't open browser
//
// Env:
//   PURSUE_MONITOR_PORT  default 9224
//   PURSUE_HELPER_DIR    default ~/.pursue-helper
//   PURSUE_MONITOR_TOKEN if set, required on POST /progress (default: no auth)

import http from "node:http";
import { readFile, writeFile, mkdir, rename, readdir, rm } from "node:fs/promises";
import { existsSync, createReadStream, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PURSUE_MONITOR_PORT || 9224);
const HELPER_DIR = process.env.PURSUE_HELPER_DIR || path.join(os.homedir(), ".pursue-helper");
const STATE_PATH = path.join(HELPER_DIR, "progress.json");
const STATE_TMP  = path.join(HELPER_DIR, "progress.json.tmp");
const DASHBOARD_HTML = path.join(__dirname, "dashboard.html");
const TOKEN = process.env.PURSUE_MONITOR_TOKEN || null;

const argv = new Set(process.argv.slice(2));
const TUI_MODE = argv.has("--tui");
const NO_OPEN = argv.has("--no-open");

await mkdir(HELPER_DIR, { recursive: true });

// ----- state -----
const blankState = () => ({
  handle: null,
  shiftStart: null,
  idle: true,
  onBreak: null,
  now: null,
  slice: { done: 0, total: 0 },
  corpus: { done: 0, target: 0 },
  recent: [],
  session: { pagesOk: 0, pagesErr: 0 },
  updatedAt: null,
  daemonPort: Number(process.env.PURSUE_VISION_PORT || 9223),
});

let state = blankState();
try {
  if (existsSync(STATE_PATH)) state = { ...blankState(), ...JSON.parse(await readFile(STATE_PATH, "utf8")) };
} catch {}
// Nothing is running at boot, so any persisted "active" state is stale from a
// previous run that exited without resetting. Force idle so the focal display
// doesn't show a phantom "NOW PROCESSING" page on a fresh load.
state.now = null;
state.idle = true;
state.onBreak = null;
state.slice = { done: 0, total: 0 };

async function persistState() {
  try {
    await writeFile(STATE_TMP, JSON.stringify(state, null, 0), "utf8");
    await rename(STATE_TMP, STATE_PATH);
  } catch {} // non-fatal
}

// ----- TUI mode -----
async function tuiLoop() {
  process.stdout.write("\x1b[?25l"); // hide cursor
  process.on("SIGINT", () => { process.stdout.write("\x1b[?25h\n"); process.exit(0); });
  const c = {
    green: s => `\x1b[38;5;121m${s}\x1b[0m`,
    cyan:  s => `\x1b[38;5;117m${s}\x1b[0m`,
    amber: s => `\x1b[38;5;221m${s}\x1b[0m`,
    rose:  s => `\x1b[38;5;211m${s}\x1b[0m`,
    dim:   s => `\x1b[2;38;5;71m${s}\x1b[0m`,
    bold:  s => `\x1b[1m${s}\x1b[0m`,
  };
  const fmt = n => String(n).padStart(2, "0");
  while (true) {
    try {
      if (existsSync(STATE_PATH)) state = { ...blankState(), ...JSON.parse(await readFile(STATE_PATH, "utf8")) };
    } catch {}
    process.stdout.write("\x1b[2J\x1b[H");  // clear + home
    const now = new Date();
    const elapsed = state.shiftStart ? Math.max(0, (Date.now() - state.shiftStart) / 1000) : 0;
    const h = Math.floor(elapsed / 3600), m = Math.floor((elapsed % 3600) / 60), s = Math.floor(elapsed % 60);
    const slicePct = state.slice.total ? Math.round(state.slice.done / state.slice.total * 100) : 0;
    const corpusPct = state.corpus.target ? Math.round(state.corpus.done / state.corpus.target * 100) : 0;
    const statusColor = state.idle ? c.dim : state.onBreak ? c.amber : c.green;

    console.log(c.green(c.bold("  P U R S U E   V O L U N T E E R   I N S T R U M E N T")));
    console.log(c.dim(`  operator @${state.handle || "—"}     ${now.toUTCString()}`));
    console.log("");
    console.log(`  ${statusColor("●")} ${state.idle ? "IDLE" : state.onBreak ? `BREAK · ${state.onBreak}` : "ACTIVE"}      shift ${fmt(h)}:${fmt(m)}:${fmt(s)}`);
    console.log("");
    if (state.now) {
      console.log(c.cyan(`  NOW PROCESSING  ${state.now.eid || ""}`));
      console.log(c.cyan(`  ${c.bold("page " + (state.now.page || "—"))}`));
      console.log(c.dim(`  ${state.now.phase || ""}`));
      console.log(c.dim(`  ${state.now.metaLine || ""}`));
    } else {
      console.log(c.dim("  awaiting first batch…"));
    }
    console.log("");
    const barW = 40;
    const sliceFill = "█".repeat(Math.round(slicePct * barW / 100)) + "░".repeat(barW - Math.round(slicePct * barW / 100));
    const corpusFill = "█".repeat(Math.round(corpusPct * barW / 100)) + "░".repeat(barW - Math.round(corpusPct * barW / 100));
    console.log(`  YOUR SLICE   ${c.amber(sliceFill)}  ${state.slice.done}/${state.slice.total}  ${slicePct}%`);
    console.log(`  CORPUS       ${c.green(corpusFill)}  ${state.corpus.done.toLocaleString()}/${state.corpus.target.toLocaleString()}  ${corpusPct}%`);
    console.log("");
    if (state.recent.length) {
      console.log(c.dim("  LAST SIX COMPLETIONS"));
      for (const r of state.recent.slice(-6)) {
        const stateC = r.state === "ok" ? c.green : r.state === "fallback" ? c.amber : r.state === "pending" ? c.cyan : c.rose;
        console.log(`    p${String(r.page).padStart(3)}   ${stateC((r.state || "ok").toUpperCase().padEnd(10))}   ${c.dim(r.note || "")}`);
      }
    }
    console.log("");
    console.log(c.dim(`  state at ${STATE_PATH}    ctrl-c to exit`));
    await new Promise(r => setTimeout(r, 1000));
  }
}

if (TUI_MODE) {
  await tuiLoop();
  process.exit(0);
}

// ----- volunteer process runner -----
const SCRIPTS_ROOT = path.resolve(__dirname, "..");
let runningProc = null;
let runningMeta = null;  // { mode, eid, slice, loop, startedAt }

function procRunning() {
  // A live spawned child has exitCode === null until it exits, then a number.
  return runningProc !== null && runningProc.exitCode === null;
}

function buildVolunteerArgs(opts) {
  // opts: { mode: "ocr"|"review"|"visuals", eid, slice, loop, handle, daemonPort }
  const handle = opts.handle || state.handle || "volunteer";
  const slice  = Math.max(1, Math.min(200, Number(opts.slice) || 20));
  const daemon = `http://127.0.0.1:${opts.daemonPort || state.daemonPort || 9223}`;
  // Vision model the daemon should drive. Defaults to chatgpt to preserve the
  // pre-provider behavior; volunteer.mjs routes the request to the matching
  // browser tab and writes to contributions/<handle>/<gpt-vision|gemini|claude>/.
  const provider = ["chatgpt", "gemini", "claude"].includes(opts.provider) ? opts.provider : "chatgpt";

  if (opts.mode === "visuals") {
    // volunteer-media.mjs has its own flow. --auto-context lets the daemon draft
    // the Context so the staged templates are commit-ready (dashboard default).
    const args = ["scripts/volunteer-media.mjs", `--my-handle=${handle}`, `--slice=${slice}`, `--daemon=${daemon}`];
    if (existsSync(LOCAL_QUEUE_PATH)) args.push(`--queue-url=${LOCAL_QUEUE_PATH}`);
    if (opts.autoContext !== false) args.push("--auto-context");
    return { script: "volunteer-media.mjs", args };
  }
  if (opts.mode === "visuals-commit") {
    // Second phase: validate filled templates, commit them, and open the PR.
    // (Previously passed --no-pr, which stopped at "finish by hand" — the
    // commit button is supposed to actually publish, so let it run the full
    // git commit + push + gh pr create flow.)
    const args = ["scripts/volunteer-media.mjs", `--my-handle=${handle}`, "--commit"];
    return { script: "volunteer-media.mjs", args };
  }

  const args = [
    "scripts/volunteer.mjs",
    `--my-handle=${handle}`,
    `--slice=${slice}`,
    `--daemon=${daemon}`,
    `--provider=${provider}`,
    "--no-pr",
  ];
  if (existsSync(LOCAL_QUEUE_PATH)) args.push(`--queue-url=${LOCAL_QUEUE_PATH}`);
  if (opts.mode === "review") args.push("--review");
  if (opts.eid)              args.push(`--eid=${opts.eid}`);
  return { script: "volunteer.mjs", args };
}

// Last completed run outcome — read by /running so the dashboard can show
// "DONE · ok=12 err=0" or "NO NEW WORK · all pages already submitted" instead
// of just "IDLE", which made every benign 1-second exit look like a crash.
let lastRun = null;

function summarizeLog(allLines, exitCode) {
  const text = allLines.join("\n");
  // volunteer.mjs prints "⊖ <eid> p<N> already done (local or merged to main)"
  // — the older "already submitted" pattern never matched, so skipCount was
  // always 0 and the dashboard headline collapsed to a generic "NO NEW WORK"
  // instead of "NO NEW WORK · N pages already submitted".
  const skipCount = (text.match(/⊖.*already (?:submitted|done)/g) || []).length;
  const okMatch   = text.match(/done\.\s*ok=(\d+)\s*err=(\d+)/);
  const okCount   = okMatch ? Number(okMatch[1]) : 0;
  const errCount  = okMatch ? Number(okMatch[2]) : 0;
  const noCommit  = /nothing to commit/.test(text);
  const queueGen  = (text.match(/queue gen ([^\s·]+)/) || [])[1] || null;

  const econnRefused = /ECONNREFUSED.*9223|ECONNREFUSED 127\.0\.0\.1:9223/.test(text);
  const cdpTimeout   = /connectOverCDP.*Timeout|CDP.*timeout/i.test(text);
  const tokenError   = /unauthorized.*bearer|HTTP 401/i.test(text);
  const pdfRenderFails = (text.match(/render failed \(Value is none of these types/g) || []).length;
  const claimedFromMedia = /\[claim\]/.test(text);
  // Visuals claim phase: "[claim] claiming N page(s)" then "templates written to".
  const mediaClaimMatch = text.match(/\[claim\] claiming (\d+) page/);
  const mediaClaimed    = mediaClaimMatch ? Number(mediaClaimMatch[1]) : 0;
  const mediaTemplatesWritten = /templates written to/.test(text);
  const draftedCount = (text.match(/drafting context via daemon… ✓/g) || []).length;
  // Visuals commit phase: "[commit] N ready · M incomplete · K empty".
  const commitMatch = text.match(/\[commit\] (\d+) ready · (\d+) incomplete · (\d+) empty/);
  // Final outcome of the commit phase (volunteer-media.mjs prints exactly one).
  const prOpened   = /\[commit\] ✓ PR opened for/.test(text);
  const nothingNew = /\[commit\] nothing new to publish/.test(text);
  const prFailed   = /\[commit\] PR step failed/.test(text);

  let kind, headline, detail;
  if (exitCode === null) {
    kind = "stopped"; headline = "STOPPED"; detail = "Killed by user.";
  } else if (commitMatch) {
    const ready = Number(commitMatch[1]), incomplete = Number(commitMatch[2]), empty = Number(commitMatch[3]);
    if (prOpened) {
      kind = "success"; headline = `✓ PR OPENED · ${ready} page(s)`;
      detail = `Opened a pull request with ${ready} media contribution(s)${incomplete ? `; ${incomplete} incomplete template(s) skipped` : ""}. Merge it to publish.`;
    } else if (nothingNew) {
      kind = "noop"; headline = `✓ UP TO DATE · ${ready} already published`;
      detail = `All ${ready} reviewed page(s) are already committed or merged — nothing new to publish.${incomplete ? ` ${incomplete} template(s) still incomplete.` : ""} The staging folder can be cleared.`;
    } else if (prFailed) {
      kind = "error"; headline = `PR STEP FAILED · ${ready} committed locally`;
      detail = `${ready} contribution(s) were committed on a local branch but the PR couldn't be opened (auth/network?). Finish with: gh pr create --head <branch>. See log.`;
    } else if (ready > 0) {
      kind = "success"; headline = `COMMITTED · ${ready} page(s)`;
      detail = `${ready} media contribution(s) committed.${incomplete ? ` ${incomplete} template(s) incomplete (skipped).` : ""}${empty ? ` ${empty} empty (skipped).` : ""}`;
    } else {
      kind = "noop"; headline = `NOTHING TO COMMIT · ${incomplete} incomplete, ${empty} empty`;
      detail = "No templates passed validation. Each needs Kind + Title (≥4 chars) + Context (≥20 chars) + a rendered PNG. Fill the Context fields and retry.";
    }
  } else if (claimedFromMedia && mediaTemplatesWritten && pdfRenderFails === 0 && mediaClaimed > 0) {
    // Visuals CLAIM phase succeeded: PNGs rendered + markdown templates staged.
    // This is a two-phase flow — claim now, fill templates, then --commit.
    kind = "success"; headline = `STAGED · ${mediaClaimed} page(s) rendered`;
    detail = "PNGs + context templates written to ~/.pursue-helper/media-staging/. Open each p<NNN>.png next to its p<NNN>.md, fill in Title/Context, then run the commit phase.";
  } else if (claimedFromMedia && pdfRenderFails > 0 && mediaClaimed > pdfRenderFails) {
    // Partial: some pages rendered, some failed.
    kind = "success"; headline = `STAGED · ${mediaClaimed - pdfRenderFails}/${mediaClaimed} page(s)`;
    detail = `${pdfRenderFails} page(s) failed to render but ${mediaClaimed - pdfRenderFails} staged OK. Fill the templates that have a PNG, then run the commit phase.`;
  } else if (claimedFromMedia && pdfRenderFails > 0 && okCount === 0) {
    // All renders failed — surface the cause.
    kind = "noop"; headline = `RENDER FAILED · ${pdfRenderFails} page(s)`;
    detail = "pdfjs couldn't render these pages. If this persists after the Path2D fix, the source PDF may be genuinely corrupt — check the log.";
  } else if (econnRefused) {
    kind = "error"; headline = "MCP DAEMON OFFLINE · port 9223";
    detail = "The OCR daemon at http://127.0.0.1:9223 isn't running, so the volunteer can't do vision work. Start it with: cd pursue-vision-mcp && npm start";
  } else if (cdpTimeout) {
    kind = "error"; headline = "CHROME / CDP NOT REACHABLE";
    detail = "The daemon is up but can't connect to Chrome on port 9222. Start Chrome with: chrome --remote-debugging-port=9222 (and log in to chatgpt.com in that browser session).";
  } else if (tokenError) {
    kind = "error"; headline = "TOKEN MISMATCH";
    detail = "The daemon rejected the volunteer's auth token. Restart both the daemon and monitor so they pick up the same ~/.pursue-vision-token value.";
  } else if (errCount > 0 && okCount === 0) {
    kind = "error"; headline = `FAILED · ${errCount} error(s)`;
    detail = (allLines.slice(-6).find(l => /✗|error|Error|FAIL/.test(l)) || allLines.at(-1) || "see log for details").slice(0, 240);
  } else if (exitCode !== 0 && exitCode !== 2) {
    kind = "error"; headline = `FAILED · exit ${exitCode}`;
    detail = (allLines.slice(-3).find(l => /error|Error|FAIL/.test(l)) || allLines.at(-1) || "see log for details").slice(0, 200);
  } else if (okCount > 0) {
    kind = "success"; headline = `DONE · ${okCount} ok, ${errCount} err`;
    detail = "Output written to contributions/. " + (noCommit ? "Nothing new to push — already submitted via an open PR." : "Ready to open a PR (run with --pr to push).");
  } else if (skipCount > 0 && noCommit) {
    kind = "noop"; headline = `NO NEW WORK · ${skipCount} pages already submitted`;
    detail = "Every page in this queue is already in one of your open PRs. Merge those PRs and wait for the server to refresh work-available.json, or try a different queue.";
  } else if (noCommit) {
    kind = "noop"; headline = "NO NEW WORK";
    detail = "Volunteer found nothing to do. Queue may be empty or stale.";
  } else {
    kind = "noop"; headline = "RUN COMPLETE";
    detail = "No pages processed. See log for details.";
  }
  return { kind, headline, detail, okCount, errCount, skipCount, noCommit, queueGen, exitCode };
}

// Clean truly-empty stub .txt files for a handle's contributions. The volunteer
// writes "" on failure, which then looks like "already submitted" to the next
// run. WE DO NOT use a size threshold: pages can legitimately OCR to very
// short text (e.g. "BOTTOM VIEW" = 11 bytes for an image page). A previous
// 50-byte threshold caused real outputs to be wiped between runs, making the
// auto-picker re-pick the same page forever. Now only wipe when content is
// empty or whitespace-only.
async function autoCleanStubs(handle) {
  if (!handle) return 0;
  const dirs = ["gpt-vision", "gpt-vision-review"];
  let removed = 0;
  for (const d of dirs) {
    const root = path.resolve(SCRIPTS_ROOT, "contributions", handle, d);
    if (!existsSync(root)) continue;
    const eids = await readdir(root).catch(() => []);
    for (const eid of eids) {
      const docDir = path.join(root, eid);
      let entries;
      try { entries = await readdir(docDir); } catch { continue; }
      for (const f of entries) {
        if (!/^p\d+\.txt$/.test(f)) continue;
        const fp = path.join(docDir, f);
        try {
          const sz = statSync(fp).size;
          if (sz === 0) {
            await rm(fp);
            const jp = fp.replace(/\.txt$/, ".json");
            if (existsSync(jp)) { try { await rm(jp); } catch {} }
            removed++;
            continue;
          }
          // For small files, verify the content is just whitespace before deleting.
          if (sz < 8) {
            const content = await readFile(fp, "utf8");
            if (!content.trim()) {
              await rm(fp);
              const jp = fp.replace(/\.txt$/, ".json");
              if (existsSync(jp)) { try { await rm(jp); } catch {} }
              removed++;
            }
          }
        } catch {}
      }
    }
  }
  return removed;
}

// When a run ends, volunteer.mjs stops POSTing progress but the last state it
// pushed (now=<page>, idle=false, slice=…) sticks in progress.json, so the
// dashboard's focal "NOW PROCESSING" panel never resets. Clear it back to idle
// and persist so the UI returns to a ready state the moment the run finishes.
function resetProgressIdle() {
  state.now = null;
  state.idle = true;
  state.onBreak = null;
  state.slice = { done: 0, total: 0 };
  state.updatedAt = Date.now();
  persistState();
}

async function spawnVolunteer(opts) {
  if (runningProc) throw new Error("a volunteer run is already in progress — stop it first");
  const { args } = buildVolunteerArgs(opts);
  console.log(`[monitor] spawn: node ${args.join(" ")}`);
  const cleaned = await autoCleanStubs(opts.handle || state.handle);
  if (cleaned > 0) console.log(`[monitor] auto-cleaned ${cleaned} stub file(s) before spawn`);
  // Probe both possible daemon-token files to find which one the live daemon
  // on :9223 actually accepts. The user may be running either pursue-vision-mcp
  // (uses ~/.pursue-vision-token) or whipgen (uses ~/.whipgen-token) — passing
  // the wrong one yields HTTP 401.
  const probeEnv = await pickDaemonTokenEnv();
  const proc = spawn(process.execPath, args, {
    cwd: SCRIPTS_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...probeEnv },
  });
  runningProc  = proc;
  runningMeta  = { mode: opts.mode, eid: opts.eid || null, slice: opts.slice, loop: !!opts.loop, startedAt: Date.now() };
  lastRun = null;

  // Reflect "running" in /progress immediately. volunteer-media.mjs (visuals
  // mode) never POSTs progress, so without this /progress keeps idle=true while
  // /running says running=true — a contradiction that makes the dashboard look
  // like it's flipping state. OCR/review overwrite this via POST /progress.
  state.idle = false;
  state.now = { phase: opts.mode === "visuals" ? "CLAIMING VISUAL CONTEXT" : String(opts.mode || "").toUpperCase(), eid: opts.eid || null };
  state.updatedAt = Date.now();
  persistState();

  const lines = [];
  const onLine = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      lines.push(line);
      if (lines.length > 200) lines.shift();
      state.runnerLog = lines.slice(-40);
    }
  };
  proc.stdout.on("data", onLine);
  proc.stderr.on("data", onLine);

  proc.on("exit", async (code) => {
    lines.push(`[exit ${code}]`);
    state.runnerLog = lines.slice(-40);
    const startedMeta = runningMeta;
    const loop = startedMeta?.loop;
    lastRun = {
      ...summarizeLog(lines, code),
      mode: startedMeta?.mode || null,
      eid: startedMeta?.eid || null,
      finishedAt: Date.now(),
      durationSec: Math.round((Date.now() - (startedMeta?.startedAt || Date.now())) / 1000),
    };
    runningProc = null;
    runningMeta = null;
    resetProgressIdle();   // clear the focal "NOW PROCESSING" display
    // Loop mode: requeue only if there was actually some work done OR pages failed.
    // If the run was a pure no-op (kind=="noop"), looping just spams empty runs at the queue —
    // stop and let the user pick a different queue or wait for fresh work.
    //
    // Visuals = the CLAIM phase: it only stages templates that then need a
    // separate (manual) commit. Auto-relooping it re-claims the same "fresh"
    // pages every few seconds (staged pages aren't marked submitted), causing
    // unbounded staging growth and the constant running↔idle flipping in the
    // UI. Only OCR/review/doc — which submit their own work — may loop.
    if (loop && !String(startedMeta?.mode || "").startsWith("visuals") && code !== null && code !== 1 && lastRun.kind !== "noop") {
      await new Promise(r => setTimeout(r, 3000));
      try { await spawnVolunteer({ ...opts }); } catch {}
    }
  });
  proc.on("error", (e) => {
    lastRun = { kind: "error", headline: "SPAWN ERROR", detail: e.message, exitCode: -1, finishedAt: Date.now() };
    runningProc = null; runningMeta = null;
    resetProgressIdle();
  });
}

// Probe the daemon with each known token file. Returns an env block to spawn
// volunteer with — the env var the volunteer's loadToken() will use first.
// Cached so we don't re-probe on every spawn.
let _cachedDaemonAuth = null;
async function pickDaemonTokenEnv() {
  if (_cachedDaemonAuth && Date.now() - _cachedDaemonAuth.ts < 60_000) return _cachedDaemonAuth.env;
  const port = state.daemonPort || 9223;
  const candidates = [
    { envKey: "PURSUE_VISION_TOKEN", path: path.join(os.homedir(), ".pursue-vision-token") },
    { envKey: "WHIPGEN_TOKEN",       path: path.join(os.homedir(), ".whipgen-token") },
  ];
  for (const c of candidates) {
    let token;
    try { token = (await readFile(c.path, "utf8")).trim(); } catch { continue; }
    if (!token) continue;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 2000);
      // /chat-with-files actually checks auth (vs /status which is open).
      // Empty body returns 400 (auth ok, validation fail) — the signal we want.
      // 401 means wrong token.
      const r = await fetch(`http://127.0.0.1:${port}/chat-with-files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
        signal: ac.signal,
      });
      clearTimeout(t);
      if (r.status !== 401) {
        const env = { [c.envKey]: token };
        _cachedDaemonAuth = { env, ts: Date.now(), source: c.envKey };
        console.log(`[monitor] daemon auth: using ${c.envKey} (${c.path})`);
        return env;
      }
    } catch {}
  }
  // No token worked — return empty env and let volunteer fall back to its file scan.
  console.log("[monitor] daemon auth: no token matched, volunteer will fall back");
  _cachedDaemonAuth = { env: {}, ts: Date.now(), source: "none" };
  return {};
}

async function daemonAlive() {
  const port = state.daemonPort || 9223;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

const REMOTE_QUEUE_URL = "https://rizzleroc.github.io/pursue-console/work-available.json";
const LOCAL_QUEUE_PATH = path.resolve(SCRIPTS_ROOT, "public/work-available.json");
async function fetchQueue() {
  // Prefer the local file (freshly built by build-work-available.mjs) over the
  // remote GitHub Pages copy, which can lag behind by hours/days.
  if (existsSync(LOCAL_QUEUE_PATH)) {
    return JSON.parse(await readFile(LOCAL_QUEUE_PATH, "utf8"));
  }
  const r = await fetch(REMOTE_QUEUE_URL + "?t=" + Date.now());
  if (!r.ok) throw new Error("queue fetch failed: " + r.status);
  return await r.json();
}

// Treat a contribution as "missing" (i.e., needs work) when the file doesn't
// exist OR is 0 bytes. Small-but-non-empty results are LEGITIMATE OCR output
// (some pages OCR to just a few words like "BOTTOM VIEW") and must NOT be
// re-claimed — doing so causes the auto-picker to loop on the same page.
function isStub(p) {
  try {
    return statSync(p).size === 0;
  } catch { return true; } // missing → needs work
}

// ----- published-state probe (the "real backend" check) -----
// With many concurrent volunteers, local files alone can't tell whether a page
// is actually DONE — someone else may have already published it. There's no
// coordination server by design (this is a fork + PR project), so origin/main
// IS the backend: any contribution file merged there means that (queue, eid,
// page) is done, no matter which handle did it. We refresh origin/main and
// cache the result ~60s. Fully graceful: if git/network is unavailable the set
// is empty and we fall back to the old local-only dedup.
let _publishedCache = null;
// Map a queue's local working dir to the published contributions dir on main.
const PUBLISHED_DIR = { "gpt-vision": "gpt-vision", "gpt-vision-review": "gpt-vision-review", "media-staging": "media", "media": "media" };
async function fetchPublishedSet() {
  if (_publishedCache && Date.now() - _publishedCache.ts < 60_000) return _publishedCache.set;
  const set = new Set(); // keys: "<dir>|<eid>|<pageNum>"
  try {
    await runCmd("git", ["fetch", "origin", "main", "--quiet"], { cwd: SCRIPTS_ROOT, timeout: 8000 });
    const out = await runCmd("git", ["ls-tree", "-r", "origin/main", "--name-only", "--", "contributions"], { cwd: SCRIPTS_ROOT, timeout: 8000 });
    for (const line of out.split(/\r?\n/)) {
      // contributions/<handle>/<dir>/<eid>/p<NNN>.<ext>
      const m = line.match(/^contributions\/[^/]+\/([^/]+)\/(.+)\/p0*(\d+)\.[a-z0-9]+$/i);
      if (m) set.add(`${m[1]}|${m[2]}|${Number(m[3])}`);
    }
  } catch { /* offline / no git — fall back to local-only dedup */ }
  _publishedCache = { ts: Date.now(), set };
  return set;
}

// Walk `contributions/<handle>/<dir>/<eid>/p####.txt` and find docs that
// still have at least one un-submitted page. Returns { totalFresh, freshDocs }.
// A page is "fresh" only if it is BOTH a local stub AND not already published
// to origin/main by anyone — so concurrent volunteers don't redo merged work.
async function findFreshWork(handle, dir, byEvent, field) {
  const base = path.resolve(SCRIPTS_ROOT, "contributions", handle, dir);
  const published = await fetchPublishedSet();
  const pubDir = PUBLISHED_DIR[dir] || dir;
  let totalFresh = 0;
  const freshDocs = [];
  for (const [eid, doc] of Object.entries(byEvent)) {
    const pages = doc[field] || [];
    if (!pages.length) continue;
    // For visuals the queue items are objects {page,kind,...}; OCR/review are bare numbers.
    const missing = pages.filter(p => {
      const num = typeof p === "object" ? p.page : p;
      // Already merged to main (by any volunteer) → done, skip.
      if (published.has(`${pubDir}|${eid}|${Number(num)}`)) return false;
      return isStub(path.join(base, eid, `p${String(num).padStart(4,"0")}.txt`));
    });
    if (missing.length) {
      freshDocs.push({ eid, freshPages: missing });
      totalFresh += missing.length;
    }
  }
  return { totalFresh, freshDocs };
}

// ----- run external command, return stdout (rejects on non-zero exit) -----
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", ...opts });
    let out = "", err = "";
    p.stdout.on("data", c => { out += c; });
    p.stderr.on("data", c => { err += c; });
    p.on("error", reject);
    p.on("exit", code => code === 0 ? resolve(out) : reject(new Error((err || out || "exit " + code).trim())));
  });
}

// ----- jail helper (shared idea with daemon, kept lightweight here) -----
const ALLOWED_ROOTS = [os.homedir(), process.cwd(), HELPER_DIR].map(p => path.resolve(p));
function jailPath(p) {
  const abs = path.resolve(p);
  if (!ALLOWED_ROOTS.some(root => abs === root || abs.startsWith(root + path.sep))) {
    throw new Error("path outside allowed roots");
  }
  if (!existsSync(abs)) throw new Error("not found");
  return abs;
}

// ----- HTTP server -----
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => { buf += c; if (buf.length > 1024 * 1024) reject(new Error("body too large")); });
    req.on("end", () => { try { resolve(JSON.parse(buf || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return sendJson(res, 200, { ok: true });

    if (req.method === "GET" && (req.url === "/" || req.url === "/dashboard")) {
      try {
        const html = await readFile(DASHBOARD_HTML, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(html);
      } catch { return sendJson(res, 500, { error: "dashboard.html missing" }); }
    }
    if (req.method === "GET" && req.url === "/progress") return sendJson(res, 200, state);

    if (req.method === "GET" && req.url.startsWith("/preview/")) {
      const b64 = req.url.slice("/preview/".length).split("?")[0];
      let p;
      try { p = jailPath(Buffer.from(b64, "base64url").toString("utf8")); }
      catch { return sendJson(res, 403, { error: "bad preview path" }); }
      if (!/\.(png|jpe?g|webp|gif)$/i.test(p)) return sendJson(res, 400, { error: "preview must be an image" });
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      return createReadStream(p).pipe(res);
    }

    if (req.method === "POST" && req.url === "/progress") {
      if (TOKEN) {
        const h = req.headers["authorization"] || "";
        const m = h.match(/^Bearer\s+(.+)$/i);
        if (!m || m[1].trim() !== TOKEN) return sendJson(res, 401, { error: "monitor token mismatch" });
      }
      const body = await readBody(req);
      state = { ...state, ...body, updatedAt: Date.now() };
      if (Array.isArray(state.recent)) state.recent = state.recent.slice(-6);
      persistState();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && req.url === "/running") {
      return sendJson(res, 200, {
        running: !!runningProc,
        meta: runningMeta,
        log: state.runnerLog || [],
        lastRun,
      });
    }

    if (req.method === "POST" && req.url === "/run") {
      const body = await readBody(req);
      if (!["ocr", "review", "visuals", "visuals-commit", "doc"].includes(body.mode)) {
        return sendJson(res, 400, { error: "mode must be ocr | review | visuals | visuals-commit | doc" });
      }
      if (body.mode === "doc" && !body.eid) {
        return sendJson(res, 400, { error: "eid required for doc mode" });
      }
      // Everything that does vision work needs the daemon. visuals-commit only
      // validates already-staged templates locally, so it doesn't.
      if (body.mode !== "visuals-commit") {
        const alive = await daemonAlive();
        if (!alive) return sendJson(res, 503, {
          error: "MCP daemon at http://127.0.0.1:9223 is offline. Start it: cd pursue-vision-mcp && npm start",
        });
      }
      try {
        await spawnVolunteer(body);
        return sendJson(res, 200, { ok: true, meta: runningMeta });
      } catch (e) {
        return sendJson(res, 409, { error: e.message });
      }
    }

    if (req.method === "POST" && req.url === "/stop") {
      if (!runningProc) return sendJson(res, 200, { ok: true, note: "nothing running" });
      runningMeta = null;  // clear loop flag so exit handler doesn't restart
      runningProc.kill("SIGTERM");
      return sendJson(res, 200, { ok: true });
    }

    // Daemon health check — surfaced on /health so the dashboard can warn.
    if (req.method === "GET" && req.url === "/daemon-health") {
      const alive = await daemonAlive();
      return sendJson(res, 200, { alive, port: state.daemonPort });
    }

    // Visuals staging state — so the COMMIT VISUALS button reflects reality
    // instead of always looking "ready". `committable` = filled templates that
    // would actually produce a contribution (Title ≥4, Context ≥20, image
    // present); `incomplete` = staged but not yet drafted/filled. When
    // committable is 0 the dashboard disables the commit button.
    if (req.method === "GET" && req.url === "/staging") {
      const handle = state.handle || "Rizzleroc";
      const base = path.join(HELPER_DIR, "media-staging", handle);
      const sectionText = (t, name) => {
        const m = t.match(new RegExp(`^#\\s+${name}\\s*$`, "m"));
        if (!m) return "";
        const rest = t.slice(m.index + m[0].length);
        const nx = rest.search(/^#\s+/m);
        return (nx >= 0 ? rest.slice(0, nx) : rest).replace(/<!--[\s\S]*?-->/g, "").trim();
      };
      let total = 0, committable = 0;
      try {
        for (const eid of await readdir(base)) {
          let files; try { files = await readdir(path.join(base, eid)); } catch { continue; }
          for (const f of files) {
            if (!/^p\d+\.md$/i.test(f)) continue;
            total++;
            try {
              const t = await readFile(path.join(base, eid, f), "utf8");
              const img = existsSync(path.join(base, eid, f.replace(/\.md$/i, ".png")))
                       || existsSync(path.join(base, eid, f.replace(/\.md$/i, ".jpg")));
              if (img && sectionText(t, "Title").length >= 4 && sectionText(t, "Context").length >= 20) committable++;
            } catch {}
          }
        }
      } catch { /* no staging dir yet */ }
      return sendJson(res, 200, { total, committable, incomplete: total - committable });
    }

    // Delete TRULY-empty stub contributions (0-byte / whitespace-only) so
    // retries can happen. Failed runs leave behind empty placeholder files that
    // fool the "already submitted" check. Short-but-real OCR (e.g. "BOTTOM
    // VIEW", 11 bytes) is legitimate output and is KEPT — matches isStub().
    if (req.method === "POST" && req.url === "/clean-stubs") {
      const body = await readBody(req).catch(() => ({}));
      const handle = body.handle || state.handle || "Rizzleroc";
      const dirs = ["gpt-vision", "gpt-vision-review"];
      let removed = 0;
      const samples = [];
      for (const d of dirs) {
        const root = path.resolve(SCRIPTS_ROOT, "contributions", handle, d);
        if (!existsSync(root)) continue;
        const eids = await readdir(root).catch(() => []);
        for (const eid of eids) {
          const docDir = path.join(root, eid);
          let entries;
          try { entries = await readdir(docDir); } catch { continue; }
          for (const f of entries) {
            if (!/^p\d+\.txt$/.test(f)) continue;
            const fp = path.join(docDir, f);
            try {
              const s = statSync(fp);
              // Only TRULY-empty (0-byte or whitespace-only). Keep short-but-real
              // OCR so we don't re-claim a page that's actually done.
              const empty = s.size === 0 || !(await readFile(fp, "utf8")).trim();
              if (empty) {
                await rm(fp);
                const jp = fp.replace(/\.txt$/, ".json");
                if (existsSync(jp)) { try { await rm(jp); } catch {} }
                removed++;
                if (samples.length < 8) samples.push(`${d}/${eid}/${f} (${s.size}B)`);
              }
            } catch {}
          }
        }
      }
      return sendJson(res, 200, { ok: true, removed, samples });
    }

    // Auto-pick a queue with fresh work. Body: { handle, slice?, loop? }.
    // Walks OCR → REVIEW → VISUALS, checking each against locally-submitted
    // files so we don't immediately re-no-op. Returns 409 if everything's
    // already in flight via open PRs.
    if (req.method === "POST" && req.url === "/run-any") {
      const body = await readBody(req);
      if (!body.handle) return sendJson(res, 400, { error: "handle required" });
      try {
        const queue = await fetchQueue();
        const handle = body.handle;
        const candidates = [
          { mode: "ocr",     dir: "gpt-vision",          field: "queue",                  count: queue.totalPagesNeeded },
          { mode: "review",  dir: "gpt-vision-review",   field: "reviewQueue",            count: queue.totalPagesNeedingReview },
          { mode: "visuals", dir: "media-staging",       field: "visualsNeedingContext",  count: queue.totalPagesNeedingVisualContext },
        ];
        let picked = null;
        for (const c of candidates) {
          if (!c.count) continue;
          const { totalFresh, freshDocs } = await findFreshWork(handle, c.dir, queue.byEvent || {}, c.field);
          if (totalFresh > 0) { picked = { ...c, totalFresh, freshDocs }; break; }
        }
        if (!picked) {
          return sendJson(res, 409, {
            error: "every page in every queue is already submitted locally — merge your open PRs or wait for the server to refresh work-available.json",
            queueCounts: { ocr: queue.totalPagesNeeded, review: queue.totalPagesNeedingReview, visuals: queue.totalPagesNeedingVisualContext },
          });
        }
        if (picked.mode !== "visuals" && !(await daemonAlive())) {
          return sendJson(res, 503, {
            error: `picked ${picked.mode} but MCP daemon at http://127.0.0.1:9223 is offline. Start it: cd pursue-vision-mcp && npm start`,
            picked: picked.mode,
          });
        }
        // Pin to the FIRST doc with fresh pages so the volunteer's slice doesn't
        // get burned on already-done docs earlier in the queue.
        const targetDoc = picked.freshDocs[0];
        // The volunteer takes pages in queue order then skips already-submitted ones.
        // If queue=[1,6] and only p6 is fresh, slice=1 means it only claims p1 (done)
        // and exits with nothing to do. We size the slice so the queue window includes
        // the position of the Nth desired fresh page (N = body.slice || 1).
        const wantedFreshCount = body.slice || 1;
        const docEntry = queue.byEvent[targetDoc.eid] || {};
        const docQueue = picked.mode === "review"
          ? (docEntry.reviewQueue || [])
          : picked.mode === "visuals"
            ? (docEntry.visualsNeedingContext || []).map(v => v.page || v)
            : (docEntry.queue || []);
        const freshPageNums = targetDoc.freshPages.map(p => typeof p === "object" ? p.page : p);
        // Find the index of the Nth fresh page in the doc's full queue.
        let lastNeededIndex = -1;
        let freshSeen = 0;
        for (let i = 0; i < docQueue.length; i++) {
          if (freshPageNums.includes(docQueue[i])) {
            freshSeen++;
            if (freshSeen >= wantedFreshCount) { lastNeededIndex = i; break; }
          }
        }
        const effectiveSlice = lastNeededIndex >= 0 ? lastNeededIndex + 1 : docQueue.length;
        const runOpts = {
          mode: picked.mode,
          slice: effectiveSlice,
          loop: !!body.loop,
          handle,
          provider: body.provider,
        };
        if (picked.mode !== "visuals") runOpts.eid = targetDoc.eid;
        await spawnVolunteer(runOpts);
        return sendJson(res, 200, {
          ok: true, picked: picked.mode,
          eid: runOpts.eid || null,
          freshPages: picked.totalFresh,
          targetPages: targetDoc.freshPages,
          meta: runningMeta,
        });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // Published-state check — the "real backend". Reports what's actually
    // merged to origin/main (by whom, by kind), so the dashboard reflects
    // published truth instead of local guesses. Read-only.
    if (req.method === "GET" && req.url === "/published") {
      try {
        await fetchPublishedSet(); // refresh + cache origin/main (graceful if offline)
        const out = await runCmd("git", ["ls-tree", "-r", "origin/main", "--name-only", "--", "contributions"], { cwd: SCRIPTS_ROOT, timeout: 8000 });
        const byHandle = {}, byKind = {}; let total = 0;
        for (const line of out.split(/\r?\n/)) {
          // count one per page via the canonical .json sidecar
          const m = line.match(/^contributions\/([^/]+)\/([^/]+)\/.+\/p0*\d+\.json$/i);
          if (!m) continue;
          total++;
          byHandle[m[1]] = (byHandle[m[1]] || 0) + 1;
          byKind[m[2]] = (byKind[m[2]] || 0) + 1;
        }
        return sendJson(res, 200, { total, byHandle, byKind, ref: "origin/main", checkedAt: Date.now() });
      } catch (e) {
        return sendJson(res, 503, { error: "published probe failed: " + e.message });
      }
    }

    // List the user's open PRs against the public corpus repo. Uses local gh.
    if (req.method === "GET" && req.url === "/prs") {
      try {
        const out = await runCmd("gh", [
          "pr", "list",
          "--repo", "rizzleroc/pursue-console",
          "--state", "open",
          "--author", "@me",
          "--json", "number,title,headRefName,mergeable,statusCheckRollup,url,createdAt",
          "--limit", "20",
        ]);
        const prs = JSON.parse(out || "[]").map(p => ({
          number: p.number,
          title: p.title,
          url: p.url,
          headRef: p.headRefName,
          mergeable: p.mergeable,
          createdAt: p.createdAt,
          checks: (p.statusCheckRollup || []).map(c => ({
            name: c.name || c.context || "?",
            conclusion: c.conclusion || c.state || null,
            status: c.status || null,
          })),
        }));
        return sendJson(res, 200, { prs });
      } catch (e) {
        return sendJson(res, 500, { error: "gh failed: " + e.message });
      }
    }

    // Merge a specific PR by number. Body: { number, method?: "squash"|"merge"|"rebase" }
    if (req.method === "POST" && req.url === "/merge") {
      const body = await readBody(req);
      const num = Number(body.number);
      if (!num) return sendJson(res, 400, { error: "number required" });
      const method = body.method === "merge" ? "--merge" : body.method === "rebase" ? "--rebase" : "--squash";
      try {
        const out = await runCmd("gh", [
          "pr", "merge", String(num),
          "--repo", "rizzleroc/pursue-console",
          method,
          "--delete-branch",
        ]);
        return sendJson(res, 200, { ok: true, output: out });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log("");
  console.log("╭───────────────────────────────────────────────────────────╮");
  console.log("│  PURSUE MONITOR (separate from MCP daemon)               │");
  console.log("│  " + url.padEnd(57) + "│");
  console.log("│  state file: " + STATE_PATH.slice(-43).padStart(43) + "│");
  console.log("╰───────────────────────────────────────────────────────────╯");
  if (NO_OPEN) return;
  const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
              : process.platform === "darwin" ? ["open", [url]]
              :                                  ["xdg-open", [url]];
  try {
    const c = spawn(opener[0], opener[1], { stdio: "ignore", detached: true });
    c.on("error", () => {});
    c.unref();
  } catch {}
});
