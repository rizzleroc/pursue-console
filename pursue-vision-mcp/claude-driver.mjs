// pursue-vision-mcp · Claude driver
//
// @unverified — modeled on the ChatGPT/Gemini drivers in this directory
// but never run end-to-end against claude.ai through this daemon. The
// selectors below are pinned to a claude.ai DOM snapshot and Anthropic
// changes their UI silently. First volunteer who runs
// `npm start --prefix pursue-vision-mcp` with --provider=claude is the
// live test; if the composer/upload/reply selectors drift, fix them here
// in one place.
//
// Connects to a logged-in Chrome via CDP, finds an open claude.ai tab,
// and runs single chat-with-files round-trips against it. Minimal —
// designed only for the vision-OCR contributor use case, not a general
// Claude API. claude.ai's composer is a ProseMirror contenteditable and
// the file upload is a hidden <input type="file">, so the mechanics
// mirror the ChatGPT driver closely.

import { chromium } from "playwright";
import path from "node:path";

const COMPOSER_TIMEOUT = 30_000;
const REPLY_TIMEOUT_DEFAULT = 300_000;       // 5 min — multi-page replies are long
const UPLOAD_INDICATOR_TIMEOUT = 24_000;
const POLL_INTERVAL = 600;

const COMPOSER_SEL = 'div[contenteditable="true"].ProseMirror, div.ProseMirror[contenteditable="true"], div[contenteditable="true"][role="textbox"], div[contenteditable="true"]';
const SEND_BTN_SEL = 'button[aria-label="Send message"], button[aria-label="Send Message"], button[aria-label*="Send" i]';
// One node per assistant turn — keep this 1:1 with replies so turn-counting
// stays honest. font-claude-message is the per-message content node; the
// data-testid is a more durable fallback if the class churns. They are NOT
// unioned (that would double-count a single reply, since the streaming
// wrapper and the content node are different elements).
const TURN_SEL_PRIMARY  = 'div.font-claude-message';
const TURN_SEL_FALLBACK = '[data-testid="assistant-message"]';
// Streaming indicator: the streaming-wrapper attribute, or the stop button.
const STREAMING_SEL = '[data-is-streaming="true"], button[aria-label="Stop response"], button[aria-label*="Stop" i]';

const UPLOAD_FAILURE_PATTERNS = [
  /no\s+(page|image|file|attachment|document)s?\s+(was\s+)?(provided|attached|shared|uploaded)/i,
  /i\s+(don'?t|do not|cannot|can'?t)\s+see\s+(any|an?)\s+(image|file|attachment|page|document)/i,
  /please\s+(share|upload|attach|provide)\s+(the|an?)\s+(image|file|page|document)/i,
  /no\s+(image|page|file|attachment)[^.]{0,40}(yet|here|shared|been provided)/i,
];

export class ClaudeDriver {
  constructor({ cdpPort = 9222 } = {}) {
    this.cdpPort = cdpPort;
    this.browser = null;
    this.page = null;
    this.callCount = 0;
    this._pending = 0;
  }
  isConnected() { return !!this.page && !this.page.isClosed?.(); }
  pendingCount() { return this._pending; }

  async connect() {
    if (this.isConnected()) return;
    if (!this.browser) {
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`);
    }
    // Find an existing claude.ai page across all contexts; else open one.
    let found = null;
    for (const ctx of this.browser.contexts()) {
      for (const p of ctx.pages()) {
        if (/^https?:\/\/(www\.)?claude\.ai/i.test(p.url())) { found = p; break; }
      }
      if (found) break;
    }
    if (!found) {
      const ctx = this.browser.contexts()[0];
      if (!ctx) throw new Error("no Chrome context found over CDP");
      found = await ctx.newPage();
      await found.goto("https://claude.ai/new", { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    this.page = found;
    if (!/claude\.ai/i.test(this.page.url())) {
      await this.page.goto("https://claude.ai/new", { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
  }

  async disconnect() {
    try { if (this.browser) await this.browser.close(); } catch {}
    this.browser = null; this.page = null;
  }

  async newChat() {
    if (!this.isConnected()) await this.connect();
    // /new reliably lands on a clean composer with no prior chat context.
    await this.page.goto("https://claude.ai/new", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.page.waitForSelector(COMPOSER_SEL, { timeout: COMPOSER_TIMEOUT });
  }

  async chatWithFiles({ filePaths, prompt, timeoutMs, freshChat = true }) {
    if (!filePaths?.length) throw new Error("filePaths[] required");
    if (!prompt) throw new Error("prompt required");
    const replyTimeout = timeoutMs || REPLY_TIMEOUT_DEFAULT;
    this._pending++;
    try {
      await this.connect();
      this.callCount++;

      if (freshChat) {
        await this.page.bringToFront().catch(() => {});
        await this.newChat();
      }
      const t0 = Date.now();
      await this._waitForComposer();
      const priorCount = await this._countAssistantMessages();

      await this._uploadFiles(filePaths);
      await this._typePrompt(prompt);
      await this._submit(priorCount);

      const text = await this._waitForReply(priorCount, replyTimeout);
      // Sanity: if the reply complains it never got the attachment, throw —
      // caller can retry. Better to fail loud than poison the cache.
      for (const re of UPLOAD_FAILURE_PATTERNS) {
        if (re.test(text)) throw new Error(`Claude did not receive the attachments: ${text.slice(0, 160)}`);
      }
      return { text, durationMs: Date.now() - t0 };
    } finally {
      this._pending--;
    }
  }

  // ---- internals ----
  async _waitForComposer() {
    await this.page.waitForSelector(COMPOSER_SEL, { timeout: COMPOSER_TIMEOUT });
  }

  async _countAssistantMessages() {
    return this.page.evaluate(({ primary, fallback }) => {
      const n = document.querySelectorAll(primary).length;
      return n > 0 ? n : document.querySelectorAll(fallback).length;
    }, { primary: TURN_SEL_PRIMARY, fallback: TURN_SEL_FALLBACK });
  }

  async _uploadFiles(filePaths) {
    const resolved = filePaths.map(p => path.resolve(p));
    // claude.ai's composer has a hidden <input type="file"> — set the files
    // directly rather than driving the "+" attach menu.
    const fileChooserPromise = this.page.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null);
    const input = await this.page.$('input[type="file"]');
    if (input) {
      await input.setInputFiles(resolved);
    } else {
      // Fall back to the attach button → native file chooser.
      const attachBtn = await this.page.$('button[aria-label*="attach" i], button[aria-label*="Upload" i], button[aria-label*="Add" i]');
      if (!attachBtn) throw new Error("Claude file input not found (UI may have changed)");
      await attachBtn.click();
      const chooser = await fileChooserPromise;
      if (!chooser) throw new Error("Claude attach: filechooser did not fire and no <input type=file> appeared");
      await chooser.setFiles(resolved);
    }
    // Wait for the attachment chips. Prefer dedicated chip/remove selectors
    // and require one per file; only fall back to a blob-image *presence*
    // check (>=1, not >=N) when no chip selector is recognized — a single
    // image can render several blob <img>, so blob count is an unreliable
    // per-file tally.
    const N = filePaths.length;
    const deadline = Date.now() + UPLOAD_INDICATOR_TIMEOUT;
    while (Date.now() < deadline) {
      const ok = await this.page.evaluate((n) => {
        const chipSels = [
          '[data-testid="file-thumbnail"]',
          '[data-testid*="attachment"]',
          'button[aria-label*="Remove" i]',
          'div[aria-label*="attachment" i]',
        ];
        for (const s of chipSels) {
          if (document.querySelectorAll(s).length >= n) return true;
        }
        if (document.querySelectorAll('img[src^="blob:"]').length >= 1) return true;
        return false;
      }, N);
      if (ok) { await this.page.waitForTimeout(1000); return; }
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    throw new Error(`Claude upload indicator did not show ${N} attachment(s) within ${UPLOAD_INDICATOR_TIMEOUT}ms`);
  }

  async _typePrompt(text) {
    const composer = await this.page.$(COMPOSER_SEL);
    if (!composer) throw new Error("Claude composer not found");
    await composer.click();
    // Clear any retained draft before typing so we never append to stale text.
    // ControlOrMeta resolves to Cmd on macOS, Ctrl elsewhere.
    await this.page.keyboard.press("ControlOrMeta+a").catch(() => {});
    await this.page.keyboard.press("Delete").catch(() => {});
    await this.page.keyboard.type(text, { delay: 0 });
    await this.page.waitForTimeout(300);
  }

  async _submit(priorCount) {
    const trySend = async () => {
      const btn = await this.page.$(SEND_BTN_SEL);
      if (btn) {
        const enabled = await btn.evaluate(b => !b.disabled).catch(() => true);
        if (enabled) { await btn.click().catch(() => {}); return; }
      }
      await this.page.keyboard.press("Enter");
    };
    // Send once. Re-issue ONLY if we can prove nothing was sent (the prompt
    // text is still sitting in the composer). Blind retries double-send —
    // either an empty Enter or a duplicate message — so we never do that.
    await trySend();
    for (let attempt = 0; attempt < 3; attempt++) {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const state = await this.page.evaluate((composerSel, primary, fallback, streamingSel) => {
          const turnsPrimary = document.querySelectorAll(primary).length;
          return {
            streaming: !!document.querySelector(streamingSel),
            turns: turnsPrimary > 0 ? turnsPrimary : document.querySelectorAll(fallback).length,
          };
        }, COMPOSER_SEL, TURN_SEL_PRIMARY, TURN_SEL_FALLBACK, STREAMING_SEL);
        // Definitely sent: a reply is streaming or a new turn appeared.
        if (state.streaming || state.turns > priorCount) return;
        await this.page.waitForTimeout(200);
      }
      // Window elapsed with no visible reply. Re-send only if the prompt text
      // is still in the composer; otherwise assume it posted and let
      // _waitForReply adjudicate (it has its own timeout).
      const len = await this.page.evaluate(
        (sel) => (document.querySelector(sel)?.innerText?.trim?.()?.length ?? 0), COMPOSER_SEL);
      if (len <= 1) return;
      await trySend();
    }
    throw new Error("Claude submit failed (prompt never left the composer)");
  }

  async _waitForReply(priorCount, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastText = ""; let stableTicks = 0;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      const snap = await this.page.evaluate((primary, fallback, streamingSel, prior) => {
        const useFallback = document.querySelectorAll(primary).length === 0;
        const nodes = Array.from(document.querySelectorAll(useFallback ? fallback : primary));
        if (nodes.length <= prior) return { ready: false, count: nodes.length };
        const newest = nodes[nodes.length - 1];
        const streaming = !!document.querySelector(streamingSel);
        const text = newest.innerText?.trim?.() ?? newest.textContent?.trim() ?? "";
        return { ready: !streaming && text.length > 0, text, count: nodes.length };
      }, TURN_SEL_PRIMARY, TURN_SEL_FALLBACK, STREAMING_SEL, priorCount);
      if (!snap.ready) { stableTicks = 0; continue; }
      if (snap.text === lastText) {
        stableTicks++;
        if (stableTicks >= 2) return snap.text;   // ~1.2s of stability
      } else {
        lastText = snap.text;
        stableTicks = 0;
      }
    }
    if (lastText) return lastText;
    throw new Error(`Claude reply did not complete within ${timeoutMs}ms`);
  }
}
