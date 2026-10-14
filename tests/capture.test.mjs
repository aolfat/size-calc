// Run with: node --test
// Raw capture: Schwab's orders and TRADE transactions kept whole in Supabase's schwab_records, account numbers masked,
// a year of transactions the first time (59 days if Schwab refuses), a week of overlap after that, at most every 6 hours.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 86400000;
const NOW = Date.parse('2026-10-14T20:00:00Z');
const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const connected = (extra = []) => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }])],
  ['schwab_account', 'HASH1'],
  ...extra,
]);

const ORDERS = [
  { orderId: 101, accountNumber: 123456789, enteredTime: '2026-10-01T14:31:00+0000', status: 'FILLED', childOrderStrategies: [{ orderId: 102, status: 'WORKING' }] },
  { orderId: 103, accountNumber: 123456789, enteredTime: '2026-10-10T15:00:00+0000', status: 'CANCELED' },
];
const TX = [
  { activityId: 9001, accountNumber: '123456789', time: '2026-10-01T14:31:05+0000', type: 'TRADE' },
  { accountNumber: '123456789', type: 'TRADE' }, // no id: counted, not kept
];

// a fake Schwab (refusing transaction ranges over maxDays) and a fake Supabase that keeps upserted rows
function world({ maxDays = 400 } = {}) {
  const ranges = [];
  const fetch = async url => {
    const u = new URL(String(url));
    const path = u.pathname.replace('/trader/v1', '');
    if (path === '/accounts/HASH1/orders') return json(ORDERS);
    if (path === '/accounts/HASH1/transactions') {
      const from = Date.parse(u.searchParams.get('startDate')), to = Date.parse(u.searchParams.get('endDate'));
      ranges.push(Math.round((to - from) / DAY));
      return (to - from) / DAY > maxDays ? json({ message: 'range too long' }, 400) : json(TX);
    }
    return json({}, 404);
  };
  const saved = [];
  let fail = false;
  const supabase = {
    from: table => ({ upsert: async rows => { if (fail) return { error: { message: 'nope' }, status: 500 }; saved.push(...rows.map(r => ({ table, ...r }))); return { error: null }; } }),
    failNext() { fail = true; },
  };
  return { fetch, supabase, saved, ranges };
}

test('a capture keeps every order and transaction whole, with account numbers masked', async () => {
  const w = world();
  const { run, storage } = await app({ fetch: w.fetch, storage: connected(), supabase: w.supabase, session: SESSION });
  const r = await run(`captureSchwab(${NOW})`);
  assert.equal(r.orders, 2);
  assert.equal(r.transactions, 2);
  assert.equal(r.skipped, 1, 'a transaction without an id is counted, not kept');
  assert.deepEqual(w.saved.map(x => [x.table, x.kind, x.record_id]), [['schwab_records', 'order', '101'], ['schwab_records', 'order', '103'], ['schwab_records', 'transaction', '9001']]);
  assert.ok(w.saved.every(x => x.user_id === 'user-1' && x.account === '6789'));
  assert.equal(w.saved[0].entered_at, '2026-10-01T14:31:00.000Z');
  assert.equal(w.saved[0].data.childOrderStrategies[0].orderId, 102, 'child orders stay inside their parent');
  assert.doesNotMatch(JSON.stringify(w.saved), /123456789/);
  assert.equal(JSON.parse(storage.get('schwab_capture')).at, NOW);
  assert.deepEqual(w.ranges, [365], 'the first capture asks for a year');
});

test("a year refused falls back to 59 days, and later captures overlap the last by a week", async () => {
  const w = world({ maxDays: 60 });
  const { run } = await app({ fetch: w.fetch, storage: connected(), supabase: w.supabase, session: SESSION });
  await run(`captureSchwab(${NOW})`);
  assert.deepEqual(w.ranges, [365, 59]);
  await run(`captureSchwab(${NOW + 2 * DAY})`);
  assert.deepEqual(w.ranges.slice(2), [9], 'two days since the last capture plus a week of overlap');
});

test('nothing is kept without both logins, and a failed save keeps the last good capture', async () => {
  const w = world();
  const out = await app({ fetch: w.fetch, storage: connected(), supabase: w.supabase });
  await assert.rejects(out.run(`captureSchwab(${NOW})`), /Sign in with Google/);
  const noSchwab = await app({ storage: new Map(), supabase: w.supabase, session: SESSION });
  await assert.rejects(noSchwab.run(`captureSchwab(${NOW})`), /Log in to Schwab/);

  const ok = await app({ fetch: w.fetch, storage: connected(), supabase: w.supabase, session: SESSION });
  await ok.run(`captureSchwab(${NOW})`);
  w.supabase.failNext();
  await assert.rejects(ok.run(`captureSchwab(${NOW + DAY})`), /nope/);
  assert.equal(JSON.parse(ok.storage.get('schwab_capture')).at, NOW);
});

test('the automatic save runs only when due, and quietly; Save now runs any time', async () => {
  const w = world();
  const { run, elements } = await app({ fetch: w.fetch, storage: connected(), supabase: w.supabase, session: SESSION });
  await run('maybeCapture()');
  assert.equal(w.saved.length, 3);
  assert.equal(elements.get('errorBox').textContent, '', 'quiet: no toast');
  await run('maybeCapture()');
  assert.equal(w.saved.length, 3, 'not due again for 6 hours');
  await run('captureNow()');
  assert.equal(w.saved.length, 6, 'Save now runs any time');
  assert.match(elements.get('errorBox').textContent, /Saved 2 orders and 2 trades/);

  const other = await app({ fetch: w.fetch, storage: connected([['schwab_capture', JSON.stringify({ at: Date.now(), user: 'someone-else', account: '6789', orders: 1, transactions: 1 })]]), supabase: w.supabase, session: SESSION });
  assert.equal(other.run('captureDue()'), true, "another Google user's capture doesn't count");
});

test('the rows builder keeps ids as text and times as ISO', async () => {
  const { run } = await app();
  const out = JSON.parse(run(`JSON.stringify(captureRows({ orders: [{ orderId: 5, enteredTime: '2026-09-01T14:00:00+0000' }], transactions: [{ activityId: 7, tradeDate: 'not a date' }], last4: '6789', userId: 'u' }))`));
  assert.deepEqual(out.rows.map(r => [r.kind, r.record_id, r.entered_at]), [['order', '5', '2026-09-01T14:00:00.000Z'], ['transaction', '7', null]]);
  assert.equal(run(`transactionStart(${NOW})`), NOW - 365 * DAY);
  assert.equal(run(`transactionStart(${NOW}, ${NOW - DAY})`), NOW - 8 * DAY);
});
