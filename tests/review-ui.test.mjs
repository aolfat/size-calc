// Run with: node --test
// Review fixes: refresh paths follow the loaded symbol (not the search field), symbol hygiene, chart and daily
// resets on a new symbol, Load never sticks, toasts, New York dates, the simulator and sheets own the keyboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { nyDateStr } from '../src/core/format.js';

const ok = body => ({ ok: true, json: async () => body });
const quote = (symbol, last = 100) => ok({ quotes: { quote: { symbol, type: 'stock', last, low: last - 2, high: last + 2 } } });
const bars = [{ time: '2026-10-08T09:30:00', timestamp: 1, open: 10, high: 11, low: 9, close: 10, volume: 1 }];

// a fetch that records every URL and answers by endpoint; `hold` parks matching requests until released
function tradier({ hold = () => false, quotes = sym => quote(sym) } = {}) {
  const urls = [], held = [];
  const answer = url => {
    if (url.includes('/markets/quotes')) return quotes(new URL(url).searchParams.get('symbols'));
    if (url.includes('/markets/timesales')) return ok({ series: { data: bars } });
    if (url.includes('/markets/history')) return ok({ history: null });
    if (url.includes('/options/expirations')) return ok({ expirations: { date: ['2026-10-16'] } });
    if (url.includes('/options/chains')) return ok({ options: { option: [] } });
    throw new Error('Unexpected request ' + url);
  };
  const fetch = async url => {
    url = String(url);
    urls.push(url);
    if (hold(url)) return new Promise(resolve => held.push({ url, release: () => resolve(answer(url)) }));
    return answer(url);
  };
  return { fetch, urls, held };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

async function loaded(opts = {}) {
  const t = tradier(opts);
  const h = await app({ fetch: t.fetch, lenient: true }); // lenient: expiry tabs are rendered ids
  h.elements.get('apiKey').value = 'test-key';
  h.run("quoteData = { symbol: 'AAPL', type: 'stock', last: 200, low: 198, high: 202 }");
  h.elements.get('stopLong').value = '197';
  h.elements.get('ticker').value = 'TSLA'; // typed into the search box, never loaded
  return { ...h, ...t };
}

// ---------- 1. refreshes key off the loaded symbol ----------

test('refresh, live ticks, interval, expiry and mode changes fetch the loaded symbol, not the typed one', async () => {
  const h = await loaded();
  assert.equal(await h.run('refreshQuote()'), true);
  assert.equal(h.run('quoteData.symbol'), 'AAPL');
  assert.equal(h.elements.get('stopLong').value, '197', 'the loaded symbol keeps its stops');
  await h.run('livePoll()');
  h.run('setChartInterval(15)');
  await h.run("selectExp('2026-10-16')");
  await h.run("setMode('options')");
  await settle();
  assert.ok(h.urls.length >= 5);
  for (const url of h.urls) assert.doesNotMatch(url, /TSLA/, url);
  assert.ok(h.urls.some(u => u.includes('/options/chains?symbol=AAPL')));
  assert.equal(h.run('quoteData.symbol'), 'AAPL');
});

test('refreshQuote says whether a fresh quote for the loaded symbol landed', async () => {
  let fail = false, empty = false, other = false;
  const h = await loaded({ quotes: sym => { if (fail) throw new Error('offline'); return empty ? ok({ quotes: {} }) : quote(other ? 'MSFT' : sym, 210); } });
  assert.equal(await h.run('refreshQuote()'), true);
  assert.equal(h.run('quoteData.last'), 210);
  fail = true;
  assert.equal(await h.run('refreshQuote()'), false, 'fetch error');
  fail = false; empty = true;
  assert.equal(await h.run('refreshQuote()'), false, 'no quote');
  empty = false; other = true;
  assert.equal(await h.run('refreshQuote()'), false, 'an answer for another symbol');
  assert.equal(h.run('quoteData.symbol'), 'AAPL');
  other = false;
  h.run("currentMode = 'futures'");
  assert.equal(await h.run('refreshQuote()'), false, 'futures');
  h.run("currentMode = 'shares'; quoteData = null");
  assert.equal(await h.run('refreshQuote()'), false, 'nothing loaded');
});

test('refreshQuote drops its answer when a Load replaced the symbol meanwhile', async () => {
  const h = await loaded({ hold: url => url.includes('symbols=AAPL') });
  const refresh = h.run('refreshQuote()');
  await settle();
  h.run("quoteData = { symbol: 'TSLA', type: 'stock', last: 300 }");
  h.held.shift().release();
  assert.equal(await refresh, false);
  assert.equal(h.run('quoteData.symbol'), 'TSLA');
});

test('a live tick landing between typing and Load still lets Load clear the old stops', async () => {
  const h = await loaded();
  await h.run('livePoll()'); // field says TSLA: the tick must not swap quoteData to it
  assert.equal(h.run('quoteData.symbol'), 'AAPL');
  await h.run('fetchQuote()');
  assert.equal(h.run('quoteData.symbol'), 'TSLA');
  assert.equal(h.elements.get('stopLong').value, '', 'stops belong to AAPL');
});

// ---------- 2. symbols are escaped, encoded and validated ----------

test('recent ticker chips escape what storage holds and drop anything that is not a symbol', async () => {
  const storage = new Map([['recent_tickers', JSON.stringify(['AAPL', '"><img src=x onerror=alert(1)>', 'BRK.B'])]]);
  const { run, elements } = await app({ storage });
  run('renderRecentTickers()');
  const html = elements.get('recentTickers').innerHTML;
  assert.doesNotMatch(html, /<img|onerror/);
  assert.match(html, /data-arg="AAPL"/);
  assert.match(html, /data-arg="BRK\.B"/);
  run("pushRecentTicker('<b>x</b>')");
  assert.doesNotMatch(storage.get('recent_tickers') || '', /<b>/);
  assert.equal(run("isSymbol('BRK.B') && isSymbol('BF-B') && isSymbol('SPX') && !isSymbol('A B') && !isSymbol('<x>') && !isSymbol('')"), true);
});

test('a junk ticker is never fetched or saved; a real one is URL-encoded', async () => {
  const t = tradier();
  const { run, elements, storage } = await app({ fetch: t.fetch });
  elements.get('apiKey').value = 'test-key';
  elements.get('ticker').value = 'AAPL&symbols=X"><script>';
  await run('fetchQuote()');
  assert.equal(t.urls.length, 0);
  assert.equal(storage.get('last_ticker'), undefined);
  assert.match(elements.get('errorBox').textContent, /Not a ticker/);
  elements.get('ticker').value = 'brk/b';
  await run('fetchQuote()');
  assert.ok(t.urls[0].includes('symbols=BRK%2FB&'), t.urls[0]);
  assert.equal(storage.get('last_ticker'), 'BRK/B');
});

// ---------- 4. the chart follows the new symbol ----------

test('a new symbol clears the old intraday bars and its own bars land even if the field changed', async () => {
  const h = await loaded({ hold: url => url.includes('/timesales') });
  h.run("chartBars = [{ t: '2026-10-08T09:30:00', o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }]");
  await h.run('fetchQuote()');
  assert.equal(h.run('chartBars.length'), 0, 'AAPL bars gone');
  assert.equal(h.elements.get('chartWrap').style.display, 'none', 'chart hides until TSLA bars land');
  h.elements.get('ticker').value = 'NV'; // typing the next one
  h.held.shift().release();
  await settle(); await settle();
  assert.equal(h.run('chartBars.length'), 1, 'the requested symbol keeps its answer');
  assert.equal(h.elements.get('chartWrap').style.display, 'block');
});

// ---------- 5. IV percentile distribution resets per symbol ----------

test('a new daily history load forgets the previous symbol\'s HV distribution', async () => {
  const { run } = await app({ fetch: async () => { throw new Error('offline'); } });
  run('hvDist = Array.from({ length: 30 }, (_, i) => 0.1 + i * 0.01)');
  assert.ok(run("ivRankInfo('AAA', 0.25)"));
  await run("fetchAdr('BBB')");
  assert.equal(run('hvDist.length'), 0);
  assert.equal(run("ivRankInfo('BBB', 0.25)"), null);
});

// ---------- 6. Load never sticks ----------

test('editing the field while the chain loads still finishes the Load', async () => {
  const h = await loaded({ hold: url => url.includes('/expirations') });
  h.run("currentMode = 'options'");
  const load = h.run('fetchQuote()');
  await settle();
  h.elements.get('ticker').value = 'NVDA';
  h.held.shift().release();
  await load;
  assert.doesNotMatch(h.elements.get('fetchBtnText').innerHTML, /spinner/);
  assert.equal(h.elements.get('quoteSection').style.display, '');
  assert.equal(h.run('quoteData.symbol'), 'TSLA');
  assert.equal(h.run('selectedExp'), '2026-10-16');
});

test('a newer Load owns the spinner; a failed Load shows the quote still loaded', async () => {
  const h = await loaded({ hold: url => url.includes('symbols=TSLA'), quotes: sym => sym === 'ZZZZ' ? ok({ quotes: {} }) : quote(sym) });
  const first = h.run('fetchQuote()');
  h.elements.get('ticker').value = 'MSFT';
  await h.run('fetchQuote()');
  assert.equal(h.run('quoteData.symbol'), 'MSFT');
  h.held.shift().release();
  await first;
  assert.equal(h.run('quoteData.symbol'), 'MSFT', 'the older answer is dropped');
  h.elements.get('ticker').value = 'ZZZZ';
  await h.run('fetchQuote()');
  assert.match(h.elements.get('errorBox').textContent, /not found/);
  assert.doesNotMatch(h.elements.get('fetchBtnText').innerHTML, /spinner/);
  assert.equal(h.elements.get('quoteSection').style.display, '', 'MSFT is still loaded, so it stays on screen');
});

// ---------- 7. toasts ----------

test('an error right after a success toast is not styled as a success', async () => {
  const { run, elements } = await app();
  run("showToast('Saved')");
  assert.ok(elements.get('errorBox').classList.contains('ok'));
  run("showError('Nope')");
  assert.ok(!elements.get('errorBox').classList.contains('ok'));
});

// ---------- 8. New York dates ----------

test('daily history treats the New York date as today, whatever the device zone', async () => {
  const tz = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  try {
    const at = Date.UTC(2026, 2, 10, 2, 0); // 22:00 Mar 9 in New York, already Mar 10 in Tokyo
    assert.equal(nyDateStr(new Date(at)), '2026-03-09');
    const { run, advance } = await app({ clock: true });
    await advance(at - Date.now());
    run(`applyDailyHistory(${JSON.stringify([
      { date: '2026-03-06', open: 10, high: 11, low: 9, close: 10 },
      { date: '2026-03-09', open: 10, high: 20, low: 1, close: 15 },
    ])})`);
    assert.deepEqual(JSON.parse(run('JSON.stringify(prevDay)')), { h: 11, l: 9, c: 10 }, "today's forming bar is not the prior day");
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

// ---------- 9. the simulator owns the keyboard ----------

test('shortcuts stay off while the simulator is open; Esc still closes it', async () => {
  const { run, elements, dispatch } = await app();
  run('initShortcuts()');
  const key = k => dispatch('keydown', { key: k, target: { tagName: 'BODY' }, preventDefault() {} });
  const help = elements.get('kbdHelp');
  const before = help.style.display;
  run("simState = { label: 'x' }");
  key('?'); key('v'); key('s');
  assert.equal(help.style.display, before);
  assert.equal(run('positionsView'), false);
  key('Escape');
  assert.equal(run('simState'), null);
  key('?');
  assert.notEqual(help.style.display, before);
});

// ---------- 10. sheets are modal ----------

test('an open sheet makes the page behind it inert, keeps Tab inside, and hands focus back on close', async () => {
  const { run, elements, element } = await app();
  let focused = null;
  const opener = { focus() { focused = 'opener'; } };
  globalThis.document.activeElement = opener;
  const sheet = elements.get('riskSheet');
  let onKey = null;
  sheet.addEventListener = (type, fn) => { if (type === 'keydown') onKey = fn; };
  const a = { getClientRects: () => [1], focus() { globalThis.document.activeElement = a; } };
  const b = { getClientRects: () => [1], focus() { globalThis.document.activeElement = b; } };
  const hidden = { getClientRects: () => [], focus() {} };
  sheet.querySelectorAll = () => [a, b, hidden];
  run("openSheet('risk')");
  for (const id of run('SHEET_BACKGROUND')) assert.equal(element(id).inert, true, id);
  assert.ok(!sheet.inert);
  assert.ok(!elements.get('errorBox').inert, 'toasts stay readable');
  const tab = shiftKey => { const e = { key: 'Tab', shiftKey, currentTarget: sheet, prevented: false, preventDefault() { this.prevented = true; } }; onKey(e); return e; };
  globalThis.document.activeElement = b;
  assert.ok(tab(false).prevented);
  assert.equal(globalThis.document.activeElement, a, 'Tab past the last control wraps to the first');
  assert.ok(tab(true).prevented);
  assert.equal(globalThis.document.activeElement, b, 'Shift+Tab before the first wraps to the last');
  run('closeSheet()');
  for (const id of run('SHEET_BACKGROUND')) assert.equal(element(id).inert, false, id);
  assert.equal(focused, 'opener');
});
