// Download DVIDS videos for the video-only events, transcribe via OpenAI
// Whisper (CLI). Output per-event transcript .txt files into public/text/.
// The actual video itself stays out of the repo (large) — only the transcript
// is committed.
//
// @unverified — the DVIDS download path has been rewritten to go through
// the pursue-vision-mcp daemon (in-page Playwright fetch) because yt-dlp
// returns ConnectionResetError(10054) from dvidshub.net (TLS-fingerprint
// block, same flavor as war.gov's Akamai filter). The Whisper path is
// unchanged. Live test is the maintainer's real Chrome.
//
// Most release-01 videos are short IR clips with little/no audio; we still
// run them through Whisper because some carry operator radio chatter. Where
// Whisper returns silence we emit a "[no audible audio]" placeholder so the
// event still has a doc record.
//
// Usage:
//   node scripts/transcribe-videos.mjs [options]
//
// Options:
//     --daemon=http://127.0.0.1:9223       pursue-vision-mcp daemon URL
//     --token-file=~/.pursue-vision-token  bearer-token file
//     --analyze=gemini|none                if 'gemini', ALSO send each video to
//                                          /chat-with-files (gemini) and write
//                                          <eid>.gemini-analysis.md alongside
//                                          the Whisper transcript. Default 'none'
//                                          for backwards compat.
//     --dry-run                            plan only; download / transcribe nothing
//
// Env honored:
//     WHISPER_MODEL=base.en   model passed to whisper CLI
//     ANALYZE_VIDEO=gemini    equivalent to --analyze=gemini
//     PURSUE_VISION_TOKEN     overrides --token-file

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VIDEO_DIR = path.join(ROOT, "data-raw/videos");
const OUT_DIR = path.join(ROOT, "public/text");
const MODEL = process.env.WHISPER_MODEL || "base.en";

// ----- args -----
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const DAEMON = args.daemon || "http://127.0.0.1:9223";
const TOKEN_FILE = (args["token-file"] || "~/.pursue-vision-token").replace(/^~/, os.homedir());
const ANALYZE = (args.analyze || process.env.ANALYZE_VIDEO || "none").toLowerCase();
const DRY = !!args["dry-run"];
if (!["none", "gemini"].includes(ANALYZE)) {
  console.error(`error: --analyze must be 'gemini' or 'none' (got '${ANALYZE}')`);
  process.exit(1);
}

// loadToken mirrors scripts/volunteer.mjs — env wins, else whipgen-token,
// else pursue-vision-token. Avoids prompting the volunteer to manage two
// files when they already have the primary MCP running.
async function loadToken() {
  if (process.env.PURSUE_VISION_TOKEN) return process.env.PURSUE_VISION_TOKEN;
  if (process.env.WHIPGEN_TOKEN) return process.env.WHIPGEN_TOKEN;
  for (const p of [path.join(os.homedir(), ".whipgen-token"), TOKEN_FILE]) {
    try { return (await readFile(p, "utf8")).trim(); } catch {}
  }
  console.error(`error: no token. Start the daemon first (it writes ${TOKEN_FILE}), or set PURSUE_VISION_TOKEN`);
  process.exit(1);
}
const TOKEN = await loadToken();

const { EVENTS } = await import("../src/data/events.js");
await mkdir(VIDEO_DIR, { recursive: true });
await mkdir(OUT_DIR, { recursive: true });

const targets = EVENTS.filter(e => e.videoId && !e.url);  // video-only records
console.log(`[transcribe] ${targets.length} video-only events:`, targets.map(t => t.id).join(", "));
console.log(`[transcribe] daemon=${DAEMON}  analyze=${ANALYZE}${DRY ? "  (DRY-RUN)" : ""}`);

// POST helper — long timeout because the daemon serializes downloads
// behind the dvids queue, and individual clips can be a couple hundred
// MB pushed through 8 MB Range chunks.
async function daemonPost(pathname, body, timeoutMs) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${DAEMON}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`daemon HTTP ${r.status}: ${txt.slice(0, 200)}`);
    }
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

for (const ev of targets) {
  const stem = path.join(VIDEO_DIR, ev.id);
  let videoPath = ["mp4","mov","webm"].map(x => `${stem}.${x}`).find(p => existsSync(p));
  if (!videoPath) {
    if (DRY) { console.log(`  · ${ev.id} would download via MCP (DVIDS ${ev.videoId})`); continue; }
    console.log(`\n↓ downloading ${ev.id} (DVIDS ${ev.videoId}) via MCP…`);
    const destPath = `${stem}.mp4`;
    try {
      const j = await daemonPost("/dvids/download", {
        videos: [{ videoId: ev.videoId, destPath }],
      }, 15 * 60_000);
      const r = (j.results || []).find(x => String(x.videoId) === String(ev.videoId));
      if (!r) throw new Error(`no result row for videoId=${ev.videoId} in daemon response`);
      if (!r.ok) throw new Error(r.error || "unknown download error");
      console.log(`  ✓ downloaded ${r.bytes ?? "?"} bytes from ${r.mp4Url?.slice(0, 80) || "(no url)"}`);
      videoPath = existsSync(destPath) ? destPath
        : ["mp4","mov","webm"].map(x => `${stem}.${x}`).find(p => existsSync(p));
    } catch (e) {
      console.log(`  ✗ MCP download failed: ${e.message.slice(0,200)}`);
      continue;
    }
  }
  if (!videoPath) { console.log(`  ✗ no video on disk for ${ev.id}`); continue; }

  if (DRY) { console.log(`  · ${ev.id} would transcribe ${videoPath}`); continue; }

  // ffprobe duration
  let dur = "?";
  try {
    const { stdout } = await exec("ffprobe", ["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1", videoPath], { windowsHide: true });
    dur = Number(stdout.trim()).toFixed(1) + "s";
  } catch {}

  // Whisper transcribe — unchanged default path
  const outDir = path.join(VIDEO_DIR, `${ev.id}-whisper`);
  await mkdir(outDir, { recursive: true });
  console.log(`\n→ ${ev.id}  (${dur})  transcribing with whisper ${MODEL}…`);
  try {
    await exec("whisper", [
      videoPath, "--model", MODEL, "--language", "en",
      "--output_dir", outDir, "--output_format", "txt",
      "--fp16", "False", "--verbose", "False",
    ], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    console.log(`  ✗ whisper failed: ${e.message.slice(0,200)}`);
    continue;
  }
  const txtName = path.basename(videoPath).replace(/\.(mp4|mov|webm)$/i, ".txt");
  const txtPath = path.join(outDir, txtName);
  let raw = "";
  try { raw = (await readFile(txtPath, "utf8")).trim(); } catch {}

  const meaningful = raw.replace(/\[.*?\]/g, "").replace(/\s+/g, " ").trim();
  if (meaningful.length < 12) raw = "[no audible audio in this clip — IR footage]";

  const header = `${ev.title}\n${"=".repeat(ev.title.length)}\n\nAgency: ${ev.agency}\nDate: ${ev.date}\nLocation: ${ev.loc}\nType: ${ev.type}\nSource extraction: WHISPER (${MODEL}) · DVIDS ${ev.videoId} · ${dur}\n\n---\n\n=== Transcript ===\n\n`;
  await writeFile(path.join(OUT_DIR, `${ev.id}.txt`), header + raw, "utf8");
  console.log(`  ✓ ${ev.id} — ${raw.length} chars transcribed`);

  // Optional Gemini multimodal analysis. Best-effort: a failure here
  // never blocks the canonical Whisper transcript above. Output sits
  // alongside the .txt as a sibling .gemini-analysis.md so existing
  // import logic (which scans for .txt files) is unaffected.
  if (ANALYZE === "gemini") {
    const analysisPath = path.join(OUT_DIR, `${ev.id}.gemini-analysis.md`);
    if (existsSync(analysisPath)) {
      console.log(`  ⊖ ${ev.id} gemini analysis already present, skipping`);
    } else {
      const prompt =
        "This is a declassified public DVIDS video clip. Please:\n" +
        "1. Transcribe any audible audio verbatim, with rough timestamps in [MM:SS] form.\n" +
        "2. Describe each visual segment in 1–3 sentences, also with [MM:SS] timestamps, " +
        "noting camera type/IR mode, on-screen telemetry text, and any annotations.\n" +
        "3. Flag anything UAP-relevant: anomalous flight characteristics, " +
        "unusual heat signatures, operator radio chatter about an unknown object, " +
        "or visible craft outside known platforms. Use a short '=== UAP NOTES ===' section " +
        "at the end. If nothing UAP-relevant, write '(none)' under that heading.";
      console.log(`  + ${ev.id} requesting Gemini multimodal analysis…`);
      try {
        const j = await daemonPost("/chat-with-files", {
          provider: "gemini",
          filePaths: [videoPath],
          prompt,
          freshChat: true,
          timeoutMs: 600_000,
        }, 11 * 60_000);
        const text = j.text ?? j.result?.text ?? j.output ?? "";
        if (!text) throw new Error("empty response from /chat-with-files");
        const aheader = `# ${ev.title} — Gemini multimodal analysis\n\n` +
          `Source video: DVIDS ${ev.videoId} (${dur})\n` +
          `Agency: ${ev.agency}\nDate: ${ev.date}\nLocation: ${ev.loc}\n\n---\n\n`;
        await writeFile(analysisPath, aheader + text.trim() + "\n", "utf8");
        console.log(`    ✓ wrote ${path.relative(ROOT, analysisPath)} (${text.length} chars)`);
      } catch (e) {
        console.log(`    ⚠ Gemini analysis failed (best-effort, continuing): ${e.message.slice(0,160)}`);
      }
    }
  }
}

if (DRY) { console.log("\n[transcribe] --dry-run set, exiting without manifest update."); process.exit(0); }

// Update manifest
const manifestPath = path.join(OUT_DIR, "manifest.json");
const manifest = JSON.parse(existsSync(manifestPath) ? await readFile(manifestPath, "utf8") : "{}");
for (const ev of targets) {
  const p = path.join(OUT_DIR, `${ev.id}.txt`);
  if (existsSync(p)) {
    const text = await readFile(p, "utf8");
    manifest[ev.id] = { source: "whisper", pages: 1, chars: text.length };
  }
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 0));
console.log(`\n[transcribe] manifest updated.`);
