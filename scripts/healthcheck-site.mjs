#!/usr/bin/env node
import { parseArgs } from 'node:util';

const DEFAULT_URL = 'https://rizzleroc.github.io/pursue-console/';
const MARKER = 'PURSUE Console — Release 01';
const RETRY_PAUSE_MS = 5000;

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: DEFAULT_URL },
    timeout: { type: 'string', default: '15000' },
    retries: { type: 'string', default: '2' },
  },
});

const url = values.url;
const timeoutMs = Number.parseInt(values.timeout, 10);
const retries = Number.parseInt(values.retries, 10);
const maxAttempts = retries + 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attempt() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'pursue-console-healthcheck/1.0' },
    });
    const status = res.status;
    if (status < 200 || status >= 300) {
      return { healthy: false, status, reason: `http_${status}`, elapsed: Date.now() - start };
    }
    const body = await res.text();
    if (!body.includes(MARKER)) {
      return { healthy: false, status, reason: 'missing_marker', elapsed: Date.now() - start };
    }
    return { healthy: true, status, reason: 'ok', elapsed: Date.now() - start };
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    return {
      healthy: false,
      status: null,
      reason: isAbort ? 'timeout' : 'fetch_error',
      elapsed: Date.now() - start,
      error: err?.message || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

const overallStart = Date.now();
let result;
let attempts = 0;
for (let i = 0; i < maxAttempts; i++) {
  attempts = i + 1;
  process.stderr.write(`[healthcheck] attempt ${attempts}/${maxAttempts} GET ${url}\n`);
  result = await attempt();
  if (result.healthy) {
    process.stderr.write(`[healthcheck] attempt ${attempts} ok (${result.elapsed}ms)\n`);
    break;
  }
  const detail = result.error ? ` (${result.error})` : '';
  process.stderr.write(
    `[healthcheck] attempt ${attempts} unhealthy: ${result.reason}${detail} (${result.elapsed}ms)\n`,
  );
  if (i < maxAttempts - 1) {
    await sleep(RETRY_PAUSE_MS);
  }
}

const payload = {
  healthy: result.healthy,
  url,
  status: result.status,
  elapsed_ms: Date.now() - overallStart,
  reason: result.reason,
  attempts,
  checked_at: new Date().toISOString(),
};

process.stdout.write(JSON.stringify(payload) + '\n');
process.exit(result.healthy ? 0 : 1);
