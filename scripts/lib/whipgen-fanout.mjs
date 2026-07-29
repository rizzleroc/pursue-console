// whipgen-fanout.mjs — hardened fanout caller with bounded failure +
// serial-fill fallback.
//
// Background: the whipgen MCP daemon's /fanout endpoint stalls indefinitely
// when one or more browser tabs gets stuck behind a captcha, session-expired
// modal, or non-terminating stream (issue #258). The tabs accept the prompt
// but never produce a "stop streaming" event, so the daemon waits its full
// per-provider deadline (sometimes 500+s) before cancelling. Repeated runs
// against the same page burn hours.
//
// This wrapper bounds that failure mode and degrades gracefully:
//
//   1. /fanout call is wrapped in a wall-clock deadline (default 90s). If
//      it returns nothing in that window the AbortController fires.
//   2. Transport-level failures (AbortError, fetch failed, HTTP 5xx) are
//      retried with exponential backoff (default [2s, 4s, 8s]).
//   3. After fanout returns (or transport gives up), any provider with no
//      result gets a *serial* /chat-with-files attempt with its own
//      per-provider wall-clock (default 60s). This preserves the issue's
//      observation that ChatGPT-text often still works while the others
//      hang — we capture partial success instead of failing the whole page.
//   4. A shared failure budget counts CONSECUTIVE per-provider failures
//      across wrapper calls in one script run. Any success (in /fanout or
//      in serial fill) zeros the counter. Once a provider hits the budget
//      (default 2 in a row), it's filtered out of subsequent calls so a
//      stuck provider doesn't waste 60s per page across the whole queue.
//   5. Auth errors (401/403) and unknown-provider errors short-circuit
//      with no retry — those won't fix themselves.
//
// What this wrapper does NOT do: it cannot "fix" a hung browser tab. If
// every provider is stuck, every path here will time out and return a
// failed result. The wrapper's job is to fail fast, preserve any
// partial wins, and let the caller continue to the next page.
//
// Public surface:
//   createFailureBudget()          → Map<provider, failureCount>
//   fanoutWithFallback(args, deps) → { byProvider, totalMs, path }
//
// `byProvider` is the same shape /fanout already returns:
//   { [provider]: { ok, text, durationMs, error? } }
// `path` is one of "fanout" | "serial-fill" | "serial-only" | "failed"
// so callers can log which strategy actually delivered the result.

const DEFAULTS = {
  fanoutDeadlineMs: 90_000,
  serialPerProviderMs: 60_000,
  perProviderTimeoutMs: 60_000,
  retryAttempts: 3,
  backoffMs: [2_000, 4_000, 8_000],
  perProviderFailureBudget: 2,
  minTextLength: 20,
};

export function createFailureBudget() {
  return new Map();
}

export class FanoutAuthError extends Error {
  constructor(message) { super(message); this.code = "auth"; }
}
export class FanoutAllBlocklistedError extends Error {
  constructor(providers) {
    super(`all providers blocklisted: ${providers.join(",")}`);
    this.code = "all-providers-blocklisted";
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultLog(event) {
  process.stderr.write(`[whipgen] ${JSON.stringify(event)}\n`);
}

function classifyError(err, status) {
  if (status === 401 || status === 403) return "auth";
  if (status && status >= 500) return "transport";
  if (err?.name === "AbortError") return "transport";
  if (err?.name === "TypeError") return "transport"; // node fetch failure
  const msg = err?.message || "";
  if (/fetch failed/i.test(msg)) return "transport";
  // Match the daemon's various spellings: "unknown-provider", "unknown_provider",
  // "unknown provider", "UnknownProvider", and JSON-wrapped variants thereof.
  if (/unknown[\s_-]?provider/i.test(msg)) return "unknown-provider";
  return "unknown";
}

function pickByProvider(body) {
  const results = Array.isArray(body?.results) ? body.results : [];
  const out = {};
  for (const r of results) {
    if (!r || typeof r.provider !== "string") continue;
    out[r.provider] = {
      ok: !!r.ok,
      text: typeof r.text === "string" ? r.text : "",
      durationMs: Number.isFinite(r.durationMs) ? r.durationMs : null,
      error: r.error || null,
    };
  }
  return out;
}

function isUsable(result, minTextLength) {
  return !!(result?.ok && typeof result.text === "string" && result.text.trim().length >= minTextLength);
}

async function callFanout({ daemonBaseUrl, token, providers, filePaths, prompt, perProviderTimeoutMs, freshChat, label, deadlineMs, fetchImpl }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deadlineMs);
  try {
    const r = await fetchImpl(`${daemonBaseUrl}/fanout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ providers, filePaths, prompt, perProviderTimeoutMs, freshChat, label }),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      const err = new Error(`/fanout HTTP ${r.status}: ${text.slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function callChatWithFiles({ daemonBaseUrl, token, provider, filePaths, prompt, freshChat, deadlineMs, fetchImpl }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deadlineMs);
  const started = Date.now();
  try {
    const r = await fetchImpl(`${daemonBaseUrl}/chat-with-files`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ provider, filePaths, prompt, freshChat, timeoutMs: deadlineMs }),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      const err = new Error(`/chat-with-files HTTP ${r.status}: ${text.slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    const body = await r.json();
    const text = body?.text ?? body?.result?.text ?? body?.output ?? "";
    return { ok: !!text, text: String(text || ""), durationMs: Date.now() - started, error: text ? null : "empty response" };
  } finally {
    clearTimeout(timer);
  }
}

export async function fanoutWithFallback(args, deps = {}) {
  const {
    daemonBaseUrl,
    token,
    providers,
    filePaths,
    prompt,
    label,
    freshChat = true,
    perProviderTimeoutMs = DEFAULTS.perProviderTimeoutMs,
    fanoutDeadlineMs = DEFAULTS.fanoutDeadlineMs,
    serialPerProviderMs = DEFAULTS.serialPerProviderMs,
    retryAttempts = DEFAULTS.retryAttempts,
    backoffMs = DEFAULTS.backoffMs,
    perProviderFailureBudget = DEFAULTS.perProviderFailureBudget,
    minTextLength = DEFAULTS.minTextLength,
    failureBudget = createFailureBudget(),
  } = args;

  const fetchImpl = deps.fetch || globalThis.fetch;
  const sleep = deps.sleep || defaultSleep;
  const log = deps.log || defaultLog;

  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("fanoutWithFallback: providers must be a non-empty array");
  }

  const startedAt = Date.now();
  const allowed = providers.filter(p => (failureBudget.get(p) || 0) < perProviderFailureBudget);
  if (allowed.length === 0) {
    log({ event: "all-providers-blocklisted", providers, budget: Object.fromEntries(failureBudget) });
    throw new FanoutAllBlocklistedError(providers);
  }
  if (allowed.length < providers.length) {
    const dropped = providers.filter(p => !allowed.includes(p));
    log({ event: "providers-blocklisted-before-call", dropped, budget: Object.fromEntries(failureBudget) });
  }

  let fanoutBody = null;
  let fanoutErrored = false;
  let lastTransportErr = null;
  for (let attempt = 1; attempt <= retryAttempts; attempt++) {
    try {
      log({ event: "fanout-attempt", attempt, deadlineMs: fanoutDeadlineMs, providers: allowed });
      fanoutBody = await callFanout({
        daemonBaseUrl, token, providers: allowed, filePaths, prompt,
        perProviderTimeoutMs, freshChat, label, deadlineMs: fanoutDeadlineMs, fetchImpl,
      });
      break;
    } catch (err) {
      const kind = classifyError(err, err?.status);
      if (kind === "auth") {
        log({ event: "fanout-auth-error", status: err.status, message: err.message });
        throw new FanoutAuthError(err.message);
      }
      if (kind === "unknown-provider") {
        log({ event: "fanout-unknown-provider", message: err.message });
        throw err;
      }
      lastTransportErr = err;
      const sleepMs = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)];
      if (attempt < retryAttempts) {
        log({ event: "fanout-retry", attempt, reason: err?.name || "error", message: (err?.message || "").slice(0, 160), sleepMs });
        await sleep(sleepMs);
      } else {
        log({ event: "fanout-give-up", attempts: retryAttempts, reason: err?.name || "error", message: (err?.message || "").slice(0, 160) });
        fanoutErrored = true;
      }
    }
  }

  const byProvider = {};
  for (const p of providers) byProvider[p] = { ok: false, text: "", durationMs: null, error: "no-attempt" };

  // Budget changes are applied ONCE per provider per call, at the end
  // (success → reset to 0; failure → +1; not-attempted → leave alone).
  // This preserves the "consecutive-failure" semantics: a single bad page
  // contributes at most one failure to a provider's counter, even if it
  // failed in both /fanout and the /chat-with-files retry.
  const allowedSet = new Set(allowed);

  if (fanoutBody) {
    const harvested = pickByProvider(fanoutBody);
    for (const [p, r] of Object.entries(harvested)) {
      if (!allowedSet.has(p)) {
        log({ event: "fanout-result-for-unrequested-provider", provider: p });
        continue;
      }
      byProvider[p] = r;
      if (!isUsable(r, minTextLength)) {
        log({ event: "provider-failed-in-fanout", provider: p, error: r.error });
      }
    }
  }

  const missing = allowed.filter(p => !isUsable(byProvider[p], minTextLength));
  let serialFilledAny = false;
  if (missing.length) {
    log({ event: "serial-fill-start", providers: missing, reason: fanoutErrored ? "fanout-transport-failed" : "fanout-partial" });
    for (const p of missing) {
      try {
        const r = await callChatWithFiles({
          daemonBaseUrl, token, provider: p, filePaths, prompt, freshChat,
          deadlineMs: serialPerProviderMs, fetchImpl,
        });
        byProvider[p] = r;
        if (isUsable(r, minTextLength)) {
          serialFilledAny = true;
          log({ event: "serial-fill-ok", provider: p, durationMs: r.durationMs });
        } else {
          log({ event: "serial-fill-empty", provider: p });
        }
      } catch (err) {
        const kind = classifyError(err, err?.status);
        if (kind === "auth") {
          log({ event: "serial-fill-auth-error", provider: p });
          throw new FanoutAuthError(err.message);
        }
        byProvider[p] = { ok: false, text: "", durationMs: null, error: (err?.message || "error").slice(0, 200) };
        log({ event: "serial-fill-failed", provider: p, error: err?.name || "error", message: (err?.message || "").slice(0, 160) });
      }
    }
  }

  // Apply per-call budget changes once each. Providers we never attempted
  // (filtered out at the start) keep their existing counter untouched.
  for (const p of allowed) {
    if (isUsable(byProvider[p], minTextLength)) {
      failureBudget.set(p, 0);
    } else {
      failureBudget.set(p, (failureBudget.get(p) || 0) + 1);
    }
  }

  const anyOk = providers.some(p => isUsable(byProvider[p], minTextLength));
  let path;
  if (fanoutErrored && !serialFilledAny) path = "failed";
  else if (fanoutErrored && serialFilledAny) path = "serial-only";
  else if (!fanoutErrored && serialFilledAny) path = "serial-fill";
  else if (!fanoutErrored && anyOk) path = "fanout";
  else path = "failed";

  const totalMs = Date.now() - startedAt;
  log({ event: "fanout-done", path, totalMs, ok: providers.filter(p => isUsable(byProvider[p], minTextLength)) });

  if (path === "failed" && lastTransportErr && !fanoutBody) {
    const err = new Error(`fanout failed after ${retryAttempts} attempts: ${(lastTransportErr.message || "").slice(0, 200)}`);
    err.code = "fanout-failed";
    err.byProvider = byProvider;
    err.totalMs = totalMs;
    throw err;
  }

  return { byProvider, totalMs, path };
}
