// Run with: node --test
// Market data from a Schwab login alone: without a Tradier key, Tradier's URLs are answered from Schwab's /marketdata/v1
// through the worker (core/schwab-market.js translates, services/market-source.js routes), in Tradier's form.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
const connected = () => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }])],
  ['schwab_account', 'HASH1'],
]);

const AAPL = {
  assetMainType: 'EQUITY', assetSubType: 'COE', symbol: 'AAPL', realtime: true,
  quote: { lastPrice: 230.75, bidPrice: 230.7, askPrice: 230.8, openPrice: 228, highPrice: 231.5, lowPrice: 227.25, closePrice: 226.5,
    netChange: 4.25, netPercentChange: 1.876, totalVolume: 41000000, tradeTime: Date.now() - 60000, bidTime: Date.now() - 1000, askTime: Date.now() - 1000, '52WeekHigh': 260, '52WeekLow': 170 },
  regular: { regularMarketLastPrice: 230.5, regularMarketNetChange: 4, regularMarketPercentChange: 1.766, regularMarketTradeTime: Date.now() - 120000 },
  reference: { description: 'Apple Inc', exchange: 'Q' },
  fundamental: { avg10DaysVolume: 52000000 },
};
const CALL = 'AAPL  261218C00230000', PUT = 'AAPL  261218P00230000';
const contract = (symbol, putCall, delta) => ({ putCall, symbol, description: symbol, bid: 9.8, ask: 10.1, last: 9.95, totalVolume: 1200, openInterest: 15000,
  volatility: 28.5, delta, gamma: 0.02, theta: -0.08, vega: 0.35, rho: -999, strikePrice: 230, multiplier: 100, optionRoot: 'AAPL', tradeTimeInLong: 1, quoteTimeInLong: 2 });
const CHAIN = {
  symbol: 'AAPL', status: 'SUCCESS',
  callExpDateMap: { '2026-12-18:42': { '230.0': [contract(CALL, 'CALL', 0.52)], '235.0': [{ ...contract('AAPL  261218C00235000', 'CALL', -999), volatility: -999 }] } },
  putExpDateMap: { '2026-12-18:42': { '230.0': [contract(PUT, 'PUT', -0.48)] } },
};

test('symbols: an index gets its $, an option its padded root, and both come back as Tradier names them', async () => {
  const { run } = await app();
  assert.equal(run("toSchwabSymbol('spx')"), '$SPX');
  assert.equal(run("toSchwabSymbol('AAPL261218C00245000')"), 'AAPL  261218C00245000');
  assert.equal(run("toSchwabSymbol('BRK.B')"), 'BRK.B');
  assert.equal(run("fromSchwabSymbol('$VIX')"), 'VIX');
  assert.equal(run("fromSchwabSymbol('SPXW  261106C05800000')"), 'SPXW261106C05800000');
});

test('each Tradier read becomes the Schwab read that answers it; the stream has no stand-in', async () => {
  const { run } = await app();
  const req = (url, body = null) => run(`schwabRequest(${JSON.stringify(url)}, ${JSON.stringify(body)}, ${Date.UTC(2026, 10, 6, 21)})`);
  const base = 'https://api.tradier.com/v1';
  assert.equal(req(`${base}/markets/quotes?symbols=AAPL,SPX,AAPL261218C00230000&greeks=true`).path,
    '/quotes?symbols=AAPL%2C%24SPX%2CAAPL++261218C00230000&fields=quote%2Creference%2Cregular%2Cfundamental&indicative=false');
  assert.deepEqual([...req(`${base}/markets/quotes`, 'symbols=QQQ%2CIWM&greeks=false').symbols], ['QQQ', 'IWM'], "the Market tab's POST batches");
  assert.equal(req(`${base}/markets/options/expirations?symbol=SPX&includeAllRoots=true`).path, '/expirationchain?symbol=%24SPX');
  assert.equal(req(`${base}/markets/options/chains?symbol=AAPL&expiration=2026-12-18&greeks=true`).path,
    '/chains?symbol=AAPL&contractType=ALL&strategy=SINGLE&includeUnderlyingQuote=false&fromDate=2026-12-18&toDate=2026-12-18');
  const five = req(`${base}/markets/timesales?symbol=AAPL&interval=5min&start=2026-11-02 09:30&end=2026-11-06 16:00&session_filter=open`);
  assert.equal(five.path, `/pricehistory?symbol=AAPL&periodType=day&frequencyType=minute&frequency=5&startDate=${Date.UTC(2026, 10, 2, 14, 30)}&endDate=${Date.UTC(2026, 10, 6, 21)}&needExtendedHoursData=false`);
  assert.equal(five.regular, true);
  const daily = req(`${base}/markets/history?symbol=VIX&interval=daily&start=2025-10-22&end=2026-11-06`);
  assert.match(daily.path, /^\/pricehistory\?symbol=%24VIX&periodType=year&frequencyType=daily&frequency=1&startDate=\d+&endDate=\d+$/);
  assert.equal(req(`${base}/markets/events/session`), null);
  assert.equal(req(`${base}/markets/history?symbol=AAPL&interval=weekly&start=2026-01-01&end=2026-11-06`), null);
});

test("Schwab's quotes in Tradier's form: the regular session's last and change, ETFs, options with greeks, the unmatched", async () => {
  const { run } = await app();
  const body = q => run(`tradierBody(schwabRequest('https://api.tradier.com/v1/markets/quotes?symbols=${q}'), ${JSON.stringify({
    AAPL, SPY: { ...AAPL, symbol: 'SPY', assetSubType: 'ETF' },
    [CALL]: { assetMainType: 'OPTION', symbol: CALL, quote: { bidPrice: 9.8, askPrice: 10.1, lastPrice: 9.95, delta: 0.52, gamma: 0.02, theta: -0.08, vega: 0.35, volatility: 28.5, openInterest: 15000 },
      reference: { underlying: 'AAPL', multiplier: 100, description: 'AAPL 12/18/2026 230.00 C' } },
  })})`);
  const one = body('AAPL').quotes.quote;
  assert.equal(one.symbol, 'AAPL');
  assert.equal(one.type, 'stock');
  assert.equal(one.last, 230.5, "the regular session's, as Tradier's last is");
  assert.equal(one.change, 4);
  assert.equal(one.prevclose, 226.5);
  assert.equal(one.low, 227.25);
  assert.equal(one.average_volume, 52000000);
  const many = body('AAPL,SPY,AAPL261218C00230000,NOPE').quotes;
  assert.equal(many.quote.length, 3);
  assert.equal(many.quote[1].type, 'etf');
  const opt = many.quote[2];
  assert.equal(opt.symbol, 'AAPL261218C00230000');
  assert.equal(opt.type, 'option');
  assert.equal(opt.option_type, 'call');
  assert.equal(opt.strike, 230);
  assert.equal(opt.expiration_date, '2026-12-18');
  assert.equal(opt.root_symbol, 'AAPL');
  assert.equal(opt.contract_size, 100);
  assert.equal(opt.greeks.delta, 0.52);
  assert.equal(opt.greeks.mid_iv, 0.285, 'IV in percent becomes a fraction');
  assert.equal(many.unmatched_symbols.symbol, 'NOPE');
});

test("a chain flattens Schwab's call and put maps by strike; Schwab's -999 is no value", async () => {
  const { run } = await app();
  const out = run(`tradierBody(schwabRequest('https://api.tradier.com/v1/markets/options/chains?symbol=AAPL&expiration=2026-12-18'), ${JSON.stringify(CHAIN)}).options.option`);
  assert.deepEqual([...out.map(o => o.symbol)], ['AAPL261218C00230000', 'AAPL261218P00230000', 'AAPL261218C00235000']);
  assert.equal(out[1].greeks.delta, -0.48);
  assert.equal(out[0].greeks.rho, null);
  assert.equal(out[2].greeks.delta, null);
  assert.equal(out[2].greeks.mid_iv, null);
  assert.equal(out[0].underlying, 'AAPL');
  const exps = run(`tradierBody(schwabRequest('https://api.tradier.com/v1/markets/options/expirations?symbol=AAPL'), { expirationList: [{ expirationDate: '2026-12-18' }, { expirationDate: '2026-11-13' }, { expirationDate: '2026-11-13' }] })`);
  assert.deepEqual([...exps.expirations.date], ['2026-11-13', '2026-12-18']);
});

/** a Schwab-only app: every market read answered from the fixtures, Tradier never reached */
async function schwabOnly({ lenient = false } = {}) {
  const calls = [], tradier = [];
  let run;
  const fetch = async (url, init = {}) => {
    if (!url.startsWith(PROXY)) { tradier.push(url); throw new Error('Unexpected request ' + url); }
    const u = new URL(url), path = u.pathname;
    calls.push(url);
    assert.equal(init.headers?.Authorization, 'Bearer acc-1');
    if (path === '/marketdata/v1/quotes') return json({ AAPL });
    if (path === '/marketdata/v1/expirationchain') return json({ expirationList: [{ expirationDate: '2026-12-18' }] });
    if (path === '/marketdata/v1/chains') return json(CHAIN);
    if (path === '/marketdata/v1/pricehistory') {
      const start = +u.searchParams.get('startDate');
      if (u.searchParams.get('frequencyType') === 'daily') {
        return json({ candles: Array.from({ length: 30 }, (_, i) => ({ datetime: start + (i + 1) * DAY, open: 220, high: 224, low: 218, close: 222, volume: 1e6 })) });
      }
      // a session of 5-minute bars on a day inside the asked window, regular hours only
      const day = run(`nyDateStr(new Date(${start + 2 * DAY}))`);
      const open = run(`nyWallMs('${day}', '09:30')`);
      return json({ candles: Array.from({ length: 78 }, (_, i) => ({ datetime: open + i * 300000, open: 229, high: 231, low: 228, close: 230, volume: 5000 })) });
    }
    return json({}, 404);
  };
  const h = await app({ fetch, storage: connected(), lenient });
  run = h.run;
  h.run("document.getElementById('riskDollar').value = '500'; document.getElementById('accountSize').value = '50000';");
  return { ...h, calls, tradier };
}

test('a Schwab login alone loads a stock: the quote, its 5-minute chart and its daily bars, nothing to Tradier', async () => {
  const { run, elements, state, calls, tradier } = await schwabOnly();
  assert.equal(run('marketSource()'), 'schwab');
  run('updateApiStatus()');
  assert.equal(elements.get('setupNotice').style.display, 'none', 'no "add a key" notice');
  assert.match(elements.get('apiStatus').innerHTML, /Quotes from Schwab/);
  assert.equal(elements.get('settingsBtn').classList.contains('needs-key'), false);
  elements.get('ticker').value = 'aapl';
  await run('fetchQuote()');
  await settle();
  assert.equal(tradier.length, 0);
  assert.equal(elements.get('errorBox').textContent || '', '');
  assert.equal(state.quoteData.symbol, 'AAPL');
  assert.equal(elements.get('qPrice').textContent, '$230.50');
  assert.ok(calls.some(u => u.includes('/marketdata/v1/pricehistory') && u.includes('frequencyType=minute')), '5-minute bars');
  assert.ok(calls.some(u => u.includes('/marketdata/v1/pricehistory') && u.includes('frequencyType=daily')), 'daily bars');
  assert.ok(state.chartBars.length > 0, 'the chart has bars');
});

test('a Schwab login alone loads the option chain with its greeks, and Live polls instead of streaming', async () => {
  const { run, state, calls, tradier, api } = await schwabOnly({ lenient: true }); // lenient: the expiration tabs' ids are dates
  const sockets = [];
  api.effects.openSocket = url => { sockets.push(url); return { readyState: 0, send() {}, close() {} }; };
  await run("setMode('options')");
  run("document.getElementById('ticker').value = 'AAPL'");
  await run('fetchQuote()');
  await settle();
  assert.equal(tradier.length, 0);
  assert.ok(calls.some(u => u.startsWith(PROXY + '/marketdata/v1/expirationchain?symbol=AAPL')));
  assert.ok(calls.some(u => u.startsWith(PROXY + '/marketdata/v1/chains?symbol=AAPL&contractType=ALL')));
  assert.equal(state.selectedExp, '2026-12-18');
  assert.equal(state.chainData.length, 3);
  assert.equal(state.chainData.find(o => o.symbol === 'AAPL261218C00230000').greeks.delta, 0.52);
  run('ensureStream()');
  await settle();
  assert.equal(sockets.length, 0, "Tradier's stream needs a Tradier key");
});

test('with neither a Tradier key nor a Schwab login, Load says what to add and opens Settings', async () => {
  const h = await app({ fetch: async url => { throw new Error('Unexpected request ' + url); } });
  h.elements.get('ticker').value = 'AAPL';
  await h.run('fetchQuote()');
  assert.equal(h.run('openSheetName'), 'settings');
  assert.equal(h.elements.get('errorBox').textContent, 'Add a Tradier API key or log in to Schwab in Settings.');
});

test('a Schwab app without Market Data Production says what to fix, not "symbol not found"', async () => {
  const fetch = async url => {
    if (url.startsWith(PROXY + '/marketdata/v1/')) return json({ message: 'Forbidden' }, 403);
    throw new Error('Unexpected request ' + url);
  };
  const h = await app({ fetch, storage: connected() });
  h.elements.get('ticker').value = 'AAPL';
  await h.run('fetchQuote()');
  await settle();
  assert.equal(h.elements.get('errorBox').textContent, 'Error: Schwab refused the market data. Check that your Schwab app has Market Data Production, then log in to Schwab again.');
  assert.equal(h.run('schwabRefusal(404)'), "Your Schwab worker can't read market data yet. Redeploy it (worker/schwab/README.md).");
  assert.equal(h.run('schwabRefusal(500)'), '');
});
