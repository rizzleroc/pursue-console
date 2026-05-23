// pursue-vision-mcp · war.gov driver
//
// @unverified — scaffold only. Never run end-to-end against a real
// www.war.gov tab; the maintainer's Chrome is the first live test. The
// Akamai TLS fingerprinting on war.gov blocks every Node-side HTTP client
// (curl, wget, Playwright `page.request`, native `fetch`); the ONLY path
// that works is an in-page `fetch()` call evaluated INSIDE a page already
// loaded on the war.gov origin, because the request inherits the real
// browser's TLS handshake.
//
// What this driver does:
//   - Connects to the user's logged-in Chrome via CDP (same pattern as
//     chatgpt-driver.mjs / gemini-driver.mjs).
//   - Finds or opens a https://www.war.gov/UFO/ tab.
//   - `fetchIndex({ release })` returns the list of release files for
//     'release_1' / 'release_2', figured out by trying three strategies
//     in order (network intercept → DOM scrape → likely index URLs).
//   - `downloadFile({ url, destPath })` pulls a single release asset via
//     in-page `fetch()`, base64-shuttling bytes from the browser into
//     Node and writing them to disk. Files >50 MB use HTTP Range
//     requests in 8 MB chunks so we don't blow up the browser memory.
//
// What this driver deliberately does NOT do:
//   - No retry-on-rate-limit dance (Akamai's response to "too eager" is
//     a hard challenge page; we throw and let the human re-solve).
//   - No streaming-to-disk in the page context (the Response.body
//     ReadableStream can't cross page.evaluate; we base64 in chunks).
//   - No HEAD-then-GET dance (the server's `Content-Length` on a 200
//     plus a Range capability check is enough).
//
// Reference for the technique (NOT copied — license is NOASSERTION):
// the vfp2/pursue-ufo-files README documents that war.gov/UFO/ exposes
// a records index loadable via the same in-page fetch trick. We
// reimplement from scratch by trying multiple discovery strategies.

import { chromium } from "playwright";
import { mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";

const CONNECT_TIMEOUT = 30_000;
const INDEX_LOAD_TIMEOUT = 30_000;
const DOWNLOAD_TIMEOUT_DEFAULT = 30 * 60_000;   // 30 min — videos are big
const CHUNK_BYTES = 8 * 1024 * 1024;            // 8 MB — fits comfortably
                                                // in a single base64 round-trip
const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024;  // >50 MB → use Range chunks

// Heuristics for "Akamai blocked this request" — when the in-page fetch
// comes back with a 403/406/429 OR an obvious challenge page body, we
// throw so we don't write a garbage HTML payload to disk pretending it's
// a PDF. The maintainer can then re-solve the challenge in their browser.
// Mirrors the spirit of UPLOAD_FAILURE_PATTERNS in the other drivers.
const AKAMAI_BLOCK_STATUS = new Set([403, 406, 429, 503]);
const AKAMAI_BODY_PATTERNS = [
  /access\s+denied/i,
  /reference\s*#\s*\d+\.[0-9a-f]+/i,    // Akamai "Reference #..." block page
  /pardon\s+our\s+interruption/i,        // Imperva-style challenge
  /www\.war\.gov\s+blocked\b/i,
];

// Likely index URLs to try as a last resort. The site is documented to
// have a CSV-or-JSON index of all release files; we try the common
// shapes. If none of these work, the live test will surface the real
// path and we patch this list.
const INDEX_CANDIDATE_PATHS = [
  "/UFO/api/records",
  "/UFO/api/records.json",
  "/UFO/api/files",
  "/UFO/index.json",
  "/UFO/records.json",
  "/UFO/records.csv",
  "/UFO/manifest.json",
];

// What "matches a release" looks like in a record. We accept either:
//   - a `release` field equal to 'release_1' / '1' / 1
//   - a URL/path that contains '/release_1/' (the documented pattern)
// The maintainer can refine this after the first live run shows what
// shape the real index actually has.
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

// Normalize a record into our shape. The real index probably uses
// different field names than we guess; this normalizer is the single
// place to extend when the live response shape lands.
function normalizeRecord(rec) {
  const url = rec.url || rec.href || rec.file_url || rec.download_url || rec.path;
  if (!url) return null;
  // Absolute-ize. The index may give us '/medialink/ufo/release_2/foo.pdf'.
  const absUrl = url.startsWith("http")
    ? url
    : new URL(url, "https://www.war.gov/").href;
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

export class WarGovDriver {
  constructor({ cdpPort = 9222 } = {}) {
    this.cdpPort = cdpPort;
    this.browser = null;
    this.page = null;
    this.callCount = 0;
    // Cache the first successful index endpoint so we don't have to
    // re-discover it on every fetch. Reset on disconnect.
    this._indexCache = null;
  }
  isConnected() { return !!this.page && !this.page.isClosed?.(); }

  async connect() {
    if (this.isConnected()) return;
    if (!this.browser) {
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`);
    }
    // Find an existing war.gov/UFO/ tab across all contexts; else open one.
    let found = null;
    for (const ctx of this.browser.contexts()) {
      for (const p of ctx.pages()) {
        if (/^https?:\/\/(www\.)?war\.gov\//i.test(p.url())) { found = p; break; }
      }
      if (found) break;
    }
    if (!found) {
      const ctx = this.browser.contexts()[0];
      if (!ctx) throw new Error("no Chrome context found over CDP");
      found = await ctx.newPage();
      await found.goto("https://www.war.gov/UFO/", {
        waitUntil: "domcontentloaded",
        timeout: CONNECT_TIMEOUT,
      });
    }
    this.page = found;
    // Make sure we're on the UFO landing page so the network intercept +
    // DOM scrape strategies have something to work with. If the tab is
    // already deep in a sub-page that's fine — we only need the origin.
    const u = this.page.url();
    if (!/war\.gov\/UFO\b/i.test(u)) {
      try {
        await this.page.goto("https://www.war.gov/UFO/", {
          waitUntil: "domcontentloaded",
          timeout: CONNECT_TIMEOUT,
        });
      } catch {
        // Leave the tab where it is; the user may be solving an Akamai
        // challenge and a forced navigation would break that.
      }
    }
  }

  async disconnect() {
    try { if (this.browser) await this.browser.close(); } catch {}
    this.browser = null;
    this.page = null;
    this._indexCache = null;
  }

  /**
   * Fetch the war.gov release-files index, filtered to one release.
   * Returns an array of { filename, url, agency, type, sizeBytes? }.
   *
   * Strategy order:
   *   1. Network intercept on a fresh page load. If the site loads its
   *      records via an XHR we can capture, that's the most reliable
   *      shape because we don't have to guess the URL.
   *   2. DOM scrape — many DoW microsites render their file lists
   *      server-side into a <table> or <a href="/medialink/..."> list.
   *   3. Probe likely index URLs (`/UFO/api/records`, `/UFO/index.json`,
   *      etc.) via in-page fetch.
   *
   * Whichever yields records first wins; subsequent calls reuse the
   * cached endpoint via `_indexCache`.
   */
  async fetchIndex({ release }) {
    if (!this.isConnected()) await this.connect();
    const releaseN = Number(String(release).replace(/^release[_-]?/i, ""));
    if (!Number.isInteger(releaseN) || releaseN < 1) {
      throw new Error(`fetchIndex: invalid release '${release}' (expected '1', '2', 'release_2', etc.)`);
    }
    this.callCount++;

    // (3a) Cached endpoint — re-use the URL that worked last time.
    if (this._indexCache?.url) {
      const cached = await this._tryFetchIndexUrl(this._indexCache.url);
      if (cached?.length) {
        return cached.filter(r => recordMatchesRelease(r, releaseN))
                     .map(normalizeRecord).filter(Boolean);
      }
    }

    // (1) Network intercept — reload the UFO page and watch for any
    //     JSON or CSV traffic that looks like a records index. We bound
    //     the wait so a page with no XHR doesn't hang the call.
    let intercepted = null;
    try {
      const respP = this.page.waitForResponse(
        r => {
          const u = r.url();
          if (!/war\.gov\/UFO\//i.test(u) && !/war\.gov\/api\//i.test(u)) return false;
          const ct = (r.headers()["content-type"] || "").toLowerCase();
          if (!ct.includes("json") && !ct.includes("csv")) return false;
          // Avoid grabbing the HTML page itself (some servers send text/html
          // with a `, charset=utf-8` and we wouldn't want to parse that).
          return r.request().resourceType() !== "document";
        },
        { timeout: INDEX_LOAD_TIMEOUT }
      ).catch(() => null);
      // Trigger any lazy-load by re-navigating. We use 'domcontentloaded'
      // (not 'load') so a heavy site doesn't waste our timeout budget.
      await this.page.reload({ waitUntil: "domcontentloaded", timeout: CONNECT_TIMEOUT }).catch(() => {});
      const resp = await respP;
      if (resp) {
        const url = resp.url();
        const ct = (resp.headers()["content-type"] || "").toLowerCase();
        const body = await resp.text();
        const records = ct.includes("csv") ? parseCsv(body) : safeParseJson(body);
        if (Array.isArray(records) && records.length) {
          intercepted = { url, records };
        }
      }
    } catch {
      // fall through to next strategy
    }
    if (intercepted) {
      this._indexCache = { url: intercepted.url, strategy: "intercept" };
      return intercepted.records
        .filter(r => recordMatchesRelease(r, releaseN))
        .map(normalizeRecord).filter(Boolean);
    }

    // (2) DOM scrape — many DoW pages render a file list as plain HTML.
    //     We look for anchors that match the documented release URL shape
    //     '/medialink/ufo/release_<n>/...'. If we find any, we synthesize
    //     records out of them (no agency/sizeBytes available this way).
    const scraped = await this.page.evaluate((releaseN) => {
      const tag = `/medialink/ufo/release_${releaseN}/`;
      const links = Array.from(document.querySelectorAll("a[href]"));
      const out = [];
      for (const a of links) {
        const href = a.getAttribute("href") || "";
        if (!href.toLowerCase().includes(tag.toLowerCase())) continue;
        // Build an absolute URL. <a> resolves automatically; use a.href.
        out.push({
          url: a.href,
          filename: decodeURIComponent(a.href.split("/").pop().split("?")[0]),
          // Best-effort agency guess from the surrounding cell text.
          agency: (a.closest("tr")?.innerText || "").split("\n").map(s => s.trim()).find(s => /^[A-Z]{2,}/.test(s)) || null,
        });
      }
      // Dedup by URL.
      const seen = new Set();
      return out.filter(r => (seen.has(r.url) ? false : (seen.add(r.url), true)));
    }, releaseN).catch(() => []);
    if (scraped.length) {
      this._indexCache = { url: this.page.url(), strategy: "dom" };
      return scraped.map(normalizeRecord).filter(Boolean);
    }

    // (3) Probe likely index URLs via in-page fetch.
    for (const candidatePath of INDEX_CANDIDATE_PATHS) {
      const candidateUrl = new URL(candidatePath, "https://www.war.gov/").href;
      const records = await this._tryFetchIndexUrl(candidateUrl);
      if (records?.length) {
        this._indexCache = { url: candidateUrl, strategy: "probe" };
        return records
          .filter(r => recordMatchesRelease(r, releaseN))
          .map(normalizeRecord).filter(Boolean);
      }
    }

    throw new Error(
      `war-gov: could not locate a release-${releaseN} file index. ` +
      `Tried network intercept, DOM scrape, and ${INDEX_CANDIDATE_PATHS.length} likely paths. ` +
      `Inspect www.war.gov/UFO/ in DevTools → Network and add the real index URL.`
    );
  }

  // Helper: fetch an index URL via in-page fetch + parse as JSON or CSV.
  // Returns the parsed array (records-of-objects), or null if the
  // response is unparseable / blocked / not a list.
  async _tryFetchIndexUrl(url) {
    let res;
    try {
      res = await this.page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: "include" });
        const text = await r.text();
        return {
          ok: r.ok,
          status: r.status,
          contentType: r.headers.get("content-type") || "",
          body: text,
        };
      }, url);
    } catch {
      return null;
    }
    if (!res.ok) return null;
    if (looksLikeAkamaiBlock(res.status, res.body)) {
      // Surface the block clearly — better to throw here than further
      // up where the caller might not realize the response was hostile.
      throw new Error(
        `war-gov: Akamai block on ${url} (status ${res.status}). ` +
        `Solve the challenge manually in the war.gov tab and re-run.`
      );
    }
    const ct = res.contentType.toLowerCase();
    let parsed = null;
    if (ct.includes("csv") || /\.csv(\?|$)/i.test(url)) parsed = parseCsv(res.body);
    else parsed = safeParseJson(res.body);
    if (!Array.isArray(parsed)) {
      // Sometimes the API wraps records under a key like { data: [...] }
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
   * Download a single war.gov file via in-page fetch. The bytes flow
   * Browser → (base64) → Node → disk. Big files use HTTP Range
   * requests in 8 MB chunks so we don't try to base64 a 2 GB video in
   * one shot.
   *
   * On Akamai block (403/429/challenge body), throws clearly so we
   * don't write the challenge HTML to disk and pretend it's a video.
   */
  async downloadFile({ url, destPath, timeoutMs = DOWNLOAD_TIMEOUT_DEFAULT, onProgress }) {
    if (!this.isConnected()) await this.connect();
    if (!url) throw new Error("downloadFile: url required");
    if (!destPath) throw new Error("downloadFile: destPath required");
    this.callCount++;

    await mkdir(path.dirname(destPath), { recursive: true });
    // Write to a .part file first so a crash mid-download doesn't leave
    // a half-baked file that looks complete to the next sync.
    const partPath = destPath + ".part";
    // Truncate any previous partial.
    await rm(partPath, { force: true });

    const t0 = Date.now();
    // Probe the file with a small Range request to learn the size and
    // whether the server honors ranges. Cheap; avoids a HEAD call (HEAD
    // sometimes returns different headers through Akamai than GET).
    const probe = await this.page.evaluate(async (u) => {
      try {
        const r = await fetch(u, {
          credentials: "include",
          headers: { Range: "bytes=0-0" },
        });
        return {
          ok: r.ok,
          status: r.status,
          contentLength: r.headers.get("content-length"),
          contentRange: r.headers.get("content-range"),
          acceptRanges: r.headers.get("accept-ranges"),
          contentType: r.headers.get("content-type") || "",
          // We don't need the 1-byte body; discard it.
        };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    }, url);
    if (!probe.ok) {
      throw new Error(`war-gov: probe failed for ${url} (${probe.status || probe.error || "unknown"})`);
    }
    if (looksLikeAkamaiBlock(probe.status, "")) {
      throw new Error(`war-gov: Akamai block on probe of ${url} (status ${probe.status})`);
    }
    // total bytes: prefer Content-Range "bytes 0-0/<total>", fall back to
    // Content-Length on the 206/200 single-byte response.
    let totalBytes = null;
    const m = (probe.contentRange || "").match(/\/(\d+)$/);
    if (m) totalBytes = Number(m[1]);
    else if (probe.contentLength) totalBytes = Number(probe.contentLength);
    const rangesOk = (probe.acceptRanges || "").toLowerCase().includes("bytes")
                  || !!probe.contentRange;

    // Small file OR server doesn't support ranges → one-shot fetch.
    // For one-shot, we still base64-shuttle the full body. >50 MB without
    // range support would be ugly, so we refuse rather than hang the
    // browser; the maintainer can revisit if war.gov really doesn't
    // support ranges on big assets.
    if (!totalBytes || (totalBytes <= LARGE_FILE_THRESHOLD || !rangesOk)) {
      if (!rangesOk && totalBytes && totalBytes > LARGE_FILE_THRESHOLD) {
        throw new Error(
          `war-gov: ${url} is ${(totalBytes / 1024 / 1024).toFixed(1)} MB and the server ` +
          `did not advertise byte ranges; refusing one-shot base64 transfer.`
        );
      }
      const got = await this._fetchOneShot(url, timeoutMs);
      await writeFile(partPath, got);
      await renameAtomic(partPath, destPath);
      if (onProgress) onProgress({ bytes: got.length, total: got.length, done: true });
      return { bytes: got.length, durationMs: Date.now() - t0 };
    }

    // Big file → stream in CHUNK_BYTES windows. We open the stream
    // here in Node and append base64-decoded buffers chunk by chunk.
    const stream = createWriteStream(partPath, { flags: "w" });
    let writtenBytes = 0;
    try {
      for (let start = 0; start < totalBytes; start += CHUNK_BYTES) {
        if (Date.now() - t0 > timeoutMs) {
          throw new Error(`war-gov: download timeout after ${timeoutMs}ms (got ${writtenBytes}/${totalBytes} bytes)`);
        }
        const end = Math.min(start + CHUNK_BYTES - 1, totalBytes - 1);
        const chunk = await this._fetchRangeBase64(url, start, end);
        if (!chunk) throw new Error(`war-gov: empty chunk at bytes=${start}-${end}`);
        const buf = Buffer.from(chunk, "base64");
        if (buf.length !== (end - start + 1)) {
          throw new Error(`war-gov: short chunk at bytes=${start}-${end} (got ${buf.length}, expected ${end - start + 1})`);
        }
        // Honor backpressure.
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

  // ---- internals ----

  async _fetchOneShot(url, timeoutMs) {
    // One-shot full-body fetch — base64-encoded to survive the Playwright
    // JSON bridge (which can't carry raw binary). For big assets we'd
    // chunk instead; this is gated by the caller above.
    const res = await this.page.evaluate(async ({ u, t }) => {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), t);
      try {
        const r = await fetch(u, { credentials: "include", signal: ctl.signal });
        const status = r.status;
        const ct = r.headers.get("content-type") || "";
        if (!r.ok) {
          const body = await r.text().catch(() => "");
          return { ok: false, status, contentType: ct, body };
        }
        const ab = await r.arrayBuffer();
        // base64-encode in the browser (the JSON bridge can't carry an
        // ArrayBuffer). For small files this is fine; LARGE_FILE_THRESHOLD
        // gates us off the giant-string path before we get here.
        let bin = "";
        const view = new Uint8Array(ab);
        const STEP = 0x8000;
        for (let i = 0; i < view.length; i += STEP) {
          bin += String.fromCharCode.apply(null, view.subarray(i, i + STEP));
        }
        return { ok: true, status, contentType: ct, base64: btoa(bin) };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      } finally {
        clearTimeout(to);
      }
    }, { u: url, t: timeoutMs });
    if (!res?.ok) {
      if (looksLikeAkamaiBlock(res?.status, res?.body)) {
        throw new Error(`war-gov: Akamai block on ${url} (status ${res?.status})`);
      }
      throw new Error(`war-gov: fetch failed for ${url} — ${res?.error || res?.status || "unknown"}`);
    }
    return Buffer.from(res.base64, "base64");
  }

  async _fetchRangeBase64(url, start, end) {
    const res = await this.page.evaluate(async ({ u, s, e }) => {
      try {
        const r = await fetch(u, {
          credentials: "include",
          headers: { Range: `bytes=${s}-${e}` },
        });
        if (!r.ok && r.status !== 206) {
          const body = await r.text().catch(() => "");
          return { ok: false, status: r.status, body };
        }
        const ab = await r.arrayBuffer();
        let bin = "";
        const view = new Uint8Array(ab);
        const STEP = 0x8000;
        for (let i = 0; i < view.length; i += STEP) {
          bin += String.fromCharCode.apply(null, view.subarray(i, i + STEP));
        }
        return { ok: true, base64: btoa(bin) };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    }, { u: url, s: start, e: end });
    if (!res?.ok) {
      if (looksLikeAkamaiBlock(res?.status, res?.body)) {
        throw new Error(`war-gov: Akamai block on Range ${start}-${end} of ${url}`);
      }
      throw new Error(`war-gov: Range ${start}-${end} failed — ${res?.error || res?.status || "unknown"}`);
    }
    return res.base64;
  }
}

// ---- module-level helpers (not driver methods, no `this`) ----

// Atomic rename, with a Windows-friendly fallback: Windows occasionally
// errors EPERM on a rename across same-volume directories if a process
// is briefly holding the source handle. We retry once.
async function renameAtomic(src, dest) {
  const { rename } = await import("node:fs/promises");
  try { await rename(src, dest); return; }
  catch (e) {
    await new Promise(r => setTimeout(r, 100));
    await rename(src, dest);
  }
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

// Minimal RFC4180-ish CSV parser — covers the war.gov-shaped indexes we
// expect (header row + N data rows, no nested objects, quoted fields
// allowed). Not a general CSV library; we just need it not to choke on
// a manifest that happens to be CSV instead of JSON.
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
