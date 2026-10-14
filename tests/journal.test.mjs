// Run with: node --test
// The Journal tab: its place in the header, what it shows signed out / not connected / with kept records, Import, and
// the fills read out of saved Schwab orders (execution legs, child orders included).
import test from 'node:test';
import assert from 'node:assert/strict';
import { app, html } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

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

// a fake Supabase table holding the kept records
const fakeSupabase = (records = RECORDS) => fakeRecords(records);

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
  assert.ok(supabase.reads.some(r => r.cols === 'kind,record_id,account,entered_at,data'), 'the list reads the kept records');
  run("setJournalTab('fills')");
  const out = elements.get('journalSection').innerHTML;
  assert.match(out, /3 orders and 1 trades kept · Sep 15, 2026 to Oct 7, 2026/);
  const rows = [...out.matchAll(/<tr>\s*<td><b>([^<]*)<\/b><\/td>\s*<td class="journal-(buy|sell)">([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/g)].map(m => m.slice(1, 7));
  assert.deepEqual(rows, [
    ['AAPL 12/18/26 245C', 'buy', 'Buy to open', '1', '$4.15', '$415.00'],
    ['AAPL 12/18/26 245C', 'buy', 'Buy to open', '2', '$4.10', '$820.00'],
    ['AAPL', 'sell', 'Sell', '100', '$94.98', '$9,498.00'],
    ['AAPL', 'buy', 'Buy', '100', '$100.02', '$10,002.00'],
  ], 'a canceled order has no fills; the stop that filled is its own fill');
  assert.match(out, /4 fills\. Fills are read from your saved Schwab orders/);
  assert.match(out, /<td>10\/3, 11:00 AM<\/td>/, 'times in New York, whatever the device zone');
  assert.match(out, /Time \(ET\)/);
  assert.match(out, /data-action="openJournalImport"[^>]*>Import</, 'Import and Export sit in the header');
  assert.match(out, /data-action="openJournalExport"[^>]*>Export</);
  assert.doesNotMatch(out, /schwabHistoryBtn/, 'the history file is in Export, not the card');
  assert.doesNotMatch(html.match(/id="settingsSheet"[\s\S]*?id="tradeSheet"/)[0], /schwabHistoryBtn/, 'and not in Settings');
});

test('Trades is the default view: fills grouped into trades, with P&L, R, hold time, and a summary', async () => {
  const records = RECORDS.map(r => ({ ...r, account: '6789' }));
  const { run, elements } = await app({ storage: connected(), supabase: fakeSupabase(records), session: SESSION });
  run("setView('journal')");
  await run('loadJournal()');
  const out = elements.get('journalSection').innerHTML;
  assert.match(out, /data-action="setJournalTab" data-arg="trades">Trades/);
  assert.match(out, /class="active" aria-pressed="true" data-action="setJournalTab" data-arg="trades"/, 'Trades is on by default');
  assert.match(out, /1 closed · 0 won \(0%\) · <span class="journal-sell">−\$504\.00<\/span> before fees · average −1\.00R over 1 · 1 open/);
  const rows = [...out.matchAll(/<tr( class="journal-open")?>\s*<td><b>([^<]*)<\/b>/g)].map(m => [m[2], !!m[1]]);
  assert.deepEqual(rows, [['AAPL 12/18/26 245C', true], ['AAPL', false]], 'the open call first (newest), then the stopped-out stock');
  assert.match(out, /<th scope="col">Symbol<\/th><th scope="col">P&amp;L<\/th><th scope="col">R<\/th>/, 'P&L and R lead, so phones see them before scrolling');
  assert.match(out, /<td><b>AAPL<\/b><span class="pos-sub"><button class="pos-link" data-action="openTradeReview" data-arg="6789\|AAPL\|long\|2026-10-01T14:30:01\.000Z"[^>]*>Edit<\/button><\/span><\/td>\s*<td class="journal-sell">−\$504\.00<\/td>\s*<td title="Initial stop \$95\.00, risk \$502\.00">−1\.00R<\/td>\s*<td><button class="pos-link" data-action="openTradeReview"[^>]*>\$95\.00<\/button><\/td>\s*<td class="journal-buy">Long<\/td>/);
  assert.match(out, /<th scope="col">R<\/th><th scope="col">Stop<\/th>/);
  assert.match(out, /aria-label="Set a stop for AAPL 12\/18\/26 245C">Set<\/button><span class="pos-sub">premium<\/span>/, 'the call has no stop: Set, and the premium is its risk');
  assert.match(out, /<td>2d 0h<\/td>/);
  assert.match(out, /P&amp;L is before fees/);
});

test('filters: side and symbol narrow the trades, and Fills shows the raw fills', async () => {
  const records = RECORDS.map(r => ({ ...r, account: '6789' }));
  const { run, elements } = await app({ storage: connected(), supabase: fakeSupabase(records), session: SESSION });
  run("setView('journal')");
  await run('loadJournal()');
  run("setJournalSide('short')");
  assert.match(elements.get('journalSection').innerHTML, /No trades match/);
  run("setJournalSide('all'); document.getElementById('journalSymbol').value = '245c'; journalSymbolChanged()");
  const out = elements.get('journalSection').innerHTML;
  assert.match(out, /AAPL 12\/18\/26 245C/);
  assert.doesNotMatch(out, /<td><b>AAPL<\/b>/, 'the stock trade is filtered out');
  run("document.getElementById('journalSymbol').value = ''; journalSymbolChanged(); setJournalTab('fills')");
  assert.match(elements.get('journalSection').innerHTML, /4 fills\. Fills are read from your saved Schwab orders/);
});

test('Import lists the sources: Schwab with its last import and Import now, file upload coming', async () => {
  const supabase = fakeSupabase();
  const storage = connected();
  storage.set('schwab_capture', JSON.stringify({ at: Date.now(), user: 'user-1', account: '6789', orders: 46, transactions: 31 }));
  const { run, elements, state } = await app({ storage, supabase, session: SESSION });
  run("setView('journal'); openJournalImport()");
  assert.equal(state.openSheetName, 'journalImport');
  assert.ok(shown(elements.get('journalImportSheet')));
  const body = elements.get('journalImportBody').innerHTML;
  assert.match(body, /Schwab <span class="sheet-status">.*Connected · ••6789/);
  assert.match(body, /Last import .*: 46 orders, 31 trades/);
  assert.match(body, /data-action="journalImport"[^>]*>Import now</);
  assert.match(body, /File upload <span class="sheet-status">Coming soon/);

  const off = await app({ supabase: fakeSupabase([]), session: SESSION });
  off.run("setView('journal'); openJournalImport()");
  const offBody = off.elements.get('journalImportBody').innerHTML;
  assert.match(offBody, /○ Not connected/);
  assert.match(offBody, /data-action="openSheet" data-arg="settings">Connect Schwab</);
  assert.doesNotMatch(offBody, /Import now/);
});

test('Export offers the Schwab history file when connected, and trades as CSV later', async () => {
  const { run, elements, state } = await app({ storage: connected(), supabase: fakeSupabase(), session: SESSION });
  run('openJournalExport()');
  assert.equal(state.openSheetName, 'journalExport');
  const body = elements.get('journalExportBody').innerHTML;
  assert.match(body, /id="schwabHistoryBtn" data-action="downloadSchwabHistory"[^>]*>Download Schwab history</);
  assert.match(body, /Trades \(CSV\) <span class="sheet-status">Coming soon/);

  const off = await app({ supabase: fakeSupabase([]), session: SESSION });
  off.run('openJournalExport()');
  assert.doesNotMatch(off.elements.get('journalExportBody').innerHTML, /schwabHistoryBtn/, 'no download without a Schwab login');
});

test('with nothing kept, the Journal says so and how Import fills it', async () => {
  const { run, elements } = await app({ supabase: fakeSupabase([]), session: SESSION });
  run("setView('journal')");
  await run('loadJournal()');
  const out = elements.get('journalSection').innerHTML;
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
  assert.deepEqual(supabase.writes.map(r => r.record_id), ['501'], 'opening the tab imports on its own when due: 501 was kept without a fingerprint, so it gets one');
  assert.equal(elements.get('errorBox').textContent, '', 'quietly');
  const before = supabase.reads.length;
  await run('journalImport()');
  await settle();
  assert.deepEqual(supabase.writes.map(r => r.record_id), ['501'], 'Import again sends nothing already kept');
  assert.ok(supabase.reads.length > before, 'the list is read again after the save');
  assert.match(elements.get('errorBox').textContent, /^Nothing new, 1 already kept\.$/);
  assert.match(elements.get('journalSection').innerHTML, /Last import .*: Nothing new, 1 already kept/);
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

// ---------- your stop and hidden trades (trade_reviews) ----------

const STOCK = '6789|AAPL|long|2026-10-01T14:30:01.000Z';
const OPTION = '6789|AAPL  261218C00245000|long|2026-10-06T14:00:02.000Z';
async function journalWith(reviews = [], tweak) {
  const supabase = fakeRecords(RECORDS.map(r => ({ ...r, account: '6789' })), reviews);
  if (tweak) tweak(supabase);
  const a = await app({ storage: connected(), supabase, session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  return { ...a, supabase, out: () => a.elements.get('journalSection').innerHTML, sheet: () => a.elements.get('tradeReviewBody').innerHTML };
}

test('your stop: set it from the trade sheet, R counts from it, and Schwab\'s is one tap back', async () => {
  const { run, state, supabase, out, sheet, elements } = await journalWith();
  assert.ok(supabase.reads.some(r => r.table === 'trade_reviews' && r.cols === 'trade_key,stop,hidden'), 'your reviews are read with the records');
  run(`openTradeReview('${STOCK}')`);
  assert.equal(state.openSheetName, 'tradeReview');
  assert.equal(elements.get('tradeReviewTitle').textContent, 'AAPL');
  assert.match(sheet(), /Using Schwab's first stop, \$95\.00 \(10\/1, 10:30 AM\)\. Risk \$502\.00\./);
  assert.match(sheet(), /data-action="pickTradeStop" data-arg="95">\$95\.00/, 'Schwab\'s stops are listed to pick');

  run("document.getElementById('tradeStopInput').value = '101'; tradeStopPreview()");
  assert.equal(elements.get('tradeStopPreview').textContent, "A long's stop goes below the entry.");
  assert.equal(elements.get('tradeStopSave').disabled, true);
  run("document.getElementById('tradeStopInput').value = '97.5'; tradeStopPreview()");
  assert.equal(elements.get('tradeStopPreview').textContent, 'Risk $252.00 · −2.00R');
  assert.equal(elements.get('tradeStopSave').disabled, false);

  await run('saveTradeStop()');
  const w = supabase.writes.filter(x => x.table === 'trade_reviews');
  assert.deepEqual(w.map(x => [x.trade_key, x.stop, x.hidden, x.onConflict]), [[STOCK, 97.5, false, 'user_id,trade_key']]);
  assert.equal(state.openSheetName, null, 'saved: the sheet closes');
  assert.match(elements.get('errorBox').textContent, /Stop saved: R counts from \$97\.50\./);
  assert.match(out(), /title="Your stop \$97\.50, risk \$252\.00">−2\.00R<\/td>\s*<td><button[^>]*>\$97\.50<\/button><span class="pos-sub">yours<\/span>/);

  run(`openTradeReview('${STOCK}')`);
  assert.match(sheet(), /Using your stop, \$97\.50\. Risk \$252\.00\. Schwab's first was \$95\.00\./);
  await run('clearTradeStop()');
  assert.equal(supabase.reviewRows()[0].stop, null);
  assert.equal(supabase.reviewRows()[0].hidden, false, 'clearing the stop keeps the rest of the row');
  assert.match(out(), /title="Initial stop \$95\.00, risk \$502\.00">−1\.00R/);
});

test('an option\'s mental stop is a price on the option, and replaces the premium as its risk', async () => {
  const { run, sheet, out } = await journalWith();
  run(`openTradeReview('${OPTION}')`);
  assert.match(sheet(), /No stop: the premium paid, \$1,235\.00, is the risk/);
  assert.match(sheet(), /For an option, the stop is a price on the option itself/);
  run("document.getElementById('tradeStopInput').value = '2.5'; tradeStopPreview()");
  assert.match(run("document.getElementById('tradeStopPreview').textContent"), /Risk \$485\.00, R once it closes/, '(4.1167 − 2.50) × 3 × 100, and it\'s still open');
  await run('saveTradeStop()');
  assert.match(out(), /\$2\.50<\/button><span class="pos-sub">yours<\/span>/);
});

test('hide a trade that doesn\'t belong: out of the list and the stats, and back with Show', async () => {
  const { run, supabase, out, sheet } = await journalWith();
  run(`openTradeReview('${STOCK}')`);
  assert.match(sheet(), /data-action="hideTrade"[^>]*>Hide this trade/);
  await run('hideTrade()');
  assert.deepEqual(supabase.reviewRows().map(r => [r.trade_key, r.hidden, r.stop]), [[STOCK, true, null]]);
  assert.doesNotMatch(out(), /<td><b>AAPL<\/b>/, 'gone from the list');
  assert.match(out(), /0 closed · 1 open · 1 hidden <button class="pos-link" data-action="toggleHiddenTrades">Show<\/button>/, 'and from the stats');
  run('toggleHiddenTrades()');
  assert.match(out(), /<tr class="journal-hidden">\s*<td><b>AAPL<\/b> <span class="journal-tag">hidden<\/span>/, 'shown dimmed to bring it back');
  assert.match(out(), /0 closed · 1 open · 1 hidden/, 'still not counted');
  run(`openTradeReview('${STOCK}')`);
  await run('unhideTrade()');
  assert.equal(supabase.reviewRows()[0].hidden, false);
  assert.match(out(), /1 closed · 0 won/);
});

test('reviews read when the journal opens; a refused save goes back; a missing table still shows the trades', async () => {
  const kept = await journalWith([{ trade_key: STOCK, stop: '97.5', hidden: false }, { trade_key: OPTION, stop: null, hidden: true }]);
  assert.match(kept.out(), /\$97\.50<\/button><span class="pos-sub">yours<\/span>/, 'Postgres numerics arrive as text');
  assert.match(kept.out(), /1 hidden/);

  kept.run(`openTradeReview('${STOCK}')`);
  kept.supabase.fail({ status: 500, message: 'nope' });
  await kept.run('hideTrade()');
  assert.match(kept.sheet(), /Couldn't save: nope/);
  assert.equal(kept.state.openSheetName, 'tradeReview', 'the sheet stays open');
  assert.match(kept.out(), /<td><b>AAPL<\/b>/, 'and the trade comes back');

  const missing = await journalWith([], s => s.failTable('trade_reviews'));
  assert.match(missing.out(), /Your stops and hidden trades couldn't load \(the database doesn(?:'|&#39;)t have the trade_reviews table yet\)\. Trades show with Schwab's stops\./);
  assert.match(missing.out(), /−1\.00R/, 'the trades still show');
  missing.run(`openTradeReview('${STOCK}')`);
  assert.match(missing.sheet(), /saving is off until they do/);
  await missing.run('hideTrade()');
  assert.equal(missing.supabase.writes.filter(x => x.table === 'trade_reviews').length, 0, 'nothing written over a row it couldn\'t read');
});
