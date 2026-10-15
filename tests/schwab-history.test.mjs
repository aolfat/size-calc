// Run with: node --test
// Journal spike: the Schwab history export reads positions, recent orders and several transaction ranges, keeps each
// read's answer or error, says how far back each went, and masks every account number before the file is saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 86400000;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const connected = () => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }])],
  ['schwab_account', 'HASH1'],
]);

// a fake Schwab: full account numbers everywhere, and a year of transactions refused
function schwab() {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    const path = u.pathname.replace('/trader/v1', '');
    if (path === '/accounts/HASH1') return json({ securitiesAccount: { accountNumber: '123456789', positions: [{ instrument: { symbol: 'AAPL' }, longQuantity: 10 }] } });
    if (path === '/accounts/HASH1/orders') return json([
      { orderId: 1, accountNumber: 123456789, enteredTime: '2026-09-01T14:00:00+0000', status: 'FILLED' },
      { orderId: 2, accountNumber: 123456789, enteredTime: '2026-10-10T14:00:00+0000', status: 'WORKING' },
    ]);
    if (path === '/accounts/HASH1/transactions') {
      const days = (Date.parse(u.searchParams.get('endDate')) - Date.parse(u.searchParams.get('startDate'))) / DAY;
      if (days > 200) return json({ message: 'Date range is too long' }, 400);
      return json([{ activityId: 9, accountNumber: '123456789', tradeDate: '2026-08-20T15:00:00+0000', type: 'TRADE', transferItems: [{ instrument: { symbol: 'AAPL' }, amount: 10, price: 180, fee: 0 }] }]);
    }
    return json({}, 404);
  };
  return { calls, fetch };
}

test('the export keeps every read, says how far each went, and masks account numbers', async () => {
  const net = schwab();
  const { run } = await app({ fetch: net.fetch, storage: connected() });
  const out = JSON.parse(await run('buildSchwabHistory(Date.parse("2026-10-14T20:00:00Z")).then(o => JSON.stringify(o))'));
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /123456789/, 'no full account number anywhere');
  assert.doesNotMatch(text, /HASH1/, 'no account hash either');
  assert.equal(out.reads.orders_59d.data[0].accountNumber, '••6789');
  assert.equal(out.reads.positions.data.accountNumber, '••6789');
  assert.equal(out.account, '••6789');
  assert.equal(out.summary.orders_59d, '2 rows, 2026-09-01 to 2026-10-10');
  assert.equal(out.summary.transactions_30d, '1 rows, 2026-08-20 to 2026-08-20');
  assert.match(out.summary.transactions_365d, /^failed \(400\): Date range is too long/);
  assert.equal(out.reads.transactions_365d.ok, false);
  assert.ok(net.calls.some(u => /transactions\?.*types=TRADE/.test(u)), 'trade transactions only');
});

test('the button downloads the file once, and needs a Schwab login', async () => {
  const net = schwab();
  const { run, elements } = await app({ fetch: net.fetch, storage: connected() });
  run('globalThis.saved = []; downloadText = (name, text) => globalThis.saved.push({ name, text })');
  await run('downloadSchwabHistory()');
  const saved = run('globalThis.saved');
  assert.equal(saved.length, 1);
  assert.match(saved[0].name, /^schwab-history-\d{4}-\d{2}-\d{2}\.json$/);
  assert.doesNotMatch(saved[0].text, /123456789/);
  assert.match(elements.get('errorBox').textContent, /not your account number/);
  assert.equal(elements.get('schwabHistoryBtn').disabled, false);

  const out = await app({ storage: new Map() });
  await out.run('downloadSchwabHistory()');
  assert.match(out.elements.get('errorBox').textContent, /Log in to Schwab first/);
});

test('masking reaches nested account fields and leaves everything else alone', async () => {
  const { run } = await app();
  const out = JSON.parse(run(`JSON.stringify(scrubAccounts({ a: [{ accountNumber: '99887766', price: 1 }], b: { hashValue: 'abcdef12', note: 'x' }, accountNumber: 12 }))`));
  assert.deepEqual(out, { a: [{ accountNumber: '••7766', price: 1 }], b: { hashValue: '••ef12', note: 'x' }, accountNumber: '••' });
});
