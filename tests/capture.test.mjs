// Run with: node --test
// Raw capture: Schwab's orders and TRADE transactions kept whole in Supabase's schwab_records, account numbers masked,
// a year of transactions the first time (59 days if Schwab refuses), a week of overlap after that, at most every 6 hours.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

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

// a fake Schwab (refusing transaction ranges over maxDays) and a fake Supabase table
function world({ maxDays = 400, orders = ORDERS, tx = TX } = {}) {
  const ranges = [];
  const fetch = async url => {
    const u = new URL(String(url));
    const path = u.pathname.replace('/trader/v1', '');
    if (path === '/accounts/HASH1/orders') return json(w.orders);
    if (path === '/accounts/HASH1/transactions') {
      const from = Date.parse(u.searchParams.get('startDate')), to = Date.parse(u.searchParams.get('endDate'));
      ranges.push(Math.round((to - from) / DAY));
      return (to - from) / DAY > maxDays ? json({ message: 'range too long' }, 400) : json(w.tx);
    }
    return json({}, 404);
  };
  const supabase = fakeRecords();
  const w = { fetch, supabase, ranges, orders, tx, get saved() { return supabase.writes; } };
  return w;
}

test('a capture keeps every order and transaction whole, with account numbers masked', async () => {
  const w = world();
  const { run, storage } = await app({ fetch: w.fetch, storage: connected(), supabase: w.supabase, session: SESSION });
  const r = await run(`captureSchwab(${NOW})`);
  assert.equal(r.orders, 2);
  assert.equal(r.transactions, 2);
  assert.equal(r.skipped, 1, 'a transaction without an id is counted, not kept');
  assert.deepEqual(w.saved.map(x => [x.table, x.kind, x.record_id]), [['schwab_records', 'order', '101'], ['schwab_records', 'order', '103'], ['schwab_records', 'transaction', '9001']]);
  assert.ok(w.saved.every(x => /^[0-9a-f]{64}$/.test(x.fingerprint)), 'every row carries its fingerprint');
  assert.equal(w.saved.find(x => x.kind === 'transaction').ignoreDuplicates, true, 'a trade is never overwritten');
  assert.deepEqual([r.newOrders, r.updatedOrders, r.newTrades, r.kept], [2, 0, 1, 0]);
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
  w.supabase.fail();
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
  assert.equal(w.saved.length, 3, 'Save now runs any time, and sends nothing that is already kept');
  assert.match(elements.get('errorBox').textContent, /^Nothing new, 3 already kept\.$/, 'the same records again are not news');

  const other = await app({ fetch: w.fetch, storage: connected([['schwab_capture', JSON.stringify({ at: Date.now(), user: 'someone-else', account: '6789', orders: 1, transactions: 1 })]]), supabase: w.supabase, session: SESSION });
  assert.equal(other.run('captureDue()'), true, "another Google user's capture doesn't count");
});

test('a new import sends only what changed: new trades, new orders, and orders whose copy changed', async () => {
  const w = world();
  const { run, elements } = await app({ fetch: w.fetch, storage: connected(), supabase: w.supabase, session: SESSION });
  await run(`captureSchwab(${NOW})`);
  const first = w.saved.length;
  // the next day: order 103 got canceled (its copy changed), a new order and a new trade came in, the rest is the same
  w.orders = [ORDERS[0], { ...ORDERS[1], status: 'CANCELED', closeTime: '2026-10-11T15:00:00+0000' }, { orderId: 104, enteredTime: '2026-10-12T14:00:00+0000', status: 'FILLED' }];
  w.tx = [...TX, { activityId: 9002, time: '2026-10-12T14:00:05+0000', type: 'TRADE' }];
  const r = await run(`captureSchwab(${NOW + DAY})`);
  const sent = w.saved.slice(first).map(x => `${x.kind}:${x.record_id}`);
  assert.deepEqual(sent.sort(), ['order:103', 'order:104', 'transaction:9002']);
  assert.deepEqual([r.newOrders, r.updatedOrders, r.newTrades, r.kept], [1, 1, 1, 2]);
  assert.equal(w.supabase.table.get('user-1:order:103').data.status, 'CANCELED', 'the newer copy replaced the kept one');
  assert.equal(run('importWords(lastCapture())'), '1 new trade, 1 new order, 1 order updated, 2 already kept');

  run("setView('journal')");
  assert.match(elements.get('journalSection').innerHTML, /Last import .*: 1 new trade, 1 new order, 1 order updated, 2 already kept/);
});

test('a key-order change is not a change, and a row kept before fingerprints is filled in quietly', async () => {
  const w = world();
  const { run } = await app({ fetch: w.fetch, storage: connected(), supabase: w.supabase, session: SESSION });
  await run(`captureSchwab(${NOW})`);
  const first = w.saved.length;
  w.orders = ORDERS.map(o => Object.fromEntries(Object.entries(o).reverse())); // same orders, keys in another order
  w.supabase.table.get('user-1:order:101').fingerprint = null; // saved before fingerprints existed
  const r = await run(`captureSchwab(${NOW + DAY})`);
  assert.deepEqual(w.saved.slice(first).map(x => x.record_id), ['101'], 'only the row missing its fingerprint is rewritten');
  assert.deepEqual([r.newOrders, r.updatedOrders, r.newTrades, r.kept], [0, 0, 0, 3]);
  assert.match(w.supabase.table.get('user-1:order:101').fingerprint, /^[0-9a-f]{64}$/);
});

test('import words: what is new first, then what was already kept', async () => {
  const { run } = await app();
  assert.equal(run('importWords({ newTrades: 3, updatedOrders: 2, kept: 71 })'), '3 new trades, 2 orders updated, 71 already kept');
  assert.equal(run('importWords({ newOrders: 1, kept: 0 })'), '1 new order, 0 already kept');
  assert.equal(run('importWords({ kept: 77 })'), 'Nothing new, 77 already kept');
});

test('the rows builder keeps ids as text and times as ISO', async () => {
  const { run } = await app();
  const out = JSON.parse(run(`JSON.stringify(captureRows({ orders: [{ orderId: 5, enteredTime: '2026-09-01T14:00:00+0000' }], transactions: [{ activityId: 7, tradeDate: 'not a date' }], last4: '6789', userId: 'u' }))`));
  assert.deepEqual(out.rows.map(r => [r.kind, r.record_id, r.entered_at]), [['order', '5', '2026-09-01T14:00:00.000Z'], ['transaction', '7', null]]);
  assert.equal(run(`transactionStart(${NOW})`), NOW - 365 * DAY);
  assert.equal(run(`transactionStart(${NOW}, ${NOW - DAY})`), NOW - 8 * DAY);
});
