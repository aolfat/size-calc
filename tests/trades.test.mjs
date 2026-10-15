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

test('summary and hold time in words', async () => {
  const { run } = await app();
  const s = JSON.parse(run(`JSON.stringify(tradesSummary([{ status: 'win', pnl: 300, r: 1.5 }, { status: 'loss', pnl: -100, r: -1 }, { status: 'win', pnl: 50, r: null }, { status: 'open', pnl: 0, r: null }]))`));
  assert.deepEqual(s, { closed: 3, open: 1, wins: 2, losses: 1, winRate: 66.7, pnl: 250, avgR: 0.25, withR: 2 });
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
  const withOwn = JSON.parse(run(`JSON.stringify(journalTrades(${JSON.stringify([entry, exit])}, ${JSON.stringify(stops)}, { '${key}': { stop: 99.5, hidden: true } }))`))[0];
  assert.equal(withOwn.stop, 99.5);
  assert.equal(withOwn.stopSource, 'yours');
  assert.equal(withOwn.schwabStop, 98);
  assert.equal(withOwn.r, -2);
  assert.equal(withOwn.deleted, true, 'the review\'s hidden column is the delete mark');
  const past = JSON.parse(run(`JSON.stringify(journalTrades(${JSON.stringify([entry, exit])}, ${JSON.stringify(stops)}, { '${key}': { stop: 101 } }))`))[0];
  assert.equal(past.stop, 98, 'a stop of yours past the entry isn\'t used');
  assert.equal(past.ownStopIgnored, true);
  assert.equal(run(`ownStopError(${JSON.stringify(t)}, 101)`), "A long's stop goes below the entry.");
  assert.equal(run(`ownStopError(${JSON.stringify(t)}, 0)`), 'Type a stop price.');
  assert.equal(run(`ownStopError(${JSON.stringify(t)}, 97)`), '');
});
