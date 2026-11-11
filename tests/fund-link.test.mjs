// Run with: node --test
// Fund link: a leveraged fund's position priced off its underlying (TQQQ off QQQ) on the position chart, its forms and the close ticket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
const near = (a, b, tol = 0.011) => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b}`);

const connected = () => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }])],
  ['schwab_account', 'HASH1'],
  ['tradier_key', 'tk'],
]);

// 100 TQQQ at $50, now $60; QQQ at $500; a target to sell 50 at $66
const ACCOUNT = { securitiesAccount: { currentBalances: { liquidationValue: 100000, cashBalance: 25000 }, positions: [
  { longQuantity: 100, shortQuantity: 0, averagePrice: 50, averageLongPrice: 50, marketValue: 6000, instrument: { assetType: 'EQUITY', symbol: 'TQQQ' } },
  { longQuantity: 100, shortQuantity: 0, averagePrice: 40, averageLongPrice: 40, marketValue: 4100, instrument: { assetType: 'EQUITY', symbol: 'HOOD' } },
] } };
const leg = (instruction, quantity, symbol) => ({ instruction, quantity, instrument: { symbol, assetType: 'EQUITY' } });
const ORDERS = [{ orderId: 201, orderType: 'LIMIT', status: 'WORKING', orderStrategyType: 'SINGLE', price: 66, quantity: 50, orderLegCollection: [leg('SELL', 50, 'TQQQ')] }];
const QUOTES = { TQQQ: 60, QQQ: 500, HOOD: 41 };
const bars = (lo, hi) => Array.from({ length: 260 }, (_, i) => ({ date: `2026-${String(1 + Math.floor(i / 22)).padStart(2, '0')}-${String(1 + i % 22).padStart(2, '0')}`, open: lo, high: hi, low: lo, close: (lo + hi) / 2 }));

function network() {
  const tradier = [];
  const fetch = async url => {
    if (url.startsWith(PROXY)) {
      const path = url.slice(PROXY.length);
      return path.includes('/orders?') ? json(ORDERS) : path.endsWith('?fields=positions') ? json(ACCOUNT) : json({}, 404);
    }
    tradier.push(url);
    if (url.includes('/markets/quotes')) {
      const syms = decodeURIComponent(url.split('symbols=')[1].split('&')[0]).split(',');
      const quote = syms.filter(s => QUOTES[s]).map(s => ({ symbol: s, last: QUOTES[s], bid: QUOTES[s] - 0.01, ask: QUOTES[s] + 0.01 }));
      return json({ quotes: { quote } });
    }
    if (url.includes('/markets/history')) return json({ history: { day: url.includes('symbol=QQQ') ? bars(490, 505) : bars(55, 62) } });
    if (url.includes('/markets/timesales')) return json({}, 400);
    throw new Error('Unexpected request ' + url);
  };
  return { fetch, tradier };
}

function fakeCanvas(el) {
  const on = {};
  Object.assign(el, {
    style: el.style || {}, clientWidth: 0,
    addEventListener: (type, fn) => { (on[type] ||= []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 458, height: 260, right: 458, bottom: 260 }),
  });
  return (type, e) => { e = { button: 0, preventDefault() {}, stopImmediatePropagation() {}, ...e }; for (const fn of on[type] || []) fn(e); return e; };
}

async function fundApp() {
  const net = network();
  const h = await app({ fetch: net.fetch, storage: connected() });
  h.elements.get('apiKey').value = 'tk';
  const canvas = fakeCanvas(h.elements.get('posChartD'));
  fakeCanvas(h.elements.get('posChart5'));
  globalThis.window.addEventListener = () => {};
  h.run('initPositionChartEvents()');
  h.run("setView('positions')");
  await settle();
  return { ...h, canvas, tradier: net.tradier };
}

test('core: a fund\'s price off its underlying within today, and back', async () => {
  const { run } = await app();
  near(run('fundPriceAt(505, 3, 60, 500)'), 61.8, 1e-9);
  near(run('fundPriceAt(505, -3, 20, 500)'), 19.4, 1e-9);
  near(run('underPriceAt(61.8, 3, 60, 500)'), 505, 1e-9);
  near(run('underPriceAt(19.4, -3, 20, 500)'), 505, 1e-9);
  assert.equal(run('fundPriceAt(700, -3, 20, 500)'), 0, 'an inverse fund past a 33% move has no price');
  assert.equal(run('fundPriceAt(505, 3, 0, 500)'), 0);
});

test('a leveraged fund\'s chart switches to its underlying: lines where QQQ puts TQQQ, a pick there is TQQQ\'s price', async () => {
  const { run, elements, canvas, tradier } = await fundApp();
  run("togglePositionChart('HOOD')");
  await settle();
  assert.equal(elements.get('posChartOn').style.display, 'none', 'a plain stock has no switch');
  assert.equal(elements.get('posTargetUnderField').style.display, 'none');
  run("togglePositionChart('TQQQ')");
  await settle();
  assert.equal(elements.get('posChartOn').style.display, '');
  assert.match(elements.get('posChartOn').innerHTML, /data-arg="fund"[^>]*>TQQQ<[\s\S]*data-arg="under"[^>]*>QQQ</);
  assert.equal(elements.get('posTargetUnderLabel').textContent, 'When QQQ is at');
  assert.match(elements.get('posUnderNote').textContent, /From TQQQ \$60\.00 and QQQ \$500\.00 now, at 3×/);

  // typing QQQ's price fills TQQQ's
  run("posUnderChanged('target', '505')");
  near(run('posChart.price'), 61.8);
  assert.equal(elements.get('posTargetPrice').value, '61.80');
  // and a TQQQ price shows its QQQ level
  run("document.getElementById('posTargetPrice').value = '63.6'; posTargetChanged()");
  assert.equal(elements.get('posTargetUnder').value, '510.00');

  run("setPosChartOn('under')");
  await settle();
  assert.ok(tradier.some(u => u.includes('/markets/history') && u.includes('symbol=QQQ')), "QQQ's own bars");
  assert.equal(run('posChart.on'), 'under');
  assert.match(elements.get('posChartTapHint').textContent, /QQQ's chart .*as TQQQ's price then/);

  // a click on QQQ's chart at 503 sets TQQQ's target at what QQQ 503 puts it at
  run('posChart.price = null');
  const g = run(`(() => { const row = positions.rows.find(r => r.symbol === 'TQQQ');
    return candleGeom(posChart.daily.bars, posChart.daily.view, 458, [...positionLevels(row).map(l => underPriceFor(row, l.price)), 0, 0, 0]); })()`);
  canvas('click', { clientX: g.x(100), clientY: g.y(503) });
  near(run('posChart.price'), run('priceTick(fundPriceAt(503, 3, 60, 500))'), 0.05);

  // back on TQQQ: its own bars, kept from before
  run("setPosChartOn('fund')");
  assert.equal(run('posChart.on'), 'fund');
  assert.ok(run('posChart.daily.bars[0].close') < 100, "TQQQ's bars again");
});

test('the close ticket takes a limit off the underlying', async () => {
  const { run, elements } = await fundApp();
  await run("openPositionTrade('TQQQ', 'close')");
  run("setCloseType('LIMIT')");
  run('fundAnchor(positions.rows.find(r => r.symbol === "TQQQ"))');
  await settle();
  run("setCloseType('MARKET'); setCloseType('LIMIT')"); // redraw with the read in
  assert.match(elements.get('posTradeBody').innerHTML, /When QQQ is at/);
  run("setCloseUnder('505')");
  near(run('posTicket.close.price'), 61.8);
  assert.equal(run('posTicket.close.r'), null, 'a price off QQQ is a price');

  // a plain stock's ticket has no such box
  run('closeSheet()');
  await run("openPositionTrade('HOOD', 'close')");
  run("setCloseType('LIMIT')");
  assert.doesNotMatch(elements.get('posTradeBody').innerHTML, /When QQQ is at|posCloseUnder/);
});
