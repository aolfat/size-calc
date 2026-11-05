// Run with: node --test
// Option entries at Schwab: a chain contract bought to open at a limit (mid, ask, bid or typed), sized by the card, with a stop on
// the option at the loss model's price for your underlying stop; reviewed, re-checked against a fresh quote, sent once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const OCC = 'TEST261218C00100000', SCHWAB = 'TEST  261218C00100000';
const json = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const plain = v => JSON.parse(JSON.stringify(v));

const connected = () => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }])],
  ['schwab_account', 'HASH1'],
]);

// the chain's detail for one call: 3 contracts lose $150 each from the $3.00 mid to $1.50 at the $98 stop
const CONTRACT = {
  opt: { symbol: OCC, strike: 100, bid: 2.9, ask: 3.1, contract_size: 100, root_symbol: 'TEST' }, isCall: true, contracts: 3, lossPerContract: 150,
  lossPerContractON: 0, totalCost: 900, atStop: 1.5, entryPrem: 3, mid: 3, stop: 98, lossOfCost: 50, lossOfCostON: 0,
  vol: 10, oi: 20, delta: 0.5, iv: 0.3, model: 'bs', customEntry: false, entryU: 100, itm: false, wideSpread: false, spreadPct: 6.7,
};

// Tradier answers the contract's quote (changeable), Schwab takes the order and reports it
function network() {
  const calls = [], posts = [];
  const quote = { bid: 2.9, ask: 3.1, last: 3 };
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    if (url.includes('/markets/quotes')) return json({ quotes: { quote: { symbol: OCC, ...quote } } });
    if (!url.startsWith(PROXY)) return json({});
    const path = url.slice(PROXY.length);
    if (path === '/trader/v1/accounts/HASH1/orders' && init.method === 'POST') {
      posts.push(JSON.parse(init.body));
      return json(null, 201, { Location: `${PROXY}/trader/v1/accounts/HASH1/orders/2001` });
    }
    if (path === '/trader/v1/accounts/HASH1/orders/2001') return json({ status: 'WORKING', childOrderStrategies: [{ status: 'AWAITING_PARENT_ORDER' }] });
    return json({}, 404);
  };
  return { calls, posts, quote, fetch };
}

async function chain(opts = {}, contract = CONTRACT) {
  const h = await app({ width: 1400, ...opts });
  h.run(`quoteData = { symbol: 'TEST', type: 'stock', last: 100, bid: 99.98, ask: 100.02, low: 98, high: 102 }; selectedExp = '2026-12-18';
    document.getElementById('apiKey').value = 'tradier-test';
    globalThis.__tr = { classList: { add() {}, remove() {} }, nextSibling: null, parentNode: { insertBefore() {} } };
    showDetail(__tr, ${JSON.stringify(contract)}, 50000)`);
  return h;
}

// ---------- the order ----------

test('a bought option is a limit buy to open that triggers a sell-to-close stop on the option, in Schwab\'s padded symbol', async () => {
  const { run } = await app();
  assert.equal(run(`schwabOptionSymbol('${OCC}')`), SCHWAB);
  assert.equal(run("schwabOptionSymbol('SPY261218P00500000')"), 'SPY   261218P00500000');
  assert.equal(run("schwabOptionSymbol('AAPL')"), '');
  assert.deepEqual(plain(run(`optionEntryOrder({ symbol: '${SCHWAB}', qty: 3, limit: 3, stop: 1.5, stopDuration: 'GOOD_TILL_CANCEL' })`)), {
    orderType: 'LIMIT', session: 'NORMAL', duration: 'DAY', price: 3, orderStrategyType: 'TRIGGER',
    orderLegCollection: [{ instruction: 'BUY_TO_OPEN', quantity: 3, instrument: { symbol: SCHWAB, assetType: 'OPTION' } }],
    childOrderStrategies: [{ orderType: 'STOP', session: 'NORMAL', duration: 'GOOD_TILL_CANCEL', orderStrategyType: 'SINGLE', stopPrice: 1.5,
      orderLegCollection: [{ instruction: 'SELL_TO_CLOSE', quantity: 3, instrument: { symbol: SCHWAB, assetType: 'OPTION' } }] }],
  });
});

test('an option entry is refused without a market, a contract, or a stop under the bid; a limit at or under the stop is held back', async () => {
  const { run } = await app();
  const err = t => run(`optionTicketError(${JSON.stringify({ qty: 3, bid: 2.9, ask: 3.1, stop: 1.5, ...t })})`);
  assert.equal(err({}), '');
  assert.match(err({ bid: 0 }), /no two-sided market/);
  assert.match(err({ bid: 3.2 }), /crossed/);
  assert.match(err({ qty: 0 }), /less than one contract/);
  assert.match(err({ stop: 0 }), /near \$0/);
  assert.match(err({ stop: 2.9 }), /at or above the bid \$2\.90/);
  assert.equal(run("optionLimitError({ limit: 3, stop: 1.5 })"), '');
  assert.match(run("optionLimitError({ limit: 0, stop: 1.5 })"), /Set a limit price/);
  assert.match(run("optionLimitError({ limit: 1.5, stop: 1.5 })"), /at or under the option stop/);
});

// ---------- the button ----------

test('the contract detail shows Trade at Schwab while connected and sizing by risk, greyed out with why', async () => {
  const off = await chain();
  assert.doesNotMatch(off.elements.get('optionTicket').innerHTML, /openOptionTrade/, 'not connected: no button');
  const on = await chain({ storage: connected() });
  assert.match(on.elements.get('optionTicket').innerHTML, /data-action="openOptionTrade" data-arg="TEST261218C00100000" title="Review a limit buy[^"]*">Trade at Schwab/);
  const none = await chain({ storage: connected() }, { ...CONTRACT, contracts: 0 });
  assert.match(none.elements.get('optionTicket').innerHTML, /title="Your max loss buys less than one contract at this stop\." disabled>Trade at Schwab/);
  const adjusted = await chain({ storage: connected() }, { ...CONTRACT, opt: { ...CONTRACT.opt, root_symbol: 'TEST1', contract_size: 100 } });
  assert.match(adjusted.elements.get('optionTicket').innerHTML, /title="Only standard 100-share contracts trade from here[^"]*" disabled/);
});

// ---------- the review and the send ----------

test('the review buys the card\'s contracts at the mid with the model\'s option stop, and Place sends exactly that once', async () => {
  const net = network();
  const { run, elements, state } = await chain({ fetch: net.fetch, storage: connected() });
  await run(`openOptionTrade('${OCC}')`);
  assert.notEqual(elements.get('tradeSheet').style.display, 'none');
  const body = () => elements.get('tradeBody').innerHTML;
  const t = state.tradeTicket;
  assert.equal(t.option, true);
  assert.equal(t.qty, 3);
  assert.equal(t.limitPrice, 3);
  assert.equal(t.stop, 1.5);
  assert.match(body(), /<strong>TEST 12\/18\/26 100C<\/strong>/);
  assert.match(body(), /aria-pressed="true" data-action="setOptionEntry" data-arg="mid"/);
  assert.match(body(), /Buy to open 3 at \$3\.00 limit/);
  assert.match(body(), /Sell to close 3 at \$1\.50<\/strong>[^]*Your TEST stop \$98\.00 puts it near \$1\.50 \(Black-Scholes\)/);
  assert.match(body(), /class="shares-loss">\$450\.00</);
  assert.match(body(), />Buy 3 TEST 12\/18\/26 100C at \$3\.00</);
  assert.match(elements.get('tradeQuote').innerHTML, /fills"><span class="tq-label">Ask/, 'a buy fills at the ask');

  await run('Promise.all([placeOptionTrade(), placeOptionTrade()])');
  await run('placeOptionTrade()');
  await run('placeTrade()'); // the shares send leaves an option ticket alone
  assert.equal(net.posts.length, 1, 'one review, one order');
  assert.deepEqual(net.posts[0], plain(t.order));
  assert.equal(net.posts[0].orderLegCollection[0].instrument.symbol, SCHWAB);
  assert.match(body(), /Order 2001: working\. Stop \$1\.50: awaiting parent order\./);
  assert.match(body(), /data-action="openOrderEdit" data-arg="2001"[^>]*>Change limit</, 'a waiting limit can move through Positions\' Edit');
  assert.deepEqual(plain(state.tradeLast).symbol, SCHWAB);
});

test('Ask, Bid and your own limit reprice the entry; a limit under the stop holds the order back', async () => {
  const net = network();
  const { run, elements, state } = await chain({ fetch: net.fetch, storage: connected() });
  await run(`openOptionTrade('${OCC}')`);
  const body = () => elements.get('tradeBody').innerHTML;
  run("setOptionEntry('ask')");
  assert.equal(state.tradeTicket.limitPrice, 3.1);
  assert.match(body(), /At the ask, so it likely fills now/);
  run("setOptionEntry('bid')");
  assert.equal(state.tradeTicket.limitPrice, 2.9);
  assert.match(body(), /At the bid: it waits for a seller/);
  run("setOptionEntry('limit')");
  assert.match(body(), /id="tradeLimit"[^>]*value="2.90"/, 'Limit starts where the last price was');
  run("setOptionLimit('1.4')");
  assert.match(elements.get('tradeDetail').innerHTML, /The limit \$1\.40 is at or under the option stop \$1\.50/);
  assert.equal(state.tradeTicket.order, null);
  run("setOptionLimit('2.97')");
  assert.equal(state.tradeTicket.limitPrice, 2.95, 'a typed price snaps to the step the quote shows');
  assert.equal(state.tradeTicket.order.price, 2.95);
  run("setOptionStopDuration('DAY')");
  assert.equal(state.tradeTicket.order.childOrderStrategies[0].duration, 'DAY');
});

test('a penny-quoted contract buys at its own mid', async () => {
  const net = network();
  Object.assign(net.quote, { bid: 2.92, ask: 2.97 });
  const { run, state } = await chain({ fetch: net.fetch, storage: connected() });
  await run(`openOptionTrade('${OCC}')`);
  assert.equal(state.tradeTicket.limitPrice, 2.95, 'the $2.945 mid, up a penny');
});

test('the review flags a wide market and risk over the plan, and a planned entry the limit doesn\'t wait for', async () => {
  const net = network();
  Object.assign(net.quote, { bid: 2.5, ask: 3.5 });
  const { run, state } = await chain({ fetch: net.fetch, storage: connected() }, { ...CONTRACT, customEntry: true, entryU: 101 });
  await run(`openOptionTrade('${OCC}')`);
  const w = state.tradeTicket.warnings.join(' ');
  assert.match(w, /Wide market: \$2\.50 × \$3\.50 is 33% of the mid/);
  run("setOptionEntry('ask')");
  assert.match(state.tradeTicket.warnings.join(' '), /At the limit \$3\.50, risk is \$600\.00, over your \$450\.00 plan/);
  assert.match(w, /Sized for your planned TEST entry \$101\.00/);
});

test('Place reads the quote again: a stop now at the bid sends nothing', async () => {
  const net = network();
  const { run, elements } = await chain({ fetch: net.fetch, storage: connected() });
  await run(`openOptionTrade('${OCC}')`);
  Object.assign(net.quote, { bid: 1.4, ask: 1.6 });
  await run('placeOptionTrade()');
  assert.equal(net.posts.length, 0);
  assert.match(elements.get('tradeBody').innerHTML, /The option stop \$1\.50 is at or above the bid \$1\.40[^]*Nothing was sent/);
});

test('a new warning at Place waits for a second Place', async () => {
  const net = network();
  const { run, state } = await chain({ fetch: net.fetch, storage: connected() });
  await run(`openOptionTrade('${OCC}')`);
  Object.assign(net.quote, { bid: 2.6, ask: 3.4 });
  await run('placeOptionTrade()');
  assert.equal(net.posts.length, 0);
  assert.match(state.tradeTicket.result.text, /The quote moved since you reviewed this/);
  await run('placeOptionTrade()');
  assert.equal(net.posts.length, 1, 'the warning has been shown');
});

test('no quote, no review', async () => {
  const net = network();
  const fetch = async (url, init) => url.includes('/markets/quotes') ? json({ quotes: null }) : net.fetch(url, init);
  const { run, elements } = await chain({ fetch, storage: connected() });
  await run(`openOptionTrade('${OCC}')`);
  assert.equal(elements.get('tradeSheet').style.display, 'none');
});
