// Sandbox-shaped Teller fixtures. Depository: debits negative. Credit: purchases positive.
export const inst = { id: 'chase', name: 'Chase' };
export const checking = { id: 'acc_chk', enrollment_id: 'enr_1', name: 'Everyday Checking', type: 'depository', subtype: 'checking', last_four: '1234', status: 'open', institution: inst };
export const card = { id: 'acc_cc', enrollment_id: 'enr_1', name: 'Sapphire Card', type: 'credit', subtype: 'credit_card', last_four: '9876', status: 'open', institution: inst };

const tx = (id, account_id, date, description, amount, status, category, cp, type = 'card_payment') =>
  ({ id, account_id, date, description, amount, status, type, details: { category, processing_status: 'complete', counterparty: cp ? { name: cp, type: 'organization' } : undefined } });

export const checkingTxns = [
  tx('txn_pay', 'acc_chk', '2026-11-14', 'ACME CORP PAYROLL', '2450.00', 'posted', 'income', 'ACME Corp', 'ach'),
  tx('txn_pp', 'acc_chk', '2026-11-12', 'PAYPAL *SPOTIFY', '-11.99', 'posted', 'entertainment', 'PayPal'),
  tx('txn_pend', 'acc_chk', '2026-11-11', 'Whole Foods', '-52.10', 'pending', 'groceries', 'Whole Foods'),
];
export const cardTxns = [
  tx('txn_kl', 'acc_cc', '2026-11-13', 'KLARNA*PAYMENT', '45.00', 'posted', 'shopping', 'Klarna'),
  tx('txn_ccpay', 'acc_cc', '2026-11-10', 'PAYMENT THANK YOU', '-300.00', 'posted', 'general', null, 'payment'),
  tx('txn_old', 'acc_cc', '2026-09-01', 'Old coffee', '4.50', 'posted', 'dining', 'Cafe'),
];

// Mock Teller: matches Basic auth to tokens, honours count/from_id, can simulate disconnects.
export function mockTeller({ tokens = { tok_good: { accounts: [checking, card], txns: { acc_chk: checkingTxns, acc_cc: cardTxns } } } } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const tok = atob((init.headers.Authorization || '').replace('Basic ', '')).split(':')[0];
    calls.push({ method: init.method || 'GET', path: u.pathname + u.search, tok });
    const t = tokens[tok];
    const R = (s, b) => new Response(b === undefined ? null : JSON.stringify(b), { status: s });
    if (!t) return R(401, { error: { code: 'unauthorized', message: 'Bad token' } });
    if (t.disconnected) return R(404, { error: { code: 'enrollment.disconnected', message: 'Enrollment disconnected' } });
    if (u.pathname === '/accounts') return R(200, t.accounts);
    let m;
    if ((m = /^\/accounts\/(\w+)\/transactions$/.exec(u.pathname))) {
      let list = t.txns[m[1]] || [];
      const from = u.searchParams.get('from_id');
      if (from) list = list.slice(list.findIndex((x) => x.id === from) + 1);
      return R(200, list.slice(0, +u.searchParams.get('count') || 50));
    }
    if ((m = /^\/accounts\/(\w+)$/.exec(u.pathname)) && init.method === 'DELETE') return R(204);
    return R(404, { error: { code: 'not_found', message: 'nope' } });
  };
  fn.calls = calls;
  return fn;
}
