// Download DVIDS videos for the video-only events, transcribe via OpenAI
// Whisper (CLI). Output per-event transcript .txt files into public/text/.
// The actual video itself stays out of the repo (large) — only the transcript
// is committed.
//
// @unverified — the DVIDS download path now drives the whipgen-mcp daemon
// (the primary MCP at 127.0.0.1:9223) via its /web/eval HTTP endpoint:
// navigate the daemon's browser to the DVIDS page, scrape the embedded
// CloudFront <source type="…mp4"> URL out of the DOM, probe its length via
// a Range request, then pull the file down in 5 MB chunks of inline base64
// and append them to data-raw/videos/<eid>.mp4 from Node. This replaces the
// previous pursue-vision-mcp /dvids/download path, which doesn't work when
// whipgen is primary (pursue-vision-mcp isn't running). The CloudFront-mp4
// path was proven against japan-2023 (DVIDS 1006107) in a prior session;
// the live test is the maintainer's real Chrome on the remaining two videos
// (indopacom-2024 DVIDS 1006106, army-2026 DVIDS 1006111). The Whisper path
// is unchanged. yt-dlp is still not viable here — dvidshub.net returns
// ConnectionResetError(10054), same flavor as war.gov's Akamai filter.
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
//     --daemon=http://127.0.0.1:9223       whipgen-mcp daemon URL
//     --token-file=~/.whipgen-token        bearer-token file
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
//     WHIPGEN_TOKEN           overrides ~/.whipgen-token
//     PURSUE_VISION_TOKEN     fallback (legacy pursue-vision-mcp token)

import { writeFile, mkdir, readFile, appendFile, stat, unlink } from "node:fs/promises";
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
const TOKEN_FILE = (args["token-file"] || "~/.whipgen-token").replace(/^~/, os.homedir());
const ANALYZE = (args.analyze || process.env.ANALYZE_VIDEO || "none").toLowerCase();
const DRY = !!args["dry-run"];
if (!["none", "gemini"].includes(ANALYZE)) {
  console.error(`error: --analyze must be 'gemini' or 'none' (got '${ANALYZE}')`);
  process.exit(1);
}

// Token precedence: env (whipgen) → ~/.whipgen-token → env (legacy pursue-vision)
// → ~/.pursue-vision-token. whipgen is the primary MCP on this machine, but
// keeping the legacy fallbacks means volunteers who only have the old token
// still work without reconfiguring.
async function loadToken() {
  if (process.env.WHIPGEN_TOKEN) return process.env.WHIPGEN_TOKEN;
  try { return (await readFile(TOKEN_FILE, "utf8")).trim(); } catch {}
  if (process.env.PURSUE_VISION_TOKEN) return process.env.PURSUE_VISION_TOKEN;
  try { return (await readFile(path.join(os.homedir(), ".pursue-vision-token"), "utf8")).trim(); } catch {}
  console.error(`error: no token. Start the whipgen daemon first (it writes ${TOKEN_FILE}), or set WHIPGEN_TOKEN`);
  process.exit(1);
}
const TOKEN = await loadToken();

const { EVENTS } = await import("../src/data/events.js");
await mkdir(VIDEO_DIR, { recursive: true });
await mkdir(OUT_DIR, { recursive: true });

const targets = EVENTS.filter(e => e.videoId && !e.url);  // video-only records
console.log(`[transcribe] ${targets.length} video-only events:`, targets.map(t => t.id).join(", "));
console.log(`[transcribe] daemon=${DAEMON}  analyze=${ANALYZE}${DRY ? "  (DRY-RUN)" : ""}`);

// POST helper — JSON body, JSON response, bearer auth, clear errors. Long
// default timeout because /web/eval can take a while when the daemon's
// browser is mid-navigation, and /chat-with-files round-trips a multimodal
// model with the video as an attachment.
async function whipgenPost(daemonUrl, token, pathname, body, timeoutMs = 60_000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${daemonUrl}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`whipgen HTTP ${r.status} on ${pathname}: ${txt.slice(0, 200)}`);
    }
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

// DVIDS download via whipgen /web/eval. Steps (all proven against
// japan-2023 / DVIDS 1006107):
//   1. Navigate the daemon browser to the DVIDS page.
//   2. Scrape <source> elements for the CloudFront mp4 (and HLS fallback).
//   3. Probe size via Range bytes=0-0 (status 206, parse content-range).
//   4. Loop in 5 MB chunks: fetch Range, base64-encode in-page, return.
//   5. Append each chunk to destPath; verify total bytes == probed total.
// We deliberately do NOT use the daemon's saveTo feature — its path-jail
// (WHIPGEN_ALLOWED_WRITE_ROOTS) doesn't include this repo on the maintainer's
// machine. Inline base64 sidesteps the jail entirely.
async function downloadDvidsVideo({ daemonUrl, token, videoId, destPath }) {
  const pageUrl = `https://www.dvidshub.net/video/${videoId}`;

  // 1) navigate
  console.log(`  · navigating daemon browser → ${pageUrl}`);
  await whipgenPost(daemonUrl, token, "/web/eval", {
    url: pageUrl,
    expression: "true",
    returnType: "text",
    timeoutMs: 60_000,
  }, 75_000);

  // 2) scrape <source> for mp4 (CloudFront)
  const scrapeExpr =
    "(() => {" +
    " const out = { mp4: null, hls: null };" +
    " document.querySelectorAll('source').forEach(s => {" +
    "   if (!s.src) return;" +
    "   if ((s.type || '').includes('mp4')) out.mp4 = s.src;" +
    "   if ((s.type || '').includes('mpegURL') || s.src.endsWith('.m3u8')) out.hls = s.src;" +
    " });" +
    " return JSON.stringify(out);" +
    "})()";
  const scrapeResp = await whipgenPost(daemonUrl, token, "/web/eval", {
    expression: scrapeExpr,
    returnType: "text",
    timeoutMs: 30_000,
  }, 45_000);
  let scraped;
  try {
    scraped = JSON.parse(scrapeResp.value ?? "");
  } catch (e) {
    throw new Error(`scrape returned non-JSON: ${String(scrapeResp.value).slice(0, 160)}`);
  }
  if (!scraped.mp4) {
    throw new Error(`no mp4 <source> on ${pageUrl} (hls fallback: ${scraped.hls || "none"})`);
  }
  const mp4Url = scraped.mp4;
  console.log(`  · mp4 ${mp4Url.slice(0, 90)}…`);

  // 3) probe size
  const probeExpr =
    "(async () => {" +
    `  const r = await fetch(${JSON.stringify(mp4Url)}, { headers: { Range: 'bytes=0-0' } });` +
    "  return JSON.stringify({ status: r.status, range: r.headers.get('content-range'), len: r.headers.get('content-length') });" +
    "})()";
  const probeResp = await whipgenPost(daemonUrl, token, "/web/eval", {
    expression: probeExpr,
    returnType: "text",
    timeoutMs: 30_000,
  }, 45_000);
  let probe;
  try { probe = JSON.parse(probeResp.value ?? ""); }
  catch { throw new Error(`probe returned non-JSON: ${String(probeResp.value).slice(0, 160)}`); }
  if (probe.status !== 206) {
    throw new Error(`Range probe expected 206, got ${probe.status} (content-range='${probe.range}')`);
  }
  const m = String(probe.range || "").match(/\/(\d+)$/);
  if (!m) throw new Error(`unparseable content-range '${probe.range}'`);
  const total = Number(m[1]);
  if (!Number.isFinite(total) || total <= 0) throw new Error(`bad total bytes ${total}`);
  console.log(`  · size ${total} bytes (${(total / 1_048_576).toFixed(1)} MB)`);

  // 4-5) chunked download. Start from a clean dest file so partial bytes
  // from a previous failed run can't poison this one.
  if (existsSync(destPath)) await unlink(destPath);
  const CHUNK = 5_242_880; // 5 MB raw → ~6.99 MB base64, fits the 8 MB /web/eval cap
  let written = 0;
  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, total - 1);
    const expr =
      "(async () => {" +
      `  const r = await fetch(${JSON.stringify(mp4Url)}, { headers: { Range: 'bytes=${start}-${end}' } });` +
      "  if (r.status !== 206) throw new Error('http ' + r.status);" +
      "  const buf = await r.arrayBuffer();" +
      "  const u8 = new Uint8Array(buf);" +
      "  let bin = '';" +
      "  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));" +
      "  return btoa(bin);" +
      "})()";
    const chunkResp = await whipgenPost(daemonUrl, token, "/web/eval", {
      expression: expr,
      returnType: "base64",
      timeoutMs: 60_000,
    }, 90_000);
    const b64 = chunkResp.base64 ?? chunkResp.value;
    if (!b64) throw new Error(`empty chunk response at byte ${start}`);
    const bytes = Buffer.from(b64, "base64");
    await appendFile(destPath, bytes);
    written += bytes.length;
    const mbDone = (written / 1_048_576).toFixed(0);
    const mbTotal = (total / 1_048_576).toFixed(0);
    console.log(`  ↓ ${mbDone}/${mbTotal} MB`);
  }

  // verify
  const st = await stat(destPath);
  if (st.size !== total) {
    await unlink(destPath).catch(() => {});
    throw new Error(`download size mismatch: wrote ${st.size}, expected ${total}`);
  }
  return { bytes: st.size, mp4Url };
}

for (const ev of targets) {
  const stem = path.join(VIDEO_DIR, ev.id);
  let videoPath = ["mp4","mov","webm"].map(x => `${stem}.${x}`).find(p => existsSync(p));
  if (!videoPath) {
    if (DRY) { console.log(`  · ${ev.id} would download via whipgen (DVIDS ${ev.videoId})`); continue; }
    console.log(`\n↓ downloading ${ev.id} (DVIDS ${ev.videoId}) via whipgen…`);
    const destPath = `${stem}.mp4`;
    try {
      const r = await downloadDvidsVideo({
        daemonUrl: DAEMON,
        token: TOKEN,
        videoId: ev.videoId,
        destPath,
      });
      console.log(`  ✓ downloaded ${r.bytes} bytes from ${r.mp4Url.slice(0, 80)}`);
      videoPath = destPath;
    } catch (e) {
      console.log(`  ✗ whipgen download failed: ${e.message.slice(0,240)}`);
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
        const j = await whipgenPost(DAEMON, TOKEN, "/chat-with-files", {
          provider: "gemini",
          filePaths: [path.resolve(videoPath)],
          prompt,
          freshChat: true,
          timeoutMs: 900_000,
        }, 16 * 60_000);
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
