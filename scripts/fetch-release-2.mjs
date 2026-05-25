// Fetch the war.gov UAP master CSV and emit the list of Release 2 assets
// (videos, PDFs, audio) that we don't yet have in our catalog.
//
// Run LOCALLY (not in cloud — Akamai blocks cloud IPs):
//   node scripts/fetch-release-2.mjs
//
// Two paths, in order of preference:
//   1) Direct curl/fetch of https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-csv.csv
//   2) Whipgen+ChatGPT recon (the daemon already has a browser session that
//      can reach war.gov), used only if the direct path 403s. Requires
//      whipgen running on http://127.0.0.1:9223 and ~/.whipgen-token.
//
// Output: data-raw/release-2-candidates.json — a structured diff of
// upstream rows vs our current events catalog. Commit and inspect.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "data-raw", "release-2-candidates.json");

const CSV_URL = "https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-csv.csv";
const DAEMON  = process.env.DAEMON || "http://127.0.0.1:9223";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

async function tryDirect() {
  console.log(`[direct] GET ${CSV_URL}`);
  try {
    const r = await fetch(CSV_URL, {
      headers: { "User-Agent": UA, "Accept": "text/csv,text/plain,*/*" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      console.log(`[direct] HTTP ${r.status} — falling back to whipgen`);
      return null;
    }
    const text = await r.text();
    console.log(`[direct] got ${text.length} bytes`);
    return text;
  } catch (e) {
    console.log(`[direct] failed: ${e.message} — falling back to whipgen`);
    return null;
  }
}

async function tryWhipgen() {
  // Read token
  let token = process.env.WHIPGEN_TOKEN;
  if (!token) {
    for (const p of [path.join(os.homedir(), ".whipgen-token"), path.join(os.homedir(), ".pursue-vision-token")]) {
      if (existsSync(p)) { token = (await readFile(p, "utf8")).trim(); break; }
    }
  }
  if (!token) { console.error("[whipgen] no token (~/.whipgen-token, ~/.pursue-vision-token, or $WHIPGEN_TOKEN)"); return null; }

  // Check daemon
  try {
    const s = await fetch(`${DAEMON}/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    if (!s.ok) { console.error(`[whipgen] daemon /status HTTP ${s.status}`); return null; }
  } catch (e) {
    console.error(`[whipgen] daemon offline at ${DAEMON}: ${e.message}`);
    console.error(`[whipgen] start it: cd pursue-vision-mcp && npm start`);
    return null;
  }

  // Whipgen requires a file path. Stage a tiny seed file describing what we want.
  const stageDir = path.join(os.homedir(), ".whipgen-smoke", "pursue-console");
  await mkdir(stageDir, { recursive: true });
  const seedPath = path.join(stageDir, "release-2-recon-seed.txt");
  await writeFile(seedPath, "This is a placeholder. See the prompt for the real task.\n", "utf8");

  const prompt = [
    "Please retrieve the CSV at:",
    "  https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-csv.csv",
    "",
    "Use your web browsing tool to fetch it. The CSV lists every file in",
    "the Department of War UAP releases (war.gov/ufo). I need the FULL raw",
    "CSV contents output verbatim — no commentary, no summarisation, no",
    "markdown wrapping. Just the CSV text.",
    "",
    "If the CSV is too long, prioritise rows where the release column",
    "indicates Release 2 (any of: \"Release 02\", \"Release 2\", \"R2\").",
    "",
    "Ignore the seed file attached — it is only a stub the API requires.",
  ].join("\n");

  console.log(`[whipgen] POST ${DAEMON}/chat-with-files`);
  const r = await fetch(`${DAEMON}/chat-with-files`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      filePaths: [seedPath],
      prompt,
      provider: "chatgpt",
      label: "release-2-recon",
      freshChat: true,
      timeoutMs: 240_000,
    }),
  });
  if (!r.ok) { console.error(`[whipgen] HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`); return null; }
  const j = await r.json();
  const text = j.text ?? j.result?.text ?? j.output ?? "";
  console.log(`[whipgen] got ${text.length} chars`);
  return text;
}

// Parse the CSV (or whatever recon text we got). The Release 1 manifest
// columns we know about (from Denis's tsv): URL, title, agency, date,
// release. Pure CSV parse with quote handling — keep it tiny.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c === "\r") {}
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function urlsFromRows(rows) {
  // Find header row. Look for a column header containing 'url' or 'link'.
  const header = rows[0] || [];
  const lower = header.map(h => h.toLowerCase().trim());
  const urlIdx = lower.findIndex(h => h === "url" || h === "link" || h.includes("url"));
  const titleIdx = lower.findIndex(h => h === "title" || h === "name" || h.includes("title"));
  const releaseIdx = lower.findIndex(h => h.includes("release"));
  const typeIdx = lower.findIndex(h => h === "type" || h.includes("type") || h.includes("kind"));
  const dateIdx = lower.findIndex(h => h.includes("date"));

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.length) continue;
    out.push({
      url:     urlIdx     >= 0 ? r[urlIdx]?.trim()     || null : null,
      title:   titleIdx   >= 0 ? r[titleIdx]?.trim()   || null : null,
      release: releaseIdx >= 0 ? r[releaseIdx]?.trim() || null : null,
      type:    typeIdx    >= 0 ? r[typeIdx]?.trim()    || null : null,
      date:    dateIdx    >= 0 ? r[dateIdx]?.trim()    || null : null,
      raw: r,
    });
  }
  return { header, items: out };
}

// --- main ---
let text = await tryDirect();
if (!text) text = await tryWhipgen();
if (!text) {
  console.error("\nBoth paths failed. Try one of:");
  console.error("  1. Run this from a network that isn't Akamai-blocked");
  console.error("  2. Start whipgen: cd pursue-vision-mcp && npm start");
  console.error("  3. Manually download CSV and pipe it: cat csv.csv | node scripts/fetch-release-2.mjs --stdin");
  process.exit(1);
}

// Allow --stdin mode for manual pasting
if (process.argv.includes("--stdin")) {
  text = await new Promise(resolve => {
    let buf = "";
    process.stdin.on("data", chunk => buf += chunk);
    process.stdin.on("end", () => resolve(buf));
  });
}

// Save the raw response for debugging
const rawPath = OUT.replace(/\.json$/, ".raw.txt");
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(rawPath, text, "utf8");
console.log(`[output] raw → ${rawPath}`);

// Try to parse as CSV
let parsed;
try {
  const rows = parseCsv(text);
  parsed = urlsFromRows(rows);
  console.log(`[parse] ${parsed.items.length} rows · header: ${parsed.header.join(" | ")}`);
} catch (e) {
  console.error(`[parse] failed: ${e.message}. Raw saved at ${rawPath} — inspect manually.`);
  process.exit(2);
}

// Load existing events catalog to diff
const { EVENTS } = await import(`../src/data/events.js?cb=${Date.now()}`);
const knownUrls = new Set();
for (const e of EVENTS) {
  if (e.url) {
    knownUrls.add(e.url.toLowerCase());
    // Also store the filename suffix for relative-URL events
    const fn = e.url.split("/").pop()?.toLowerCase();
    if (fn) knownUrls.add(fn);
  }
}

// Split into Release 2 candidates vs already-known
const release2 = [], otherNew = [], known = [];
for (const it of parsed.items) {
  if (!it.url) continue;
  const lc = it.url.toLowerCase();
  const fn = lc.split("/").pop();
  const isKnown = knownUrls.has(lc) || (fn && knownUrls.has(fn));
  if (isKnown) { known.push(it); continue; }
  const isRel2 = /release.0?2|r2|release_?2|release.?ii/i.test(it.release || "") ||
                 /release_?2|release.?02/i.test(it.url);
  if (isRel2) release2.push(it);
  else otherNew.push(it);
}

const summary = {
  generatedAt: new Date().toISOString(),
  source: text === (await tryDirect.toString) ? "whipgen" : "direct-or-stdin",
  totalRows: parsed.items.length,
  knownCount: known.length,
  release2Count: release2.length,
  otherNewCount: otherNew.length,
  release2,
  otherNew,
};
await writeFile(OUT, JSON.stringify(summary, null, 2) + "\n", "utf8");

console.log(`\n[summary] total ${parsed.items.length} · known ${known.length} · Release 2 candidates ${release2.length} · other new ${otherNew.length}`);
console.log(`[summary] full diff → ${OUT}`);
if (release2.length) {
  console.log(`\n[release-2 head]`);
  for (const it of release2.slice(0, 10)) console.log(`  - ${it.type || "?"} · ${it.title || "(no title)"} · ${it.url}`);
}
