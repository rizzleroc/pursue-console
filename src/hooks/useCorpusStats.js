import { useEffect, useState } from "react";

// Shared hook for reading public/corpus-stats.json across every view.
// Replaces the half-dozen ad-hoc `let _byEventP = null` module-level
// caches that each view had to reimplement (TimelineView, AtlasView,
// NetworkView, HelpView, VolunteerModal, SemanticSearchView all rolled
// their own).
//
// Semantics:
//   - One in-flight fetch, shared across all consumers (cached promise)
//   - Revalidates every REVALIDATE_MS (default 60s) so a tab kept open
//     while a new deploy lands eventually catches up
//   - Survives a network blip via a single retry with backoff
//   - Returns `{ stats, error, reload }` — `reload()` forces a bust

const REVALIDATE_MS = 60_000;

let _cache = null;          // { promise, resolvedAt, value }
let _lastFetchedAt = 0;

function fetchStats(bust = false) {
  const url = `${import.meta.env.BASE_URL}corpus-stats.json${bust ? `?t=${Date.now()}` : ""}`;
  return fetch(url, { cache: bust ? "reload" : "default" })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .catch(async err => {
      // single retry with 800ms backoff for transient network blips
      await new Promise(r => setTimeout(r, 800));
      const r2 = await fetch(url, { cache: "reload" });
      if (!r2.ok) throw err;
      return r2.json();
    });
}

function loadStats(bust = false) {
  const now = Date.now();
  const stale = now - _lastFetchedAt > REVALIDATE_MS;
  if (bust || !_cache || stale) {
    _lastFetchedAt = now;
    _cache = { promise: fetchStats(bust || stale), resolvedAt: null, value: null };
    _cache.promise.then(v => { _cache.value = v; _cache.resolvedAt = Date.now(); }).catch(() => {});
  }
  return _cache.promise;
}

export default function useCorpusStats() {
  const [stats, setStats] = useState(_cache?.value ?? null);
  const [error, setError] = useState(null);

  async function reload(bust = true) {
    setError(null);
    try { setStats(await loadStats(bust)); }
    catch (e) { setError(e.message || String(e)); }
  }

  useEffect(() => {
    let cancelled = false;
    loadStats(false).then(v => { if (!cancelled) setStats(v); }).catch(e => { if (!cancelled) setError(e.message); });
    const id = setInterval(() => loadStats(true).then(v => { if (!cancelled) setStats(v); }).catch(() => {}), REVALIDATE_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return { stats, error, reload };
}
