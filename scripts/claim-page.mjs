// Volunteer claim ledger.
//
// Claims prevent duplicate work: before a volunteer starts on a page they
// write a claim file; other volunteers see it and skip. Different task types
// can always coexist on the same page (vision + visual is fine). Same task
// type is limited by the phase's max_concurrent in config/leasing.json.
//
// Consensus rule (vision only):
//   First `consensus_passes` (default 3) concurrent vision claims are allowed
//   on any page — this builds a majority for cross-source agreement. After
//   max_concurrent active vision claims the page is closed to new vision work.
//
// Claim file locations:
//   Maintainer (writes directly): public/claims/<eid>/p<NNNN>.json
//   Volunteers (in their PR):     contributions/<handle>/claims/<eid>/p<NNNN>.json
//   import-contributions.mjs merges volunteer claims into public/claims/.
//
// Schema: { vision: [...], visual: [...], review: [...], revalidation: [...] }
// Each slot: { handle, claimed_at (unix seconds), lease_secs }

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
export const CLAIMS_DIR = path.join(ROOT, "public", "claims");
const LEASING_CONFIG = path.join(ROOT, "config", "leasing.json");

let _config = null;
export async function loadConfig() {
  if (_config) return _config;
  try { _config = JSON.parse(await readFile(LEASING_CONFIG, "utf8")); }
  catch {
    _config = {
      default_lease_secs: 86400,
      gc_after_secs: 604800,
      consensus_passes: 3,
      phases: {
        vision:      { max_concurrent: 3, lease_secs: 7200 },
        visual:      { max_concurrent: 1, lease_secs: 86400 },
        review:      { max_concurrent: 1, lease_secs: 86400 },
        revalidation:{ max_concurrent: 2, lease_secs: 7200 },
      },
    };
  }
  return _config;
}

function pad4(n) { return String(n).padStart(4, "0"); }

export function claimFilePath(eid, page) {
  return path.join(CLAIMS_DIR, eid, `p${pad4(page)}.json`);
}

export async function readClaims(eid, page) {
  const p = claimFilePath(eid, page);
  if (!existsSync(p)) return {};
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return {}; }
}

function activeSlots(slots, taskType, now) {
  return (slots[taskType] || []).filter(s => now < s.claimed_at + s.lease_secs);
}

// Returns true if this taskType slot is still open for claiming.
export async function isClaimable(eid, page, taskType) {
  const cfg = await loadConfig();
  const phase = cfg.phases[taskType] || { max_concurrent: 1, lease_secs: cfg.default_lease_secs };
  const slots = await readClaims(eid, page);
  const now = Math.floor(Date.now() / 1000);
  return activeSlots(slots, taskType, now).length < phase.max_concurrent;
}

// Write a claim for this page+taskType. Idempotent for the same handle.
// Returns the updated slots object.
export async function writeClaim(eid, page, handle, taskType, claimsRoot = CLAIMS_DIR) {
  const cfg = await loadConfig();
  const phase = cfg.phases[taskType] || { max_concurrent: 1, lease_secs: cfg.default_lease_secs };
  const claimPath = path.join(claimsRoot, eid, `p${pad4(page)}.json`);
  await mkdir(path.dirname(claimPath), { recursive: true });

  let slots = {};
  if (existsSync(claimPath)) {
    try { slots = JSON.parse(await readFile(claimPath, "utf8")); } catch {}
  }

  const now = Math.floor(Date.now() / 1000);
  // Expire stale entries across all types
  for (const type of Object.keys(slots)) {
    slots[type] = (slots[type] || []).filter(s => now < s.claimed_at + s.lease_secs);
  }
  if (!slots[taskType]) slots[taskType] = [];

  // Idempotent: don't double-add same handle
  const alreadyClaimed = slots[taskType].some(s => s.handle === handle);
  if (!alreadyClaimed) {
    slots[taskType].push({ handle, claimed_at: now, lease_secs: phase.lease_secs });
  }

  await writeFile(claimPath, JSON.stringify(slots, null, 2) + "\n", "utf8");
  return slots;
}

// Summary of active claims for a page (for embedding in work-available.json).
// Returns { vision: ["alice","bob"], visual: ["carol"] } or {}
export async function getClaimSummary(eid, page) {
  const slots = await readClaims(eid, page);
  const now = Math.floor(Date.now() / 1000);
  const out = {};
  for (const [type, list] of Object.entries(slots)) {
    const active = (list || []).filter(s => now < s.claimed_at + s.lease_secs).map(s => s.handle);
    if (active.length) out[type] = active;
  }
  return out;
}

// Garbage-collect expired claim files. Removes empty files; leaves active ones.
// Safe to run at build time.
export async function gcClaims(claimsRoot = CLAIMS_DIR) {
  if (!existsSync(claimsRoot)) return { removed: 0, kept: 0 };
  const cfg = await loadConfig();
  const gcAfter = cfg.gc_after_secs || 604800;
  const now = Math.floor(Date.now() / 1000);
  let removed = 0, kept = 0;

  const eids = (await readdir(claimsRoot, { withFileTypes: true })).filter(d => d.isDirectory());
  for (const eidEnt of eids) {
    const eidDir = path.join(claimsRoot, eidEnt.name);
    const files = (await readdir(eidDir)).filter(f => /^p\d+\.json$/.test(f));
    for (const f of files) {
      const fp = path.join(eidDir, f);
      try {
        const slots = JSON.parse(await readFile(fp, "utf8"));
        const anyActive = Object.values(slots).some(list =>
          (list || []).some(s => now < s.claimed_at + s.lease_secs)
        );
        const allExpiredLongAgo = Object.values(slots).every(list =>
          (list || []).every(s => now > s.claimed_at + gcAfter)
        );
        if (!anyActive && allExpiredLongAgo) {
          const { unlink } = await import("node:fs/promises");
          await unlink(fp);
          removed++;
        } else {
          kept++;
        }
      } catch { /* corrupt file — leave it */ kept++; }
    }
  }
  return { removed, kept };
}
