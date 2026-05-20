// Harvest visual content references from Denis's imported Gemini
// transcripts. The Gemini pipeline tags visual elements inline with
// bracket markers like [Photograph of...], [Sketch of...], [Newspaper
// Clipping], [Image of UFO]. We don't need to render the page — the
// marker itself is the metadata.
//
// For every page that has at least one visual-content marker:
//   - Write data-raw/.visuals/<eid>/p<NNN>.json with kind + title + description
//   - If a local PDF exists for the event, ALSO render p<NNN>.png to
//     public/media/<eid>/ (so the MEDIA tile has an actual image)
//   - If no local PDF, the page still lands in MEDIA — the description
//     IS the content, the tile uses a placeholder
//
// Tag → kind mapping (case-insensitive, first-word match):
//   Photo, Photograph                → photograph
//   Sketch, Drawing                  → hand-drawing
//   Newspaper Clipping, Clipping     → newspaper-clipping
//   Diagram                          → diagram
//   Map                              → map
//   Negative, Photocopy              → photocopied-negative
//   Image, Figure, Illustration      → photograph (generic fallback)
//
// Pages with existing human-curated classifier verdicts are not
// overwritten.

import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VIS = path.join(ROOT, "data-raw", ".vision-cache");
const RAW = path.join(ROOT, "data-raw");
const VISUALS = path.join(ROOT, "data-raw", ".visuals");
const MEDIA = path.join(ROOT, "public", "media");

const KIND_MAP = [
  // ordered: more specific patterns first
  [/^\s*(newspaper\s+clipping|press\s+clipping|news\s+clipping|clipping)/i, "newspaper-clipping"],
  [/^\s*(photograph|photo)\b/i, "photograph"],
  [/^\s*(sketch|drawing|hand-?drawn)/i, "hand-drawing"],
  [/^\s*(diagram|schematic)/i, "diagram"],
  [/^\s*(map|floor\s*plan)/i, "map"],
  [/^\s*(negative|photocopy\s+of\s+negative|photocopied\s+negative)/i, "photocopied-negative"],
  [/^\s*(image|figure|illustration)\b/i, "photograph"],
];

function inferKind(label) {
  for (const [re, kind] of KIND_MAP) if (re.test(label)) return kind;
  return null;
}

// Find every bracket marker that LOOKS like a visual-content tag.
// Tag = first word(s) up to colon or end. Description = the rest.
function extractMarkers(text) {
  const out = [];
  // Brackets that span up to ~400 chars. Don't match brackets with
  // common non-visual words like "Stamp", "Handwritten", "Address".
  const re = /\[([A-Z][^\]]{2,400}?)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    // Strip "Top Center -" / "Bottom Right (foo)" positional prefixes
    const cleaned = body.replace(/^(Top|Bottom|Left|Right|Center|Upper|Lower)\s*(Center|Left|Right|Top|Bottom)?\s*[:\-,]?\s*/, "")
                        .replace(/^[\[\(].*?[\]\)]\s*/, "");
    const kind = inferKind(cleaned) || inferKind(body);
    if (!kind) continue;
    // Title = first 80 chars stripped of the leading kind word
    const title = cleaned.replace(/^\s*(photo(graph)?|sketch|drawing|diagram|map|newspaper\s+clipping|clipping|image|figure|illustration|negative)\s*[:\-]?\s*/i, "").slice(0, 80) || body.slice(0, 80);
    out.push({ kind, title: title.trim(), description: body });
  }
  // Dedupe by (kind + first 40 chars of title)
  const seen = new Set();
  return out.filter(v => {
    const key = `${v.kind}|${v.title.slice(0, 40).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// pdfjs render (lossless PNG) — only used when a local PDF exists
let pdfjs = null;
async function tryRenderPage(eid, pageNum) {
  const candidates = (await readdir(RAW).catch(() => [])).filter(f => f.toLowerCase().endsWith(".pdf"));
  const lowerEid = eid.toLowerCase();
  const pdfFile = candidates.find(f => f.toLowerCase().replace(/\.pdf$/, "") === lowerEid)
              || candidates.find(f => f.toLowerCase().includes(lowerEid))
              || null;
  if (!pdfFile) return null;
  try {
    if (!pdfjs) pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const buf = await readFile(path.join(RAW, pdfFile));
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: false, disableFontFace: true,
      isEvalSupported: false, useWorkerFetch: false,
    }).promise;
    const page = await doc.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });
    const scale = 800 / Math.max(base.width, base.height);
    const vp = page.getViewport({ scale });
    const cv = createCanvas(Math.floor(vp.width), Math.floor(vp.height));
    const ctx = cv.getContext("2d");
    const factory = {
      create: (w, h) => { const c = createCanvas(w, h); return { canvas: c, context: c.getContext("2d") }; },
      reset: (c, w, h) => { c.canvas.width = w; c.canvas.height = h; },
      destroy: (c) => { c.canvas.width = 0; c.canvas.height = 0; c.canvas = null; c.context = null; },
    };
    await page.render({ canvasContext: ctx, viewport: vp, canvasFactory: factory, annotationMode: 0 }).promise;
    return cv.toBuffer("image/png");
  } catch { return null; }
}

const stats = { scanned: 0, with_markers: 0, written: 0, rendered: 0, skipped_existing: 0, by_kind: {} };

async function listDirs(p) {
  try { return (await readdir(p, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
}

for (const eid of await listDirs(VIS)) {
  const dir = path.join(VIS, eid);
  for (const f of await readdir(dir)) {
    if (!/^p\d+\.gemini\.txt$/.test(f)) continue;
    stats.scanned++;
    const pn = Number(f.match(/^p(\d+)/)[1]);
    const pad = String(pn).padStart(4, "0");
    const sidecarPath = path.join(VISUALS, eid, `p${pad}.json`);

    // Skip if a human-curated sidecar already exists
    if (existsSync(sidecarPath)) {
      try {
        const sc = JSON.parse(await readFile(sidecarPath, "utf8"));
        if ((sc.classifier || "").startsWith("human:")) { stats.skipped_existing++; continue; }
      } catch {}
    }

    const text = await readFile(path.join(dir, f), "utf8");
    const markers = extractMarkers(text);
    if (!markers.length) continue;
    stats.with_markers++;

    // For now, store the dominant marker as the page-level classification
    // (the MediaView shows one tile per page; multiple visuals per page
    // can be a future enhancement).
    const primary = markers[0];
    const sidecar = {
      kind: primary.kind,
      title: primary.title || `${primary.kind} from gemini transcript`,
      description: primary.description.slice(0, 500),
      additional_markers: markers.slice(1).map(m => ({ kind: m.kind, title: m.title })),
      classifier: "gemini-text-extract",
      classifiedAt: new Date().toISOString(),
    };
    await mkdir(path.dirname(sidecarPath), { recursive: true });
    await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
    stats.written++;
    stats.by_kind[primary.kind] = (stats.by_kind[primary.kind] || 0) + 1;

    // If we have a local PDF, render the page so MEDIA has an image
    const mediaPath = path.join(MEDIA, eid, `p${pad}.png`);
    if (!existsSync(mediaPath)) {
      const png = await tryRenderPage(eid, pn);
      if (png) {
        await mkdir(path.dirname(mediaPath), { recursive: true });
        await writeFile(mediaPath, png);
        stats.rendered++;
      }
    }
  }
}

console.log(`[gemini-media] scanned ${stats.scanned} gemini transcripts`);
console.log(`               ${stats.with_markers} pages have visual markers`);
console.log(`               ${stats.written} sidecars written  ·  ${stats.rendered} pages rendered locally`);
console.log(`               ${stats.skipped_existing} skipped (human-curated already)`);
console.log(`[gemini-media] by kind:`);
for (const [k, n] of Object.entries(stats.by_kind).sort((a, b) => b[1] - a[1])) {
  console.log(`                 ${k.padEnd(22)} ${n}`);
}
console.log(`[gemini-media] next: node scripts/build-media-index.mjs`);
