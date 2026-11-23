// Renders the app's own BudTracks logo (wordmark + Bud) to icons/email-logo.png for emails: coral on a transparent background.
// Run: node scripts/render-email-logo.mjs   (needs `python3 -m http.server 8765` in the repo root and Playwright)
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../icons/email-logo.png');
const BASE = process.env.BT_URL || 'http://localhost:8765/';
const b = await pw.chromium.launch();
const page = await (await b.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2, serviceWorkers: 'block', colorScheme: 'light' })).newPage();
await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.continue());
await page.goto(BASE + '#transactions', { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
// Big, on a clean page: only the logo, in the light-theme coral, on transparent.
await page.evaluate(() => {
  document.documentElement.setAttribute('data-theme', 'light');
  const wm = document.querySelector('#logoOut .wm');
  document.body.innerHTML = ''; document.body.style.cssText = 'margin:0;background:transparent;width:600px;height:160px;display:flex;align-items:flex-end;justify-content:center;padding-bottom:8px;box-sizing:border-box';
  document.documentElement.style.background = 'transparent';
  wm.style.fontSize = '58px'; wm.style.margin = '0'; document.body.appendChild(wm);
});
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => window.dispatchEvent(new Event('resize')));   // the app redraws Bud's arms and head after a resize
await page.waitForTimeout(700);
await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: 600, height: 160 } });
await b.close();
console.log('wrote', out);
