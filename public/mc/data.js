// Mission Control — shared live-data layer.
//
// The vanilla-JS counterpart to the React app's src/hooks/*. Fetches every
// public/*.json the console builds, caches each behind a single in-flight
// promise, revalidates on an interval, and exposes:
//
//   MC.ready()            → Promise resolving once all sources are loaded
//   MC.data               → { coverage, stats, nextMissing, patterns,
//                             media, feed, similarity, events } (raw JSON)
//   MC.get(path, fallback)→ safe deep-read, e.g. MC.get('stats.pages.vision')
//   MC.derive             → computed metrics (see below)
//   MC.bind()             → resolve every [data-mc="path"] text node
//   MC.onUpdate(fn)       → fn called after each (re)load
//
// Every /mc page includes this BEFORE chrome.js. Pages keep their baked-in
// numbers as the fallback so a fetch failure degrades to the static mockup
// rather than blanking out. When the corpus rebuilds, an open tab catches
// the new values within REVALIDATE_MS.

(function () {
  const REVALIDATE_MS = 60_000;
  // /mc/*.html → JSON lives one level up at the site root.
  const BASE = "../";

  const SOURCES = {
    coverage:   "coverage.json",
    stats:      "corpus-stats.json",
    nextMissing:"next-missing.json",
    patterns:   "patterns.json",
    media:      "media.json",
    feed:       "live-feed.json",
    similarity: "event-similarity.json",
    work:       "work-available.json",
    events:     "events.json",
    research:   "research-frameworks.json",
    entities:   "entities.json",
  };

  const MC = {
    data: {},
    _loaded: false,
    _listeners: [],
    _readyResolve: null,
  };
  MC._readyPromise = new Promise((res) => { MC._readyResolve = res; });

  function fetchJSON(file) {
    const url = BASE + file + "?t=" + Date.now();
    return fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .catch(async () => {
        // one retry
        await new Promise((r) => setTimeout(r, 600));
        const r2 = await fetch(BASE + file, { cache: "reload" });
        if (!r2.ok) throw new Error("HTTP " + r2.status);
        return r2.json();
      });
  }

  async function loadAll() {
    const keys = Object.keys(SOURCES);
    const results = await Promise.allSettled(keys.map((k) => fetchJSON(SOURCES[k])));
    results.forEach((res, i) => {
      if (res.status === "fulfilled") MC.data[keys[i]] = res.value;
      // on rejection: leave whatever we had (or undefined → fallbacks kick in)
    });
    MC._loaded = true;
    MC._computeDerived();
    MC._readyResolve(MC);
    MC._listeners.forEach((fn) => { try { fn(MC); } catch (e) { console.warn(e); } });
  }

  MC.ready = () => MC._readyPromise;
  MC.onUpdate = (fn) => { MC._listeners.push(fn); if (MC._loaded) fn(MC); };

  MC.get = (path, fallback) => {
    const parts = path.split(".");
    let v = MC.data;
    for (const p of parts) {
      if (v == null) return fallback;
      // support array index and bracket keys like byRelease['Release 01']
      v = v[p];
    }
    return v == null ? fallback : v;
  };

  // ─────────── Derived metrics (the numbers the pages actually show) ───────────
  MC._computeDerived = function () {
    const d = MC.data;
    const D = {};

    // Coverage --------------------------------------------------------------
    const cov = d.coverage || {};
    const byEvent = Array.isArray(cov.byEvent) ? cov.byEvent : [];
    const status = (s) => byEvent.filter((e) => e.status === s).length;
    D.coverageTotal   = byEvent.length || cov.events || 0;
    D.coverageComplete= status("complete");
    D.coveragePartial = status("gap") + status("mismatch");
    D.coverageNoData  = status("no-data");
    D.coverageAwaitingPct = D.coverageTotal
      ? Math.round(((D.coveragePartial + D.coverageNoData) / D.coverageTotal) * 100)
      : 0;
    // grid cells: map each event to a simplified class (complete|partial|empty)
    D.coverageCells = byEvent.map((e) =>
      e.status === "complete" ? "complete"
      : e.status === "no-data" ? "empty"
      : "partial"
    );

    // Corpus stats ----------------------------------------------------------
    const s = d.stats || {};
    const rel = s.byRelease || {};
    const r1 = rel["Release 01"] || {};
    const r2 = rel["Release 02"] || {};
    D.r1Catalogued = r1.catalogued ?? null;
    D.r1Inventory  = r1.inventoryTotal ?? null;
    D.r2Catalogued = r2.catalogued ?? null;
    D.r2Inventory  = r2.inventoryTotal ?? null;
    D.pagesIndexed = s.pages?.totalIndexed ?? null;
    D.pagesChars   = s.pages?.totalChars ?? null;
    D.pagesVision  = s.pages?.vision ?? null;
    D.pagesOcr     = s.pages?.ocrOnly ?? null;
    D.charsM       = D.pagesChars ? (D.pagesChars / 1e6).toFixed(2) + "M" : null;
    // document-progress buckets (real corpus-stats shape)
    D.gapUncatalogued = s.gap?.uncataloguedRecords ?? null;
    D.gapNoPages      = s.gap?.cataloguedButNoPages ?? null;
    D.gapNeedsVision  = s.gap?.partialOcrNeedsVision ?? null;
    D.eventsFullyVision = s.events?.fullyVision ?? null;
    D.reviewCount  = s.review?.pagesNeedingReview ?? 0;
    D.inventoryTotal = s.inventory?.total ?? null;

    // Next-missing ----------------------------------------------------------
    const q = (d.nextMissing && d.nextMissing.queue) || [];
    D.queue = q;
    D.queueTop = q[0] || null;
    D.queueTop8 = q.slice(0, 8);

    // Patterns --------------------------------------------------------------
    const pk = (d.patterns && d.patterns.byKind) || {};
    D.entityCount = (pk.entity || []).length;
    D.dateCount   = (pk.date || []).length;
    D.topEntities = (pk.entity || [])
      .slice()
      .sort((a, b) => (b.total || 0) - (a.total || 0))
      .slice(0, 8)
      .map((e) => ({ term: e.term, mentions: e.total, docs: e.docCount }));
    D.topShapes   = (pk.shape || []).map((e) => ({ term: e.term, n: e.total }));
    D.topBehaviors= (pk.behavior || []).map((e) => ({ term: e.term, n: e.total }));
    D.topSensors  = (pk.sensor || []).map((e) => ({ term: e.term, n: e.total }));

    // Media -----------------------------------------------------------------
    const m = d.media || {};
    D.mediaTotal = m.total ?? (m.items ? m.items.length : null);
    D.mediaEvents = m.eventCount ?? null;
    D.mediaByKind = m.byKind || {};
    D.mediaItems = m.items || [];

    // Feed ------------------------------------------------------------------
    const f = d.feed || {};
    D.feedCount = f.count ?? (f.entries ? f.entries.length : 0);
    D.feedEntries = f.entries || [];
    D.feedVision = f.stats?.bySource?.vision ?? null;
    D.feedOcr    = f.stats?.bySource?.ocr ?? null;
    D.mediaTypeCounts = m.byKind || {};

    // Events ----------------------------------------------------------------
    const ev = (d.events && d.events.events) || [];
    D.events = ev;
    D.eventCount = ev.length;
    D.byAgency = tally(ev, "agency");
    D.byRegion = tally(ev, "region");
    D.byEra    = tally(ev, "era");
    D.byFlag   = tally(ev, "flag");

    // Similarity ------------------------------------------------------------
    D.similarity = (d.similarity && d.similarity.events) || {};

    // Priority / Evidence / Cross-references --------------------------------
    // Built once at load — cheap, since EVENTS is ~220 rows.
    D.priorityEvents = ev.filter((e) => e.priority);
    D.physicsEvents  = ev.filter((e) => Array.isArray(e.category) && e.category.indexOf("physics-relevant") !== -1);
    D.criticalCount  = ev.filter((e) => e.priority === "critical").length;
    D.priorityCount  = D.priorityEvents.length;
    D.physicsCount   = D.physicsEvents.length;
    D.crossRefCount  = ev.reduce((n, e) => n + (Array.isArray(e.crossRefs) ? e.crossRefs.length : 0), 0);

    // Research index — flatten the four sub-collections so MC.byRefId() is O(1).
    const research = d.research || {};
    const refIndex = {};
    ["reports", "programs", "frameworks", "facilities", "sensors"].forEach((kind) => {
      (research[kind] || []).forEach((row) => {
        if (row && row.id) refIndex[row.id] = Object.assign({ kind: kind.replace(/s$/, "") }, row);
      });
    });
    D.refIndex = refIndex;
    D.reports     = research.reports     || [];
    D.programs    = research.programs    || [];
    D.frameworks  = research.frameworks  || [];
    D.facilities  = research.facilities  || [];
    D.sensors     = research.sensors     || [];

    // Entity catalogue — hand-curated bipartite event↔entity index.
    // Each entity carries { id, name, kind, events: [...] }. We build
    // forward + reverse indexes once so MC.entityById / MC.entitiesByEid
    // are O(1) lookups.
    const ents = (d.entities && d.entities.entities) || [];
    D.entities = ents;
    D.entityKinds = (d.entities && d.entities.kinds) || {};
    D.entityById = {};
    D.entitiesByEid = {};
    ents.forEach((en) => {
      D.entityById[en.id] = en;
      (en.events || []).forEach((eid) => {
        if (!D.entitiesByEid[eid]) D.entitiesByEid[eid] = [];
        D.entitiesByEid[eid].push(en);
      });
    });
    D.entityCatalogueCount = ents.length;

    MC.derive = D;
  };

  function tally(arr, key) {
    const out = {};
    for (const x of arr) { const k = x[key] || "Unknown"; out[k] = (out[k] || 0) + 1; }
    return out;
  }

  // neighbors for a given eid (dossier / network)
  MC.neighbors = (eid, n = 10) => {
    const e = (MC.derive && MC.derive.similarity[eid]) || null;
    return e && e.neighbors ? e.neighbors.slice(0, n) : [];
  };
  // entities mentioned in one event (dossier)
  MC.entitiesForEvent = (eid, n = 8) => {
    const ents = MC.get("patterns.byKind.entity", []);
    return ents
      .map((e) => {
        const hit = (e.events || []).find((x) => x.eid === eid);
        return hit ? { term: e.term, count: hit.count, docs: e.docCount } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.count - a.count)
      .slice(0, n);
  };
  // shape/behavior/sensor terms for one event (dossier signatures)
  MC.signaturesForEvent = (eid) => {
    const out = { shape: [], behavior: [], sensor: [] };
    for (const k of Object.keys(out)) {
      const bucket = MC.get(`patterns.byKind.${k}`, []);
      out[k] = bucket
        .map((t) => {
          const hit = (t.events || []).find((x) => x.eid === eid);
          return hit ? { term: t.term, count: hit.count } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
    }
    return out;
  };
  // event metadata lookup (by id)
  MC.byEid = (eid) => {
    if (!MC.derive || !MC.derive.events) return null;
    return MC.derive.events.find((e) => e.id === eid) || null;
  };
  // research-frameworks lookup — reports / programs / frameworks / facilities / sensors
  // shaped from public/research-frameworks.json
  MC.byRefId = (id) => {
    return (MC.derive && MC.derive.refIndex && MC.derive.refIndex[id]) || null;
  };
  // cross-references for an event — each entry is enriched with the resolved target
  // (resolved=null if the id points outside the index, which is fine; the caller falls back)
  MC.crossRefsForEvent = (eid) => {
    const ev = MC.byEid(eid);
    const out = (ev && Array.isArray(ev.crossRefs)) ? ev.crossRefs : [];
    return out.map((ref) => ({
      ...ref,
      resolved: ref.type === "event" ? MC.byEid(ref.id) : MC.byRefId(ref.id),
    }));
  };
  // reverse: events that reference a given target id (event/report/program/framework/facility/sensor)
  MC.eventsReferencing = (targetId) => {
    const events = (MC.derive && MC.derive.events) || [];
    return events.filter((e) => Array.isArray(e.crossRefs) && e.crossRefs.some((r) => r.id === targetId));
  };
  // filter helpers
  MC.byPriority   = (level)       => ((MC.derive && MC.derive.events) || []).filter((e) => e.priority === level);
  MC.byCategory   = (categoryTag) => ((MC.derive && MC.derive.events) || []).filter((e) => Array.isArray(e.category) && e.category.indexOf(categoryTag) !== -1);
  MC.byEvidenceType = (kind)      => ((MC.derive && MC.derive.events) || []).filter((e) => Array.isArray(e.evidenceTypes) && e.evidenceTypes.indexOf(kind) !== -1);

  // ── Entity catalogue (entities.json) ──
  MC.entityById     = (id)   => (MC.derive && MC.derive.entityById && MC.derive.entityById[id]) || null;
  MC.entitiesForEid = (eid)  => ((MC.derive && MC.derive.entitiesByEid && MC.derive.entitiesByEid[eid]) || []).slice();
  MC.entitiesByKind = (kind) => ((MC.derive && MC.derive.entities) || []).filter((e) => e.kind === kind);

  // ── Convenience helpers (additive) ──
  // Media items attached to an event (returns [] if media not loaded).
  MC.mediaForEid = (eid) => {
    if (!eid) return [];
    const items = (MC.derive && Array.isArray(MC.derive.mediaItems)) ? MC.derive.mediaItems : [];
    return items.filter((m) => m && m.eventId === eid);
  };

  // Coverage row for one event, normalised to {status, complete, total, percent}.
  // Tolerates both {eid,complete,total} and the corpus shape {eventId,pagesTouched,totalPages}.
  MC.coverageForEid = (eid) => {
    if (!eid) return null;
    const byEvent = MC.get("coverage.byEvent", []);
    if (!Array.isArray(byEvent)) return null;
    const row = byEvent.find((e) => e && (e.eid === eid || e.eventId === eid || e.id === eid));
    if (!row) return null;
    const complete = (row.complete != null ? row.complete : row.pagesTouched) || 0;
    const total = (row.total != null ? row.total : row.totalPages) || 0;
    const percent = total > 0 ? Math.round((complete / total) * 100) : 0;
    return { status: row.status || null, complete, total, percent };
  };

  // Quick free-text search across event metadata. Returns array sorted by score desc.
  MC.searchEvents = (query, options) => {
    const events = (MC.derive && MC.derive.events) || [];
    if (!events.length) return [];
    const q = (query == null ? "" : String(query)).trim().toLowerCase();
    if (!q) return [];
    const opts = options || {};
    const limit = typeof opts.limit === "number" ? opts.limit : 24;
    const fields = Array.isArray(opts.fields) && opts.fields.length
      ? opts.fields
      : ["title", "id", "agency", "region", "era", "type"];
    const terms = q.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const ev of events) {
      let score = 0;
      for (const f of fields) {
        const raw = ev && ev[f];
        if (raw == null) continue;
        const hay = String(Array.isArray(raw) ? raw.join(" ") : raw).toLowerCase();
        for (const t of terms) {
          if (!t) continue;
          if (hay === t) score += 10;
          else if (hay.startsWith(t)) score += 5;
          else if (hay.indexOf(t) !== -1) score += 2;
        }
      }
      if (score > 0) scored.push({ ev, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.ev);
  };

  // Most-recent generatedAt across every loaded source. Returns ISO string or "" if none.
  MC.lastBuildAt = () => {
    const d = MC.data || {};
    let best = 0;
    let bestRaw = "";
    for (const key of Object.keys(d)) {
      const src = d[key];
      if (!src) continue;
      const raw = src.generatedAt || src.generated_at || src.builtAt || src.built_at || null;
      if (!raw) continue;
      const t = Date.parse(raw);
      if (!isNaN(t) && t > best) { best = t; bestRaw = raw; }
    }
    return bestRaw;
  };

  // Human-friendly "Nm ago" / "Nh ago" / "Nd ago" relative string.
  MC.humanAgo = (ts) => {
    if (ts == null || ts === "") return "";
    let t;
    if (typeof ts === "number") t = ts;
    else if (ts instanceof Date) t = ts.getTime();
    else t = Date.parse(String(ts));
    if (isNaN(t)) return "";
    const diff = Date.now() - t;
    if (diff < 0) return "just now";
    const s = Math.floor(diff / 1000);
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    const days = Math.floor(h / 24);
    return days + "d ago";
  };

  // ── Header filters — sessionStorage-backed, piped into every view ──
  // Lets the topbar's search box + agency / type dropdowns drive every
  // surface the way the React Header does. Pages read MC.headerFilters
  // on load; live filter changes fire a 'mc:filters' CustomEvent on
  // window so views can refresh without a reload.
  const HF_KEY = 'mc.headerFilters.v1';
  MC.headerFilters = (() => {
    try {
      const raw = sessionStorage.getItem(HF_KEY);
      return raw ? Object.assign({ query: '', agency: 'all', type: 'all' }, JSON.parse(raw)) : { query: '', agency: 'all', type: 'all' };
    } catch (e) { return { query: '', agency: 'all', type: 'all' }; }
  })();
  MC.setHeaderFilters = (patch) => {
    MC.headerFilters = Object.assign({}, MC.headerFilters, patch || {});
    try { sessionStorage.setItem(HF_KEY, JSON.stringify(MC.headerFilters)); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('mc:filters', { detail: MC.headerFilters })); } catch (e) {}
  };
  MC.onHeaderFilters = (fn) => {
    const h = (e) => fn(e.detail || MC.headerFilters);
    window.addEventListener('mc:filters', h);
    return () => window.removeEventListener('mc:filters', h);
  };
  // URL helpers
  MC.url = {
    dossier: (eid, extra = "") => `dossier.html?eid=${encodeURIComponent(eid)}${extra ? "&" + extra : ""}`,
    evidence: (eid)            => `evidence.html${eid ? "?eid=" + encodeURIComponent(eid) : ""}`,
    claim:   (eid, page) => {
      // Pre-fill a GitHub issue against the repo, type:cataloguing label,
      // body referencing the eid + page so a volunteer can pick it up.
      const repo = "rizzleroc/pursue-console";
      const title = `[transcribe] ${eid} · p${page || 1}`;
      const body = `Claim this page for transcription. Source: \`public/next-missing.json\` queue.\n\n- **Event:** \`${eid}\`\n- **Page:** ${page || 1}\n\nSee HOW-CAN-I-HELP.md for the workflow.`;
      return `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=cataloguing`;
    },
  };
  // URL query parsing
  MC.query = (() => {
    const qs = new URLSearchParams(window.location.search);
    const out = {};
    qs.forEach((v, k) => { out[k] = v; });
    return out;
  })();

  // ─────────── Declarative text binding ───────────
  // <span data-mc="r1Catalogued"></span>  → MC.derive.r1Catalogued
  // <span data-mc="stats.pages.vision"></span> → MC.get(...)
  // Supports data-mc-format="comma" for thousands separators.
  MC.bind = function (root) {
    (root || document).querySelectorAll("[data-mc]").forEach((el) => {
      const key = el.getAttribute("data-mc");
      let v = (MC.derive && key in MC.derive) ? MC.derive[key] : MC.get(key, undefined);
      if (v == null) return; // keep fallback text already in the element
      const fmt = el.getAttribute("data-mc-format");
      if (fmt === "comma" && typeof v === "number") v = v.toLocaleString();
      el.textContent = v;
    });
  };

  // Auto-bind on every load, and let count-up (chrome.js) read live targets.
  MC.onUpdate(() => MC.bind());

  // Kick off
  loadAll();
  setInterval(loadAll, REVALIDATE_MS);

  window.MC = MC;
})();
