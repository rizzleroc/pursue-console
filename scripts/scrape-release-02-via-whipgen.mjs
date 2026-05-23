// scripts/scrape-release-02-via-whipgen.mjs
//
// Drives the whipgen MCP web tools (whipgen_web_search /
// whipgen_web_open / whipgen_web_extract) over the daemon's HTTP MCP
// transport to scrape the war.gov UFO/PURSUE Release 02 file index and
// emit a paste-ready src/data/events.js entry block for the 51 videos +
// 7 audio items.
//
// The 6 PDFs are already in events.js (CIA-UAP-D001, DOE-UAP-D001..D003,
// DOW-UAP-D017, ODNI-UAP-D001) — they're skipped on output to keep IDs
// unique.
//
// Usage:
//   node scripts/scrape-release-02-via-whipgen.mjs                       # run + print
//   node scripts/scrape-release-02-via-whipgen.mjs --out=events-r02.js   # write to file
//   node scripts/scrape-release-02-via-whipgen.mjs --daemon=http://127.0.0.1:9233
//   node scripts/scrape-release-02-via-whipgen.mjs --dry-run             # plan only
//
// Reads the bearer token from $WHIPGEN_TOKEN or ~/.whipgen-token (falls
// back to ~/.pursue-vision-token).
//
// MCP HTTP transport assumption: the daemon accepts JSON-RPC 2.0 envelopes
// at POST /mcp. If your build uses a different route (some forks use
// POST /tools/call or direct /web/{search,open,extract}), pass
// --mcp-route=<path>. The script auto-probes common variants on the first
// call and prints which one worked.

import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---- args ----
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const DAEMON     = args.daemon || "http://127.0.0.1:9223";
const OUT_PATH   = args.out || null;
const DRY_RUN    = !!args["dry-run"];
const VERBOSE    = !!args.verbose;
const MCP_ROUTE_OVERRIDE = args["mcp-route"] || null;

const RELEASE_URL = "https://www.war.gov/News/Releases/Release/Article/4499305/department-of-war-publishes-second-release-of-unidentified-anomalous-phenomena/";
const FALLBACK_INDEX_URL = "https://www.war.gov/UFO/";

const ALREADY_CATALOGUED = new Set([
  "CIA-UAP-D001", "DOE-UAP-D001", "DOE-UAP-D002",
  "DOE-UAP-D003", "DOW-UAP-D017", "ODNI-UAP-D001",
]);

// ---- token ----
async function loadToken() {
  if (process.env.WHIPGEN_TOKEN) return process.env.WHIPGEN_TOKEN;
  if (process.env.PURSUE_VISION_TOKEN) return process.env.PURSUE_VISION_TOKEN;
  for (const p of [
    path.join(os.homedir(), ".whipgen-token"),
    path.join(os.homedir(), ".pursue-vision-token"),
  ]) {
    try { return (await readFile(p, "utf8")).trim(); } catch {}
  }
  console.error("error: no token. Set $WHIPGEN_TOKEN or put it in ~/.whipgen-token");
  process.exit(1);
}
const TOKEN = await loadToken();

// ---- MCP transport probe ----
//
// MCP servers expose tools differently depending on the implementation.
// Try the most common shapes in this order; cache whichever one works.
const TRANSPORTS = [
  {
    name: "jsonrpc-mcp",                                                // standard MCP over HTTP
    route: "/mcp",
    build: (tool, argsObj) => ({
      jsonrpc: "2.0", id: Date.now(),
      method: "tools/call",
      params: { name: tool, arguments: argsObj },
    }),
    parse: (j) => j?.result?.content?.[0]?.text ?? j?.result ?? j,
  },
  {
    name: "tools-call",                                                 // some forks
    route: "/tools/call",
    build: (tool, argsObj) => ({ name: tool, arguments: argsObj }),
    parse: (j) => j?.content?.[0]?.text ?? j?.result ?? j,
  },
  {
    name: "direct-web",                                                 // direct endpoint flavour
    route: (tool) => "/web/" + tool.replace(/^whipgen_web_/, ""),
    build: (_tool, argsObj) => argsObj,
    parse: (j) => j?.text ?? j?.result ?? j,
  },
];
let activeTransport = null;

async function callTool(tool, argsObj) {
  const transports = activeTransport ? [activeTransport] : TRANSPORTS;
  if (MCP_ROUTE_OVERRIDE) {
    transports.unshift({
      name: "override",
      route: MCP_ROUTE_OVERRIDE,
      build: TRANSPORTS[0].build,
      parse: TRANSPORTS[0].parse,
    });
  }
  let lastErr = null;
  for (const t of transports) {
    const route = typeof t.route === "function" ? t.route(tool) : t.route;
    const body  = t.build(tool, argsObj);
    if (VERBOSE) console.error(`[mcp] try ${t.name} ${route}  tool=${tool}`);
    try {
      const r = await fetch(DAEMON + route, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.status === 404) { lastErr = new Error(`404 at ${route}`); continue; }
      if (!r.ok) {
        const text = (await r.text()).slice(0, 300);
        throw new Error(`HTTP ${r.status} at ${route}: ${text}`);
      }
      const j = await r.json().catch(async () => ({ text: await r.text() }));
      const out = t.parse(j);
      if (!activeTransport) {
        activeTransport = t;
        console.error(`[mcp] using transport: ${t.name} (${route})`);
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (!/404/.test(e.message)) throw e;     // non-404 = transport works but call failed
    }
  }
  throw new Error(`no MCP transport worked. Last: ${lastErr?.message}. ` +
                  `Pass --mcp-route=<path> with your daemon's route or --verbose to see attempts.`);
}

// ---- scrape ----
async function fetchPage(url) {
  // Prefer whipgen_web_open (renders JS); fall back to whipgen_web_extract.
  try {
    return await callTool("whipgen_web_open", { url });
  } catch (e) {
    if (VERBOSE) console.error(`[scrape] whipgen_web_open failed (${e.message}), trying extract`);
    return await callTool("whipgen_web_extract", { url });
  }
}

// War.gov UFO entries follow AGENCY-UAP-{D|PR}NNN. Lift them out of any
// text/HTML blob the MCP returns.
const ID_RX = /\b((?:CIA|DOE|DOW|FBI|ODNI|NASA|DOS|DOJ|DOD|AARO|USPS)-UAP-(?:D|PR)\d{3,4})\b/gi;
const DVIDS_RX = /dvidshub\.net\/(?:video|asset|image)\/(\d{6,8})/gi;
const PDF_RX = /https?:\/\/[^\s"'<>]+release_2[^\s"'<>]*\.pdf/gi;

function unique(arr) { return [...new Set(arr)]; }

function harvest(text) {
  if (typeof text !== "string") text = JSON.stringify(text);
  const ids   = unique([...text.matchAll(ID_RX)].map(m => m[1].toUpperCase()));
  const dvids = unique([...text.matchAll(DVIDS_RX)].map(m => m[1]));
  const pdfs  = unique([...text.matchAll(PDF_RX)].map(m => m[0]));
  return { ids, dvids, pdfs };
}

// ---- agency inference ----
const AGENCY_FROM_PREFIX = {
  CIA: "Central Intelligence Agency",
  DOE: "Department of Energy",
  DOW: "Department of War",
  FBI: "FBI",
  ODNI: "Office of the Director of National Intelligence",
  NASA: "NASA",
  DOS: "Department of State",
  DOJ: "Department of Justice",
  DOD: "Department of Defense",
  AARO: "All-domain Anomaly Resolution Office",
};
function agencyOf(id) {
  const prefix = id.split("-")[0];
  return AGENCY_FROM_PREFIX[prefix] || prefix;
}

// ---- main ----
console.error(`[scrape] daemon: ${DAEMON}`);
console.error(`[scrape] dry-run: ${DRY_RUN}`);

const pages = [];
for (const url of [RELEASE_URL, FALLBACK_INDEX_URL]) {
  console.error(`[scrape] fetching ${url}`);
  try {
    const t = await fetchPage(url);
    pages.push({ url, text: typeof t === "string" ? t : JSON.stringify(t) });
  } catch (e) {
    console.error(`[scrape] ${url} → ${e.message}`);
  }
}
if (!pages.length) {
  console.error("error: no pages fetched. Is the daemon up + serving whipgen_web_* tools?");
  process.exit(1);
}

// Pool everything we got and harvest identifiers.
const combined = pages.map(p => p.text).join("\n\n");
const { ids, dvids, pdfs } = harvest(combined);
console.error(`[scrape] harvested  ids=${ids.length}  dvids=${dvids.length}  pdfs=${pdfs.length}`);

const newIds = ids.filter(id => !ALREADY_CATALOGUED.has(id));
console.error(`[scrape] after dedup against the 6 known PDFs: ${newIds.length} new ids`);

if (DRY_RUN) {
  console.error("[scrape] --dry-run set, listing what would be emitted:");
  for (const id of newIds) console.error("  -", id, "→", agencyOf(id));
  process.exit(0);
}

// For each id, ask the MCP for the item's detail page so we can pull
// title/date/location. War.gov uses a predictable URL pattern; if the
// scrape hasn't surfaced a per-item URL we just emit a stub the user can
// fill (the most useful win of this script is the canonical ID list +
// agency mapping, not perfect summary text).
async function detailFor(id) {
  const candidateUrls = [
    `https://www.war.gov/UFO/${id}/`,
    `https://www.war.gov/UFO/Release-02/${id}/`,
  ];
  for (const url of candidateUrls) {
    try {
      const t = await fetchPage(url);
      const text = typeof t === "string" ? t : JSON.stringify(t);
      // crude title heuristic — first non-empty line with the id in it
      const titleLine = text.split(/\r?\n/).find(l => l.includes(id) && l.length < 200);
      return { url, titleLine: titleLine?.trim() || "", text };
    } catch { /* try next */ }
  }
  return null;
}

const entries = [];
for (const id of newIds) {
  const detail = await detailFor(id).catch(() => null);
  const isVideo = /-PR\d/.test(id);
  const agency  = agencyOf(id);
  const title   = detail?.titleLine
    ? `${id}, ${detail.titleLine.replace(new RegExp(`^.*?${id}[,:\\s-]+`), "").slice(0, 140)}`
    : `${id}, Release 02 ${isVideo ? "Mission Report + Video" : "Document"}`;
  // Best-guess sort within Release 02 if we don't have an incident date.
  const sort = 20260522;
  entries.push({
    id, title,
    date: "Undated", sort, era: "20s",
    loc: "United States", region: "North America", coords: [38.9, -77.0],
    agency,
    type: isVideo ? "Mission Report + Video" : "Document",
    flag: "med",
    redacted: true,
    summary: `Release 02 record ${id}. <SCRAPE PASS — fill in summary from the war.gov detail page>`,
    url: detail?.url || "",
    ...(isVideo ? { videoId: "" } : {}),
    release: "Release 02",
    tags: ["release-02", id.split("-")[0]],
    docType: isVideo ? "video" : "document",
  });
}

// Render as a paste-ready JS block.
const block = entries.map(e => {
  const parts = [];
  for (const [k, v] of Object.entries(e)) {
    parts.push(`${k}: ${JSON.stringify(v)}`);
  }
  return "  { " + parts.join(", ") + " },";
}).join("\n");

const header = `\n  // ===== Release 02 scraped via whipgen MCP — ${new Date().toISOString()} =====\n`;
const out = header + block + "\n";

if (OUT_PATH) {
  await writeFile(OUT_PATH, out, "utf8");
  console.error(`[scrape] wrote ${entries.length} entries → ${OUT_PATH}`);
} else {
  process.stdout.write(out);
  console.error(`[scrape] emitted ${entries.length} entries to stdout`);
}
