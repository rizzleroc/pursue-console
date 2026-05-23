// scripts/lib/pdfjs-assets.mjs
//
// Spin up a tiny localhost HTTP server that vends the pdfjs-dist runtime
// assets (wasm + standard fonts) so pdfjs's worker fetch (`isValidFetchUrl`)
// accepts them. pdfjs rejects `file://` URLs, so the assets MUST be served
// over http/https even when we're running entirely locally — that's why
// this exists.
//
// Returns an object with the two URLs the pdfjs `getDocument({ wasmUrl,
// standardFontDataUrl })` call expects, plus the `server` instance so the
// caller can `.close()` it on shutdown if it wants to. We don't bother
// closing in the current callers because Node's process exit reclaims the
// port; the export is there for future long-lived consumers.
//
// API:
//   const { wasmUrl, standardFontDataUrl, server } = await getPdfjsAssetUrls();
//
// MUST be awaited — picks an ephemeral port via listen(0) which is async.
//
// Re-extracted from scripts/volunteer.mjs (was inline; the harden-volunteer-
// client branch extracted it but forgot to commit this file — surfaced by
// the 2026-05-22 punchlist follow-up).

import http from "node:http";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/lib/ -> project root is two up
const ROOT = path.resolve(__dirname, "..", "..");
const PDFJS_DIST_DIR = path.join(ROOT, "node_modules", "pdfjs-dist");

export async function getPdfjsAssetUrls() {
  const server = http.createServer((req, res) => {
    // path jail: only serve files inside node_modules/pdfjs-dist
    const safePath = path.normalize(decodeURIComponent(req.url || "/"))
      .replace(/^[/\\]+/, "");
    const filePath = path.join(PDFJS_DIST_DIR, safePath);
    if (!filePath.startsWith(PDFJS_DIST_DIR + path.sep) && filePath !== PDFJS_DIST_DIR) {
      res.writeHead(403); return res.end();
    }
    const ct = filePath.endsWith(".wasm")
      ? "application/wasm"
      : "application/octet-stream";
    res.writeHead(200, { "Content-Type": ct });
    createReadStream(filePath).on("error", () => res.end()).pipe(res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  // Without unref(), the listening socket keeps the event loop alive, and on
  // Windows process.exit() can hit a libuv UV_HANDLE_CLOSING race tearing down
  // an unused listener (Assertion failed in src\win\async.c → exit 3221226505).
  server.unref();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    wasmUrl: `${base}/wasm/`,
    standardFontDataUrl: `${base}/standard_fonts/`,
    server,
  };
}
