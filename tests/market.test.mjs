import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script id="marketLogic">([\s\S]*?)<\/script>/)?.[1];
const context = vm.createContext({ URLSearchParams, AbortController, setTimeout, clearTimeout });
if (script) vm.runInContext(script, context);
const data = script ? vm.runInContext('MarketData', context) : {};
const csv = fs.readFileSync(new URL('../data/market-universe-2026-09-16.csv', import.meta.url), 'utf8');
const header = 'ticker,name,group,performance_today,performance_1w,performance_1m,performance_3m,performance_6m,performance_ytd';
const fixture = () => data.parseCsv(header + '\nA,"Alpha, Inc.",Tech,0,2,4,6,8,10\nB,Beta,Tech,-2,,8,10,12,14\nC,Gamma,Energy,3,4,5,6,7,8');

test('imports all 2,860 tickers and 146 groups without duplicates', () => {
  assert.equal(typeof data.parseCsv, 'function');
  const rows = data.parseCsv(csv);
  assert.equal(rows.length, 2860);
  assert.equal(new Set(rows.map(r => r.ticker)).size, 2860);
  assert.equal(data.groups(rows).length, 146);
});

test('CSV preserves quoted names, blank vs zero, and rejects invalid schemas/duplicates', () => {
  const rows = fixture();
  assert.equal(rows[0].name, 'Alpha, Inc.');
  assert.equal(rows[0].returns[0], 0);
  assert.equal(rows[1].returns[1], null);
  assert.throws(() => data.parseCsv('ticker,name\nA,Alpha'), /columns/i);
  assert.throws(() => data.parseCsv(header + '\nA,Alpha,Tech,1,2,3,4,5,6\nA,Again,Tech,1,2,3,4,5,6'), /duplicate/i);
});

test('groups use equal-weight averages, exclude missing returns and retain coverage', () => {
  const group = data.groups(fixture()).find(r => r.name === 'Tech');
  assert.equal(group.count, 2);
  assert.equal(group.returns[0], -1);
  assert.equal(group.returns[1], 2);
  assert.equal(group.coverage[1], 1);
  assert.equal(group.returns[2], 6);
});

test('searching a ticker finds its full group without changing its average', () => {
  const groups = data.groups(fixture());
  const results = data.filter(groups, 'alpha');
  assert.equal(results.length, 1);
  assert.equal(results[0].count, 2);
  assert.equal(results[0].returns[2], 6);
  assert.equal(data.filter(fixture(), 'ENERGY')[0].ticker, 'C');
});

test('sorting puts unavailable values last in either direction, without mutating rows', () => {
  const rows = fixture();
  assert.equal(data.sort(rows, 1, 'desc').map(r => r.ticker).join(), 'C,A,B');
  assert.equal(data.sort(rows, 1, 'asc').map(r => r.ticker).join(), 'A,C,B');
  assert.equal(rows.map(r => r.ticker).join(), 'A,B,C');
});

test('fresh quotes replace Today only; missing symbols never silently retain old returns', () => {
  const rows = fixture();
  const quotes = data.quoteRows({quotes: {quote: {symbol: 'A', last: 100, prevclose: 100, change_percentage: 0, volume: 1200}}});
  const updated = data.withQuotes(rows, quotes);
  assert.equal(updated[0].returns[0], 0);
  assert.equal(updated[0].price, 100);
  assert.equal(updated[1].returns[0], null);
  assert.equal(updated[1].returns[2], 8);
  assert.equal(rows[1].returns[0], -2);
  assert.equal(data.quoteRows({quotes: {quote: {symbol: 'BAD', last: 0, change_percentage: 50}}}).BAD, undefined);
});

test('quote refresh batches symbols and accepts both single and multiple quote responses', async () => {
  const calls = [];
  const symbols = Array.from({length: 105}, (_, i) => 'S' + i);
  const quotes = await data.fetchQuotes(symbols, {
    base: 'https://api.tradier.com/v1', auth: {'Authorization': 'Bearer test'}, pause: async () => {},
    fetchImpl: async (url, options) => {
      const batch = new URLSearchParams(options.body).get('symbols').split(',');
      calls.push({url, options, batch});
      return {ok: true, json: async () => ({quotes: {quote: batch.map(symbol => ({symbol, last: 10, change_percentage: 1}))}})};
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].batch.length, 100);
  assert.equal(Object.keys(quotes).length, 105);
});

test('failed or cancelled refreshes reject instead of returning partial results', async () => {
  await assert.rejects(data.fetchQuotes(['A'], {
    base: 'https://api.tradier.com/v1', auth: {},
    fetchImpl: async () => ({ok: false, status: 429}),
  }), /rate limit/i);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(data.fetchQuotes(['A'], {
    base: '', auth: {}, signal: controller.signal,
    fetchImpl: async () => { throw new Error('should not fetch'); },
  }), /cancel/i);
});

function appContext(fetchImpl = async () => { throw new Error('Unexpected request'); }, skipMarketLoad = true) {
  const elements = new Map();
  const listeners = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', style: {}, dataset: {}, innerHTML: '', textContent: '',
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {}, removeAttribute() {}, addEventListener() {}, focus() {}, scrollIntoView() {},
    });
    return elements.get(id);
  };
  element('apiEnv').value = 'production';
  element('ticker').value = 'A';
  const sandbox = vm.createContext({ URLSearchParams, AbortController, setTimeout, clearTimeout,
    setInterval, clearInterval, fetch: fetchImpl, navigator: {},
    window: { scrollY: 0, scrollTo() {} },
    document: { hidden: false, getElementById: element, querySelector: element, querySelectorAll: () => [],
      addEventListener: (type, listener) => listeners.set(type, listener),
      documentElement: { style: { setProperty() {} } } },
  });
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  vm.runInContext(scripts[0], sandbox);
  vm.runInContext(scripts[1].split('syncSuppress = true; // init reads back')[0], sandbox);
  vm.runInContext((skipMarketLoad ? 'loadMarket = async () => {}; ' : '') + 'renderQuote = () => {}; pushRecentTicker = () => {}; fetchChart = async () => {}; fetchAdr = async () => {}; markSyncDirty = () => {};', sandbox);
  return { run: code => vm.runInContext(code, sandbox), element, dispatch: (type, event) => listeners.get(type)(event) };
}

test('Market and Tools keep calculator charts hidden even after a pending quote finishes', async () => {
  let resolveQuote;
  const response = new Promise(resolve => { resolveQuote = resolve; });
  const app = appContext(() => response);
  app.element('apiKey').value = 'test';
  const request = app.run('fetchQuote()');
  app.run("chartBars = [{}]; dailyBars = [{}]; setView('market'); updateChartVisibility();");
  assert.equal(app.element('chartWrap').style.display, 'none');
  resolveQuote({json: async () => ({quotes: {quote: {symbol:'A', type:'stock', last:10}}})});
  await request;
  assert.equal(app.element('quoteSection').style.display, 'none');
  app.run("setView('utils'); updateChartVisibility();");
  assert.equal(app.element('chartWrap').style.display, 'none');
  app.run("setView('calc');");
  assert.equal(app.element('quoteSection').style.display, '');
  assert.equal(app.element('chartWrap').style.display, 'block');
});

test('a late quote for a previous ticker cannot overwrite the symbol selected from Market', async () => {
  const pending = {};
  const app = appContext(url => new Promise(resolve => { pending[url.includes('symbols=A&') ? 'A' : 'B'] = resolve; }));
  app.element('apiKey').value = 'test';
  const oldRequest = app.run('fetchQuote()');
  app.element('ticker').value = 'B';
  const newRequest = app.run('fetchQuote()');
  pending.B({json: async () => ({quotes: {quote: {symbol:'B', type:'stock', last:20}}})});
  await newRequest;
  pending.A({json: async () => ({quotes: {quote: {symbol:'A', type:'stock', last:10}}})});
  await oldRequest;
  assert.equal(app.run('quoteData.symbol'), 'B');
});

test('switching tickers can load a new options chain while the previous chain is pending', async () => {
  const pending = {};
  const app = appContext(url => new Promise(resolve => { pending[url.includes('symbol=A&') ? 'A' : 'B'] = resolve; }));
  app.run("selectedExp = '2026-10-16'; renderChain = () => {}; cancelSpread = () => {};");
  const oldRequest = app.run("fetchChain('A', selectedExp, true)");
  app.element('ticker').value = 'B';
  const newRequest = app.run("fetchChain('B', selectedExp, true)");
  assert.equal(typeof pending.B, 'function');
  pending.B({json: async () => ({options: {option: {symbol:'B-option'}}})});
  await newRequest;
  pending.A({json: async () => ({options: {option: {symbol:'A-option'}}})});
  await oldRequest;
  assert.equal(app.run('chainData[0].symbol'), 'B-option');
});

test('a failure after a successful batch still rejects the whole refresh', async () => {
  let calls = 0;
  await assert.rejects(data.fetchQuotes(Array.from({length:101}, (_, i) => 'S' + i), {
    base: 'https://api.tradier.com/v1', auth: {}, pause: async () => {},
    fetchImpl: async () => ++calls === 1
      ? {ok:true, json: async () => ({quotes: {quote: {symbol:'S0', last:10, change_percentage:1}}})}
      : {ok:false, status:503},
  }), /503/);
  assert.equal(calls, 2);
});

const etfFixture = () => data.parseCsv(header + ',performance_open,performance_1y,category\nXLK,Technology Select Sector SPDR ETF,S&P Sectors,1,2,3,4,5,,0.5,30,sectors\nRSP,Invesco S&P 500 Equal Weight ETF,Equal Weight,-1,-2,-3,-4,-5,,-0.5,10,equal-weight');

test('ETF import keeps from-open and one-year returns separate from YTD', () => {
  const rows = etfFixture();
  assert.equal(rows[0].category, 'sectors');
  assert.equal(rows[0].returns[5], null);
  assert.equal(rows[0].returns[6], 0.5);
  assert.equal(rows[0].returns[7], 30);
  assert.equal(fixture()[0].returns.length, 6);
});

test('ETF quote refresh replaces from-open and Today, preserving the one-year snapshot', () => {
  const quotes = data.quoteRows({quotes: {quote: {symbol:'XLK', last:110, open:100, prevclose:105}}});
  const rows = data.withQuotes(etfFixture(), quotes);
  assert.ok(Math.abs(rows[0].returns[6] - 10) < 1e-10);
  assert.equal(rows[0].returns[7], 30);
  assert.equal(rows[1].returns[6], null);
  const noOpen = data.quoteRows({quotes: {quote: {symbol:'XLK', last:110, open:0, change_percentage:2}}});
  assert.equal(data.withQuotes(etfFixture(), noOpen)[0].returns[6], null);
});

test('all four ETF universes match the reference and contain distinct tickers', () => {
  const etfs = data.parseCsv(fs.readFileSync(new URL('../data/market-etfs-2026-09-16.csv', import.meta.url), 'utf8'));
  assert.equal(etfs.length, 146);
  assert.equal(new Set(etfs.map(row => row.ticker)).size, 146);
  for (const [category, count] of Object.entries({'group-etfs':88, sectors:17, 'equal-weight':13, countries:28})) {
    assert.equal(etfs.filter(row => row.category === category).length, count);
  }
  assert.equal(etfs.find(row => row.ticker === 'DRAM').returns[7], null);
  assert.equal(etfs.find(row => row.ticker === 'EWY').returns[7], 118.73);
});

test('switching categories clears a stock drilldown and uses the correct ETF universe and periods', () => {
  const app = appContext();
  app.run('marketState.stocks = ' + JSON.stringify(fixture()) + '; marketState.etfs = ' + JSON.stringify(etfFixture()) + ';');
  app.run("marketOpenGroup('Tech'); marketSetCategory('sectors');");
  assert.equal(app.run('marketState.group'), '');
  assert.equal(app.run('marketRows().map(row => row.ticker).join()'), 'XLK');
  assert.equal(app.element('marketScope').hidden, true);
  assert.match(app.element('marketContent').innerHTML, /From open/);
  assert.match(app.element('marketContent').innerHTML, /1Y/);
  assert.doesNotMatch(app.element('marketContent').innerHTML, />YTD/);
  app.run("marketSetPeriod(7); marketSetCategory('themes');");
  assert.equal(app.run('marketState.period'), 2);
  assert.equal(app.run('marketRows().length'), 3);
  assert.equal(app.element('marketScope').hidden, false);
  assert.match(app.element('marketContent').innerHTML, />YTD/);
  app.run("marketSetCategory('equal-weight'); marketSetDisplay('heatmap');");
  assert.match(app.element('marketContent').innerHTML, /data-market-ticker="RSP"/);
  assert.doesNotMatch(app.element('marketContent').innerHTML, /XLK/);
});

test('ticker sorting works in both directions and quote requests include stocks and every ETF once', () => {
  assert.equal(data.sort(etfFixture(), 'ticker', 'asc').map(row => row.ticker).join(), 'RSP,XLK');
  assert.equal(data.sort(etfFixture(), 'ticker', 'desc').map(row => row.ticker).join(), 'XLK,RSP');
  const app = appContext();
  app.run('marketState.stocks = ' + JSON.stringify(fixture()) + '; marketState.etfs = ' + JSON.stringify(etfFixture()) + ';');
  assert.equal(app.run('marketQuoteSymbols().sort().join()'), 'A,B,C,RSP,XLK');
});

test('an ETF file failure can be retried without leaving half of the Market universes loaded', async () => {
  let failEtfs = true;
  const etfCsv = fs.readFileSync(new URL('../data/market-etfs-2026-09-16.csv', import.meta.url), 'utf8');
  const app = appContext(async url => ({ok: !(failEtfs && url.includes('market-etfs')), text: async () => url.includes('market-etfs') ? etfCsv : csv}), false);
  await app.run('loadMarket()');
  assert.equal(app.run('marketState.stocks.length'), 0);
  assert.equal(app.run('marketState.etfs.length'), 0);
  assert.match(app.element('marketContent').innerHTML, /Retry loading/);
  failEtfs = false;
  await app.run('loadMarket()');
  assert.equal(app.run('marketQuoteSymbols().length'), 3006);
  assert.equal(app.run('marketState.error'), '');
});

test('refresh covers all universes even when the category changes during the request', async () => {
  let resolveQuote, requested;
  const app = appContext((url, options) => {
    requested = new URLSearchParams(options.body).get('symbols');
    return new Promise(resolve => { resolveQuote = resolve; });
  });
  app.element('apiKey').value = 'test';
  app.run('marketState.stocks = ' + JSON.stringify(fixture()) + '; marketState.etfs = ' + JSON.stringify(etfFixture()) + ';');
  app.run("marketSetCategory('sectors');");
  const refresh = app.run('marketRefreshToday()');
  assert.equal(requested, 'A,B,C,XLK,RSP');
  app.run("marketSetCategory('equal-weight');");
  resolveQuote({ok:true, json: async () => ({quotes:{quote:[
    {symbol:'XLK', last:110, open:100, change_percentage:5},
    {symbol:'RSP', last:51, open:50, change_percentage:1},
  ]}})});
  await refresh;
  assert.equal(app.run('marketRows()[0].ticker'), 'RSP');
  assert.equal(app.run('marketRows()[0].returns[0]'), 1);
  assert.ok(Math.abs(app.run('marketRows()[0].returns[6]') - 2) < 1e-10);
  app.run("marketSetCategory('sectors');");
  assert.equal(app.run('marketRows()[0].returns[0]'), 5);
  assert.equal(app.run('marketRows()[0].returns[7]'), 30);
  app.run("marketSetCategory('themes');");
  assert.equal(app.run('marketRows()[0].returns[0]'), null);
});

test('an ETF opens sizing, clearing the previous symbol and stop values', () => {
  const app = appContext();
  app.element('apiKey').value = 'test';
  app.element('stopLong').value = '90';
  app.run('marketState.etfs = ' + JSON.stringify(etfFixture()) + '; fetchQuote = () => {};');
  app.run("setView('market'); marketSizeTrade('XLK');");
  assert.equal(app.element('ticker').value, 'XLK');
  assert.equal(app.element('stopLong').value, '');
  assert.equal(app.run('marketView'), false);
  assert.equal(app.run('quoteData'), null);
});

test('both Tools shortcuts work from Market without moving focus into a text field', () => {
  const app = appContext();
  let focusedGain = false;
  app.element('gainCost').focus = () => { focusedGain = true; };
  app.run('initShortcuts();');
  for (const key of ['t', 'u']) {
    app.run("setView('market');");
    app.dispatch('keydown', {key, target:{tagName:'BUTTON'}, preventDefault() {}});
    assert.equal(app.run('utilsView'), true);
    assert.equal(app.run('marketView'), false);
    assert.equal(focusedGain, false);
    app.dispatch('keydown', {key, target:{tagName:'BUTTON'}, preventDefault() {}});
    assert.equal(app.run('utilsView'), false);
  }
});
