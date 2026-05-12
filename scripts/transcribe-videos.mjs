// Download DVIDS videos for the video-only events, transcribe via OpenAI
// Whisper (CLI). Output per-event transcript .txt files into public/text/.
// The actual video itself stays out of the repo (large) — only the transcript
// is committed.
//
// Most release-01 videos are short IR clips with little/no audio; we still
// run them through Whisper because some carry operator radio chatter. Where
// Whisper returns silence we emit a "[no audible audio]" placeholder so the
// event still has a doc record.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VIDEO_DIR = path.join(ROOT, "data-raw/videos");
const OUT_DIR = path.join(ROOT, "public/text");
const MODEL = process.env.WHISPER_MODEL || "base.en";

const { EVENTS } = await import("../src/data/events.js");
await mkdir(VIDEO_DIR, { recursive: true });
await mkdir(OUT_DIR, { recursive: true });

const targets = EVENTS.filter(e => e.videoId && !e.url);  // video-only records
console.log(`[transcribe] ${targets.length} video-only events:`, targets.map(t => t.id).join(", "));

for (const ev of targets) {
  const stem = path.join(VIDEO_DIR, ev.id);
  let videoPath = ["mp4","mov","webm"].map(x => `${stem}.${x}`).find(p => existsSync(p));
  if (!videoPath) {
    console.log(`\n↓ downloading ${ev.id} (DVIDS ${ev.videoId})…`);
    try {
      await exec("yt-dlp", [
        "-o", `${stem}.%(ext)s`,
        "--no-playlist", "--no-warnings", "--quiet",
        `https://www.dvidshub.net/video/${ev.videoId}`,
      ], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      videoPath = ["mp4","mov","webm"].map(x => `${stem}.${x}`).find(p => existsSync(p));
    } catch (e) {
      console.log(`  ✗ yt-dlp failed: ${e.message.slice(0,120)}`);
      continue;
    }
  }
  if (!videoPath) { console.log(`  ✗ no video on disk for ${ev.id}`); continue; }

  // ffprobe duration
  let dur = "?";
  try {
    const { stdout } = await exec("ffprobe", ["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1", videoPath], { windowsHide: true });
    dur = Number(stdout.trim()).toFixed(1) + "s";
  } catch {}

  // Whisper transcribe
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
}

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
