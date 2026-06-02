// Mission Control chrome injector.
// Each page wraps its body content in <main>. This script inserts
// the consistent header/nav before <main> and the footer after.

(function () {
  const VIEWS = [
    { id: 'live',     label: 'Live' },
    { id: 'coverage', label: 'Coverage' },
    { id: 'search',   label: 'Search' },
    { id: 'ask',      label: 'Ask' },
    { id: 'review',   label: 'Review', badge: 3 },
    { id: 'media',    label: 'Media' },
    null,
    { id: 'dossier',  label: 'Dossier' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'atlas',    label: 'Atlas' },
    { id: 'globe',    label: 'Globe' },
    { id: 'network',  label: 'Network' },
  ];

  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else e.setAttribute(k, v);
    }
    for (const c of children) {
      if (typeof c === 'string') e.appendChild(document.createTextNode(c));
      else if (c) e.appendChild(c);
    }
    return e;
  }

  const view = document.body.dataset.view || '';
  function stamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}·${pad(d.getUTCMonth() + 1)}·${pad(d.getUTCDate())}  ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
  }

  // Background overlays (fixed-position, order doesn't matter)
  document.body.append(
    el('div', { class: 'bg-void' }),
    el('div', { class: 'bg-grid' }),
    el('div', { class: 'bg-noise' }),
    el('div', { class: 'vignette' }),
    el('div', { class: 'scanline' }),
    el('span', { class: 'corner tl' }),
    el('span', { class: 'corner tr' }),
    el('span', { class: 'corner bl' }),
    el('span', { class: 'corner br' }),
  );

  // Find <main> — it's the anchor
  const main = document.querySelector('main');
  if (!main) {
    console.error('Mission Control: page is missing <main>');
    return;
  }

  // ─────────── Pre-main chrome ───────────
  const classifiedTop = el('div', { class: 'classified' }, [
    el('span', { class: 'stamp' }, ['// declassified · war.gov · open-source mirror']),
    el('span', { class: 'dash' }, ['— — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —']),
    el('span', { class: 'stamp' }, ['community-run · not agency-affiliated']),
  ]);
  const topbar = el('header', { class: 'topbar' }, [
    el('div', { class: 'brand' }, [
      el('span', { class: 'brand-mark' }),
      el('span', { class: 'brand-name' }, ['PURSUE  CONSOLE']),
      el('span', { class: 'brand-sub' }, ['MISSION CONTROL · 3.0 · WAR.GOV/UAP']),
    ]),
    el('div', { class: 'center-strip' }, [
      el('span', { class: 'badge' }, [el('span', { class: 'dot' }), 'OPERATIONAL']),
      el('span', { class: 'badge', id: 'time-badge' }, [el('span', { class: 'v' }, [stamp()])]),
      el('span', { class: 'badge amber' }, [el('span', { class: 'dot' }), 'LIVE WATCH']),
    ]),
    el('div', { class: 'topbar-actions' }, [
      el('a', { class: 'ghost', href: 'index.html' }, ['LAUNCH ▾']),
      el('a', { class: 'ghost', href: '../', title: 'Jump to the live React app at the deployed site root' }, ['OPEN LIVE APP →']),
      el('a', { class: 'ops-btn', href: 'review.html' }, ['＋ ENLIST']),
    ]),
  ]);
  const nav = el('nav', { class: 'tabs' });
  for (const v of VIEWS) {
    if (v === null) {
      nav.appendChild(el('span', { class: 'nav-divider' }));
      nav.appendChild(el('span', { class: 'nav-group' }, ['ANALYSIS']));
      continue;
    }
    const tab = el('a', {
      class: 'nav-tab' + (view === v.id ? ' active' : ''),
      href: `${v.id}.html`,
    }, [v.label]);
    if (v.id === 'review') {
      // live review badge — hidden until we know the count is > 0
      const b = el('span', { class: 'nav-badge', id: 'review-badge', style: 'display:none' }, ['0']);
      tab.appendChild(b);
    } else if (v.badge) {
      tab.appendChild(el('span', { class: 'nav-badge' }, [String(v.badge)]));
    }
    nav.appendChild(tab);
  }
  main.parentNode.insertBefore(classifiedTop, main);
  main.parentNode.insertBefore(topbar, main);
  main.parentNode.insertBefore(nav, main);

  // ─────────── Post-main chrome ───────────
  const footer = el('footer', { class: 'fc' }, [
    el('span', {}, ['watchkeeper · automated vigil · human-in-loop']),
    el('span', {}, [`// ${stamp().toLowerCase()}`]),
    el('span', {}, ['community-run · not agency-affiliated']),
  ]);
  const classifiedBot = el('div', { class: 'classified', style: 'margin-top: 12px;' }, [
    el('span', { class: 'stamp' }, ['// end of transmission']),
    el('span', { class: 'dash' }, ['— — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —']),
    el('span', { class: 'stamp' }, ['classification · open · public mirror']),
  ]);
  main.parentNode.appendChild(footer);
  main.parentNode.appendChild(classifiedBot);

  // Live UTC tick
  setInterval(() => {
    const t = document.querySelector('#time-badge .v');
    if (t) t.textContent = stamp();
  }, 1000);

  // Count-up helper. Targets come from the static data-count attribute by
  // default; if the element also carries data-mc-count="<deriveKey>", the
  // LIVE value from the data layer overrides it once MC is ready.
  // Uses setTimeout rather than requestAnimationFrame: rAF is throttled to
  // ~0 fps in headless / non-visible / accessibility contexts, leaving the
  // cells stuck on their fallback. setTimeout fires reliably everywhere.
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  const FRAME_MS = 33; // ~30fps; perceptually identical to rAF for short animations
  const DUR_MS = 1500;
  function animateOne(elx) {
    let target = parseFloat(elx.dataset.count);
    const liveKey = elx.dataset.mcCount;
    if (liveKey && window.MC && window.MC.derive && window.MC.derive[liveKey] != null) {
      const lv = window.MC.derive[liveKey];
      if (typeof lv === 'number' && isFinite(lv)) target = lv;
    }
    if (!isFinite(target)) return;
    // Mark so we don't re-animate from 0 every time MC revalidates — write
    // the target value directly on subsequent passes.
    if (elx._mcAnimated) {
      elx.textContent = Math.round(target).toLocaleString();
      return;
    }
    elx._mcAnimated = true;
    const start = Date.now();
    (function step() {
      const elapsed = Date.now() - start;
      const t = Math.min(1, elapsed / DUR_MS);
      elx.textContent = Math.round(target * easeOut(t)).toLocaleString();
      if (t < 1) setTimeout(step, FRAME_MS);
    })();
  }
  function runCountUp() {
    document.querySelectorAll('[data-count]').forEach(animateOne);
  }

  // Live review badge from the data layer
  function updateReviewBadge() {
    const b = document.getElementById('review-badge');
    if (!b || !window.MC || !window.MC.derive) return;
    const n = window.MC.derive.reviewCount;
    if (typeof n === 'number' && n > 0) { b.textContent = String(n); b.style.display = ''; }
    else { b.style.display = 'none'; }
  }

  if (window.MC && typeof window.MC.ready === 'function') {
    // Live data present — animate count-up to LIVE targets once MC is ready,
    // and re-sync (without re-animating) on every revalidation.
    window.MC.ready().then(() => { runCountUp(); updateReviewBadge(); });
    window.MC.onUpdate(() => { runCountUp(); updateReviewBadge(); });
    // Fallback if MC stays slow: still animate the static data-count targets.
    setTimeout(() => { if (!window.MC._loaded) runCountUp(); }, 1500);
  } else {
    setTimeout(runCountUp, 600);
  }
})();
