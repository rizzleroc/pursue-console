// =====================================================================
// Shared embedding client. Both SemanticSearchView and AskView need the
// same MiniLM-L6-v2 model + the same embeddings.bin / meta. SemanticSearchView
// keeps its inline copy (cheap module-level caches mean importing it
// would be fine, but extracting it to a separate file would force a
// large refactor of that view). This file mirrors its loaders so the
// model + vectors are loaded once per session no matter which view
// asked for them first.
// =====================================================================
import { pipeline, env } from "@huggingface/transformers";

const MODEL = "Xenova/all-MiniLM-L6-v2";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

let _vectorsP = null;
export function loadVectors() {
  if (!_vectorsP) {
    _vectorsP = Promise.all([
      fetch(`${import.meta.env.BASE_URL}embeddings.bin`).then(r => r.arrayBuffer()),
      fetch(`${import.meta.env.BASE_URL}embeddings-meta.json`).then(r => r.json()),
      fetch(`${import.meta.env.BASE_URL}embeddings-info.json`).then(r => r.json()),
    ]).then(([buf, meta, info]) => {
      const vectors = new Float32Array(buf);
      if (vectors.length !== info.count * info.dim) {
        throw new Error(`embeddings size mismatch ${vectors.length} vs ${info.count}*${info.dim}`);
      }
      return { vectors, meta, info };
    });
  }
  return _vectorsP;
}

let _modelP = null;
export function loadModel(onProgress) {
  if (!_modelP) {
    _modelP = pipeline("feature-extraction", MODEL, {
      dtype: "int8",
      device: "wasm",
      progress_callback: onProgress,
    }).catch(err => {
      _modelP = null;
      throw err;
    });
  }
  return _modelP;
}

// L2-normalize the query, dot against every stored (already-normalized)
// vector, keep the top-K via a fixed-size min-heap. Same routine as
// SemanticSearchView.topK — kept here so AskView can use it directly.
export function topK(qVec, vectors, dim, count, K = 12) {
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += qVec[i] * qVec[i];
  norm = Math.sqrt(norm) || 1;
  const q = new Float32Array(dim);
  for (let i = 0; i < dim; i++) q[i] = qVec[i] / norm;

  const scores = new Float32Array(K).fill(-Infinity);
  const idxs = new Int32Array(K).fill(-1);
  let minScore = -Infinity, minPos = 0;
  for (let r = 0; r < count; r++) {
    let s = 0;
    const base = r * dim;
    for (let i = 0; i < dim; i++) s += vectors[base + i] * q[i];
    if (s > minScore) {
      scores[minPos] = s; idxs[minPos] = r;
      minScore = scores[0]; minPos = 0;
      for (let i = 1; i < K; i++) if (scores[i] < minScore) { minScore = scores[i]; minPos = i; }
    }
  }
  const out = [];
  for (let i = 0; i < K; i++) if (idxs[i] >= 0) out.push({ idx: idxs[i], score: scores[i] });
  out.sort((a, b) => b.score - a.score);
  return out;
}

// Embed a single query string. Returns Float32Array(dim).
export async function embedQuery(text) {
  const pipe = await loadModel();
  const out = await pipe(text, { pooling: "mean", normalize: false });
  return new Float32Array(out.data);
}
