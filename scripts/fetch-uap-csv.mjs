// Fetch the canonical war.gov UAP CSV via an in-page fetch from a
// real Chromium tab on the war.gov origin. Akamai's TLS fingerprinting
// rejects every Node-side HTTP client; the only way through is to run
// the fetch INSIDE a page already loaded on www.war.gov.
//
// Prereq: a Chromium instance with CDP open on 127.0.0.1:9222 (the
// pursue-vision-mcp daemon's start.mjs sets this up, or launch any
// Chromium with --remote-debugging-port=9222).
//
// Writes data-raw/uap-data.csv. Prints row count + first few IDs so
// the caller can sanity-check.

import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(path.join(ROOT, "pursue-vision-mcp", "package.json"));
const { chromium } = require("playwright");
const CDP_URL = process.env.PURSUE_CDP_URL || "http://127.0.0.1:9222";
const CSV_URL = process.env.UAP_CSV_URL
  || "https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-data.csv";
const LANDING = "https://www.war.gov/UFO/";
const OUT_PATH = path.join(ROOT, "data-raw", "uap-data.csv");

console.log(`[fetch-uap-csv] cdp=${CDP_URL}`);
console.log(`[fetch-uap-csv] csv=${CSV_URL}`);

const browser = await chromium.connectOverCDP(CDP_URL);

let page = null;
for (const ctx of browser.contexts()) {
  for (const p of ctx.pages()) {
    if (/^https?:\/\/(www\.)?war\.gov\//i.test(p.url())) { page = p; break; }
  }
  if (page) break;
}
if (!page) {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("no Chrome context found over CDP");
  page = await ctx.newPage();
  console.log(`[fetch-uap-csv] opening ${LANDING}`);
  await page.goto(LANDING, { waitUntil: "domcontentloaded", timeout: 30_000 });
} else {
  console.log(`[fetch-uap-csv] reusing existing war.gov tab: ${page.url()}`);
  if (!/war\.gov\/UFO\b/i.test(page.url())) {
    await page.goto(LANDING, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
}

const res = await page.evaluate(async (u) => {
  const r = await fetch(u, { credentials: "include" });
  return {
    ok: r.ok,
    status: r.status,
    contentType: r.headers.get("content-type") || "",
    body: await r.text(),
  };
}, CSV_URL);

if (!res.ok) {
  console.error(`[fetch-uap-csv] HTTP ${res.status} (${res.contentType})`);
  console.error(`[fetch-uap-csv] body preview: ${res.body.slice(0, 400)}`);
  await browser.close().catch(() => {});
  process.exit(1);
}

await mkdir(path.dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, res.body, "utf8");

const lines = res.body.split(/\r?\n/).filter(Boolean);
const head = lines[0] || "";
const sampleIds = lines.slice(1, 12).map(l => l.split(",")[0]?.replace(/^"|"$/g, "") || "");
console.log(`[fetch-uap-csv] saved ${res.body.length} bytes → ${OUT_PATH}`);
console.log(`[fetch-uap-csv] rows: ${lines.length - 1} (excluding header)`);
console.log(`[fetch-uap-csv] header: ${head}`);
console.log(`[fetch-uap-csv] first IDs:\n  ${sampleIds.join("\n  ")}`);

await browser.close().catch(() => {});
