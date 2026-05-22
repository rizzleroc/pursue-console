// Download each event's primary PDF into data-raw/ (gitignored).
// Skips files that already exist. Skips events with no URL.
import { mkdir, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeFetch } from "./safe-fetch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(ROOT, "data-raw");

const { EVENTS } = await import("../src/data/events.js");
await mkdir(RAW_DIR, { recursive: true });

const exists = async (p) => { try { await access(p, constants.F_OK); return true; } catch { return false; } };
const safeName = (id, url) => {
  const ext = (url.split(".").pop() || "pdf").split("?")[0].toLowerCase();
  return `${id}.${ext.length <= 5 ? ext : "pdf"}`;
};

let downloaded = 0, skipped = 0, missing = 0, failed = 0;
for (const ev of EVENTS) {
  if (!ev.url) { missing++; continue; }
  const outPath = path.join(RAW_DIR, safeName(ev.id, ev.url));
  if (await exists(outPath)) { skipped++; continue; }
  process.stdout.write(`↓ ${ev.id.padEnd(28)} `);
  try {
    const res = await safeFetch(ev.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(outPath, buf);
    console.log(`${(buf.length / 1024).toFixed(0)} KB`);
    downloaded++;
  } catch (e) {
    console.log(`FAIL ${e.message}`);
    failed++;
  }
}
console.log(`\n[fetch] downloaded=${downloaded} skipped=${skipped} no-url=${missing} failed=${failed}`);
