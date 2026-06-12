// Decode a whipgen_web_eval base64 PDF response and write it to disk.
//
// Usage:  node scripts/decode-whipgen-pdf.mjs <tool-result-path> <out-path>
//
// Reads the file at <tool-result-path> (saved by Claude Code when an MCP
// response is too large for the context window), extracts result.value
// (a JSON-stringified { ok, status, size, base64 }), decodes the base64,
// and writes the bytes to <out-path>.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const [resultPath, outPath] = process.argv.slice(2);
if (!resultPath || !outPath) {
  console.error("usage: node scripts/decode-whipgen-pdf.mjs <tool-result-path> <out-path>");
  process.exit(2);
}

const raw = await readFile(resultPath, "utf8");
const j = JSON.parse(raw);
if (j.status !== "done") {
  console.error(`job not done: status=${j.status} error=${(j.error || "").slice(0, 200)}`);
  process.exit(1);
}
const v = JSON.parse(j.result.value);
if (!v.ok) {
  console.error(`fetch failed: httpStatus=${v.status}`);
  process.exit(1);
}
const buf = Buffer.from(v.base64, "base64");
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, buf);
console.log(`wrote ${outPath} (${buf.length} bytes, httpStatus=${v.status})`);
