// Plaid-shaped fixtures. Plaid amounts: positive = money out, negative = money in, for every account type.
export const checking = { account_id: 'acc_chk', name: 'Everyday Checking', official_name: 'Chase Total Checking', mask: '1234', type: 'depository', subtype: 'checking' };
export const card = { account_id: 'acc_cc', name: 'Sapphire Card', official_name: null, mask: '9876', type: 'credit', subtype: 'credit card' };

export const tx = (id, account_id, date, name, amount, over = {}) => ({
  transaction_id: id, account_id, date, authorized_date: null, name, merchant_name: null, amount, pending: false,
  pending_transaction_id: null, personal_finance_category: null, ...over });
const pfc = (primary, detailed) => ({ primary, detailed, confidence_level: 'HIGH' });

export const checkingTxns = [
  tx('t_pay', 'acc_chk', '2026-11-14', 'ACME CORP PAYROLL', -2450, { personal_finance_category: pfc('INCOME', 'INCOME_WAGES') }),
  tx('t_pp', 'acc_chk', '2026-11-12', 'PAYPAL *SPOTIFY', 11.99, { merchant_name: 'Spotify', personal_finance_category: pfc('ENTERTAINMENT', 'ENTERTAINMENT_MUSIC_AND_AUDIO') }),
  tx('t_pend', 'acc_chk', '2026-11-11', 'WHOLEFDS 123', 52.1, { merchant_name: 'Whole Foods', pending: true, authorized_date: '2026-11-10', personal_finance_category: pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES') }),
];
export const cardTxns = [
  tx('t_kl', 'acc_cc', '2026-11-13', 'KLARNA*PAYMENT', 45, { personal_finance_category: pfc('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE') }),
  tx('t_ccpay', 'acc_cc', '2026-11-10', 'PAYMENT THANK YOU', -300, { personal_finance_category: pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') }),
  tx('t_old', 'acc_cc', '2026-09-01', 'Old coffee', 4.5, { personal_finance_category: pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE') }),
];

const PLAID_ERR = (code, type = 'ITEM_ERROR', message = code) => ({ error_type: type, error_code: code, error_message: message });

// Mock Plaid. tokens[access_token] = { item_id, accounts, batches, error, itemError, mutateOnce }
// `batches` is a list of sync batches; each batch is a list of pages { added, modified, removed }.
// A cursor of null starts at batch 0; the cursor returned after batch i is "b<i+1>"; mid-batch cursors are "p<i>.<j>".
export function mockPlaid({ tokens } = {}) {
  tokens ||= { tok_good: { item_id: 'item_1', accounts: [checking, card], batches: [[{ added: [...checkingTxns, ...cardTxns], modified: [], removed: [] }]] } };
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url), body = JSON.parse(init.body || '{}');
    calls.push({ method: init.method || 'GET', host: u.origin, path: u.pathname, body });
    const R = (s, b) => new Response(JSON.stringify(b), { status: s });
    if (u.pathname === '/item/public_token/exchange') {
      if (body.public_token === 'public-bad') return R(400, PLAID_ERR('INVALID_PUBLIC_TOKEN', 'INVALID_INPUT'));
      const tok = body.public_token.replace('public-', 'tok_');
      return tokens[tok] ? R(200, { access_token: tok, item_id: tokens[tok].item_id }) : R(400, PLAID_ERR('INVALID_PUBLIC_TOKEN', 'INVALID_INPUT'));
    }
    if (u.pathname === '/sandbox/public_token/create') {
      if (!body.institution_id || !body.initial_products) return R(400, PLAID_ERR('INVALID_FIELD', 'INVALID_REQUEST'));
      return R(200, { public_token: 'public-good', request_id: 'x' });
    }
    if (u.pathname === '/link/token/create') {
      if (body.access_token && !tokens[body.access_token]) return R(400, PLAID_ERR('INVALID_ACCESS_TOKEN', 'INVALID_INPUT'));
      return R(200, { link_token: body.access_token ? 'link-update-token' : 'link-new-token', expiration: 'x' });
    }
    const t = tokens[body.access_token];
    if (!t) return R(400, PLAID_ERR('INVALID_ACCESS_TOKEN', 'INVALID_INPUT'));
    if (u.pathname === '/item/remove') return R(200, { removed: true });
    if (t.error) return R(400, PLAID_ERR(t.error));
    if (u.pathname === '/accounts/get') return R(200, { accounts: t.accounts, item: { institution_id: 'ins_1', error: t.itemError || null } });
    if (u.pathname === '/transactions/refresh') {
      if (t.refreshError) return R(400, PLAID_ERR(t.refreshError, 'INVALID_REQUEST', 'this product is not enabled for your account'));
      return R(200, { request_id: 'r1' });
    }
    if (u.pathname === '/transactions/sync') {
      const empty = { added: [], modified: [], removed: [] };
      let b = 0, p = 0, m;
      if (body.cursor && (m = /^b(\d+)$/.exec(body.cursor))) b = +m[1];
      else if (body.cursor && (m = /^p(\d+)\.(\d+)$/.exec(body.cursor))) { b = +m[1]; p = +m[2]; }
      const batch = t.batches[b];
      if (!batch) return R(200, { ...empty, next_cursor: body.cursor || 'b0', has_more: false });
      if (t.mutateOnce && p === 1 && !t.mutated) { t.mutated = true; return R(400, PLAID_ERR('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 'TRANSACTIONS_ERROR')); }
      if (t.failAtPage === p && batch.length > 1) return R(500, PLAID_ERR('INTERNAL_SERVER_ERROR', 'API_ERROR'));
      const more = p + 1 < batch.length;
      return R(200, { ...empty, ...batch[p], next_cursor: more ? `p${b}.${p + 1}` : `b${b + 1}`, has_more: more });
    }
    return R(404, PLAID_ERR('NOT_FOUND', 'API_ERROR'));
  };
  fn.calls = calls;
  return fn;
}
export { PLAID_ERR };
