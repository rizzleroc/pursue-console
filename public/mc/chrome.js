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
    { id: 'evidence', label: 'Evidence' },
    null,
    { id: 'help',     label: 'Help' },
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
  // HTML version with blinking colons in the time portion — used for the
  // live topbar clock so the seconds tick feels alive. Each ":" becomes
  // <span class="bk">:</span>, animated via styles.css.
  function stampHTML() {
    return stamp().replace(/(\d{2}):(\d{2}):(\d{2})/, (m, h, mn, s) =>
      `${h}<span class="bk">:</span>${mn}<span class="bk">:</span>${s}`);
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
    el('span', { class: 'stamp', 'data-i18n': 'chrome.classified_top_left', 'data-i18n-default': '// declassified · war.gov · open-source mirror' }, ['// declassified · war.gov · open-source mirror']),
    el('span', { class: 'dash' }, ['— — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —']),
    el('span', { class: 'stamp', 'data-i18n': 'chrome.classified_top_right', 'data-i18n-default': 'community-run · not agency-affiliated' }, ['community-run · not agency-affiliated']),
  ]);
  const topbar = el('header', { class: 'topbar' }, [
    el('div', { class: 'brand' }, [
      el('span', { class: 'brand-mark' }),
      el('span', { class: 'brand-name' }, ['PURSUE  CONSOLE']),
      el('span', { class: 'brand-sub', 'data-i18n': 'chrome.brand_sub', 'data-i18n-default': 'MISSION CONTROL · 3.0 · WAR.GOV/UAP' }, ['MISSION CONTROL · 3.0 · WAR.GOV/UAP']),
    ]),
    el('div', { class: 'center-strip' }, [
      el('span', { class: 'badge' }, [el('span', { class: 'dot' }), el('span', { 'data-i18n': 'chrome.operational', 'data-i18n-default': 'OPERATIONAL' }, ['OPERATIONAL'])]),
      el('span', { class: 'badge', id: 'time-badge' }, [el('span', { class: 'v', html: stampHTML() })]),
      el('span', { class: 'badge amber' }, [el('span', { class: 'dot' }), el('span', { 'data-i18n': 'chrome.live_watch', 'data-i18n-default': 'LIVE WATCH' }, ['LIVE WATCH'])]),
    ]),
    el('div', { class: 'topbar-actions' }, [
      // Highlight LAUNCH when on the index/launcher page (body data-view="")
      // so users see a visible "you are here" cue (no nav-tab matches index).
      el('a', { class: 'ghost' + (view === '' ? ' active' : ''), href: 'index.html', 'data-i18n': 'chrome.launch', 'data-i18n-default': 'LAUNCH ▾' }, ['LAUNCH ▾']),
      el('a', { class: 'ghost', href: '../', title: 'Jump to the live React app at the deployed site root', 'data-i18n': 'chrome.open_live_app', 'data-i18n-default': 'OPEN LIVE APP →' }, ['OPEN LIVE APP →']),
      el('button', { class: 'ops-btn', id: 'enlist-btn', type: 'button', 'data-i18n': 'chrome.enlist', 'data-i18n-default': '＋ ENLIST' }, ['＋ ENLIST']),
    ]),
  ]);
  const nav = el('nav', { class: 'tabs' });
  let _analysisInserted = false;
  for (const v of VIEWS) {
    if (v === null) {
      nav.appendChild(el('span', { class: 'nav-divider' }));
      const groupSpan = el('span', { class: 'nav-group' }, ['ANALYSIS']);
      // Only the first divider gets the "ANALYSIS" label; subsequent ones
      // (e.g. the Help split) get a "SUPPORT" label so the translation key
      // is distinct.
      groupSpan.setAttribute('data-i18n', _analysisInserted ? 'nav.support' : 'nav.analysis');
      groupSpan.dataset.i18nDefault = _analysisInserted ? 'SUPPORT' : 'ANALYSIS';
      nav.appendChild(groupSpan);
      _analysisInserted = true;
      continue;
    }
    const tab = el('a', {
      class: 'nav-tab' + (view === v.id ? ' active' : ''),
      href: `${v.id}.html`,
      'data-i18n': 'nav.' + v.id,
      'data-i18n-default': v.label,
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
  // Shared filter strip — search box + agency / type dropdowns persisted
  // via MC.headerFilters (sessionStorage). Every view subscribes via
  // MC.onHeaderFilters and re-renders. Mirrors src/components/Header.jsx.
  const HF = (window.MC && window.MC.headerFilters) || { query: '', agency: 'all', type: 'all' };
  const hf = el('div', { class: 'header-filters' }, [
    el('span', { class: 'hf-label' }, ['FILTER']),
    el('input', {
      class: 'hf-input',
      id: 'hf-query',
      type: 'search',
      placeholder: 'search title · agency · region · era · tag…',
      value: HF.query || '',
      autocomplete: 'off',
    }),
    el('select', { class: 'hf-select', id: 'hf-agency' }, [
      el('option', { value: 'all' }, ['ALL AGENCIES']),
    ]),
    el('select', { class: 'hf-select', id: 'hf-type' }, [
      el('option', { value: 'all' }, ['ALL TYPES']),
    ]),
    el('span', { class: 'hf-clear', id: 'hf-clear', title: 'reset all filters' }, ['✕ RESET']),
  ]);

  main.parentNode.insertBefore(classifiedTop, main);
  main.parentNode.insertBefore(topbar, main);
  main.parentNode.insertBefore(nav, main);
  main.parentNode.insertBefore(hf, main);

  // ─────────── Post-main chrome ───────────
  const footer = el('footer', { class: 'fc' }, [
    el('span', { 'data-i18n': 'chrome.footer_left', 'data-i18n-default': 'watchkeeper · automated vigil · human-in-loop' }, ['watchkeeper · automated vigil · human-in-loop']),
    el('span', {}, [`// ${stamp().toLowerCase()}`]),
    el('span', { 'data-i18n': 'chrome.footer_right', 'data-i18n-default': 'community-run · not agency-affiliated' }, ['community-run · not agency-affiliated']),
  ]);
  const classifiedBot = el('div', { class: 'classified', style: 'margin-top: 12px;' }, [
    el('span', { class: 'stamp', 'data-i18n': 'chrome.eot_left', 'data-i18n-default': '// end of transmission' }, ['// end of transmission']),
    el('span', { class: 'dash' }, ['— — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —']),
    el('span', { class: 'stamp', 'data-i18n': 'chrome.eot_right', 'data-i18n-default': 'classification · open · public mirror' }, ['classification · open · public mirror']),
  ]);
  main.parentNode.appendChild(footer);
  main.parentNode.appendChild(classifiedBot);

  // Load the AAA polish runtime — count-up, scroll-reveal, ops ripple,
  // tactical chime on revalidation. Single shared script that runs on
  // every MC page via chrome.js so individual pages don't need a tag.
  (function loadFx() {
    const here = document.currentScript && document.currentScript.src;
    const base = here ? here.replace(/chrome\.js.*$/, '') : '';
    const s = document.createElement('script');
    s.src = base + 'mc-fx.js';
    s.defer = true;
    document.head.appendChild(s);
  })();

  // Live UTC tick
  setInterval(() => {
    const t = document.querySelector('#time-badge .v');
    if (t) t.innerHTML = stampHTML();
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

  // ─── i18n — load saved lang + apply data-i18n attributes ───
  // Mirrors src/i18n/context.js: persisted to localStorage, en.json is
  // the authoritative key set, missing keys fall back to en.
  const I18N_KEY = 'mc.lang.v1';
  let _i18nDict = null, _i18nEn = null, _i18nLang = 'en';
  function getNested(obj, dotPath) {
    const parts = dotPath.split('.');
    let v = obj;
    for (const p of parts) { if (v == null) return undefined; v = v[p]; }
    return v;
  }
  function tr(key, defaultVal) {
    if (_i18nDict) {
      const v = getNested(_i18nDict, key);
      if (typeof v === 'string') return v;
    }
    if (_i18nEn) {
      const v = getNested(_i18nEn, key);
      if (typeof v === 'string') return v;
    }
    return defaultVal != null ? defaultVal : key;
  }
  function applyI18n(root) {
    (root || document).querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      const fallback = el.dataset.i18nDefault || el.textContent;
      el.textContent = tr(key, fallback);
    });
    document.documentElement.lang = _i18nLang;
  }
  async function loadLocale(code) {
    if (!code || code === 'en') {
      if (!_i18nEn) _i18nEn = await fetch('../i18n/en.json').then((r) => r.ok ? r.json() : null).catch(() => null);
      _i18nDict = _i18nEn;
      _i18nLang = 'en';
      return;
    }
    const url = `../i18n/${code}.json`;
    try {
      const r = await fetch(url);
      _i18nDict = r.ok ? await r.json() : null;
      _i18nLang = code;
    } catch (e) { _i18nDict = null; _i18nLang = 'en'; }
    if (!_i18nEn) _i18nEn = await fetch('../i18n/en.json').then((r) => r.ok ? r.json() : null).catch(() => null);
  }
  async function initI18n() {
    let saved = 'en';
    try { saved = localStorage.getItem(I18N_KEY) || 'en'; } catch (e) {}
    await loadLocale(saved);
    applyI18n();
  }
  // Expose for views that want to translate dynamic strings.
  window.MC && (window.MC.tr = tr);

  // Language picker — pulls available langs from i18n/languages.json.
  // Dropdown opens on click; selecting persists + reloads the page so
  // the change is total (every page applies on its own load).
  async function injectLanguagePicker() {
    const langs = await fetch('../i18n/languages.json')
      .then((r) => r.ok ? r.json() : null)
      .catch(() => null);
    if (!langs || !Array.isArray(langs.languages)) return;
    const current = (langs.languages.find((l) => l.code === _i18nLang)) || langs.languages[0];
    const wrap = document.createElement('span');
    wrap.className = 'lang-picker';
    wrap.innerHTML =
      '<span class="lp-current" id="lp-current">' + (current.native || current.code).toUpperCase() + ' ▾</span>' +
      '<div class="lp-menu" id="lp-menu">' +
        langs.languages.map(function(l){
          return '<a class="lp-opt' + (l.code === _i18nLang ? ' on' : '') + '" data-code="' + l.code + '" dir="' + (l.dir || 'ltr') + '">' +
            (l.native || l.code) +
            ' <span class="lp-sub">' + (l.english || l.code) + '</span>' +
          '</a>';
        }).join('') +
      '</div>';
    // Inject just before ENLIST button.
    const actions = document.querySelector('.topbar-actions');
    if (actions) actions.insertBefore(wrap, actions.lastElementChild);
    const cur = wrap.querySelector('#lp-current');
    const menu = wrap.querySelector('#lp-menu');
    cur.addEventListener('click', function(e){
      e.stopPropagation();
      menu.classList.toggle('on');
    });
    document.addEventListener('click', function(){ menu.classList.remove('on'); });
    wrap.querySelectorAll('.lp-opt').forEach(function(a){
      a.addEventListener('click', function(){
        const code = a.dataset.code;
        try { localStorage.setItem(I18N_KEY, code); } catch (e) {}
        window.location.reload();
      });
    });
  }

  // Init i18n: load lang, apply DOM, then inject picker.
  initI18n().then(injectLanguagePicker);

  // ─── Volunteer modal (chrome-wide) ───
  // Shared modal triggered by ENLIST button across every page. Mirrors
  // src/components/VolunteerModal.jsx — three quickstart paths
  // (Quickstart / GitHub Issue / Browse Queue) and a copy-clipboard
  // for the install command.
  const volunteerModal = document.createElement('div');
  volunteerModal.id = 'volunteer-modal';
  volunteerModal.className = 'vol-modal';
  volunteerModal.innerHTML = ''
    + '<div class="vol-panel">'
    +   '<button class="vol-close" id="vol-close" type="button">✕ CLOSE</button>'
    +   '<div class="vol-eyebrow">JOIN THE EFFORT</div>'
    +   '<h2 class="vol-title">Help transcribe the next page.</h2>'
    +   '<p class="vol-sub">PURSUE is a civic-tech archive of declassified UAP material. The bottleneck is volume — pages need transcription so the corpus stays searchable. Pick a path:</p>'
    +   '<div class="vol-paths">'
    +     '<div class="vol-card">'
    +       '<div class="vol-card-head"><span class="vol-num">01</span><span class="vol-card-title">QUICKSTART</span></div>'
    +       '<p>One command. Pulls ~10 MB. Picks 20 pages, OCRs them, opens a PR.</p>'
    +       '<div class="vol-code">'
    +         '<button class="vol-copy" id="vol-copy" type="button">⎘ COPY</button>'
    +         '<pre id="vol-code-pre">curl -fsSL https://rizzleroc.github.io/pursue-console/install-helper.sh | bash\ncd pursue-helper\nnpm start\nnpm run volunteer -- --my-handle=YOU</pre>'
    +       '</div>'
    +     '</div>'
    +     '<div class="vol-card">'
    +       '<div class="vol-card-head"><span class="vol-num">02</span><span class="vol-card-title">CLAIM A PAGE</span></div>'
    +       '<p>Open a pre-filled GitHub issue for the next page in the queue.</p>'
    +       '<a class="vol-btn" id="vol-claim" href="review.html" target="_blank" rel="noopener">→ OPEN GITHUB ISSUE</a>'
    +     '</div>'
    +     '<div class="vol-card">'
    +       '<div class="vol-card-head"><span class="vol-num">03</span><span class="vol-card-title">BROWSE QUEUE</span></div>'
    +       '<p>Pick from the waiting-pages table — small (≤20) or big (>20) jobs.</p>'
    +       '<a class="vol-btn" href="help.html">→ OPEN HELP SURFACE</a>'
    +     '</div>'
    +   '</div>'
    +   '<div class="vol-foot">Reviewer credit anonymous OK · see <a href="https://github.com/rizzleroc/pursue-console/blob/main/HOW-CAN-I-HELP.md" target="_blank" rel="noopener">HOW-CAN-I-HELP.md</a></div>'
    + '</div>';
  document.body.appendChild(volunteerModal);
  function openVolunteer(){
    volunteerModal.classList.add('on');
    // Bind the CLAIM link to the live next-missing top-of-queue.
    const claim = document.getElementById('vol-claim');
    if (claim && window.MC && window.MC.derive && window.MC.url) {
      const top = window.MC.derive.queue && window.MC.derive.queue[0];
      if (top && top.eid) claim.href = window.MC.url.claim(top.eid, top.page);
    }
  }
  function closeVolunteer(){ volunteerModal.classList.remove('on'); }
  const enlistBtn = document.getElementById('enlist-btn');
  if (enlistBtn) enlistBtn.addEventListener('click', openVolunteer);
  const volClose = document.getElementById('vol-close');
  if (volClose) volClose.addEventListener('click', closeVolunteer);
  volunteerModal.addEventListener('click', function(e){ if (e.target === volunteerModal) closeVolunteer(); });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeVolunteer(); });
  const volCopy = document.getElementById('vol-copy');
  if (volCopy) volCopy.addEventListener('click', async function(){
    const pre = document.getElementById('vol-code-pre');
    try {
      await navigator.clipboard.writeText(pre.textContent);
      volCopy.textContent = '✓ COPIED';
      volCopy.classList.add('ok');
      setTimeout(function(){ volCopy.textContent = '⎘ COPY'; volCopy.classList.remove('ok'); }, 1500);
    } catch (err) { volCopy.textContent = '⨯ ERR'; }
  });

  if (window.MC && typeof window.MC.ready === 'function') {
    // Live data present — animate count-up to LIVE targets once MC is ready,
    // and re-sync (without re-animating) on every revalidation.
    window.MC.ready().then(() => { runCountUp(); updateReviewBadge(); hydrateHeaderFilters(); });
    window.MC.onUpdate(() => { runCountUp(); updateReviewBadge(); hydrateHeaderFilters(); });
    // Fallback if MC stays slow: still animate the static data-count targets.
    setTimeout(() => { if (!window.MC._loaded) runCountUp(); }, 1500);
  } else {
    setTimeout(runCountUp, 600);
  }

  // ─── Header filter strip hydration ───
  // Populate the agency + type dropdowns from MC.derive tallies and wire
  // change events to MC.setHeaderFilters (which persists + dispatches a
  // 'mc:filters' CustomEvent so every view can react).
  let _hfHydrated = false;
  function hydrateHeaderFilters() {
    if (_hfHydrated) return;
    if (!window.MC || !window.MC.derive) return;
    const qInp = document.getElementById('hf-query');
    const agSel = document.getElementById('hf-agency');
    const tySel = document.getElementById('hf-type');
    const clr   = document.getElementById('hf-clear');
    if (!qInp || !agSel || !tySel) return;

    const D = window.MC.derive;
    const byAgency = D.byAgency || {};

    // Populate agency options from the live tally so a new release's
    // agencies show up automatically.
    Object.keys(byAgency).sort().forEach(a => {
      const o = document.createElement('option');
      o.value = a; o.textContent = a;
      agSel.appendChild(o);
    });
    // Type dropdown uses the four canonical buckets the React app filters
    // by — collapsing 40+ free-form `type` strings ("Sensor Video",
    // "Mission Report + Video", "Audio Recording", "Imagery", …) into
    // {Document, Video, Image, Audio} keeps the dropdown usable and means
    // every event matches exactly one option. MC.recordType() lives in
    // data.js so views applying their own filter use the same bucketing.
    ['Document', 'Video', 'Image', 'Audio'].forEach(t => {
      const o = document.createElement('option');
      o.value = t; o.textContent = t.toUpperCase();
      tySel.appendChild(o);
    });
    // Restore from MC.headerFilters
    const HF = window.MC.headerFilters || {};
    if (HF.query)  qInp.value = HF.query;
    if (HF.agency) agSel.value = HF.agency;
    if (HF.type)   tySel.value = HF.type;

    let deb;
    qInp.addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => window.MC.setHeaderFilters({ query: qInp.value }), 120);
    });
    agSel.addEventListener('change', () => window.MC.setHeaderFilters({ agency: agSel.value }));
    tySel.addEventListener('change', () => window.MC.setHeaderFilters({ type: tySel.value }));
    if (clr) clr.addEventListener('click', () => {
      qInp.value = '';
      agSel.value = 'all';
      tySel.value = 'all';
      window.MC.setHeaderFilters({ query: '', agency: 'all', type: 'all' });
    });
    _hfHydrated = true;
  }
})();
