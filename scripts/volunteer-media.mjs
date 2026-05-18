// Media-context volunteer flow.
//
// Two phases:
//
//   1. CLAIM      — fetches work-available.json, picks N pages from the
//                   visualsNeedingContext queue (deterministic per handle),
//                   downloads the source PDFs, renders the claimed pages at
//                   readable resolution, and writes a markdown template per
//                   page into staging/. Tells the volunteer to fill it in.
//
//   2. COMMIT     — re-reads staging/, validates each filled template,
//                   converts to the canonical p<NNN>.json + p<NNN>.jpg
//                   pair under contributions/<handle>/media/<eid>/, opens
//                   a PR.
//
// Why two phases: typing rich context in the terminal is miserable; doing
// it in a text editor with the rendered page open alongside is not. The
// staging templates carry all the metadata the importer needs.
//
// Usage:
//   node scripts/volunteer-media.mjs --my-handle=YOU --slice=5         # claim
//   # ... open ~/.pursue-helper/media-staging/<handle>/, fill templates ...
//   node scripts/volunteer-media.mjs --my-handle=YOU --commit          # commit + PR
//
// Options:
//   --my-handle=<handle>   GitHub handle (required)
//   --slice=N              Pages to claim (default 5)
//   --commit               Switch to commit phase (no new claims made)
//   --no-pr                Stage the commits but don't open the PR
//   --queue-url=…          Override the work queue URL (defaults to live site)
//   --pdf-root=…           Where to download PDFs (default data-raw/volunteer)
//   --staging=…            Override staging dir (default ~/.pursue-helper/media-staging)

import { readFile, writeFile, mkdir, readdir, stat, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const HANDLE = (args["my-handle"] || "").replace(/^@/, "").trim();
if (!HANDLE) {
  console.error("error: --my-handle=<your-github-handle> is required");
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,39}$/.test(HANDLE)) {
  console.error(`error: '${HANDLE}' is not a valid GitHub handle`);
  process.exit(1);
}
const SLICE = Number(args.slice || 5);
const COMMIT = !!args.commit;
const NO_PR = !!args["no-pr"];
const QUEUE_URL = args["queue-url"] || "https://rizzleroc.github.io/pursue-console/work-available.json";
const PDF_ROOT = path.resolve(args["pdf-root"] || path.join(ROOT, "data-raw/volunteer"));
const STAGING = path.resolve(args.staging || path.join(os.homedir(), ".pursue-helper", "media-staging", HANDLE));
const CONTRIB_DIR = path.join(ROOT, "contributions", HANDLE, "media");

function hash(s) { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) | 0; return Math.abs(h); }
async function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: "inherit", ...opts });
    p.on("exit", code => code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`)));
    p.on("error", reject);
  });
}

// =====================================================================
// CLAIM PHASE
// =====================================================================
async function claimPhase() {
  await mkdir(STAGING, { recursive: true });
  await mkdir(PDF_ROOT, { recursive: true });

  console.log(`[claim] fetching ${QUEUE_URL}`);
  const queue = await (await fetch(QUEUE_URL)).json();
  if (!queue.byEvent) { console.error("error: queue missing byEvent"); process.exit(1); }
  console.log(`[claim] queue gen ${queue.generatedAt} · ${queue.totalPagesNeedingVisualContext || 0} pages need visual context`);

  // Pick a deterministic rotation across events.
  const candidates = Object.entries(queue.byEvent)
    .filter(([, d]) => (d.visualsNeedingContext || []).length > 0);
  if (!candidates.length) { console.log("[claim] no pages need visual context right now."); process.exit(0); }
  const start = hash(HANDLE) % candidates.length;
  const rotated = candidates.slice(start).concat(candidates.slice(0, start));

  const claims = [];
  let remaining = SLICE;
  for (const [eid, d] of rotated) {
    if (remaining <= 0) break;
    for (const v of d.visualsNeedingContext) {
      if (remaining <= 0) break;
      claims.push({ eid, doc: d, ...v });
      remaining--;
    }
  }
  console.log(`[claim] claiming ${claims.length} page(s):`);
  for (const c of claims) console.log(`    ${c.eid.padEnd(28)} p${String(c.page).padStart(4, "0")}  ${c.kind.padEnd(20)}  "${c.suggestedTitle.slice(0, 40)}"`);

  // pdfjs render — same approach as classify-visuals.mjs
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  class NodeCanvasFactory {
    create(w, h) { const cv = createCanvas(w, h); return { canvas: cv, context: cv.getContext("2d") }; }
    reset(c, w, h) { c.canvas.width = w; c.canvas.height = h; }
    destroy(c) { c.canvas.width = 0; c.canvas.height = 0; c.canvas = null; c.context = null; }
  }

  const downloadedPdf = new Map();
  async function getPdfPath(eid, url) {
    if (downloadedPdf.has(eid)) return downloadedPdf.get(eid);
    const filename = path.join(PDF_ROOT, `${eid}.pdf`);
    if (!existsSync(filename)) {
      console.log(`    ↓ downloading ${url}`);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      await writeFile(filename, buf);
    }
    downloadedPdf.set(eid, filename);
    return filename;
  }

  for (const c of claims) {
    const pad4 = String(c.page).padStart(4, "0");
    const outDir = path.join(STAGING, c.eid);
    await mkdir(outDir, { recursive: true });
    const jpgPath = path.join(outDir, `p${pad4}.jpg`);
    const tmplPath = path.join(outDir, `p${pad4}.md`);
    try {
      const pdfPath = await getPdfPath(c.eid, c.doc.pdfUrl);
      const buf = await readFile(pdfPath);
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(buf),
        useSystemFonts: false, disableFontFace: true,
      }).promise;
      const page = await doc.getPage(c.page);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = 1200 / Math.max(baseViewport.width, baseViewport.height);
      const viewport = page.getViewport({ scale });
      const factory = new NodeCanvasFactory();
      const cv = factory.create(Math.floor(viewport.width), Math.floor(viewport.height));
      await page.render({ canvasContext: cv.context, viewport, canvasFactory: factory, annotationMode: 0 }).promise;
      const jpg = cv.canvas.toBuffer("image/jpeg", 0.78);
      factory.destroy(cv);
      await writeFile(jpgPath, jpg);
    } catch (e) {
      console.log(`    ! ${c.eid} p${pad4}: render failed (${e.message})`);
      continue;
    }
    // Markdown template alongside the rendered page
    await writeFile(tmplPath, `<!--
PURSUE — Media Context Template
Event:  ${c.eid}
Page:   ${c.page}
PDF:    ${c.doc.pdfUrl}

Suggested kind:        ${c.kind}
Classifier's title:    ${c.suggestedTitle || "(none)"}
Classifier's blurb:    ${c.suggestedDescription || "(none)"}

Open p${pad4}.jpg next to this file. Fill the fields below.
-->

# Kind
<!-- One of: photograph, hand-drawing, photocopied-negative, newspaper-clipping, map, diagram -->
${c.kind}

# Title
<!-- Short. For newspaper-clipping: the actual headline verbatim. Otherwise: subject + context. -->
${c.suggestedTitle || ""}

# Context
<!--
Quote verbatim from the document. What does the page BEFORE this say about the image?
What's the caption on this page? What does the page AFTER say? Why is this image in the file?
Don't summarize. Don't interpret. Quotes only. Mark unreadable text [illegible].
-->


# Article text (newspaper-clipping ONLY)
<!--
If kind is newspaper-clipping, paste the full article body here. Headline + byline + body.
Do NOT paste the whole newspaper page — only the article that IS the visual.
Skip this section for all other kinds.
-->

`, "utf8");
  }
  console.log(`\n[claim] templates written to: ${STAGING}`);
  console.log(`[claim] next steps:`);
  console.log(`         1. open ${STAGING}`);
  console.log(`         2. open each p<NNN>.jpg + p<NNN>.md side by side`);
  console.log(`         3. fill in the Title / Context / (Article text) sections`);
  console.log(`         4. run:  node scripts/volunteer-media.mjs --my-handle=${HANDLE} --commit`);
}

// =====================================================================
// COMMIT PHASE
// =====================================================================
function parseTemplate(md) {
  const sections = {};
  let current = null, buf = [];
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^# (.+?)\s*$/);
    if (h) {
      if (current) sections[current] = buf.join("\n").trim();
      current = h[1].toLowerCase();
      buf = [];
      continue;
    }
    if (current) buf.push(line);
  }
  if (current) sections[current] = buf.join("\n").trim();
  // strip HTML comments
  for (const k of Object.keys(sections)) sections[k] = sections[k].replace(/<!--[\s\S]*?-->/g, "").trim();
  return sections;
}

async function commitPhase() {
  if (!existsSync(STAGING)) { console.error(`error: nothing staged at ${STAGING}`); process.exit(1); }
  const eids = (await readdir(STAGING, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
  if (!eids.length) { console.error("error: staging has no event folders"); process.exit(1); }

  const ALLOWED_KINDS = new Set(["photograph", "hand-drawing", "photocopied-negative", "newspaper-clipping", "map", "diagram"]);
  let committed = 0, skipped = 0, badTemplate = 0;
  const touchedEids = new Set();

  for (const eid of eids) {
    const dir = path.join(STAGING, eid);
    const files = await readdir(dir);
    const mdFiles = files.filter(f => /^p\d+\.md$/i.test(f));
    for (const mdFile of mdFiles) {
      const pad = mdFile.match(/^p(\d+)\.md$/i)[1];
      const md = await readFile(path.join(dir, mdFile), "utf8");
      const sec = parseTemplate(md);
      const issues = [];
      if (!ALLOWED_KINDS.has(sec.kind)) issues.push(`kind not in enum (got "${sec.kind}")`);
      if (!sec.title || sec.title.length < 4) issues.push("title missing or too short");
      if (!sec.context || sec.context.length < 20) issues.push("context missing or too short (≥20 chars, verbatim from page)");
      const jpgSrc = path.join(dir, `p${pad}.jpg`);
      if (!existsSync(jpgSrc)) issues.push(`p${pad}.jpg missing`);
      if (sec.kind === "newspaper-clipping" && sec["article text (newspaper-clipping only)"] && sec["article text (newspaper-clipping only)"].length > 50_000) {
        issues.push("article_text > 50,000 chars — paste just the article, not the whole edition");
      }
      if (issues.length) {
        console.log(`! ${eid} p${pad}: ${issues.join("; ")} — skipping`);
        if (sec.title || sec.context) badTemplate++;
        else skipped++;
        continue;
      }
      const dstDir = path.join(CONTRIB_DIR, eid);
      await mkdir(dstDir, { recursive: true });
      const dstJson = path.join(dstDir, `p${pad}.json`);
      const dstJpg  = path.join(dstDir, `p${pad}.jpg`);
      const out = {
        kind: sec.kind,
        title: sec.title,
        context: sec.context,
        captured_at: new Date().toISOString(),
      };
      const article = sec["article text (newspaper-clipping only)"];
      if (out.kind === "newspaper-clipping" && article) out.article_text = article;
      await writeFile(dstJson, JSON.stringify(out, null, 2) + "\n", "utf8");
      await copyFile(jpgSrc, dstJpg);
      committed++;
      touchedEids.add(eid);
      console.log(`✓ ${eid} p${pad}  ${sec.kind.padEnd(20)}  "${sec.title.slice(0, 40)}"`);
    }
  }
  console.log(`\n[commit] ${committed} ready · ${badTemplate} incomplete · ${skipped} empty`);
  if (!committed) { console.log("[commit] nothing to PR"); process.exit(0); }
  if (NO_PR) {
    console.log(`[commit] --no-pr set; finish by hand:`);
    console.log(`         git add contributions/${HANDLE}/media && git commit && gh pr create`);
    process.exit(0);
  }

  // git + gh
  const branch = `contrib-${HANDLE}-media-${Date.now().toString(36)}`;
  try {
    await run("git", ["checkout", "-b", branch]);
    await run("git", ["add", `contributions/${HANDLE}/media`]);
    await run("git", ["commit", "-m", `media: visual context contributions from @${HANDLE}\n\n${committed} pages across ${touchedEids.size} document(s).`]);
    await run("git", ["push", "-u", "origin", branch]);
    const body = `## Media context contribution\n\n${committed} pages with images + verbatim documentary context, across ${touchedEids.size} document(s).\n\nGenerated via \`scripts/volunteer-media.mjs\` by @${HANDLE}.\n\nCI validates schema, image presence, image size (5KB–5MB), and runs safety checks on the title + context text.`;
    await run("gh", ["pr", "create", "--title", `Media context contribution from @${HANDLE}`, "--body", body]);
  } catch (e) {
    console.error(`[commit] PR step failed: ${e.message}`);
    console.error(`[commit] your files are staged at contributions/${HANDLE}/media — finish by hand.`);
  }
}

if (COMMIT) await commitPhase();
else await claimPhase();
