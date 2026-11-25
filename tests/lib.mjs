// Shared setup for every e2e script. Change test-wide behavior here, not in each file.
// Each script still runs on its own: node tests/vNN.e2e.mjs [screenshot dir]. tests/run.mjs runs them all in parallel.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);

export let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
export const chromium = pw.chromium;
export const SHOTS = process.argv[2] || process.env.BT_SHOTS_DIR || '/tmp';
export const BASE = process.env.BT_URL || 'http://localhost:8765/';
export const API = 'https://worker.test';

// Dates in local time, like the app.
export const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
export const addD = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };

// Steps: a failing step is logged and counted; the script carries on. finish() prints the result and sets the exit code.
let failed = 0;
export const step = async (name, fn) => {
  try { await fn(); console.log('ok  ', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n   ', String(e && e.message).split('\n').slice(0, 25).join('\n    ')); }
};
export const failures = () => failed;
export const finish = () => { console.log(failed ? failed + ' step(s) FAILED' : 'all steps passed'); process.exit(failed ? 1 : 0); };

// Runs on every test page before the app loads. Put new test-wide defaults here.
// - Bank connections and Ask Bud on the Income tab start open, as most tests expect. prep(page, { bankOpen: false }) keeps the app default.
// - Web fonts are blocked so pages load fast and offline.
export async function prep(page, o = {}) {
  page.setDefaultTimeout(6000);
  page.setDefaultNavigationTimeout(20000); // GitHub's machine can take over 6 s to reload under parallel load
  if (o.bankOpen !== false) await page.addInitScript(() => { if (!localStorage.getItem('budtrack.incopen')) localStorage.setItem('budtrack.incopen', '{"bank":true,"ai":true}'); });
  // Every other outside request is blocked, like the offline sandbox. On GitHub the network is open and logo
  // services made page loads hang. Routes a test adds later, for the Worker or Plaid, take priority over this one.
  await page.route(u => !/^(https?:\/\/localhost[:/]|https:\/\/worker\.test\/|https:\/\/cdn\.plaid\.com\/|data:|blob:)/.test(u.href), route => route.abort());
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  return page;
}

// Layout helpers.
export const noHScroll = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 0.5 && document.body.scrollWidth <= innerWidth + 0.5), 'horizontal scroll at ' + label);
export const R = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top + scrollY, b: r.bottom + scrollY, w: r.width, h: r.height }; }, sel);
export const near = (a, b, d, msg) => assert.ok(Math.abs(a - b) <= d, msg + ': ' + a + ' vs ' + b);
export const go = async (page, tab) => { await page.evaluate(t => { location.hash = '#' + t; }, tab); await page.waitForFunction(t => document.querySelector('.app').dataset.tab === t, tab); await page.waitForTimeout(400); };

// Waits for the app's first bank sync. Up to 20 s: a big sync is slow when tests run in parallel.
// On a timeout it prints what the app saw, so a failure on GitHub can be read from the log.
export const synced = (page, more) => page.waitForFunction(m => { const b = JSON.parse(localStorage.getItem('budtrack.v1')).bank; return !!b.lastSync && (!m || !!(b.balances && b.balances.items.length)); }, !!more, { timeout: 20000 })
  .catch(async e => {
    const why = await page.evaluate(() => { const b = JSON.parse(localStorage.getItem('budtrack.v1')).bank; return { lastSync: b.lastSync, balances: b.balances && b.balances.items.length, syncErr: typeof BANKUI !== 'undefined' ? BANKUI.syncErr : '?', toast: (document.querySelector('#toast') || {}).textContent, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, now: new Date().toString() }; }).catch(x => 'page gone: ' + x.message);
    console.log('SYNC WAIT TIMED OUT', JSON.stringify(why)); throw e;
  });

// v49: "Updated ..." for bank sync moved from the Transactions header into the Spent this pay cycle list. Opens it, reads it, closes it.
export async function txUpdated(page) {
  await page.click('.tx-sum-b'); await page.waitForSelector('#sheet:not([hidden]) .lede');
  const t = await page.locator('#sheet .lede').innerText();
  await page.click('#sheet .sheet-h [data-action="close"]'); await page.waitForSelector('#sheet', { state: 'hidden' });
  return t;
}
