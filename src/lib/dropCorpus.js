// Client-side ingestion + persistence for user-dropped documents.
//
// Why this exists:
//   The official inventory at war.gov is 162 records; we only have 47
//   catalogued PDFs in the static embedding index. To cover the rest
//   without round-tripping through a server, the user drops PDF/TXT
//   files into the SEMANTIC view. We extract text with pdfjs (already
//   bundled), embed each page chunk with the same transformers.js
//   pipeline that the official corpus uses, and persist everything
//   to IndexedDB so it survives reloads.
//
// Vector format on disk: Float32Array, L2-normalized, dim=384 (matches
// the static corpus so we can search both in one cosine pass).

import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorkerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerSrc;

const DB_NAME = "pursue-drop-corpus";
const DB_VERSION = 1;
const STORE_DOCS = "docs";
const STORE_CHUNKS = "chunks";

// ---- IndexedDB helpers ----
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_DOCS)) {
        db.createObjectStore(STORE_DOCS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        const cs = db.createObjectStore(STORE_CHUNKS, { keyPath: "id", autoIncrement: true });
        cs.createIndex("docId", "docId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function txGet(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const s = tx.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; }).catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function listDocs() {
  return txGet(STORE_DOCS, "readonly", (s) => new Promise((res, rej) => {
    const req = s.getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  }));
}

export async function deleteDoc(docId) {
  const db = await openDb();
  await new Promise((res, rej) => {
    const tx = db.transaction([STORE_DOCS, STORE_CHUNKS], "readwrite");
    tx.objectStore(STORE_DOCS).delete(docId);
    const idx = tx.objectStore(STORE_CHUNKS).index("docId");
    const cursorReq = idx.openCursor(IDBKeyRange.only(docId));
    cursorReq.onsuccess = () => {
      const c = cursorReq.result;
      if (c) { c.delete(); c.continue(); }
    };
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

export async function clearAll() {
  const db = await openDb();
  await new Promise((res, rej) => {
    const tx = db.transaction([STORE_DOCS, STORE_CHUNKS], "readwrite");
    tx.objectStore(STORE_DOCS).clear();
    tx.objectStore(STORE_CHUNKS).clear();
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

// Load all chunks across all dropped docs as one packed Float32Array + meta.
// Matches the wire format of the static embeddings so cosine search can
// score both in one loop.
export async function loadAllChunks() {
  const chunks = await txGet(STORE_CHUNKS, "readonly", (s) => new Promise((res, rej) => {
    const req = s.getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  }));
  if (!chunks.length) return { vectors: new Float32Array(0), meta: [], dim: 384 };
  const dim = chunks[0].vector.length;
  const packed = new Float32Array(chunks.length * dim);
  const meta = new Array(chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    packed.set(chunks[i].vector, i * dim);
    meta[i] = {
      docId: chunks[i].docId,
      docName: chunks[i].docName,
      page: chunks[i].page,
      snippet: chunks[i].snippet,
      kind: "dropped",
    };
  }
  return { vectors: packed, meta, dim };
}

// ---- PDF text extraction ----
async function extractPdfPages(file) {
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    try {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const t = tc.items.map(it => it.str || "").join(" ").replace(/\s+/g, " ").trim();
      out.push({ page: p, text: t });
    } catch (e) {
      out.push({ page: p, text: "" });
    }
  }
  await doc.cleanup();
  await doc.destroy();
  return out;
}

function sliceLong(body, n = 1500) {
  if (body.length <= n) return [body];
  const paragraphs = body.split(/\n\s*\n|(?<=[.!?])\s+(?=[A-Z])/);
  const out = [];
  let buf = "";
  for (const p of paragraphs) {
    if ((buf + " " + p).length <= n) {
      buf = (buf + " " + p).trim();
    } else {
      if (buf) out.push(buf);
      if (p.length <= n) buf = p;
      else { for (let i = 0; i < p.length; i += n) out.push(p.slice(i, i + n)); buf = ""; }
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ---- Public: ingest a file using the loaded transformers.js pipeline ----
export async function ingestFile(file, pipe, onProgress) {
  const isText = /\.(txt|md)$/i.test(file.name);
  const isPdf = /\.pdf$/i.test(file.name);
  if (!isText && !isPdf) throw new Error(`Unsupported file type: ${file.name}`);

  const docId = `${file.name}-${file.size}-${file.lastModified}`;

  // Idempotent: skip if already ingested
  const existing = await txGet(STORE_DOCS, "readonly", (s) => new Promise((res, rej) => {
    const req = s.get(docId);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
  if (existing) {
    onProgress?.({ phase: "skipped", file: file.name, chunks: existing.chunkCount });
    return { docId, skipped: true, chunkCount: existing.chunkCount };
  }

  onProgress?.({ phase: "extracting", file: file.name });
  let pages;
  if (isPdf) {
    pages = await extractPdfPages(file);
  } else {
    const text = await file.text();
    // try to split on === Page N === markers else one chunk
    const m = text.split(/=== Page (\d+) ===/);
    if (m.length >= 3) {
      pages = [];
      for (let i = 1; i < m.length; i += 2) pages.push({ page: Number(m[i]), text: (m[i+1]||"").trim() });
    } else {
      pages = [{ page: 1, text }];
    }
  }

  // Build chunk objects (page-level, sliced if long)
  const chunks = [];
  for (const { page, text } of pages) {
    if (!text || text.length < 30) continue;
    for (const piece of sliceLong(text)) {
      chunks.push({ page, body: piece, snippet: piece.slice(0, 240).replace(/\n/g, " ").trim() });
    }
  }
  if (!chunks.length) throw new Error(`No extractable text in ${file.name} (might be a scanned PDF)`);

  onProgress?.({ phase: "embedding", file: file.name, total: chunks.length, done: 0 });

  // Embed in batches of 16 to keep memory bounded
  const BATCH = 16;
  const vectors = new Array(chunks.length);
  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH);
    const out = await pipe(slice.map(c => c.body), { pooling: "mean", normalize: true });
    // transformers.js returns a Tensor — split per-row
    const dim = out.dims[1];
    const data = out.data;
    for (let j = 0; j < slice.length; j++) {
      vectors[i + j] = new Float32Array(data.buffer, data.byteOffset + j * dim * 4, dim).slice();
    }
    onProgress?.({ phase: "embedding", file: file.name, total: chunks.length, done: Math.min(i + BATCH, chunks.length) });
  }

  onProgress?.({ phase: "storing", file: file.name, chunks: chunks.length });

  // Persist atomically: one doc row + N chunk rows
  const db = await openDb();
  await new Promise((res, rej) => {
    const tx = db.transaction([STORE_DOCS, STORE_CHUNKS], "readwrite");
    const docs = tx.objectStore(STORE_DOCS);
    const ch = tx.objectStore(STORE_CHUNKS);
    docs.put({
      id: docId,
      name: file.name,
      size: file.size,
      pages: pages.length,
      chunkCount: chunks.length,
      ingestedAt: Date.now(),
    });
    for (let i = 0; i < chunks.length; i++) {
      ch.put({
        docId,
        docName: file.name,
        page: chunks[i].page,
        snippet: chunks[i].snippet,
        vector: vectors[i],
      });
    }
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });

  onProgress?.({ phase: "done", file: file.name, chunks: chunks.length });
  return { docId, skipped: false, chunkCount: chunks.length, pageCount: pages.length };
}
