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
  const rows = [...out.matchAll(/<tr( class="journal-open")? data-action="openTradeRow" data-arg="[^"]*">\s*<td><div class="journal-sym"><label class="journal-pick">[\s\S]*?<\/label><div class="journal-sym-main"><button class="journal-name"[^>]*><b>([^<]*)<\/b>/g)].map(m => [m[2], !!m[1]]);
  assert.deepEqual(rows, [['AAPL 12/18/26 245C', true], ['AAPL', false]], 'the open call first (newest), then the stopped-out stock');
  assert.match(out, /<th scope="col">Symbol<\/th><th scope="col">P&amp;L<\/th><th scope="col">R<\/th>/, 'P&L and R lead, so phones see them before scrolling');
  assert.match(out, /<tr data-action="openTradeRow" data-arg="6789\|AAPL\|long\|2026-10-01T14:30:01\.000Z">\s*<td><div class="journal-sym"><label class="journal-pick">[\s\S]*?<\/label><div class="journal-sym-main"><button class="journal-name" data-action="openTradeReview" data-arg="6789\|AAPL\|long\|2026-10-01T14:30:01\.000Z" aria-label="Open the AAPL trade"><b>AAPL<\/b><\/button><\/div><\/div><\/td>\s*<td class="journal-sell">−\$504\.00<\/td>\s*<td title="Initial stop \$95\.00, risk \$502\.00">−1\.00R<\/td>\s*<td><button class="pos-link" data-action="openTradeReview"[^>]*>\$95\.00<\/button><\/td>\s*<td class="journal-buy">Long<\/td>/);
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
  assert.doesNotMatch(out, /<\/label><div class="journal-sym-main"><button class="journal-name"[^>]*><b>AAPL<\/b>/, 'the stock trade is filtered out');
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

// ---------- your stop and deleted trades (trade_reviews: stop, deleted) ----------

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
  assert.ok(supabase.reads.some(r => r.table === 'trade_reviews' && r.cols === 'trade_key,stop,deleted'), 'your reviews are read with the records');
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
  assert.deepEqual(w.map(x => [x.trade_key, x.stop, x.deleted, x.onConflict]), [[STOCK, 97.5, false, 'user_id,trade_key']]);
  assert.equal(state.openSheetName, null, 'saved: the sheet closes');
  assert.match(elements.get('errorBox').textContent, /Stop saved: R counts from \$97\.50\./);
  assert.match(out(), /title="Your stop \$97\.50, risk \$252\.00">−2\.00R<\/td>\s*<td><button[^>]*>\$97\.50<\/button><span class="pos-sub">yours<\/span>/);

  run(`openTradeReview('${STOCK}')`);
  assert.match(sheet(), /Using your stop, \$97\.50\. Risk \$252\.00\. Schwab's first was \$95\.00\./);
  await run('clearTradeStop()');
  assert.equal(supabase.reviewRows()[0].stop, null);
  assert.equal(supabase.reviewRows()[0].deleted, false, 'clearing the stop keeps the rest of the row');
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

test('a row opens its trade; Delete in the sheet takes it out at once with Undo, and imports can\'t bring it back', async () => {
  const { run, state, supabase, out, sheet, elements } = await journalWith();
  const name = /<\/label><div class="journal-sym-main"><button class="journal-name"[^>]*><b>AAPL<\/b>/;
  assert.doesNotMatch(out(), /journal-row-acts|>Edit<|>Delete</, 'no links on the rows');
  run(`openTradeRow('${STOCK}', { target: { closest: s => s === '.journal-pick' ? {} : null } })`);
  assert.equal(state.journalTrade, null, 'ticking the box doesn\'t open it');
  run(`openTradeRow('${STOCK}', { target: { closest: () => null } })`);
  assert.equal(state.journalTrade?.key, STOCK, 'anywhere else on the row opens its trade page');
  run('editJournalTrade()');
  assert.equal(state.openSheetName, 'tradeReview', 'and Edit there opens the trade sheet');
  assert.equal(elements.get('tradeReviewTitle').textContent, 'AAPL');
  assert.match(sheet(), /data-action="deleteTrade"[^>]*>Delete this trade/);
  assert.match(sheet(), /Imports won(?:'|&#39;)t bring it back/);
  await run('deleteTrade()');
  assert.deepEqual(supabase.reviewRows().map(r => [r.trade_key, r.deleted, r.stop]), [[STOCK, true, null]], 'no question first; the mark is on the trade key');
  assert.equal(state.openSheetName, null, 'the sheet closes');
  assert.match(elements.get('errorBox').innerHTML, /^Deleted AAPL\. <button class="pos-link toast-act" data-action="undoDeleteTrades">Undo<\/button>$/);
  assert.doesNotMatch(out(), name, 'gone from the list');
  assert.match(out(), /0 closed · 1 open · 1 deleted <button class="pos-link" data-action="toggleDeletedTrades">Show<\/button>/, 'and from the stats');

  await run('undoDeleteTrades()');
  assert.equal(supabase.reviewRows()[0].deleted, false, 'Undo puts it back');
  assert.match(out(), name);
  assert.match(elements.get('errorBox').textContent, /Trade restored\./);

  // ticked trades go together from the pick bar
  run(`toggleJournalPick('${STOCK}')`);
  run(`toggleJournalPick('${OPTION}')`);
  assert.match(out(), /2 picked<\/span><button class="btn journal-danger" data-action="deletePicked">Delete<\/button>/);
  await run('deletePicked()');
  assert.deepEqual(supabase.reviewRows().map(r => r.deleted), [true, true]);
  assert.match(elements.get('errorBox').innerHTML, /^Deleted 2 trades\. <button[^>]*data-action="undoDeleteTrades">Undo/);
  assert.deepEqual(state.journalPicked, [], 'the picks go with them');
  assert.doesNotMatch(out(), /journal-pickbar/);
  assert.match(out(), /No trades match\. 2 deleted\./);

  // an import brings Schwab's orders again: the trades stay deleted
  await run('loadJournal()');
  assert.doesNotMatch(out(), name, 'still gone after the records are read again');
  assert.equal(supabase.rows().filter(r => r.record_id === '501').length, 1, 'its orders are still kept');

  run('toggleDeletedTrades()');
  assert.match(out(), /<tr class="journal-deleted">\s*<td><div class="journal-sym"><span class="journal-pick" aria-hidden="true"><\/span><div class="journal-sym-main"><b>AAPL<\/b> <span class="journal-tag">deleted<\/span>/, 'shown dimmed to restore it, not to open');
  assert.match(out(), /data-action="restoreTrade" data-arg="6789\|AAPL[^"]*"[^>]*>Restore</);
  assert.match(out(), /No trades match\. · 2 deleted/, "still not counted");
  await run(`restoreTrade('${STOCK}')`);
  assert.equal(supabase.reviewRows().find(r => r.trade_key === STOCK).deleted, false);
  assert.match(out(), /1 closed · 0 won/);
});

test('reviews read when the journal opens; a refused save goes back; a missing table still shows the trades', async () => {
  const kept = await journalWith([{ trade_key: STOCK, stop: '97.5', deleted: false }, { trade_key: OPTION, stop: null, deleted: true }]);
  assert.match(kept.out(), /\$97\.50<\/button><span class="pos-sub">yours<\/span>/, 'Postgres numerics arrive as text');
  assert.match(kept.out(), /1 deleted/);

  kept.run(`openTradeReview('${STOCK}')`);
  kept.supabase.fail({ status: 500, message: 'nope' });
  await kept.run('deleteTrade()');
  assert.match(kept.sheet(), /Couldn't save: nope/);
  assert.match(kept.elements.get('errorBox').textContent, /Couldn't save: nope/);
  assert.equal(kept.state.openSheetName, 'tradeReview', 'the sheet stays open');
  assert.match(kept.out(), /<\/label><div class="journal-sym-main"><button class="journal-name"[^>]*><b>AAPL<\/b>/, 'and the trade comes back');

  const missing = await journalWith([], s => s.failTable('trade_reviews'));
  assert.match(missing.out(), /Your stops and deleted trades couldn't load \(the database doesn(?:'|&#39;)t have the trade_reviews table yet\)\. Trades show with Schwab's stops, deleted ones included\./);
  assert.match(missing.out(), /−1\.00R/, 'the trades still show');
  missing.run(`openTradeReview('${STOCK}')`);
  assert.match(missing.sheet(), /saving is off until they do/);
  await missing.run('deleteTrade()');
  missing.run(`toggleJournalPick('${STOCK}')`);
  assert.match(missing.out(), /data-action="deletePicked" disabled/);
  await missing.run('deletePicked()');
  assert.equal(missing.supabase.writes.filter(x => x.table === 'trade_reviews').length, 0, 'nothing written over a row it couldn\'t read');
});

test('fees: before by default; After fees takes out Schwab\'s fees per trade, says when they haven\'t come in, and syncs', async () => {
  const fee = (id, orderId, items) => ({ kind: 'transaction', record_id: String(id), account: '6789', entered_at: '2026-10-03T15:00:00Z', data: { activityId: id, type: 'TRADE', orderId, transferItems: items } });
  const records = [...RECORDS.map(r => ({ ...r, account: '6789' })),
    fee(9101, 501, [{ instrument: { symbol: 'AAPL', assetType: 'EQUITY' }, amount: 100, cost: -10002, price: 100.02 }, { amount: 0, cost: 0, feeType: 'COMMISSION' }]),
    fee(9102, 502, [{ instrument: { symbol: 'AAPL', assetType: 'EQUITY' }, amount: -100, cost: 9498, price: 94.98 }, { amount: 0, cost: -0.26, feeType: 'SEC_FEE' }, { amount: 0, cost: -0.02, feeType: 'TAF_FEE' }]),
  ];
  const { run, elements, storage } = await app({ storage: connected(), supabase: fakeRecords(records), session: SESSION });
  run("setView('journal')");
  await run('loadJournal()');
  const out = () => elements.get('journalSection').innerHTML;
  assert.match(out(), /class="active" aria-pressed="true" data-action="setJournalFees" data-arg="before">Before fees/, 'before fees unless you choose');
  assert.match(out(), /−\$504\.00<\/span> before fees/);
  assert.match(out(), /P&amp;L is before fees\./);

  run("setJournalFees('after')");
  assert.equal(storage.get('journal_fees'), 'after');
  assert.ok(run("CLOUD_KEYS.includes('journal_fees')"), 'the choice goes with your account');
  assert.match(out(), /<td class="journal-sell" title="Before fees −\$504\.00, fees \$0\.28">−\$504\.28<span class="pos-sub">fees \$0\.28<\/span><\/td>/);
  assert.match(out(), /−1\.00R/, '−504.28 ÷ 502 still rounds to −1.00R');
  assert.match(out(), /−\$504\.28<\/span> after fees \(fees \$0\.28\)/);
  assert.match(out(), /P&amp;L is after Schwab(?:'|&#39;)s fees/);
  assert.match(out(), /<td class="" title="Before fees \$0\.00, fees \$0\.00, 1 order without fees yet">—<\/td>/, 'an open trade with nothing sold shows a plain dash, not a red one');

  run("setJournalTab('fills')");
  assert.doesNotMatch(out(), /setJournalFees/, 'fees are a trades setting');
});

test('after fees, an order without its transaction yet says so instead of a made-up zero', async () => {
  const records = RECORDS.map(r => ({ ...r, account: '6789' }));
  const storage = connected();
  storage.set('journal_fees', 'after');
  const { run, elements } = await app({ storage, supabase: fakeRecords(records), session: SESSION });
  run("setView('journal')");
  await run('loadJournal()');
  const out = elements.get('journalSection').innerHTML;
  assert.match(out, /−\$504\.00<span class="pos-sub"><span class="journal-fees-missing">fees not in yet<\/span><\/span>/);
  assert.match(out, /fees not in yet on 1/);
});

test('a sell whose purchase is older than the history: marked, kept out of the stats, deletable; an expired option says so', async () => {
  const sell = {
    orderId: 801, enteredTime: '2026-09-02T14:00:00+0000', status: 'FILLED',
    orderLegCollection: [{ legId: 1, instruction: 'SELL', quantity: 40, instrument: { symbol: 'MSFT', assetType: 'EQUITY' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7801, executionLegs: [{ legId: 1, quantity: 40, price: 510, time: '2026-09-02T14:00:01+0000' }] }],
  };
  const expiredCall = {
    orderId: 802, enteredTime: '2026-09-02T14:10:00+0000', status: 'FILLED',
    orderLegCollection: [{ legId: 1, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { symbol: 'MSFT  260918C00520000', assetType: 'OPTION' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7802, executionLegs: [{ legId: 1, quantity: 1, price: 2.4, time: '2026-09-02T14:10:01+0000' }] }],
  };
  const records = [...RECORDS, { kind: 'order', record_id: '801', entered_at: '2026-09-02T14:00:00Z', data: sell }, { kind: 'order', record_id: '802', entered_at: '2026-09-02T14:10:00Z', data: expiredCall }]
    .map(r => ({ ...r, account: '6789' }));
  const supabase = fakeRecords(records);
  const { run, elements } = await app({ storage: connected(), supabase, session: SESSION });
  run("setView('journal')");
  await run('loadJournal()');
  const out = () => elements.get('journalSection').innerHTML;
  assert.match(out(), /<tr class="journal-history"[^>]*>\s*<td><div class="journal-sym"><label class="journal-pick">[\s\S]*?<\/label><div class="journal-sym-main"><button class="journal-name"[^>]*><b>MSFT<\/b><\/button> <span class="journal-tag journal-tag-history">before your history<\/span>/);
  assert.match(out(), /data-change="toggleJournalPick" data-arg="6789\|MSFT\|long\|before\|2026-09-02T14:00:01\.000Z"/, 'it can be ticked, to delete');
  assert.doesNotMatch(out(), /Short<\/td>\s*<td>40</, 'no made-up short');
  assert.match(out(), /2 closed · 0 won \(0%\) · <span class="journal-sell">−\$744\.00<\/span> before fees/, 'the stock and the expired call count; the history sell doesn\'t');
  assert.match(out(), /1 from before your history/);
  assert.match(out(), /MSFT 9\/18\/26 520C<\/b><\/button> <span class="journal-tag journal-tag-quiet" title="Closed at \$0 at the 4pm close on expiry/);
  assert.match(out(), /−\$240\.00/, 'the whole premium');
  assert.match(out(), /Options still open after expiry close at \$0/);

  run("openTradeReview('6789|MSFT|long|before|2026-09-02T14:00:01.000Z')");
  assert.match(elements.get('tradeReviewBody').innerHTML, /Sold 40 at \$510\.00 · bought before your history, so no P&amp;L/);
  assert.doesNotMatch(elements.get('tradeReviewBody').innerHTML, /tradeStopInput/, 'no entry to set a stop against: facts and Delete only');
  await run('deleteTrade()');
  assert.doesNotMatch(out(), /before your history<\/span>/);
  assert.match(out(), /1 deleted/);
});

test('spreads: a multi-leg order is one row; Split writes solo; Combine joins legs and stays on the spread', async () => {
  const exec = (id, legs) => [{ activityType: 'EXECUTION', activityId: id, executionLegs: legs }];
  const LEGS = [
    { legId: 1, instruction: 'BUY_TO_OPEN', quantity: 2, instrument: { symbol: 'AAPL  261218C00250000', assetType: 'OPTION' } },
    { legId: 2, instruction: 'SELL_TO_OPEN', quantity: 2, instrument: { symbol: 'AAPL  261218C00260000', assetType: 'OPTION' } },
  ];
  const vertical = { orderId: 901, enteredTime: '2026-10-08T14:00:00+0000', status: 'FILLED', orderLegCollection: LEGS,
    orderActivityCollection: exec(7901, [{ legId: 1, quantity: 2, price: 6.2, time: '2026-10-08T14:00:01+0000' }, { legId: 2, quantity: 2, price: 2.7, time: '2026-10-08T14:00:01+0000' }]) };
  const records = [...RECORDS, { kind: 'order', record_id: '901', entered_at: '2026-10-08T14:00:00Z', data: vertical }].map(r => ({ ...r, account: '6789' }));
  const supabase = fakeRecords(records);
  const { run, elements, state } = await app({ storage: connected(), supabase, session: SESSION });
  run("setView('journal')");
  await run('loadJournal()');
  const out = () => elements.get('journalSection').innerHTML;
  const sheet = () => elements.get('tradeReviewBody').innerHTML;
  const SPREAD = '6789|AAPL|spread|2026-10-08T14:00:01.000Z';
  assert.match(out(), /<b>AAPL 12\/18\/26 250\/260C<\/b><\/button> <span class="journal-tag journal-tag-quiet">call debit<\/span> <span class="journal-tag">open<\/span><span class="pos-sub journal-legs">\+2 250C −2 260C<\/span>/);
  assert.match(out(), /journal-buy">Long<\/td>\s*<td>2<\/td>\s*<td>\$3\.50<\/td>/, 'a call debit spread is long; net debit per spread');
  assert.doesNotMatch(out(), /data-action="separateTrade"/, 'no Separate on the row: it is in the sheet');

  run(`openTradeReview('${SPREAD}')`);
  assert.match(sheet(), /data-action="splitSpread"[^>]*>Split into legs/);
  assert.match(sheet(), /Paid \$3\.50 × 2/);
  assert.match(sheet(), /Opened in one order, so its legs are one trade\. The debit paid, \$700\.00, is the risk\./);
  assert.match(sheet(), /data-action="splitSpread"/);
  await run('splitSpread()');
  const solos = [...supabase.trades.values()];
  assert.equal(solos.length, 2, 'one trades row per leg keeps them apart, though one order opened them');
  assert.ok(solos.every(r => r.fill_ids.length === 1));
  assert.equal(supabase.reviewRows().length, 0, 'nothing written to trade_reviews');
  assert.match(out(), /<b>AAPL 12\/18\/26 260C<\/b>/, 'two legs again');
  assert.doesNotMatch(out(), /call debit/);

  const legKey = strike => out().match(new RegExp(`data-change="toggleJournalPick" data-arg="(6789\\|AAPL  261218C00${strike}000[^"]*)"`))[1];
  const LONG = legKey('250'), SHORT = legKey('260');
  run(`openTradeReview('${LONG}')`);
  assert.match(sheet(), /Combine into a spread/);
  assert.match(sheet(), new RegExp(`data-action="combineTrade" data-arg="${SHORT.replace(/[|.]/g, '\\$&')}"`), 'the short call is offered');
  await run(`combineTrade('${SHORT}')`);
  const [joined, ...rest] = [...supabase.trades.values()];
  assert.equal(rest.length, 0, 'the legs\' rows become one');
  assert.equal(joined.fill_ids.length, 2);
  assert.equal(state.openSheetName, 'tradeReview', 'the sheet stays open');
  assert.equal(state.tradeReviewKey, `trade:${joined.id}`, 'on the spread');
  assert.match(sheet(), /You combined these legs/);
  assert.match(out(), /call debit/);
});

test('before the trades table is pushed: stops and deletes still load, merging and combining say what they need', async () => {
  const supabase = fakeRecords(RECORDS.map(r => ({ ...r, account: '6789' })), [{ trade_key: STOCK, stop: 97.5, deleted: false }]);
  supabase.failTable('trades');
  const { run, elements } = await app({ storage: connected(), supabase, session: SESSION });
  run("setView('journal')");
  await run('loadJournal()');
  const out = () => elements.get('journalSection').innerHTML;
  assert.match(out(), /\$97\.50<\/button><span class="pos-sub">yours<\/span>/, 'your stop still loads');
  assert.doesNotMatch(out(), /couldn(?:'|&#39;)t load/);
  assert.match(out(), /Merges unavailable: the database doesn(?:'|&#39;)t have the trades table yet/);
  run(`toggleJournalPick('${STOCK}'); toggleJournalPick('${OPTION}')`);
  assert.match(out(), /journal-why">Merging needs the database update: npx supabase db push\./);
  run(`openTradeReview('${OPTION}')`);
  assert.match(elements.get('tradeReviewBody').innerHTML, /Combining needs the database update: npx supabase db push\./);
});


// ---------- merge and separate: tick trades, Merge, kept as a row in your account's trades table ----------

// a filled order: one leg per [instruction, quantity, price, symbol]
const filled = (id, time, legs) => ({
  kind: 'order', record_id: String(id), account: '6789', entered_at: time,
  data: {
    orderId: id, enteredTime: time.replace('Z', '+0000'), status: 'FILLED',
    orderLegCollection: legs.map(([instruction, qty, , symbol = 'AAPL'], i) => ({ legId: i + 1, instruction, quantity: qty, instrument: { symbol, assetType: symbol.includes(' ') ? 'OPTION' : 'EQUITY' } })),
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: id * 10, executionLegs: legs.map(([, qty, price], i) => ({ legId: i + 1, quantity: qty, price, time: time.replace('Z', '+0000') })) }],
  },
});
// two AAPL round trips (flat on Oct 2), and one MSFT
const ROUND_TRIPS = [
  filled(1, '2026-10-01T14:30:00Z', [['BUY', 100, 20]]),
  filled(2, '2026-10-02T14:30:00Z', [['SELL', 100, 21]]),
  filled(3, '2026-10-05T14:30:00Z', [['BUY', 50, 21.5]]),
  filled(4, '2026-10-06T14:30:00Z', [['SELL', 50, 23]]),
  filled(5, '2026-10-07T14:30:00Z', [['BUY', 10, 400, 'MSFT']]),
  filled(6, '2026-10-07T15:30:00Z', [['SELL', 10, 401, 'MSFT']]),
];
const KEY_A = '6789|AAPL|long|2026-10-01T14:30:00.000Z', KEY_B = '6789|AAPL|long|2026-10-05T14:30:00.000Z', KEY_M = '6789|MSFT|long|2026-10-07T14:30:00.000Z';
const symbolCells = out => [...out.matchAll(/<tr[^>]*>\s*<td><div class="journal-sym"><label class="journal-pick">[\s\S]*?<\/label><div class="journal-sym-main"><button class="journal-name"[^>]*><b>([^<]*)<\/b>/g)].map(m => m[1]);
const reKey = k => k.replace(/[|.]/g, '\\$&');

async function journalOf(records, trades = []) {
  const supabase = fakeRecords(records, [], trades);
  const a = await app({ storage: connected(), supabase, session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  return { ...a, supabase, out: () => a.elements.get('journalSection').innerHTML };
}

test('tick two trades and Merge: kept as one trade in your account; Separate splits it back', async () => {
  const { run, out, supabase, elements } = await journalOf(ROUND_TRIPS);
  assert.ok(supabase.reads.some(r => r.table === 'trades' && r.cols === 'id,account,fill_ids,created_at'), 'merges are read with the records');
  assert.deepEqual(symbolCells(out()), ['MSFT', 'AAPL', 'AAPL']);
  assert.match(out(), new RegExp(`<input type="checkbox" data-change="toggleJournalPick" data-arg="${reKey(KEY_A)}" aria-label="Pick AAPL"`));
  assert.doesNotMatch(out(), /journal-pickbar/, 'no bar until something is ticked');

  run(`toggleJournalPick('${KEY_A}')`);
  assert.match(out(), /<span>1 picked<\/span><button class="btn journal-danger" data-action="deletePicked">Delete<\/button><span>Tick another to merge\.<\/span>[\s\S]*data-action="mergePicked" disabled/, 'Delete sits by the count, away from Merge');
  run(`toggleJournalPick('${KEY_B}')`);
  assert.match(out(), /class="journal-pickbar"[\s\S]*2 picked<\/span><button class="btn journal-danger" data-action="deletePicked">Delete<\/button>\s*<span class="journal-pickbar-acts"><button class="btn primary" data-action="mergePicked">Merge into one trade<\/button>/);
  assert.match(out(), new RegExp(`data-arg="${reKey(KEY_A)}" aria-label="Pick AAPL" checked`));

  await run('mergePicked()');
  const [row] = [...supabase.trades.values()];
  assert.equal(supabase.trades.size, 1);
  assert.equal(row.account, '6789');
  assert.deepEqual([...row.fill_ids].sort(), ['1:10:1:0', '2:20:1:0', '3:30:1:0', '4:40:1:0'], 'the merge is its fills, by Schwab id');
  assert.equal(elements.get('errorBox').textContent, 'Merged 2 trades into one.');
  assert.deepEqual(symbolCells(out()), ['MSFT', 'AAPL']);
  assert.match(out(), /<span class="pos-sub journal-legs">2 trades merged<\/span>/);
  run(`openTradeReview('trade:${row.id}')`);
  assert.match(elements.get('tradeReviewBody').innerHTML, new RegExp(`data-action="separateTrade" data-arg="trade:${row.id}"`), 'Separate is in its sheet');
  assert.match(out(), /2 closed · 2 won/);
  assert.doesNotMatch(out(), /journal-pickbar/, 'the picks clear');

  await run(`separateTrade('trade:${row.id}')`);
  assert.equal(supabase.trades.size, 0);
  assert.equal(elements.get('errorBox').textContent, 'Separated into 2 trades.');
  assert.deepEqual(symbolCells(out()), ['MSFT', 'AAPL', 'AAPL']);
});

test('trades that cannot be one say why, and Merge stays off', async () => {
  const { run, out, supabase } = await journalOf(ROUND_TRIPS);
  run(`toggleJournalPick('${KEY_A}'); toggleJournalPick('${KEY_M}')`);
  assert.match(out(), /2 picked<\/span><button[^>]*>Delete<\/button><span class="journal-why">Pick trades on the same symbol\.<\/span>/);
  assert.match(out(), /data-action="mergePicked" disabled/);
  await run('mergePicked()');
  assert.equal(supabase.trades.size, 0);
  run('clearJournalPicks()');
  assert.doesNotMatch(out(), /journal-pickbar/);
});

test('merging a merged trade with another keeps its row, so its key (and your stop on it) stays put', async () => {
  const more = [...ROUND_TRIPS, filled(7, '2026-10-12T14:30:00Z', [['BUY', 10, 22]]), filled(8, '2026-10-12T15:30:00Z', [['SELL', 10, 22.5]])];
  const kept = { id: '11111111-1111-4111-8111-111111111111', account: '6789', fill_ids: ['1:10:1:0', '3:30:1:0'], created_at: '2026-10-09T00:00:00.000Z' };
  const { run, out, supabase } = await journalOf(more, [kept]);
  run(`toggleJournalPick('trade:${kept.id}'); toggleJournalPick('6789|AAPL|long|2026-10-12T14:30:00.000Z')`);
  await run('mergePicked()');
  assert.deepEqual(supabase.tradeOps.map(o => o.op), ['update']);
  assert.ok(supabase.trades.get(kept.id).fill_ids.includes('7:70:1:0'));
  assert.match(out(), /3 trades merged/);
});
