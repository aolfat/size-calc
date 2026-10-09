// Run with: node --test
// Position trades: a breakeven stop or a close (market or limit, all or part) for one Schwab position, planned purely, reviewed, sent once.
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
      const { quantity, instrument: { symbol } } = call.body.orderLegCollection[0];
      live.positions = live.positions.flatMap(p => { // filled at once, for that many
        if (p.instrument.symbol !== symbol) return [p];
        const qty = (p.longQuantity || -p.shortQuantity) > 0 ? p.longQuantity - quantity : -(p.shortQuantity - quantity);
        return qty ? [{ ...p, longQuantity: Math.max(qty, 0), shortQuantity: Math.max(-qty, 0), marketValue: p.marketValue / (p.longQuantity || -p.shortQuantity) * qty }] : [];
      });
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

test('just moving the stop leaves the limit alone and puts a breakeven stop on the rest', async () => {
  const { run } = await app();
  const plan = plain(run(`breakevenPlan(${rowWith('HOOD')}, 'GOOD_TILL_CANCEL', { limits: 'keep' })`));
  assert.equal(plan.error, '');
  assert.deepEqual(plan.steps.map(s => [s.kind, s.orderId]), [['cancel', 102], ['replace', 101]], 'the limit is not touched');
  assert.equal(plan.steps[1].order.orderLegCollection[0].quantity, 200);
  assert.equal(plan.rest, 200);
  assert.equal(plan.bare, 100, 'the shares in the limit stay without a stop');
  assert.deepEqual(plan.paired, []);
  const whole = ORDERS.map(o => o.orderId === 103 ? single(103, 'LIMIT', 'HOOD', 'SELL', 300, 45) : o);
  assert.match(run(`breakevenPlan(${rowWith('HOOD', whole)}, 'DAY', { limits: 'keep' }).error`), /limit holds the whole position/);
  assert.match(run(`breakevenPlan(${rowWith('AMD')}, 'DAY', { limits: 'keep' }).error`), /limit holds the whole position/);
});

test('cancelling the limits clears the way for one breakeven stop on every share', async () => {
  const { run } = await app();
  const plan = plain(run(`breakevenPlan(${rowWith('HOOD')}, 'GOOD_TILL_CANCEL', { limits: 'cancel' })`));
  assert.equal(plan.error, '');
  assert.deepEqual(plan.steps.map(s => [s.kind, s.orderId]), [['cancel', 103], ['cancel', 102], ['replace', 101]], 'the limit first, the far stop next, then the near stop takes everything');
  assert.equal(plan.steps[2].order.orderLegCollection[0].quantity, 300);
  assert.equal(plan.rest, 300);
  assert.equal(plan.bare, 0);
  const pairOnly = plain(run(`breakevenPlan(${rowWith('AMD')}, 'DAY', { limits: 'cancel' })`));
  assert.deepEqual(pairOnly.steps.map(s => [s.kind, s.orderId ?? null]), [['cancel', 501], ['cancel', 502], ['place', null]]);
  assert.equal(pairOnly.steps[2].order.orderLegCollection[0].quantity, 50);
  // what blocks the other two is just one more order to cancel here
  const market = [...ORDERS, single(105, 'MARKET', 'HOOD', 'SELL', 20, 0)];
  assert.match(run(`breakevenPlan(${rowWith('HOOD', market)}, 'DAY', { limits: 'keep' }).error`), /market order for 20/);
  assert.deepEqual(plain(run(`breakevenPlan(${rowWith('HOOD', market)}, 'DAY', { limits: 'cancel' })`)).steps.map(s => s.orderId ?? null), [103, 105, 102, 101]);
  const tooMany = [...ORDERS, single(104, 'LIMIT', 'HOOD', 'SELL', 250, 50)];
  assert.equal(run(`breakevenPlan(${rowWith('HOOD', tooMany)}, 'DAY', { limits: 'cancel' }).error`), '');
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

test('a partial close at market keeps the targets and cuts the stops to the shares left', async () => {
  const { run } = await app();
  // HOOD: 300 shares, a limit holding 100, stops $35.50 × 250 and $34 × 50; 200 shares are free to close
  const plan = plain(run(`closePlan(${rowWith('HOOD')}, { type: 'MARKET', qty: 100 })`));
  assert.equal(plan.error, '');
  assert.deepEqual(plan.steps.map(s => [s.kind, s.orderId ?? null]), [['cancel', 102], ['replace', 101], ['place', null]]);
  assert.equal(plan.steps[1].order.orderLegCollection[0].quantity, 100);
  assert.equal(plan.steps[1].order.stopPrice, 35.5);
  assert.equal(plan.steps[2].order.orderType, 'MARKET');
  assert.equal(plan.steps[2].order.orderLegCollection[0].quantity, 100);
  assert.equal(plan.rest, 200);
  assert.match(run(`closePlan(${rowWith('HOOD')}, { type: 'MARKET', qty: 250 }).error`), /Your targets hold 100 of the 300 shares, so a partial close can take up to 200\. Close all 300 to cancel them too\./);
  assert.match(run(`closePlan(${rowWith('HOOD')}, { type: 'MARKET', qty: 0 }).error`), /Pick how many shares to sell/);
  assert.match(run(`closePlan(${rowWith('HOOD')}, { type: 'MARKET', qty: 301 }).error`), /You hold 300 shares/);
  assert.match(run(`closePlan(${rowWith('TSLA')}, { type: 'MARKET', qty: 0 }).error`), /Pick how many shares to buy back/);
});

test('a limit close is paired with the nearest stop for the same shares', async () => {
  const { run } = await app();
  const part = plain(run(`closePlan(${rowWith('HOOD')}, { type: 'LIMIT', qty: 100, price: 41.004, duration: 'DAY' })`));
  assert.deepEqual(part.steps.map(s => [s.kind, s.orderId ?? null]), [['cancel', 102], ['replace', 101], ['place', null]]);
  assert.deepEqual(part.steps[2].order, { orderStrategyType: 'OCO', childOrderStrategies: [
    { orderType: 'LIMIT', session: 'NORMAL', duration: 'DAY', orderStrategyType: 'SINGLE', price: 41, orderLegCollection: [{ instruction: 'SELL', quantity: 100, instrument: { symbol: 'HOOD', assetType: 'EQUITY' } }] },
    { orderType: 'STOP', session: 'NORMAL', duration: 'DAY', orderStrategyType: 'SINGLE', stopPrice: 35.5, orderLegCollection: [{ instruction: 'SELL', quantity: 100, instrument: { symbol: 'HOOD', assetType: 'EQUITY' } }] },
  ] });
  assert.equal(part.price, 41);
  assert.equal(part.stop, 35.5);
  // all of it: every order on it is cancelled first, then one pair for the whole position
  const all = plain(run(`closePlan(${rowWith('HOOD')}, { type: 'LIMIT', qty: 300, price: 41, duration: 'GOOD_TILL_CANCEL' })`));
  assert.deepEqual(all.steps.map(s => [s.kind, s.orderId ?? null]), [['cancel', 103], ['cancel', 102], ['cancel', 101], ['place', null]]);
  assert.equal(all.steps[3].order.childOrderStrategies[0].orderLegCollection[0].quantity, 300);
  assert.equal(all.steps[3].order.childOrderStrategies[1].stopPrice, 35.5);
  assert.equal(all.moved, 300, 'no stop between the cancels and the pair');
  // no stop: the limit goes alone
  const bare = plain(run(`closePlan(${rowWith('NVDA')}, { type: 'LIMIT', qty: 150, price: 113, duration: 'DAY' })`));
  assert.deepEqual(bare.steps.map(s => s.kind), ['place']);
  assert.equal(bare.steps[0].order.orderType, 'LIMIT');
  assert.equal(bare.stop, 0);
  // options take the $0.05 / $0.10 grid, to the nearest step
  const opt = plain(run(`closePlan(${rowWith(OPT)}, { type: 'LIMIT', qty: 2, price: 6.14, duration: 'DAY' })`));
  assert.equal(opt.steps.at(-1).order.price, 6.1);
  assert.equal(opt.steps.at(-1).order.orderLegCollection[0].instruction, 'SELL_TO_CLOSE');
  assert.equal(run('optionPriceTick(2.97)'), 2.95);
  assert.match(run(`closePlan(${rowWith('HOOD')}, { type: 'LIMIT', qty: 300, price: 0 }).error`), /Set a limit price/);
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
  run("setPositionBeMode('pair')");
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

test('a limit in the way asks first: stop the rest, or pair with the limit, and nothing goes until you pick', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('HOOD', 'breakeven')");
  const ask = elements.get('posTradeBody').innerHTML;
  assert.match(ask, /Your limit \$45\.00 for 100 shares already sells part of this position/);
  assert.match(ask, /data-action="setPositionBeMode" data-arg="keep"[^>]*>[\s\S]*Stop the rest[\s\S]*Breakeven stop for the 200 shares outside the limit\. The limit stays as it is; its 100 shares have no stop\./);
  assert.match(ask, /data-action="setPositionBeMode" data-arg="pair"[^>]*>[\s\S]*Pair with the limit/);
  assert.match(ask, /data-action="placePositionTrade" disabled/);
  await run('placePositionTrade()');
  assert.equal(b.sent.length, 0, 'no choice, no orders');

  run("setPositionBeMode('keep')");
  const only = elements.get('posTradeBody').innerHTML;
  assert.match(only, /aria-pressed="true" data-action="setPositionBeMode" data-arg="keep"/);
  assert.match(only, /Replace stop \$35\.50 for 250 shares with stop \$38\.20 for 200 shares/);
  assert.doesNotMatch(only, /Cancel limit/);
  assert.match(only, /data-action="placePositionTrade">Set stop \$38\.20</);
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/102', 'PUT /orders/101']);
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab now shows a stop at \$38\.20 for 200 shares\. Your limit keeps 100 shares without a stop\./);
});

test('cancel the limit: the sell orders go, then one breakeven stop for every share', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('HOOD', 'breakeven')");
  assert.match(elements.get('posTradeBody').innerHTML, /data-action="setPositionBeMode" data-arg="cancel"[^>]*>[\s\S]*Cancel the limit[\s\S]*Cancel it, then one breakeven stop for all 300 shares\. You lose the target\./);
  run("setPositionBeMode('cancel')");
  const review = elements.get('posTradeBody').innerHTML;
  assert.match(review, /Cancel limit \$45\.00 for 100 shares</);
  assert.match(review, /Replace stop \$35\.50 for 250 shares with stop \$38\.20 for 300 shares/);
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/103', 'DELETE /orders/102', 'PUT /orders/101']);
  assert.equal(b.sent[2].body.orderLegCollection[0].quantity, 300);
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab now shows a stop at \$38\.20 for 300 shares\./);
  assert.doesNotMatch(elements.get('posTradeBody').innerHTML, /was cancelled and not placed again/);
});

test('an order the other options can\'t work around still leaves cancelling', async () => {
  const b = broker();
  b.live.orders.push(single(105, 'MARKET', 'HOOD', 'SELL', 20, 0));
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('HOOD', 'breakeven')");
  const html = elements.get('posTradeBody').innerHTML;
  assert.match(html, /Your orders for 120 shares already sell part of this position/);
  assert.match(html, /data-action="setPositionBeMode" data-arg="keep" disabled/);
  assert.match(html, /data-action="setPositionBeMode" data-arg="pair" disabled/);
  assert.match(html, /A market order for 20 is waiting/);
  assert.doesNotMatch(html, /data-action="setPositionBeMode" data-arg="cancel" disabled/);
  assert.match(html, /Cancel them, then one breakeven stop for all 300 shares\. You lose the target\./, 'one limit among them: one target');
});

test('a limit holding the whole position leaves pairing or cancelling', async () => {
  const b = broker();
  b.live.orders = b.live.orders.map(o => o.orderId === 103 ? single(103, 'LIMIT', 'HOOD', 'SELL', 300, 45) : o);
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('HOOD', 'breakeven')");
  assert.match(elements.get('posTradeBody').innerHTML, /data-action="setPositionBeMode" data-arg="keep" disabled/);
  assert.match(elements.get('posTradeBody').innerHTML, /limit holds the whole position/);
  assert.match(elements.get('posTradeBody').innerHTML, /Your limit \$45\.00 for 300 shares already sells the whole position\./);
});

test('the stop duration can be switched before sending and is remembered', async () => {
  const b = broker();
  const { run, elements, storage } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('TSLA', 'breakeven')");
  assert.doesNotMatch(elements.get('posTradeBody').innerHTML, /shares in a limit|setPositionBeMode/, 'no limit in the way: no question');
  run("setPositionStopDuration('DAY')");
  await run('placePositionTrade()');
  assert.equal(b.sent[0].body.duration, 'DAY');
  assert.equal(storage.get('schwab_stop_duration'), 'DAY');
});

test('a refused replace stops there and says what is left uncovered', async () => {
  const b = broker({ refuse: c => c.method === 'PUT' ? json({ message: 'Order cannot be replaced.' }, 400) : null });
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('HOOD', 'breakeven')");
  run("setPositionBeMode('pair')");
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
  assert.match(elements.get('posTradeBody').innerHTML, />Sell 300 HOOD at market</);
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/103', 'DELETE /orders/102', 'DELETE /orders/101', 'POST /orders']);
  assert.equal(b.sent[3].body.orderType, 'MARKET');
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab no longer shows the HOOD position/);
});

test('the close ticket picks market or limit, how many and the price, like a broker', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('HOOD', 'close')");
  const body = () => elements.get('posTradeBody').innerHTML;
  const detail = () => elements.get('posTradeDetail').innerHTML;
  assert.match(body(), /aria-pressed="true" data-action="setCloseType" data-arg="MARKET"/);
  assert.match(body(), /id="posCloseQty"[^>]*value="300"/);
  assert.doesNotMatch(body(), /id="posClosePrice"/, 'a market order has no price');
  run("setCloseType('LIMIT')");
  assert.match(body(), /aria-pressed="true" data-action="setCloseType" data-arg="LIMIT"/);
  assert.match(body(), /id="posClosePrice"[^>]*value="41.10"/, 'starts at Schwab\'s mark');
  assert.match(body(), /data-action="setPositionStopDuration" data-arg="DAY"/);
  assert.match(body(), />Sell 300 HOOD, limit \$41\.10</);
  // typing re-plans without redrawing the inputs under the cursor
  run("setCloseQty('100')");
  assert.match(detail(), /Cut stop \$35\.50 from 250 shares to 100/);
  assert.match(detail(), /paired with stop \$35\.50/);
  assert.match(detail(), />Sell 100 HOOD, limit \$41\.10</);
  run("setCloseQty('250')");
  assert.match(detail(), /can take up to 200/);
  assert.match(detail(), /data-action="placePositionTrade" disabled/);
  run('setClosePortion(0.5)');
  assert.match(body(), /id="posCloseQty"[^>]*value="150"/);
  run("setClosePrice('40.5')");
  assert.match(detail(), /\+\$345\.00/, '150 × ($40.50 − $38.20)');
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/102', 'PUT /orders/101', 'POST /orders']);
  assert.equal(b.sent[1].body.orderLegCollection[0].quantity, 50);
  assert.equal(b.sent[2].body.orderStrategyType, 'OCO');
  assert.equal(b.sent[2].body.childOrderStrategies[0].price, 40.5);
  assert.match(body(), /Schwab now shows a limit \$40\.50 for 150 shares, paired with a stop at \$35\.50/);
});

test('a partial market close sells only that many and confirms what is left', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('HOOD', 'close')");
  run("setCloseQty('100')");
  assert.match(elements.get('posTradeDetail').innerHTML, />Sell 100 HOOD at market</);
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/102', 'PUT /orders/101', 'POST /orders']);
  assert.equal(b.sent[2].body.orderLegCollection[0].quantity, 100);
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab now shows 200 shares HOOD/);
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

// ---------- profit targets ----------

const onlyStop = [single(101, 'STOP', 'HOOD', 'SELL', 300, 35.5), single(201, 'STOP', 'TSLA', 'BUY_TO_COVER', 40, 270)];
const targetFor = (symbol, price, qty, orders = onlyStop, duration = 'GOOD_TILL_CANCEL') => `targetPlan(${rowWith(symbol, orders)}, { price: ${price}, qty: ${qty}, duration: '${duration}' })`;

test('limit prices snap to the nearest tick: cents from $1, four decimals under', async () => {
  const { run } = await app();
  assert.equal(run('priceTick(52.004)'), 52);
  assert.equal(run('priceTick(52.006)'), 52.01);
  assert.equal(run('priceTick(0.12346)'), 0.1235);
});

test('a target on a stopped position cuts the stop to make room and goes in paired with a stop for the same shares', async () => {
  const { run } = await app();
  const plan = plain(run(targetFor('HOOD', 50.004, 100)));
  assert.equal(plan.error, '');
  assert.equal(plan.price, 50);
  assert.equal(plan.stop, 35.5);
  assert.equal(plan.moved, 100, '100 shares leave the plain stop');
  assert.equal(plan.rest, 200);
  assert.deepEqual(plan.steps.map(s => [s.kind, s.orderId ?? null]), [['replace', 101], ['place', null]]);
  const stop = qty => ({ orderType: 'STOP', session: 'NORMAL', duration: 'GOOD_TILL_CANCEL', orderStrategyType: 'SINGLE', stopPrice: 35.5,
    orderLegCollection: [{ instruction: 'SELL', quantity: qty, instrument: { symbol: 'HOOD', assetType: 'EQUITY' } }] });
  assert.deepEqual(plan.steps[0].order, stop(200), 'same price, 200 shares');
  assert.deepEqual(plan.steps[1].order, { orderStrategyType: 'OCO', childOrderStrategies: [
    { orderType: 'LIMIT', session: 'NORMAL', duration: 'GOOD_TILL_CANCEL', orderStrategyType: 'SINGLE', price: 50,
      orderLegCollection: [{ instruction: 'SELL', quantity: 100, instrument: { symbol: 'HOOD', assetType: 'EQUITY' } }] },
    stop(100),
  ] });
  // the whole position: the plain stop goes, the pair carries every share
  assert.deepEqual(plain(run(targetFor('HOOD', 50, 300))).steps.map(s => [s.kind, s.orderId ?? null]), [['cancel', 101], ['place', null]]);
});

test('stops are cut farthest first and keep how long they last; the pair stops at the nearest', async () => {
  const { run } = await app();
  const orders = [single(101, 'STOP', 'HOOD', 'SELL', 200, 35.5, { duration: 'DAY' }), single(102, 'STOP', 'HOOD', 'SELL', 100, 34)];
  const plan = plain(run(targetFor('HOOD', 50, 150, orders)));
  assert.deepEqual(plan.steps.map(s => [s.kind, s.orderId ?? null]), [['cancel', 102], ['replace', 101], ['place', null]]);
  assert.equal(plan.steps[1].order.orderLegCollection[0].quantity, 150);
  assert.equal(plan.steps[1].order.duration, 'DAY', 'a cut stop keeps its own duration');
  assert.equal(plan.steps[2].order.childOrderStrategies[1].stopPrice, 35.5);
  assert.equal(plan.moved, 150);
  // room outside the stops: nothing to cut, and the target still carries the stop
  const partial = [single(101, 'STOP', 'HOOD', 'SELL', 100, 35.5)];
  const roomy = plain(run(targetFor('HOOD', 50, 100, partial)));
  assert.deepEqual(roomy.steps.map(s => s.kind), ['place']);
  assert.equal(roomy.moved, 0);
  assert.equal(roomy.steps[0].order.orderStrategyType, 'OCO');
});

test('a target on a short buys back below the price, paired with the stop above', async () => {
  const { run } = await app();
  const plan = plain(run(targetFor('TSLA', 240, 20)));
  assert.equal(plan.error, '');
  assert.equal(plan.steps[0].order.orderLegCollection[0].quantity, 20);
  const [limit, stop] = plan.steps[1].order.childOrderStrategies;
  assert.equal(limit.orderLegCollection[0].instruction, 'BUY_TO_COVER');
  assert.equal(limit.price, 240);
  assert.equal(stop.stopPrice, 270);
  assert.match(run(targetFor('TSLA', 260, 20) + '.error'), /The target \$260\.00 is at or above the price \$255\.30\. It would buy back right away/);
});

test('a position without a stop gets the target alone', async () => {
  const { run } = await app();
  const plan = plain(run(targetFor('NVDA', 125, 50, [])));
  assert.equal(plan.error, '');
  assert.equal(plan.stop, 0);
  assert.equal(plan.bare, 50);
  assert.deepEqual(plan.steps.map(s => s.order.orderType), ['LIMIT']);
});

test('a target is refused through the price, over what other targets leave, for options, or with an order in the way', async () => {
  const { run } = await app();
  assert.match(run(targetFor('HOOD', 41, 100) + '.error'), /The target \$41\.00 is at or below the price \$41\.10\. It would sell right away/);
  assert.match(run(targetFor('HOOD', 0, 100) + '.error'), /Set a target price/);
  assert.match(run(targetFor('HOOD', 50, 0) + '.error'), /Pick how many shares the target sells/);
  assert.match(run(targetFor('HOOD', 50, 2.5) + '.error'), /Pick how many shares/);
  assert.match(run(targetFor('HOOD', 50, 400) + '.error'), /The target is for 400 shares and you hold 300/);
  assert.match(run(targetFor('HOOD', 50, 250, ORDERS) + '.error'), /Your other targets hold 100 of the 300 shares, so this one can take up to 200/);
  assert.match(run(targetFor('AMD', 180, 10, ORDERS) + '.error'), /Your targets already hold all 50 shares/);
  assert.match(run(targetFor(OPT, 9, 1, ORDERS) + '.error'), /stocks and ETFs/);
  assert.match(run(targetFor('HOOD', 50, 100, [...onlyStop, single(105, 'MARKET', 'HOOD', 'SELL', 20, 0)]) + '.error'), /A market order for 20 is waiting/);
  assert.deepEqual({ ...run(`targetRoom(${rowWith('HOOD', ORDERS)})`) }, { error: '', held: 300, reserved: 100, free: 200 });
});

test('the chart levels add up sizes per price, and a target reads in R off the nearest stop', async () => {
  const { run } = await app();
  assert.deepEqual(plain(run(`positionLevels(${rowWith('HOOD')})`)), [
    { kind: 'avg', price: 38.2, qty: 300 }, { kind: 'stop', price: 35.5, qty: 250 }, { kind: 'stop', price: 34, qty: 50 }, { kind: 'target', price: 45, qty: 100 },
  ]);
  const paired = [single(101, 'STOP', 'HOOD', 'SELL', 200, 35.5), { orderId: 600, status: 'WORKING', orderStrategyType: 'OCO',
    childOrderStrategies: [single(601, 'LIMIT', 'HOOD', 'SELL', 100, 50), single(602, 'STOP', 'HOOD', 'SELL', 100, 35.5)] }];
  assert.deepEqual(plain(run(`positionLevels(${rowWith('HOOD', paired)})`)).filter(l => l.kind === 'stop'), [{ kind: 'stop', price: 35.5, qty: 300 }]);
  const g = run(`targetGain(${rowWith('HOOD', onlyStop)}, 50, 100)`);
  assert.ok(Math.abs(g.gain - 1180) < 1e-9);
  assert.ok(Math.abs(g.pct - 11.8 / 38.2 * 100) < 1e-9);
  assert.ok(Math.abs(g.r - 11.8 / 2.7) < 1e-9);
  assert.equal(run(`targetGain(${rowWith('NVDA', [])}, 125, 10).r`), null, 'no stop, no R');
});

// the chart's form, as a tap and a portion chip leave it
const setTarget = (run, elements, symbol, price, qty) => {
  run(`posChart = { symbol: '${symbol}', bars: [], view: { count: 63, offset: 0 }, range: 63, loading: false, error: '', hover: -1, hoverY: -1, price: null, qty: null }`);
  elements.get('posTargetPrice').value = String(price);
  elements.get('posTargetQty').value = String(qty);
  run('posTargetChanged()');
};

test('the target review re-reads Schwab, sends the cut and the pair once, and confirms the target Schwab shows', async () => {
  const b = broker();
  b.live.orders = plain(onlyStop);
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run('refreshPositions()');
  setTarget(run, elements, 'HOOD', 50, 100);
  await run("actions.openPositionTrade({ dataset: { arg: 'HOOD', arg2: 'target' } })");
  assert.equal(elements.get('posTradeTitle').textContent, 'Profit target');
  const review = elements.get('posTradeBody').innerHTML;
  assert.match(review, /Cut stop \$35\.50 from 300 shares to 200/);
  assert.match(review, /Place limit \$50\.00 for 100 shares paired with stop \$35\.50 \(one cancels the other\)/);
  assert.match(review, /\+\$1,180\.00/);
  assert.match(review, /\+30\.9% over your cost · 4\.4R from the \$35\.50 stop\. 200 shares left after it fills\./);
  assert.match(review, /your stop is cut to make room\. While the target goes in, 100 shares have no stop for a moment/);
  assert.match(review, /data-action="placePositionTrade"[^>]*>Place target \$50\.00</);
  assert.equal(b.sent.length, 0);

  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['PUT /orders/101', 'POST /orders']);
  assert.equal(b.sent[0].body.orderLegCollection[0].quantity, 200);
  assert.equal(b.sent[1].body.orderStrategyType, 'OCO');
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab now shows a target at \$50\.00 for 100 shares, paired with a stop at \$35\.50\./);
  assert.doesNotMatch(elements.get('posTradeBody').innerHTML, /no stop now/, 'every share still has a stop');
  assert.equal(run('posChart.price'), null, 'the form clears once Schwab shows it');
  assert.equal(elements.get('posTargetPrice').value, '');
  await run('placePositionTrade()');
  assert.equal(b.sent.length, 2, 'a sent ticket never goes again');
});

test('a target lasting today only warns that its stop ends with it; the choice is remembered', async () => {
  const b = broker();
  b.live.orders = plain(onlyStop);
  const { run, elements, storage } = await app({ fetch: b.fetch, storage: connected() });
  await run('refreshPositions()');
  setTarget(run, elements, 'HOOD', 50, 100);
  await run("openPositionTrade('HOOD', 'target')");
  assert.doesNotMatch(elements.get('posTradeBody').innerHTML, /Today only/);
  run("setPositionStopDuration('DAY')");
  assert.match(elements.get('posTradeBody').innerHTML, /Today only: at the close the target and the stop paired with it both end, and those 100 shares have no stop\./);
  assert.equal(storage.get('schwab_stop_duration'), 'DAY');
  await run('placePositionTrade()');
  assert.equal(b.sent[1].body.childOrderStrategies[0].duration, 'DAY');
  assert.equal(b.sent[1].body.childOrderStrategies[1].duration, 'DAY');
  assert.equal(b.sent[0].body.duration, 'GOOD_TILL_CANCEL', 'the cut stop keeps its own');
});

test('a target Schwab doesn\'t show yet is not confirmed, keeps the form, and holds the next send', async () => {
  const b = broker({ lag: true });
  b.live.orders = plain(onlyStop);
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run('refreshPositions()');
  setTarget(run, elements, 'HOOD', 50, 100);
  await run("openPositionTrade('HOOD', 'target')");
  await run('placePositionTrade()');
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab does not show the target yet\. Check Schwab\./);
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab lists for HOOD/);
  assert.equal(run('posChart.price'), 50);
  await run("openPositionTrade('HOOD', 'target')");
  assert.match(elements.get('posTradeBody').innerHTML, /Your last order on HOOD has not shown up at Schwab yet/);
});

test('without a stop the target goes alone, and the sheet says the position has no stop', async () => {
  const b = broker();
  b.live.orders = [];
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run('refreshPositions()');
  setTarget(run, elements, 'HOOD', 50, 100);
  await run("openPositionTrade('HOOD', 'target')");
  const review = elements.get('posTradeBody').innerHTML;
  assert.match(review, /Place a limit \$50\.00 for 100 shares \(sell\)/);
  assert.match(review, /This position has no stop, so the target goes alone\./);
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => c.body.orderType), ['LIMIT']);
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab now shows a target at \$50\.00 for 100 shares\. 300 shares have no stop now\./);
});

// ---------- cancelling working orders ----------

const ENTRY = { ...single(600, 'LIMIT', 'NVDA', 'BUY', 20, 110, { duration: 'DAY' }), orderStrategyType: 'TRIGGER',
  childOrderStrategies: [single(601, 'STOP', 'NVDA', 'SELL', 20, 104, { status: 'AWAITING_PARENT_ORDER' })] };

test('cancelling half of a pair puts the other half back on its own unless both should go', async () => {
  const { run } = await app();
  const keep = plain(run(`cancelPlan(${JSON.stringify(ORDERS)}, 501)`));
  assert.equal(keep.error, '');
  assert.equal(keep.partner.orderId, 502);
  assert.equal(keep.keep, true);
  assert.deepEqual(keep.steps, [{ kind: 'cancel', orderId: 501 }, { kind: 'place', order: { orderType: 'STOP', session: 'NORMAL', duration: 'GOOD_TILL_CANCEL', orderStrategyType: 'SINGLE',
    stopPrice: 140, orderLegCollection: [{ instruction: 'SELL', quantity: 50, instrument: { symbol: 'AMD', assetType: 'EQUITY' } }] } }]);
  const both = plain(run(`cancelPlan(${JSON.stringify(ORDERS)}, '501', { keep: false })`));
  assert.deepEqual(both.steps, [{ kind: 'cancel', orderId: 501 }], 'ids match as strings too');
  assert.equal(both.keep, false);
  const alone = plain(run(`cancelPlan(${JSON.stringify(ORDERS)}, 102)`));
  assert.deepEqual([alone.partner, alone.steps.length], [null, 1]);
  const trailing = [{ orderId: 700, status: 'WORKING', orderStrategyType: 'OCO', childOrderStrategies: [single(701, 'LIMIT', 'AMD', 'SELL', 50, 170), single(702, 'TRAILING_STOP', 'AMD', 'SELL', 50, 0, { stopPriceOffset: 2 })] }];
  const t = plain(run(`cancelPlan(${JSON.stringify(trailing)}, 701)`));
  assert.match(t.keepError, /A trailing stop can't be placed again from here/);
  assert.equal(t.keep, false);
  assert.deepEqual(t.steps.map(s => s.kind), ['cancel']);
});

test('an entry takes its waiting stop with it; the waiting stop alone can\'t be cancelled from here', async () => {
  const { run } = await app();
  const plan = plain(run(`cancelPlan(${JSON.stringify([ENTRY])}, 600)`));
  assert.deepEqual(plan.children.map(c => c.orderId), [601]);
  assert.match(run(`cancelPlan(${JSON.stringify([ENTRY])}, 601).error`), /This waits on its buy order\. Cancel that one and this goes with it/);
  assert.match(run(`cancelPlan(${JSON.stringify(ORDERS)}, 999).error`), /no longer shows this order as working/);
  assert.match(run(`cancelPlan(${JSON.stringify(ORDERS)}, 103).error`), /^$/);
});

test('working orders get a Cancel button, except one waiting on its entry', async () => {
  const b = broker();
  b.live.orders.push(plain(ENTRY));
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run('refreshPositions()');
  const html = elements.get('positionsSection').innerHTML;
  const card = html.slice(html.indexOf('orders-card'));
  for (const id of [101, 102, 103, 201, 401, 501, 502, 600]) assert.match(card, new RegExp(`data-action="openOrderCancel" data-arg="${id}"`), String(id));
  assert.doesNotMatch(card, /data-arg="601"/);
});

test('cancelling a target keeps its stop: the pair goes, the stop goes back alone, and Schwab confirms both', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run('refreshPositions()');
  await run("actions.openOrderCancel({ dataset: { arg: '501' } })");
  assert.equal(elements.get('cancelSheet').style.display, '');
  const review = elements.get('cancelBody').innerHTML;
  assert.match(review, /Sell limit \$170\.00 · 50 shares AMD/);
  assert.match(review, /It's paired with the sell stop \$140\.00 for 50 shares\. Schwab cancels the two together\./);
  assert.match(review, /aria-pressed="true" data-action="setCancelKeep" data-arg="keep"[^>]*><strong>Keep the stop<\/strong><span>Placed again on its own: sell stop \$140\.00 for 50 shares, until canceled\./);
  assert.match(review, /Cancel sell limit \$170\.00 for 50 shares AMD, and with it the paired sell stop \$140\.00/);
  assert.match(review, /Place the sell stop \$140\.00 for 50 shares again on its own/);
  assert.match(review, /Until the stop is placed again, 50 shares have no stop for a moment\./);
  assert.match(review, /data-action="sendOrderCancel"[^>]*>Cancel sell limit \$170\.00</);
  assert.equal(b.sent.length, 0, 'nothing is sent from the review');

  await run('sendOrderCancel()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/501', 'POST /orders']);
  assert.equal(b.sent[1].body.orderType, 'STOP');
  assert.match(elements.get('cancelBody').innerHTML, /Schwab no longer shows the sell limit \$170\.00\. The sell stop \$140\.00 for 50 shares is working on its own\./);
  await run('sendOrderCancel()');
  assert.equal(b.sent.length, 2, 'a sent ticket never goes again');
});

test('cancelling both halves says the shares lose their stop, and sends only the cancel', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run('refreshPositions()');
  await run('openOrderCancel(501)');
  run("actions.setCancelKeep({ dataset: { arg: 'both' } })");
  const review = elements.get('cancelBody').innerHTML;
  assert.match(review, /aria-pressed="true" data-action="setCancelKeep" data-arg="both"/);
  assert.match(review, /The stop goes too: those 50 shares lose it\./);
  assert.match(review, /After this, your 50 AMD have no stop\./);
  assert.doesNotMatch(review, /<li class="pos-step">Place/, 'nothing placed again');
  await run('sendOrderCancel()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/501']);
  assert.match(elements.get('cancelBody').innerHTML, /Schwab no longer shows the sell limit \$170\.00\./);
});

test('cancelling one of several stops says what the rest still cover', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run('refreshPositions()');
  await run('openOrderCancel(102)');
  assert.match(elements.get('cancelBody').innerHTML, /After this, stops cover 250 of your 300 HOOD\./);
  await run('sendOrderCancel()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/102']);
  assert.match(elements.get('cancelBody').innerHTML, /trade-result ok[\s\S]*Schwab no longer shows the sell stop \$34\.00\./);
});

test('a cancel that loses to a fill says so and sends nothing more', async () => {
  const b = broker({ refuse: (c, live) => {
    if (c.method !== 'DELETE') return null;
    const pair = live.orders.find(o => o.orderId === 500);
    pair.childOrderStrategies[0].status = 'FILLED';
    pair.childOrderStrategies[1].status = 'CANCELED';
    return json({ message: 'Order cannot be canceled.' }, 400);
  } });
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run('refreshPositions()');
  await run('openOrderCancel(501)');
  await run('sendOrderCancel()');
  assert.deepEqual(b.sent.map(c => c.method), ['DELETE'], 'the stop is not placed again over a filled target');
  const html = elements.get('cancelBody').innerHTML;
  assert.match(html, /Schwab filled the sell limit \$170\.00 before it could be cancelled\. Nothing more was sent\./);
  assert.match(html, /Schwab shows the sell limit \$170\.00 filled\./);
  assert.match(html, /Schwab lists for AMD/);
});

test('an entry cancel names the stop waiting on it; a stale order can\'t be cancelled', async () => {
  const b = broker();
  b.live.orders.push(plain(ENTRY));
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run('refreshPositions()');
  await run('openOrderCancel(600)');
  assert.match(elements.get('cancelBody').innerHTML, /Its sell stop \$104\.00, waiting on it, is cancelled too\./);
  b.live.orders = b.live.orders.filter(o => o.orderId !== 600);
  await run('openOrderCancel(600)');
  assert.match(elements.get('cancelBody').innerHTML, /no longer shows this order as working/);
  assert.doesNotMatch(elements.get('cancelBody').innerHTML, /sendOrderCancel/);
});

// ---------- a breakeven stop never loosens a stop ----------

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const two = () => { const s = connected(); s.set('schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }, { hash: 'HASH2', last4: '4321' }])); return s; };
const marked = (symbol, mark) => POSITIONS.map(p => p.instrument.symbol === symbol ? { ...p, marketValue: (p.longQuantity || -p.shortQuantity) * mark } : p);
const rowAt = (symbol, mark, orders) => `positionRows(${JSON.stringify(account(marked(symbol, mark)))}, ${JSON.stringify(orders)}).rows.find(r => r.symbol === '${symbol}')`;

test('stops already past breakeven stay where they are: nothing to move, long or short', async () => {
  const { run } = await app();
  // long 300 HOOD from $38.20, now $50, a sell stop at $45 for all of it: moving it to $38.20 would give up $2,040
  const long = rowAt('HOOD', 50, [single(101, 'STOP', 'HOOD', 'SELL', 300, 45)]);
  for (const limits of ['pair', 'keep', 'cancel']) {
    const plan = plain(run(`breakevenPlan(${long}, 'GOOD_TILL_CANCEL', { limits: '${limits}' })`));
    assert.match(plan.error, /Every share already has a stop at or past breakeven\. Moving it would loosen it\./, limits);
    assert.deepEqual(plan.steps, []);
  }
  assert.equal(run(`atBreakeven(${long})`), true);
  // short 40 TSLA from $262, now $230, a cover stop at $240
  const short = rowAt('TSLA', 230, [single(201, 'STOP', 'TSLA', 'BUY_TO_COVER', 40, 240)]);
  assert.match(run(`breakevenPlan(${short}, 'DAY').error`), /already has a stop at or past breakeven/);
  assert.equal(run(`atBreakeven(${short})`), true);
  assert.equal(run(`atBreakeven(${rowAt('TSLA', 230, [single(201, 'STOP', 'TSLA', 'BUY_TO_COVER', 40, 270)])})`), false);
});

test('only the shares without a stop past breakeven get one; the better stop is kept as it is', async () => {
  const { run } = await app();
  const orders = [single(101, 'STOP', 'HOOD', 'SELL', 200, 45), single(102, 'STOP', 'HOOD', 'SELL', 100, 34)];
  const plan = plain(run(`breakevenPlan(${rowAt('HOOD', 50, orders)}, 'GOOD_TILL_CANCEL')`));
  assert.equal(plan.error, '');
  assert.deepEqual(plan.steps.map(s => [s.kind, s.orderId ?? null]), [['replace', 102]], 'the $45 stop is not touched');
  assert.equal(plan.steps[0].order.stopPrice, 38.2);
  assert.equal(plan.steps[0].order.orderLegCollection[0].quantity, 100);
  assert.equal(plan.kept, 200);
  assert.ok(Math.abs(plan.locked - (45 - 38.2) * 200) < 1e-6, 'the kept stop locks its own gain, breakeven locks nothing');
  // a short the same way: $240 kept for 30, the $270 stop moves to $262 for the other 10
  const short = plain(run(`breakevenPlan(${rowAt('TSLA', 230, [single(201, 'STOP', 'TSLA', 'BUY_TO_COVER', 30, 240), single(202, 'STOP', 'TSLA', 'BUY_TO_COVER', 10, 270)])}, 'DAY')`));
  assert.deepEqual(short.steps.map(s => [s.kind, s.orderId, s.order.stopPrice, s.order.orderLegCollection[0].quantity]), [['replace', 202, 262, 10]]);
  // no stop for the rest: a new one for just those shares
  const placed = plain(run(`breakevenPlan(${rowAt('HOOD', 50, [single(101, 'STOP', 'HOOD', 'SELL', 200, 45)])}, 'DAY')`));
  assert.deepEqual(placed.steps.map(s => [s.kind, s.order.orderLegCollection[0].quantity]), [['place', 100]]);
});

test('a pair whose stop is past breakeven stays; cancelling it would loosen it, so that choice is refused', async () => {
  const { run } = await app();
  const orders = [single(102, 'STOP', 'HOOD', 'SELL', 200, 34),
    { orderId: 600, status: 'WORKING', orderStrategyType: 'OCO', childOrderStrategies: [single(601, 'LIMIT', 'HOOD', 'SELL', 100, 55), single(602, 'STOP', 'HOOD', 'SELL', 100, 40)] }];
  const row = rowAt('HOOD', 50, orders);
  for (const limits of ['pair', 'keep']) {
    const plan = plain(run(`breakevenPlan(${row}, 'GOOD_TILL_CANCEL', { limits: '${limits}' })`));
    assert.deepEqual(plan.steps.map(s => [s.kind, s.orderId ?? null]), [['replace', 102]], `${limits}: the pair is left alone`);
    assert.equal(plan.steps[0].order.orderLegCollection[0].quantity, 200);
  }
  assert.match(run(`breakevenPlan(${row}, 'DAY', { limits: 'cancel' }).error`), /Your stop \$40\.00 paired with a limit is already past breakeven\. Cancelling it would loosen it\./);
});

test('cancelling the limits keeps the stops past breakeven and covers only the rest', async () => {
  const { run } = await app();
  // 300 held, a target for 100, a $40 stop for 250: the stop can't shrink for a pair without loosening, but cancelling the target works
  const orders = [single(101, 'STOP', 'HOOD', 'SELL', 250, 40), single(103, 'LIMIT', 'HOOD', 'SELL', 100, 55)];
  const row = rowAt('HOOD', 50, orders);
  assert.match(run(`breakevenPlan(${row}, 'DAY', { limits: 'pair' }).error`), /Stops at or past breakeven already cover 250, more than the 200 outside your limits/);
  assert.match(run(`breakevenPlan(${row}, 'DAY', { limits: 'keep' }).error`), /already at or past breakeven/);
  const cancel = plain(run(`breakevenPlan(${row}, 'DAY', { limits: 'cancel' })`));
  assert.deepEqual(cancel.steps.map(s => [s.kind, s.orderId ?? null]), [['cancel', 103], ['place', null]]);
  assert.equal(cancel.steps[1].order.orderLegCollection[0].quantity, 50);
  assert.equal(cancel.steps[1].order.stopPrice, 38.2);
});

test('a stop limit moved to breakeven keeps its limit as far away; a trailing stop short of it is cancelled, not rebuilt', async () => {
  const { run } = await app();
  const stopLimit = plain(run(`breakevenPlan(${rowWith('HOOD', [single(101, 'STOP_LIMIT', 'HOOD', 'SELL', 300, 35.5, { price: 35.3 })])}, 'DAY')`));
  assert.deepEqual(stopLimit.steps.map(s => [s.kind, s.order.orderType, s.order.stopPrice, s.order.price]), [['replace', 'STOP_LIMIT', 38.2, 38]]);
  const trailing = plain(run(`breakevenPlan(${rowWith('HOOD', [single(101, 'TRAILING_STOP', 'HOOD', 'SELL', 300, 35.5, { stopPriceOffset: 2 })])}, 'DAY')`));
  assert.deepEqual(trailing.steps.map(s => [s.kind, s.orderId ?? null]), [['cancel', 101], ['place', null]]);
  assert.equal(trailing.steps[1].order.orderType, 'STOP');
});

test('a stop cut for a target or a partial close keeps its type; a trailing stop can\'t be cut', async () => {
  const { run } = await app();
  const stopLimit = [single(101, 'STOP_LIMIT', 'HOOD', 'SELL', 300, 35.5, { price: 35.3, duration: 'DAY' })];
  const target = plain(run(targetFor('HOOD', 50, 100, stopLimit)));
  assert.deepEqual(target.steps[0].order, { orderType: 'STOP_LIMIT', session: 'NORMAL', duration: 'DAY', orderStrategyType: 'SINGLE', stopPrice: 35.5, price: 35.3,
    orderLegCollection: [{ instruction: 'SELL', quantity: 200, instrument: { symbol: 'HOOD', assetType: 'EQUITY' } }] });
  const close = plain(run(`closePlan(${rowWith('HOOD', stopLimit)}, { type: 'MARKET', qty: 100 })`));
  assert.equal(close.steps[0].order.orderType, 'STOP_LIMIT');
  assert.equal(close.steps[0].order.price, 35.3);
  const trailing = [single(101, 'TRAILING_STOP', 'HOOD', 'SELL', 300, 35.5, { stopPriceOffset: 2 })];
  assert.match(run(targetFor('HOOD', 50, 100, trailing) + '.error'), /Your trailing stop for 300 can't be cut to fewer from here\. Change it in Schwab first\./);
  assert.match(run(`closePlan(${rowWith('HOOD', trailing)}, { type: 'MARKET', qty: 100 }).error`), /trailing stop for 300 can't be cut/);
  assert.equal(run(`closePlan(${rowWith('HOOD', trailing)}).error`), '', 'closing all of it just cancels the trailing stop');
});

test('the table says a stop is past breakeven instead of offering to move it', async () => {
  const b = broker();
  b.live.positions = marked('HOOD', 50);
  b.live.orders = [single(101, 'STOP', 'HOOD', 'SELL', 300, 45), single(401, 'STOP', 'QQQ', 'SELL', 10, 400)];
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run('refreshPositions()');
  const html = elements.get('positionsSection').innerHTML;
  const cell = symbol => html.split('<tr>').find(r => r.includes(`>${symbol}<`)) || '';
  assert.match(cell('HOOD'), /stop past breakeven/);
  assert.doesNotMatch(cell('HOOD'), /data-arg2="breakeven"/);
  assert.match(cell('QQQ'), /stop at breakeven/);
});

// ---------- re-checked before sending ----------

test('a position trade is checked against Schwab again before it goes; a changed plan is shown, not sent', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('TSLA', 'breakeven')");
  assert.match(elements.get('posTradeBody').innerHTML, /Replace stop \$270\.00 for 40 shares with stop \$262\.00 for 40 shares/);
  b.live.orders.push(single(202, 'STOP', 'TSLA', 'BUY_TO_COVER', 40, 280)); // another stop showed up since the review opened
  await run('placePositionTrade()');
  assert.equal(b.sent.length, 0, 'nothing goes when Schwab shows something else');
  const html = elements.get('posTradeBody').innerHTML;
  assert.match(html, /Schwab changed since you opened this, so nothing was sent\. This is what it would send now: review it, then send again\./);
  assert.match(html, /Cancel stop \$280\.00 for 40 shares/);
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/202', 'PUT /orders/201'], 'the reviewed update goes as shown');
});

test('a price through the stop by send time sends nothing and says why', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('TSLA', 'breakeven')");
  b.live.positions = marked('TSLA', 263); // the short is now under water: a $262 cover stop would fire at once
  await run('placePositionTrade()');
  assert.equal(b.sent.length, 0);
  assert.match(elements.get('posTradeBody').innerHTML, /Nothing was sent\. The price \$263\.00 is at or above the breakeven stop \$262\.00/);
  assert.doesNotMatch(elements.get('posTradeBody').innerHTML, /data-action="placePositionTrade"/);
});

test('a review waits for the newest read when another refresh overtakes its own', async () => {
  const b = broker();
  const gates = [], opened = [];
  const fetch = async (url, init = {}) => {
    if (url.endsWith('?fields=positions')) { const n = opened.push(url); await gates[n - 1]; }
    return b.fetch(url, init);
  };
  const release = [];
  for (let i = 0; i < 2; i++) gates.push(new Promise(r => release.push(r)));
  const { run, state } = await app({ fetch, storage: connected() });
  const open = run("openPositionTrade('TSLA', 'breakeven')");
  await settle();
  run('refreshPositions()'); // the 30s timer, or a tap on Refresh, while the review's read is out
  await settle();
  release[0](); // the review's own read lands first, already overtaken
  await settle();
  assert.equal(state.posTicket, null, 'no ticket from a read that was overtaken');
  release[1]();
  await open;
  assert.equal(state.posTicket.error, '');
  assert.deepEqual(plain(state.posTicket.steps.map(s => s.kind)), ['replace']);
});

test('a full limit close at a target\'s price is confirmed though the plan cancelled that target', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run("openPositionTrade('HOOD', 'close')");
  run("setCloseType('LIMIT')");
  run("setClosePrice('45')"); // where the 100-share target sits
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/103', 'DELETE /orders/102', 'DELETE /orders/101', 'POST /orders']);
  assert.match(elements.get('posTradeBody').innerHTML, /trade-result ok[\s\S]*Schwab now shows a limit \$45\.00 for 300 shares, paired with a stop at \$35\.50/);
});

// ---------- bound to one account ----------

test('a position ticket goes only to the account it was read from', async () => {
  const b = broker();
  const storage = two();
  const { run, elements } = await app({ fetch: b.fetch, storage });
  await run("openPositionTrade('TSLA', 'breakeven')");
  storage.set('schwab_account', 'HASH2'); // another account picked while the review is open
  await run('placePositionTrade()');
  assert.equal(b.sent.length, 0);
  assert.match(elements.get('posTradeBody').innerHTML, /You switched Schwab accounts since this was reviewed\. Nothing was sent\./);
});

test('switching accounts mid-run stops the next step before it leaves', async () => {
  let storage;
  const b = broker({ refuse: c => { if (c.method === 'DELETE' && c.path === '/orders/103') storage.set('schwab_account', 'HASH2'); return null; } });
  storage = two();
  const { run, elements } = await app({ fetch: b.fetch, storage });
  await run("openPositionTrade('HOOD', 'close')");
  await run('placePositionTrade()');
  assert.deepEqual(b.sent.map(c => `${c.method} ${c.path}`), ['DELETE /orders/103'], 'nothing goes to either account after the switch');
  assert.match(elements.get('posTradeBody').innerHTML, /You switched Schwab accounts since this was reviewed\. Nothing more was sent\./);
});

test('the wait after an unconfirmed order is per account and symbol', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  run("posLast = { hash: 'HASH2', symbol: 'TSLA', at: Date.now(), confirmed: false }");
  await run("openPositionTrade('TSLA', 'breakeven')");
  assert.doesNotMatch(elements.get('posTradeBody').innerHTML, /has not shown up at Schwab yet/, 'another account\'s order does not hold this one');
  run("posLast = { hash: 'HASH1', symbol: 'TSLA', at: Date.now(), confirmed: false }");
  await run("openPositionTrade('TSLA', 'breakeven')");
  assert.match(elements.get('posTradeBody').innerHTML, /Your last order on TSLA has not shown up at Schwab yet/);
});

// ---------- keeping the other half of a pair ----------

const fillTarget = status => (c, live) => {
  if (c.method !== 'DELETE' || c.path !== '/orders/502') return null;
  const pair = live.orders.find(o => o.orderId === 500);
  pair.childOrderStrategies[0].status = 'FILLED'; // the target sold first, and Schwab cancelled its stop with it
  pair.childOrderStrategies[1].status = 'CANCELED';
  return status === 200 ? new Response(null, { status: 200 }) : json({ message: 'Order cannot be canceled.' }, 400);
};

for (const status of [400, 200]) {
  test(`keeping the target is never a new sell over a target that filled (cancel answered ${status})`, async () => {
    const b = broker({ refuse: fillTarget(status) });
    const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
    await run('refreshPositions()');
    await run('openOrderCancel(502)'); // cancel the stop, keep the limit
    assert.match(elements.get('cancelBody').innerHTML, /Place the sell limit \$170\.00 for 50 shares again on its own/);
    await run('sendOrderCancel()');
    assert.deepEqual(b.sent.map(c => c.method), ['DELETE'], 'the limit is not placed again');
    const html = elements.get('cancelBody').innerHTML;
    assert.match(html, /Schwab shows the sell limit \$170\.00 filled, so it was not placed again\./);
    assert.doesNotMatch(html, /went with it/);
  });
}

test('keeping the other half waits for Schwab to show it cancelled', async () => {
  const b = broker({ refuse: c => c.method === 'DELETE' ? new Response(null, { status: 200 }) : null }); // accepted, but nothing changed yet
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run('refreshPositions()');
  await run('openOrderCancel(501)');
  await run('sendOrderCancel()');
  assert.deepEqual(b.sent.map(c => c.method), ['DELETE']);
  assert.match(elements.get('cancelBody').innerHTML, /Schwab shows the sell stop \$140\.00 working, so it was not placed again\. Check Schwab\./);
});

test('a cancel is checked against Schwab again before it goes', async () => {
  const b = broker();
  const { run, elements } = await app({ fetch: b.fetch, storage: connected() });
  await run('refreshPositions()');
  await run('openOrderCancel(501)');
  const stop = b.live.orders.find(o => o.orderId === 500).childOrderStrategies[1];
  stop.stopPrice = 145; // the paired stop was changed in Schwab meanwhile
  await run('sendOrderCancel()');
  assert.equal(b.sent.length, 0);
  assert.match(elements.get('cancelBody').innerHTML, /Schwab changed since you opened this, so nothing was sent/);
  assert.match(elements.get('cancelBody').innerHTML, /Place the sell stop \$145\.00 for 50 shares again on its own/);
  await run('sendOrderCancel()');
  assert.deepEqual(b.sent.map(c => c.method), ['DELETE', 'POST']);
  assert.equal(b.sent[1].body.stopPrice, 145);
});
