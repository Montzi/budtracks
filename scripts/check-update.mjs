// Manual check of the update flow with a real service worker. Serve a copy of the app on :8799 from /tmp/swcheck first:
// mkdir -p /tmp/swcheck && cp -r index.html sw.js manifest.webmanifest icons /tmp/swcheck/ && (cd /tmp/swcheck && python3 -m http.server 8799 &)
import { pw } from '/home/claude/budtracks/tests/lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const b = await pw.chromium.launch(); const ctx = await b.newContext(); const p = await ctx.newPage();
let loads = 0; p.on('load', () => loads++);
await p.goto('http://localhost:8799/'); await p.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
await p.reload(); await p.waitForFunction(() => navigator.serviceWorker.controller); console.log('installed app opened again, loads', loads);
// a new release: new VERSION and a marker in the page
writeFileSync('/tmp/swcheck/sw.js', readFileSync('/tmp/swcheck/sw.js', 'utf8').replace(/budtracks-v\d+/, 'budtracks-v999'));
writeFileSync('/tmp/swcheck/index.html', readFileSync('/tmp/swcheck/index.html', 'utf8').replace('<body', '<body data-rel="v999"'));
const before = loads;
// the app comes back to the front
await p.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
await p.waitForFunction(() => document.body.dataset.rel === 'v999', null, { timeout: 20000 });
console.log('reloaded into the new release on its own:', loads > before, 'body marker', await p.evaluate(() => document.body.dataset.rel));
await b.close();
