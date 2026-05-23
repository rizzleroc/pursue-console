// war-gov-direct.mjs — Node-side war.gov index + download client.
//
// Mirror of the request shape implemented in
// pursue-vision-mcp/war-gov-driver.mjs (which goes through Chrome via CDP).
// This module is the no-daemon fallback: same discovery strategies, same
// record normalization, same Akamai-block detection — just plain Node
// `fetch` instead of an in-page browser fetch.
//
// IMPORTANT CAVEAT: the MCP driver's docstring already says it, and it's
// still true here: live www.war.gov uses Akamai TLS fingerprinting that
// rejects most Node-side HTTP clients. Empirically a sandboxed `curl`
// gets HTTP 403 or "Host not in allowlist", and `node fetch` fares the
// same. The direct path is therefore expected to *work* against:
//   - mirrors (e.g. github.com/DenisSergeevitch/UFO-USA) when pointed at
//     them via `baseUrl`,
//   - any environment whose egress IP isn't on Akamai's denylist,
//   - future war.gov endpoints that relax the fingerprint check.
// Against live war.gov from a typical server, it will throw an Akamai
// block error and the caller should fall back to the MCP daemon flow.
//
// Public surface:
//   fetchIndexDirect({ release, baseUrl?, fetchImpl? }) → records[]
//   downloadFileDirect({ url, destPath, timeoutMs?, onProgress?, fetchImpl? }) → { bytes, durationMs }

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_BASE_URL = "https://www.war.gov";
const INDEX_LOAD_TIMEOUT = 30_000;
const DOWNLOAD_TIMEOUT_DEFAULT = 30 * 60_000;
const CHUNK_BYTES = 8 * 1024 * 1024;
const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024;

// Pretend to be a real browser. Akamai will still fingerprint the TLS
// handshake itself (which is what the in-page fetch sidesteps), but a
// realistic UA + Accept headers at least don't get rejected on the
// trivial heuristics.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const AKAMAI_BLOCK_STATUS = new Set([403, 406, 429, 503]);
const AKAMAI_BODY_PATTERNS = [
  /access\s+denied/i,
  /reference\s*#\s*\d+\.[0-9a-f]+/i,
  /pardon\s+our\s+interruption/i,
  /www\.war\.gov\s+blocked\b/i,
];

const INDEX_CANDIDATE_PATHS = [
  "/UFO/api/records",
  "/UFO/api/records.json",
  "/UFO/api/files",
  "/UFO/index.json",
  "/UFO/records.json",
  "/UFO/records.csv",
  "/UFO/manifest.json",
];

function recordMatchesRelease(rec, releaseN) {
  const tag = `release_${releaseN}`;
  const r = rec.release ?? rec.releaseId ?? rec.release_number ?? rec.release_id;
  if (r != null) {
    const s = String(r).toLowerCase();
    if (s === tag) return true;
    if (s === String(releaseN)) return true;
  }
  const u = String(rec.url || rec.href || rec.path || rec.file_url || "").toLowerCase();
  if (u.includes(`/${tag}/`)) return true;
  return false;
}

function normalizeRecord(rec, baseUrl) {
  const url = rec.url || rec.href || rec.file_url || rec.download_url || rec.path;
  if (!url) return null;
  const absUrl = url.startsWith("http") ? url : new URL(url, baseUrl).href;
  const filename = rec.filename || rec.name || path.basename(new URL(absUrl).pathname);
  const ext = (path.extname(filename) || "").toLowerCase().replace(/^\./, "");
  const type = rec.type || rec.media_type ||
    (["pdf"].includes(ext) ? "pdf"
      : ["mp3", "wav", "m4a", "ogg", "flac"].includes(ext) ? "audio"
      : ["mp4", "mov", "webm", "mkv", "avi"].includes(ext) ? "video"
      : "other");
  return {
    filename,
    url: absUrl,
    agency: rec.agency || rec.org || rec.source || null,
    type,
    sizeBytes: rec.sizeBytes ?? rec.size_bytes ?? rec.size ?? null,
  };
}

function looksLikeAkamaiBlock(status, body) {
  if (status && AKAMAI_BLOCK_STATUS.has(Number(status))) return true;
  if (typeof body === "string") {
    for (const re of AKAMAI_BODY_PATTERNS) if (re.test(body)) return true;
  }
  return false;
}

function safeParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ""; }
      else if (ch === '"') inQ = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter(l => l.length);
  if (!lines.length) return [];
  const cells = lines.map(splitCsvLine);
  const header = cells[0].map(h => h.trim());
  return cells.slice(1).map(row => {
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = row[i] ?? "";
    return obj;
  });
}

// Scrape HTML for /medialink/ufo/release_<n>/ anchors. Cheap; works when
// the DoW page renders its file list server-side, even with no JS. We
// regex over the raw HTML rather than parsing because the page shape is
// unverified and we only need href + visible link text.
function scrapeAnchorsForRelease(html, releaseN, baseUrl) {
  const tag = `/medialink/ufo/release_${releaseN}/`;
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href.toLowerCase().includes(tag.toLowerCase())) continue;
    const absUrl = href.startsWith("http") ? href : new URL(href, baseUrl).href;
    if (seen.has(absUrl)) continue;
    seen.add(absUrl);
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    out.push({
      url: absUrl,
      filename: decodeURIComponent(absUrl.split("/").pop().split("?")[0]),
      agency: text || null,
    });
  }
  return out;
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(to);
  }
}

async function tryFetchIndexUrl(fetchImpl, url) {
  let res;
  try {
    res = await fetchWithTimeout(
      fetchImpl, url,
      { headers: { ...BROWSER_HEADERS, Accept: "application/json, text/csv, */*" } },
      INDEX_LOAD_TIMEOUT,
    );
  } catch {
    return null;
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    if (looksLikeAkamaiBlock(res.status, text)) {
      throw new Error(
        `war-gov: Akamai block on ${url} (status ${res.status}). ` +
        `The direct path can't bypass TLS fingerprinting; start the MCP daemon ` +
        `(npm start --prefix pursue-vision-mcp) and re-run.`
      );
    }
    return null;
  }
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  let parsed;
  if (ct.includes("csv") || /\.csv(\?|$)/i.test(url)) parsed = parseCsv(text);
  else parsed = safeParseJson(text);
  if (!Array.isArray(parsed)) {
    if (parsed && typeof parsed === "object") {
      for (const k of ["records", "data", "files", "items", "results"]) {
        if (Array.isArray(parsed[k])) return parsed[k];
      }
    }
    return null;
  }
  return parsed;
}

/**
 * Fetch the war.gov release-files index via Node-side fetch.
 *
 * Strategies, in order:
 *   1. Probe likely JSON/CSV index paths under baseUrl.
 *   2. Fetch the /UFO/ landing page HTML and scrape `/medialink/ufo/release_<n>/`
 *      anchors out of it.
 *
 * (The MCP driver also has a network-intercept strategy on a real page
 * load — we can't do that without a browser, so it's omitted.)
 */
export async function fetchIndexDirect({
  release,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  const releaseN = Number(String(release).replace(/^release[_-]?/i, ""));
  if (!Number.isInteger(releaseN) || releaseN < 1) {
    throw new Error(`fetchIndexDirect: invalid release '${release}' (expected '1', '2', 'release_2', etc.)`);
  }

  // (1) Probe likely index URLs.
  for (const candidatePath of INDEX_CANDIDATE_PATHS) {
    const candidateUrl = new URL(candidatePath, baseUrl).href;
    const records = await tryFetchIndexUrl(fetchImpl, candidateUrl);
    if (records?.length) {
      return records
        .filter(r => recordMatchesRelease(r, releaseN))
        .map(r => normalizeRecord(r, baseUrl))
        .filter(Boolean);
    }
  }

  // (2) Scrape the landing page HTML.
  const landingUrl = new URL("/UFO/", baseUrl).href;
  let html = "";
  try {
    const res = await fetchWithTimeout(
      fetchImpl, landingUrl, { headers: BROWSER_HEADERS }, INDEX_LOAD_TIMEOUT,
    );
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      if (looksLikeAkamaiBlock(res.status, body)) {
        throw new Error(
          `war-gov: Akamai block on ${landingUrl} (status ${res.status}). ` +
          `The direct path can't bypass TLS fingerprinting; start the MCP daemon ` +
          `(npm start --prefix pursue-vision-mcp) and re-run.`
        );
      }
      throw new Error(`war-gov: landing page fetch failed (status ${res.status})`);
    }
    if (looksLikeAkamaiBlock(200, body)) {
      throw new Error(
        `war-gov: Akamai challenge body on ${landingUrl}. ` +
        `Start the MCP daemon and clear the challenge in a real browser tab.`
      );
    }
    html = body;
  } catch (e) {
    // Re-throw Akamai errors clearly; let network errors bubble too.
    throw new Error(`war-gov: index discovery failed — ${e.message || e}`);
  }
  const scraped = scrapeAnchorsForRelease(html, releaseN, baseUrl);
  if (scraped.length) {
    return scraped.map(r => normalizeRecord(r, baseUrl)).filter(Boolean);
  }

  throw new Error(
    `war-gov: could not locate a release-${releaseN} file index via direct fetch. ` +
    `Tried ${INDEX_CANDIDATE_PATHS.length} candidate paths + landing-page DOM scrape. ` +
    `If the daemon is available, run with --prefer-mcp; otherwise inspect ${landingUrl} ` +
    `manually and extend INDEX_CANDIDATE_PATHS.`
  );
}

async function renameAtomic(src, dest) {
  try { await rename(src, dest); }
  catch {
    await new Promise(r => setTimeout(r, 100));
    await rename(src, dest);
  }
}

/**
 * Download a single war.gov asset via Node-side fetch.
 * Big files use HTTP Range requests in 8 MB chunks streamed straight to
 * disk; small/no-range files use a one-shot GET.
 *
 * Throws on Akamai block so we never write a challenge HTML body to disk
 * pretending it's a PDF.
 */
export async function downloadFileDirect({
  url,
  destPath,
  timeoutMs = DOWNLOAD_TIMEOUT_DEFAULT,
  onProgress,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!url) throw new Error("downloadFileDirect: url required");
  if (!destPath) throw new Error("downloadFileDirect: destPath required");

  await mkdir(path.dirname(destPath), { recursive: true });
  const partPath = destPath + ".part";
  await rm(partPath, { force: true });

  const t0 = Date.now();

  // Probe with a tiny Range request to learn size + range support.
  const probe = await fetchWithTimeout(
    fetchImpl, url,
    { headers: { ...BROWSER_HEADERS, Range: "bytes=0-0" } },
    INDEX_LOAD_TIMEOUT,
  );
  if (!probe.ok && probe.status !== 206) {
    const body = await probe.text().catch(() => "");
    if (looksLikeAkamaiBlock(probe.status, body)) {
      throw new Error(`war-gov: Akamai block on probe of ${url} (status ${probe.status})`);
    }
    throw new Error(`war-gov: probe failed for ${url} (status ${probe.status})`);
  }
  // Discard probe body to free the connection.
  await probe.arrayBuffer().catch(() => {});

  const contentRange = probe.headers.get("content-range");
  const contentLength = probe.headers.get("content-length");
  const acceptRanges = (probe.headers.get("accept-ranges") || "").toLowerCase();
  let totalBytes = null;
  const m = (contentRange || "").match(/\/(\d+)$/);
  if (m) totalBytes = Number(m[1]);
  else if (contentLength) totalBytes = Number(contentLength);
  const rangesOk = acceptRanges.includes("bytes") || !!contentRange;

  // Small / no-range path: stream the whole body to disk in one GET.
  if (!totalBytes || totalBytes <= LARGE_FILE_THRESHOLD || !rangesOk) {
    if (totalBytes && totalBytes > LARGE_FILE_THRESHOLD && !rangesOk) {
      throw new Error(
        `war-gov: ${url} is ${(totalBytes / 1024 / 1024).toFixed(1)} MB and the server ` +
        `did not advertise byte ranges; refusing one-shot transfer.`
      );
    }
    const res = await fetchWithTimeout(
      fetchImpl, url, { headers: BROWSER_HEADERS }, timeoutMs,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (looksLikeAkamaiBlock(res.status, body)) {
        throw new Error(`war-gov: Akamai block on ${url} (status ${res.status})`);
      }
      throw new Error(`war-gov: fetch failed for ${url} (status ${res.status})`);
    }
    if (!res.body) {
      // Some fetch impls give no body stream — fall back to buffered write.
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(partPath, buf);
    } else {
      await pipeline(Readable.fromWeb(res.body), createWriteStream(partPath));
    }
    await renameAtomic(partPath, destPath);
    const { size } = await import("node:fs/promises").then(m => m.stat(destPath));
    if (onProgress) onProgress({ bytes: size, total: size, done: true });
    return { bytes: size, durationMs: Date.now() - t0 };
  }

  // Big file → range-chunk to disk.
  const stream = createWriteStream(partPath, { flags: "w" });
  let writtenBytes = 0;
  try {
    for (let start = 0; start < totalBytes; start += CHUNK_BYTES) {
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(
          `war-gov: download timeout after ${timeoutMs}ms (got ${writtenBytes}/${totalBytes} bytes)`,
        );
      }
      const end = Math.min(start + CHUNK_BYTES - 1, totalBytes - 1);
      const res = await fetchWithTimeout(
        fetchImpl, url,
        { headers: { ...BROWSER_HEADERS, Range: `bytes=${start}-${end}` } },
        INDEX_LOAD_TIMEOUT,
      );
      if (!res.ok && res.status !== 206) {
        const body = await res.text().catch(() => "");
        if (looksLikeAkamaiBlock(res.status, body)) {
          throw new Error(`war-gov: Akamai block on Range ${start}-${end} of ${url}`);
        }
        throw new Error(`war-gov: Range ${start}-${end} failed — status ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== (end - start + 1)) {
        // Some CDNs ignore Range and send the whole body on the first
        // request. If that's the case on chunk 0, just take it and stop.
        if (start === 0 && buf.length === totalBytes) {
          if (!stream.write(buf)) await new Promise(r => stream.once("drain", r));
          writtenBytes = buf.length;
          break;
        }
        throw new Error(
          `war-gov: short chunk at bytes=${start}-${end} (got ${buf.length}, expected ${end - start + 1})`,
        );
      }
      if (!stream.write(buf)) await new Promise(r => stream.once("drain", r));
      writtenBytes += buf.length;
      if (onProgress) onProgress({ bytes: writtenBytes, total: totalBytes, done: false });
    }
  } catch (e) {
    stream.destroy();
    try { await rm(partPath, { force: true }); } catch {}
    throw e;
  }
  await new Promise((resolve, reject) => stream.end(err => err ? reject(err) : resolve()));
  await renameAtomic(partPath, destPath);
  if (onProgress) onProgress({ bytes: writtenBytes, total: totalBytes, done: true });
  return { bytes: writtenBytes, durationMs: Date.now() - t0 };
}

// Exposed for tests + the sync script's filter logic.
export const _internals = {
  INDEX_CANDIDATE_PATHS,
  recordMatchesRelease,
  normalizeRecord,
  looksLikeAkamaiBlock,
  parseCsv,
  scrapeAnchorsForRelease,
};
