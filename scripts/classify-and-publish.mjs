// Long-running maintainer batch: classify pages, rebuild the MEDIA
// index every N pages, optionally commit + push so the live site
// updates incrementally instead of one drop at the end.
//
// This is a wrapper around classify-visuals.mjs. Runs it in a child
// process, listens for completed pages on stdout, batches a rebuild
// + commit every PUBLISH_EVERY pages.
//
// Usage:
//   node scripts/classify-and-publish.mjs              # publish every 20 pages
//   PUBLISH_EVERY=10 node scripts/classify-and-publish.mjs
//   NO_PUSH=1 node scripts/classify-and-publish.mjs    # rebuild but don't git push
//
// Keep the daemon at :9223 running. The wrapper terminates when
// classify-visuals exits.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PUBLISH_EVERY = Number(process.env.PUBLISH_EVERY || 20);
const NO_PUSH = !!process.env.NO_PUSH;

let processed = 0;
let lastPublishedAt = 0;
let publishing = false;

async function publish() {
  if (publishing) return;
  publishing = true;
  console.log(`\n[publish] running media-index + corpus-stats refresh...`);
  await new Promise(resolve => {
    const p = spawn("node", ["scripts/extract-media-from-gemini.mjs"], { cwd: ROOT, stdio: "inherit" });
    p.on("close", resolve);
  });
  await new Promise(resolve => {
    const p = spawn("node", ["scripts/build-media-index.mjs"], { cwd: ROOT, stdio: "inherit" });
    p.on("close", resolve);
  });
  await new Promise(resolve => {
    const p = spawn("node", ["scripts/db-rebuild.mjs"], { cwd: ROOT, stdio: "inherit" });
    p.on("close", resolve);
  });
  if (!NO_PUSH) {
    console.log(`[publish] committing + pushing...`);
    await new Promise(resolve => {
      const p = spawn("bash", ["-c", `git add -A && git -c user.name=rizzleroc -c user.email=rizzleroc@users.noreply.github.com commit -m "data: classifier batch progress · ${processed} pages processed since start" 2>&1 | tail -3 && git push origin main 2>&1 | tail -3`], { cwd: ROOT, stdio: "inherit", shell: true });
      p.on("close", resolve);
    });
  }
  lastPublishedAt = processed;
  publishing = false;
  console.log(`[publish] done · ${processed} pages processed total\n`);
}

const child = spawn("node", ["scripts/classify-visuals.mjs", ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: ["inherit", "pipe", "inherit"],
});

let buf = "";
child.stdout.on("data", async (chunk) => {
  buf += chunk.toString();
  process.stdout.write(chunk);   // tee to console
  const lines = buf.split("\n");
  buf = lines.pop();             // keep partial line
  for (const line of lines) {
    // classify-visuals logs one line per page with kind name at the end:
    //   [N/M] <eid>     pNNNN <kind>   "<title>"
    // we count the lines that look like "[N/M] " to track progress.
    if (/^\[\d+\/\d+\]/.test(line)) {
      processed++;
      if (processed - lastPublishedAt >= PUBLISH_EVERY && !publishing) {
        publish().catch(e => console.error("publish error:", e.message));
      }
    }
  }
});

child.on("close", async (code) => {
  console.log(`\n[classify-and-publish] child exited with code ${code}`);
  if (processed > lastPublishedAt) {
    console.log(`[classify-and-publish] final publish of ${processed - lastPublishedAt} pending pages...`);
    await publish();
  }
  process.exit(code);
});
