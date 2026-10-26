// Run with: node --test
// Opening-range breakouts: today's range from 5-minute bars, the 5m / 15m / 30m chips on the shares ticket, and the stop
// (or stop limit) entry Trade at Schwab sends from them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const json = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const connected = () => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }])],
  ['schwab_account', 'HASH1'],
]);

// Friday 2026-10-23, New York on daylight time (UTC−4)
const at = (h, m) => Date.UTC(2026, 9, 23, h + 4, m);
const bar = (day, hhmm, h, l) => ({ t: `${day}T${hhmm}:00`, o: l, h, l, c: h, v: 1000 });
// today's first half hour on TEST: 9:30 makes the high, 9:40 the low, 9:55 runs past both
const TODAY = [
  bar('2026-10-22', '15:55', 99, 98),
  bar('2026-10-23', '09:30', 100.5, 99.6), bar('2026-10-23', '09:35', 100.2, 99.8), bar('2026-10-23', '09:40', 100.1, 99.4),
  bar('2026-10-23', '09:45', 100.8, 99.9), bar('2026-10-23', '09:50', 100.6, 100), bar('2026-10-23', '09:55', 101.2, 99.2),
];

test('the opening range: the high and low from 9:30 until it closes, and not before', async () => {
  const { run } = await app();
  const range = (bars, minutes, now) => run(`openingRange(${JSON.stringify(bars)}, ${minutes}, ${now})`);
  assert.deepEqual({ ...range(TODAY, 5, at(9, 36)) }, { error: '', high: 100.5, low: 99.6, end: '09:35', bars: 1 });
  assert.deepEqual({ ...range(TODAY, 15, at(9, 46)) }, { error: '', high: 100.5, low: 99.4, end: '09:45', bars: 3 });
  assert.equal(range(TODAY, 30, at(10, 0)).high, 101.2);
  assert.equal(range(TODAY, 30, at(10, 0)).low, 99.2);
  assert.equal(range(TODAY, 15, at(9, 44)).error, 'The 15m range closes at 9:45 ET.');
  assert.equal(range(TODAY.slice(0, 3), 15, at(9, 45)).error, 'Tradier hasn\'t sent the 9:40 bar yet. Try again in a moment.');
  assert.equal(range(TODAY.slice(0, 3), 15, at(9, 50)).error, '', 'five minutes on, a thin stock may just not have traded then');
  assert.equal(range(TODAY.slice(1, 2), 15, at(9, 50)).low, 99.6, 'only the 9:30 bar traded');
  assert.equal(range(TODAY.slice(0, 1), 5, at(9, 36)).error, 'No 5-minute bars from today\'s open yet.', 'only yesterday\'s');
  assert.equal(range([bar('2026-10-23', '10:05', 1, 1)], 15, at(10, 6)).error, 'No trades in the first 15 minutes today.');
  assert.match(range(TODAY, 5, Date.UTC(2026, 9, 24, 15, 0)).error, /No 5-minute bars/, 'a Saturday');
});

test('the breakout levels: a tick past the range, the stop at its other side', async () => {
  const { run } = await app();
  assert.deepEqual({ ...run('orbLevels({ high: 100.5, low: 99.4 }, true)') }, { entry: 100.51, stop: 99.4 });
  assert.deepEqual({ ...run('orbLevels({ high: 100.5, low: 99.4 }, false)') }, { entry: 99.39, stop: 100.5 });
  assert.deepEqual({ ...run('orbLevels({ high: 0.5123, low: 0.48 }, true)') }, { entry: 0.5124, stop: 0.48 });
});

test('stop entries: the payload, and the checks on where the stop and limit sit', async () => {
  const { run } = await app();
  const order = run("sharesStopOrder({ symbol: 'TEST', qty: 100, isLong: true, stop: 99.4, stopDuration: 'DAY', entryType: 'STOP_LIMIT', entryStop: 100.51, entryLimit: 100.71 })");
  assert.deepEqual(JSON.parse(JSON.stringify(order)), {
    orderType: 'STOP_LIMIT', session: 'NORMAL', duration: 'DAY', price: 100.71, stopPrice: 100.51, orderStrategyType: 'TRIGGER',
    orderLegCollection: [{ instruction: 'BUY', quantity: 100, instrument: { symbol: 'TEST', assetType: 'EQUITY' } }],
    childOrderStrategies: [{
      orderType: 'STOP', session: 'NORMAL', duration: 'DAY', orderStrategyType: 'SINGLE', stopPrice: 99.4,
      orderLegCollection: [{ instruction: 'SELL', quantity: 100, instrument: { symbol: 'TEST', assetType: 'EQUITY' } }],
    }],
  });
  const stop = run("sharesStopOrder({ symbol: 'TEST', qty: 10, isLong: false, stop: 100.5, stopDuration: 'DAY', entryType: 'STOP', entryStop: 99.39 })");
  assert.equal(stop.orderType, 'STOP');
  assert.equal(stop.stopPrice, 99.39);
  assert.equal('price' in stop, false);
  assert.equal(stop.orderLegCollection[0].instruction, 'SELL_SHORT');

  assert.equal(run("stopEntryError({ isLong: true, entryStop: 100.51, bid: 100.1, ask: 100.12 })"), '');
  assert.match(run("stopEntryError({ isLong: true, entryStop: 100.51, bid: 100.5, ask: 100.52 })"), /The buy stop \$100\.51 is at or under the ask \$100\.52, so it would buy right away/);
  assert.match(run("stopEntryError({ isLong: false, entryStop: 99.39, bid: 99.3, ask: 99.32 })"), /The sell-short stop \$99\.39 is at or over the bid \$99\.30/);
  assert.match(run("entryLimitError({ isLong: true, entryStop: 100.51, entryLimit: 100.5 })"), /under the stop \$100\.51, so it could never fill/);
  assert.equal(run("entryLimitError({ isLong: true, entryStop: 100.51, entryLimit: 100.51 })"), '', 'at the stop is fine');
  assert.equal(run('defaultEntryLimit(100.51, true)'), 100.71, '0.2% past the stop');
  assert.equal(run('defaultEntryLimit(2.5, false)'), 2.49, 'at least a tick');
  // the protective stop only goes in once the entry fills, so it's checked against the entry, not today's bid
  const ticket = side => run(`sharesTicketError({ symbol: 'TEST', type: 'stock', qty: 100, isLong: true, stop: ${side}, bid: 99.3, ask: 99.32, entryType: 'STOP', entryStop: 100.51 })`);
  assert.equal(ticket(99.4), '', 'a stop over the bid, under the entry');
  assert.match(ticket(100.6), /The stop \$100\.60 is not under the entry \$100\.51/);
});

// the shares card on TEST at $100.02 ask, with Tradier answering quotes and the 5-minute bars
async function card({ now = at(9, 46), bars = TODAY, quote = {}, later = null } = {}) {
  const posts = [];
  let quotes = 0; // later: the quote from the second read on (the one right before sending)
  const QUOTE = { symbol: 'TEST', type: 'stock', last: 100.1, bid: 100.08, ask: 100.12, low: 99.2, high: 100.5, ...quote };
  const fetch = async (url, init = {}) => {
    if (url.startsWith(PROXY)) {
      if (init.method === 'POST') { posts.push(JSON.parse(init.body)); return json(null, 201, { Location: `${PROXY}/trader/v1/accounts/HASH1/orders/1001` }); }
      return json({}, 404);
    }
    if (url.includes('/markets/quotes')) return json({ quotes: { quote: quotes++ && later ? { ...QUOTE, ...later } : QUOTE } });
    if (url.includes('/markets/timesales')) return json({ series: { data: bars.map(b => ({ time: b.t, timestamp: 0, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })) } });
    return json({});
  };
  const h = await app({ fetch, storage: connected(), clock: true, now });
  h.run(`quoteData = ${JSON.stringify(QUOTE)};
    document.getElementById('ticker').value = 'TEST';
    document.getElementById('apiKey').value = 'tradier-test';
    document.getElementById('riskDollar').value = '500';
    renderShares();`);
  return { ...h, posts };
}

test('a chip sets the entry a tick over the range and the stop at its low, and the card says where they came from', async () => {
  const { run, elements, state } = await card();
  assert.equal(elements.get('orbRow').style.display, '');
  assert.match(elements.get('orbChips').innerHTML, /data-action="setOrb" data-arg="15"[^>]*>15m</);
  await run('actions.setOrb({ dataset: { arg: "15" } })');
  await settle();
  assert.equal(elements.get('entryPrice').value, '100.51');
  assert.equal(elements.get('stopLong').value, '99.40');
  assert.equal(run('sharesPlan().shares'), 450, '$500 over $1.11 a share');
  assert.match(elements.get('orbChips').innerHTML, /class="filter-btn active" aria-pressed="true" data-action="setOrb" data-arg="15"/);
  assert.equal(elements.get('orbHint').textContent, '15m range $99.40 to $100.50, 9:30 to 9:45 ET. Entry a tick over the high, stop at the low.');
  const stats = elements.get('sharesStats').innerHTML;
  assert.match(stats, /Entry <strong>\$100\.51<\/strong> · 15m range high/);
  assert.match(stats, /15m range low/);

  elements.get('stopLong').value = '99.5';
  run('stopsChanged()');
  assert.doesNotMatch(elements.get('orbChips').innerHTML, /active/, 'a stop moved by hand is yours');
  assert.match(elements.get('sharesStats').innerHTML, /Custom stop/);
  assert.equal(state.orb.minutes, 15);
});

test('a short takes the low, and a range still forming says when it closes', async () => {
  const { run, elements } = await card({ now: at(9, 44) });
  run("setDirection('short')");
  await run('setOrb(15)');
  assert.equal(elements.get('entryPrice').value, '');
  assert.equal(elements.get('orbHint').textContent, 'The 15m range closes at 9:45 ET.');
  assert.ok(elements.get('orbHint').className.includes('warn'));
  await run('setOrb(5)');
  assert.equal(elements.get('entryPrice').value, '99.59');
  assert.equal(elements.get('stopShort').value, '100.50');
});

test('the chips are for shares on risk sizing only', async () => {
  const { run, elements } = await card();
  run("setSizingMode('allocation')");
  assert.equal(elements.get('orbRow').style.display, 'none');
});

test('Trade at Schwab sends the breakout as a stop limit by default, and Stop when you pick it', async () => {
  const { run, elements, state, storage, posts } = await card();
  await run('setOrb(15)');
  await run('openTrade()');
  let t = state.tradeTicket;
  assert.equal(t.entryType, 'STOP_LIMIT', 'the entry is over the ask: a breakout');
  assert.equal(t.entryStop, 100.51);
  assert.equal(t.entryLimit, 100.71);
  assert.ok(Math.abs(t.plannedRisk - 499.5) < 1e-9);
  let body = elements.get('tradeBody').innerHTML;
  assert.match(body, /Buy 450 TEST on a stop at \$100\.51, limit \$100\.71/);
  assert.match(body, /From the stop entry \$100\.51 \(15m range high\)\. Up to \$589\.50 filled at the limit/);
  assert.match(body, /Buy stop limit 450 TEST/);
  assert.equal(t.warnings.length, 0, 'what the limit risks is in the risk row, not a warning');

  run("actions.setTradeEntryType({ dataset: { arg: 'STOP' } })");
  t = state.tradeTicket;
  assert.equal(storage.get('schwab_entry_type'), 'STOP', 'remembered for the next one');
  assert.equal(t.order.orderType, 'STOP');
  assert.equal(t.order.stopPrice, 100.51);
  body = elements.get('tradeBody').innerHTML;
  assert.match(body, /Once TEST trades at \$100\.51, buys at market\. Today only\./);
  assert.doesNotMatch(body, /id="tradeEntryLimit"/);

  await run('placeTrade()');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].orderType, 'STOP');
  assert.equal(posts[0].orderStrategyType, 'TRIGGER');
  assert.equal(posts[0].childOrderStrategies[0].stopPrice, 99.4);
});

test('a stop limit\'s limit is typed in place, and one under the stop holds the order back', async () => {
  const { run, elements, state } = await card();
  await run('setOrb(15)');
  await run('openTrade()');
  elements.set('tradeEntryLimit', { value: '100.4' });
  elements.set('tradePlace', { disabled: false });
  run("actions.setTradeEntryLimit({ value: '100.4' })");
  assert.equal(state.tradeTicket.order, null);
  assert.match(elements.get('tradeDetail').innerHTML, /The limit \$100\.40 is under the stop \$100\.51, so it could never fill/);
  assert.equal(elements.get('tradePlace').disabled, true);
  run("setTradeEntryLimit('100.6')");
  assert.equal(state.tradeTicket.order.price, 100.6);
  assert.equal(elements.get('tradePlace').disabled, false);
});

test('no stop entry when the price is already through it: Market only, and a break before sending stops the send', async () => {
  const { run, elements, state, posts } = await card({ quote: { last: 100.6, bid: 100.58, ask: 100.62 } });
  await run('setOrb(15)');
  await run('openTrade()');
  assert.equal(state.tradeTicket.entryType, 'MARKET');
  assert.match(elements.get('tradeBody').innerHTML, /data-arg="STOP" title="The buy stop \$100\.51 is at or under the ask \$100\.62, so it would buy right away\. Use Market, or a higher entry\." disabled/);
  run("setTradeEntryType('STOP')");
  assert.equal(state.tradeTicket.entryType, 'MARKET');

});

test('a break through the entry between review and Place sends nothing', async () => {
  const { run, state, posts } = await card({ later: { last: 100.6, bid: 100.58, ask: 100.62 } });
  await run('setOrb(15)');
  await run('openTrade()');
  assert.equal(state.tradeTicket.entryType, 'STOP_LIMIT');
  await run('placeTrade()');
  assert.equal(posts.length, 0);
  assert.match(state.tradeTicket.result.text, /The buy stop \$100\.51 is at or under the ask \$100\.62, so it would buy right away\. Use Market, or a higher entry\. Nothing was sent\./);
});
