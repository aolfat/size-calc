// Run with: node --test
// A position's cost after an add and a trim: the whole position's average (the Journal's), not Schwab's oldest-first figure,
// and the breakevens a stop can go to once it's been trimmed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

const connected = () => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }])],
  ['schwab_account', 'HASH1'],
]);

const ago = d => new Date(Date.now() - d * DAY).toISOString().replace('Z', '+0000');
const exec = (orderId, instruction, qty, price, time) => ({ orderId, enteredTime: time, status: 'FILLED', orderType: 'MARKET', orderStrategyType: 'SINGLE',
  orderLegCollection: [{ legId: 1, instruction, quantity: qty, instrument: { symbol: 'TEST', assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: orderId * 10, executionLegs: [{ legId: 1, quantity: qty, price, time }] }] });
// 100 at $10, 100 more at $12 (average $11), then 100 sold at $13: 100 left
const FILLS = [exec(1, 'BUY', 100, 10, ago(5)), exec(2, 'BUY', 100, 12, ago(4)), exec(3, 'SELL', 100, 13, ago(3))];
// Schwab drops the oldest shares first on a trim, so it shows the add's $12
const ACCOUNT = { securitiesAccount: { currentBalances: { liquidationValue: 100000, cashBalance: 5000 },
  positions: [{ longQuantity: 100, shortQuantity: 0, averagePrice: 12, averageLongPrice: 12, marketValue: 1400, instrument: { assetType: 'EQUITY', symbol: 'TEST' } }] } };

const held = (mark, schwabAvg = 12) => ({ securitiesAccount: { currentBalances: { liquidationValue: 100000, cashBalance: 5000 },
  positions: [{ longQuantity: 100, shortQuantity: 0, averagePrice: schwabAvg, averageLongPrice: schwabAvg, marketValue: 100 * mark, instrument: { assetType: 'EQUITY', symbol: 'TEST' } }] } });
const stopAt = (orderId, px) => ({ orderId, orderType: 'STOP', status: 'WORKING', orderStrategyType: 'SINGLE', session: 'NORMAL', duration: 'GOOD_TILL_CANCEL', stopPrice: px,
  quantity: 100, remainingQuantity: 100, orderLegCollection: [{ instruction: 'SELL', quantity: 100, instrument: { symbol: 'TEST', assetType: 'EQUITY' } }] });

function broker(orders = FILLS, acct = ACCOUNT) {
  const sent = [];
  const fetch = async (url, init = {}) => {
    const path = url.slice(PROXY.length), method = init.method || 'GET';
    if (method === 'GET') return path.includes('/orders?') ? json(orders) : path.endsWith('?fields=positions') ? json(acct) : json({}, 404);
    sent.push({ method, path, body: init.body ? JSON.parse(init.body) : null });
    return new Response(null, { status: 201, headers: { Location: `${PROXY}/trader/v1/accounts/HASH1/orders/900` } });
  };
  return { fetch, sent };
}

const fill = (id, side, qty, price, t, instruction = side === 'buy' ? 'BUY' : 'SELL') =>
  ({ id, orderId: String(id), account: '6789', time: `2026-10-0${t}T14:00:00Z`, symbol: 'TEST', label: 'TEST', assetType: 'EQUITY', instruction, side, qty, price });

test('a Journal trade keeps the whole position\'s average through a trim, and the lots left oldest-sold-first', async () => {
  const { run } = await app();
  const [t] = run(`buildTrades(${JSON.stringify([fill(1, 'buy', 100, 10, 1), fill(2, 'buy', 100, 12, 2), fill(3, 'sell', 100, 13, 3)])})`);
  assert.equal(t.status, 'open');
  assert.equal(t.costAvg, 11, 'the add averages in, the trim leaves it');
  assert.equal(t.lotsAvg, 12, 'the $10 lot went first');
  // an add after the trim averages in with what's held, not with what was sold
  const [u] = run(`buildTrades(${JSON.stringify([fill(1, 'buy', 100, 10, 1), fill(2, 'sell', 50, 13, 2), fill(3, 'buy', 50, 14, 3)])})`);
  assert.equal(u.costAvg, 12);
  assert.equal(u.lotsAvg, 12);
  const [closed] = run(`buildTrades(${JSON.stringify([fill(1, 'buy', 100, 10, 1), fill(2, 'sell', 100, 13, 2)])})`);
  assert.equal(closed.costAvg, undefined, 'a closed trade has none');
});

test('journalCost: the average, the lots and the whole-trade-even price, only when the Journal holds what Schwab does', async () => {
  const { run } = await app();
  const trade = { costAvg: 11, lotsAvg: 12, avgEntry: 11, entryQty: 200, openQty: 100, avgExit: 13 };
  assert.deepEqual(run(`journalCost(${JSON.stringify(trade)}, 100)`), { avg: 11, lots: 12, net: 9, trimmed: true });
  assert.equal(run(`journalCost(${JSON.stringify(trade)}, 150)`), null, 'another quantity: Schwab\'s figure stays');
  // a short: sold 200 at an average of $50, bought back 100 at $45
  assert.equal(run(`journalCost(${JSON.stringify({ costAvg: 50, lotsAvg: 50, avgEntry: 50, entryQty: 200, openQty: 100, avgExit: 45 })}, 100)`).net, 55);
});

test('Positions shows the whole position\'s average with Schwab\'s figure under it, and counts P/L and the breakeven from it', async () => {
  const { run, elements, state } = await app({ fetch: broker().fetch, storage: connected() });
  run("setView('positions')");
  await settle();
  const row = state.positions.rows.find(r => r.symbol === 'TEST');
  assert.equal(row.avg, 11);
  assert.equal(row.schwabAvg, 12);
  assert.equal(row.be, 11);
  assert.equal(row.pnl, 300, '100 at $14 over $11');
  assert.match(elements.get('positionsSection').innerHTML, /\$11\.00<span class="pos-sub" title="Your whole position&#39;s average cost[^"]*">Schwab \$12\.00<\/span>/);
});

test('without a matching Journal trade the row keeps Schwab\'s average', async () => {
  // the orders only hold the add and the trim: the first 100 is older than Schwab's 59 days
  const { run, state } = await app({ fetch: broker(FILLS.slice(1)).fetch, storage: connected() });
  run("setView('positions')");
  await settle();
  const row = state.positions.rows.find(r => r.symbol === 'TEST');
  assert.equal(row.avg, 12);
  assert.equal(row.cost, null);
  assert.deepEqual(run(`breakevenChoices(state.positions.rows[0])`), []);
});

test('after a trim the breakeven stop asks which breakeven: the average, the last lots or the whole trade even', async () => {
  const b = broker();
  const { run, elements, state } = await app({ fetch: b.fetch, storage: connected() });
  run("setView('positions')");
  await settle();
  const choices = run(`breakevenChoices(state.positions.rows[0])`);
  assert.deepEqual(choices.map(c => [c.key, c.price, c.trade]), [['avg', 11, 200], ['lots', 12, 300], ['net', 9, 0]]);
  await run("openPositionTrade('TEST', 'breakeven')");
  const html = () => elements.get('posTradeBody').innerHTML;
  assert.match(html(), /Average cost \$11\.00<\/strong><span>[^<]*The whole trade \+\$200\.00 if it stops here\./);
  assert.match(html(), /Last lots \$12\.00<\/strong><span>[^<]*Schwab&#39;s way\. The whole trade \+\$300\.00/);
  assert.match(html(), /Scratch the trade \$9\.00<\/strong><span>[^<]*The whole trade \$0\.00/);
  assert.equal(state.posTicket.stop, 11, 'the average by default');
  run("setPositionBeAt('net')");
  assert.equal(state.posTicket.stop, 9);
  assert.match(html(), /class="pos-loss">−\$200\.00<\/span><span class="shares-detail">Exactly the whole trade even\. From your average cost \$11\.00/);
  await run('placePositionTrade()');
  const placed = b.sent.find(s => s.method === 'POST');
  assert.equal(placed.body.stopPrice, 9);
  assert.equal(placed.body.orderLegCollection[0].quantity, 100);
});

test('the Stop sheet offers a chip for each breakeven after a trim', async () => {
  const { run, elements } = await app({ fetch: broker().fetch, storage: connected() });
  run("setView('positions')");
  await settle();
  await run("openPositionTrade('TEST', 'stop')");
  const html = elements.get('posTradeBody').innerHTML;
  assert.match(html, /data-arg="11"[^>]*>Breakeven \$11\.00/);
  assert.match(html, /data-arg="12"[^>]*>Last lots \$12\.00/);
  assert.match(html, /data-arg="9"[^>]*>Scratch \$9\.00/);
});

test('with the price under the average, the breakeven stop starts on the one that can still work', async () => {
  const { run, elements, state } = await app({ fetch: broker(FILLS, held(10.5)).fetch, storage: connected() });
  run("setView('positions')");
  await settle();
  await run("openPositionTrade('TEST', 'breakeven')");
  assert.equal(state.posTicket.error, '');
  assert.equal(state.posTicket.beAt, 'net');
  assert.equal(state.posTicket.stop, 9);
  const html = elements.get('posTradeBody').innerHTML;
  assert.match(html, /data-arg="avg" disabled><strong>Average cost \$11\.00<\/strong><span>The price \$10\.50 is already through it\.</);
  assert.match(html, /aria-pressed="true" data-action="setPositionBeAt" data-arg="net">/);
});

test('a stop at the average leaves the BE stop button while Last lots is tighter', async () => {
  const { run, elements } = await app({ fetch: broker([...FILLS, stopAt(9, 11.2)], held(14)).fetch, storage: connected() });
  run("setView('positions')");
  await settle();
  const row = elements.get('positionsSection').innerHTML.split('<tr>').find(r => r.includes('<b>TEST</b>'));
  assert.match(row, /data-arg2="breakeven"/);
  await run("openPositionTrade('TEST', 'breakeven')");
  assert.equal(run('posTicket.beAt'), 'lots', 'the average and the scratch are already covered');
  assert.equal(run('posTicket.stop'), 12);
  // a stop at the last lots covers every breakeven: nothing left to move
  const done = await app({ fetch: broker([...FILLS, stopAt(9, 12)], held(14)).fetch, storage: connected() });
  done.run("setView('positions')");
  await settle();
  assert.doesNotMatch(done.elements.get('positionsSection').innerHTML, /data-arg2="breakeven"/);
});

test('a spread\'s legs keep Schwab\'s cost', async () => {
  const { run } = await app();
  const C = 'TEST  261218C00050000', P = 'TEST  261218C00060000';
  const leg = (symbol, instruction, price, time, id) => ({ id: String(id), orderId: String(id), account: '6789', time, symbol, label: symbol, assetType: 'OPTION', instruction, side: /BUY/.test(instruction) ? 'buy' : 'sell', qty: 1, price });
  const trades = run(`buildTrades(${JSON.stringify([leg(C, 'BUY_TO_OPEN', 3, '2026-10-01T14:00:00Z', 1), leg(P, 'SELL_TO_OPEN', 1, '2026-10-02T14:00:00Z', 2)])})`);
  const acct = { currentBalances: { liquidationValue: 100000 }, positions: [
    { longQuantity: 1, shortQuantity: 0, averageLongPrice: 2.5, marketValue: 400, instrument: { assetType: 'OPTION', symbol: C, putCall: 'CALL', underlyingSymbol: 'TEST' } },
    { longQuantity: 0, shortQuantity: 1, averageShortPrice: 0.8, marketValue: -150, instrument: { assetType: 'OPTION', symbol: P, putCall: 'CALL', underlyingSymbol: 'TEST' } }] };
  const out = run(`positionRows(${JSON.stringify(acct)}, [], { trades: ${JSON.stringify(trades)}, last4: '6789' })`);
  assert.equal(out.spreads.length, 1);
  assert.deepEqual(out.rows.map(r => [r.avg, r.cost]), [[2.5, null], [0.8, null]]);
});
