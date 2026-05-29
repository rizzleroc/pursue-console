// Tests for scripts/lib/whipgen-fanout.mjs. Pure node, no test framework.
//
// Run: node scripts/test-whipgen-fanout.mjs
// Exit 0 on all pass, 1 on any fail.
//
// The wrapper takes its fetch, sleep, and log as `deps`, so all paths
// here are exercised deterministically without touching the network
// or waiting on a real wall-clock.
//
// Note on end-to-end verification: this test script stands in for a
// live `node scripts/reevaluate-disputed.mjs` run against the daemon.
// Issue #258 is precisely that the daemon's /fanout endpoint stalls,
// so a real run during this PR window would either hang for ~9 min/page
// or wedge the queue. Tests 3 and 8 deterministically simulate the
// hung-tab path (AbortError x3 → serial-fill / blocklist), which is the
// scenario the wrapper exists to handle.

import {
  fanoutWithFallback,
  createFailureBudget,
  FanoutAuthError,
  FanoutAllBlocklistedError,
} from "./lib/whipgen-fanout.mjs";

function makeFakeFetch(plan) {
  const calls = [];
  let i = 0;
  const fn = async (url, opts = {}) => {
    let body = null;
    try { body = opts.body ? JSON.parse(opts.body) : null; } catch {}
    calls.push({ url, body });
    const step = plan[i++];
    if (!step) {
      const err = new Error(`fake-fetch: exhausted plan at call ${i} (${url})`);
      err.detail = { calls };
      throw err;
    }
    if (step.throw) throw step.throw;
    const status = step.status ?? 200;
    const respBody = step.body ?? {};
    const respText = step.text ?? JSON.stringify(respBody);
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return respText; },
      async json() { return respBody; },
    };
  };
  fn.calls = calls;
  return fn;
}

function makeFakeSleep() {
  const sleeps = [];
  const fn = async (ms) => { sleeps.push(ms); };
  fn.sleeps = sleeps;
  return fn;
}

function makeFakeLog() {
  const events = [];
  const fn = (e) => events.push(e);
  fn.events = events;
  return fn;
}

function abortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

const OK_TEXT = "x".repeat(40);   // > 20 char min for "usable"
const BASE_ARGS = {
  daemonBaseUrl: "http://daemon",
  token: "TOK",
  providers: ["chatgpt", "gemini", "claude"],
  filePaths: ["/tmp/p.png"],
  prompt: "transcribe",
  label: "test",
  // Tighten retry/backoff so test logic is easier to reason about; the
  // production defaults are still covered by the schedule assertion.
  retryAttempts: 3,
  backoffMs: [2_000, 4_000, 8_000],
  perProviderFailureBudget: 2,
};

let pass = 0, fail = 0;
function assert(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.log(`  ✗ ${name}`); if (detail) console.log(`    ${detail}`); }
}
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

console.log("[whipgen-fanout]");

// ---- test 1: happy fanout ----
{
  const fetch = makeFakeFetch([
    { status: 200, body: { results: [
      { provider: "chatgpt", ok: true, text: OK_TEXT, durationMs: 100 },
      { provider: "gemini",  ok: true, text: OK_TEXT, durationMs: 110 },
      { provider: "claude",  ok: true, text: OK_TEXT, durationMs: 120 },
    ]}},
  ]);
  const sleep = makeFakeSleep();
  const log = makeFakeLog();
  const res = await fanoutWithFallback(BASE_ARGS, { fetch, sleep, log });
  assert("happy: path=fanout",       res.path === "fanout", `got ${res.path}`);
  assert("happy: 1 fetch call",      fetch.calls.length === 1, `got ${fetch.calls.length}`);
  assert("happy: no sleeps",         sleep.sleeps.length === 0);
  assert("happy: all providers ok",  Object.values(res.byProvider).every(p => p.ok));
}

// ---- test 2: partial fanout → serial-fill the missing provider ----
{
  const fetch = makeFakeFetch([
    { status: 200, body: { results: [
      { provider: "chatgpt", ok: true,  text: OK_TEXT, durationMs: 100 },
      { provider: "gemini",  ok: false, text: "",      durationMs: 60_000, error: "timeout" },
      { provider: "claude",  ok: true,  text: OK_TEXT, durationMs: 120 },
    ]}},
    // serial-fill for gemini
    { status: 200, body: { text: OK_TEXT + " fill" } },
  ]);
  const sleep = makeFakeSleep();
  const log = makeFakeLog();
  const res = await fanoutWithFallback(BASE_ARGS, { fetch, sleep, log });
  assert("partial: path=serial-fill",         res.path === "serial-fill", `got ${res.path}`);
  assert("partial: 2 fetch calls",            fetch.calls.length === 2, `got ${fetch.calls.length}`);
  assert("partial: serial-fill hit gemini",   fetch.calls[1].url.endsWith("/chat-with-files") && fetch.calls[1].body.provider === "gemini");
  assert("partial: gemini now ok",            res.byProvider.gemini.ok === true);
  assert("partial: no sleeps",                sleep.sleeps.length === 0);
}

// ---- test 3: fanout AbortError → retry/backoff → exhaust → serial-only ----
{
  const fetch = makeFakeFetch([
    { throw: abortError() },
    { throw: abortError() },
    { throw: abortError() },
    // serial-fill all three
    { status: 200, body: { text: OK_TEXT + " a" } },
    { status: 200, body: { text: OK_TEXT + " b" } },
    { status: 200, body: { text: OK_TEXT + " c" } },
  ]);
  const sleep = makeFakeSleep();
  const log = makeFakeLog();
  const res = await fanoutWithFallback(BASE_ARGS, { fetch, sleep, log });
  assert("abort: path=serial-only",   res.path === "serial-only", `got ${res.path}`);
  assert("abort: 6 fetch calls",      fetch.calls.length === 6, `got ${fetch.calls.length}`);
  assert("abort: backoff schedule",   deepEqual(sleep.sleeps, [2_000, 4_000]), `sleeps=${JSON.stringify(sleep.sleeps)}`);
  assert("abort: all providers ok",   Object.values(res.byProvider).every(p => p.ok));
  assert("abort: give-up logged",     log.events.some(e => e.event === "fanout-give-up"));
}

// ---- test 4: fanout 5xx → retry+backoff (same classification as transport) ----
{
  const fetch = makeFakeFetch([
    { status: 503, text: "upstream down" },
    { status: 200, body: { results: [
      { provider: "chatgpt", ok: true, text: OK_TEXT, durationMs: 100 },
      { provider: "gemini",  ok: true, text: OK_TEXT, durationMs: 100 },
      { provider: "claude",  ok: true, text: OK_TEXT, durationMs: 100 },
    ]}},
  ]);
  const sleep = makeFakeSleep();
  const log = makeFakeLog();
  const res = await fanoutWithFallback(BASE_ARGS, { fetch, sleep, log });
  assert("5xx: path=fanout (recovered)",  res.path === "fanout", `got ${res.path}`);
  assert("5xx: 2 fetch calls",            fetch.calls.length === 2);
  assert("5xx: 1 backoff",                deepEqual(sleep.sleeps, [2_000]));
}

// ---- test 5: fanout 401 → throw immediately, no retry, no fallback ----
{
  const fetch = makeFakeFetch([
    { status: 401, text: "bad token" },
  ]);
  const sleep = makeFakeSleep();
  const log = makeFakeLog();
  let caught = null;
  try { await fanoutWithFallback(BASE_ARGS, { fetch, sleep, log }); }
  catch (e) { caught = e; }
  assert("auth: throws FanoutAuthError", caught instanceof FanoutAuthError, `got ${caught?.constructor?.name}`);
  assert("auth: 1 fetch call",           fetch.calls.length === 1);
  assert("auth: 0 sleeps",               sleep.sleeps.length === 0);
}

// ---- test 6: unknown-provider error → throw immediately, no retry ----
{
  const fetch = makeFakeFetch([
    { status: 400, text: "unknown-provider: foo" },
  ]);
  const sleep = makeFakeSleep();
  const log = makeFakeLog();
  let caught = null;
  try { await fanoutWithFallback(BASE_ARGS, { fetch, sleep, log }); }
  catch (e) { caught = e; }
  assert("unknown-provider: throws", caught && /unknown-provider/i.test(caught.message), `got ${caught?.message}`);
  assert("unknown-provider: 1 fetch call", fetch.calls.length === 1);
  assert("unknown-provider: 0 sleeps", sleep.sleeps.length === 0);
}

// ---- test 7: failure budget — pre-blocklisted provider is skipped ----
{
  const budget = createFailureBudget();
  budget.set("gemini", 2);   // already at the budget
  const fetch = makeFakeFetch([
    { status: 200, body: { results: [
      { provider: "chatgpt", ok: true, text: OK_TEXT, durationMs: 100 },
      { provider: "claude",  ok: true, text: OK_TEXT, durationMs: 100 },
    ]}},
  ]);
  const sleep = makeFakeSleep();
  const log = makeFakeLog();
  const res = await fanoutWithFallback({ ...BASE_ARGS, failureBudget: budget }, { fetch, sleep, log });
  assert("budget: 1 fetch call",                 fetch.calls.length === 1);
  assert("budget: fanout omitted gemini",        deepEqual(fetch.calls[0].body.providers, ["chatgpt", "claude"]));
  assert("budget: gemini left no-attempt",       res.byProvider.gemini.error === "no-attempt");
  assert("budget: chatgpt+claude ok",            res.byProvider.chatgpt.ok && res.byProvider.claude.ok);
  assert("budget: drop event logged",            log.events.some(e => e.event === "providers-blocklisted-before-call" && deepEqual(e.dropped, ["gemini"])));
}

// ---- test 8: shared budget accrues across CONSECUTIVE failed calls ----
// Two bad pages → budget hits 2 → third page filters the provider out.
{
  const budget = createFailureBudget();

  // Plan for a single bad page: fanout returns gemini=fail, serial-fill
  // for gemini also fails. End-of-call: gemini counter += 1.
  function badPagePlan() {
    return [
      { status: 200, body: { results: [
        { provider: "chatgpt", ok: true,  text: OK_TEXT, durationMs: 100 },
        { provider: "gemini",  ok: false, text: "", durationMs: 60_000, error: "timeout" },
        { provider: "claude",  ok: true,  text: OK_TEXT, durationMs: 100 },
      ]}},
      { status: 502, text: "gemini upstream" }, // serial-fill for gemini fails
    ];
  }

  // Call 1
  await fanoutWithFallback({ ...BASE_ARGS, failureBudget: budget }, { fetch: makeFakeFetch(badPagePlan()), sleep: makeFakeSleep(), log: makeFakeLog() });
  assert("shared: gemini=1 after call 1", budget.get("gemini") === 1, `got ${budget.get("gemini")}`);

  // Call 2 — same failure shape
  await fanoutWithFallback({ ...BASE_ARGS, failureBudget: budget }, { fetch: makeFakeFetch(badPagePlan()), sleep: makeFakeSleep(), log: makeFakeLog() });
  assert("shared: gemini=2 after call 2", budget.get("gemini") === 2, `got ${budget.get("gemini")}`);

  // Call 3 — gemini now filtered out of the fanout body
  const fetch3 = makeFakeFetch([
    { status: 200, body: { results: [
      { provider: "chatgpt", ok: true, text: OK_TEXT, durationMs: 100 },
      { provider: "claude",  ok: true, text: OK_TEXT, durationMs: 100 },
    ]}},
  ]);
  const res3 = await fanoutWithFallback({ ...BASE_ARGS, failureBudget: budget }, { fetch: fetch3, sleep: makeFakeSleep(), log: makeFakeLog() });
  assert("shared: call 3 omits gemini",   deepEqual(fetch3.calls[0].body.providers, ["chatgpt", "claude"]));
  assert("shared: call 3 one fetch",      fetch3.calls.length === 1);
  assert("shared: call 3 path=fanout",    res3.path === "fanout");
}

// ---- test 9: all providers blocklisted → throws immediately ----
{
  const budget = createFailureBudget();
  for (const p of BASE_ARGS.providers) budget.set(p, 2);
  const fetch = makeFakeFetch([]);
  const sleep = makeFakeSleep();
  const log = makeFakeLog();
  let caught = null;
  try { await fanoutWithFallback({ ...BASE_ARGS, failureBudget: budget }, { fetch, sleep, log }); }
  catch (e) { caught = e; }
  assert("all-blocked: throws FanoutAllBlocklistedError", caught instanceof FanoutAllBlocklistedError);
  assert("all-blocked: 0 fetch calls",                    fetch.calls.length === 0);
}

// ---- test 10: a single bad page contributes ONE failure, not two ----
// Even when fanout AND serial-fill both fail for the same provider in the
// same call, the per-call budget delta is +1. This is the "consecutive
// page failures" semantic — a single ugly page shouldn't blocklist a
// provider for the rest of the queue.
{
  const budget = createFailureBudget();
  const fetch = makeFakeFetch([
    { status: 200, body: { results: [
      { provider: "chatgpt", ok: true,  text: OK_TEXT, durationMs: 100 },
      { provider: "gemini",  ok: false, text: "", durationMs: 60_000, error: "timeout" },
      { provider: "claude",  ok: true,  text: OK_TEXT, durationMs: 100 },
    ]}},
    { status: 502, text: "still down" }, // serial-fill for gemini also fails
  ]);
  const sleep = makeFakeSleep();
  const log = makeFakeLog();
  await fanoutWithFallback({ ...BASE_ARGS, failureBudget: budget }, { fetch, sleep, log });
  assert("single-fail: gemini budget = 1 (not 2)", budget.get("gemini") === 1, `got ${budget.get("gemini")}`);
  assert("single-fail: chatgpt reset to 0",        budget.get("chatgpt") === 0);
  assert("single-fail: claude reset to 0",         budget.get("claude") === 0);
}

// ---- test 11: success resets the consecutive-failure counter ----
// Distinguishes "fail twice in a row" from cumulative count. Across two
// calls, a success in between zeros the counter so a single later failure
// doesn't blocklist.
{
  const budget = createFailureBudget();

  // Call A: chatgpt fanout-fails, serial-fill recovers → count: 1 → 0.
  const fetchA = makeFakeFetch([
    { status: 200, body: { results: [
      { provider: "chatgpt", ok: false, text: "", durationMs: 60_000, error: "timeout" },
      { provider: "gemini",  ok: true,  text: OK_TEXT, durationMs: 100 },
      { provider: "claude",  ok: true,  text: OK_TEXT, durationMs: 100 },
    ]}},
    { status: 200, body: { text: OK_TEXT + " fill" } },
  ]);
  await fanoutWithFallback({ ...BASE_ARGS, failureBudget: budget }, { fetch: fetchA, sleep: makeFakeSleep(), log: makeFakeLog() });
  assert("reset: count zeroed after serial-fill success", budget.get("chatgpt") === 0, `got ${budget.get("chatgpt")}`);

  // Call B: chatgpt fanout-fails, serial-fill also fails → count: 1 → 2.
  const fetchB = makeFakeFetch([
    { status: 200, body: { results: [
      { provider: "chatgpt", ok: false, text: "", durationMs: 60_000, error: "timeout" },
      { provider: "gemini",  ok: true,  text: OK_TEXT, durationMs: 100 },
      { provider: "claude",  ok: true,  text: OK_TEXT, durationMs: 100 },
    ]}},
    { status: 500, text: "still down" },
  ]);
  await fanoutWithFallback({ ...BASE_ARGS, failureBudget: budget }, { fetch: fetchB, sleep: makeFakeSleep(), log: makeFakeLog() });
  assert("reset: count is 1 after fresh failure (was zeroed)", budget.get("chatgpt") === 1, `got ${budget.get("chatgpt")}`);
}

// ---- test 12: daemon-returned results for unrequested providers are ignored ----
// Defensive: if the daemon ever sends back a result entry for a provider
// the wrapper did NOT ask for (e.g., a residual entry or a misbehaving
// daemon), the wrapper must not overwrite byProvider or touch that
// provider's budget. Otherwise a blocklisted provider could be "revived"
// or re-bumped despite our explicit filter.
{
  const budget = createFailureBudget();
  budget.set("gemini", 2); // blocklisted
  const fetch = makeFakeFetch([
    { status: 200, body: { results: [
      { provider: "chatgpt", ok: true, text: OK_TEXT, durationMs: 100 },
      { provider: "claude",  ok: true, text: OK_TEXT, durationMs: 100 },
      // Daemon also returns gemini despite our filter — wrapper must ignore.
      { provider: "gemini",  ok: false, text: "", durationMs: 100, error: "spurious" },
    ]}},
  ]);
  const log = makeFakeLog();
  const res = await fanoutWithFallback({ ...BASE_ARGS, failureBudget: budget }, { fetch, sleep: makeFakeSleep(), log });
  assert("spurious: gemini stays at 2",            budget.get("gemini") === 2, `got ${budget.get("gemini")}`);
  assert("spurious: byProvider gemini=no-attempt", res.byProvider.gemini.error === "no-attempt");
  assert("spurious: warned in log",                log.events.some(e => e.event === "fanout-result-for-unrequested-provider" && e.provider === "gemini"));
}

console.log(`\n[whipgen-fanout] ${pass} passed · ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
