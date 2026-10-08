// Run with: node --test
// Position trades: a breakeven stop or a market close for one Schwab position, planned purely, reviewed, sent once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const json = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const plain = v => JSON.parse(JSON.stringify(v));

const connected = () => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }])],
  ['schwab_account', 'HASH1'],
]);

const OPT = 'AAPL  261120C00230000';
const pos = (symbol, qty, avg, mark, instrument = {}) => ({
  longQuantity: qty > 0 ? qty : 0, shortQuantity: qty < 0 ? -qty : 0, averagePrice: avg,
  marketValue: qty * mark * (instrument.assetType === 'OPTION' ? 100 : 1), instrument: { assetType: 'EQUITY', symbol, ...instrument },
});
const POSITIONS = [
  pos('HOOD', 300, 38.2, 41.1),
  pos('TSLA', -40, 262, 255.3),
  pos(OPT, 2, 4.83, 6.1, { assetType: 'OPTION', putCall: 'CALL', underlyingSymbol: 'AAPL' }),
  pos('NVDA', 150, 118.4, 112),
  pos('SWVXX', 500, 1, 1, { assetType: 'CASH_EQUIVALENT' }),
  pos('QQQ', 10, 400, 480, { assetType: 'COLLECTIVE_INVESTMENT', type: 'EXCHANGE_TRADED_FUND' }),
];
const leg = (instruction, quantity, symbol, assetType = 'EQUITY') => ({ instruction, quantity, instrument: { symbol, assetType } });
const stopOrder = (orderId, symbol, instruction, qty, stopPrice) => ({ orderId, orderType: 'STOP', status: 'WORKING', orderStrategyType: 'SINGLE', stopPrice, quantity: qty, remainingQuantity: qty, orderLegCollection: [leg(instruction, qty, symbol)] });
const ORDERS = [
  // the app's own trade: the stop is the working child of a filled trigger
  { orderId: 100, orderType: 'MARKET', status: 'FILLED', orderStrategyType: 'TRIGGER', orderLegCollection: [leg('BUY', 250, 'HOOD')], childOrderStrategies: [stopOrder(101, 'HOOD', 'SELL', 250, 35.5)] },
  stopOrder(102, 'HOOD', 'SELL', 50, 34),
  { orderId: 103, orderType: 'LIMIT', status: 'WORKING', orderStrategyType: 'SINGLE', price: 45, quantity: 300, remainingQuantity: 300, orderLegCollection: [leg('SELL', 300, 'HOOD')] },
  stopOrder(201, 'TSLA', 'BUY_TO_COVER', 40, 270),
  stopOrder(401, 'QQQ', 'SELL', 10, 400),
];

// a fake Schwab account that changes as orders arrive, so the re-read after sending tells the truth
function broker({ refuse = () => null } = {}) {
  const live = { positions: plain(POSITIONS), orders: plain(ORDERS), nextId: 900 };
  const sent = [];
  const all = () => live.orders.flatMap(o => [o, ...(o.childOrderStrategies || [])]);
  const fetch = async (url, init = {}) => {
    if (!url.startsWith(PROXY)) throw new Error('Unexpected request ' + url);
    const path = url.slice(PROXY.length);
    const method = init.method || 'GET';
    if (method === 'GET') {
      if (path.includes('/orders?')) return json(live.orders);
      if (path.endsWith('?fields=positions')) return json({ securitiesAccount: { currentBalances: { liquidationValue: 100000, cashBalance: 5000 }, positions: live.positions } });
      return json({}, 404);
    }
    const call = { method, path: path.replace('/trader/v1/accounts/HASH1', ''), body: init.body ? JSON.parse(init.body) : null };
    sent.push(call);
    const refused = refuse(call);
    if (refused) return refused;
    const id = Number(call.path.split('/')[2]);
    if (method === 'DELETE') { all().find(o => o.orderId === id).status = 'CANCELED'; return new Response(null, { status: 200 }); }
    const orderId = live.nextId++;
    if (method === 'PUT') all().find(o => o.orderId === id).status = 'CANCELED';
    if (call.body.orderType === 'MARKET') {
      const symbol = call.body.orderLegCollection[0].instrument.symbol;
      live.positions = live.positions.filter(p => p.instrument.symbol !== symbol); // filled at once
    } else live.orders.push({ ...call.body, orderId, status: 'WORKING' });
    return new Response(null, { status: 201, headers: { Location: `${PROXY}/trader/v1/accounts/HASH1/orders/${orderId}` } });
  };
  return { fetch, sent, live };
}

const rowsFor = run => run(`positionRows({ currentBalances: { liquidationValue: 100000 }, positions: ${JSON.stringify(POSITIONS)} }, ${JSON.stringify(ORDERS)}).rows`);
const rowOf = (run, symbol) => `positionRows({ currentBalances: { liquidationValue: 100000 }, positions: ${JSON.stringify(POSITIONS)} }, ${JSON.stringify(ORDERS)}).rows.find(r => r.symbol === '${symbol}')`;

// ---------- orders and plans ----------

test('option stops use steps every option accepts, rounded toward the market', async () => {
  const { run } = await app();
  assert.equal(run('optionStopTick(4.83, true)'), 4.9, '$0.10 steps from $3');
  assert.equal(run('optionStopTick(4.83, false)'), 4.8);
  assert.equal(run('optionStopTick(1.22, true)'), 1.25, '$0.05 steps under $3');
  assert.equal(run('optionStopTick(2.98, true)'), 3);
  assert.equal(run('optionStopTick(2.5, true)'), 2.5, 'a price on the step stays put');
  assert.deepEqual(['EQUITY true', 'EQUITY false', 'OPTION true', 'OPTION false'].map(a => run(`closingInstruction('${a.split(' ')[0]}', ${a.split(' ')[1]})`)), ['SELL', 'BUY_TO_COVER', 'SELL_TO_CLOSE', 'BUY_TO_CLOSE']);
});

test('a breakeven stop cancels the other stops, then replaces the nearest one for the whole position', async () => {
  const { run } = await app();
  const plan = plain(run(`breakevenPlan(${rowOf(run, 'HOOD')}, 'GOOD_TILL_CANCEL')`));
  assert.equal(plan.error, '');
  assert.equal(plan.stop, 38.2);
  assert.deepEqual(plan.steps.map(s => [s.kind, s.orderId]), [['cancel', 102], ['replace', 101]], 'the limit target is left alone');
  assert.deepEqual(plan.steps[1].order, {
    orderType: 'STOP', session: 'NORMAL', duration: 'GOOD_TILL_CANCEL', orderStrategyType: 'SINGLE', stopPrice: 38.2,
    orderLegCollection: [{ instruction: 'SELL', quantity: 300, instrument: { symbol: 'HOOD', assetType: 'EQUITY' } }],
  });
  const short = plain(run(`breakevenPlan(${rowOf(run, 'TSLA')}, 'DAY')`));
  assert.deepEqual(short.steps.map(s => [s.kind, s.orderId]), [['replace', 201]]);
  assert.equal(short.steps[0].order.orderLegCollection[0].instruction, 'BUY_TO_COVER');
  assert.equal(short.steps[0].order.stopPrice, 262);
  assert.equal(short.steps[0].order.duration, 'DAY');
});

test('an option with no stop gets a new one on the option, at or above its cost', async () => {
  const { run } = await app();
  const plan = plain(run(`breakevenPlan(${rowOf(run, OPT)}, 'GOOD_TILL_CANCEL')`));
  assert.deepEqual(plan.steps.map(s => s.kind), ['place']);
  assert.equal(plan.stop, 4.9);
  assert.deepEqual(plan.steps[0].order.orderLegCollection, [{ instruction: 'SELL_TO_CLOSE', quantity: 2, instrument: { symbol: OPT, assetType: 'OPTION' } }]);
});

test('a breakeven stop is refused when it would fire at once, has no cost, or is already there', async () => {
  const { run } = await app();
  assert.match(run(`breakevenPlan(${rowOf(run, 'NVDA')}, 'DAY').error`), /\$112\.00 is at or below the breakeven stop \$118\.40/);
  assert.match(run(`breakevenPlan(${rowOf(run, 'SWVXX')}, 'DAY').error`), /stocks, ETFs and options/);
  assert.match(run(`breakevenPlan(${rowOf(run, 'QQQ')}, 'DAY').error`), /already at breakeven/);
  assert.match(run(`breakevenPlan({ ...${rowOf(run, 'HOOD')}, avg: 0 }, 'DAY').error`), /no cost basis/);
  assert.match(run(`breakevenPlan({ ...${rowOf(run, 'HOOD')}, qty: 2.5 }, 'DAY').error`), /Fractional/);
});

test('closing cancels every order that would close the position, then sells it at market', async () => {
  const { run } = await app();
  const plan = plain(run(`closePlan(${rowOf(run, 'HOOD')})`));
  assert.deepEqual(plan.steps.map(s => [s.kind, s.orderId ?? null]), [['cancel', 101], ['cancel', 102], ['cancel', 103], ['place', null]]);
  assert.deepEqual(plan.steps[3].order, {
    orderType: 'MARKET', session: 'NORMAL', duration: 'DAY', orderStrategyType: 'SINGLE',
    orderLegCollection: [{ instruction: 'SELL', quantity: 300, instrument: { symbol: 'HOOD', assetType: 'EQUITY' } }],
  });
  assert.equal(run(`closePlan(${rowOf(run, OPT)}).steps[0].order.orderLegCollection[0].instruction`), 'SELL_TO_CLOSE');
  assert.equal(run(`closePlan(${rowOf(run, 'TSLA')}).steps[1].order.orderLegCollection[0].instruction`), 'BUY_TO_COVER');
  assert.match(run(`closePlan(${rowOf(run, 'SWVXX')}).error`), /stocks, ETFs and options/);
});

// ---------- the table and the sheet ----------

test('stock, ETF and option rows get trade buttons; a stop already at breakeven says so', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run('refreshPositions()');
  const html = elements.get('positionsSection').innerHTML;
  const cell = symbol => html.split('<tr>').find(r => r.includes(`>${symbol}<`) || r.includes(`>${symbol} `)) || '';
  for (const s of ['HOOD', 'TSLA', 'NVDA']) assert.match(cell(s), /data-action="openPositionTrade" data-arg="[^"]+" data-arg2="breakeven"/, s);
  assert.match(cell('AAPL'), new RegExp(`data-arg="${OPT}" data-arg2="close"`));
  assert.doesNotMatch(cell('SWVXX'), /openPositionTrade/);
  assert.match(cell('QQQ'), /stop at breakeven/);
  assert.doesNotMatch(cell('QQQ'), /data-arg2="breakeven"/);
  assert.match(cell('QQQ'), /data-arg2="close"/);
});

test('the breakeven review re-reads Schwab, then sends each step once in order and confirms what Schwab shows', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('HOOD', 'breakeven')");
  assert.equal(elements.get('posTradeSheet').style.display, '');
  const review = elements.get('posTradeBody').innerHTML;
  assert.match(review, /Cancel stop \$34\.00 for 50 shares/);
  assert.match(review, /Replace stop \$35\.50 for 250 shares with stop \$38\.20 for 300 shares/);
  assert.match(review, /data-action="placePositionTrade"[^>]*>Set stop \$38\.20</);
  assert.equal(b.sent.length, 0, 'nothing is sent from the review');

  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/102', 'PUT /orders/101']);
  assert.equal(b.sent[1].body.stopPrice, 38.2);
  assert.equal(b.sent[1].body.orderLegCollection[0].quantity, 300);
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab now shows a stop at \$38\.20 for 300 shares/);
  await run('placePositionTrade()');
  assert.equal(b.sent.length, 2, 'a sent ticket never goes again');
});

test('the stop duration can be switched before sending and is remembered', async () => {
  const b = broker();
  const { run, storage } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('TSLA', 'breakeven')");
  run("setPositionStopDuration('DAY')");
  await run('placePositionTrade()');
  assert.equal(b.sent[0].body.duration, 'DAY');
  assert.equal(storage.get('schwab_stop_duration'), 'DAY');
});

test('a refused replace stops there and says which shares are left without a stop', async () => {
  const b = broker({ refuse: c => c.method === 'PUT' ? json({ message: 'Order cannot be replaced.' }, 400) : null });
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('HOOD', 'breakeven')");
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => c.method), ['DELETE', 'PUT']);
  const html = elements.get('posTradeBody').innerHTML;
  assert.match(html, /Schwab refused it\. Order cannot be replaced\./);
  assert.match(html, /50 shares have no stop now/);
});

test('a close is not sent when cancelling its orders fails', async () => {
  const b = broker({ refuse: c => c.method === 'DELETE' && c.path === '/orders/102' ? json({ message: 'Order already filled.' }, 400) : null });
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('HOOD', 'close')");
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/101', 'DELETE /orders/102']);
  assert.match(elements.get('posTradeBody').innerHTML, /Order already filled/);
});

test('closing a position cancels its orders, sells at market, and confirms it is gone', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('HOOD', 'close')");
  assert.match(elements.get('posTradeBody').innerHTML, /Cancel limit \$45\.00 for 300 shares/);
  assert.match(elements.get('posTradeBody').innerHTML, />Close 300 shares HOOD</);
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/101', 'DELETE /orders/102', 'DELETE /orders/103', 'POST /orders']);
  assert.equal(b.sent[3].body.orderType, 'MARKET');
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab no longer shows the HOOD position/);
});

test('no answer from Schwab mid-way says to check before trying again', async () => {
  const b = broker();
  const fetch = async (url, init = {}) => { if (init.method === 'PUT') throw new TypeError('Failed to fetch'); return b.fetch(url, init); };
  const { run, elements } = await app({ fetch, storage: connected() });
  await run("openPositionTrade('TSLA', 'breakeven')");
  await run('placePositionTrade()');
  assert.match(elements.get('posTradeBody').innerHTML, /No answer from Schwab\. Check your Schwab orders before trying again\./);
});

test('a position that is gone by the time the review opens cannot be traded', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  b.live.positions = b.live.positions.filter(p => p.instrument.symbol !== 'HOOD');
  await run("openPositionTrade('HOOD', 'breakeven')");
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab no longer shows a HOOD position/);
  assert.doesNotMatch(elements.get('posTradeBody').innerHTML, /placePositionTrade/);
});

test('stocks and ETFs trade as equity, options as options, cash and funds not at all', async () => {
  const { run } = await app();
  assert.deepEqual(plain(rowsFor(run)).map(r => [r.label.split(' ')[0], r.tradeAs]),
    [['AAPL', 'OPTION'], ['HOOD', 'EQUITY'], ['NVDA', 'EQUITY'], ['QQQ', 'EQUITY'], ['SWVXX', null], ['TSLA', 'EQUITY']]);
});
