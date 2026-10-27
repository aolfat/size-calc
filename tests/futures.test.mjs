// Run with: node --test
// Live futures sizing: Schwab's futures quote through the worker's market data relay, the entry and stop it fills,
// typed prices that hold, and Live on the futures ticket.
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
    quote: { lastPrice: 6012.25, bidPrice: 6012, askPrice: 6012.25, highPrice: 6020.5, lowPrice: 5995, closePrice: 5997.75, tick: 0.25, tickAmount: 1.25, tradeTime: Date.UTC(2026, 9, 27, 14, 31, 5), ...quote },
    reference: { product: '/MES', futureActiveSymbol: '/MESZ26', description: 'Micro E-mini S&P 500 Index Futures,Dec-2026,ETH' },
    ...extra,
  },
});

async function ticket({ answer = () => json(mes()), storage = connected() } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.Authorization });
    if (url.startsWith(PROXY + '/marketdata/v1/quotes')) return answer(new URL(url).searchParams.get('symbols'));
    if (url.startsWith(PROXY)) return json({}, 404);
    throw new Error('Unexpected request ' + url);
  };
  const h = await app({ fetch, storage });
  h.run("document.getElementById('riskDollar').value = '500'; initFutures();");
  return { ...h, calls };
}

test('the quote: the active contract, its prices, the change from the close, and the feed', async () => {
  const { run } = await app();
  const q = run(`parseFuturesQuote(${JSON.stringify(mes())}, 'MES')`);
  assert.equal(q.contract, '/MESZ26');
  assert.deepEqual([q.last, q.bid, q.ask, q.low, q.high], [6012.25, 6012, 6012.25, 5995, 6020.5]);
  assert.equal(q.change, 14.5);
  assert.equal(q.changePct.toFixed(2), '0.24');
  assert.equal(q.realtime, true);
  assert.equal(q.specMismatch, null, 'Schwab agrees with the ticket: 0.25 × $1.25');
  assert.equal(run(`futuresEntryFrom(${JSON.stringify(q)}, 'long')`), 6012.25, 'a long fills at the ask');
  assert.equal(run(`futuresEntryFrom(${JSON.stringify(q)}, 'short')`), 6012, 'a short at the bid');
  assert.equal(run(`futuresStopFrom(${JSON.stringify(q)}, 'long')`), 5995);
  assert.equal(run(`futuresStopFrom(${JSON.stringify(q)}, 'short')`), 6020.5);
});

test('the quote: another root, no price, a crossed market, a delayed feed and a tick Schwab disagrees with', async () => {
  const { run } = await app();
  const parse = (body, root = 'MES') => run(`parseFuturesQuote(${JSON.stringify(body)}, '${root}')`);
  assert.equal(parse(mes(), 'ES'), null, "the /MES answer is never /ES's");
  assert.equal(parse({ '/MES': { ...mes()['/MES'], reference: { futureActiveSymbol: '/ESZ26' } } }), null, 'a contract of another root');
  assert.equal(parse({ errors: { invalidSymbols: ['/MES'] } }), null);
  assert.equal(parse(mes({ lastPrice: 0, mark: 0, bidPrice: 0, askPrice: 0 })), null, 'zero is no price');
  const crossed = parse(mes({ bidPrice: 6013, askPrice: 6012 }));
  assert.deepEqual([crossed.bid, crossed.ask, crossed.last], [null, null, 6012.25], 'a crossed market is no market; the last stays');
  assert.equal(run(`futuresEntryFrom(${JSON.stringify(crossed)}, 'long')`), 6012.25, 'with no ask the entry is the last');
  assert.equal(parse(mes({}, { realtime: false })).realtime, false);
  assert.deepEqual({ ...parse(mes({ tickAmount: 12.5 })).specMismatch }, { tick: 0.25, tickAmount: 12.5 });
  assert.equal(parse({ '/MES': { ...mes()['/MES'], reference: { futureActiveSymbol: '' } } }).contract, '/MES', 'no active contract named: the root');
  assert.equal(run('onTick(6012.3, 0.25)'), 6012.25);
  assert.equal(run('onTick(71.2349999, 0.01)'), 71.23);
  assert.equal(run('onTick(0.1 + 0.2, 0.1)'), 0.3, 'no float dust');
});

test('opening Futures reads the quote through the worker and sizes off the ask and the low of day', async () => {
  const { run, elements, calls } = await ticket();
  await run("setMode('futures')");
  await settle();
  const read = calls.find(c => c.url.includes('/marketdata/v1/quotes'));
  assert.equal(read.url, `${PROXY}/marketdata/v1/quotes?symbols=%2FMES&fields=quote%2Creference`);
  assert.equal(read.auth, 'Bearer acc-1');
  assert.equal(elements.get('futuresEntry').value, '6012.25');
  assert.equal(elements.get('futuresStop').value, '5995');
  // 69 ticks × $1.25 = $86.25 a contract; $500 buys 5
  assert.match(elements.get('futuresStats').innerHTML, /value="5"/);
  assert.match(elements.get('futuresStats').innerHTML, /69 ticks × \$1\.25/);
  const box = elements.get('futuresQuote').innerHTML;
  assert.match(box, /\/MESZ26/);
  assert.match(box, /6,012\.25/);
  assert.match(box, /\+14\.5 \(\+0\.24%\)/);
  assert.match(box, /Real-time/);
  assert.match(box, /LOD 5,995/);
  assert.match(box, /HOD 6,020\.5/);
  assert.match(box, /10:31:05 AM ET/);
  assert.equal(elements.get('futuresFeed').textContent, 'Entry: the ask · Stop: low of day (LOD) · type to hold a price');
  assert.equal(elements.get('futuresRefresh').disabled, false);
  assert.equal(elements.get('futuresLiveBtn').disabled, false);

  run("setFuturesDirection('short')");
  assert.equal(elements.get('futuresEntry').value, '6012', 'a short enters at the bid');
  assert.equal(elements.get('futuresStop').value, '6020.5', 'with the stop at the high of day');
  assert.equal(elements.get('futuresFeed').textContent, 'Entry: the bid · Stop: high of day (HOD) · type to hold a price');

  run("copiedText = ''; copyPlainText = text => { copiedText = text; }; copyFutures();");
  // 34 ticks × $1.25 = $42.50 a contract; $500 shorts 11
  assert.match(run('copiedText'), /^Short 11 \/MESZ26 contracts @ 6,012 · stop 6,020\.5 · 34 ticks/, 'the copy names the month');
});

test('a typed entry or stop holds through refreshes, and clearing it follows the market again', async () => {
  let last = 6012.25;
  const { run, elements } = await ticket({ answer: () => json(mes({ askPrice: last, lastPrice: last })) });
  await run("setMode('futures')");
  await settle();
  elements.get('futuresStop').value = '6000';
  run("futuresPriceTyped(document.getElementById('futuresStop'), 'stop')");
  last = 6015.5;
  await run('refreshFuturesQuote()');
  assert.equal(elements.get('futuresEntry').value, '6015.5', 'the untyped entry follows');
  assert.equal(elements.get('futuresStop').value, '6000', 'the typed stop holds');
  assert.equal(elements.get('futuresFeed').textContent, 'Entry: the ask · Stop: typed · clear a box to follow the market');

  elements.get('futuresEntry').value = '6010';
  run("futuresPriceTyped(document.getElementById('futuresEntry'), 'entry')");
  last = 6018;
  await run('refreshFuturesQuote()');
  assert.equal(elements.get('futuresEntry').value, '6010');

  elements.get('futuresEntry').value = '';
  run("futuresPriceTyped(document.getElementById('futuresEntry'), 'entry')");
  assert.equal(elements.get('futuresEntry').value, '6018', 'cleared, it takes the market right away');
});

test('changing the contract drops the old quote, and an answer for the old one never lands', async () => {
  let release;
  const slow = new Promise(r => { release = r; });
  const { run, elements, calls } = await ticket({
    answer: async symbol => symbol === '/MES' ? (await slow, json(mes())) : json({
      '/MNQ': { symbol: '/MNQ', realtime: true, quote: { lastPrice: 21000.5, bidPrice: 21000.25, askPrice: 21000.5, highPrice: 21100, lowPrice: 20950 }, reference: { futureActiveSymbol: '/MNQZ26' } },
    }),
  });
  run("setMode('futures')");
  await settle();
  elements.get('futuresContract').value = 'MNQ';
  await run('futuresContractChanged()');
  release();
  await settle();
  assert.deepEqual(calls.filter(c => c.url.includes('quotes')).map(c => new URL(c.url).searchParams.get('symbols')), ['/MES', '/MNQ']);
  assert.match(elements.get('futuresQuote').innerHTML, /\/MNQZ26/);
  assert.doesNotMatch(elements.get('futuresQuote').innerHTML, /MES/);
  assert.equal(elements.get('futuresEntry').value, '21000.5');
  assert.equal(elements.get('futuresStop').value, '20950');

  elements.get('futuresContract').value = 'custom';
  await run('futuresContractChanged()');
  assert.equal(elements.get('futuresQuote').innerHTML, '');
  assert.equal(elements.get('futuresFeed').textContent, 'Custom contract: typed prices only.');
  assert.equal(elements.get('futuresEntry').value, '', 'no live price fills a custom contract');
  assert.equal(elements.get('futuresLiveBtn').disabled, true);
});

test('a worker without the relay, or a Schwab app without market data, says what to fix and keeps the last price', async () => {
  let status = 200;
  const { run, elements } = await ticket({ answer: () => status === 200 ? json(mes()) : json({ message: 'nope' }, status) });
  await run("setMode('futures')");
  await settle();
  status = 404;
  await run('refreshFuturesQuote()');
  assert.match(elements.get('futuresQuote').innerHTML, /Your Schwab worker can&#39;t read quotes yet\. Redeploy it/);
  assert.match(elements.get('futuresQuote').innerHTML, /\/MESZ26/, 'the last good quote stays');
  status = 403;
  await run('refreshFuturesQuote()');
  assert.match(elements.get('futuresQuote').innerHTML, /Check that your Schwab app has Market Data Production/);
  status = 200;
  await run('refreshFuturesQuote()');
  assert.doesNotMatch(elements.get('futuresQuote').innerHTML, /futures-quote-error/);
});

test('a delayed feed or a different tick from Schwab is said on the ticket', async () => {
  const { run, elements } = await ticket({ answer: () => json(mes({ tickAmount: 12.5 }, { realtime: false })) });
  await run("setMode('futures')");
  await settle();
  const box = elements.get('futuresQuote').innerHTML;
  assert.match(box, /Delayed/);
  assert.match(box, /Schwab sent a delayed quote/);
  assert.match(box, /Schwab's tick for \/MES is 0\.25 × \$12\.50, not this ticket's/);
});

test('without a Schwab login nothing is read, typed prices work, and Live says to log in', async () => {
  const { run, elements, calls } = await ticket({ storage: new Map() });
  await run("setMode('futures')");
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(elements.get('futuresFeed').textContent, 'Log in to Schwab in Settings for live prices. Typed prices work without it.');
  assert.equal(elements.get('futuresLiveBtn').disabled, true);
  run('toggleLive()');
  assert.equal(elements.get('errorBox').textContent, 'Log in to Schwab in Settings for live futures prices.');
  elements.get('futuresEntry').value = '6000';
  elements.get('futuresStop').value = '5995';
  run("futuresPriceTyped(document.getElementById('futuresEntry'), 'entry')");
  assert.match(elements.get('futuresStats').innerHTML, /value="20"/);
});

test('Live on the futures ticket polls the quote, paints both buttons, and ends when you switch to shares', async () => {
  let n = 0;
  const { run, elements, calls } = await ticket({ answer: () => json(mes({ askPrice: 6012.25 + 0.25 * n++ })) });
  await run("setMode('futures')");
  await settle();
  run('toggleLive()');
  await settle();
  assert.match(elements.get('futuresLiveBtn').innerHTML, /Live 1:00 · tap: 5m/);
  assert.equal(elements.get('futuresLiveBtn').className, 'btn live-on');
  assert.equal(elements.get('liveBtn').className, 'btn live-on');
  const before = calls.length;
  await run('livePoll()');
  assert.equal(calls.length, before + 1, 'each tick is one quote read');
  assert.equal(elements.get('futuresEntry').value, '6012.75');
  await run("setMode('shares')");
  assert.equal(elements.get('futuresLiveBtn').innerHTML, '⚡ Live');
  assert.equal(run('liveInterval'), null);
});

test('the worker relays market data reads and nothing else there', async () => {
  const env = { SCHWAB_APP_KEY: 'k', SCHWAB_APP_SECRET: 's', SCHWAB_CALLBACK_URL: 'https://app.example/', ALLOWED_ORIGINS: 'https://app.example' };
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url, method: init.method, auth: init.headers.Authorization }); return json(mes()); };
  try {
    const call = (path, method = 'GET') => worker.fetch(new Request('https://w.example' + path, { method, headers: { Origin: 'https://app.example', Authorization: 'Bearer t1' }, ...(method === 'POST' ? { body: '{}' } : {}) }), env);
    const ok = await call('/marketdata/v1/quotes?symbols=%2FMES&fields=quote%2Creference');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://app.example');
    assert.deepEqual(seen, [{ url: 'https://api.schwabapi.com/marketdata/v1/quotes?symbols=%2FMES&fields=quote%2Creference', method: 'GET', auth: 'Bearer t1' }]);
    assert.equal((await call('/marketdata/v1/quotes', 'POST')).status, 404, 'market data is read only');
    assert.equal((await call('/marketdata/v2/quotes')).status, 404);
    assert.equal(seen.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
