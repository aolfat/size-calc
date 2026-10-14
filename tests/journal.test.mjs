// Run with: node --test
// The Journal tab: its place in the header, what it shows signed out / not connected / with kept records, Import, and
// the fills read out of saved Schwab orders (execution legs, child orders included).
import test from 'node:test';
import assert from 'node:assert/strict';
import { app, html } from './helpers/app.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 86400000;
const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const connected = () => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }])],
  ['schwab_account', 'HASH1'],
]);

// a market buy of 100 AAPL that triggered a stop, which later filled at 95; and a call bought in two fills
const ENTRY = {
  orderId: 501, enteredTime: '2026-10-01T14:30:00+0000', status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction: 'BUY', quantity: 100, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7001, executionLegs: [{ legId: 1, quantity: 100, price: 100.02, time: '2026-10-01T14:30:01+0000' }] }],
  childOrderStrategies: [{
    orderId: 502, status: 'FILLED', orderType: 'STOP', stopPrice: 95,
    orderLegCollection: [{ legId: 1, instruction: 'SELL', quantity: 100, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7002, executionLegs: [{ legId: 1, quantity: 100, price: 94.98, time: '2026-10-03T15:00:00+0000' }] }],
  }],
};
const CALL = {
  orderId: 601, enteredTime: '2026-10-06T14:00:00+0000', status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction: 'BUY_TO_OPEN', quantity: 3, instrument: { symbol: 'AAPL  261218C00245000', assetType: 'OPTION' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7101, executionLegs: [{ legId: 1, quantity: 2, price: 4.1, time: '2026-10-06T14:00:02+0000' }, { legId: 1, quantity: 1, price: 4.15, time: '2026-10-06T14:00:09+0000' }] }],
};
const CANCELED = { orderId: 701, enteredTime: '2026-10-07T14:00:00+0000', status: 'CANCELED', orderLegCollection: [{ legId: 1, instruction: 'SELL', quantity: 10, instrument: { symbol: 'MSFT', assetType: 'EQUITY' } }] };
const RECORDS = [
  { kind: 'order', record_id: '701', entered_at: '2026-10-07T14:00:00Z', data: CANCELED },
  { kind: 'order', record_id: '601', entered_at: '2026-10-06T14:00:00Z', data: CALL },
  { kind: 'order', record_id: '501', entered_at: '2026-10-01T14:30:00Z', data: ENTRY },
  { kind: 'transaction', record_id: '9001', entered_at: '2026-09-15T15:00:00Z', data: { activityId: 9001, type: 'TRADE' } },
];

// a fake Supabase: reads return the kept records (newest first); upserts are kept too
function fakeSupabase(records = RECORDS) {
  const reads = [];
  const upserts = [];
  return {
    reads, upserts,
    from: table => ({
      select: cols => {
        reads.push({ table, cols });
        const q = { order: () => q, limit: () => q, then: (res, rej) => Promise.resolve({ data: records.map(r => ({ ...r })), error: null }).then(res, rej) };
        return q;
      },
      upsert: async rows => { upserts.push(...rows); return { error: null }; },
    }),
  };
}

const shown = el => el.style.display !== 'none';
// let pending reads and saves (fake network, fake Supabase) finish
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };

test('Journal is a header tab between Positions and Tools, with an icon for the phone bar and the j key', async () => {
  const nav = html.match(/<nav class="brand-tabs"[\s\S]*?<\/nav>/)[0];
  const order = ['brandMarket', 'brandSize', 'brandPositions', 'brandJournal', 'brandTools'].map(id => nav.indexOf(`id="${id}"`));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), 'Market / Size / Positions / Journal / Tools');
  assert.match(nav.match(/<button[^>]*id="brandJournal"[\s\S]*?<\/button>/)[0], /<svg class="tab-icon"/);

  const { run, elements, dispatch } = await app();
  run("setView('journal')");
  assert.ok(shown(elements.get('journalSection')));
  assert.ok(!shown(elements.get('modeCard')) && !shown(elements.get('riskStrip')), 'sizing surfaces hide');
  assert.equal(elements.get('brandJournal').getAttribute('aria-current'), 'page');
  assert.equal(elements.get('viewTitle').textContent, 'Journal');
  run("setView('calc')");
  assert.ok(!shown(elements.get('journalSection')));
  run('initShortcuts()');
  dispatch('keydown', { key: 'j', target: {}, preventDefault() {} });
  assert.equal(run('journalView'), true, 'j opens it');
});

test('signed out, the Journal asks you to sign in', async () => {
  const { run, elements } = await app();
  run("setView('journal')");
  assert.match(elements.get('journalSection').innerHTML, /Sign in to keep your journal/);
});

test('signed in, it shows what is kept and the fills inside your orders, newest first', async () => {
  const supabase = fakeSupabase();
  const { run, elements } = await app({ storage: connected(), supabase, session: SESSION });
  run("setView('journal')");
  await run('loadJournal()');
  assert.deepEqual(supabase.reads[0], { table: 'schwab_records', cols: 'kind,record_id,entered_at,data' });
  const out = elements.get('journalSection').innerHTML;
  assert.match(out, /3 orders and 1 trades kept · Sep 15, 2026 to Oct 7, 2026/);
  const rows = [...out.matchAll(/<tr>\s*<td><b>([^<]*)<\/b><\/td>\s*<td>[^<]*<\/td>\s*<td class="journal-(buy|sell)">([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/g)].map(m => m.slice(1));
  assert.deepEqual(rows, [
    ['AAPL 12/18/26 245C', 'buy', 'Buy to open', '1', '$4.15', '$415.00'],
    ['AAPL 12/18/26 245C', 'buy', 'Buy to open', '2', '$4.10', '$820.00'],
    ['AAPL', 'sell', 'Sell', '100', '$94.98', '$9,498.00'],
    ['AAPL', 'buy', 'Buy', '100', '$100.02', '$10,002.00'],
  ], 'a canceled order has no fills; the stop that filled is its own fill');
  assert.match(out, /4 fills\. Fills are read from your saved Schwab orders/);
  assert.match(out, /data-action="journalImport"(?! disabled)[^>]*>Import</);
});

test('not connected to Schwab, Import waits and the Journal says where to connect', async () => {
  const { run, elements } = await app({ supabase: fakeSupabase([]), session: SESSION });
  run("setView('journal')");
  await run('loadJournal()');
  const out = elements.get('journalSection').innerHTML;
  assert.match(out, /id="journalImportBtn" data-action="journalImport" disabled/);
  assert.match(out, /Connect Schwab to import/);
  assert.match(out, /Nothing kept yet/);
  assert.match(out, /Import saves your last 60 days of Schwab orders and up to a year of trades/);
});

test('Import saves the latest from Schwab, then reads the kept records again', async () => {
  const supabase = fakeSupabase();
  const fetch = async url => {
    const path = new URL(String(url)).pathname.replace('/trader/v1', '');
    if (path === '/accounts/HASH1/orders') return json([ENTRY]);
    if (path === '/accounts/HASH1/transactions') return json([]);
    return json({}, 404);
  };
  const { run, elements } = await app({ fetch, storage: connected(), supabase, session: SESSION });
  run("setView('journal')");
  await settle();
  assert.deepEqual(supabase.upserts.map(r => r.record_id), ['501'], 'opening the tab imports on its own when due');
  assert.equal(elements.get('errorBox').textContent, '', 'quietly');
  const before = supabase.reads.length;
  await run('journalImport()');
  await settle();
  assert.deepEqual(supabase.upserts.map(r => r.record_id), ['501', '501'], 'Import saves again any time');
  assert.ok(supabase.reads.length > before, 'the list is read again after the save');
  assert.match(elements.get('errorBox').textContent, /Saved 1 orders and 0 trades/);
  assert.match(elements.get('journalSection').innerHTML, /Last import .*: 1 orders, 0 trades/);
});

test('fills: matched to their order leg, zero quantities skipped, words for every instruction', async () => {
  const { run } = await app();
  const fills = JSON.parse(run(`JSON.stringify(orderFills({ orderId: 1, enteredTime: '2026-10-01T14:30:00+0000',
    orderLegCollection: [{ legId: 1, instruction: 'SELL_SHORT', instrument: { symbol: 'TSLA', assetType: 'EQUITY' } }, { legId: 2, instruction: 'BUY_TO_COVER', instrument: { symbol: 'NVDA', assetType: 'EQUITY' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', executionLegs: [{ legId: 2, quantity: 5, price: 10 }, { legId: 1, quantity: 0, price: 9 }] }, { activityType: 'ORDER_ACTION', executionLegs: [{ legId: 1, quantity: 9, price: 9 }] }] }))`));
  assert.deepEqual(fills.map(f => [f.symbol, f.side, f.qty, f.time]), [['NVDA', 'buy', 5, '2026-10-01T14:30:00.000Z']], 'no execution time: the order time');
  assert.equal(run("instructionWords('SELL_SHORT')"), 'Sell short');
  assert.equal(run("instructionWords('BUY_TO_COVER')"), 'Buy to cover');
});
