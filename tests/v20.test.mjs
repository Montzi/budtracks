// v20: postponing a pay-later payment (schedule math, undo, plans without explicit dates).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const a = html.indexOf('const BT = (() => {');
const b = html.indexOf('\n})();', a);
const BT = new Function(html.slice(a, b + 5) + '\nreturn BT;')();
const clone = o => JSON.parse(JSON.stringify(o));
const TODAY = '2026-11-23';
const st = (plans, extra) => Object.assign({ marks: {}, occ: {}, bills: [], cards: [], spends: [], unalloc: [], perPeriod: [], income: [], plans, since: '2026-01-01' }, extra || {});
const plan = o => Object.assign({ id: 'k', provider: 'Klarna', merchant: 'Nike', amount: 25, total: 4, paid: 1, freq: 'biweekly', lastDate: '2026-11-20', autopay: true }, o || {});
const dates = (s, p) => BT.planSchedule(s, p, TODAY).map(x => x.date);

test('plan without explicit dates: planDates builds the full schedule', () => {
  const p = plan();
  assert.deepEqual(BT.planDates(p), ['2026-11-20', '2026-12-04', '2026-12-18', '2027-01-01']);
  assert.equal(p.dates, undefined);
});

test('shift all: payment 2 +7 days moves 2-4, keeping the biweekly spacing, and writes plan.dates', () => {
  const s = st([plan()]), p = s.plans[0];
  const r = BT.postponePlan(s, p, 2, '2026-12-11', true, TODAY);
  assert.ok(r.ok);
  assert.deepEqual(dates(s, p), ['2026-12-11', '2026-12-25', '2027-01-08']);
  assert.equal(p.dates.length, 4);
  assert.equal(p.dates[0], '2026-11-20');
  assert.deepEqual(p.postponed.map(x => [x.n, x.from, x.to, x.at]), [[2, '2026-12-04', '2026-12-11', TODAY]]);
  assert.equal(BT.planStatus(s, p, TODAY).ends, '2027-01-08');
});

test('move only one: later payments keep their dates', () => {
  const s = st([plan()]), p = s.plans[0];
  assert.ok(BT.postponePlan(s, p, 2, '2026-12-11', false, TODAY).ok);
  assert.deepEqual(dates(s, p), ['2026-12-11', '2026-12-18', '2027-01-01']);
  assert.equal(BT.planStatus(s, p, TODAY).ends, '2027-01-01');
});

test('monthly plans shift by month steps from the new date; weekly by 7 days', () => {
  const s = st([plan({ freq: 'monthly', lastDate: '2026-11-15', total: 4, paid: 1 }), plan({ id: 'w', freq: 'weekly', lastDate: '2026-11-20' })]);
  const [m, w] = s.plans;
  assert.deepEqual(dates(s, m), ['2026-12-15', '2027-01-15', '2027-02-15']);
  BT.postponePlan(s, m, 2, '2026-12-22', true, TODAY);
  assert.deepEqual(dates(s, m), ['2026-12-22', '2027-01-22', '2027-02-22']);
  BT.postponePlan(s, w, 2, '2026-12-05', true, TODAY);
  assert.deepEqual(dates(s, w), ['2026-12-05', '2026-12-12', '2026-12-19']);
});

test('paid payments never move; a paid later one stays fixed', () => {
  const s = st([plan({ paid: 0, lastDate: '2026-11-09', autopay: false })]), p = s.plans[0];
  // payments: 1 = 11-23 (today), 2 = 12-07, 3 = 12-21, 4 = 01-04
  s.marks['p:k:3'] = true;
  assert.equal(BT.postponeBlock(s, p, 3, TODAY), 'This payment is already paid.');
  assert.equal(BT.postponePlan(s, p, 3, '2026-12-30', true, TODAY).ok, false);
  assert.ok(BT.postponePlan(s, p, 1, '2026-11-30', true, TODAY).ok);
  assert.deepEqual(dates(s, p), ['2026-11-30', '2026-12-14', '2026-12-21', '2027-01-11']);
});

test('a payment linked to a bank line cannot be postponed', () => {
  const s = st([plan()]), p = s.plans[0];
  s.occ['p:k:2'] = { txn: 'tx1' };
  assert.ok(BT.postponeBlock(s, p, 2, TODAY));
  assert.equal(BT.postponePlan(s, p, 2, '2026-12-11', true, TODAY).ok, false);
  assert.equal(p.dates, undefined);
});

test('past due dates (autopay) count as paid and are not postponable', () => {
  const s = st([plan()]), p = s.plans[0];
  assert.ok(BT.postponeBlock(s, p, 1, TODAY));
  assert.equal(BT.postponePlan(s, p, 2, '2026-12-04', true, TODAY).ok, false, 'not later than the current date');
});

test('undo restores the previous dates; plans that had no dates get them removed again', () => {
  const s = st([plan()]), p = s.plans[0], before = dates(s, p);
  BT.postponePlan(s, p, 2, '2026-12-11', true, TODAY);
  assert.ok(BT.undoPostpone(p));
  assert.deepEqual(dates(s, p), before);
  assert.equal(p.postponed, undefined);
  assert.equal(p.dates, undefined);
  assert.equal(BT.undoPostpone(p), false);
  // two postpones undo one at a time
  const q = clone(plan({ dates: ['2026-11-20', '2026-12-04', '2026-12-18', '2027-01-01'] }));
  BT.postponePlan(s, q, 2, '2026-12-11', true, TODAY);
  BT.postponePlan(s, q, 2, '2026-12-13', true, TODAY);
  BT.undoPostpone(q);
  assert.equal(q.dates[1], '2026-12-11');
  BT.undoPostpone(q);
  assert.deepEqual(q.dates, ['2026-11-20', '2026-12-04', '2026-12-18', '2027-01-01']);
});

test('a payment moved into the next cycle leaves the current cycle occurrences', () => {
  const s = st([plan({ lastDate: '2026-11-17' })], { income: [{ id: 'pay', name: 'Pay', freq: 'biweekly', date: '2026-11-21', amount: 1000 }] });
  const r = BT.periodRange(s, 'biweekly', 0, TODAY), p = s.plans[0];
  const inCycle = () => BT.occurrences(s, r, TODAY).filter(x => x.kind === 'plan').map(x => x.n);
  assert.deepEqual(inCycle(), [2]);
  BT.postponePlan(s, p, 2, BT.addDays(r.end, 1), true, TODAY);
  assert.deepEqual(inCycle(), []);
  BT.undoPostpone(p);
  assert.deepEqual(inCycle(), [2]);
});

test('guidance warnings: over 7 days, Afterpay first/last, already postponed', () => {
  const p = plan({ provider: 'Afterpay', paid: 0, lastDate: '2026-11-09' });
  assert.deepEqual(BT.postponeWarnings(p, 2, '2026-12-14'), []);
  assert.equal(BT.postponeWarnings(p, 2, '2026-12-15').length, 1);
  assert.equal(BT.postponeWarnings(p, 1, '2026-11-30').length, 1);
  assert.equal(BT.postponeWarnings(p, 4, '2027-01-11').length, 1);
  const k = plan();
  assert.equal(BT.postponeWarnings(k, 1, '2026-11-13').length, 0);
  k.postponed = [{ n: 2 }];
  assert.equal(BT.postponeWarnings(k, 2, '2026-12-11').length, 1);
});
