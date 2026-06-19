// Decode multiple whipgen_web_eval Range-chunk responses and assemble
// them into a single PDF on disk.
//
// Usage:
//   node scripts/decode-whipgen-pdf-chunks.mjs <out-path> <tool-result-path-1> [<tool-result-path-2> ...]
//
// Each <tool-result-path> is a saved Claude Code MCP tool result containing
// a whipgen_web_eval Range fetch ({ok, status, size, base64} as result.value).
// The chunks are decoded in order and concatenated. Use this for PDFs that
// exceed WHIP's 8 MB result cap.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const [outPath, ...resultPaths] = process.argv.slice(2);
if (!outPath || !resultPaths.length) {
  console.error("usage: node scripts/decode-whipgen-pdf-chunks.mjs <out-path> <tool-result-path-1> [<path-2> ...]");
  process.exit(2);
}

const buffers = [];
for (const p of resultPaths) {
  const raw = await readFile(p, "utf8");
  const j = JSON.parse(raw);
  // Support both whipgen_job_status format {status,result.value} and
  // synchronous whipgen_web_eval format {value} (no status wrapper).
  let valueStr;
  if (j.status !== undefined) {
    if (j.status !== "done") {
      console.error(`job not done for ${p}: status=${j.status}`);
      process.exit(1);
    }
    valueStr = j.result.value;
  } else if (j.value !== undefined) {
    valueStr = j.value;
  } else {
    console.error(`unrecognised result format for ${p}`);
    process.exit(1);
  }
  const v = JSON.parse(valueStr);
  if (!v.ok) {
    console.error(`fetch failed for ${p}: httpStatus=${v.status}`);
    process.exit(1);
  }
  buffers.push(Buffer.from(v.base64, "base64"));
}

const final = Buffer.concat(buffers);
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, final);
console.log(`wrote ${outPath} (${final.length} bytes from ${buffers.length} chunks)`);
