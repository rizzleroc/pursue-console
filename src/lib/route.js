// Hash-based routing. Deployed to GitHub Pages under /pursue-console/, so a
// hash route (#/media, #/dossier/<id>) keeps deep links from 404-ing — the
// server only ever has to serve index.html.

export const VIEWS = [
  "live", "search", "semantic", "review", "media",
  "timeline", "atlas", "globe", "network", "help", "dossier",
];

const DEFAULT_VIEW = "live";

// "#/dossier/EVT-12?page=4" -> { view, eventId, page }
export function parseHash(hash) {
  const raw = (hash || "").replace(/^#/, "").replace(/^\//, "");
  const [path, search] = raw.split("?");
  const segments = path.split("/").filter(Boolean);

  let view = segments[0] || DEFAULT_VIEW;
  if (!VIEWS.includes(view)) view = DEFAULT_VIEW;

  const eventId = view === "dossier" ? (segments[1] ? decodeURIComponent(segments[1]) : null) : null;

  const params = new URLSearchParams(search || "");
  const pageRaw = params.get("page");
  const page = pageRaw != null && pageRaw !== "" && !Number.isNaN(Number(pageRaw)) ? Number(pageRaw) : null;

  return { view, eventId, page };
}

export function buildHash({ view = DEFAULT_VIEW, eventId = null, page = null } = {}) {
  let path = `/${view}`;
  if (view === "dossier" && eventId) path += `/${encodeURIComponent(eventId)}`;
  const params = new URLSearchParams();
  if (page != null) params.set("page", String(page));
  const search = params.toString();
  return `#${path}${search ? `?${search}` : ""}`;
}
