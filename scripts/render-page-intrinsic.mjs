// Quick one-shot: render every page-intrinsic disputed page from its
// source PDF as a JPEG into /tmp/page-intrinsic/ so they can be
// visually inspected (these are the pages that need human typing,
// per dispute_kind = page-intrinsic).

import Database from "better-sqlite3";
// pdfjs's nested canvas (0.1.x); see backfill-media-renders.mjs.
import { createCanvas } from "pdfjs-dist/node_modules/@napi-rs/canvas/index.js";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DB = path.join(ROOT, "data-raw", "corpus.sqlite");
const RAW = path.join(ROOT, "data-raw");
const OUT = path.join(os.tmpdir(), "page-intrinsic");

await mkdir(OUT, { recursive: true });

const db = new Database(DB, { readonly: true });
const rows = db.prepare(`
  SELECT event_id, page_num
  FROM pages
  WHERE dispute_kind = 'page-intrinsic'
  ORDER BY event_id, page_num
`).all();
db.close();

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
class CF {
  create(w, h) { const c = createCanvas(w, h); return { canvas: c, context: c.getContext("2d") }; }
  reset(c, w, h) { c.canvas.width = w; c.canvas.height = h; }
  destroy(c) { c.canvas.width = 0; c.canvas.height = 0; c.canvas = null; c.context = null; }
}

const docCache = new Map();
async function getDoc(eid) {
  if (docCache.has(eid)) return docCache.get(eid);
  const cands = (await readdir(RAW)).filter(f => f.toLowerCase().endsWith(".pdf"));
  let pdf = cands.find(f => f.toLowerCase().replace(/\.pdf$/, "") === eid.toLowerCase())
         || cands.find(f => f.toLowerCase().includes(eid.toLowerCase()));
  if (!pdf) { docCache.set(eid, null); return null; }
  const buf = await readFile(path.join(RAW, pdf));
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false, disableFontFace: true,
  }).promise;
  docCache.set(eid, doc);
  return doc;
}

for (const r of rows) {
  const pad = String(r.page_num).padStart(4, "0");
  const out = path.join(OUT, `${r.event_id}-p${pad}.jpg`);
  process.stdout.write(`${r.event_id} p${pad} `);
  try {
    const doc = await getDoc(r.event_id);
    if (!doc) { console.log("no PDF"); continue; }
    const page = await doc.getPage(r.page_num);
    const base = page.getViewport({ scale: 1 });
    const scale = 1100 / Math.max(base.width, base.height);
    const vp = page.getViewport({ scale });
    const fac = new CF();
    const cv = fac.create(Math.floor(vp.width), Math.floor(vp.height));
    await page.render({ canvasContext: cv.context, viewport: vp, canvasFactory: fac, annotationMode: 0 }).promise;
    await writeFile(out, cv.canvas.toBuffer("image/jpeg", 0.78));
    fac.destroy(cv);
    console.log(`-> ${path.relative(ROOT, out).replaceAll("\\", "/")}`);
  } catch (e) {
    console.log(`FAIL ${e.message}`);
  }
}
console.log(`\nWrote to ${OUT}`);
