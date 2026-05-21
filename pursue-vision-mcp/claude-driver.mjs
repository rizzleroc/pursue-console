// pursue-vision-mcp · Claude driver
//
// @unverified — modeled on the chatgpt-driver.mjs shape (contenteditable
// composer + hidden <input type=file> + stop-button streaming detection),
// never run end-to-end against claude.ai through this bundled daemon. The
// selectors are pinned to a specific DOM snapshot (claude.ai as of
// 2026-05-21); Anthropic changes the UI silently. First volunteer who runs
// `npm run volunteer -- --provider=claude` is the live test. If claude.ai
// changes their UI, update the selectors here in one place.
//
// Connects to a logged-in Chrome via CDP, finds an open claude.ai tab, and
// runs single chat-with-files round-trips against it. Minimal — designed
// only for the vision-OCR contributor use case, not a general Claude API.

import { chromium } from "playwright";

const COMPOSER_TIMEOUT = 30_000;
const REPLY_TIMEOUT_DEFAULT = 300_000;       // 5 min — multi-page replies are long
const UPLOAD_INDICATOR_TIMEOUT = 24_000;
const POLL_INTERVAL = 600;

// claude.ai composer is a ProseMirror contenteditable.
const COMPOSER_SEL = 'div.ProseMirror[contenteditable="true"], div[contenteditable="true"][role="textbox"], [aria-label="Write your prompt to Claude"]';
// Assistant turns. claude.ai tags rendered replies with .font-claude-message;
// the data-testid is a fallback for older/newer snapshots.
const ASSISTANT_SEL = 'div.font-claude-message, [data-testid="message-content"], [data-is-streaming]';
const SEND_BTN_SEL = 'button[aria-label="Send message"], button[aria-label="Send Message"], button[aria-label*="Send" i]';
const STOP_BTN_SEL = 'button[aria-label="Stop response"], button[aria-label*="Stop" i]';

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
  }

  async disconnect() {
    try { if (this.browser) await this.browser.close(); } catch {}
    this.browser = null; this.page = null;
  }

  async chatWithFiles({ filePaths, prompt, timeoutMs, freshChat = true }) {
    if (!filePaths?.length) throw new Error("filePaths[] required");
    if (!prompt) throw new Error("prompt required");
    const replyTimeout = timeoutMs || REPLY_TIMEOUT_DEFAULT;
    this._pending++;
    try {
      await this.connect();
      this.callCount++;

      // Fresh chat → /new reliably lands on a clean composer.
      if (freshChat) {
        await this.page.bringToFront().catch(() => {});
        await this.page.goto("https://claude.ai/new", { waitUntil: "domcontentloaded", timeout: 30_000 });
      }
      const t0 = Date.now();
      await this._waitForComposer();
      const priorCount = await this._countAssistantMessages();

      await this._uploadFiles(filePaths);
      await this._typePrompt(prompt);
      await this._submit(priorCount);

      const text = await this._waitForReply(priorCount, replyTimeout);
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
    return this.page.evaluate((sel) => {
      const sels = sel.split(", ");
      let max = 0;
      for (const s of sels) {
        const n = document.querySelectorAll(s).length;
        if (n > max) max = n;
      }
      return max;
    }, ASSISTANT_SEL);
  }

  async _uploadFiles(filePaths) {
    // claude.ai composer has a hidden <input type="file"> behind the "+"
    // attach control. Set the files directly — faster + more reliable than
    // clicking through the popover menu.
    const input = await this.page.$('input[type="file"]');
    if (!input) throw new Error("Claude file input not found (UI may have changed)");
    await input.setInputFiles(filePaths);
    // Wait for at least N attachment chips to appear.
    const N = filePaths.length;
    const deadline = Date.now() + UPLOAD_INDICATOR_TIMEOUT;
    while (Date.now() < deadline) {
      const ok = await this.page.evaluate((n) => {
        const sels = [
          '[data-testid="file-thumbnail"]',
          '[data-testid*="attachment"]',
          'button[aria-label*="Remove" i]',
          '[data-testid="file-upload-cell"]',
          'img[src^="blob:"]',
          '[class*="thumbnail"]',
        ];
        for (const s of sels) {
          if (document.querySelectorAll(s).length >= n) return true;
        }
        return false;
      }, N);
      if (ok) {
        // Brief pause for backend processing — claude disables send while
        // it's still ingesting the upload.
        await this.page.waitForTimeout(1200);
        return;
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    throw new Error(`Claude upload indicator did not show ${N} attachment(s) within ${UPLOAD_INDICATOR_TIMEOUT}ms`);
  }

  async _typePrompt(text) {
    const composer = await this.page.$(COMPOSER_SEL);
    if (!composer) throw new Error("Claude composer not found");
    await composer.click();
    await this.page.keyboard.type(text, { delay: 0 });
  }

  async _submit(priorCount) {
    // Prefer the send button; fall back to Enter. claude.ai submits on a
    // bare Enter (Shift+Enter inserts a newline), so Enter is a safe fallback.
    let posted = false;
    for (let attempt = 0; attempt < 4 && !posted; attempt++) {
      try {
        const btn = await this.page.$(SEND_BTN_SEL);
        if (btn) {
          const enabled = await btn.evaluate(b => !b.disabled).catch(() => true);
          if (enabled) await btn.click({ delay: 40 });
          else await this.page.keyboard.press("Enter");
        } else {
          await this.page.keyboard.press("Enter");
        }
      } catch {}
      // Verify the composer cleared OR streaming started OR a new turn landed.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const state = await this.page.evaluate((composerSel, assistantSel, stopSel, prior) => {
          const c = document.querySelector(composerSel);
          const len = c?.innerText?.trim?.()?.length ?? 0;
          const streaming = !!document.querySelector(stopSel);
          const sels = assistantSel.split(", ");
          let turns = 0;
          for (const s of sels) { const n = document.querySelectorAll(s).length; if (n > turns) turns = n; }
          return { len, streaming, turns };
        }, COMPOSER_SEL, ASSISTANT_SEL, STOP_BTN_SEL, priorCount);
        if (state.len <= 1 && (state.streaming || state.turns > priorCount)) { posted = true; break; }
        await this.page.waitForTimeout(200);
      }
    }
    if (!posted) throw new Error("Claude submit failed (composer not cleared after retries)");
  }

  async _waitForReply(priorCount, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastText = ""; let stableTicks = 0;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      const snap = await this.page.evaluate((assistantSel, stopSel, prior) => {
        const sels = assistantSel.split(", ");
        const set = new Set();
        for (const s of sels) for (const el of document.querySelectorAll(s)) set.add(el);
        const nodes = Array.from(set);
        if (nodes.length <= prior) return { ready: false, count: nodes.length };
        const newest = nodes[nodes.length - 1];
        const streaming = !!document.querySelector(stopSel) ||
          newest.getAttribute?.("data-is-streaming") === "true";
        const text = newest.innerText || newest.textContent || "";
        return { ready: !streaming && text.length > 0, text, count: nodes.length };
      }, ASSISTANT_SEL, STOP_BTN_SEL, priorCount);
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
    throw new Error(`Claude reply did not arrive within ${timeoutMs}ms`);
  }
}
