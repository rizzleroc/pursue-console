// pursue-vision-mcp · ChatGPT driver
//
// Connects to a logged-in Chrome via CDP, finds an open chatgpt.com tab,
// and runs single chat-with-files round-trips against it. Minimal —
// designed only for the vision-OCR contributor use case, not a general
// ChatGPT API.

import { chromium } from "playwright";

const COMPOSER_TIMEOUT = 30_000;
const REPLY_TIMEOUT_DEFAULT = 300_000;       // 5 min — multi-page replies are long
const UPLOAD_INDICATOR_TIMEOUT = 24_000;
const POLL_INTERVAL = 600;

const UPLOAD_FAILURE_PATTERNS = [
  /no\s+(page|image|file|attachment|document)s?\s+(was\s+)?(provided|attached|shared|uploaded)/i,
  /i\s+(don'?t|do not|cannot|can'?t)\s+see\s+(any|an?)\s+(image|file|attachment|page|document)/i,
  /please\s+(share|upload|attach|provide)\s+(the|an?)\s+(image|file|page|document)/i,
  /no\s+(image|page|file|attachment)[^.]{0,40}(yet|here|shared|been provided)/i,
];

export class ChatGPTDriver {
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
    // Find an existing chatgpt.com page across all contexts; else open one.
    let found = null;
    for (const ctx of this.browser.contexts()) {
      for (const p of ctx.pages()) {
        const u = p.url();
        if (/^https?:\/\/(www\.|chat\.)?chatgpt\.com/i.test(u)) { found = p; break; }
      }
      if (found) break;
    }
    if (!found) {
      const ctx = this.browser.contexts()[0];
      if (!ctx) throw new Error("no Chrome context found over CDP");
      found = await ctx.newPage();
      await found.goto("https://chatgpt.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
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

      // Fresh chat → click "New chat" if available, else navigate.
      if (freshChat) {
        await this.page.bringToFront().catch(() => {});
        const navigated = await this._tryNewChat();
        if (!navigated) {
          await this.page.goto("https://chatgpt.com/?model=auto", { waitUntil: "domcontentloaded" });
        }
      }
      const t0 = Date.now();
      await this._waitForComposer();
      const priorCount = await this._countAssistantMessages();

      // Upload the files, then wait for the attachment indicators to appear.
      await this._uploadFiles(filePaths);

      // Type prompt + submit. Prefer keyboard Enter; fall back to button click.
      await this._typePrompt(prompt);
      await this._submit();

      // Wait for the reply to settle.
      const text = await this._waitForReply(priorCount, replyTimeout);
      // Sanity: if the reply looks like an upload-failure complaint, throw —
      // caller can retry. Better to fail loud than poison the cache.
      for (const re of UPLOAD_FAILURE_PATTERNS) {
        if (re.test(text)) throw new Error(`ChatGPT did not receive the attachments: ${text.slice(0, 160)}`);
      }
      return { text, durationMs: Date.now() - t0 };
    } finally {
      this._pending--;
    }
  }

  // ---- internals ----
  async _tryNewChat() {
    try {
      const btn = await this.page.$('a[aria-label="New chat"], button[aria-label="New chat"]');
      if (!btn) return false;
      await btn.click({ timeout: 3000 });
      await this.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      return true;
    } catch { return false; }
  }

  async _waitForComposer() {
    // The composer is a contenteditable with role="textbox"
    await this.page.waitForSelector('div[contenteditable="true"][role="textbox"], textarea#prompt-textarea', { timeout: COMPOSER_TIMEOUT });
  }

  async _countAssistantMessages() {
    return this.page.evaluate(() => document.querySelectorAll('[data-message-author-role="assistant"]').length);
  }

  async _uploadFiles(filePaths) {
    // ChatGPT's composer has a hidden <input type="file"> that accepts the
    // upload event. Find it and set the files directly — faster + more
    // reliable than clicking the "+" menu.
    const input = await this.page.$('input[type="file"]');
    if (!input) throw new Error("ChatGPT file input not found (UI may have changed)");
    await input.setInputFiles(filePaths);
    // Wait for at least N attachment chips to appear. Try a few selectors.
    const N = filePaths.length;
    const deadline = Date.now() + UPLOAD_INDICATOR_TIMEOUT;
    while (Date.now() < deadline) {
      const ok = await this.page.evaluate((n) => {
        const sels = [
          '[data-testid="file-attachment"]',
          '[data-testid^="file-attachment"]',
          'button[aria-label*="Remove attachment"]',
          'button[aria-label*="Remove file"]',   // ChatGPT UI ≥ May 2026: "Remove file N: name.png"
          'div[aria-label*="attachment"]',
        ];
        for (const s of sels) {
          if (document.querySelectorAll(s).length >= n) return true;
        }
        return false;
      }, N);
      if (ok) return;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    throw new Error(`upload indicator did not show ${N} attachment(s) within ${UPLOAD_INDICATOR_TIMEOUT}ms`);
  }

  async _typePrompt(text) {
    // Click the composer to focus it, then type.
    const composer = await this.page.$('div[contenteditable="true"][role="textbox"]') ||
                     await this.page.$('textarea#prompt-textarea');
    if (!composer) throw new Error("composer not found");
    await composer.click();
    // Page.keyboard.type respects newlines; ChatGPT accepts \n in composer.
    await this.page.keyboard.type(text, { delay: 0 });
  }

  async _submit() {
    // Try the submit button first (more reliable across UI changes than Enter).
    const sel = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"]';
    const btn = await this.page.$(sel);
    if (btn) {
      const enabled = await btn.evaluate(b => !b.disabled);
      if (enabled) { await btn.click(); return; }
    }
    // Fall back to Enter.
    await this.page.keyboard.press("Enter");
  }

  async _waitForReply(priorCount, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastText = ""; let stableTicks = 0;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      const snap = await this.page.evaluate((prior) => {
        const nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
        if (nodes.length <= prior) return { ready: false, count: nodes.length };
        const newest = nodes[nodes.length - 1];
        // Detect "still streaming" — ChatGPT shows a stop button while generating.
        const stopBtn = document.querySelector('button[aria-label="Stop streaming"], button[data-testid="stop-button"]');
        const text = newest.innerText || "";
        return { ready: !stopBtn && text.length > 0, text, count: nodes.length };
      }, priorCount);
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
    throw new Error(`reply did not arrive within ${timeoutMs}ms`);
  }
}
