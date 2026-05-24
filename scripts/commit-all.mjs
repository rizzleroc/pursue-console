// Unified commit script — commits whatever's pending across OCR, review,
// and visuals into their own PRs. One COMMIT button in the dashboard drives
// this regardless of which job the volunteer just ran.
//
// Why per-source instead of one big PR: the three sources have different
// reviewer expectations (OCR judged by JUDGE-STANDARD, review pages are
// human-typed canonical, visuals carry images). Mixing them in one PR
// makes review awkward and CI status confusing. Per-source PRs let
// each get the right treatment.
//
// Why temp-index instead of `git checkout -b`: the working tree is shared
// with the user's editor and other tooling (monitor cockpit, sparse-checkout).
// Branching with checkout flooded the runner log with sparse-checkout "M …"
// warnings, occasionally left the tree stranded on an orphan contrib branch
// when push failed, and could include unrelated build artifacts. Building
// the commit off `origin/main` via GIT_INDEX_FILE + read-tree + commit-tree
// produces a clean diff with zero working-tree side effects.
//
// Visuals still shell out to volunteer-media.mjs --commit because that path
// already does template validation, image normalization, and staging cleanup
// — duplicating that here would drift.
//
// Usage:
//   node scripts/commit-all.mjs --my-handle=YOU              # commit everything pending
//   node scripts/commit-all.mjs --my-handle=YOU --sources=ocr,review  # subset
//   node scripts/commit-all.mjs --my-handle=YOU --dry-run    # show what would happen

import { readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

const HANDLE = args["my-handle"] || process.env.GITHUB_USER || "";
if (!HANDLE) {
  console.error("[commit-all] --my-handle=<github-handle> required");
  process.exit(1);
}
const DRY = !!args["dry-run"];
const REQUESTED_SOURCES = String(args.sources || "ocr,review,visuals").split(",").map(s => s.trim()).filter(Boolean);

function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, argv, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32", ...opts });
    c.on("error", reject);
    c.on("exit", code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}
function capture(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, argv, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", ...opts });
    let out = "", err = "";
    c.stdout.on("data", d => out += d);
    c.stderr.on("data", d => err += d);
    c.on("error", reject);
    c.on("exit", code => code === 0 ? resolve(out) : reject(new Error(`${cmd} ${code}: ${err.trim()}`)));
  });
}

// Count files that look like contribution outputs in a source dir. Used to
// decide whether to even attempt a commit (empty source = silent skip).
async function pendingCount(sourceDir) {
  if (!existsSync(sourceDir)) return 0;
  let n = 0;
  async function walk(d) {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (/\.(txt|json|md|jpg|jpeg|png|webp)$/i.test(ent.name)) n++;
    }
  }
  await walk(sourceDir);
  return n;
}

// Commit a single source via the temp-index pattern.
//   - read-tree origin/main into a throwaway index
//   - git add only that source's dir into the throwaway index
//   - if no diff vs main → nothing new, silent skip
//   - write-tree + commit-tree + push → PR
// The user's working tree is never touched.
async function commitSource({ source, label, prTitle, prBody }) {
  const srcDir = path.join(ROOT, "contributions", HANDLE, source);
  const n = await pendingCount(srcDir);
  if (n === 0) {
    console.log(`[commit-all] ${label}: nothing on disk; skipping`);
    return { source, status: "empty" };
  }
  console.log(`[commit-all] ${label}: ${n} file(s) on disk in contributions/${HANDLE}/${source}/`);
  if (DRY) return { source, status: "dry" };

  // Fetch latest main so the commit is built on top of it, not a stale ref.
  try { await run("git", ["fetch", "origin", "main", "--quiet"], { stdio: "ignore" }); }
  catch (e) { console.warn(`[commit-all] ${label}: git fetch failed (${e.message}); using cached origin/main`); }

  const tmpIndex = path.join(os.tmpdir(), `pursue-idx-${source}-${Date.now().toString(36)}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    await run("git", ["read-tree", "origin/main"], { env, stdio: "ignore" });
    await run("git", ["add", "--", `contributions/${HANDLE}/${source}`], { env, stdio: "ignore" });

    // diff-index --quiet: exit 0 = clean (no diff), exit 1 = differences exist.
    // We want "differences exist" to mean go-ahead, so a clean exit means skip.
    let hasChanges = false;
    try { await run("git", ["diff-index", "--quiet", "--cached", "origin/main"], { env, stdio: "ignore" }); }
    catch { hasChanges = true; }
    if (!hasChanges) {
      console.log(`[commit-all] ${label}: byte-identical to origin/main; nothing new to publish`);
      return { source, status: "clean" };
    }

    const tree = (await capture("git", ["write-tree"], { env })).trim();
    const parent = (await capture("git", ["rev-parse", "origin/main"])).trim();
    const msg = `${label}: volunteer contributions from @${HANDLE}\n\nSubmitted via scripts/commit-all.mjs.`;
    const commit = (await capture("git", ["commit-tree", tree, "-p", parent, "-m", msg], { env })).trim();

    const branch = `contrib-${HANDLE}-${source}-${Date.now().toString(36)}`;
    await run("git", ["push", "-q", "origin", `${commit}:refs/heads/${branch}`]);
    await run("gh", ["pr", "create", "--head", branch, "--base", "main",
      "--title", prTitle.replace("{HANDLE}", HANDLE),
      "--body", prBody.replace("{HANDLE}", HANDLE)]);
    console.log(`[commit-all] ✓ ${label}: PR opened on ${branch}`);
    return { source, status: "pr", branch };
  } finally {
    try { await rm(tmpIndex); } catch {}
  }
}

// Visuals: delegate to volunteer-media.mjs --commit. That script already
// validates templates, normalizes images, and clears staging on success —
// re-implementing here would drift. The downside is it still uses the
// checkout-based commit path, but it works and changing it is out of scope
// for this task.
async function commitVisuals() {
  const stagingRoot = process.env.PURSUE_STAGING ||
    path.join(os.homedir(), ".pursue-helper", "media-staging", HANDLE);
  if (!existsSync(stagingRoot)) {
    console.log(`[commit-all] visuals: no staging dir; skipping`);
    return { source: "media", status: "empty" };
  }
  // Quick check: any p<NNN>.md files at all?
  let any = false;
  try {
    for (const eid of await readdir(stagingRoot)) {
      const d = path.join(stagingRoot, eid);
      try {
        if ((await readdir(d)).some(f => /^p\d+\.md$/i.test(f))) { any = true; break; }
      } catch {}
    }
  } catch {}
  if (!any) {
    console.log(`[commit-all] visuals: staging empty; skipping`);
    return { source: "media", status: "empty" };
  }
  console.log(`[commit-all] visuals: delegating to volunteer-media.mjs --commit`);
  if (DRY) return { source: "media", status: "dry" };
  try {
    await run("node", ["scripts/volunteer-media.mjs", `--my-handle=${HANDLE}`, "--commit"]);
    return { source: "media", status: "ok" };
  } catch (e) {
    console.error(`[commit-all] visuals: failed — ${e.message}`);
    return { source: "media", status: "error" };
  }
}

const SOURCES = {
  ocr: {
    source: "gpt-vision",
    label: "OCR",
    prTitle: "Volunteer OCR contribution from @{HANDLE}",
    prBody: `## Vision-OCR contribution\n\nVision-OCR'd pages submitted via \`scripts/commit-all.mjs\` by @{HANDLE}.\n\nCI validates against [JUDGE-STANDARD.md](../blob/main/JUDGE-STANDARD.md).`,
  },
  review: {
    source: "gpt-vision-review",
    label: "Review",
    prTitle: "Volunteer review contribution from @{HANDLE}",
    prBody: `## Human review contribution\n\nHuman-typed canonical text for pages where machine sources disagreed. Submitted via \`scripts/commit-all.mjs\` by @{HANDLE}.\n\nThese pages were flagged \`needs_review\` by \`scripts/compare-sources.mjs\` and represent higher-leverage corrections than additional OCR.`,
  },
};

const results = [];
for (const key of REQUESTED_SOURCES) {
  if (key === "visuals" || key === "media") {
    results.push(await commitVisuals());
  } else if (SOURCES[key]) {
    try { results.push(await commitSource(SOURCES[key])); }
    catch (e) {
      console.error(`[commit-all] ${SOURCES[key].label}: failed — ${e.message}`);
      results.push({ source: SOURCES[key].source, status: "error", error: e.message });
    }
  } else {
    console.warn(`[commit-all] unknown source "${key}" — skipping`);
  }
}

const prs = results.filter(r => r.status === "pr" || r.status === "ok").length;
const empty = results.filter(r => r.status === "empty" || r.status === "clean").length;
const errors = results.filter(r => r.status === "error").length;
console.log(`\n[commit-all] done. ${prs} action(s), ${empty} skipped, ${errors} error(s)`);
if (errors > 0) process.exit(2);
if (prs === 0) process.exit(0);  // nothing to do is still success
process.exit(0);
