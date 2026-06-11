// Mission Control — shared sharing primitives.
//
// Every MC page can:
//   • Call MC.setShareMeta({title, description, url, eid}) to update the
//     <head> OG / Twitter Card tags at runtime (since the static HTML can't
//     know which event the user picked).
//   • Call MC.copyToClipboard(text, sourceBtn) to copy and flash a
//     "✓ COPIED" confirmation on the source button. Falls back to a hidden
//     textarea + document.execCommand for browsers blocking the async API.
//   • Read MC.url.share(eid) for the canonical share URL of an event.

(function () {
  if (!window.MC) return;

  // ─────────── OG / Twitter Card meta updater ───────────
  // Static HTML carries default tags; runtime calls override them per event.
  // Selectors are explicit so we don't accidentally rewrite unrelated meta.
  const META_KEYS = {
    title:       ['meta[property="og:title"]',       'meta[name="twitter:title"]'],
    description: ['meta[property="og:description"]', 'meta[name="twitter:description"]'],
    image:       ['meta[property="og:image"]',       'meta[name="twitter:image"]'],
    url:         ['meta[property="og:url"]'],
  };

  function ensureMeta(selector, attrPair) {
    let el = document.head.querySelector(selector);
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute(attrPair[0], attrPair[1]);
      document.head.appendChild(el);
    }
    return el;
  }

  MC.setShareMeta = function (m) {
    if (!m) return;
    // Compose page <title> too so the browser tab + bookmarks reflect the case.
    if (m.title) {
      try { document.title = m.title + ' · PURSUE Console'; } catch (e) {}
    }
    // Auto-resolve og:image from eid if no explicit image was passed.
    if (m.image == null && m.eid != null && MC.url && MC.url.ogImage) {
      m.image = MC.url.ogImage(m.eid);
    }
    Object.keys(META_KEYS).forEach((k) => {
      if (m[k] == null) return;
      const selectors = META_KEYS[k];
      selectors.forEach((sel) => {
        let el = document.head.querySelector(sel);
        if (!el) {
          el = document.createElement('meta');
          // Recreate from the selector — covers og:* and twitter:*.
          if (sel.includes('property=')) {
            el.setAttribute('property', sel.match(/property="([^"]+)"/)[1]);
          } else {
            el.setAttribute('name', sel.match(/name="([^"]+)"/)[1]);
          }
          document.head.appendChild(el);
        }
        el.setAttribute('content', String(m[k]));
      });
    });
    // OG canonical URL — if missing, compose from window.location.
    if (m.url == null) {
      const ogUrl = document.head.querySelector('meta[property="og:url"]');
      if (ogUrl) ogUrl.setAttribute('content', window.location.href);
    }
  };

  // ─────────── Clipboard with confirmation ───────────
  MC.copyToClipboard = async function (text, sourceBtn) {
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) {}
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) {}
    }
    if (sourceBtn) {
      const orig = sourceBtn.textContent;
      sourceBtn.textContent = ok ? '✓ COPIED' : '⨯ COPY FAILED';
      sourceBtn.disabled = true;
      setTimeout(() => {
        sourceBtn.textContent = orig;
        sourceBtn.disabled = false;
      }, 1600);
    }
    return ok;
  };

  // ─────────── Canonical share URL helper ───────────
  if (MC.url) {
    MC.url.share = function (eid, extra) {
      const base = window.location.origin + window.location.pathname.replace(/\/mc\/.*$/, '/mc/');
      return base + 'share.html?eid=' + encodeURIComponent(eid) + (extra ? '&' + extra : '');
    };
    // og:image lookup — points at the pre-rendered per-event card for the
    // 6 curated events; falls back to og/default.png otherwise. Twitter
    // Cards only honour the static og:image baked into the HTML at request
    // time, so this getter is used by the runtime overrider only for the
    // chat clients that DO execute JS (Slack/iMessage/Discord/Facebook).
    const CURATED_OG = new Set(['usper-2025', 'DOE-UAP-D001', 'fbi-62hq83894', 'gemini-7', 'apollo-17', 'cometa']);
    MC.url.ogImage = function (eid) {
      const origin = window.location.origin;
      const base = window.location.pathname.replace(/\/mc\/.*$/, '/').replace(/\/[^/]+$/, '/');
      const safe = (eid || '').replace(/[^a-z0-9_.-]/gi, '_');
      if (eid && CURATED_OG.has(eid)) {
        return origin + base + 'og/event-' + safe + '.png';
      }
      return origin + base + 'og/default.png';
    };
  }

  // ─────────── Native-share fallback ───────────
  // Phones get the system share sheet; desktop gets a clipboard copy.
  MC.share = async function (payload, sourceBtn) {
    const { title, text, url } = payload || {};
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
        return true;
      } catch (e) { /* user cancelled — fall through to copy */ }
    }
    const composite = [text, url].filter(Boolean).join('\n\n');
    return MC.copyToClipboard(composite, sourceBtn);
  };
})();
