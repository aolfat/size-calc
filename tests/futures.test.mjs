// Run with: node --test
// Futures in the Stocks & futures ticket: a /MES ticker loads Schwab's quote, 5-minute and daily bars through the worker's
// market data relay, and the shares card counts contracts on whole ticks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import worker from '../worker/schwab/worker.js';

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

// Schwab's answer for /MES, the shape /marketdata/v1/quotes sends a futures root in
const mes = (quote = {}, extra = {}) => ({
  '/MES': {
    assetMainType: 'FUTURE', symbol: '/MES', realtime: true,
    quote: { lastPrice: 6012.25, bidPrice: 6012, askPrice: 6012.25, highPrice: 6020.5, lowPrice: 5995, closePrice: 5997.75, totalVolume: 81234, tick: 0.25, tickAmount: 1.25, tradeTime: Date.UTC(2026, 9, 27, 14, 31, 5), ...quote },
    reference: { product: '/MES', futureActiveSymbol: '/MESZ26', description: 'Micro E-mini S&P 500 Index Futures,Dec-2026,ETH' },
    ...extra,
  },
});
// New York on daylight time (UTC−4) through Nov 1, 2026
const ny = (d, h, m) => Date.UTC(2026, 9, d, h + 4, m);
const candle = (ms, o, h, l, c) => ({ datetime: ms, open: o, high: h, low: l, close: c, volume: 100 });
const BARS = { symbol: '/MES', empty: false, candles: [candle(ny(26, 15, 55), 6000, 6002, 5999, 6001), candle(ny(26, 18, 0), 6001, 6003, 5998, 6002), candle(ny(27, 9, 30), 6002, 6014, 5995, 6012)] };
const DAILY = { symbol: '/MES', empty: false, candles: [candle(ny(23, 0, 0), 5980, 6000, 5960, 5990), candle(ny(26, 0, 0), 5990, 6005, 5985, 5997.75)] };

async function ticket({ answer = () => json(mes()), storage = connected(), bars = () => json(BARS), daily = () => json(DAILY) } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.Authorization });
    const u = new URL(url);
    if (url.startsWith(PROXY + '/marketdata/v1/quotes')) return answer(u.searchParams.get('symbols'));
    if (url.startsWith(PROXY + '/marketdata/v1/pricehistory')) return u.searchParams.get('frequencyType') === 'daily' ? daily() : bars();
    if (url.startsWith(PROXY)) return json({}, 404);
    throw new Error('Unexpected request ' + url);
  };
  const h = await app({ fetch, storage });
  h.run("document.getElementById('riskDollar').value = '500'; document.getElementById('accountSize').value = '50000';");
  const load = async symbol => { h.elements.get('ticker').value = symbol; await h.run('fetchQuote()'); await settle(); };
  return { ...h, calls, load };
}

test('a futures ticker: a root or one month of a contract the app knows, never a stock', async () => {
  const { run } = await app();
  const sym = s => run(`futuresSymbol(${JSON.stringify(s)})`);
  assert.deepEqual({ ...sym('/mes') }, { symbol: '/MES', root: 'MES', month: false });
  assert.deepEqual({ ...sym('/MESZ26') }, { symbol: '/MESZ26', root: 'MES', month: true });
  assert.equal(sym('/M2K').root, 'M2K');
  assert.equal(sym('/MGC').root, 'MGC');
  assert.equal(sym('/ESH7').root, 'ES');
  assert.equal(sym('/ZB'), null, 'a root without its tick here');
  assert.equal(sym('MES'), null, 'no slash: a stock ticker');
  assert.equal(run('isTicker("/MNQ")'), true);
  assert.equal(run('isTicker("/ZB")'), false);
  assert.equal(run('fmtTicks(6012, 0.25)'), '6,012.00');
  assert.equal(run('fmtTicks(44210, 1)'), '44,210');
  assert.equal(run('fmtTicks(71.2, 0.01)'), '71.20');
  assert.equal(run("priceLabeler({ type: 'future', tickSize: 0.25 })(6046.77)"), '6,046.77');
  assert.equal(run("priceLabeler({ symbol: 'AAPL' })(231.5)"), '$231.50', 'a stock keeps its dollars');
});

test('the quote: the active contract, its prices, the change from the close, and the feed', async () => {
  const { run } = await app();
  const q = run(`parseFuturesQuote(${JSON.stringify(mes())}, '/MES')`);
  assert.equal(q.symbol, '/MES');
  assert.equal(q.type, 'future');
  assert.equal(q.contract, '/MESZ26');
  assert.deepEqual([q.last, q.bid, q.ask, q.low, q.high, q.prevclose, q.volume], [6012.25, 6012, 6012.25, 5995, 6020.5, 5997.75, 81234]);
  assert.equal(q.change, 14.5);
  assert.equal(q.change_percentage.toFixed(2), '0.24');
  assert.deepEqual([q.tickSize, q.tickValue, q.realtime, q.specMismatch], [0.25, 1.25, true, null]);
  const month = { '/MESH27': { ...mes()['/MES'], symbol: '/MESH27', reference: { product: '/MES', futureActiveSymbol: '/MESZ26' } } };
  assert.equal(run(`parseFuturesQuote(${JSON.stringify(month)}, '/MESH27')`).contract, '/MESH27', 'a month asked for is that month, not the front one');
});

test('the quote: another root, no price, a crossed market, a delayed feed and a tick Schwab disagrees with', async () => {
  const { run } = await app();
  const parse = (body, symbol = '/MES') => run(`parseFuturesQuote(${JSON.stringify(body)}, '${symbol}')`);
  assert.equal(parse(mes(), '/ES'), null, "the /MES answer is never /ES's");
  assert.equal(parse({ '/MES': { ...mes()['/MES'], reference: { futureActiveSymbol: '/ESZ26' } } }), null, 'a contract of another root');
  assert.equal(parse({ errors: { invalidSymbols: ['/MES'] } }), null);
  assert.equal(parse(mes({ lastPrice: 0, mark: 0, bidPrice: 0, askPrice: 0 })), null, 'zero is no price');
  const crossed = parse(mes({ bidPrice: 6013, askPrice: 6012 }));
  assert.deepEqual([crossed.bid, crossed.ask, crossed.last], [null, null, 6012.25], 'a crossed market is no market; the last stays');
  assert.equal(parse(mes({}, { realtime: false })).realtime, false);
  assert.deepEqual({ ...parse(mes({ tickAmount: 12.5 })).specMismatch }, { tick: 0.25, tickAmount: 12.5 });
  assert.equal(parse({ '/MES': { ...mes()['/MES'], reference: { futureActiveSymbol: '' } } }).contract, '/MES', 'no active contract named: the root');
  assert.equal(run('onTick(6012.3, 0.25)'), 6012.25);
  assert.equal(run('onTick(0.1 + 0.2, 0.1)'), 0.3, 'no float dust');
});

test("bars carry their trading day: CME's opens at 18:00 New York the evening before", async () => {
  const { run } = await app();
  const bars = run(`futuresBars(${JSON.stringify(BARS)})`);
  assert.deepEqual([...bars.map(b => b.t)], ['2026-10-26T15:55:00', '2026-10-27T18:00:00', '2026-10-27T09:30:00']);
  assert.equal(bars[1].ts, ny(26, 18, 0) / 1000);
  assert.deepEqual({ ...run(`futuresSessionClock(${ny(25, 18, 30)})`) }, { day: '2026-10-26', time: '18:30' }, "Sunday evening is Monday's session");
  assert.deepEqual([...run(`futuresDays(${JSON.stringify(DAILY)})`).map(d => d.date)], ['2026-10-23', '2026-10-26']);
  const evening = { candles: [candle(ny(25, 18, 0), 1, 2, 1, 2)] };
  assert.equal(run(`futuresDays(${JSON.stringify(evening)})`)[0].date, '2026-10-26', 'a daily bar stamped at the open is its own day');
  assert.equal(run('futuresBars({ candles: [{ open: 1, high: 0.5, low: 1, close: 1, datetime: 1 }, { open: 1 }] }).length'), 0, 'broken candles go');
});

test('the plan: the entry on the nearest tick, the stop on the tick past it, away from the entry', async () => {
  const { run } = await app();
  const plan = o => run(`futuresPlan(${JSON.stringify({ risk: 500, direction: 'long', root: 'MES', ...o })})`);
  const p = plan({ entry: 6012.3, stop: 5994.9 });
  assert.deepEqual([p.entry, p.stop, p.ticks, p.riskPerContract, p.contracts, p.totalRisk, p.pointValue], [6012.25, 5994.75, 70, 87.5, 5, 437.5, 5]);
  const s = plan({ direction: 'short', entry: 6012, stop: 6020.4 });
  assert.deepEqual([s.stop, s.ticks, s.contracts], [6020.5, 34, 11], 'a short stop rounds up');
  assert.equal(plan({ entry: 6012.25, stop: 5995, fees: 1.24 }).riskPerContract, 87.49);
  assert.equal(plan({ entry: 6000, stop: 6005 }).error, 'Stop must be below entry for a long.');
  assert.equal(plan({ entry: 6000, stop: NaN }).error, 'No valid stop price. Check the LOD / HOD, or enter a stop.');
  assert.equal(plan({ root: 'ZB', entry: 1, stop: 0 }).error, 'Not a futures contract this app knows.');
});

test('/MES in the ticker box loads from Schwab: quote bar, contracts at the LOD, and both charts', async () => {
  const { run, elements, state, calls, load } = await ticket();
  await load('/mes');
  const quote = calls.find(c => c.url.includes('/marketdata/v1/quotes'));
  assert.equal(quote.url, `${PROXY}/marketdata/v1/quotes?symbols=%2FMES&fields=quote%2Creference`);
  assert.equal(quote.auth, 'Bearer acc-1');
  assert.ok(!calls.some(c => c.url.includes('tradier')), 'nothing goes to Tradier');
  assert.equal(elements.get('qTicker').textContent, '/MESZ26  ');
  assert.equal(elements.get('qPrice').textContent, '6,012.25');
  assert.equal(elements.get('qChg').textContent, ' +14.50 (+0.24%)');
  assert.equal(elements.get('qLod').textContent, '5,995.00');
  assert.equal(elements.get('qHod').textContent, '6,020.50');
  assert.match(elements.get('qExt').innerHTML, /Real-time/);
  // entry at the last, stop at the LOD: 69 ticks × $1.25 = $86.25 a contract; $500 buys 5
  const card = elements.get('sharesStats').innerHTML;
  assert.match(card, /Contracts to buy/);
  assert.match(card, /value="5"/);
  assert.match(card, /\/MESZ26 · entry <strong>6,012\.25<\/strong>/);
  assert.match(card, /5,995\.00[\s\S]*Low of day \(LOD\)/);
  assert.match(card, /\$431\.25/);
  assert.match(card, /69 ticks × \$1\.25/);
  assert.match(card, /\$150,306\.25/, 'notional: 5 × 6,012.25 × $5');
  assert.equal(elements.get('sharesTrade').style.display, 'none', "no futures orders through Schwab's API");
  assert.equal(elements.get('sharesImage').style.display, 'none');
  assert.equal(elements.get('orbRow').style.display, 'none');
  assert.equal(elements.get('sizingAllocation').disabled, true);

  const history = calls.filter(c => c.url.includes('/pricehistory')).map(c => new URL(c.url).searchParams);
  const five = history.find(p => p.get('frequencyType') === 'minute');
  assert.deepEqual([five.get('symbol'), five.get('frequency'), five.get('needExtendedHoursData')], ['/MES', '5', 'true']);
  assert.ok(history.some(p => p.get('frequencyType') === 'daily' && p.get('periodType') === 'year'));
  // today's session from 18:00; it has 2 bars, so yesterday's stays on (until today's has 2 hours of them)
  assert.deepEqual(state.chartBars.map(b => b.t), ['2026-10-26T15:55:00', '2026-10-27T18:00:00', '2026-10-27T09:30:00']);
  assert.deepEqual(state.dailyBars.map(d => d.date), ['2026-10-23', '2026-10-26']);
  assert.equal(elements.get('chartWrap').style.display, 'block');
  assert.equal(run("JSON.parse(localStorage.getItem('recent_tickers'))[0]"), '/MES');
  assert.equal(run("localStorage.getItem('last_ticker')"), '/MES');
});

test('contracts: a stop off the tick, a typed count, fees and a short', async () => {
  const { run, elements, storage, load } = await ticket();
  await load('/MES');
  elements.get('stopLong').value = '5994.9'; // a chart click lands between ticks
  run('stopsChanged()');
  let card = elements.get('sharesStats').innerHTML;
  assert.match(card, /<div class="s-val">5,994\.75<\/div>/, 'the stop goes to the tick below');
  assert.match(card, /70 ticks/);
  run("sharesQtyChanged({ value: '3' })");
  assert.equal(+elements.get('riskDollar').value, 262.5, '3 × $87.50');
  assert.match(elements.get('sharesStats').innerHTML, /value="3"/);

  run("document.getElementById('riskDollar').value = '500'; syncFromDollar();");
  run("actions.futuresFeesChanged({ value: '1.24', dataset: { arg: 'MES' } })");
  assert.equal(storage.get('futures_fees'), '{"MES":1.24}');
  card = elements.get('sharesStats').innerHTML;
  assert.match(card, /\$88\.74/, '70 ticks × $1.25 + $1.24');
  assert.match(card, /\+ \$1\.24 fees/);

  elements.get('stopLong').value = '';
  run("setDirection('short')");
  card = elements.get('sharesStats').innerHTML;
  assert.match(card, /Contracts to short/);
  assert.match(card, /6,020\.50[\s\S]*High of day \(HOD\)/);
  // 33 ticks × $1.25 + $1.24 = $42.49 a contract: 11 for $500
  assert.match(card, /value="11"/);
  run("copiedText = ''; copyPlainText = text => { copiedText = text; }; copyShares();");
  assert.equal(run('copiedText'), 'Short 11 /MESZ26 contracts @ 6,012.25 · stop 6,020.50 · 33 ticks × $1.25/tick · risk @ stop $467.39 incl. $1.24/ct round-trip fees · excludes slippage');
});

test('a ticker that is not a futures contract here, or no Schwab login, says why and reads nothing', async () => {
  const signedOut = await ticket({ storage: new Map() });
  await signedOut.load('/MES');
  assert.equal(signedOut.calls.length, 0);
  assert.equal(signedOut.elements.get('errorBox').textContent, 'Futures prices come from Schwab. Log in to Schwab in Settings.');
  const h = await ticket();
  await h.load('/ZB');
  assert.equal(h.calls.length, 0);
  assert.match(h.elements.get('errorBox').textContent, /^Futures here: \/MES, \/ES, \/MNQ, .* or one month like \/MESZ26\.$/);
  await h.run("setMode('options')");
  await h.load('/MES');
  assert.equal(h.elements.get('errorBox').textContent, 'No option chains for futures here. Size them in Stocks & futures.');
});

test('a worker without the relay, or a Schwab app without market data, says what to fix', async () => {
  for (const [status, words] of [[404, /Redeploy it/], [403, /Market Data Production/]]) {
    const { elements, load, state } = await ticket({ answer: () => json({ message: 'nope' }, status) });
    await load('/MES');
    assert.match(elements.get('errorBox').textContent, words);
    assert.equal(state.quoteData, null);
  }
});

test('a delayed feed or a different tick from Schwab is said on the ticket', async () => {
  const { elements, load } = await ticket({ answer: () => json(mes({ tickAmount: 12.5 }, { realtime: false })) });
  await load('/MES');
  assert.match(elements.get('qExt').innerHTML, /Delayed/);
  const card = elements.get('sharesStats').innerHTML;
  assert.match(card, /Schwab sent a delayed quote/);
  assert.match(card, /Schwab's tick for \/MES is 0\.25 × \$12\.50, not 0\.25 × \$1\.25/);
});

test('a futures ticker has no option chain, and allocation sizing switches back to risk', async () => {
  const { run, elements, load } = await ticket();
  run("setSizingMode('allocation')");
  assert.equal(run('sizingMode'), 'allocation');
  await load('/MES');
  assert.equal(run('sizingMode'), 'risk');
  run("setSizingMode('allocation')");
  assert.equal(run('sizingMode'), 'risk', 'futures size by risk');
  await run("setMode('options')");
  assert.equal(elements.get('errorBox').textContent, 'No option chains for futures here. Load a stock for options.');
});

test('Live with a futures ticker polls Schwab for the quote, and the chart every fourth tick', async () => {
  let n = 0;
  const { run, elements, calls, load } = await ticket({ answer: () => json(mes({ lastPrice: 6012.25 + 0.25 * n++ })) });
  await load('/MES');
  const reads = () => calls.filter(c => c.url.includes('/quotes')).length;
  const charts = () => calls.filter(c => c.url.includes('frequencyType=minute')).length;
  const [q0, c0] = [reads(), charts()];
  run('toggleLive()');
  await settle();
  assert.equal(reads(), q0 + 1);
  assert.equal(charts(), c0 + 1, 'the first tick redraws the chart');
  assert.equal(elements.get('qPrice').textContent, '6,012.50');
  await run('livePoll()');
  await settle();
  assert.equal(reads(), q0 + 2);
  assert.equal(charts(), c0 + 1);
  assert.ok(!calls.some(c => c.url.includes('tradier')));
});

test('the worker relays market data reads and nothing else there', async () => {
  const env = { SCHWAB_APP_KEY: 'k', SCHWAB_APP_SECRET: 's', SCHWAB_CALLBACK_URL: 'https://app.example/', ALLOWED_ORIGINS: 'https://app.example' };
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url, method: init.method, auth: init.headers.Authorization }); return json(mes()); };
  try {
    const call = (path, method = 'GET') => worker.fetch(new Request('https://w.example' + path, { method, headers: { Origin: 'https://app.example', Authorization: 'Bearer t1' }, ...(method === 'POST' ? { body: '{}' } : {}) }), env);
    const ok = await call('/marketdata/v1/pricehistory?symbol=%2FMES&frequency=5');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://app.example');
    assert.deepEqual(seen, [{ url: 'https://api.schwabapi.com/marketdata/v1/pricehistory?symbol=%2FMES&frequency=5', method: 'GET', auth: 'Bearer t1' }]);
    assert.equal((await call('/marketdata/v1/quotes', 'POST')).status, 404, 'market data is read only');
    assert.equal((await call('/marketdata/v2/quotes')).status, 404);
    assert.equal(seen.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
