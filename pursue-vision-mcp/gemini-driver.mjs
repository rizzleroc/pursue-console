// pursue-vision-mcp · Gemini driver
//
// @unverified — ported from upstream whipgen-mcp slim, never run
// end-to-end against gemini.google.com through this bundled daemon.
// The reeval smoke test went via the upstream MCP, not this one. The
// selectors are pinned to a specific DOM snapshot; Gemini changes
// silently. First volunteer who runs `npm start --prefix pursue-vision-mcp`
// is the live test.
//
// Connects to a logged-in Chrome via CDP, finds an open gemini.google.com
// tab, and runs single chat-with-files round-trips against it. Minimal
// — only what the vision-OCR contributor flow needs (uploadFiles +
// prompt + reply). No history, no image gen, no video gen, no model
// switching beyond accepting the default.
//
// Heavily based on the upstream whipgen-mcp gemini-driver.js, slimmed
// for this open-source slice. The selectors here reflect the live
// Gemini DOM as of 2026-05-18. If Gemini changes their UI, update
// these in one place.

import { chromium } from "playwright";
import path from "node:path";

const COMPOSER_TIMEOUT = 30_000;
const REPLY_TIMEOUT_DEFAULT = 300_000;
const UPLOAD_TIMEOUT = 30_000;

const COMPOSER_SEL = 'rich-textarea div.ql-editor[contenteditable="true"], div.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea';
const RESPONSE_SEL = 'model-response, message-content[data-test-id="model-response-content"], .model-response-text';
const STOP_BTN_SEL = 'button[aria-label*="stop" i], button[data-test-id*="stop" i]';
const SEND_BTN_SEL = '[data-test-id="bard-send-button"], button[aria-label*="Send" i][data-mat-icon-name="send"], button[aria-label*="Submit" i]';

const UPLOAD_FAILURE_PATTERNS = [
  /no\s+(page|image|file|attachment|document)s?\s+(was\s+)?(provided|attached|shared|uploaded)/i,
  /i\s+(don'?t|do not|cannot|can'?t)\s+see\s+(any|an?)\s+(image|file|attachment|page|document)/i,
  /please\s+(share|upload|attach|provide)\s+(the|an?)\s+(image|file|page|document)/i,
  /no\s+(image|page|file|attachment)[^.]{0,40}(yet|here|shared|been provided)/i,
];

export class GeminiDriver {
  constructor({ cdpPort = 9222 } = {}) {
    this.cdpPort = cdpPort;
    this.browser = null;
    this.page = null;
    this.callCount = 0;
  }
  isConnected() { return !!this.page && !this.page.isClosed?.(); }

  async disconnect() {
    try { if (this.browser) await this.browser.close(); } catch {}
    this.browser = null; this.page = null;
  }

  async connect() {
    if (this.isConnected()) return;
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`);
    const contexts = this.browser.contexts();
    let page = null;
    for (const ctx of contexts) {
      for (const p of ctx.pages()) {
        if (/gemini\.google\.com/.test(p.url())) { page = p; break; }
      }
      if (page) break;
    }
    if (!page) {
      // No tab open — open one in the default context.
      const ctx = contexts[0] ?? await this.browser.newContext();
      page = await ctx.newPage();
      await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    this.page = page;
    if (!/gemini\.google\.com/.test(this.page.url())) {
      await this.page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
  }

  async newChat() {
    if (!this.isConnected()) await this.connect();
    // /app reliably lands on a clean composer with no prior chat context.
    await this.page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.page.waitForSelector(COMPOSER_SEL, { timeout: COMPOSER_TIMEOUT });
  }

  async chatWithFiles({ filePaths, prompt, timeoutMs = REPLY_TIMEOUT_DEFAULT, freshChat = true }) {
    if (!this.isConnected()) await this.connect();
    if (!filePaths?.length) throw new Error("filePaths[] required");
    if (!prompt) throw new Error("prompt required");
    if (freshChat) await this.newChat();
    const t0 = Date.now();
    const priorTurns = await this._countTurns();
    await this._uploadFiles(filePaths);
    await this._submitPrompt(prompt);
    const text = await this._waitForReply(priorTurns, timeoutMs);
    // Sanity: if the reply looks like an upload-failure complaint, throw —
    // caller can retry. Better to fail loud than poison the cache.
    for (const re of UPLOAD_FAILURE_PATTERNS) {
      if (re.test(text)) throw new Error(`Gemini did not receive the attachments: ${text.slice(0, 160)}`);
    }
    this.callCount++;
    return { text, durationMs: Date.now() - t0 };
  }

  async _countTurns() {
    return await this.page.evaluate((sel) => {
      const sels = sel.split(", ");
      let max = 0;
      for (const s of sels) {
        const n = document.querySelectorAll(s).length;
        if (n > max) max = n;
      }
      return max;
    }, RESPONSE_SEL);
  }

  async _uploadFiles(filePaths) {
    const resolved = filePaths.map(p => path.resolve(p));
    // 2-step popover: "Open upload file menu" → "local-images-files-uploader-button"
    await this.page.waitForSelector('button[aria-label="Open upload file menu"]', { timeout: 15_000 });
    const menuBtn = await this.page.$('button[aria-label="Open upload file menu"]');
    if (!menuBtn) throw new Error("Gemini upload menu trigger vanished");
    await menuBtn.click();
    await this.page.waitForSelector(
      '[data-test-id="local-images-files-uploader-button"], [aria-label*="Upload files" i]',
      { timeout: 8_000, state: "visible" }
    );
    const fileChooserPromise = this.page.waitForEvent("filechooser", { timeout: 15_000 }).catch(() => null);
    const localBtn = (await this.page.$('[data-test-id="local-images-files-uploader-button"]'))
                  || (await this.page.$('[aria-label*="Upload files" i]'));
    if (!localBtn) throw new Error("Gemini upload menu opened but 'Upload files' item missing");
    await localBtn.click();
    const chooser = await fileChooserPromise;
    if (chooser) {
      await chooser.setFiles(resolved);
    } else {
      const fi = await this.page.$('input[type="file"]');
      if (!fi) throw new Error("Gemini upload: filechooser did not fire and no <input type=file> appeared");
      await fi.setInputFiles(resolved);
    }
    // Wait for the attachment chip to appear, then for the backend to
    // finish processing (send button re-enables).
    const uploadOk = await this.page.waitForFunction(() => {
      const sels = [
        '[data-test-id*="attachment"]',
        '[data-test-id*="thumbnail"]',
        '[data-test-id*="file-card"]',
        '[aria-label*="attached" i]',
        '[aria-label*="attachment" i]',
        'img[src^="blob:"]',
        '[class*="uploaded-file"]',
        '[class*="image-thumbnail"]',
        '[class*="file-chip"]',
      ];
      for (const s of sels) if (document.querySelectorAll(s).length >= 1) return true;
      return false;
    }, { timeout: UPLOAD_TIMEOUT }).then(() => true).catch(() => false);
    if (!uploadOk) throw new Error("Gemini upload chip never appeared");
    // Brief pause for backend image processing — sends are silently
    // disabled while Gemini is still hashing the upload.
    await this.page.waitForTimeout(1200);
  }

  async _submitPrompt(text) {
    await this.page.waitForSelector(COMPOSER_SEL, { timeout: COMPOSER_TIMEOUT });
    const composer = await this.page.$(COMPOSER_SEL);
    if (!composer) throw new Error("Gemini composer not found");
    await composer.focus();
    // Gemini's composer is a Quill rich-text contenteditable; setting
    // innerHTML is blocked by TrustedHTML. Use safe DOM mutation.
    await this.page.evaluate((str) => {
      const el =
        document.querySelector('rich-textarea div.ql-editor[contenteditable="true"]') ||
        document.querySelector('div.ql-editor[contenteditable="true"]') ||
        document.querySelector('div[contenteditable="true"][role="textbox"]');
      if (el) {
        el.focus();
        try { el.replaceChildren(); } catch { while (el.firstChild) el.removeChild(el.firstChild); }
        for (const line of str.split(/\r?\n/)) {
          const p = document.createElement("p");
          p.textContent = line || " ";
          el.appendChild(p);
        }
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: str }));
        return;
      }
      const ta = document.querySelector('textarea');
      if (ta) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(ta, str);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, text);
    await this.page.waitForTimeout(400);

    const priorTurns = await this._countTurns();
    // Try to click a send button; fall back to Enter.
    let posted = false;
    for (let attempt = 0; attempt < 4 && !posted; attempt++) {
      try {
        const sendBtn = await this.page.waitForSelector(SEND_BTN_SEL, { timeout: 3000, state: "visible" }).catch(() => null);
        if (sendBtn) {
          await sendBtn.click({ delay: 40 });
        } else {
          await this.page.keyboard.press("Enter");
        }
      } catch {}
      // Verify the composer cleared OR a new turn appeared.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const state = await this.page.evaluate((sel) => {
          const c = document.querySelector('rich-textarea div.ql-editor[contenteditable="true"], div.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea');
          const len = c?.innerText?.trim?.()?.length ?? 0;
          const stop = !!document.querySelector('button[aria-label*="stop" i], button[data-test-id*="stop" i]');
          const sels = sel.split(", ");
          let turns = 0;
          for (const s of sels) { const n = document.querySelectorAll(s).length; if (n > turns) turns = n; }
          return { len, stop, turns };
        }, RESPONSE_SEL);
        if (state.len <= 1 && (state.stop || state.turns > priorTurns)) { posted = true; break; }
        await this.page.waitForTimeout(200);
      }
    }
    if (!posted) throw new Error("Gemini submit failed (composer not cleared after retries)");
  }

  async _waitForReply(priorTurns, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.page.evaluate((sel, prior) => {
        const sels = sel.split(", ");
        const set = new Set();
        for (const s of sels) for (const el of document.querySelectorAll(s)) set.add(el);
        const msgs = Array.from(set);
        if (msgs.length <= prior) return { ready: false, text: "" };
        const last = msgs[msgs.length - 1];
        const stillStreaming = !!document.querySelector('button[aria-label*="stop" i], button[data-test-id*="stop" i]');
        const text = last.innerText?.trim?.() ?? last.textContent?.trim() ?? "";
        return { ready: !stillStreaming, text };
      }, RESPONSE_SEL, priorTurns);
      if (state.ready && state.text) return state.text;
      await this.page.waitForTimeout(800);
    }
    throw new Error(`Gemini reply did not complete within ${timeoutMs}ms`);
  }
}
