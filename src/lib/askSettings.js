// =====================================================================
// localStorage-backed settings for ASK's SMART mode.
//
// The user runs pursue-vision-mcp on their own machine. We need:
//  - daemonUrl: where the daemon binds (default http://127.0.0.1:9223).
//  - token:    the bearer token at ~/.pursue-vision-token (user pastes it).
//  - provider: which logged-in tab to route through (claude / chatgpt / gemini).
//  - k:        how many top retrieved passages to send as context.
// =====================================================================

const KEY = "pursue:ask:settings:v1";
const DEFAULTS = {
  daemonUrl: "http://127.0.0.1:9223",
  token: "",
  provider: "claude",
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

export const PROVIDERS = [
  { id: "claude",  label: "Claude (claude.ai tab)" },
  { id: "chatgpt", label: "ChatGPT (chatgpt.com tab)" },
  { id: "gemini",  label: "Gemini (gemini.google.com tab)" },
];
