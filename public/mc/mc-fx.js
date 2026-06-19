// Mission Control — AAA polish runtime.
//
// Tiny, framework-free behaviours that land on every page via chrome.js:
//   - Count-up animation for receipts row + headline counters (drives off
//     [data-mc] values once they land — animates from 0 to the live value
//     once per visit, then snaps on subsequent revalidations).
//   - Scroll-reveal for sections marked with .mc-rise (uses IntersectionObserver).
//   - Ops-button mouse-position ripple (sets --mx/--my so the radial gradient
//     follows the cursor).
//   - Heads-up tactical chime (visual only — pulses the live-watch badge
//     when MC revalidates with new data).
//
// Designed to be inert when MC isn't loaded (no errors, no console noise).

(function () {
  if (typeof window === 'undefined') return;

  // ─── Count-up animation ──────────────────────────────────────────────
  // Re-applies whenever a data-mc element gets a textContent change. We
  // only animate on the FIRST live value to avoid distracting twitches on
  // subsequent 60s revalidations. Per-element marker bit stays on the
  // element after first run.
  const EASE = (t) => 1 - Math.pow(1 - t, 3);
  const DUR_MS = 1400;

  function parseLive(el) {
    const raw = (el.textContent || '').replace(/[, ]/g, '');
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  }
  function fmt(n, withCommas) {
    n = Math.round(n);
    return withCommas ? n.toLocaleString() : String(n);
  }
  function animateOne(el) {
    if (el._mcAnimated) return;
    const target = parseLive(el);
    if (target == null) return;
    el._mcAnimated = true;
    const withCommas = (el.getAttribute('data-mc-format') === 'comma') ||
                       (target >= 1000);
    const start = Date.now();
    (function step() {
      const t = Math.min(1, (Date.now() - start) / DUR_MS);
      el.textContent = fmt(target * EASE(t), withCommas);
      if (t < 1) setTimeout(step, 33);
    })();
  }
  function sweepCountUp(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-mc], [data-count]').forEach(animateOne);
  }

  // First sweep after a beat so MC has had a chance to populate.
  function kickCountUp() {
    if (window.MC && typeof MC.ready === 'function') {
      MC.ready().then(() => sweepCountUp());
      MC.onUpdate(() => sweepCountUp());
    } else {
      setTimeout(sweepCountUp, 800);
    }
  }

  // ─── Scroll-reveal ───────────────────────────────────────────────────
  function applyReveal() {
    const targets = document.querySelectorAll('.mc-rise:not([data-revealed])');
    if (!targets.length) return;
    if (typeof IntersectionObserver === 'undefined') {
      targets.forEach((el) => el.setAttribute('data-revealed', '1'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.setAttribute('data-revealed', '1');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -60px 0px' });
    targets.forEach((el) => io.observe(el));
  }

  // ─── Ops-button cursor-tracked ripple ─────────────────────────────────
  function bindOpsRipple() {
    document.addEventListener('mousemove', (e) => {
      const btn = e.target.closest && e.target.closest('.ops-btn');
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * 100;
      const my = ((e.clientY - r.top) / r.height) * 100;
      btn.style.setProperty('--mx', mx + '%');
      btn.style.setProperty('--my', my + '%');
    }, { passive: true });
  }

  // ─── Tactical chime on MC.onUpdate ────────────────────────────────────
  // Visual only: brief amber flash on the live-watch badge each
  // revalidation. Skipped on the very first paint.
  let _firstUpdateSeen = false;
  function chimeOnUpdate() {
    if (!_firstUpdateSeen) { _firstUpdateSeen = true; return; }
    const badge = document.querySelector('header.topbar .badge.amber');
    if (!badge) return;
    badge.style.transition = 'box-shadow .25s ease';
    badge.style.boxShadow =
      '0 0 0 1px rgba(242, 166, 35, 1), 0 0 28px -2px rgba(242, 166, 35, 1)';
    setTimeout(() => { badge.style.boxShadow = ''; }, 450);
  }

  // ─── Init ────────────────────────────────────────────────────────────
  function init() {
    bindOpsRipple();
    applyReveal();
    kickCountUp();
    if (window.MC && MC.onUpdate) MC.onUpdate(chimeOnUpdate);

    // Expose a helper for views that swap-in fresh DOM after first paint
    // (Network, Atlas, Live coverage matrix, etc.) so they can request a
    // re-sweep when their cells render.
    window.MC && (window.MC.fx = { reveal: applyReveal, countUp: sweepCountUp });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
