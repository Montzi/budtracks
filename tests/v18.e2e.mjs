// v18: one persistent brand header (Bud, laptop, wordmark, glow, Saved pill) shared by every tab.
// Run: node tests/v18.e2e.mjs <screenshot dir>   (needs `python3 -m http.server 8765` in the repo root)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
const SHOTS = process.argv[2] || '/tmp';
const BASE = process.env.BT_URL || 'http://localhost:8765/';
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n   ', String(e.message).split('\n').slice(0, 14).join('\n    ')); } };
const TABS = ['overview', 'transactions', 'bills', 'plans', 'income'];
const SIZES = [[390, 844], [430, 932], [669, 951], [951, 669], [1000, 703]];
const b = await pw.chromium.launch();
async function newPage(w, h, o) {
  o = o || {};
  const ctx = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', colorScheme: o.scheme || 'dark', deviceScaleFactor: 1 });
  const page = await ctx.newPage(); page.setDefaultTimeout(6000);
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  await page.goto(BASE, { waitUntil: 'load' });
  if (o.theme) { await page.evaluate(t => { const s = JSON.parse(localStorage.getItem('budtrack.v1') || '{}'); s.settings = Object.assign(s.settings || {}, { theme: t }); localStorage.setItem('budtrack.v1', JSON.stringify(s)); }, o.theme); }
  await page.goto(BASE + '#overview', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);
  return { ctx, page, errs };
}
const go = async (page, t) => { await page.evaluate(t => { location.hash = t; }, t); await page.waitForTimeout(250); };
const noHScroll = async (page, m) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 0.5), 'horizontal scroll ' + m);
const overlap = (a, c) => a.l < c.r - .01 && c.l < a.r - .01 && a.t < c.b - .01 && c.t < a.b - .01;
const geo = page => page.evaluate(() => {
  const q = s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  return { bar: q('#brandbar'), wm: q('#brandbar .wm'), arms: q('#brandbar svg.arms'), hd: q('#brandbar svg.hd'), sync: q('#brandbar .sync'), hero: q('.ov > .hero') };
});
const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
const ratio = (a, c) => { const x = lum(a), y = lum(c); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const rgb = s => s.match(/[\d.]+/g).slice(0, 3).map(Number);

for (const [w, h] of SIZES) for (const scheme of ['dark', 'light']) {
  const { page, errs } = await newPage(w, h, { scheme, theme: scheme });
  const tag = `${w}x${h} ${scheme}`;
  await step(`${tag}: one brand header, same node across all tabs, same wordmark size, nothing old left`, async () => {
    await page.evaluate(() => { const bb = document.querySelector('#brandbar'); bb.__tag = 'same'; bb.querySelector('svg.hd').__tag = 'same'; bb.querySelector('.wm').__tag = 'same'; window.__anim = document.getAnimations().filter(a => a.animationName === 'glowDrift').map(a => a.startTime); });
    let ow = null;
    for (const t of [...TABS, 'plans', 'overview']) {
      await go(page, t);
      const g = await geo(page);
      assert.equal(await page.locator('#brandbar').count(), 1, 'one header');
      assert.ok(await page.evaluate(() => document.querySelector('#brandbar').__tag === 'same' && document.querySelector('#brandbar svg.hd').__tag === 'same' && document.querySelector('#brandbar .wm').__tag === 'same'), 'header remounted on ' + t);
      assert.ok(g.bar && g.bar.w > 0 && g.wm && g.arms && g.hd && g.sync, 'parts on ' + t);
      if (ow === null) ow = g.wm.w; assert.ok(Math.abs(g.wm.w - ow) <= 2, `wordmark width ${g.wm.w} vs ${ow} on ${t}`);
      const fs = await page.locator('#brandbar .wm').evaluate(e => parseFloat(getComputedStyle(e).fontSize)); assert.ok(Math.abs(fs - Math.min(68, Math.max(44, w * .15))) < 1, 'wordmark font ' + fs);
      assert.equal(await page.locator('#brandOut, .hero-brand, .hero .sync, .hero-foot .sync, .wm').evaluateAll(els => els.filter(e => !e.closest('#brandbar')).length), 0, 'no old logo/Saved: ' + t);
      assert.equal(await page.locator('.sync:visible').count(), 1, 'exactly one Saved pill');
      assert.ok(g.arms.l >= -.5 && g.arms.r <= w + .5 && g.bar.r <= w + .5);
      await noHScroll(page, t);
      if (t !== 'overview' && w === 390) assert.ok(g.bar.h <= 220, 'header height ' + g.bar.h);
    }
    const anim = await page.evaluate(() => document.getAnimations().filter(a => a.animationName === 'glowDrift').map(a => a.startTime));
    assert.deepEqual(anim, await page.evaluate(() => window.__anim), 'glow animation never restarted');
    assert.deepEqual(errs, []);
  });
  await step(`${tag}: Saved pill top-right, clear of wordmark, arms and Bud on every tab`, async () => {
    for (const long of [false, true]) for (const t of TABS) {
      await go(page, t);
      await page.evaluate(l => { document.querySelectorAll('.sync').forEach(e => { e.textContent = l ? 'Not synced. Saved in this browser' : 'Saved'; }); }, long);
      const g = await geo(page);
      for (const k of ['wm', 'arms', 'hd']) assert.ok(!overlap(g.sync, g[k]), `${k} overlaps Saved on ${t}: ` + JSON.stringify([g.sync, g[k]]));
      assert.ok(g.sync.r <= g.bar.r - 8 && g.sync.r >= g.bar.r - 16 && g.sync.t - g.bar.t <= 12 && g.sync.l >= g.bar.l, 'top-right corner ' + JSON.stringify([g.sync, g.bar]));
      assert.ok(g.sync.l > (g.bar.l + g.bar.r) / 2 - 60 || !long, 'not centered');
    }
  });
  await step(`${tag}: Saved pill text contrast >= 4.5`, async () => {
    for (const t of ['overview', 'plans']) {
      await go(page, t);
      const c = await page.evaluate(() => { const e = document.querySelector('#brandbar .sync'), s = getComputedStyle(e); return { fg: s.color, bg: getComputedStyle(document.querySelector('#brandbar')).backgroundColor }; });
      const r = ratio(rgb(c.fg), rgb(c.bg)); assert.ok(r >= 4.5, `contrast ${r.toFixed(2)} ${JSON.stringify(c)}`);
    }
  });
  await step(`${tag}: Overview hero continues the header seamlessly`, async () => {
    await go(page, 'overview');
    const g = await geo(page);
    assert.ok(Math.abs(g.bar.b - g.hero.t) <= 1, `header bottom ${g.bar.b} vs hero top ${g.hero.t}`);
    assert.ok(Math.abs(g.bar.l - g.hero.l) <= 1, 'same left edge');
    const wide = w >= 900 || (w >= 740 && w > h);
    if (!wide) assert.ok(Math.abs(g.bar.w - g.hero.w) <= 1, 'same width'); else assert.ok(Math.abs(g.bar.w - g.hero.w) <= 1, 'header spans the hero column: ' + g.bar.w + ' vs ' + g.hero.w);
    const bg = await page.evaluate(() => [getComputedStyle(document.querySelector('#brandbar')).backgroundColor, getComputedStyle(document.querySelector('.ov > .hero')).backgroundColor]);
    assert.equal(bg[0], bg[1]); assert.equal(bg[0], scheme === 'dark' ? 'rgb(24, 36, 63)' : 'rgb(255, 255, 255)');
    const rad = await page.evaluate(() => { const a = getComputedStyle(document.querySelector('#brandbar')), c = getComputedStyle(document.querySelector('.ov > .hero')); return [a.borderBottomLeftRadius, c.borderTopLeftRadius, a.borderTopLeftRadius, c.borderBottomLeftRadius]; });
    assert.deepEqual(rad, ['0px', '0px', '22px', '22px']);
    if (wide) { const d = await page.evaluate(() => document.querySelector('.ov-donut').getBoundingClientRect().top); assert.ok(Math.abs(d - g.hero.t) <= 1, 'donut aligned with the hero top ' + d + ' vs ' + g.hero.t); }
  });
  await step(`${tag}: other tabs: standalone rounded card, content below`, async () => {
    await go(page, 'plans');
    const g = await geo(page), r = await page.evaluate(() => getComputedStyle(document.querySelector('#brandbar')).borderBottomLeftRadius);
    assert.equal(r, '22px'); const wide = w >= 900 || (w >= 740 && w > h); assert.ok(wide || g.bar.w >= Math.min(w - 40, 700) - 2, 'full width ' + g.bar.w);   // v19: landscape keeps the Overview column width on every tab
    const m = await page.evaluate(() => document.querySelector('#main').getBoundingClientRect().top); assert.ok(m >= g.bar.b + 8, 'content below header');
  });
  await step(`${tag}: tapping Bud opens the hat sheet from Plans; party glow follows a change`, async () => {
    await go(page, 'plans');
    await page.locator('#brandbar svg.hd').dispatchEvent('click'); await page.waitForSelector('#sheet:not([hidden]) .hat-sw');
    await page.click('#sheet [data-action="hat-color"][data-c="#d03b3b"]'); await page.waitForTimeout(150);
    assert.ok(await page.evaluate(() => (document.querySelector('#brandbar svg.hd').innerHTML.includes('#d03b3b') && document.querySelector('#brandbar').__x !== 1)), 'hat updated in the header');
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    assert.equal(await page.locator('#brandbar .wm').count(), 1);
    const g = await geo(page); assert.ok(g.arms && g.hd);
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('budtrack.v1')); s.settings.hat = { color: '#16181d', dir: 'front' }; localStorage.setItem('budtrack.v1', JSON.stringify(s)); });
  });
  if (w === 390 || w === 951) await step(`${tag}: screenshots`, async () => {
    await page.evaluate(() => document.querySelectorAll('.sync').forEach(e => { e.textContent = 'Saved'; }));
    if (scheme === 'dark' && w === 390) { await go(page, 'overview'); await page.screenshot({ path: `${SHOTS}/brand-overview-390.png` }); await go(page, 'transactions'); await page.screenshot({ path: `${SHOTS}/brand-tx-390.png` }); }
    if (scheme === 'light' && w === 390) { await go(page, 'plans'); await page.screenshot({ path: `${SHOTS}/brand-plans-light-390.png` }); }
    if (scheme === 'dark' && w === 951) { await go(page, 'overview'); await page.screenshot({ path: `${SHOTS}/brand-overview-951.png` }); }
  });
  await page.context().close();
}

await step('party rainbow turns on the header from any tab and Bud speaks', async () => {
  const { page } = await newPage(390, 844); await go(page, 'bills');
  await page.evaluate(() => { document.querySelector('#brandbar').classList.add('party'); });
  await page.waitForTimeout(1800); assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#brandbar'), '::after').opacity), '1');
  await page.locator('#brandbar svg.hd').hover(); await page.waitForTimeout(250);
  assert.ok(await page.evaluate(() => document.querySelector('#bud').classList.contains('on') && /Bud/.test(document.querySelector('#bud').textContent)), 'Bud bubble on hover');
  await page.context().close();
});

await b.close();
console.log(failed ? `\n${failed} FAILED` : '\nall ok');
process.exit(failed ? 1 : 0);
