// =====================================================================
// localStorage-backed settings for ASK's SMART mode.
//
// Two backends:
//
//   hosted     — Cloud RAG proxy (pursue-rag-server on Railway). The
//                deployed-site default. Just a URL + optional shared
//                bearer; the maintainer's Anthropic key sits on the
//                server, the visitor pastes nothing.
//
//   local-mcp  — pursue-vision-mcp on 127.0.0.1:9223. The user runs
//                the daemon themselves and routes through their own
//                logged-in Claude / ChatGPT / Gemini browser tab.
//                Needs the bearer token from ~/.pursue-vision-token.
//
// Both backends speak the same /ask wire protocol — only the URL +
// auth shape differs. ragClient.js branches on `backend`.
// =====================================================================

const KEY = "pursue:ask:settings:v1";

// Default Railway URL. Change after deploying pursue-rag-server to
// point at your service's public URL. Per-browser overrides via the
// settings panel still take precedence.
const DEFAULT_HOSTED_URL = "https://pursue-rag-production.up.railway.app";

const DEFAULTS = {
  backend: "hosted",                          // "hosted" | "local-mcp"
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
  { id: "hosted",    label: "Hosted (Railway)" },
  { id: "local-mcp", label: "Local MCP (pursue-vision-mcp)" },
];

export const PROVIDERS = [
  { id: "claude",  label: "Claude (claude.ai tab)" },
  { id: "chatgpt", label: "ChatGPT (chatgpt.com tab)" },
  { id: "gemini",  label: "Gemini (gemini.google.com tab)" },
];

