// Copy onnxruntime-web's WASM + JS variants into public/ort/ so the
// browser semantic-search loader can find them at runtime.
//
// Why: transformers.js v4 loads variant mjs/wasm files dynamically
// based on the browser's capability (asyncify / jsep / jspi / plain).
// Vite's static analysis emits only one variant by default, and the
// jsDelivr CDN only carries 1.22.0 stable while our installed version
// is 1.26.0-dev — variant filenames differ across versions. Self-host
// the exact files from node_modules to guarantee a version match.

import { mkdir, readdir, copyFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "node_modules/onnxruntime-web/dist");
const DST = path.join(ROOT, "public/ort");

await mkdir(DST, { recursive: true });
// Only the runtime variants transformers.js asks for — skip the
// alternate bundle entry-points (ort.all.mjs, ort.bundle.min.mjs, …)
// which would balloon the deploy from ~13 MB gz to ~90 MB.
const files = (await readdir(SRC)).filter(f => /^ort-wasm-.+\.(wasm|mjs)$/.test(f));
let bytes = 0;
for (const f of files) {
  await copyFile(path.join(SRC, f), path.join(DST, f));
  bytes += (await stat(path.join(DST, f))).size;
}
console.log(`[ort] copied ${files.length} runtime files (${(bytes/1024/1024).toFixed(1)} MB) → public/ort/`);
