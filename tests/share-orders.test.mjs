// Run with: node --test
// Share order cards: the shares answer pinned as many times as you like, each card sized and sent to Schwab on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const json = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const connected = () => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }])],
  ['schwab_account', 'HASH1'],
]);

const QUOTES = {
  AAA: { symbol: 'AAA', type: 'stock', last: 100, bid: 99.98, ask: 100.02, low: 98, high: 102 },
  BBB: { symbol: 'BBB', type: 'stock', last: 50, bid: 49.99, ask: 50.01, low: 49, high: 51 },
};

// Tradier answers each symbol with its own quote; Schwab orders get ids 1001, 1002, ... and read back filled
function network() {
  const calls = [];
  let nextId = 1000;
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (url.startsWith(PROXY)) {
      const path = url.slice(PROXY.length);
      if (path === '/trader/v1/accounts/HASH1/orders' && init.method === 'POST') return json(null, 201, { Location: `${PROXY}/trader/v1/accounts/HASH1/orders/${++nextId}` });
      if (/\/orders\/\d+$/.test(path)) return json({ status: 'FILLED', childOrderStrategies: [{ status: 'WORKING' }] });
      return json({}, 404);
    }
    if (url.includes('/markets/quotes')) {
      const sym = decodeURIComponent(url.match(/symbols=([^&]+)/)[1]);
      return json({ quotes: { quote: QUOTES[sym] } });
    }
    return json({});
  };
  return { calls, fetch, posts: () => calls.filter(c => c.url.startsWith(PROXY) && c.method === 'POST').map(c => JSON.parse(c.body)) };
}

async function loaded(symbol, opts) {
  const h = await app(opts);
  h.run(`document.getElementById('apiKey').value = 'tradier-test';
    document.getElementById('riskDollar').value = '500';`);
  load(h, symbol);
  return h;
}

const load = (h, symbol) => h.run(`quoteData = ${JSON.stringify(QUOTES[symbol])};
  document.getElementById('ticker').value = '${symbol}';
  renderShares();`);

const cardIds = state => Object.keys(state.pinnedData).filter(id => state.pinnedData[id].kind === 'shares');

test('Pin order keeps the shares answer as a card, and a second ticker makes a second card', async () => {
  const h = await loaded('AAA', { storage: connected() });
  const { run, elements, state } = h;
  const pin = elements.get('sharesPin');
  assert.equal(pin.style.display, '');
  assert.equal(pin.disabled, false);
  const a = run('pinShares()');
  load(h, 'BBB');
  run("direction = 'short'; renderShares()");
  const b = run('pinShares()');
  assert.deepEqual(cardIds(state).sort(), [a, b].sort(), 'two cards, one per pin');
  const cardA = elements.get(a).innerHTML, cardB = elements.get(b).innerHTML;
  assert.match(cardA, /<span class="tag call">Long<\/span>\s*<span class="pinned-symbol">AAA shares<\/span>/);
  assert.match(cardA, /Shares to buy<\/div><div class="s-val">250</, '$500 over $2 to the LOD');
  assert.match(cardB, /<span class="tag put">Short<\/span>\s*<span class="pinned-symbol">BBB shares<\/span>/);
  assert.match(cardB, /Shares to short<\/div><div class="s-val">500</, '$500 over $1 to the HOD');
  assert.match(cardA, /data-action="openCardTrade" data-arg="[^"]+"/);

  run("document.getElementById('riskDollar').value = '1000'; renderPinnedCards()");
  assert.match(elements.get(a).innerHTML, /Shares to buy<\/div><div class="s-val">500</, 'cards size from the max loss now');
});

test('a pinned LOD stop follows a new low, and a typed stop stays put', async () => {
  const net = network();
  const h = await loaded('AAA', { fetch: net.fetch, storage: connected() });
  const { run, elements, state } = h;
  const a = run('pinShares()');
  QUOTES.AAA = { ...QUOTES.AAA, last: 99, bid: 98.98, ask: 99.02, low: 97 };
  try {
    await run(`refreshPinned('${a}')`);
    assert.equal(state.pinnedData[a].stopLevel, 97, 'the stop moved down to the new LOD');
    assert.equal(state.pinnedData[a].planCtx.stop_level, 97);
    assert.match(elements.get(a).innerHTML, /Shares to buy<\/div><div class="s-val">250</, '$500 over $2 from the 99 market to the 97 LOD');
    await run(`openCardTrade('${a}')`);
    assert.equal(state.tradeTicket.stop, 97);
    run('closeSheet()');
    run(`shareOrderStopChanged('${a}', { value: '96.50' })`);
    QUOTES.AAA = { ...QUOTES.AAA, low: 96 };
    await run(`refreshPinned('${a}')`);
    assert.equal(state.pinnedData[a].stopLevel, 96.5, 'a typed stop is yours: the new low leaves it');
  } finally {
    QUOTES.AAA = { symbol: 'AAA', type: 'stock', last: 100, bid: 99.98, ask: 100.02, low: 98, high: 102 };
  }
});

test('a pinned stop keeps its buffer under a new low, and a custom stop pinned stays put', async () => {
  const net = network();
  const h = await loaded('AAA', { fetch: net.fetch, storage: connected() });
  const { run, state } = h;
  run("setStopStrategy('percent'); stopPercent = 1; renderShares()");
  const a = run('pinShares()');
  assert.equal(state.pinnedData[a].stopLevel, 97.02, 'LOD 98 less 1%');
  run("document.getElementById('stopLong').value = '97.50'; renderShares()");
  const b = run('pinShares()');
  QUOTES.AAA = { ...QUOTES.AAA, low: 97 };
  try {
    await run(`refreshPinned('${a}')`);
    await run(`refreshPinned('${b}')`);
    assert.equal(state.pinnedData[a].stopLevel, 96.02, 'the same 98 cent buffer under the new 97 low');
    assert.equal(state.pinnedData[b].stopLevel, 97.5);
  } finally {
    QUOTES.AAA = { symbol: 'AAA', type: 'stock', last: 100, bid: 99.98, ask: 100.02, low: 98, high: 102 };
  }
});

test('the pin button needs a valid stop, and stays away from futures and allocation', async () => {
  const { run, elements } = await loaded('AAA');
  const pin = elements.get('sharesPin');
  assert.equal(pin.style.display, '', 'pinning works without Schwab too');
  run("document.getElementById('stopLong').value = '101'; renderShares()");
  assert.equal(pin.disabled, true, 'a stop over the entry pins nothing');
  assert.equal(run('pinShares()'), undefined);
  run("document.getElementById('stopLong').value = ''; setSizingMode('allocation')");
  assert.equal(pin.style.display, 'none');
});

test('a card trades its own ticker while another one is loaded, and each card sends once per review', async () => {
  const net = network();
  const h = await loaded('AAA', { fetch: net.fetch, storage: connected() });
  const { run, elements, state } = h;
  const a = run('pinShares()');
  load(h, 'BBB');
  const b = run('pinShares()');
  run("document.getElementById('stopLong').value = '49.50'; renderShares()"); // the calculator moves on; the cards keep theirs

  await run(`openCardTrade('${a}')`);
  assert.notEqual(elements.get('tradeSheet').style.display, 'none');
  assert.equal(state.tradeTicket.symbol, 'AAA');
  assert.equal(state.tradeTicket.qty, 250);
  assert.equal(state.tradeTicket.stop, 98);
  assert.equal(state.tradeTicket.cardId, a);
  assert.equal(state.quoteData.symbol, 'BBB', 'the loaded ticker stays put');
  await run('placeTrade()');
  assert.match(elements.get(a).innerHTML, /Sent \d+:\d\d\D*?: buy 250, order 1001\. <button type="button" class="pos-link" data-action="openCardOrder"/);
  assert.match(elements.get(a).innerHTML, /Trade at Schwab again/);

  await run(`openCardTrade('${b}')`);
  assert.equal(state.tradeTicket.symbol, 'BBB');
  assert.equal(state.tradeTicket.qty, 500, '$500 over $1 to the LOD it was pinned with');
  await run('placeTrade()');
  const posts = net.posts();
  assert.deepEqual(posts.map(o => [o.orderLegCollection[0].instrument.symbol, o.orderLegCollection[0].quantity, o.childOrderStrategies[0].stopPrice]), [['AAA', 250, 98], ['BBB', 500, 49]]);
  assert.match(elements.get(b).innerHTML, /order 1002/);
  assert.doesNotMatch(elements.get(a).innerHTML, /order 1002/, 'each card keeps its own order');

  run(`openCardOrder('${a}')`);
  assert.equal(state.tradeTicket.orderId, '1001', 'Status reopens that card\'s review');
  assert.doesNotMatch(elements.get('tradeBody').innerHTML, /id="tradePlace"/, 'sent: nothing to place again from it');
});

test('a stop or entry typed on the card resizes it, and the plan says the stop is custom', async () => {
  const net = network();
  const { run, elements, state } = await loaded('AAA', { fetch: net.fetch, storage: connected() });
  const a = run('pinShares()');
  assert.equal(state.pinnedData[a].planCtx.stop_source, 'auto');
  run(`shareOrderStopChanged('${a}', { value: '99' })`);
  assert.match(elements.get(a).innerHTML, /Shares to buy<\/div><div class="s-val">500</);
  assert.match(elements.get(a).innerHTML, /<div class="s-sub">Custom stop<\/div>/);
  assert.equal(state.pinnedData[a].planCtx.stop_source, 'custom');
  run(`shareOrderEntryChanged('${a}', { value: '101' })`);
  assert.match(elements.get(a).innerHTML, /Shares to buy<\/div><div class="s-val">250</, 'from a planned 101 to the 99 stop');
  await run(`openCardTrade('${a}')`);
  assert.equal(state.tradeTicket.entryType, 'STOP_LIMIT', 'a planned entry over the ask opens as a breakout');
  assert.equal(state.tradeTicket.planCtx.stop_planned, 99);
  assert.equal(state.tradeTicket.planCtx.max_loss, 500);
  run(`shareOrderStopChanged('${a}', { value: '102' })`);
  assert.match(elements.get(a).innerHTML, /Stop \(\$102\.00\) must be below entry \(\$101\.00\) for a long\./);
  assert.match(elements.get(a).innerHTML, /data-action="openCardTrade" data-arg="[^"]+" disabled/);
});

test('without a Schwab login the card has no trade button, and removing it drops it', async () => {
  const { run, elements, state } = await loaded('AAA');
  const a = run('pinShares()');
  assert.doesNotMatch(elements.get(a).innerHTML, /openCardTrade/);
  run(`removePinned('${a}')`);
  assert.equal(state.pinnedData[a], undefined);
});

test('a redraw waits while you type in a card, and committing the box redraws it', async () => {
  const { run, elements, state } = await loaded('AAA');
  const a = run('pinShares()');
  const card = elements.get(a);
  const box = { id: '' };
  card.contains = el => el === box;
  run('document').activeElement = box;
  const before = card.innerHTML;
  run("document.getElementById('riskDollar').value = '1000'; renderPinnedCards()");
  assert.equal(card.innerHTML, before, 'the live refresh leaves the box you are in alone');
  run(`shareOrderStopChanged('${a}', { value: '99' })`);
  assert.match(card.innerHTML, /Shares to buy<\/div><div class="s-val">1000</, 'Enter or leaving the box redraws it');
  assert.equal(state.pinnedData[a].stopLevel, 99);
});

test('a card removed during its review still re-checks and sends; a lost answer says so on the card', async () => {
  const net = network();
  const lost = async (url, init = {}) => init.method === 'POST' ? (() => { net.calls.push({ url, method: 'POST', body: init.body }); throw new TypeError('Failed to fetch'); })() : net.fetch(url, init);
  const h = await loaded('AAA', { fetch: net.fetch, storage: connected() });
  const a = h.run('pinShares()');
  await h.run(`openCardTrade('${a}')`);
  h.run(`removePinned('${a}')`);
  await h.run('placeTrade()');
  assert.equal(net.posts().length, 1, 'the review went, from a quote read for its ticker');
  assert.equal(net.posts()[0].orderLegCollection[0].instrument.symbol, 'AAA');

  const h2 = await loaded('AAA', { fetch: lost, storage: connected() });
  const b = h2.run('pinShares()');
  await h2.run(`openCardTrade('${b}')`);
  await h2.run('placeTrade()');
  assert.match(h2.elements.get(b).innerHTML, /<p class="share-order-sent lost" role="status">No answer from Schwab [^:]+:\d\d[^:]*: buy 250\. Check your Schwab orders before trading it again\./);
});
