# Volunteer Work Leasing — design + brutal analysis

> **Status: PROPOSAL / not built.** This documents a requested feature — live
> tracking of which volunteer is working on which page, with an auto-reassign
> timeout — and then argues honestly about whether (and how) to build it.
>
> TL;DR: the *need* is real but small; the *requested implementation* (an
> always-on tracking server with admin settings) is architecturally wrong for
> this project. The right-sized fix is a static claims file with a TTL, with a
> serverless function as a later escalation only if real concurrency appears.

---

## 1. The request

> "When things check in there should be a server component that does live
> tracking of what volunteers are working on. If they take too long the job
> goes to the next person after a 10-minute period, but that's configurable in
> the admin settings."

Decomposed, this asks for four things:

1. **Live claim tracking** — a central record of `{page → volunteer, claimed_at}`.
2. **Lease expiry** — a claim auto-expires after a timeout (default 10 min).
3. **Reassignment** — once expired, the page is free for the next volunteer.
4. **Admin settings** — the timeout (and presumably other knobs) are configurable.

The motivating problem is genuine: two volunteers can currently grab the same
page, and a volunteer who claims pages then walks away leaves that work in
limbo. This is already on the roadmap as R6 *"Auto-claim-then-warn for stale
claims."*

---

## 2. What the architecture actually is today

This matters because the request implicitly assumes a backend that does not
exist.

- **Hosting:** GitHub Pages. 100% static. No server process, no runtime, no
  database, no auth. (`SQL-MIGRATION-ROADMAP.md` → *"Not a server-side
  database. Stays static."*)
- **Work distribution:** `scripts/build-work-available.mjs` runs at **build
  time**, reads the maintainer's local `.vision-cache` / `.visuals`
  directories, and writes a static `public/work-available.json`. Volunteers
  `GET` that file. Nothing is POSTed back to any central service.
- **Claiming:** there is no claim. `volunteer.mjs` / `volunteer-media.mjs` pick
  pages by a deterministic rotation (`hash(handle) % docs`) plus a local
  already-done skip. Two volunteers with different handles start at different
  offsets; collisions are possible but not tracked.
- **Completion path:** claim → OCR/render locally → open a **PR** → maintainer
  merges → maintainer regenerates `work-available.json` → the page leaves the
  queue on the next deploy. **Latency from "done" to "queue updated" is hours,
  gated on a human merge + rebuild.**
- **Identity:** a handle is a self-asserted CLI flag (`--my-handle=foo`). There
  are no accounts, no tokens, no way to *authenticate* that a claim belongs to
  who it says.
- **Privacy promise:** the volunteer modal states verbatim: *"You stay in your
  own GitHub account; no central server holds your work."*

The whole contribution model is **fork-and-PR**, the same as any open-source
repo. There is deliberately no central authority.

---

## 3. Brutal analysis

### 3.1 The requested implementation fights the architecture

A live-tracking lease **server** introduces, in a project that has none of
these today:

| New requirement | Cost |
|---|---|
| An always-on host | Money + uptime + a thing that can go down and block all volunteers |
| Authentication | Handles are self-asserted. To trust a lease you need accounts/tokens — a login system the project explicitly avoids |
| Volunteers phoning home | The CLI currently only does a `GET` of a static JSON. Now every run POSTs claims/heartbeats to a central service — directly contradicting *"no central server holds your work"* |
| Admin settings UI + storage | A settings store, an admin auth boundary, a UI. More server. |
| A new single point of failure | If the lease server is down, can volunteers work? If "yes," the lease is advisory and you didn't need the server. If "no," you just made a static, resilient system fragile. |

That last row is the crux. **A lease is only enforceable if the work submission
goes through the same authority that issued the lease.** But submission here is
a GitHub PR — GitHub is the authority, and it has no idea about your lease. So
the lease can never be more than *advisory*. And an advisory lease does not need
a server — a file does.

### 3.2 The problem is real but tiny at current scale

- Concurrent volunteers right now: ~1 (the maintainer). R1 on the roadmap is
  *"get literally one outside person to run the flow end-to-end"* — that is the
  honest contributor count.
- Collision probability with a deterministic per-handle rotation offset is
  already low. Two volunteers collide only if they (a) run simultaneously and
  (b) their hash offsets land on overlapping doc ranges within a slice.
- The duplication cost when it *does* happen is one wasted OCR/render — minutes
  of compute, then the second PR is a no-op the maintainer closes. Annoying,
  not expensive.

Building an always-on, authenticated, admin-configurable lease server to
prevent occasional minutes-of-wasted-compute for a contributor base of ~1 is
textbook over-engineering. It is solving a scaling problem the project does not
yet have, at the cost of the simplicity that is currently its biggest asset.

### 3.3 The 10-minute timeout is mis-calibrated for the real flow

A 10-minute lease assumes a unit of work takes < 10 minutes and "abandonment"
is detectable in that window. But:

- An OCR slice of 20 pages can take ~30 minutes (the modal literally says
  *"~30 min of mostly-idle compute"*).
- The visuals flow is **claim → human reads/edits context → commit**, which can
  legitimately span hours or days (you stage templates, fill them when you have
  time).
- The real "page is taken" signal isn't a heartbeat — it's an **open PR**.

So a 10-minute reassign would actively *cause* the duplication it's meant to
prevent: volunteer A claims a 20-page OCR slice, is 12 minutes into honest work,
the lease expires, volunteer B grabs the same pages, and now they *both* finish
and open competing PRs. The timeout has to be matched to the real work unit, and
the real work unit is "until a PR appears," which is unbounded.

### 3.4 What's genuinely worth solving

Strip the request to its real kernel and two things are worth doing:

1. **Don't let two volunteers start the same page if one already has it in
   flight.** (Soft collision avoidance.)
2. **Don't let a page sit "claimed" forever if the claimer never ships.**
   (Stale-claim reclamation.)

Neither requires a server. Both are R6's *"claim file in
`public/claims/<handle>.json` with a TTL"* idea, which the maintainer already
scoped.

---

## 4. Right-sized design (recommended)

### Phase 0 — *already shipped in this work*

Local already-done dedup: the volunteer scripts skip any page that already has a
local contribution/staged template, so a single volunteer stops re-claiming
their own merged-but-not-yet-regenerated work. (This was the actual bug behind
"it re-served the same lot.") **Zero infra.**

### Phase 1 — static claims ledger (recommended next; no server)

A claim is a tiny JSON committed to the repo (or written to a Pages-hosted
side-channel) under `public/claims/`:

```
public/claims/<eid>/p<NNN>.json
{ "handle": "alice", "claimed_at": 1716200000, "lease_secs": 86400, "phase": "ocr" }
```

- **Claiming** = the volunteer script writes the file and opens (or amends) a
  lightweight "claims" PR, OR posts it to a claims branch. Reading the queue, a
  volunteer skips any page with a *non-expired* claim by someone else.
- **Lease expiry** = `now > claimed_at + lease_secs`. Expired claims are
  ignored (and garbage-collected by the build). **Default lease 24h, not 10
  min** — matched to the real "until a PR appears" work unit, configurable per
  run via `--lease-hours`.
- **Reassignment** = automatic and implicit: an expired claim simply stops
  being honored. No server decides anything.
- **Admin settings** = a committed `config/leasing.json`
  (`{ default_lease_secs, gc_after_secs }`) read at build time. Versioned,
  reviewable, no admin server.

This delivers all four requested behaviors (tracking, expiry, reassignment,
configurable timeout) with **no always-on infrastructure, no auth system, and
no breach of the "no central server holds your work" promise.** The trade-off
is that claims propagate at git/Pages latency (minutes), not real-time — which
is fine, because the work units are tens of minutes to days.

### Phase 2 — serverless claim function (only if real concurrency appears)

*Trigger criteria (do NOT build before these are true):*

- Sustained **≥ 5 concurrent active volunteers**, AND
- Observed duplicate-PR rate high enough that closing them is a real maintainer
  burden, AND
- Phase 1's git-latency claims are demonstrably too slow to prevent collisions.

Then, and only then, a **single stateless serverless function** (Cloudflare
Worker / Netlify / GitHub Actions `repository_dispatch`) backed by a KV store:

- `POST /claim {eid, page, handle}` → returns `{granted, until}` or `{taken_by}`.
- `POST /heartbeat` → extends the lease (for genuinely long single-page work).
- TTL handled by KV expiry; admin config in the same KV namespace.
- **Still advisory** — submission stays PR-based; the function only *coordinates*.

This is the closest thing to the user's "server component," but it is an
escalation gated on evidence, not a day-one build. And even here it's a
function, not a standing server, and it never holds the volunteer's work.

---

## 5. Recommendation

**Do not build the always-on tracking server now.** Ship Phase 1 (static claims
ledger with a 24h default lease, configurable via committed config) when a
*second* real volunteer exists — i.e., when R1 is satisfied and collisions
become possible in practice. Keep Phase 2 (serverless function) on the shelf
behind the explicit concurrency trigger above.

Building the server first would trade the project's defining strength —
zero-infra, resilient, private, fork-and-PR — for a coordination layer aimed at
a scale the project is nowhere near. The honest move is to fix the real bug
(done: dedup), document the lease design (this doc), and wait for evidence
before adding infrastructure.

---

_Companion to [ROADMAP.md](../ROADMAP.md) R6. Supersedes the one-line R6 bullet
"Auto-claim-then-warn for stale claims" with a phased plan + the analysis of
why the server-first version is the wrong order._
