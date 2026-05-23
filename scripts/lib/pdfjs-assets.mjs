// scripts/lib/pdfjs-assets.mjs
//
// Returns the URLs pdfjs-dist's `getDocument({ wasmUrl, standardFontDataUrl })`
// call expects.
//
// IMPORTANT: pdfjs-dist's NodeBinaryDataFactory reads these "URLs" via
// `fs.readFile(url + filename)` — it does NOT fetch over HTTP and does NOT
// accept file:// strings on Windows. So in Node we hand back ABSOLUTE
// FILESYSTEM PATHS with forward-slash separators (fs.readFile accepts those
// on both POSIX and Windows). Earlier versions spun up a tiny localhost HTTP
// server on an ephemeral port; pdfjs in Node never used it (every font fetch
// failed silently with "Unable to load font data") AND the idle listening
// socket caused a libuv UV_HANDLE_CLOSING assertion on Windows when the
// volunteer exited fast (exit code 3221226505).
//
// The `server` return value is kept as a no-op shim so existing callers that
// call `server.close()` / `server.unref()` don't need to be touched.
//
// API:
//   const { wasmUrl, standardFontDataUrl, server } = await getPdfjsAssetUrls();

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/lib/ -> project root is two up
const ROOT = path.resolve(__dirname, "..", "..");
const PDFJS_DIST_DIR = path.join(ROOT, "node_modules", "pdfjs-dist");

// pdfjs concatenates `${baseUrl}${filename}` — baseUrl must end with the
// directory separator. Using "/" works on Windows too (fs.readFile accepts
// mixed separators), and avoids a backslash in a string that some pdfjs
// internals later re-process as a URL substring.
function dirAsBase(p) {
  return p.split(path.sep).join("/") + "/";
}

const NOOP_SERVER = Object.freeze({
  close(cb) { if (typeof cb === "function") cb(); },
  unref() {},
});

export async function getPdfjsAssetUrls() {
  return {
    wasmUrl: dirAsBase(path.join(PDFJS_DIST_DIR, "wasm")),
    standardFontDataUrl: dirAsBase(path.join(PDFJS_DIST_DIR, "standard_fonts")),
    server: NOOP_SERVER,
  };
}
