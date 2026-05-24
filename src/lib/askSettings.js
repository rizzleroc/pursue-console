// =====================================================================
// localStorage-backed settings for ASK's SMART mode.
//
// Three backends:
//
//   in-browser — A small instruction-tuned LLM (Qwen2.5-0.5B by
//                default) loaded into the browser via transformers.js,
//                cached in IndexedDB after first download. No server
//                of any kind. Just works on github.io — the default.
//                Trade-off: ~400 MB first-load; smaller models
//                hallucinate more than frontier ones.
//
//   hosted     — Cloud RAG proxy (pursue-rag-server on Railway). The
//                maintainer's Anthropic key sits on the server; the
//                visitor pastes nothing. Higher quality, but requires
//                the proxy to be deployed and the URL set below.
//
//   local-mcp  — pursue-vision-mcp on 127.0.0.1:9223. The user runs
//                the daemon themselves and routes through their own
//                logged-in Claude / ChatGPT / Gemini browser tab.
//                Needs the bearer token from ~/.pursue-vision-token.
//
// All three backends produce the same answer shape. ragClient.js
// branches on `backend` and either calls the in-browser pipeline
// directly or POSTs /ask on the remote service.
// =====================================================================

const KEY = "pursue:ask:settings:v1";

// Default Railway URL. Change after deploying pursue-rag-server to
// point at your service's public URL. Per-browser overrides via the
// settings panel still take precedence.
const DEFAULT_HOSTED_URL = "https://pursue-rag-production.up.railway.app";

// Default in-browser model. The curated picker (WEBLLM_MODELS in
// webllmClient.js) lets users swap without typing model IDs by hand.
const DEFAULT_MODEL_ID = "onnx-community/Qwen2.5-0.5B-Instruct";

const DEFAULTS = {
  backend: "in-browser",                      // "in-browser" | "hosted" | "local-mcp"
  modelId: DEFAULT_MODEL_ID,                  // in-browser only
  hostedUrl: DEFAULT_HOSTED_URL,
  hostedBearer: "",                           // optional shared secret
  daemonUrl: "http://127.0.0.1:9223",         // local-mcp only
  token: "",                                  // local-mcp bearer
  provider: "claude",                         // local-mcp only
  k: 10,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...DEFAULTS, ...s }));
  } catch {
    // localStorage disabled / private window — settings won't persist this
    // session, but the in-memory state still works.
  }
}

export const BACKENDS = [
  { id: "in-browser", label: "In-browser model (no setup)" },
  { id: "hosted",     label: "Hosted (Railway)" },
  { id: "local-mcp",  label: "Local MCP (pursue-vision-mcp)" },
];

export const PROVIDERS = [
  { id: "claude",  label: "Claude (claude.ai tab)" },
  { id: "chatgpt", label: "ChatGPT (chatgpt.com tab)" },
  { id: "gemini",  label: "Gemini (gemini.google.com tab)" },
];
