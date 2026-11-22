// Screenshot entries: automatic links to the bank's own transaction, suggestions when the amount changed, and duplicate
// detection when reviewing what a screenshot shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const a = html.indexOf('const BT = (() => {');
const b = html.indexOf('\n})();', a);
const BT = new Function(html.slice(a, b + 5) + '\nreturn BT;')();

const shot = (id, desc, amount, date, raw, over) => Object.assign({ id, category: 'Takeout Food', desc, amount, date, via: '', note: '',
  shot: { at: '2026-11-20T15:00:00Z', bank: 'Chase', pending: false, rawMerchant: raw || desc, accountHint: null } }, over || {});
const T = (id, date, desc, amount, over) => Object.assign({ id: 'pl:' + id, date, desc, rawDesc: desc, amount, account: { id: 'chk', institution: 'Chase', last4: '1284' }, status: 'posted', pendingOf: null, counterparty: null }, over || {});
const st = (spends, bank) => ({ spends, categories: ['Takeout Food', 'Laundry', 'Dining Out', 'Other'], billCats: [], bank: Object.assign({ seen: {}, inbox: [], history: [], txns: {}, notShot: {} }, bank || {}) });

test('names alike: delivery-app prefixes, truncated names, Square prefixes; different merchants and payment apps alone are not', () => {
  for (const [x, y] of [['DD *DOORDASH', 'DoorDash'], ['DD *DOORDASH', 'DD *DOORDASH DASHPASS 855-973-1040 CA'], ['DURANLAUNDROMA', 'DURAN LAUNDROMAT'], ['SQ *EL MESON R', 'El Meson Restaurant'], ['UBER * EATS', 'Uber Eats'], ['KLARNA', 'Klarna']]) assert.ok(BT.shotSim(x, y), x + ' ~ ' + y);
  for (const [x, y] of [['UBER * EATS', 'DoorDash'], ['PAYPAL to Ana', 'PAYPAL *SPOTIFY'], ['Shell', 'DoorDash'], ['DURANLAUNDROMA', 'SQ *EL MESON R']]) assert.ok(!BT.shotSim(x, y), x + ' !~ ' + y);
});

test('exact link: same amount, a pending date 2 days later, "DD *DOORDASH" vs "DoorDash"', () => {
  const s = st([shot('e1', 'DoorDash', 16.2, '2026-11-20', 'DD *DOORDASH')]);
  const t = T('dd', '2026-11-22', 'DoorDash', 16.2, { rawDesc: 'DD *DOORDASH 855-973-1040', status: 'pending' });
  assert.deepEqual(BT.shotMatch(s, t), { type: 'link', spend: s.spends[0], diff: 0 });
  assert.deepEqual(BT.shotLinks(s, [t]).map(l => [l.txn.id, l.spend.id]), [['pl:dd', 'e1']]);
  // A cent off still links; the same purchase 4 days away does not link but is suggested; 6 days away is unrelated.
  assert.equal(BT.shotMatch(s, T('a', '2026-11-21', 'DoorDash', 16.21)).type, 'link');
  assert.equal(BT.shotMatch(s, T('b', '2026-11-23', 'DoorDash', 16.2)).type, 'link');
  assert.equal(BT.shotMatch(s, T('c', '2026-11-24', 'DoorDash', 16.2)).type, 'suggest');
  assert.equal(BT.shotMatch(s, T('d', '2026-11-16', 'DoorDash', 16.2)).type, 'suggest');
  assert.equal(BT.shotMatch(s, T('e', '2026-11-26', 'DoorDash', 16.2)), null);
});

test('tip difference: bank amount up to +30% (or -10%) is a suggestion, never an automatic link', () => {
  const s = st([shot('e1', 'DoorDash', 16.2, '2026-11-20', 'DD *DOORDASH')]);
  const m = BT.shotMatch(s, T('dd', '2026-11-21', 'DD *DOORDASH', 19.7));
  assert.equal(m.type, 'suggest'); assert.equal(m.spend.id, 'e1'); assert.equal(m.diff, 3.5);
  assert.equal(BT.shotLinks(s, [T('dd', '2026-11-21', 'DD *DOORDASH', 19.7)]).length, 0);
  assert.equal(BT.shotMatch(s, T('lo', '2026-11-21', 'DoorDash', 14.6)).type, 'suggest');
  assert.equal(BT.shotMatch(s, T('hi', '2026-11-21', 'DoorDash', 21.2)), null, 'more than 30% more');
  assert.equal(BT.shotMatch(s, T('lo2', '2026-11-21', 'DoorDash', 14.5)), null, 'more than 10% less');
});

test('different merchant, same amount and day: no link, no suggestion', () => {
  const s = st([shot('e1', 'Duran Laundromat', 32.32, '2026-11-20', 'DURANLAUNDROMA', { category: 'Laundry' })]);
  assert.equal(BT.shotMatch(s, T('x', '2026-11-20', 'SHELL OIL 5521', 32.32)), null);
  assert.equal(BT.shotMatch(s, T('y', '2026-11-20', 'DURAN LAUNDROMAT', 32.32)).type, 'link');
  // Money in never links to spending.
  assert.equal(BT.shotMatch(s, T('z', '2026-11-20', 'DURAN LAUNDROMAT', -32.32)), null);
});

test('one entry per bank line: two laundromat visits link to the right amounts; linked, refused and seen ones are skipped', () => {
  const s = st([shot('l1', 'Duranlaundroma', 32.32, '2026-11-19', 'DURANLAUNDROMA'), shot('l2', 'Duranlaundroma', 23.98, '2026-11-19', 'DURANLAUNDROMA')]);
  const t1 = T('a', '2026-11-20', 'DURAN LAUNDROMAT', 23.98), t2 = T('b', '2026-11-20', 'DURAN LAUNDROMAT', 32.32), t3 = T('c', '2026-11-20', 'DURAN LAUNDROMAT', 32.32);
  assert.deepEqual(BT.shotLinks(s, [t1, t2, t3]).map(l => [l.txn.id, l.spend.id]), [['pl:a', 'l2'], ['pl:b', 'l1']]);
  // Already linked to a bank line: not a candidate any more.
  s.spends[0].bank = 'pl:b';
  assert.equal(BT.shotMatch(s, t3), null);
  // "Not the same" for this line and entry.
  s.spends[0].bank = undefined; s.bank.notShot['pl:c'] = ['l1'];
  assert.equal(BT.shotMatch(s, t3), null);
  assert.equal(BT.shotMatch(s, t2).spend.id, 'l1');
  // A bank line already decided is never linked again.
  s.bank.seen['pl:b'] = { res: 'skip', src: 'sync' };
  assert.equal(BT.shotLinks(s, [t2]).length, 0);
  // Entries typed by hand (no shot) never auto-link.
  const h = st([{ id: 'm', category: 'Laundry', desc: 'Duran Laundromat', amount: 32.32, date: '2026-11-20' }]);
  assert.equal(BT.shotMatch(h, t2), null);
});

test('duplicates in review: same amount ±$0.01 within 3 days and a similar name, in spends, bank lines or an earlier screenshot', () => {
  const row = (merchant, amount, date) => ({ merchant, amount, date });
  const s = st([{ id: 'm1', category: 'Takeout Food', desc: 'Uber Eats', amount: 35.35, date: '2026-11-20', note: '' }, shot('e2', 'El Meson R', 23.54, '2026-11-18', 'SQ *EL MESON R', { category: 'Dining Out' })], {
    txns: { 'pl:dd': T('dd', '2026-11-21', 'DoorDash', 16.2, { rawDesc: 'DD *DOORDASH' }) },
    inbox: [{ txn: T('lau', '2026-11-19', 'DURAN LAUNDROMAT', 32.32), kind: 'spend' }]
  });
  assert.equal(BT.shotDupe(s, row('UBER * EATS', 35.35, '2026-11-21')), 'spend');
  assert.equal(BT.shotDupe(s, row('SQ *EL MESON R', 23.54, '2026-11-18')), 'screenshot');
  assert.equal(BT.shotDupe(s, row('DD *DOORDASH', 16.2, '2026-11-20')), 'bank');
  assert.equal(BT.shotDupe(s, row('DURANLAUNDROMA', 32.32, '2026-11-20')), 'bank', 'a line waiting in review');
  assert.equal(BT.shotDupe(s, row('DURANLAUNDROMA', 32.31, '2026-11-22')), 'bank', 'a cent off, 3 days');
  assert.equal(BT.shotDupe(s, row('DURANLAUNDROMA', 23.98, '2026-11-19')), '', 'other amount');
  assert.equal(BT.shotDupe(s, row('DD *DOORDASH', 16.2, '2026-11-25')), '', '4 days away');
  assert.equal(BT.shotDupe(s, row('SHELL', 16.2, '2026-11-21')), '', 'other merchant');
});
