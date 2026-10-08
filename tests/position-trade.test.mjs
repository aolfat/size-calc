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
  pos('AMD', 50, 150, 160),
];
const leg = (instruction, quantity, symbol, assetType = 'EQUITY') => ({ instruction, quantity, instrument: { symbol, assetType } });
const single = (orderId, orderType, symbol, instruction, qty, px, extra = {}) => ({ orderId, orderType, status: 'WORKING', orderStrategyType: 'SINGLE', session: 'NORMAL', duration: 'GOOD_TILL_CANCEL',
  ...(/STOP/.test(orderType) ? { stopPrice: px } : orderType === 'LIMIT' ? { price: px } : {}), quantity: qty, remainingQuantity: qty, orderLegCollection: [leg(instruction, qty, symbol)], ...extra });
const ORDERS = [
  // the app's own trade: the stop is the working child of a filled trigger
  { orderId: 100, orderType: 'MARKET', status: 'FILLED', orderStrategyType: 'TRIGGER', orderLegCollection: [leg('BUY', 250, 'HOOD')], childOrderStrategies: [single(101, 'STOP', 'HOOD', 'SELL', 250, 35.5)] },
  single(102, 'STOP', 'HOOD', 'SELL', 50, 34),
  single(103, 'LIMIT', 'HOOD', 'SELL', 100, 45, { duration: 'DAY' }), // a target for part of the position
  single(201, 'STOP', 'TSLA', 'BUY_TO_COVER', 40, 270),
  single(401, 'STOP', 'QQQ', 'SELL', 10, 400),
  // a target and a stop already paired, one cancels the other
  { orderId: 500, status: 'WORKING', orderStrategyType: 'OCO', childOrderStrategies: [single(501, 'LIMIT', 'AMD', 'SELL', 50, 170), single(502, 'STOP', 'AMD', 'SELL', 50, 140)] },
];
const account = (positions = POSITIONS) => ({ currentBalances: { liquidationValue: 100000 }, positions });
const rowWith = (symbol, orders = ORDERS) => `positionRows(${JSON.stringify(account())}, ${JSON.stringify(orders)}).rows.find(r => r.symbol === '${symbol}')`;

// a fake Schwab account that changes as orders arrive, so the re-read after sending tells the truth.
// Cancelling one leg of a pair cancels both, and a second cancel is refused, as Schwab does.
function broker({ refuse = () => null, lag = false } = {}) {
  const live = { positions: plain(POSITIONS), orders: plain(ORDERS), nextId: 900 };
  const sent = [];
  const all = () => live.orders.flatMap(o => [o, ...(o.childOrderStrategies || [])]);
  const parentOf = o => live.orders.find(p => (p.childOrderStrategies || []).includes(o));
  const fetch = async (url, init = {}) => {
    if (!url.startsWith(PROXY)) throw new Error('Unexpected request ' + url);
    const path = url.slice(PROXY.length);
    const method = init.method || 'GET';
    if (method === 'GET') {
      if (path.includes('/orders?')) return json(live.orders);
      if (path.endsWith('?fields=positions')) return json({ securitiesAccount: { currentBalances: { liquidationValue: 100000, cashBalance: 5000 }, positions: live.positions } });
      const one = path.match(/\/orders\/(\d+)$/);
      if (one) return json(all().find(o => o.orderId === Number(one[1])) || null, all().some(o => o.orderId === Number(one[1])) ? 200 : 404);
      return json({}, 404);
    }
    const call = { method, path: path.replace('/trader/v1/accounts/HASH1', ''), body: init.body ? JSON.parse(init.body) : null };
    sent.push(call);
    const refused = refuse(call, live);
    if (refused) return refused;
    if (lag) return new Response(null, { status: method === 'DELETE' ? 200 : 201 }); // accepted, but not showing yet
    const id = Number(call.path.split('/')[2]);
    if (method === 'DELETE') {
      const o = all().find(x => x.orderId === id);
      if (o.status !== 'WORKING') return json({ message: 'Order cannot be canceled.' }, 400);
      const parent = parentOf(o);
      (parent && parent.orderStrategyType === 'OCO' ? parent.childOrderStrategies : [o]).forEach(x => { x.status = 'CANCELED'; });
      return new Response(null, { status: 200 });
    }
    const orderId = live.nextId++;
    if (method === 'PUT') all().find(o => o.orderId === id).status = 'REPLACED';
    if (call.body.orderType === 'MARKET') {
      const symbol = call.body.orderLegCollection[0].instrument.symbol;
      live.positions = live.positions.filter(p => p.instrument.symbol !== symbol); // filled at once
    } else live.orders.push({ ...call.body, orderId, status: 'WORKING', childOrderStrategies: (call.body.childOrderStrategies || []).map(c => ({ ...c, orderId: live.nextId++, status: 'WORKING' })) });
    return new Response(null, { status: 201, headers: { Location: `${PROXY}/trader/v1/accounts/HASH1/orders/${orderId}` } });
  };
  return { fetch, sent, live };
}

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

test('a breakeven stop covers the shares no sell order holds, and pairs each limit with its own stop', async () => {
  const { run } = await app();
  const plan = plain(run(`breakevenPlan(${rowWith('HOOD')}, 'GOOD_TILL_CANCEL')`));
  assert.equal(plan.error, '');
  assert.equal(plan.stop, 38.2);
  assert.deepEqual(plan.steps.map(s => [s.kind, s.orderId ?? null]), [['cancel', 103], ['cancel', 102], ['replace', 101], ['place', null]],
    'the limit goes first, the far stop next, the near stop last; then the pair');
  const stop = qty => ({ orderType: 'STOP', session: 'NORMAL', duration: 'GOOD_TILL_CANCEL', orderStrategyType: 'SINGLE', stopPrice: 38.2,
    orderLegCollection: [{ instruction: 'SELL', quantity: qty, instrument: { symbol: 'HOOD', assetType: 'EQUITY' } }] });
  assert.deepEqual(plan.steps[2].order, stop(200), '300 held, 100 in the limit: the plain stop covers 200');
  assert.deepEqual(plan.steps[3].order, { orderStrategyType: 'OCO', childOrderStrategies: [
    { orderType: 'LIMIT', session: 'NORMAL', duration: 'GOOD_TILL_CANCEL', orderStrategyType: 'SINGLE', price: 45,
      orderLegCollection: [{ instruction: 'SELL', quantity: 100, instrument: { symbol: 'HOOD', assetType: 'EQUITY' } }] },
    stop(100),
  ] });
  const short = plain(run(`breakevenPlan(${rowWith('TSLA')}, 'DAY')`));
  assert.deepEqual(short.steps.map(s => [s.kind, s.orderId]), [['replace', 201]]);
  assert.equal(short.steps[0].order.orderLegCollection[0].instruction, 'BUY_TO_COVER');
  assert.equal(short.steps[0].order.stopPrice, 262);
  assert.equal(short.steps[0].order.duration, 'DAY');
});

test('a target already paired with a stop is placed again paired with a breakeven stop', async () => {
  const { run } = await app();
  const plan = plain(run(`breakevenPlan(${rowWith('AMD')}, 'GOOD_TILL_CANCEL')`));
  assert.deepEqual(plan.steps.map(s => [s.kind, s.orderId ?? null]), [['cancel', 501], ['cancel', 502], ['place', null]]);
  const [limit, stop] = plan.steps[2].order.childOrderStrategies;
  assert.equal(limit.price, 170);
  assert.equal(stop.stopPrice, 150);
  assert.equal(stop.orderLegCollection[0].quantity, 50);
  const atBe = ORDERS.map(o => o.orderId === 500 ? { ...o, childOrderStrategies: [o.childOrderStrategies[0], { ...o.childOrderStrategies[1], stopPrice: 150 }] } : o);
  assert.match(run(`breakevenPlan(${rowWith('AMD', atBe)}, 'DAY').error`), /already at breakeven/);
});

test('an option with no stop gets a new one on the option, at or above its cost', async () => {
  const { run } = await app();
  const plan = plain(run(`breakevenPlan(${rowWith(OPT)}, 'GOOD_TILL_CANCEL')`));
  assert.deepEqual(plan.steps.map(s => s.kind), ['place']);
  assert.equal(plan.stop, 4.9);
  assert.deepEqual(plan.steps[0].order.orderLegCollection, [{ instruction: 'SELL_TO_CLOSE', quantity: 2, instrument: { symbol: OPT, assetType: 'OPTION' } }]);
});

test('a breakeven stop is refused when it would fire at once, has no cost, is already there, or the orders don\'t add up', async () => {
  const { run } = await app();
  assert.match(run(`breakevenPlan(${rowWith('NVDA')}, 'DAY').error`), /\$112\.00 is at or below the breakeven stop \$118\.40/);
  assert.match(run(`breakevenPlan(${rowWith('SWVXX')}, 'DAY').error`), /stocks, ETFs and options/);
  assert.match(run(`breakevenPlan(${rowWith('QQQ')}, 'DAY').error`), /already at breakeven/);
  assert.match(run(`breakevenPlan({ ...${rowWith('HOOD')}, avg: 0 }, 'DAY').error`), /no cost basis/);
  assert.match(run(`breakevenPlan({ ...${rowWith('HOOD')}, qty: 2.5 }, 'DAY').error`), /Fractional/);
  const tooMany = [...ORDERS, single(104, 'LIMIT', 'HOOD', 'SELL', 250, 50)];
  assert.match(run(`breakevenPlan(${rowWith('HOOD', tooMany)}, 'DAY').error`), /sell orders on this position already add up to 350, more than the 300 you hold/);
  const market = [...ORDERS, single(105, 'MARKET', 'HOOD', 'SELL', 20, 0)];
  assert.match(run(`breakevenPlan(${rowWith('HOOD', market)}, 'DAY').error`), /A market order for 20 is waiting to close part of this position/);
});

test('closing cancels the targets first and the nearest stop last, then sells it at market', async () => {
  const { run } = await app();
  const plan = plain(run(`closePlan(${rowWith('HOOD')})`));
  assert.deepEqual(plan.steps.map(s => [s.kind, s.orderId ?? null]), [['cancel', 103], ['cancel', 102], ['cancel', 101], ['place', null]]);
  assert.deepEqual(plan.steps[3].order, {
    orderType: 'MARKET', session: 'NORMAL', duration: 'DAY', orderStrategyType: 'SINGLE',
    orderLegCollection: [{ instruction: 'SELL', quantity: 300, instrument: { symbol: 'HOOD', assetType: 'EQUITY' } }],
  });
  assert.equal(run(`closePlan(${rowWith(OPT)}).steps[0].order.orderLegCollection[0].instruction`), 'SELL_TO_CLOSE');
  assert.equal(run(`closePlan(${rowWith('TSLA')}).steps[1].order.orderLegCollection[0].instruction`), 'BUY_TO_COVER');
  assert.match(run(`closePlan(${rowWith('SWVXX')}).error`), /stocks, ETFs and options/);
});

test('only orders still in play count, under any of Schwab\'s live statuses', async () => {
  const { run } = await app();
  const statuses = ['NEW', 'PENDING_ACKNOWLEDGEMENT', 'PENDING_REPLACE', 'REPLACED', 'AWAITING_PARENT_ORDER', 'FILLED'];
  const orders = statuses.map((status, i) => single(700 + i, 'STOP', 'HOOD', 'SELL', 10, 30 + i, { status }));
  assert.deepEqual(plain(run(`${rowWith('HOOD', orders)}.stopOrders.map(o => o.orderId)`)).sort(), [700, 701, 702]);
});

// ---------- the table and the sheet ----------

test('stock, ETF and option rows get trade buttons; a stop already at breakeven says so', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run('refreshPositions()');
  const html = elements.get('positionsSection').innerHTML;
  const cell = symbol => html.split('<tr>').find(r => r.includes(`>${symbol}<`) || r.includes(`>${symbol} `)) || '';
  for (const s of ['HOOD', 'TSLA', 'NVDA', 'AMD']) assert.match(cell(s), /data-action="openPositionTrade" data-arg="[^"]+" data-arg2="breakeven"/, s);
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
  assert.match(review, /Cancel limit \$45\.00 for 100 shares, to pair it with a stop/);
  assert.match(review, /Cancel stop \$34\.00 for 50 shares/);
  assert.match(review, /Replace stop \$35\.50 for 250 shares with stop \$38\.20 for 200 shares/);
  assert.match(review, /Place limit \$45\.00 for 100 shares paired with stop \$38\.20 \(one cancels the other\)/);
  assert.match(review, /100 shares have no stop for a moment/);
  assert.match(review, /Your limit was for today only\. Paired, it lasts until canceled/);
  assert.match(review, /data-action="placePositionTrade"[^>]*>Set stop \$38\.20</);
  assert.equal(b.sent.length, 0, 'nothing is sent from the review');

  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/103', 'DELETE /orders/102', 'PUT /orders/101', 'POST /orders']);
  assert.equal(b.sent[2].body.orderLegCollection[0].quantity, 200);
  assert.equal(b.sent[3].body.orderStrategyType, 'OCO');
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab now shows stops at \$38\.20 for all 300 shares/);
  await run('placePositionTrade()');
  assert.equal(b.sent.length, 4, 'a sent ticket never goes again');
});

test('the stop duration can be switched before sending and is remembered', async () => {
  const b = broker();
  const { run, elements, storage } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('TSLA', 'breakeven')");
  assert.doesNotMatch(elements.get('posTradeBody').innerHTML, /shares in a limit/, 'nothing to pair, nothing said about pairing');
  run("setPositionStopDuration('DAY')");
  await run('placePositionTrade()');
  assert.equal(b.sent[0].body.duration, 'DAY');
  assert.equal(storage.get('schwab_stop_duration'), 'DAY');
});

test('a refused replace stops there and says what is left uncovered', async () => {
  const b = broker({ refuse: c => c.method === 'PUT' ? json({ message: 'Order cannot be replaced.' }, 400) : null });
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('HOOD', 'breakeven')");
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => c.method), ['DELETE', 'DELETE', 'PUT']);
  const html = elements.get('posTradeBody').innerHTML;
  assert.match(html, /Schwab refused it\. Order cannot be replaced\./);
  assert.match(html, /50 shares have no stop now/);
  assert.match(html, /Your limit \$45\.00 for 100 shares was cancelled and not placed again/);
  assert.match(html, /Schwab lists for HOOD/);
  assert.match(html, /stop \$35\.50 · sell 250 · working/);
});

test('a close is not sent when a cancel is refused', async () => {
  const b = broker({ refuse: c => c.method === 'DELETE' && c.path === '/orders/102' ? json({ message: 'Order is being worked.' }, 400) : null });
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('HOOD', 'close')");
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/103', 'DELETE /orders/102']);
  assert.match(elements.get('posTradeBody').innerHTML, /Order is being worked/);
});

test('a cancel refused because the order filled stops everything', async () => {
  const b = broker({ refuse: (c, live) => {
    if (c.method !== 'DELETE' || c.path !== '/orders/102') return null;
    live.orders.find(o => o.orderId === 102).status = 'FILLED';
    return json({ message: 'Order cannot be canceled.' }, 400);
  } });
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('HOOD', 'close')");
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => c.method), ['DELETE', 'DELETE']);
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab filled the stop \$34\.00 for 50 shares while this ran\. Nothing more was sent\./);
});

test('closing a paired target and stop goes on when the second leg was cancelled with the first', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('AMD', 'close')");
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/501', 'DELETE /orders/502', 'POST /orders']);
  assert.match(elements.get('posTradeBody').innerHTML, /already cancelled/);
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab no longer shows the AMD position/);
});

test('closing a position cancels its orders, sells at market, and confirms it is gone', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('HOOD', 'close')");
  assert.match(elements.get('posTradeBody').innerHTML, /Cancel limit \$45\.00 for 100 shares/);
  assert.match(elements.get('posTradeBody').innerHTML, />Close 300 shares HOOD</);
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/103', 'DELETE /orders/102', 'DELETE /orders/101', 'POST /orders']);
  assert.equal(b.sent[3].body.orderType, 'MARKET');
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab no longer shows the HOOD position/);
});

test('without the account\'s orders there is no plan: the app can\'t see what already covers the position', async () => {
  const b = broker();
  const fetch = async (url, init = {}) => url.includes('/orders?') ? json({ message: 'down' }, 500) : b.fetch(url, init);
  const { run, elements } = await app({ fetch, storage: connected() });
  for (const kind of ['breakeven', 'close']) {
    await run(`openPositionTrade('HOOD', '${kind}')`);
    assert.match(elements.get('posTradeBody').innerHTML, /Schwab did not return the orders on this account, so there is no telling what already covers the position/);
    assert.doesNotMatch(elements.get('posTradeBody').innerHTML, /placePositionTrade/);
  }
  assert.equal(b.sent.length, 0);
});

test('when Schwab doesn\'t show the result yet, the next send on that symbol waits and Schwab\'s list is shown', async () => {
  const b = broker({ lag: true });
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('TSLA', 'breakeven')");
  await run('placePositionTrade()');
  const html = elements.get('posTradeBody').innerHTML;
  assert.match(html, /Schwab does not show the new stop yet/);
  assert.match(html, /Schwab lists for TSLA/);
  assert.match(html, /stop \$270\.00 · buy to cover 40 · working/);
  await run("openPositionTrade('TSLA', 'breakeven')");
  assert.match(elements.get('posTradeBody').innerHTML, /Your last order on TSLA has not shown up at Schwab yet/);
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab lists for TSLA/);
  assert.doesNotMatch(elements.get('posTradeBody').innerHTML, /placePositionTrade/);
  assert.equal(b.sent.length, 1);
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
  assert.deepEqual(plain(run(`positionRows(${JSON.stringify(account())}, ${JSON.stringify(ORDERS)}).rows`)).map(r => [r.label.split(' ')[0], r.tradeAs]),
    [['AAPL', 'OPTION'], ['AMD', 'EQUITY'], ['HOOD', 'EQUITY'], ['NVDA', 'EQUITY'], ['QQQ', 'EQUITY'], ['SWVXX', null], ['TSLA', 'EQUITY']]);
});
