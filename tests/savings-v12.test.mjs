// v12: which bank lines are moves between checking and an account marked as savings (BT.savingsMove).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const a = html.indexOf('const BT = (() => {');
const b = html.indexOf('\n})();', a);
const BT = new Function(html.slice(a, b + 5) + '\nreturn BT;')();

const CHK = { id: 'chk', institution: 'Chime' }, SAV = { id: 'sav', institution: 'Chime' }, OTH = { id: 'cit', institution: 'Citizens' };
const T = (id, date, desc, amount, account) => ({ id, date, desc, rawDesc: desc, amount, account });
const SV = new Set(['sav']);
const st = { income: [{ id: 'pay', name: 'Acme', payer: 'acme corp' }] };

test('checking → savings pair: the savings leg records the move, the checking leg is a plain transfer', () => {
  const out = T('o', '2026-11-20', 'ONLINE TRANSFER TO SAVINGS', 150, CHK), inn = T('i', '2026-11-21', 'TRANSFER FROM CHK', -150, SAV), all = [out, inn];
  assert.deepEqual(BT.savingsMove(out, SV, all, st), { sv: 'in', leg: 'checking', pair: 'i' });
  assert.deepEqual(BT.savingsMove(inn, SV, all, st), { sv: 'in', leg: 'savings', pair: 'o' });
});

test('savings → checking pair is a move out of savings', () => {
  const out = T('o', '2026-11-20', 'TRANSFER TO CHECKING', 80, SAV), inn = T('i', '2026-11-20', 'TRANSFER FROM SAVINGS', -80, CHK), all = [out, inn];
  assert.deepEqual(BT.savingsMove(out, SV, all, st), { sv: 'out', leg: 'savings', pair: 'i' });
  assert.deepEqual(BT.savingsMove(inn, SV, all, st), { sv: 'out', leg: 'checking', pair: 'o' });
});

test('conservative: no savings account, no pair, too far apart, different amount, or no transfer wording', () => {
  const out = T('o', '2026-11-20', 'ONLINE TRANSFER TO SAVINGS', 150, CHK);
  assert.equal(BT.savingsMove(out, new Set(), [out], st), null, 'no savings accounts');
  assert.equal(BT.savingsMove(out, SV, [out], st), null, 'other leg not seen yet');
  assert.equal(BT.savingsMove(out, SV, [out, T('i', '2026-11-24', 'X', -150, SAV)], st), null, 'more than 2 days apart');
  assert.equal(BT.savingsMove(out, SV, [out, T('i', '2026-11-20', 'X', -149.5, SAV)], st), null, 'amount differs');
  const shop = T('s', '2026-11-20', 'SHOPRITE 123', 150, CHK);
  assert.equal(BT.savingsMove(shop, SV, [shop, T('i', '2026-11-20', 'X', -150, SAV)], st), null, 'spending that happens to match');
  const zel = T('z', '2026-11-20', 'TRANSFER TO JOHN', 50, CHK);
  assert.equal(BT.savingsMove(zel, SV, [zel, T('k', '2026-11-20', 'ZELLE FROM JOHN', -50, OTH)], st), null, 'pair is not a savings account');
});

test('on the savings account: any money in is saved (interest too), but not a paycheck; money out needs wording or a pair', () => {
  assert.deepEqual(BT.savingsMove(T('int', '2026-11-20', 'INTEREST PAID', -1.23, SAV), SV, [], st), { sv: 'in', leg: 'savings', pair: null });
  assert.equal(BT.savingsMove(T('p', '2026-11-20', 'ACME PAYROLL', -500, SAV), SV, [], st), null, 'payroll');
  assert.equal(BT.savingsMove(T('p2', '2026-11-20', 'ACME CORP', -500, SAV), SV, [], st), null, 'known payer');
  assert.equal(BT.savingsMove(T('w', '2026-11-20', 'ATM WITHDRAWAL', 40, SAV), SV, [], st), null, 'cash out of savings is not a transfer');
  assert.deepEqual(BT.savingsMove(T('w2', '2026-11-20', 'TRANSFER TO CHECKING', 40, SAV), SV, [], st), { sv: 'out', leg: 'savings', pair: null });
});

test('lines without an account id or amount are ignored', () => {
  assert.equal(BT.savingsMove(T('n', '2026-11-20', 'TRANSFER', 10, null), SV, [], st), null);
  assert.equal(BT.savingsMove(T('n', '2026-11-20', 'TRANSFER', 0, CHK), SV, [], st), null);
});
