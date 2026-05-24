// =====================================================================
// In-browser LLM client. Loads a small instruction-tuned model via
// transformers.js, runs it entirely in the browser. No backend needed.
//
// This is the "just works on the deployed site" option — first run
// downloads the model weights (cached in IndexedDB after that), every
// subsequent visit hits the cache and is instant.
//
// Default model: onnx-community/Qwen2.5-0.5B-Instruct (q4, ~400 MB).
// Trade-off: small models hallucinate more than frontier LLMs, but for
// strictly grounded RAG ("answer using ONLY these passages") even a
// 0.5B model gives sensible results most of the time. The model is
// configurable in askSettings → modelId.
//
// transformers.js v3+ already ships in the SemanticSearchView path
// (the embedding side), so adding text-generation doesn't pull in a
// second framework — just more weights for a different head.
// =====================================================================
import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

// Module-level cache per modelId so switching models doesn't reload an
// already-warm pipeline. Keyed by `${modelId}|${dtype}` so changing the
// quantization (e.g. q4 → q8) also produces a fresh load.
const _genCache = new Map();

// Try WebGPU first (10-20× faster on modern hardware); fall back to
// WASM if the browser doesn't expose it or model init fails.
async function pickDevice() {
  try {
    if (typeof navigator !== "undefined" && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return "webgpu";
    }
  } catch {}
  return "wasm";
}

export async function loadGenerator(modelId, opts = {}) {
  const dtype = opts.dtype || "q4";
  const key = `${modelId}|${dtype}`;
  if (_genCache.has(key)) return _genCache.get(key);

  const device = await pickDevice();
  const p = pipeline("text-generation", modelId, {
    dtype,
    device,
    progress_callback: opts.onProgress,
  }).catch(err => {
    _genCache.delete(key);   // allow retry after a failed first load
    throw err;
  });

  _genCache.set(key, p);
  return p;
}

// Build the same prompt scaffold the hosted server uses, so answers
// look consistent across backends. Cap total chars so a wild K doesn't
// blow past the small model's context window (Qwen2.5-0.5B has 32K,
// but quality degrades fast past ~4K with small models — keep it tight).
function buildSystemAndUser(question, contexts) {
  const lines = [];
  lines.push("CONTEXT — top retrieved passages from the PURSUE corpus");
  lines.push("(declassified war.gov/UFO documents). Each shows EID, page,");
  lines.push("and a snippet of source text.");
  lines.push("");
  let used = 0;
  const BUDGET = 4000;     // chars across all context passages
  for (const c of contexts) {
    const head = `--- ${c.eid || "?"}${c.page != null ? ` · p${c.page}` : ""}${c.title ? ` · ${c.title}` : ""} ---`;
    const body = String(c.text || c.snippet || "").trim();
    if (used + head.length + body.length > BUDGET) break;
    lines.push(head);
    lines.push(body);
    lines.push("");
    used += head.length + body.length + 2;
  }
  const system = [
    "You are an investigator's analytic assistant. Answer the user's",
    "question using ONLY the supplied context passages. When you use a",
    "passage, cite it inline as [eid · page] using the EID exactly as",
    "it appears. If the context doesn't contain enough to answer, say so",
    "plainly — do not invent facts. Keep the answer under 300 words,",
    "terse and analytic.",
  ].join(" ");
  const user = lines.join("\n") + `\nQUESTION: ${question}`;
  return { system, user };
}

export async function generateAnswer({ question, contexts, modelId, onStatus, onProgress }) {
  if (!question) throw new Error("question required");
  if (!Array.isArray(contexts) || !contexts.length) throw new Error("contexts[] required");

  onStatus?.({ phase: "loading-model" });
  const gen = await loadGenerator(modelId, { onProgress });

  onStatus?.({ phase: "generating" });
  const { system, user } = buildSystemAndUser(question, contexts);
  const messages = [
    { role: "system", content: system },
    { role: "user",   content: user },
  ];

  const t0 = performance.now();
  const out = await gen(messages, {
    max_new_tokens: 512,
    do_sample: false,
    // temperature 0 / greedy — RAG QA wants determinism, not creativity.
    // The model's job is to surface what's in the context, not riff.
    return_full_text: false,
  });

  // transformers.js text-generation with chat input returns an array of
  // { generated_text: messages[] } where the last message is the
  // assistant reply. Different versions sometimes return strings — handle
  // both shapes defensively.
  let text = "";
  const first = Array.isArray(out) ? out[0] : out;
  const gt = first?.generated_text;
  if (typeof gt === "string") {
    text = gt;
  } else if (Array.isArray(gt)) {
    const assistant = [...gt].reverse().find(m => m.role === "assistant");
    text = assistant?.content || "";
  }
  text = (text || "").trim();

  return {
    text,
    durationMs: Math.round(performance.now() - t0),
    model: modelId,
    contextCount: contexts.length,
  };
}

// Curated list of small models known to work with transformers.js v3+.
// The Settings UI shows these as a dropdown so the user can swap
// without typing a model ID by hand. q4 sizes are approximate.
export const WEBLLM_MODELS = [
  { id: "onnx-community/Qwen2.5-0.5B-Instruct",        label: "Qwen2.5 0.5B (~400 MB)" },
  { id: "HuggingFaceTB/SmolLM2-360M-Instruct",         label: "SmolLM2 360M (~230 MB) · weakest" },
  { id: "HuggingFaceTB/SmolLM2-1.7B-Instruct",         label: "SmolLM2 1.7B (~1.1 GB) · best quality" },
  { id: "onnx-community/Llama-3.2-1B-Instruct",        label: "Llama 3.2 1B (~700 MB)" },
];
