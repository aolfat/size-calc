// Run with: node --test
// Journal trades: fills grouped flat to flat (first in first out, scale-ins, partial exits, flips, ×100 options), the
// initial stop (the first stop order on the loss side, from just before entry until close), R, and the summaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const fill = (id, time, side, qty, price, extra = {}) => ({
  id, orderId: id, account: '6789', time, symbol: 'AAPL', label: 'AAPL', assetType: 'EQUITY',
  instruction: side === 'buy' ? 'BUY' : 'SELL', side, qty, price, ...extra,
});
const stopOrder = (orderId, entered, instruction, stopPrice, extra = {}) => ({
  kind: 'order', account: '6789',
  data: { orderId, orderType: 'STOP', stopPrice, enteredTime: entered, status: 'CANCELED', orderLegCollection: [{ instruction, instrument: { symbol: extra.symbol || 'AAPL', assetType: 'EQUITY' } }], ...extra.data },
});

async function trades(fills, records = []) {
  const { run } = await app();
  return JSON.parse(run(`JSON.stringify(journalTrades(${JSON.stringify(fills)}, ${JSON.stringify(records)}))`));
}

test('a scale-in, a partial exit and a flip: first in first out, P&L per share matched to the oldest lot', async () => {
  const list = await trades([
    fill('a', '2026-10-01T14:30:00.000Z', 'buy', 100, 100),
    fill('b', '2026-10-01T14:40:00.000Z', 'buy', 50, 101),
    fill('c', '2026-10-01T15:00:00.000Z', 'sell', 100, 103),
    fill('d', '2026-10-02T15:00:00.000Z', 'sell', 80, 104), // closes the last 50, then 30 short
  ]);
  assert.equal(list.length, 2);
  const long = list.find(t => t.direction === 'long'), short = list.find(t => t.direction === 'short');
  assert.equal(long.direction, 'long');
  assert.equal(long.entryQty, 150);
  assert.equal(long.avgEntry.toFixed(3), '100.333');
  assert.equal(long.pnl, 450, '100 × $3 from the first lot, 50 × $3 from the second');
  assert.equal(long.exits, 2, 'scaled out over two exits');
  assert.equal(long.status, 'win');
  assert.equal(long.closedAt, '2026-10-02T15:00:00.000Z');
  assert.equal(long.holdMs, 24.5 * 3600000);
  assert.equal(short.direction, 'short', 'the flip opens the other way');
  assert.equal(short.entryQty, 30);
  assert.equal(short.status, 'open');
  assert.equal(short.key, '6789|AAPL|short|2026-10-02T15:00:00.000Z', 'keyed by account, symbol, direction and open time');
});

test('a short: P&L when covered higher, R from the stop above the entry', async () => {
  const [t] = await trades(
    [fill('s', '2026-10-02T13:35:01.000Z', 'sell', 50, 251.2, { instruction: 'SELL_SHORT' }), fill('c', '2026-10-02T15:12:30.000Z', 'buy', 50, 253.4, { instruction: 'BUY_TO_COVER' })],
    [stopOrder(9101, '2026-10-02T13:35:00+0000', 'BUY_TO_COVER', 253)],
  );
  assert.equal(t.direction, 'short');
  assert.equal(t.pnl, -110);
  assert.equal(t.status, 'loss');
  assert.equal(t.stop, 253);
  assert.equal(t.rBasis, 'stop');
  assert.equal(t.risk, 90, '(253 − 251.20) × 50');
  assert.equal(t.r, -1.22);
});

test('options count ×100, and a long option with no stop risks its premium', async () => {
  const o = { symbol: 'AAPL  261218C00245000', label: 'AAPL 12/18/26 245C', assetType: 'OPTION' };
  const [t] = await trades([
    fill('o1', '2026-10-09T14:05:03.000Z', 'buy', 3, 4.1, { ...o, instruction: 'BUY_TO_OPEN' }),
    fill('o2', '2026-10-10T15:00:00.000Z', 'sell', 3, 5, { ...o, instruction: 'SELL_TO_CLOSE' }),
  ]);
  assert.equal(t.multiplier, 100);
  assert.equal(t.pnl, 270, '3 contracts × $0.90 × 100');
  assert.equal(t.rBasis, 'premium');
  assert.equal(t.risk, 1230);
  assert.equal(t.r, 0.22);
});

test('the initial stop: the first one on the loss side, in the trade window, for this symbol and account', async () => {
  const entry = fill('e', '2026-10-01T14:30:00.000Z', 'buy', 100, 100);
  const exit = fill('x', '2026-10-01T16:00:00.000Z', 'sell', 100, 101);
  const [t] = await trades([entry, exit], [
    stopOrder(1, '2026-10-01T13:00:00+0000', 'SELL', 97), // an hour and a half before the entry: another trade's
    stopOrder(2, '2026-10-01T14:31:00+0000', 'SELL', 98), // the initial stop, later replaced
    stopOrder(3, '2026-10-01T15:00:00+0000', 'SELL', 99), // the replacement, tighter
    stopOrder(4, '2026-10-01T14:30:30+0000', 'SELL', 100.5), // above the entry: protects profit, isn't the risk
    stopOrder(5, '2026-10-01T14:30:10+0000', 'SELL', 90, { symbol: 'MSFT' }),
    { ...stopOrder(6, '2026-10-01T14:30:20+0000', 'SELL', 95), account: '1111' },
    stopOrder(7, '2026-10-01T14:30:40+0000', 'BUY', 95), // opens, doesn't close a long
  ]);
  assert.equal(t.stop, 98);
  assert.equal(t.stopOrderId, '2');
  assert.equal(t.risk, 200);
  assert.equal(t.r, 0.5);

  const [none] = await trades([entry, exit]);
  assert.equal(none.stop, null);
  assert.equal(none.r, null, 'a stock with no stop order has no R');
});

test('a trigger child stop counts though it was entered with its entry, seconds before the fill', async () => {
  const [t] = await trades(
    [fill('e', '2026-10-01T14:30:05.000Z', 'buy', 100, 100.02), fill('x', '2026-10-03T15:00:00.000Z', 'sell', 100, 94.98)],
    [{ kind: 'order', account: '6789', data: { orderId: 501, orderType: 'MARKET', enteredTime: '2026-10-01T14:30:00+0000', childOrderStrategies: [{ orderId: 502, orderType: 'STOP', stopPrice: 95, enteredTime: '2026-10-01T14:30:00+0000', status: 'FILLED', orderLegCollection: [{ instruction: 'SELL', instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }] }] } }],
  );
  assert.equal(t.stop, 95);
  assert.equal(t.r, -1, 'stopped out for −1R (slippage of 2 cents, on a $5.02 risk)');
});

test('identical-looking fills from a split order are both kept, and accounts never mix', async () => {
  const list = await trades([
    fill('p1', '2026-10-01T14:30:00.000Z', 'buy', 100, 50),
    fill('p2', '2026-10-01T14:30:00.000Z', 'buy', 100, 50),
    fill('q', '2026-10-01T15:00:00.000Z', 'sell', 200, 51),
    fill('z', '2026-10-01T14:35:00.000Z', 'buy', 10, 50, { account: '1111' }),
  ]);
  const mine = list.find(t => t.account === '6789');
  assert.equal(mine.entryQty, 200);
  assert.equal(mine.pnl, 200);
  assert.equal(list.find(t => t.account === '1111').status, 'open');
});

test('an open trade shows what it has realized so far, but no R until it closes', async () => {
  const [t] = await trades(
    [fill('a', '2026-10-01T14:30:00.000Z', 'buy', 100, 100), fill('b', '2026-10-01T15:00:00.000Z', 'sell', 40, 102)],
    [stopOrder(1, '2026-10-01T14:30:30+0000', 'SELL', 98)],
  );
  assert.equal(t.status, 'open');
  assert.equal(t.openQty, 60);
  assert.equal(t.pnl, 80);
  assert.equal(t.risk, 200, 'the risk is known');
  assert.equal(t.r, null);
  assert.equal(t.holdMs, null);
});

test('summary and hold time in words', async () => {
  const { run } = await app();
  const s = JSON.parse(run(`JSON.stringify(tradesSummary([{ status: 'win', pnl: 300, r: 1.5 }, { status: 'loss', pnl: -100, r: -1 }, { status: 'win', pnl: 50, r: null }, { status: 'open', pnl: 0, r: null }]))`));
  assert.deepEqual(s, { closed: 3, open: 1, wins: 2, losses: 1, winRate: 66.7, pnl: 250, avgR: 0.25, withR: 2 });
  assert.equal(run('holdWords(45 * 60000)'), '45m');
  assert.equal(run('holdWords((3 * 60 + 10) * 60000)'), '3h 10m');
  assert.equal(run('holdWords((52) * 3600000)'), '2d 4h');
  assert.equal(run('holdWords(null)'), '');
});

// ---------- merged trades: trades you said are one, kept as their fills in Supabase's trades table ----------

const C245 = { symbol: 'AAPL  261218C00245000', label: 'AAPL 12/18/26 245C', assetType: 'OPTION' };
const C250 = { symbol: 'AAPL  261218C00250000', label: 'AAPL 12/18/26 250C', assetType: 'OPTION' };
const P245 = { symbol: 'AAPL  261218P00245000', label: 'AAPL 12/18/26 245P', assetType: 'OPTION' };
const P250 = { symbol: 'AAPL  261218P00250000', label: 'AAPL 12/18/26 250P', assetType: 'OPTION' };
// two AAPL trades: flat on Oct 3, back in on Oct 6
const TWO = [
  fill('a1', '2026-10-01T14:30:00.000Z', 'buy', 100, 20),
  fill('a2', '2026-10-02T14:30:00.000Z', 'buy', 50, 21),
  fill('a3', '2026-10-03T14:30:00.000Z', 'sell', 150, 22),
  fill('b1', '2026-10-06T14:30:00.000Z', 'buy', 100, 21.5),
  fill('b2', '2026-10-08T14:30:00.000Z', 'sell', 100, 23),
];
const saved = (id, fillIds, extra = {}) => ({ id, account: '6789', fill_ids: fillIds, created_at: '2026-10-09T00:00:00.000Z', ...extra });
async function merged(fills, records, rows) {
  const { run } = await app();
  return JSON.parse(run(`JSON.stringify(journalTrades(${JSON.stringify(fills)}, ${JSON.stringify(records)}, ${JSON.stringify(rows)}))`));
}

test('two trades on one symbol merged: P&L added, weighted entry and exit, first open to last close, R off the first stop', async () => {
  const stops = [stopOrder(1, '2026-10-01T14:30:30+0000', 'SELL', 19)];
  const apart = await merged(TWO, stops, []);
  assert.equal(apart.length, 2);
  assert.deepEqual(apart.map(t => t.kind), ['single', 'single']);
  const list = await merged(TWO, stops, [saved('m1', ['a1', 'a2', 'a3', 'b1', 'b2'])]);
  assert.equal(list.length, 1);
  const t = list[0];
  assert.equal(t.kind, 'merged');
  assert.equal(t.id, 'm1');
  assert.equal(t.key, 'trade:m1', 'keyed by the saved row, so a review sticks to it');
  assert.deepEqual(t.savedIds, ['m1']);
  assert.deepEqual(t.parts, apart.map(p => p.key).sort(), 'the trades it was made from, for Separate');
  assert.equal(t.label, 'AAPL');
  assert.equal(t.direction, 'long');
  assert.equal(t.pnl, 400, '250 + 150');
  assert.equal(t.entryQty, 250);
  assert.equal(t.avgEntry, 20.8);
  assert.equal(t.avgExit, 22.4);
  assert.equal(t.exits, 2);
  assert.equal(t.openedAt, '2026-10-01T14:30:00.000Z');
  assert.equal(t.closedAt, '2026-10-08T14:30:00.000Z');
  assert.equal(t.holdMs, 7 * 86400000);
  assert.equal(t.status, 'win');
  assert.equal(t.stop, 19);
  assert.equal(t.risk, 450, '(20.80 − 19) × 250');
  assert.equal(t.r, 0.89);
});

test('a merge that took in an open trade follows it: fills that land later still belong to it', async () => {
  // merged while the second trade was open, before its exit b2 was imported
  const [t] = await merged(TWO, [], [saved('m1', ['a1', 'a2', 'a3', 'b1'])]);
  assert.equal(t.kind, 'merged');
  assert.equal(t.pnl, 400);
  assert.equal(t.status, 'win');
  assert.ok(t.fillIds.includes('b2'));
});

test('saved merges that share a trade make one trade; a merge left with one trade, or across accounts, changes nothing', async () => {
  const third = [fill('c1', '2026-10-09T14:30:00.000Z', 'buy', 10, 22), fill('c2', '2026-10-09T15:30:00.000Z', 'sell', 10, 22.5)];
  const list = await merged([...TWO, ...third], [], [
    saved('m2', ['b1', 'c1'], { created_at: '2026-10-10T00:00:00.000Z' }),
    saved('m1', ['a1', 'b1']),
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'm1', 'the oldest saved row names it');
  assert.deepEqual(list[0].savedIds.sort(), ['m1', 'm2'], 'Separate deletes both');
  assert.equal(list[0].pnl, 405);

  const lonely = await merged(TWO, [], [saved('m1', ['a1', 'gone-fill'])]);
  assert.deepEqual(lonely.map(t => t.kind), ['single', 'single']);

  const other = { ...fill('z1', '2026-10-06T14:30:00.000Z', 'buy', 10, 21), account: '1111' };
  const mixed = await merged([...TWO, other], [], [saved('m1', ['a1', 'z1'])]);
  assert.equal(mixed.length, 3, 'never across accounts');
});

test('a call debit spread merged: net debit in, net credit out, risk = the debit', async () => {
  const fills = [
    fill('l1', '2026-10-06T14:00:00.000Z', 'buy', 2, 4.1, { ...C245, instruction: 'BUY_TO_OPEN', orderId: 'S1' }),
    fill('s1', '2026-10-06T14:00:00.000Z', 'sell', 2, 1.6, { ...C250, instruction: 'SELL_TO_OPEN', orderId: 'S1' }),
    fill('l2', '2026-10-09T15:00:00.000Z', 'sell', 2, 6, { ...C245, instruction: 'SELL_TO_CLOSE', orderId: 'S2' }),
    fill('s2', '2026-10-09T15:00:00.000Z', 'buy', 2, 2.5, { ...C250, instruction: 'BUY_TO_CLOSE', orderId: 'S2' }),
  ];
  const [t] = await merged(fills, [], [saved('sp', ['l1', 's1'])]);
  assert.equal(t.kind, 'spread');
  assert.equal(t.label, 'AAPL 12/18/26 245/250C');
  assert.equal(t.net, 'debit', 'paid to open');
  assert.equal(t.bias, 'long', 'a call debit spread is long');
  assert.equal(t.structure, 'call debit');
  assert.equal(t.entryQty, 2, 'two spreads');
  assert.equal(t.avgEntry, 2.5, 'net debit per spread');
  assert.equal(t.avgExit, 3.5, 'net credit per spread at the close');
  assert.equal(t.pnl, 200, '+380 on the 245C, −180 on the 250C');
  assert.equal(t.multiplier, 100);
  assert.equal(t.rBasis, 'spread');
  assert.equal(t.risk, 500, 'the debit is all it can lose');
  assert.equal(t.r, 0.4);
});

test('a put credit spread merged: net credit in, risk = width − credit', async () => {
  const fills = [
    fill('s1', '2026-10-06T14:00:00.000Z', 'sell', 1, 3, { ...P250, instruction: 'SELL_TO_OPEN', orderId: 'S1' }),
    fill('l1', '2026-10-06T14:00:00.000Z', 'buy', 1, 1.2, { ...P245, instruction: 'BUY_TO_OPEN', orderId: 'S1' }),
    fill('s2', '2026-10-09T15:00:00.000Z', 'buy', 1, 1, { ...P250, instruction: 'BUY_TO_CLOSE', orderId: 'S2' }),
    fill('l2', '2026-10-09T15:00:00.000Z', 'sell', 1, 0.3, { ...P245, instruction: 'SELL_TO_CLOSE', orderId: 'S2' }),
  ];
  const [t] = await merged(fills, [], [saved('sp', ['s1', 'l1', 's2', 'l2'])]);
  assert.equal(t.label, 'AAPL 12/18/26 245/250P');
  assert.equal(t.net, 'credit', 'received to open');
  assert.equal(t.bias, 'long', 'a put credit spread is long');
  assert.equal(t.structure, 'put credit');
  assert.equal(t.avgEntry, 1.8, 'net credit');
  assert.equal(t.avgExit, 0.7, 'net debit to close');
  assert.equal(t.pnl, 110);
  assert.equal(t.risk, 320, '$5 wide × 100 − $180 credit');
  assert.equal(t.r, 0.34);
});

test('what can be merged: same account and underlying; one symbol on one side, or option contracts', async () => {
  const { run } = await app();
  const problem = list => run(`mergeProblem(${JSON.stringify(list)})`);
  const t = (symbol, direction, extra = {}) => ({ account: '6789', symbol, assetType: symbol.includes(' ') ? 'OPTION' : 'EQUITY', direction, ...extra });
  assert.equal(problem([t('AAPL', 'long')]), 'Pick two or more trades.');
  assert.equal(problem([t('AAPL', 'long'), t('AAPL', 'long')]), '');
  assert.equal(problem([t('AAPL', 'long'), t('AAPL', 'short')]), 'Pick trades on the same side.');
  assert.equal(problem([t('AAPL', 'long'), t('MSFT', 'long')]), 'Pick trades on the same symbol.');
  assert.equal(problem([t('AAPL', 'long'), t('AAPL', 'long', { account: '1111' })]), 'Those trades are in different accounts.');
  assert.equal(problem([t(C245.symbol, 'long'), t(C250.symbol, 'short')]), '', 'a spread');
  assert.equal(problem([t(C245.symbol, 'long'), t('MSFT  261218C00245000', 'short')]), 'Pick trades on the same symbol.');
  assert.equal(problem([t('AAPL', 'long'), t(C250.symbol, 'short')]), "Shares and options can't be one trade yet.");
});

test('spread suggestions: legs that went in as one Schwab order, until they are merged', async () => {
  const fills = [
    fill('l1', '2026-10-06T14:00:00.000Z', 'buy', 1, 4.1, { ...C245, instruction: 'BUY_TO_OPEN', orderId: 'S1' }),
    fill('s1', '2026-10-06T14:00:00.000Z', 'sell', 1, 1.6, { ...C250, instruction: 'SELL_TO_OPEN', orderId: 'S1' }),
    ...TWO,
  ];
  const { run } = await app();
  const suggest = rows => JSON.parse(run(`JSON.stringify(spreadSuggestions(journalTrades(${JSON.stringify(fills)}, [], ${JSON.stringify(rows)})))`));
  const [s, ...rest] = suggest([]);
  assert.equal(rest.length, 0, 'the two stock trades were separate orders');
  assert.equal(s.label, 'AAPL 12/18/26 245/250C');
  assert.deepEqual(s.keys, ['6789|AAPL  261218C00245000|long|2026-10-06T14:00:00.000Z', '6789|AAPL  261218C00250000|short|2026-10-06T14:00:00.000Z']);
  assert.deepEqual(suggest([saved('sp', ['l1', 's1'])]), [], 'merged: nothing to suggest');
});

test('the side is the bet on the stock: calls bought long, puts bought short, verticals by type and debit, time spreads neutral', async () => {
  const opt = (symbol, label) => ({ symbol, label, assetType: 'OPTION' });
  const C245N = opt('AAPL  261120C00245000', 'AAPL 11/20/26 245C');
  const P240 = opt('AAPL  261218P00240000', 'AAPL 12/18/26 240P'), C255 = opt('AAPL  261218C00255000', 'AAPL 12/18/26 255C');
  let n = 0;
  const leg = (side, leg, price = 2) => fill(`f${++n}`, '2026-10-06T14:00:00.000Z', side, 1, price, { ...leg, orderId: 'S' });
  const one = async (legs) => { const fills = legs; const list = await merged(fills, [], [saved('x', fills.map(f => f.id))]); assert.equal(list.length, 1); return list[0]; };

  const singles = await merged([leg('buy', C245), leg('sell', C250), leg('buy', P245), leg('sell', P250), fill('st', '2026-10-06T14:00:00.000Z', 'sell', 10, 50, { symbol: 'TSLA', label: 'TSLA' })], [], []);
  const bias = label => singles.find(t => t.label === label).bias;
  assert.equal(bias('AAPL 12/18/26 245C'), 'long', 'a call bought');
  assert.equal(bias('AAPL 12/18/26 250C'), 'short', 'a call sold');
  assert.equal(bias('AAPL 12/18/26 245P'), 'short', 'a put bought');
  assert.equal(bias('AAPL 12/18/26 250P'), 'long', 'a put sold');
  assert.equal(bias('TSLA'), 'short', 'shares sold short');

  const putDebit = await one([leg('buy', P250, 3), leg('sell', P245, 1.2)]);
  assert.deepEqual([putDebit.structure, putDebit.bias], ['put debit', 'short']);
  const callCredit = await one([leg('sell', C245, 4.1), leg('buy', C250, 1.6)]);
  assert.deepEqual([callCredit.structure, callCredit.bias], ['call credit', 'short']);
  const calendar = await one([leg('sell', C245N, 3), leg('buy', C245, 4)]);
  assert.deepEqual([calendar.structure, calendar.bias, calendar.label], ['time spread', 'neutral', 'AAPL 11/20/26 245C / AAPL 12/18/26 245C']);
  // diagonals go by strikes like a vertical: bought below what's sold = long, for puts and calls
  const P240J = opt('AAPL  270115P00240000', 'AAPL 1/15/27 240P'), P245N = opt('AAPL  261120P00245000', 'AAPL 11/20/26 245P');
  const P250J = opt('AAPL  270115P00250000', 'AAPL 1/15/27 250P'), C200J = opt('AAPL  270115C00200000', 'AAPL 1/15/27 200C');
  const putDiag = await one([leg('buy', P240J, 6), leg('sell', P245N, 3)]);
  assert.deepEqual([putDiag.structure, putDiag.bias], ['put diagonal', 'long'], 'a longer-dated put bought, a shorter-dated put sold above it');
  const rolled = await one([leg('buy', P240J, 6), leg('sell', P245N, 3), leg('sell', P245, 3.5)]);
  assert.deepEqual([rolled.structure, rolled.bias], ['put diagonal', 'long'], 'shorter-dated puts sold again and again against it');
  const bearDiag = await one([leg('buy', P250J, 9), leg('sell', opt('AAPL  261120P00240000', 'AAPL 11/20/26 240P'), 1)]);
  assert.deepEqual([bearDiag.structure, bearDiag.bias], ['put diagonal', 'short'], 'bought above what is sold: a put debit spread over time');
  const pmcc = await one([leg('buy', C200J, 40), leg('sell', C250, 2)]);
  assert.deepEqual([pmcc.structure, pmcc.bias], ['call diagonal', 'long'], "a poor man's covered call");
  const condor = await one([leg('buy', P240, 0.8), leg('sell', P245, 1.5), leg('sell', C250, 1.6), leg('buy', C255, 0.7)]);
  assert.deepEqual([condor.structure, condor.bias], ['', 'neutral'], 'an iron condor: the legs cancel');
});
