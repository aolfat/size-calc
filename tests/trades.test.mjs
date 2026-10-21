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
    fill('d', '2026-10-02T15:00:00.000Z', 'sell', 80, 104, { instruction: '' }), // closes the last 50, then 30 short (an instruction that doesn't say it only closes, like a file import's)
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

test('a resting entry: its attached stop counts though it was entered hours before the fill', async () => {
  const child = { orderId: 602, orderType: 'STOP', stopPrice: 95, status: 'FILLED', orderLegCollection: [{ instruction: 'SELL', instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }] };
  const parent = { orderId: 601, orderType: 'LIMIT', enteredTime: '2026-10-01T13:00:00+0000', childOrderStrategies: [child] };
  const fills = [fill('e', '2026-10-01T16:00:00.000Z', 'buy', 100, 100, { orderId: '601' }), fill('x', '2026-10-02T15:00:00.000Z', 'sell', 100, 95)];
  const [t] = await trades(fills, [{ kind: 'order', account: '6789', data: parent }]);
  assert.equal(t.stop, 95, 'attached to the entry, so it counts');
  assert.equal(t.r, -1);
  const [own] = await trades(fills, [{ kind: 'order', account: '6789', data: { ...parent, childOrderStrategies: [{ ...child, enteredTime: '2026-10-01T13:00:00+0000' }] } }]);
  assert.equal(own.stop, 95, 'with its own entered time too');
  const [other] = await trades(fills, [{ kind: 'order', account: '6789', data: { ...parent, orderId: 700 } }]);
  assert.equal(other.stop, null, 'a stop on some other order, entered hours before, is not this trade\'s');
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

test('P&L %: of what the closed part cost, a short of what it took in, an option ×100; none before anything closed', async () => {
  const { run } = await app();
  const pct = list => list.map(t => run(`pnlPct(${JSON.stringify(t)})`));
  const [long] = await trades([fill('a', '2026-10-01T14:30:00.000Z', 'buy', 100, 50), fill('b', '2026-10-02T15:00:00.000Z', 'sell', 100, 52)]);
  const [short] = await trades([fill('s', '2026-10-02T13:35:01.000Z', 'sell', 50, 200, { instruction: 'SELL_SHORT' }), fill('c', '2026-10-02T15:12:30.000Z', 'buy', 50, 210, { instruction: 'BUY_TO_COVER' })]);
  const o = { symbol: 'AAPL  261218C00245000', label: 'AAPL 12/18/26 245C', assetType: 'OPTION' };
  const [option] = await trades([fill('o1', '2026-10-09T14:05:03.000Z', 'buy', 3, 4, { ...o, instruction: 'BUY_TO_OPEN' }), fill('o2', '2026-10-10T15:00:00.000Z', 'sell', 3, 5, { ...o, instruction: 'SELL_TO_CLOSE' })]);
  const [trimmed] = await trades([fill('a', '2026-10-01T14:30:00.000Z', 'buy', 100, 100), fill('b', '2026-10-01T15:00:00.000Z', 'sell', 40, 102)]);
  const [fresh] = await trades([fill('a', '2026-10-01T14:30:00.000Z', 'buy', 100, 100)]);
  const [earlier] = await trades([fill('x', '2026-10-01T15:00:00.000Z', 'sell', 10, 100)]);
  assert.deepEqual(pct([long, short, option, trimmed, fresh, earlier]), [4, -5, 25, 2, null, null]);
  assert.equal(earlier.status, 'history');
  const s = JSON.parse(run(`JSON.stringify(tradesSummary(${JSON.stringify([long, short, option, trimmed])}))`));
  assert.equal(s.avgPct, 8, 'the closed ones averaged, the open one left out');
  assert.equal(s.withPct, 3);
});

test('summary and hold time in words', async () => {
  const { run } = await app();
  const s = JSON.parse(run(`JSON.stringify(tradesSummary([{ status: 'win', pnl: 300, r: 1.5 }, { status: 'loss', pnl: -100, r: -1 }, { status: 'win', pnl: 50, r: null }, { status: 'open', pnl: 0, r: null }]))`));
  assert.deepEqual(s, { avgPct: null, withPct: 0, closed: 3, open: 1, history: 0, wins: 2, losses: 1, winRate: 66.7, pnl: 250, avgR: 0.25, withR: 2, fees: 0, feesMissing: 0 });
  assert.equal(run('holdWords(45 * 60000)'), '45m');
  assert.equal(run('holdWords((3 * 60 + 10) * 60000)'), '3h 10m');
  assert.equal(run('holdWords((52) * 3600000)'), '2d 4h');
  assert.equal(run('holdWords(null)'), '');
});

test('a moved stop: R stays on the first, the move is shown; your stop overrides; one past the entry is ignored', async () => {
  const entry = fill('e', '2026-10-01T14:30:00.000Z', 'buy', 100, 100);
  const exit = fill('x', '2026-10-01T16:00:00.000Z', 'sell', 100, 99);
  const stops = [stopOrder(1, '2026-10-01T14:30:30+0000', 'SELL', 98), stopOrder(2, '2026-10-01T15:00:00+0000', 'SELL', 96), stopOrder(3, '2026-10-01T15:30:00+0000', 'SELL', 100.2)];
  const [t] = await trades([entry, exit], stops);
  assert.equal(t.stop, 98);
  assert.equal(t.r, -0.5, 'widened to 96 and then raised past the entry: R still counts from 98');
  assert.equal(t.movedTo, 100.2, 'the last stop it had');
  assert.equal(t.stopSource, 'schwab');
  assert.deepEqual(t.stopTrail.map(s => s.stopPrice), [98, 96, 100.2], 'every stop on it, oldest first, past the entry included');

  const { run } = await app();
  const key = t.key;
  const withOwn = JSON.parse(run(`JSON.stringify(journalTrades(${JSON.stringify([entry, exit])}, ${JSON.stringify(stops)}, { '${key}': { stop: 99.5, deleted: true } }))`))[0];
  assert.equal(withOwn.stop, 99.5);
  assert.equal(withOwn.stopSource, 'yours');
  assert.equal(withOwn.schwabStop, 98);
  assert.equal(withOwn.r, -2);
  assert.equal(withOwn.deleted, true, 'the review\'s deleted column');
  const past = JSON.parse(run(`JSON.stringify(journalTrades(${JSON.stringify([entry, exit])}, ${JSON.stringify(stops)}, { '${key}': { stop: 101 } }))`))[0];
  assert.equal(past.stop, 98, 'a stop of yours past the entry isn\'t used');
  assert.equal(past.ownStopIgnored, true);
  assert.equal(run(`ownStopError(${JSON.stringify(t)}, 101)`), "A long's stop goes below the entry.");
  assert.equal(run(`ownStopError(${JSON.stringify(t)}, 0)`), 'Type a stop price.');
  assert.equal(run(`ownStopError(${JSON.stringify(t)}, 97)`), '');
});

// Schwab's TRADE transactions: the fill's instrument item, plus one item per fee with a feeType, charged as a negative cost
const tx = (orderId, fees, extra = {}) => ({
  kind: 'transaction', account: '6789',
  data: { activityId: Number(orderId) * 10 + Object.keys(fees).length, type: 'TRADE', orderId, transferItems: [
    { instrument: { symbol: 'AAPL', assetType: 'EQUITY' }, amount: 100, cost: -10000, price: 100, positionEffect: 'OPENING' },
    ...Object.entries(fees).map(([feeType, cost]) => ({ instrument: { symbol: 'CURRENCY_USD', assetType: 'CURRENCY' }, amount: 0, cost, feeType })),
  ], ...extra },
});

test('fees per order: fee items add up, pieces of one order add up, other items and other transactions don\'t count', async () => {
  const { run } = await app();
  const fees = JSON.parse(run(`JSON.stringify([...feesByOrder(${JSON.stringify([
    tx(1, { COMMISSION: -0.65, OPT_REG_FEE: -0.02 }),
    tx(1, { COMMISSION: -1.3 }), // the same order, filled in a second piece
    tx(2, { SEC_FEE: -0.26, TAF_FEE: -0.02 }),
    tx(3, { COMMISSION: 0 }),
    { kind: 'transaction', data: { type: 'DIVIDEND_OR_INTEREST', orderId: 4, transferItems: [{ feeType: 'COMMISSION', cost: -5 }] } },
    { kind: 'order', data: { orderId: 5 } },
  ])})])`));
  assert.deepEqual(fees.map(([k, v]) => [k, Math.round(v * 100) / 100]), [['1', 1.97], ['2', 0.28], ['3', 0]]);
});

test('after fees: P&L, the result and R are net; a flip splits its order\'s fees by quantity; missing ones are counted', async () => {
  const fills = [
    fill('a', '2026-10-01T14:30:00.000Z', 'buy', 100, 100, { orderId: '1' }),
    fill('b', '2026-10-01T15:00:00.000Z', 'sell', 150, 100.02, { orderId: '2', instruction: '' }), // closes 100, opens 50 short
    fill('c', '2026-10-01T15:30:00.000Z', 'buy', 50, 99, { orderId: '3' }),
  ];
  const records = [stopOrder(9, '2026-10-01T14:30:10+0000', 'SELL', 99), tx(1, { COMMISSION: -1 }), tx(2, { COMMISSION: -3 })];
  const { run } = await app();
  const get = after => JSON.parse(run(`JSON.stringify(journalTrades(${JSON.stringify(fills)}, ${JSON.stringify(records)}, {}, { afterFees: ${after} }))`));
  const before = get(false), after = get(true);
  const long = list => list.find(t => t.direction === 'long'), short = list => list.find(t => t.direction === 'short');
  assert.equal(long(before).pnl, 2, 'before fees: 100 × $0.02');
  assert.equal(long(before).status, 'win');
  assert.equal(long(before).fees, 3, 'shown either way: $1 entry + $2 of the $3 flip (100 of its 150 shares)');
  assert.equal(long(after).pnl, -1, 'a $2 win is a $1 loss after $3 of fees');
  assert.equal(long(after).grossPnl, 2);
  assert.equal(long(after).status, 'loss');
  assert.equal(long(after).r, -0.01, 'R on the net: −1 ÷ (100 × $1)');
  assert.equal(short(after).fees, 1, 'the other $1 of the flip');
  assert.equal(short(after).feesMissing, 1, 'its cover (order 3) has no transaction yet');
  assert.equal(short(after).pnl, 50, '50 × $1.02, less its $1');
  const { run: r2 } = await app();
  const s = JSON.parse(r2(`JSON.stringify(tradesSummary(${JSON.stringify(after)}))`));
  assert.equal(s.fees, 4);
  assert.equal(s.feesMissing, 1);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
});

test('a close with nothing open was opened before the history: its own trade, out of the stats, never a flip', async () => {
  const list = await trades([
    fill('s1', '2026-10-01T14:30:00.000Z', 'sell', 60, 50), // sold shares bought before the 60 days
    fill('s2', '2026-10-01T14:40:00.000Z', 'sell', 40, 51),
    fill('b', '2026-10-02T14:30:00.000Z', 'buy', 100, 48),
    fill('x', '2026-10-03T14:30:00.000Z', 'sell', 150, 49), // 100 of this trade, 50 more than the history holds
    fill('c', '2026-10-04T14:30:00.000Z', 'buy', 20, 30, { instruction: 'BUY_TO_COVER' }), // a short from before
  ]);
  const hist = list.filter(t => t.status === 'history');
  assert.deepEqual(hist.map(t => [t.direction, t.entryQty, Math.round(t.avgExit * 100) / 100]).sort(), [['long', 100, 50.4], ['long', 50, 49], ['short', 20, 30]].sort(),
    'the two sells from flat are one trade; the extra 50 and the cover are their own');
  assert.ok(hist.every(t => t.pnl === 0 && t.avgEntry === 0 && t.r === null && t.stop === null), 'entry and P&L unknown');
  assert.match(hist.find(t => t.entryQty === 100).key, /^6789\|AAPL\|long\|before\|2026-10-01T14:30:00\.000Z$/, 'a stable key, so a delete sticks');
  const real = list.filter(t => t.status !== 'history');
  assert.equal(real.length, 1, 'no made-up short');
  assert.equal(real[0].pnl, 100);
  const { run } = await app();
  const s = JSON.parse(run(`JSON.stringify(tradesSummary(${JSON.stringify(list)}))`));
  assert.deepEqual([s.closed, s.open, s.history, s.pnl], [1, 0, 3, 100], 'history trades never count');
});

test('an option still open after its expiry closes at $0 at 4pm New York; before then it stays open', async () => {
  const o = { symbol: 'AAPL  261016C00245000', label: 'AAPL 10/16/26 245C', assetType: 'OPTION' };
  const longCall = [fill('o', '2026-10-09T14:05:03.000Z', 'buy', 2, 1.5, { ...o, instruction: 'BUY_TO_OPEN' })];
  const shortPut = [fill('p', '2026-10-09T14:05:03.000Z', 'sell', 1, 0.8, { ...o, symbol: 'AAPL  261016P00230000', label: 'AAPL 10/16/26 230P', instruction: 'SELL_TO_OPEN' })];
  const { run } = await app();
  const at = (fills, now) => JSON.parse(run(`JSON.stringify(journalTrades(${JSON.stringify(fills)}, [], {}, { now: ${now} }))`))[0];
  const close = Date.parse('2026-10-16T20:00:00.000Z'); // 4pm EDT
  assert.equal(at(longCall, close - 1).status, 'open', 'not before the close');
  const t = at(longCall, close + 1);
  assert.equal(t.expired, true);
  assert.equal(t.status, 'loss');
  assert.equal(t.pnl, -300, '2 × $1.50 × 100, the whole premium');
  assert.equal(t.avgExit, 0);
  assert.equal(t.closedAt, '2026-10-16T20:00:00.000Z');
  assert.equal(t.r, -1, 'premium risk: −1R');
  const p = at(shortPut, close + 1);
  assert.equal(p.status, 'win');
  assert.equal(p.pnl, 80, 'a sold option kept its premium');
  assert.equal(at(longCall, undefined)?.status, 'open', 'no clock, no expiry');
});

// ---------- spreads ----------
const leg = (id, orderId, time, side, qty, price, symbol, instruction) => fill(id, time, side, qty, price, {
  orderId, symbol, label: `AAPL 12/18/26 ${Number(symbol.slice(-8)) / 1000}${symbol.at(-9)}`, assetType: 'OPTION', instruction,
});
const C245 = 'AAPL  261218C00245000', C255 = 'AAPL  261218C00255000';

test('a multi-leg order is one spread: net debit, legs summed, the debit is its risk', async () => {
  const list = await trades([
    leg('a', '700', '2026-10-01T14:30:00.000Z', 'buy', 3, 6.2, C245, 'BUY_TO_OPEN'),
    leg('b', '700', '2026-10-01T14:30:00.000Z', 'sell', 3, 2.7, C255, 'SELL_TO_OPEN'),
    leg('c', '701', '2026-10-08T15:00:00.000Z', 'sell', 3, 8.1, C245, 'SELL_TO_CLOSE'),
    leg('d', '701', '2026-10-08T15:00:00.000Z', 'buy', 3, 3.3, C255, 'BUY_TO_CLOSE'),
  ]);
  assert.equal(list.length, 1, 'one trade, not two');
  const [t] = list;
  assert.equal(t.label, 'AAPL 12/18/26 245/255C');
  assert.equal(t.spreadKind, 'debit');
  assert.equal(t.group, 'auto');
  assert.equal(t.entryQty, 3);
  assert.equal(t.avgEntry.toFixed(2), '3.50', '6.20 − 2.70 paid per spread');
  assert.equal(t.avgExit.toFixed(2), '4.80', '8.10 − 3.30 taken back');
  assert.equal(t.pnl, 390, '+570 on the long leg, −180 on the short');
  assert.equal(t.rBasis, 'debit');
  assert.equal(t.risk, 1050);
  assert.equal(t.r, 0.37);
  assert.equal(t.key, '6789|AAPL|spread|2026-10-01T14:30:00.000Z');
  assert.equal(t.legs.length, 2);
  const { run } = await app();
  assert.equal(run(`legWords(${JSON.stringify(t.legs)})`), '+3 245C −3 255C');
});

test('a credit vertical risks its width less the credit; your trades rows combine and split over the order', async () => {
  const legged = [
    leg('s', '710', '2026-10-01T14:30:00.000Z', 'sell', 2, 4.0, C245, 'SELL_TO_OPEN'), // legged in: two orders
    leg('l', '711', '2026-10-01T14:35:00.000Z', 'buy', 2, 1.5, C255, 'BUY_TO_OPEN'),
  ];
  const apart = await trades(legged);
  assert.equal(apart.length, 2, 'separate orders stay separate trades');
  const { run } = await app();
  const row = (id, fillIds) => ({ id, account: '6789', fill_ids: fillIds, created_at: '2026-10-02T00:00:00.000Z' });
  const joined = JSON.parse(run(`JSON.stringify(journalTrades(${JSON.stringify(legged)}, [], {}, { saved: ${JSON.stringify([row('g1', ['s', 'l'])])} }))`));
  assert.equal(joined.length, 1);
  const [t] = joined;
  assert.equal(t.group, 'yours');
  assert.equal(t.spreadKind, 'credit');
  assert.equal(t.avgEntry.toFixed(2), '2.50', 'took in 4.00 − 1.50');
  assert.equal(t.rBasis, 'width');
  assert.equal(t.risk, 1500, '(10 wide − 2.50) × 2 × 100');
  assert.equal(t.status, 'open');

  const oneOrder = legged.map(f => ({ ...f, orderId: '720' }));
  const auto = JSON.parse(run(`JSON.stringify(journalTrades(${JSON.stringify(oneOrder)}, []))`));
  assert.equal(auto.length, 1, 'one order: combined on its own');
  const solo = JSON.parse(run(`JSON.stringify(journalTrades(${JSON.stringify(oneOrder)}, [], {}, { saved: ${JSON.stringify([row('s1', ['s']), row('s2', ['l'])])} }))`));
  assert.equal(solo.length, 2, 'split: a row per leg keeps them apart');
});

test('combine candidates: other legs on the same underlying and account that overlap in time', async () => {
  const fills = [
    leg('a', '1', '2026-10-01T14:30:00.000Z', 'buy', 1, 5, C245, 'BUY_TO_OPEN'),
    leg('b', '2', '2026-10-02T14:30:00.000Z', 'sell', 1, 2, C255, 'SELL_TO_OPEN'), // overlaps a
    leg('c', '3', '2026-10-05T14:30:00.000Z', 'sell', 1, 6, C245, 'SELL_TO_CLOSE'), // a closes 10/5
    leg('d', '4', '2026-10-09T14:30:00.000Z', 'buy', 1, 3, 'AAPL  261218P00230000', 'BUY_TO_OPEN'), // after a closed
    fill('e', '2026-10-02T14:30:00.000Z', 'buy', 100, 240), // the stock
    { ...leg('f', '6', '2026-10-02T14:30:00.000Z', 'buy', 1, 1, 'MSFT  261218C00500000', 'BUY_TO_OPEN'), label: 'MSFT 12/18/26 500C' },
  ];
  const { run } = await app();
  const all = JSON.parse(run(`JSON.stringify(journalTrades(${JSON.stringify(fills)}, []))`));
  const a = all.find(t => t.symbol === C245);
  const c = JSON.parse(run(`JSON.stringify(combineCandidates(${JSON.stringify(all)}, '${a.key}'))`));
  assert.deepEqual(c.map(t => t.symbol), [C255], 'not the later put, the stock, or MSFT');
});

// ---------- merged trades: trades you said are one, kept as their fills in Supabase's trades table ----------

const C245o = { symbol: 'AAPL  261218C00245000', label: 'AAPL 12/18/26 245C', assetType: 'OPTION' };
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
  return JSON.parse(run(`JSON.stringify(journalTrades(${JSON.stringify(fills)}, ${JSON.stringify(records)}, {}, { saved: ${JSON.stringify(rows)} }))`));
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
    fill('l1', '2026-10-06T14:00:00.000Z', 'buy', 2, 4.1, { ...C245o, instruction: 'BUY_TO_OPEN', orderId: 'S1' }),
    fill('s1', '2026-10-06T14:00:00.000Z', 'sell', 2, 1.6, { ...C250, instruction: 'SELL_TO_OPEN', orderId: 'S1' }),
    fill('l2', '2026-10-09T15:00:00.000Z', 'sell', 2, 6, { ...C245o, instruction: 'SELL_TO_CLOSE', orderId: 'S2' }),
    fill('s2', '2026-10-09T15:00:00.000Z', 'buy', 2, 2.5, { ...C250, instruction: 'BUY_TO_CLOSE', orderId: 'S2' }),
  ];
  const [t] = await merged(fills, [], [saved('sp', ['l1', 's1'])]);
  assert.equal(t.kind, 'spread');
  assert.equal(t.label, 'AAPL 12/18/26 245/250C');
  assert.equal(t.spreadKind, 'debit', 'paid to open');
  assert.equal(t.group, 'yours');
  assert.equal(t.bias, 'long', 'a call debit spread is long');
  assert.equal(t.structure, 'call debit');
  assert.equal(t.entryQty, 2, 'two spreads');
  assert.equal(t.avgEntry.toFixed(2), '2.50', 'net debit per spread');
  assert.equal(t.avgExit.toFixed(2), '3.50', 'net credit per spread at the close');
  assert.equal(t.pnl, 200, '+380 on the 245C, −180 on the 250C');
  assert.equal(t.multiplier, 100);
  assert.equal(t.rBasis, 'debit');
  assert.equal(t.risk, 500, 'the debit is all it can lose');
  assert.equal(t.r, 0.4);
  const { run } = await app();
  assert.equal(run(`pnlPct(${JSON.stringify(t)})`), 40, 'P&L % of the debit paid');
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
  assert.equal(t.spreadKind, 'credit', 'received to open');
  assert.equal(t.bias, 'long', 'a put credit spread is long');
  assert.equal(t.structure, 'put credit');
  assert.equal(t.avgEntry.toFixed(2), '1.80', 'net credit');
  assert.equal(t.avgExit.toFixed(2), '0.70', 'net debit to close');
  assert.equal(t.pnl, 110);
  assert.equal(t.rBasis, 'width');
  assert.equal(t.risk, 320, '$5 wide × 100 − $180 credit');
  assert.equal(t.r, 0.34);
  const { run } = await app();
  assert.equal(run(`pnlPct(${JSON.stringify(t)})`), 34.375, 'P&L % of what it risked, not of the credit');
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
  assert.equal(problem([t(C245o.symbol, 'long'), t(C250.symbol, 'short')]), '', 'a spread');
  assert.equal(problem([t(C245o.symbol, 'long'), t('MSFT  261218C00245000', 'short')]), 'Pick trades on the same symbol.');
  assert.equal(problem([t('AAPL', 'long'), t(C250.symbol, 'short')]), "Shares and options can't be one trade yet.");
  assert.equal(problem([t('AAPL', 'long'), t('AAPL', 'long', { status: 'history' })]), "Trades from before your history can't be merged.");
  assert.equal(problem([t('AAPL', 'long'), t('AAPL', 'long', { deleted: true })]), 'Restore deleted trades before merging them.');
  assert.equal(problem([t('AAPL', 'long', { assetType: 'SPREAD' }), t(C250.symbol, 'short')]), '', 'a leg added to a spread');
});

test('a multi-leg order is a spread on its own, and a row with one of its legs keeps that leg apart', async () => {
  const fills = [
    fill('l1', '2026-10-06T14:00:00.000Z', 'buy', 1, 4.1, { ...C245o, instruction: 'BUY_TO_OPEN', orderId: 'S1' }),
    fill('s1', '2026-10-06T14:00:00.000Z', 'sell', 1, 1.6, { ...C250, instruction: 'SELL_TO_OPEN', orderId: 'S1' }),
  ];
  const [auto] = await merged(fills, [], []);
  assert.deepEqual([auto.kind, auto.group, auto.bias, auto.structure], ['spread', 'auto', 'long', 'call debit']);
  assert.deepEqual(auto.savedIds, [], 'no row behind it');
  const apart = await merged(fills, [], [saved('solo1', ['l1']), saved('solo2', ['s1'])]);
  assert.deepEqual(apart.map(t => [t.kind, t.savedIds[0]]).sort(), [['single', 'solo1'], ['single', 'solo2']]);
});
