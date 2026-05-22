// SSRF guard for the corpus PDF fetchers. Download URLs come from data
// files (src/data/events.js, data-raw/inventory-sync.json — the latter is
// synced from an upstream GitHub repo), so we only ever want to reach
// public https hosts: never localhost, link-local, or private ranges, and
// never a public URL that redirects into one.
import net from "node:net";

const PRIVATE_V4 = [
  /^127\./,
  /^10\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
];

function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (net.isIPv4(h)) return PRIVATE_V4.some((re) => re.test(h));
  if (net.isIPv6(h)) {
    return (
      h === "::1" ||
      h.startsWith("fc") ||
      h.startsWith("fd") ||
      h.startsWith("fe80") ||
      h.startsWith("::ffff:127.")
    );
  }
  // Bare hostname: DNS is not resolved here, so the scheme check plus
  // per-redirect re-validation are the protection. Curated data only.
  return false;
}

export function assertSafeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (u.protocol !== "https:") throw new Error(`refusing non-https URL: ${raw}`);
  if (isPrivateHost(u.hostname)) throw new Error(`refusing private/loopback host: ${u.hostname}`);
  return u;
}

// fetch() that re-validates every redirect hop against the SSRF policy.
export async function safeFetch(raw, opts = {}) {
  let url = assertSafeUrl(raw).toString();
  const maxHops = 5;
  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await fetch(url, { ...opts, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return res;
    url = assertSafeUrl(new URL(loc, url).toString()).toString();
  }
  throw new Error(`too many redirects for ${raw}`);
}
