import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MarketData as data } from '../src/core/market-data.js';
import { app as harness } from './helpers/app.mjs';

const csv = fs.readFileSync(new URL('../data/market-universe-2026-09-16.csv', import.meta.url), 'utf8');
const realEtfCsv = fs.readFileSync(new URL('../data/market-etfs-2026-09-16.csv', import.meta.url), 'utf8');
const header = 'ticker,name,group,performance_today,performance_1w,performance_1m,performance_3m,performance_6m,performance_ytd';
const fixture = () => data.parseCsv(header + '\nA,"Alpha, Inc.",Tech,0,2,4,6,8,10\nB,Beta,Tech,-2,,8,10,12,14\nC,Gamma,Energy,3,4,5,6,7,8');

test('imports all 2,860 tickers and 146 groups without duplicates', async () => {
  assert.equal(typeof data.parseCsv, 'function');
  const rows = data.parseCsv(csv);
  assert.equal(rows.length, 2860);
  assert.equal(new Set(rows.map(r => r.ticker)).size, 2860);
  assert.equal(data.groups(rows).length, 146);
});

test('CSV preserves quoted names, blank vs zero, and rejects invalid schemas/duplicates', async () => {
  const rows = fixture();
  assert.equal(rows[0].name, 'Alpha, Inc.');
  assert.equal(rows[0].returns[0], 0);
  assert.equal(rows[1].returns[1], null);
  assert.throws(() => data.parseCsv('ticker,name\nA,Alpha'), /columns/i);
  assert.throws(() => data.parseCsv(header + '\nA,Alpha,Tech,1,2,3,4,5,6\nA,Again,Tech,1,2,3,4,5,6'), /duplicate/i);
});

test('groups use equal-weight averages, exclude missing returns and retain coverage', async () => {
  const group = data.groups(fixture()).find(r => r.name === 'Tech');
  assert.equal(group.count, 2);
  assert.equal(group.returns[0], -1);
  assert.equal(group.returns[1], 2);
  assert.equal(group.coverage[1], 1);
  assert.equal(group.returns[2], 6);
});

test('searching a ticker finds its full group without changing its average', async () => {
  const groups = data.groups(fixture());
  const results = data.filter(groups, 'alpha');
  assert.equal(results.length, 1);
  assert.equal(results[0].count, 2);
  assert.equal(results[0].returns[2], 6);
  assert.equal(data.filter(fixture(), 'ENERGY')[0].ticker, 'C');
});

test('sorting puts unavailable values last in either direction, without mutating rows', async () => {
  const rows = fixture();
  assert.equal(data.sort(rows, 1, 'desc').map(r => r.ticker).join(), 'C,A,B');
  assert.equal(data.sort(rows, 1, 'asc').map(r => r.ticker).join(), 'A,C,B');
  assert.equal(rows.map(r => r.ticker).join(), 'A,B,C');
});

test('fresh quotes replace Today only; missing symbols never silently retain old returns', async () => {
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
    base: 'https://api.tradier.com/v1', auth: {}, retries: 0,
    fetchImpl: async () => ({ok: false, status: 429}),
  }), /rate limit/i);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(data.fetchQuotes(['A'], {
    base: '', auth: {}, signal: controller.signal,
    fetchImpl: async () => { throw new Error('should not fetch'); },
  }), /cancel/i);
});

// Market cases run on a lenient fake page with fake timers and clock. Requests the calculator makes on
// the side (intraday bars, daily history, and the CSV universe unless a test loads it itself) get canned
// answers here, so each test's fake only sees the Market and quote traffic it is about.
const sideBars = [0, 1].map(i => ({ time: `2026-09-18T09:${30 + i * 5}:00`, timestamp: 1789738200 + i * 300, open: 10, high: 10.5, low: 9.5, close: 10, volume: 1 }));
const sideDays = [{ date: '2026-09-17', open: 10, high: 11, low: 9, close: 10 }, { date: '2026-09-18', open: 10, high: 11, low: 9, close: 10 }];
async function appContext(fetchImpl = async () => { throw new Error('Unexpected request'); }, skipMarketLoad = true) {
  const side = url => {
    if (url.includes('/markets/timesales')) return { ok: true, json: async () => ({ series: { data: sideBars } }) };
    if (url.includes('/markets/history')) return { ok: true, json: async () => ({ history: { day: sideDays } }) };
    if (skipMarketLoad && /data\/market-.*\.csv$/.test(url)) return { ok: true, text: async () => url.includes('market-etfs') ? realEtfCsv : csv };
    return null;
  };
  const app = await harness({ lenient: true, timers: 'fake', clock: true, fetch: (url, options) => side(String(url)) || fetchImpl(url, options) });
  app.element('apiEnv').value = 'production';
  app.element('ticker').value = 'A';
  return app;
}

test('Market and Tools keep calculator charts hidden even after a pending quote finishes', async () => {
  let resolveQuote;
  const response = new Promise(resolve => { resolveQuote = resolve; });
  const app = await appContext(() => response);
  app.element('apiKey').value = 'test';
  const request = app.run('fetchQuote()');
  app.run("chartBars = [{}]; dailyBars = [{}]; setView('market'); updateChartVisibility();");
  assert.equal(app.element('chartWrap').style.display, 'none');
  resolveQuote({json: async () => ({quotes: {quote: {symbol:'A', type:'stock', last:10}}})});
  await request;
  await new Promise(resolve => setImmediate(resolve)); // the intraday and daily loads that follow the quote
  assert.equal(app.element('quoteSection').style.display, 'none');
  app.run("setView('utils'); updateChartVisibility();");
  assert.equal(app.element('chartWrap').style.display, 'none');
  app.run("setView('calc');");
  assert.equal(app.element('quoteSection').style.display, '');
  assert.equal(app.element('chartWrap').style.display, 'block');
});

test('a late quote for a previous ticker cannot overwrite the symbol selected from Market', async () => {
  const pending = {};
  const app = await appContext(url => new Promise(resolve => { pending[url.includes('symbols=A&') ? 'A' : 'B'] = resolve; }));
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
  const app = await appContext(url => new Promise(resolve => { pending[url.includes('symbol=A&') ? 'A' : 'B'] = resolve; }));
  app.run("selectedExp = '2026-10-16';");
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
    base: 'https://api.tradier.com/v1', auth: {}, pause: async () => {}, retries: 0,
    fetchImpl: async () => ++calls === 1
      ? {ok:true, json: async () => ({quotes: {quote: {symbol:'S0', last:10, change_percentage:1}}})}
      : {ok:false, status:503},
  }), /503/);
  assert.equal(calls, 2);
});

const etfFixture = () => data.parseCsv(header + ',performance_open,performance_1y,category\nXLK,Technology Select Sector SPDR ETF,S&P Sectors,1,2,3,4,5,,0.5,30,sectors\nRSP,Invesco S&P 500 Equal Weight ETF,Equal Weight,-1,-2,-3,-4,-5,,-0.5,10,equal-weight');

test('ETF import keeps from-open and one-year returns separate from YTD', async () => {
  const rows = etfFixture();
  assert.equal(rows[0].category, 'sectors');
  assert.equal(rows[0].returns[5], null);
  assert.equal(rows[0].returns[6], 0.5);
  assert.equal(rows[0].returns[7], 30);
  assert.equal(fixture()[0].returns.length, 6);
});

test('ETF quote refresh replaces from-open and Today, preserving the one-year snapshot', async () => {
  const quotes = data.quoteRows({quotes: {quote: {symbol:'XLK', last:110, open:100, prevclose:105}}});
  const rows = data.withQuotes(etfFixture(), quotes);
  assert.ok(Math.abs(rows[0].returns[6] - 10) < 1e-10);
  assert.equal(rows[0].returns[7], 30);
  assert.equal(rows[1].returns[6], null);
  const noOpen = data.quoteRows({quotes: {quote: {symbol:'XLK', last:110, open:0, change_percentage:2}}});
  assert.equal(data.withQuotes(etfFixture(), noOpen)[0].returns[6], null);
});

test('all four ETF universes match the reference and contain distinct tickers', async () => {
  const etfs = data.parseCsv(fs.readFileSync(new URL('../data/market-etfs-2026-09-16.csv', import.meta.url), 'utf8'));
  assert.equal(etfs.length, 146);
  assert.equal(new Set(etfs.map(row => row.ticker)).size, 146);
  for (const [category, count] of Object.entries({'group-etfs':88, sectors:17, 'equal-weight':13, countries:28})) {
    assert.equal(etfs.filter(row => row.category === category).length, count);
  }
  assert.equal(etfs.find(row => row.ticker === 'DRAM').returns[7], null);
  assert.equal(etfs.find(row => row.ticker === 'EWY').returns[7], 118.73);
});

test('switching categories clears a stock drilldown and uses the correct ETF universe and periods', async () => {
  const app = await appContext();
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

test('refresh scopes cover the active ETF tab, opened group, or complete theme overview', async () => {
  assert.equal(data.sort(etfFixture(), 'ticker', 'asc').map(row => row.ticker).join(), 'RSP,XLK');
  assert.equal(data.sort(etfFixture(), 'ticker', 'desc').map(row => row.ticker).join(), 'XLK,RSP');
  const app = await appContext();
  app.run('marketState.stocks = ' + JSON.stringify(fixture()) + '; marketState.etfs = ' + JSON.stringify(etfFixture()) + ';');
  assert.equal(app.run('marketQuoteSymbols().sort().join()'), 'A,B,C');
  assert.equal(app.run('marketRefreshScope().interval'), 180000);
  app.run("marketOpenGroup('Tech');");
  assert.equal(app.run('marketQuoteSymbols().sort().join()'), 'A,B');
  assert.equal(app.run('marketRefreshScope().interval'), 30000);
  app.run("marketSetCategory('sectors');");
  assert.equal(app.run('marketQuoteSymbols().join()'), 'XLK');
});

test('an ETF file failure can be retried without leaving half of the Market universes loaded', async () => {
  let failEtfs = true;
  const etfCsv = fs.readFileSync(new URL('../data/market-etfs-2026-09-16.csv', import.meta.url), 'utf8');
  const app = await appContext(async url => ({ok: !(failEtfs && url.includes('market-etfs')), text: async () => url.includes('market-etfs') ? etfCsv : csv}), false);
  await app.run('loadMarket()');
  assert.equal(app.run('marketState.stocks.length'), 0);
  assert.equal(app.run('marketState.etfs.length'), 0);
  assert.match(app.element('marketContent').innerHTML, /Retry loading/);
  failEtfs = false;
  await app.run('loadMarket()');
  assert.equal(app.run('marketAllRows().length'), 3006);
  assert.equal(app.run('marketState.error'), '');
});

test('switching categories cancels the old scope and prevents its late response being committed', async () => {
  let resolveQuote, requested, signal;
  const app = await appContext((url, options) => {
    requested = new URLSearchParams(options.body).get('symbols');
    signal = options.signal;
    return new Promise(resolve => { resolveQuote = resolve; });
  });
  app.element('apiKey').value = 'test';
  app.run('marketState.stocks = ' + JSON.stringify(fixture()) + '; marketState.etfs = ' + JSON.stringify(etfFixture()) + ';');
  app.run("marketView = true; marketSetCategory('sectors');");
  const refresh = app.run('marketRefreshToday()');
  assert.equal(requested, 'XLK');
  app.run("marketSetCategory('equal-weight');");
  assert.equal(signal.aborted, true);
  resolveQuote({ok:true, json: async () => ({quotes:{quote:[
    {symbol:'XLK', last:110, open:100, change_percentage:5},
    {symbol:'RSP', last:51, open:50, change_percentage:1},
  ]}})});
  await refresh;
  assert.equal(app.run('marketRows()[0].ticker'), 'RSP');
  assert.equal(app.run('marketCachedSnapshot()'), null);
  assert.equal(app.run('Object.keys(marketState.snapshots).length'), 0);
});

test('an ETF opens sizing, clearing the previous symbol and stop values', async () => {
  const app = await appContext();
  app.element('apiKey').value = 'test';
  app.element('stopLong').value = '90';
  app.run('marketState.etfs = ' + JSON.stringify(etfFixture()) + ';');
  app.run("setView('market'); marketSizeTrade('XLK');");
  assert.equal(app.element('ticker').value, 'XLK');
  assert.equal(app.element('stopLong').value, '');
  assert.equal(app.run('marketView'), false);
  assert.equal(app.run('quoteData'), null);
});

test('sizing an ETF from Market exits a previously selected Futures mode', async () => {
  const app = await appContext();
  app.run('marketState.etfs = ' + JSON.stringify(etfFixture()) + ';');
  await app.run("setMode('futures')");
  app.run("setView('market'); marketSizeTrade('XLK');");
  assert.equal(app.run('currentMode'), 'shares');
  assert.equal(app.element('futuresSection').style.display, 'none');
  assert.equal(app.element('sizingControls').style.display, '');
  assert.equal(app.element('ticker').value, 'XLK');
});

test('Futures shortcut works from Market and Market search keeps its focus behavior', async () => {
  const app = await appContext();
  let selectedSearch = false;
  app.element('marketSearch').select = () => { selectedSearch = true; };
  app.run('initShortcuts();');
  await app.run("setMode('futures')");
  app.run("setView('market');");
  app.dispatch('keydown', {key:'/', target:{tagName:'BUTTON'}, preventDefault() {}});
  assert.equal(selectedSearch, true);
  assert.equal(app.run('marketView'), true);
  app.dispatch('keydown', {key:'f', target:{tagName:'BUTTON'}, preventDefault() {}});
  assert.equal(app.run('marketView'), false);
  assert.equal(app.run('currentMode'), 'futures');
  assert.equal(app.element('futuresSection').style.display, '');
});

test('both Tools shortcuts work from Market without moving focus into a text field', async () => {
  const app = await appContext();
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

function seedMarket(app) {
  app.run('marketState.stocks = ' + JSON.stringify(fixture()) + '; marketState.etfs = ' + JSON.stringify(etfFixture()) + ';');
  app.element('apiKey').value = 'test';
  app.run("marketView = true; marketSetCategory('sectors');");
}
const quoteResponse = (symbol, change = 2) => ({ok:true, json: async () => ({quotes:{quote:{symbol, last:102, open:100, change_percentage:change}}})});

test('a scoped refresh preserves selected period, sort, unrelated caches and historical returns', async () => {
  const requested = [];
  const app = await appContext(async (url, options) => {
    const symbol = new URLSearchParams(options.body).get('symbols'); requested.push(symbol);
    return quoteResponse(symbol);
  });
  seedMarket(app);
  app.run('marketSetPeriod(7); marketSortTicker();');
  await app.run('marketRefreshToday()');
  assert.equal(app.run('marketState.period'), 7);
  assert.equal(app.run('marketState.sort'), 'ticker');
  assert.equal(app.run('marketState.direction'), 'asc');
  assert.equal(app.run('marketRows()[0].returns[7]'), 30);
  app.run("marketSetCategory('equal-weight');");
  assert.equal(app.run('marketCachedSnapshot()'), null);
  await app.run('marketRefreshToday()');
  app.run("marketSetCategory('sectors');");
  assert.equal(app.run('marketRows()[0].returns[0]'), 2);
  assert.equal(requested.join(), 'XLK,RSP');
  app.run('marketState.snapshots = {}; marketReadCache();');
  assert.equal(app.run('marketRows()[0].returns[0]'), 2);
  app.element('apiEnv').value = 'sandbox';
  app.run('marketReadCache();');
  assert.equal(app.run('marketCachedSnapshot()'), null);
});

test('automatic refresh respects cache age, pauses when hidden and resumes only when stale', async () => {
  let calls = 0;
  const app = await appContext(async () => { calls++; return quoteResponse('XLK'); });
  seedMarket(app);
  await app.advance(0);
  assert.equal(calls, 1);
  await app.advance(29000);
  assert.equal(calls, 1);
  await app.advance(1000);
  assert.equal(calls, 2);
  app.run('document.hidden = true; marketScheduleRefresh();');
  await app.advance(60000);
  assert.equal(calls, 2);
  app.run('document.hidden = false; marketScheduleRefresh();');
  await app.advance(0);
  assert.equal(calls, 3);
  app.run("setView('calc');");
  await app.advance(60000);
  assert.equal(calls, 3);
});

test('a group reuses the full overview cache but a group-only refresh cannot mark the overview fresh', async () => {
  const app = await appContext(async (url, options) => ({ok:true, json:async () => ({quotes:{quote:
    new URLSearchParams(options.body).get('symbols').split(',').map(symbol => ({symbol,last:100,change_percentage:2}))}})}));
  seedMarket(app);
  app.run("marketSetCategory('themes');");
  await app.run('marketRefreshToday()');
  app.run("marketOpenGroup('Tech');");
  assert.equal(app.run('marketCachedSnapshot().quotes.A.change'), 2);
  app.run('marketState.snapshots = {};');
  await app.run('marketRefreshToday()');
  app.run("marketSetScope('groups');");
  assert.equal(app.run('marketCachedSnapshot()'), null);
});

test('snapshot mode pauses auto-refresh, and turning auto back on restores cached quotes', async () => {
  let calls = 0;
  const app = await appContext(async () => { calls++; return quoteResponse('XLK', 9); });
  seedMarket(app);
  await app.run('marketRefreshToday()');
  app.run('marketUseSnapshot();');
  await app.advance(60000);
  assert.equal(calls, 1);
  assert.equal(app.run('marketRows()[0].returns[0]'), 1);
  app.run('marketToggleAuto();');
  assert.equal(app.run('marketRows()[0].returns[0]'), 9);
  await app.advance(0);
  assert.equal(calls, 2);
});

test('leaving Market aborts in-flight requests and keeps the previous cache', async () => {
  let resolve, signal;
  const app = await appContext((url, options) => { signal = options.signal; return new Promise(done => { resolve = done; }); });
  seedMarket(app);
  const request = app.run('marketRefreshToday()');
  app.run("setView('utils');");
  assert.equal(signal.aborted, true);
  resolve(quoteResponse('XLK'));
  await request;
  assert.equal(app.run('marketCachedSnapshot()'), null);
});

test('a failed batch is retried without requesting earlier successful batches again', async () => {
  const calls = [], waits = [];
  const symbols = Array.from({length:101}, (_, i) => 'S' + i);
  const quotes = await data.fetchQuotes(symbols, {base:'',auth:{},pause:async ms => waits.push(ms),
    fetchImpl:async (url, options) => {
      const batch = new URLSearchParams(options.body).get('symbols').split(','); calls.push(batch);
      if (calls.length === 2) return {ok:false,status:503};
      return {ok:true,json:async () => ({quotes:{quote:batch.map(symbol => ({symbol,last:10,change_percentage:1}))}})};
    }});
  assert.equal(calls.length, 3);
  assert.equal(calls[1].join(), calls[2].join());
  assert.equal(Object.keys(quotes).length, 101);
  assert.ok(waits.includes(1000));
});

test('rate-limit retries honor Retry-After and authentication errors are never retried', async () => {
  let attempts = 0;
  const waits = [];
  await data.fetchQuotes(['XLK'], {base:'',auth:{},pause:async ms => waits.push(ms),
    fetchImpl:async () => ++attempts === 1 ? {ok:false,status:429,headers:{get:key => key === 'Retry-After' ? '60' : null}} : quoteResponse('XLK')});
  assert.equal(waits[0], 60000);
  attempts = 0;
  await assert.rejects(data.fetchQuotes(['XLK'], {base:'',auth:{},pause:async () => {},
    fetchImpl:async () => { attempts++; return {ok:false,status:401}; }}), /API key/);
  assert.equal(attempts, 1);
});

test('invalid rate-limit headers use a conservative fallback wait', async () => {
  let attempts = 0;
  const waits = [];
  await data.fetchQuotes(['XLK'], {base:'',auth:{},pause:async ms => waits.push(ms),
    fetchImpl:async () => ++attempts === 1 ? {ok:false,status:429,headers:{get:() => 'invalid'}} : quoteResponse('XLK')});
  assert.equal(waits[0], 60000);
});

test('refresh preserves table scroll and keyboard focus when price changes reorder rows', async () => {
  const app = await appContext(async () => quoteResponse('XLK'));
  seedMarket(app);
  const section = app.element('marketSection');
  const oldTable = {scrollTop:250,scrollLeft:120}, newTable = {scrollTop:0,scrollLeft:0};
  let tableReads = 0, focusOptions;
  section.querySelector = () => ++tableReads === 1 ? oldTable : newTable;
  section.contains = () => true;
  app.run("document.activeElement = {attributes:[{name:'data-market-ticker',value:'XLK'}], closest:() => document.getElementById('marketContent')};");
  const rows = [
    {getAttribute: () => 'RSP', focus:() => assert.fail('must focus the same ticker')},
    {getAttribute: () => 'XLK', focus:options => { focusOptions = options; }},
  ];
  app.element('marketContent').querySelectorAll = () => rows;
  section.querySelectorAll = () => [
    {getAttribute: () => 'XLK', focus:() => assert.fail('must not move focus to a summary card')}, ...rows,
  ];
  await app.run('marketRefreshToday()');
  assert.equal(newTable.scrollTop, 250);
  assert.equal(newTable.scrollLeft, 120);
  assert.equal(focusOptions.preventScroll, true);
});

test('existing v2 quotes migrate into scoped caches with their original timestamp', async () => {
  const app = await appContext();
  seedMarket(app);
  app.storage.set('market_quotes_v2_production', JSON.stringify({fetchedAt:app.run('Date.now() - 60000'),quotes:{
    A:{price:10,change:5}, XLK:{price:100,change:6,fromOpen:2}, RSP:{price:50,change:3}
  }}));
  app.run('marketReadCache();');
  assert.equal(app.run('marketRows()[0].returns[0]'), 6);
  assert.equal(app.run('Date.now() - marketCachedSnapshot().fetchedAt'), 60000);
  app.run("marketSetCategory('equal-weight');");
  assert.equal(app.run('marketRows()[0].returns[0]'), 3);
  app.run("marketSetCategory('themes');");
  assert.equal(app.run('marketRows()[1].returns[0]'), null);
});

test('authentication failure pauses auto-refresh until credentials change', async () => {
  let calls = 0;
  const app = await appContext(async () => ++calls === 1 ? {ok:false,status:401} : quoteResponse('XLK'));
  seedMarket(app);
  await app.advance(0);
  assert.equal(calls, 1);
  await app.advance(180000);
  assert.equal(calls, 1);
  assert.match(app.element('marketRefreshStatus').textContent, /check your Tradier key/);
  app.element('apiKey').value = 'new-test-key';
  app.run('marketScheduleRefresh();');
  await app.advance(0);
  assert.equal(calls, 2);
});

test('failed refresh keeps cached values and backs off; missing quotes clear only the refreshed scope', async () => {
  let calls = 0;
  const app = await appContext(async () => {
    calls++;
    if (calls === 2) return {ok:false,status:422};
    return {ok:true,json:async () => ({quotes:{quote: calls === 1
      ? [{symbol:'A',last:10,change_percentage:5},{symbol:'B',last:20,change_percentage:6}]
      : {symbol:'A',last:10,change_percentage:7}}})};
  });
  seedMarket(app);
  app.run("marketSetCategory('themes'); marketOpenGroup('Tech');");
  await app.run('marketRefreshToday()');
  await app.run('marketRefreshToday()');
  assert.equal(app.run('marketRows()[1].returns[0]'), 6);
  await app.advance(29000);
  assert.equal(calls, 2);
  await app.advance(1000);
  assert.equal(calls, 3);
  assert.equal(app.run('marketRows()[0].returns[0]'), 7);
  assert.equal(app.run('marketRows()[1].returns[0]'), null);
});

test('offline and missing-key states never request quotes', async () => {
  let calls = 0;
  const app = await appContext(async () => { calls++; return quoteResponse('XLK'); });
  seedMarket(app);
  app.element('apiKey').value = '';
  app.run('marketScheduleRefresh();');
  await app.advance(180000);
  assert.equal(calls, 0);
  app.element('apiKey').value = 'test';
  app.run('navigator.onLine = false; marketScheduleRefresh();');
  await app.advance(180000);
  assert.equal(calls, 0);
  app.run('navigator.onLine = true; marketScheduleRefresh();');
  await app.advance(0);
  assert.equal(calls, 1);
});

test('cancelling during rate-limit backoff rejects promptly without another request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const request = data.fetchQuotes(['XLK'], {base:'',auth:{},signal:controller.signal,
    onRetry: () => controller.abort(),
    fetchImpl: async () => { calls++; return {ok:false,status:429}; }});
  await assert.rejects(request, /cancel/i);
  assert.equal(calls, 1);
});
