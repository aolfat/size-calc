// Run with: node --test
// Shares an option delivered: Schwab posts an assignment or exercise as a TRADE transaction with no orderId, its stock leg
// at the strike. The journal makes fills of it: the shares at the strike, and the option closed at $0 that day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const json = (run, code) => JSON.parse(run(`JSON.stringify(${code})`));
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };

const order = (orderId, instruction, symbol, assetType, qty, price, time) => ({
  kind: 'order', record_id: String(orderId), account: '6789', entered_at: time.replace('+0000', 'Z'),
  data: {
    orderId, enteredTime: time, status: 'FILLED',
    orderLegCollection: [{ legId: 1, instruction, quantity: qty, instrument: { symbol, assetType } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: orderId * 10, executionLegs: [{ legId: 1, quantity: qty, price, time }] }],
  },
});
// the shape Schwab posts: no orderId, the stock leg at the strike, settlementDate the day it happened, posted overnight
const delivery = (activityId, symbol, amount, price, effect, settlementDate, fees = []) => ({
  kind: 'transaction', record_id: String(activityId), account: '6789', entered_at: settlementDate,
  data: {
    activityId, type: 'TRADE', status: 'VALID', subAccount: 'MARGIN', description: symbol,
    time: settlementDate.replace(/T.*/, 'T11:00:00+0000'), settlementDate, tradeDate: settlementDate, netAmount: -amount * price,
    transferItems: [
      ...fees.map(([feeType, cost]) => ({ feeType, amount: -cost, cost, price: 0, instrument: { assetType: 'CURRENCY', symbol: 'CURRENCY_USD' } })),
      { amount, cost: -amount * price, price, positionEffect: effect, instrument: { assetType: 'EQUITY', symbol, type: 'COMMON_STOCK' } },
    ],
  },
});

const PUT = 'SOFI  261016P00020000';
// 20 puts sold, 15 assigned early over two nights, the last 5 bought back, then the shares sold
const SOFI = [
  order(1, 'SELL_TO_OPEN', PUT, 'OPTION', 20, 1.2, '2026-09-25T18:02:00+0000'),
  delivery(11, 'SOFI', 500, 20, 'OPENING', '2026-10-08T04:00:00+0000'),
  delivery(12, 'SOFI', 1000, 20, 'OPENING', '2026-10-12T04:00:00+0000'),
  order(2, 'BUY_TO_CLOSE', PUT, 'OPTION', 5, 0.4, '2026-10-16T18:00:00+0000'),
  order(3, 'SELL', 'SOFI', 'EQUITY', 1500, 21, '2026-10-19T15:00:00+0000'),
];
const NOW = Date.parse('2026-10-20T00:00:00Z');

test('assigned puts: the contracts close at $0 the day they were assigned, and the shares open at the strike', async () => {
  const { run } = await app();
  const fills = json(run, `fillsFrom(${JSON.stringify(SOFI)}).filter(f => f.via)`);
  const at = f => `${f.time} ${f.assetType}`;
  assert.deepEqual(fills.sort((x, y) => (at(x) < at(y) ? -1 : 1)).map(f => [f.symbol, f.instruction, f.qty, f.price, f.time, f.via]), [
    ['SOFI', 'BUY', 500, 20, '2026-10-08T20:00:00.000Z', 'assigned'],
    [PUT, 'BUY_TO_CLOSE', 5, 0, '2026-10-08T20:00:00.000Z', 'assigned'],
    ['SOFI', 'BUY', 1000, 20, '2026-10-12T20:00:00.000Z', 'assigned'],
    [PUT, 'BUY_TO_CLOSE', 10, 0, '2026-10-12T20:00:00.000Z', 'assigned'],
  ], 'at 4pm New York on the settlement day, the posting\'s own day');

  const trades = json(run, `journalTrades(fillsFrom(${JSON.stringify(SOFI)}), ${JSON.stringify(SOFI)}, {}, { now: ${NOW} })`);
  const put = trades.find(t => t.symbol === PUT), shares = trades.find(t => t.symbol === 'SOFI');
  assert.equal(put.status, 'win');
  assert.equal(put.pnl, 2200, 'the premium kept on the 15 assigned, less the buyback on the last 5');
  assert.equal(put.via, 'assigned');
  assert.equal(put.expired, false, 'nothing left to expire');
  assert.equal(shares.direction, 'long');
  assert.equal(shares.entryQty, 1500);
  assert.equal(shares.avgEntry, 20, 'the shares cost the strike');
  assert.equal(shares.openedAt, '2026-10-08T20:00:00.000Z');
  assert.equal(shares.pnl, 1500, 'the sale is no longer from before your history');
  assert.equal(shares.via, 'assigned');
});

test('shares whose option is older than the history still open at the strike, and say delivered', async () => {
  const { run } = await app();
  const records = [delivery(21, 'AAPL', 100, 250, 'OPENING', '2026-03-13T04:00:00+0000'), order(4, 'SELL', 'AAPL', 'EQUITY', 100, 257.5, '2026-03-17T15:00:00+0000')];
  const [t] = json(run, `journalTrades(fillsFrom(${JSON.stringify(records)}), ${JSON.stringify(records)}, {}, { now: ${NOW} })`);
  assert.equal(t.status, 'win');
  assert.equal(t.pnl, 750);
  assert.equal(t.via, 'delivered');
  assert.equal(t.openedAt, '2026-03-13T20:00:00.000Z', '4pm EDT');
});

test('a covered call assigned: the shares go out at the strike, the call closes at $0, and the fee goes to the shares', async () => {
  const { run } = await app();
  const CALL = 'MSFT  260320C00400000';
  const records = [
    order(5, 'BUY', 'MSFT', 'EQUITY', 100, 392, '2026-03-02T15:00:00+0000'),
    order(6, 'SELL_TO_OPEN', CALL, 'OPTION', 1, 3, '2026-03-02T15:05:00+0000'),
    delivery(31, 'MSFT', -100, 400, 'CLOSING', '2026-03-20T04:00:00+0000', [['SEC_FEE', -0.27]]),
  ];
  const trades = json(run, `journalTrades(fillsFrom(${JSON.stringify(records)}), ${JSON.stringify(records)}, {}, { now: ${NOW}, afterFees: true })`);
  const shares = trades.find(t => t.symbol === 'MSFT'), call = trades.find(t => t.symbol === CALL);
  assert.equal(shares.grossPnl, 800);
  assert.equal(shares.fees, 0.27);
  assert.equal(shares.via, 'assigned');
  assert.equal(shares.closedAt, '2026-03-20T20:00:00.000Z');
  assert.equal(call.grossPnl, 300, 'the whole premium');
  assert.equal(call.expired, false);
  assert.equal(call.feesMissing, 1, 'only its opening order waits on fees; the assignment has none to wait on');
});

test('the Journal tags assigned trades and words the fills', async () => {
  const supabase = fakeRecords(SOFI);
  const { run, elements } = await app({ supabase, session: SESSION });
  run("setView('journal')");
  await run('loadJournal()');
  await settle();
  const out = () => elements.get('journalSection').innerHTML;
  assert.match(out(), /SOFI 10\/16\/26 20P<\/b><\/button>[^]*?<span class="journal-tag journal-tag-quiet" title="Assigned: the option closed at \$0[^"]*">assigned<\/span>/);
  assert.match(out(), /An assigned or exercised option closes at \$0 the day it happened/);
  run("setJournalTab('fills')");
  assert.match(out(), /Buy to close \(assigned\)/);
  assert.match(out(), /Buy \(assigned\)/);
});
