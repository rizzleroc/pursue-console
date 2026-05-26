// pursue-vision-mcp · DVIDS driver
//
// @unverified — scaffold only. Never run end-to-end against a real
// www.dvidshub.net video page; the maintainer's Chrome is the first
// live test. DVIDS (dvidshub.net) returns ConnectionResetError(10054)
// to yt-dlp and Node-side HTTP clients — same flavor of TLS-fingerprint
// block that war.gov uses. The ONLY path that works is an in-page
// `fetch()` call evaluated INSIDE a page already loaded on the DVIDS
// origin, because the request inherits the real browser's TLS handshake.
//
// What this driver does:
//   - Connects to the user's logged-in Chrome via CDP (same pattern as
//     chatgpt-driver.mjs / gemini-driver.mjs / war-gov-driver.mjs).
//   - Finds or opens a https://www.dvidshub.net/ tab.
//   - `resolveVideoUrl({ videoId })` navigates to the video page for a
//     numeric DVIDS asset ID (e.g. 1006107) and extracts the direct mp4
//     URL. Tries three strategies in order:
//       (a) page.waitForResponse capturing the mp4 traffic on load,
//       (b) DOM scrape — <video src>, <source>, og:video meta, JSON-LD
//           VideoObject.contentUrl,
//       (c) parse embedded JSON in the page for videoUrl / playbackUrl /
//           similar keys.
//   - `downloadFile({ url, destPath })` pulls a single mp4 via in-page
//     `fetch()`, base64-shuttling bytes from the browser into Node and
//     writing them to disk. Files >50 MB use HTTP Range requests in 8 MB
//     chunks. Exact same shape as war-gov-driver.mjs#downloadFile.
//
// What this driver deliberately does NOT do:
//   - No yt-dlp fallback (that's what we're replacing; the user's
//     directive is "use the MCP").
//   - No streaming-to-disk in the page context (the Response.body
//     ReadableStream can't cross page.evaluate; we base64 in chunks).
//   - No generic DVIDS API client — only video pages. Other DVIDS asset
//     types (images, news, podcasts) are out of scope for this driver.
//
// DVIDS is a public DoD media distribution site; in normal operation
// there should be no challenge page. The Akamai-style block detection
// is reused defensively in case the CDN ever issues one.

import { chromium } from "playwright";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";

const CONNECT_TIMEOUT = 30_000;
const VIDEO_LOAD_TIMEOUT = 30_000;
const DOWNLOAD_TIMEOUT_DEFAULT = 30 * 60_000;   // 30 min — clips can be big
const CHUNK_BYTES = 8 * 1024 * 1024;            // 8 MB — fits comfortably
                                                // in a single base64 round-trip
const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024;  // >50 MB → use Range chunks

// Heuristics for "the CDN blocked this request" — when an in-page fetch
// comes back with a 403/406/429 OR an obvious challenge page body, we
// throw so we don't write a garbage HTML payload to disk pretending it's
// an mp4. Mirrors the same pattern war-gov-driver.mjs uses.
const BLOCK_STATUS = new Set([403, 406, 429, 503]);
const BLOCK_BODY_PATTERNS = [
  /access\s+denied/i,
  /reference\s*#\s*\d+\.[0-9a-f]+/i,    // Akamai "Reference #..." block page
  /pardon\s+our\s+interruption/i,        // Imperva-style challenge
  /\bforbidden\b/i,
];

// Match anything that looks like a DVIDS mp4 URL. The hosts we've seen
// in the wild include cdn.dvidshub.net, mediadl.dvidshub.net, and
// occasionally d34w7g4gy10iej.cloudfront.net. We accept any host that
// either matches dvidshub.net or ends in .mp4 served from a CDN that
// appears on the DVIDS page. Conservative on the suffix to avoid
// snagging ad-network video.
const MP4_URL_RE = /^https?:\/\/[^\s"'<>]+\.mp4(?:\?[^\s"'<>]*)?$/i;

function looksLikeMp4Url(u) {
  return typeof u === "string" && MP4_URL_RE.test(u);
}

export class DVIDSDriver {
  constructor({ cdpPort = 9222 } = {}) {
    this.cdpPort = cdpPort;
    this.browser = null;
    this.page = null;
    this.callCount = 0;
  }
  isConnected() { return !!this.page && !this.page.isClosed?.(); }

  async connect() {
    if (this.isConnected()) return;
    if (!this.browser) {
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`);
    }
    // Find an existing dvidshub.net tab across all contexts; else open one.
    let found = null;
    for (const ctx of this.browser.contexts()) {
      for (const p of ctx.pages()) {
        if (/^https?:\/\/(www\.)?dvidshub\.net\//i.test(p.url())) { found = p; break; }
      }
      if (found) break;
    }
    if (!found) {
      const ctx = this.browser.contexts()[0];
      if (!ctx) throw new Error("no Chrome context found over CDP");
      found = await ctx.newPage();
      await found.goto("https://www.dvidshub.net/", {
        waitUntil: "domcontentloaded",
        timeout: CONNECT_TIMEOUT,
      });
    }
    this.page = found;
  }

  async disconnect() {
    try { if (this.browser) await this.browser.close(); } catch {}
    this.browser = null;
    this.page = null;
  }

  /**
   * Resolve a DVIDS numeric video asset ID to its direct mp4 URL.
   *
   * Strategy order:
   *   1. Network intercept — start a `waitForResponse` for any *.mp4
   *      traffic, THEN navigate to the video page so the player's own
   *      request gets captured. Most reliable because the player
   *      knows which CDN host is currently serving the asset.
   *   2. DOM scrape — after the page settles, look at <video>, <source>,
   *      Open Graph `og:video`, and JSON-LD VideoObject.contentUrl.
   *   3. Regex over the page HTML for keys like `videoUrl`, `playbackUrl`,
   *      `mp4Url`, or a bare mp4 URL.
   *
   * Returns `{ videoId, title, mp4Url, durationSec?, sizeBytes? }`.
   * Throws if no mp4 URL can be found by any strategy.
   */
  async resolveVideoUrl({ videoId }) {
    if (!this.isConnected()) await this.connect();
    const idStr = String(videoId).trim();
    if (!/^\d+$/.test(idStr)) {
      throw new Error(`resolveVideoUrl: invalid videoId '${videoId}' (expected numeric DVIDS asset id)`);
    }
    this.callCount++;

    const pageUrl = `https://www.dvidshub.net/video/${idStr}`;
    // (1) Set up the network-intercept BEFORE navigating, so the player's
    //     own fetch of the mp4 gets caught. We bound the wait so a page
    //     with no mp4 traffic (e.g. a 404) doesn't hang us forever.
    const mp4P = this.page.waitForResponse(
      r => {
        const u = r.url();
        if (!looksLikeMp4Url(u)) return false;
        // The response code on a real video load is 200 or 206; reject
        // 403/404 here so we don't lock onto a blocked URL.
        const s = r.status();
        return s === 200 || s === 206;
      },
      { timeout: VIDEO_LOAD_TIMEOUT }
    ).catch(() => null);

    try {
      await this.page.goto(pageUrl, {
        waitUntil: "domcontentloaded",
        timeout: CONNECT_TIMEOUT,
      });
    } catch (e) {
      throw new Error(`dvids: navigation to ${pageUrl} failed — ${e.message}`);
    }

    // Title scrape happens regardless of which strategy lands the URL.
    const title = await this.page.evaluate(() => {
      // Prefer og:title (clean, no site suffix); fall back to <title>.
      const og = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
      if (og) return og.trim();
      const t = document.title || "";
      return t.replace(/\s*[-|]\s*DVIDS\b.*$/i, "").trim();
    }).catch(() => null);

    // (1) cont'd — race the intercept against the page settling.
    const resp = await mp4P;
    let mp4Url = null;
    if (resp) {
      mp4Url = resp.url();
    }

    // (2) DOM scrape — many DVIDS pages put the mp4 in a <video src> or a
    //     <source> child, in og:video meta, or in a JSON-LD VideoObject.
    if (!mp4Url) {
      mp4Url = await this.page.evaluate(() => {
        const pickMp4 = (u) => (typeof u === "string" && /\.mp4(\?|$)/i.test(u)) ? u : null;
        // <video src>
        for (const v of document.querySelectorAll("video[src]")) {
          const hit = pickMp4(v.getAttribute("src"));
          if (hit) return hit;
        }
        // <source> children of any media element
        for (const s of document.querySelectorAll("video source[src], audio source[src]")) {
          const hit = pickMp4(s.getAttribute("src"));
          if (hit) return hit;
        }
        // Open Graph og:video / og:video:url / og:video:secure_url
        for (const sel of [
          'meta[property="og:video"]',
          'meta[property="og:video:url"]',
          'meta[property="og:video:secure_url"]',
        ]) {
          const v = document.querySelector(sel)?.getAttribute("content");
          const hit = pickMp4(v);
          if (hit) return hit;
        }
        // JSON-LD — find VideoObject and read its contentUrl.
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const parsed = JSON.parse(s.textContent || "null");
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of items) {
              if (!item || typeof item !== "object") continue;
              const ty = item["@type"];
              const isVideo = ty === "VideoObject" || (Array.isArray(ty) && ty.includes("VideoObject"));
              if (!isVideo) continue;
              for (const key of ["contentUrl", "url", "embedUrl"]) {
                const hit = pickMp4(item[key]);
                if (hit) return hit;
              }
            }
          } catch { /* ignore one bad block */ }
        }
        return null;
      }).catch(() => null);
    }

    // (3) Regex over the raw page HTML. Some DVIDS pages embed the
    //     player config as inline JS / JSON under keys like videoUrl,
    //     playbackUrl, mp4Url, or just leave a bare mp4 URL in the markup.
    let durationSec = null;
    let sizeBytes = null;
    if (!mp4Url) {
      const html = await this.page.content().catch(() => "");
      // Common keyed patterns first.
      const keyedRe = /"(?:videoUrl|playbackUrl|mp4Url|videoFile|file)"\s*:\s*"([^"]+\.mp4[^"]*)"/i;
      const m = html.match(keyedRe);
      if (m) mp4Url = m[1].replace(/\\\//g, "/");
      // Fall back to the first bare mp4 URL on the page.
      if (!mp4Url) {
        const bareRe = /(https?:\/\/[^"'<>\s]+\.mp4(?:\?[^"'<>\s]*)?)/i;
        const m2 = html.match(bareRe);
        if (m2) mp4Url = m2[1].replace(/\\\//g, "/");
      }
      // Best-effort duration scrape from JSON-LD or meta tags. The
      // dvidshub.net VideoObject usually carries an ISO 8601 duration.
      const durMatch = html.match(/"duration"\s*:\s*"(PT[^"]+)"/);
      if (durMatch) durationSec = isoDurationToSec(durMatch[1]);
      const sizeMatch = html.match(/"contentSize"\s*:\s*"?(\d+)"?/);
      if (sizeMatch) sizeBytes = Number(sizeMatch[1]);
    }

    if (!mp4Url || !looksLikeMp4Url(mp4Url)) {
      throw new Error(
        `dvids: could not find an mp4 URL for video ${idStr}. ` +
        `Tried network intercept, DOM scrape (<video>/<source>/og:video/JSON-LD), and inline-JSON regex. ` +
        `Inspect ${pageUrl} in DevTools → Network and patch the strategies in dvids-driver.mjs.`
      );
    }
    return { videoId: idStr, title, mp4Url, durationSec, sizeBytes };
  }

  /**
   * Download a single DVIDS mp4 via in-page fetch. The bytes flow
   * Browser → (base64) → Node → disk. Big files use HTTP Range
   * requests in 8 MB chunks so we don't try to base64 a 2 GB video in
   * one shot.
   *
   * On Akamai-style block (403/429/challenge body), throws clearly so
   * we don't write challenge HTML to disk and pretend it's an mp4.
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
    // can return different headers through a CDN than GET).
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
      throw new Error(`dvids: probe failed for ${url} (${probe.status || probe.error || "unknown"})`);
    }
    if (looksLikeBlock(probe.status, "")) {
      throw new Error(`dvids: CDN block on probe of ${url} (status ${probe.status})`);
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
    // browser; the maintainer can revisit if DVIDS really doesn't
    // support ranges on big assets.
    if (!totalBytes || (totalBytes <= LARGE_FILE_THRESHOLD || !rangesOk)) {
      if (!rangesOk && totalBytes && totalBytes > LARGE_FILE_THRESHOLD) {
        throw new Error(
          `dvids: ${url} is ${(totalBytes / 1024 / 1024).toFixed(1)} MB and the server ` +
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
          throw new Error(`dvids: download timeout after ${timeoutMs}ms (got ${writtenBytes}/${totalBytes} bytes)`);
        }
        const end = Math.min(start + CHUNK_BYTES - 1, totalBytes - 1);
        const chunk = await this._fetchRangeBase64(url, start, end);
        if (!chunk) throw new Error(`dvids: empty chunk at bytes=${start}-${end}`);
        const buf = Buffer.from(chunk, "base64");
        if (buf.length !== (end - start + 1)) {
          throw new Error(`dvids: short chunk at bytes=${start}-${end} (got ${buf.length}, expected ${end - start + 1})`);
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
      if (looksLikeBlock(res?.status, res?.body)) {
        throw new Error(`dvids: CDN block on ${url} (status ${res?.status})`);
      }
      throw new Error(`dvids: fetch failed for ${url} — ${res?.error || res?.status || "unknown"}`);
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
      if (looksLikeBlock(res?.status, res?.body)) {
        throw new Error(`dvids: CDN block on Range ${start}-${end} of ${url}`);
      }
      throw new Error(`dvids: Range ${start}-${end} failed — ${res?.error || res?.status || "unknown"}`);
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

function looksLikeBlock(status, body) {
  if (status && BLOCK_STATUS.has(Number(status))) return true;
  if (typeof body === "string") {
    for (const re of BLOCK_BODY_PATTERNS) if (re.test(body)) return true;
  }
  return false;
}

// ISO 8601 duration ("PT1M30S") → seconds. Best-effort: returns null on
// anything we can't parse. Used only for the resolveVideoUrl response.
function isoDurationToSec(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!m) return null;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const sec = Number(m[3] || 0);
  return h * 3600 + min * 60 + sec;
}
