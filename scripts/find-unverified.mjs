// Walk scripts/ + src/ for `@unverified` annotations. The convention:
// when a code path is shipped but has never been exercised end-to-end
// against a real input (e.g. a freshly-ported driver, a new validator
// branch, a flow that's only had `node --check` against it), mark it
// in a comment:
//
//   // @unverified — never run against a real Gemini round-trip via
//                    the bundled MCP. Selectors may have drifted.
//
// This script greps for those, prints the list, and exits non-zero if
// any are found (so CI or a contributor can see the surface area of
// untested promises in one shot).
//
//   node scripts/find-unverified.mjs           # report
//   node scripts/find-unverified.mjs --silent  # exit code only

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SILENT = process.argv.includes("--silent");
const ROOTS = [path.join(ROOT, "scripts"), path.join(ROOT, "src"), path.join(ROOT, "pursue-vision-mcp")];

async function walk(dir, out = []) {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) await walk(fp, out);
    else if (/\.(mjs|js|jsx|ts|tsx|py)$/.test(e.name)) out.push(fp);
  }
  return out;
}

// Exclude the scanner itself + any test files that match the marker
// while documenting it. Anything that demonstrates the @unverified
// convention isn't itself unverified code.
const SELF_PATHS = new Set([
  path.resolve(__filename).replaceAll("\\", "/"),
]);
const files = (await Promise.all(ROOTS.map(r => walk(r)))).flat()
  .filter(f => !SELF_PATHS.has(f.replaceAll("\\", "/")));
const findings = [];
for (const f of files) {
  let content;
  try { content = await readFile(f, "utf8"); } catch { continue; }
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/@unverified\b/.test(lines[i])) {
      // grab the comment block: the @unverified line + any following
      // comment lines (lines starting with //)
      const note = [lines[i]];
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        if (/^\s*\/\//.test(lines[j])) note.push(lines[j]);
        else break;
      }
      findings.push({
        file: path.relative(ROOT, f).replaceAll("\\", "/"),
        line: i + 1,
        note: note.map(l => l.trim()).join(" ").replace(/\/\/\s*/g, "").replace(/@unverified\s*[-—]?\s*/, ""),
      });
    }
  }
}

if (!SILENT) {
  console.log(`\n[unverified] ${findings.length} annotation${findings.length === 1 ? "" : "s"} across ${files.length} source files`);
  if (findings.length) {
    console.log(`\nThese code paths have been shipped but never exercised end-to-end:\n`);
    for (const f of findings) {
      console.log(`  ${f.file}:${f.line}`);
      console.log(`    ${f.note}`);
      console.log();
    }
    console.log(`These are surface area for confidence — each one is a promise the project makes that hasn't been tested. Pick one and verify it.\n`);
  } else {
    console.log(`\n[unverified] clean — every code path with the annotation has been verified and the comment removed.\n`);
  }
}
process.exit(findings.length > 0 ? 1 : 0);
