// Render OpenGraph cards from /mc/share.html by loading the page in
// headless Chromium at a 1200×630 viewport and screenshotting.
//
// Output: public/og/default.png   (USPER-2025 default)
//         public/og/event-<eid>.png  (one per curated event)
//
// Twitter Cards crawl the static og:image URL — they don't execute JS.
// So the per-event cards must be pre-rendered files on disk, not
// runtime-generated. This script is the pre-render step.
//
// Playwright lives in the pursue-vision-mcp/node_modules nested install
// (not the top-level package's dependencies). Resolve it explicitly so
// `npm run build` finds it from the repo root.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
let chromium;
for (const candidate of [
  'playwright',
  path.resolve(__dirname, '../pursue-vision-mcp/node_modules/playwright'),
  path.resolve(__dirname, '../node_modules/playwright'),
]) {
  try { ({ chromium } = _require(candidate)); break; } catch (e) {}
}
if (!chromium) {
  console.error('[og-cards] playwright not found in any node_modules — skipping. Run `npm i playwright` at the repo root, or hoist from pursue-vision-mcp.');
  process.exit(0);
}
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(PUBLIC, 'og');

const CURATED = ['usper-2025', 'DOE-UAP-D001', 'fbi-62hq83894', 'gemini-7', 'apollo-17', 'cometa'];

// Tiny static HTTP server so the share.html page can fetch its sibling
// JSON files (data.js → events.json etc) the same way it does in prod.
function startServer(rootDir, port) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        let pth = path.join(rootDir, decodeURIComponent(url.pathname));
        if (pth.endsWith('/')) pth = path.join(pth, 'index.html');
        const s = await stat(pth);
        if (s.isDirectory()) pth = path.join(pth, 'index.html');
        const ext = path.extname(pth).toLowerCase();
        const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml' };
        res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.writeHead(200);
        createReadStream(pth).pipe(res);
      } catch (e) {
        res.writeHead(404); res.end('404 ' + req.url);
      }
    });
    server.listen(port, () => resolve(server));
  });
}

await mkdir(OUT, { recursive: true });
const PORT = 17891;
const server = await startServer(PUBLIC, PORT);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });

async function shoot(eid, outPath) {
  const page = await ctx.newPage();
  const url = `http://localhost:${PORT}/mc/share.html?eid=${encodeURIComponent(eid)}&render=card`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  // Wait for MC data + render() to settle, including the curated overlay paint.
  await page.waitForFunction(() => window.MC && window.MC._loaded, { timeout: 20000 });
  await page.waitForTimeout(800);
  // Trim everything except the share-frame card — the surrounding chrome/CTA tray
  // shouldn't appear in the OG image.
  await page.evaluate(() => {
    document.body.style.cssText = 'background:#0A1018;margin:0;padding:0;';
    const frame = document.getElementById('share-frame');
    if (frame) {
      frame.style.cssText += ';margin:0;max-width:1200px;width:1200px;min-height:630px;box-shadow:none';
    }
    // Hide every non-frame surface
    document.querySelectorAll('main > *').forEach(el => {
      if (el.id !== 'share-frame') el.style.display = 'none';
    });
    // Hide chrome injected by chrome.js
    document.querySelectorAll('.topbar, .tabs, .header-filters, .classified, .fc, .scanline, .bg-grid, .bg-noise, .vignette, .corner').forEach(el => el.style.display = 'none');
  });
  await page.waitForTimeout(300);
  const frame = await page.$('#share-frame');
  if (!frame) throw new Error('share-frame not found for ' + eid);
  await frame.screenshot({ path: outPath, type: 'png' });
  await page.close();
  console.log(`  ${path.relative(ROOT, outPath)}`);
}

console.log('[og-cards] rendering default + ' + CURATED.length + ' curated cards…');
const defaultEid = CURATED[0]; // USPER-2025 = the site-wide default
await shoot(defaultEid, path.join(OUT, 'default.png'));

for (const eid of CURATED) {
  const safe = eid.replace(/[^a-z0-9_.-]/gi, '_');
  await shoot(eid, path.join(OUT, `event-${safe}.png`));
}

await browser.close();
server.close();
console.log('[og-cards] done.');
