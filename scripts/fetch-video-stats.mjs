// scripts/fetch-video-stats.mjs
//
// Scrape view counts (and basic metadata) for every DVIDS video in the
// corpus and emit src/data/video-stats.json for the site to read.
//
// Two fetch paths, same dual pattern as scripts/sync-war-gov.mjs:
//   1. Direct fetch() — works locally, often 403's in cloud sessions
//      with x-deny-reason: host_not_allowed.
//   2. Fallback: whipgen MCP daemon on :9223, JSON-RPC POST /mcp,
//      tools/call → whipgen_web_open. Bearer token read from
//      $WHIPGEN_TOKEN or ~/.whipgen-token or ~/.pursue-vision-token,
//      same as scripts/scrape-release-02-via-whipgen.mjs.
//
// Parse strategy for HTML:
//   • Prefer JSON-LD (<script type="application/ld+json">). DVIDS embeds
//     a schema.org/VideoObject with interactionStatistic →
//     InteractionCounter / WatchAction whose userInteractionCount is the
//     view count. Also yields name, uploadDate, and (ISO 8601) duration.
//   • Fallback regexes: any "userInteractionCount":\s*N in the page,
//     or a visible ".views" / "data-views" attribute. If none match we
//     record {views: null, error: "no views found"}.
//
// If DVIDS_API_KEY is set we try https://api.dvidshub.net/asset/<id>
// first (cleaner data, no scrape). On any failure we fall back to HTML.
//
// CLI:
//   node scripts/fetch-video-stats.mjs                 # run + write JSON
//   node scripts/fetch-video-stats.mjs --dry-run       # list IDs, exit
//   node scripts/fetch-video-stats.mjs --ids=1006119   # only these IDs
//   node scripts/fetch-video-stats.mjs --verbose       # log each fetch
//   node scripts/fetch-video-stats.mjs --daemon=http://127.0.0.1:9223
//   node scripts/fetch-video-stats.mjs --prefer=direct|whipgen
//
// Per-video failures never block the script — they're recorded with an
// error string and the rest of the corpus continues. Exit code is 0
// unless setup itself fails.

import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.on("unhandledRejection", e => console.error("  ! unhandled:", e?.message || e));

// ---- args ----
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

const DRY     = !!args["dry-run"];
const VERBOSE = !!args.verbose;
const DAEMON  = String(args.daemon || "http://127.0.0.1:9223").replace(/\/+$/, "");
const PREFER  = (args.prefer || "").toLowerCase();         // "", "direct", "whipgen"
const ID_FILTER = args.ids
  ? new Set(String(args.ids).split(",").map(s => s.trim()).filter(Boolean))
  : null;

if (PREFER && PREFER !== "direct" && PREFER !== "whipgen") {
  console.error(`error: --prefer must be 'direct' or 'whipgen', got '${PREFER}'`);
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT     = path.resolve(__dirname, "..");
const EVENTS_PATH = path.join(ROOT, "src", "data", "events.js");
const OUT_PATH    = path.join(ROOT, "src", "data", "video-stats.json");

const POLITE_GAP_MS = 250;

// ---- enumerate video IDs from events.js ----
//
// We don't want to actually import the module (it pulls in URL bases +
// auto-files). A surface text grep is enough: every video entry has a
// `videoId: "NNNNNNN"` field with a numeric DVIDS asset id.
async function enumerateVideoIds() {
  const src = await readFile(EVENTS_PATH, "utf8");
  const ids = [];
  const re = /videoId\s*:\s*["']([0-9]+)["']/g;
  let m;
  while ((m = re.exec(src))) ids.push(m[1]);
  return [...new Set(ids)];
}

// ---- token (for whipgen path) ----
async function loadToken() {
  if (process.env.WHIPGEN_TOKEN) return process.env.WHIPGEN_TOKEN;
  if (process.env.PURSUE_VISION_TOKEN) return process.env.PURSUE_VISION_TOKEN;
  for (const p of [
    path.join(os.homedir(), ".whipgen-token"),
    path.join(os.homedir(), ".pursue-vision-token"),
  ]) {
    try { return (await readFile(p, "utf8")).trim(); } catch {}
  }
  return null;
}

// ---- daemon probe ----
async function isDaemonHealthy() {
  try {
    const r = await fetch(`${DAEMON}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

// ---- HTML parser ----
//
// Returns { views, title, durationSec, publishedAt } or throws.
// Order of preference:
//   1. JSON-LD VideoObject (schema.org)
//   2. Loose "userInteractionCount": N anywhere in the HTML
//   3. data-views="N" attribute or <span class="views">N views</span>
function parseDvidsHtml(html) {
  if (typeof html !== "string" || !html.length) {
    throw new Error("empty html");
  }
  const out = { views: null, title: null, durationSec: null, publishedAt: null };

  // 1. JSON-LD blocks
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch;
  const ldBlocks = [];
  while ((ldMatch = ldRe.exec(html))) {
    const raw = ldMatch[1].trim();
    try { ldBlocks.push(JSON.parse(raw)); } catch { /* ignore malformed blocks */ }
  }
  // Some pages wrap multiple objects in an @graph array.
  const flat = [];
  for (const block of ldBlocks) {
    if (Array.isArray(block)) flat.push(...block);
    else if (block && Array.isArray(block["@graph"])) flat.push(...block["@graph"]);
    else if (block) flat.push(block);
  }
  const videoObj = flat.find(o => {
    const t = o && o["@type"];
    return t === "VideoObject" || (Array.isArray(t) && t.includes("VideoObject"));
  });
  if (videoObj) {
    if (videoObj.name && typeof videoObj.name === "string") out.title = videoObj.name;
    if (videoObj.uploadDate) out.publishedAt = String(videoObj.uploadDate);
    if (videoObj.duration && typeof videoObj.duration === "string") {
      out.durationSec = iso8601DurationToSec(videoObj.duration);
    }
    const stats = videoObj.interactionStatistic;
    const arr = Array.isArray(stats) ? stats : (stats ? [stats] : []);
    for (const s of arr) {
      const action = s?.interactionType;
      const actType = typeof action === "string"
        ? action
        : (action && action["@type"]) || "";
      // schema.org/WatchAction signals view count.
      if (/WatchAction/i.test(String(actType))) {
        const n = Number(s.userInteractionCount);
        if (Number.isFinite(n)) { out.views = n; break; }
      }
    }
    // If WatchAction wasn't called out explicitly, but there's exactly
    // one interaction stat, use its count anyway.
    if (out.views == null && arr.length === 1) {
      const n = Number(arr[0].userInteractionCount);
      if (Number.isFinite(n)) out.views = n;
    }
  }
  if (out.views != null) return out;

  // 2. Loose JSON pattern (sometimes the LD block isn't there but the
  // same key appears elsewhere on the page, e.g. inside __NEXT_DATA__).
  const looseRe = /"userInteractionCount"\s*:\s*"?(\d+)"?/;
  const loose = html.match(looseRe);
  if (loose) {
    out.views = Number(loose[1]);
    return out;
  }

  // 3. Visible markup fallbacks.
  const dataAttr = html.match(/\bdata-views\s*=\s*["']?(\d+)["']?/i);
  if (dataAttr) { out.views = Number(dataAttr[1]); return out; }
  const spanRe = /<span[^>]*class=["'][^"']*\bviews\b[^"']*["'][^>]*>\s*([\d,]+)[^<]*<\/span>/i;
  const spanMatch = html.match(spanRe);
  if (spanMatch) {
    out.views = Number(spanMatch[1].replace(/,/g, ""));
    return out;
  }

  throw new Error("no views found in HTML (JSON-LD/looseJSON/data-views/.views all missed)");
}

// ISO 8601 duration "PT1H2M30S" → seconds. Returns null on parse failure.
function iso8601DurationToSec(s) {
  const m = String(s).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return null;
  const h = Number(m[1] || 0), min = Number(m[2] || 0), sec = Number(m[3] || 0);
  const total = h * 3600 + min * 60 + sec;
  return Number.isFinite(total) ? Math.round(total) : null;
}

// ---- fetch paths ----
async function fetchDirectHtml(id) {
  const url = `https://www.dvidshub.net/video/${id}`;
  const r = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (pursue-console video-stats fetcher)",
      "Accept": "text/html,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const deny = r.headers.get("x-deny-reason");
    throw new Error(`HTTP ${r.status}${deny ? ` (x-deny-reason: ${deny})` : ""}`);
  }
  return await r.text();
}

async function fetchApiJson(id, apiKey) {
  const url = `https://api.dvidshub.net/asset/${id}?api_key=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`API HTTP ${r.status}`);
  return await r.json();
}

function parseApiResults(json) {
  // The DVIDS API returns { results: {...} } or { results: [{...}] }.
  const r = Array.isArray(json?.results) ? json.results[0] : json?.results || json;
  if (!r || typeof r !== "object") throw new Error("API response missing results");
  const views = Number(r.views ?? r.view_count ?? r.viewcount);
  return {
    views: Number.isFinite(views) ? views : null,
    title: r.title || null,
    durationSec: Number.isFinite(Number(r.duration)) ? Number(r.duration) : null,
    publishedAt: r.date_published || r.published_at || r.date || null,
  };
}

async function fetchWhipgenHtml(id, token) {
  const url = `https://www.dvidshub.net/video/${id}`;
  const body = {
    jsonrpc: "2.0", id: Date.now(),
    method: "tools/call",
    params: { name: "whipgen_web_open", arguments: { url } },
  };
  const r = await fetch(`${DAEMON}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`whipgen HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const j = await r.json();
  if (j?.error) throw new Error(`whipgen MCP error: ${j.error.message || JSON.stringify(j.error)}`);
  const payload = j?.result?.content?.[0]?.text;
  if (!payload) throw new Error("whipgen response missing result.content[0].text");
  // The text field is a JSON string of the page map; parse and use .text.
  let parsed;
  try { parsed = typeof payload === "string" ? JSON.parse(payload) : payload; }
  catch { /* may be raw HTML/text already */ parsed = { text: payload }; }
  const text = parsed?.text ?? parsed?.html ?? (typeof parsed === "string" ? parsed : "");
  if (!text) throw new Error("whipgen page map missing 'text' field");
  return String(text);
}

// ---- run ----
const allIds = await enumerateVideoIds();
let videoIds = allIds;
if (ID_FILTER) {
  videoIds = allIds.filter(id => ID_FILTER.has(id));
  const missing = [...ID_FILTER].filter(id => !allIds.includes(id));
  if (missing.length) {
    console.error(`[video-stats] note: --ids contains IDs not in events.js: ${missing.join(", ")}`);
  }
}

console.error(`[video-stats] events.js videoIds: ${allIds.length}` +
              (ID_FILTER ? ` · after --ids filter: ${videoIds.length}` : ""));

if (DRY) {
  console.error("[video-stats] --dry-run: would fetch:");
  for (const id of videoIds) console.log(`  ${id}  https://www.dvidshub.net/video/${id}`);
  process.exit(0);
}

if (!videoIds.length) {
  console.error("[video-stats] nothing to fetch.");
  process.exit(0);
}

// Decide path. If --prefer=direct, skip the daemon entirely. If
// --prefer=whipgen, require it. Otherwise: try direct first per id,
// fall back to whipgen if (a) it 403's with a deny reason or (b) any
// network error.
const apiKey = process.env.DVIDS_API_KEY || null;
const daemonOk = PREFER === "direct" ? false : await isDaemonHealthy();
const token    = daemonOk ? await loadToken() : null;

if (PREFER === "whipgen" && !(daemonOk && token)) {
  console.error(`error: --prefer=whipgen set but daemon (${DAEMON}) or token not available`);
  console.error(`       daemonHealthy=${daemonOk} token=${token ? "present" : "missing"}`);
  process.exit(1);
}

console.error(`[video-stats] paths: direct=${PREFER !== "whipgen" ? "yes" : "skip"}` +
              ` · whipgen=${daemonOk && token ? "ready" : "unavailable"}` +
              ` · api=${apiKey ? "yes (DVIDS_API_KEY set)" : "no"}`);

const stats = {};
let sourceUsed = "dvids-html";   // updated as we go; final value is the most recent path that succeeded

async function fetchOne(id) {
  // 1. API path if key is set.
  if (apiKey) {
    try {
      const j = await fetchApiJson(id, apiKey);
      const parsed = parseApiResults(j);
      sourceUsed = "dvids-api";
      return { ...parsed, fetchedAt: new Date().toISOString() };
    } catch (e) {
      if (VERBOSE) console.error(`  [${id}] api failed: ${e.message}`);
    }
  }
  // 2. Direct HTML (unless explicitly skipped).
  if (PREFER !== "whipgen") {
    try {
      const html = await fetchDirectHtml(id);
      const parsed = parseDvidsHtml(html);
      sourceUsed = "dvids-html";
      return { ...parsed, fetchedAt: new Date().toISOString() };
    } catch (e) {
      if (VERBOSE) console.error(`  [${id}] direct failed: ${e.message}`);
      if (!(daemonOk && token)) throw e;        // no fallback available
    }
  }
  // 3. Whipgen MCP fallback.
  if (daemonOk && token) {
    const html = await fetchWhipgenHtml(id, token);
    const parsed = parseDvidsHtml(html);
    sourceUsed = "whipgen-mcp";
    return { ...parsed, fetchedAt: new Date().toISOString() };
  }
  throw new Error("all paths exhausted");
}

const t0 = Date.now();
for (let i = 0; i < videoIds.length; i++) {
  const id = videoIds[i];
  if (VERBOSE) console.error(`[${i + 1}/${videoIds.length}] ${id}`);
  try {
    const rec = await fetchOne(id);
    stats[id] = rec;
    if (VERBOSE || (i + 1) % 5 === 0 || i === videoIds.length - 1) {
      console.error(`  ${id} → views=${rec.views ?? "null"} title="${(rec.title || "").slice(0, 60)}"`);
    }
  } catch (e) {
    stats[id] = { views: null, error: e.message || String(e), fetchedAt: new Date().toISOString() };
    console.error(`  ${id} → ERROR ${e.message || e}`);
  }
  if (i < videoIds.length - 1) {
    await new Promise(r => setTimeout(r, POLITE_GAP_MS));
  }
}

const output = {
  fetchedAt: new Date().toISOString(),
  source: sourceUsed,
  stats,
};
await writeFile(OUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");

const ok = Object.values(stats).filter(s => s && s.views != null).length;
const fail = videoIds.length - ok;
const tookS = ((Date.now() - t0) / 1000).toFixed(1);
console.error(`\n[video-stats] wrote ${OUT_PATH}`);
console.error(`[video-stats] ${ok} ok · ${fail} missing · source=${sourceUsed} · ${tookS}s`);
process.exit(0);
