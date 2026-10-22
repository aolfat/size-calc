// Run with: node --test
// Position chart: a stock position's daily chart with its cost, stops and targets, and the profit-target form that feeds the review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

const connected = (extra = []) => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }, { hash: 'HASH2', last4: '4321' }])],
  ['schwab_account', 'HASH1'],
  ...extra,
]);

const OPT = 'HOOD  261218C00050000';
const ACCOUNT = { securitiesAccount: { currentBalances: { liquidationValue: 100000, cashBalance: 25000 }, positions: [
  { longQuantity: 300, shortQuantity: 0, averagePrice: 38.2, marketValue: 300 * 41.1, instrument: { assetType: 'EQUITY', symbol: 'HOOD' } },
  { longQuantity: 2, shortQuantity: 0, averagePrice: 2.5, marketValue: 600, instrument: { assetType: 'OPTION', symbol: OPT, underlyingSymbol: 'HOOD' } },
  { longQuantity: 0, shortQuantity: 40, averagePrice: 262, marketValue: -40 * 255.3, instrument: { assetType: 'EQUITY', symbol: 'TSLA' } },
  { longQuantity: 500, shortQuantity: 0, averagePrice: 1, marketValue: 500, instrument: { assetType: 'CASH_EQUIVALENT', symbol: 'SWVXX' } },
] } };
const leg = (instruction, quantity, symbol) => ({ instruction, quantity, instrument: { symbol, assetType: 'EQUITY' } });
const ORDERS = [
  { orderId: 101, orderType: 'STOP', status: 'WORKING', orderStrategyType: 'SINGLE', stopPrice: 35.5, quantity: 200, orderLegCollection: [leg('SELL', 200, 'HOOD')] },
  { orderId: 103, orderType: 'LIMIT', status: 'WORKING', orderStrategyType: 'SINGLE', price: 45, quantity: 100, orderLegCollection: [leg('SELL', 100, 'HOOD')] },
  { orderId: 104, orderType: 'STOP', status: 'WORKING', orderStrategyType: 'SINGLE', stopPrice: 2, quantity: 2, orderLegCollection: [{ ...leg('SELL_TO_CLOSE', 2, OPT), instrument: { symbol: OPT, assetType: 'OPTION' } }] },
];
// 260 sessions between 39 and 44, the last one reaching 46: with the position's lines the scale runs 35.5 to 46 (plus 5%)
const BARS = Array.from({ length: 260 }, (_, i) => ({ date: `2026-${String(1 + Math.floor(i / 22)).padStart(2, '0')}-${String(1 + i % 22).padStart(2, '0')}`,
  open: 40, high: i === 259 ? 46 : 44, low: 39, close: 43 }));

// the option's 5-minute bars: three sessions of 10 trades each (a thin contract), around $3, the last bar reaching $3.60
const OPT_BARS = ['2026-10-08', '2026-10-09', '2026-10-12'].flatMap((day, d) => Array.from({ length: 10 }, (_, i) => {
  const mins = 9 * 60 + 30 + i * 5, last = d === 2 && i === 9;
  return { time: `${day}T${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`, timestamp: 0, open: 3, high: last ? 3.6 : 3.2, low: 2.8, close: 3.1, volume: 5 };
}));

// Schwab answers from the fixtures; Tradier answers the daily history and the option's timesales, counted
function network({ bars = BARS } = {}) {
  const tradier = [];
  const fetch = async (url) => {
    if (url.startsWith(PROXY)) {
      const path = url.slice(PROXY.length);
      return path.includes('/orders?') ? json(ORDERS) : path.endsWith('?fields=positions') ? json(ACCOUNT) : json({}, 404);
    }
    if (url.includes('/markets/history')) { tradier.push(url); return json({ history: bars.length ? { day: bars } : null }); }
    if (url.includes('/markets/timesales')) { tradier.push(url); return json({ series: { data: OPT_BARS } }); }
    throw new Error('Unexpected request ' + url);
  };
  return { fetch, tradier };
}

const event = e => ({ button: 0, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {}, ...e });
// the chart canvas: a 458px box (400px of plot between the gutters), 260 tall, listeners recorded
function fakeCanvas(el) {
  const on = {};
  Object.assign(el, {
    style: el.style || {}, clientWidth: 0,
    addEventListener: (type, fn) => { (on[type] ||= []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 458, height: 260, right: 458, bottom: 260 }),
  });
  return (type, e) => { e = event(e); for (const fn of on[type] || []) fn(e); return e; };
}

async function chartApp({ key = true, ...opts } = {}) {
  const net = network(opts);
  const h = await app({ fetch: net.fetch, storage: connected(key ? [['tradier_key', 'tk']] : []) });
  if (key) h.elements.get('apiKey').value = 'tk';
  const canvas = fakeCanvas(h.elements.get('posChart'));
  globalThis.window.addEventListener = () => {};
  h.run('initPositionChartEvents()');
  h.run("setView('positions')");
  await settle();
  return { ...h, canvas, tradier: net.tradier };
}

const tableRow = (elements, symbol) => elements.get('positionsSection').innerHTML.split('<tr>').find(r => r.includes(`<b>${symbol}`)) || '';

test('stocks and options get a Chart button; cash does not', async () => {
  const { elements } = await chartApp();
  assert.match(tableRow(elements, 'HOOD'), /data-action="togglePositionChart" data-arg="HOOD"/);
  assert.match(tableRow(elements, 'TSLA'), /data-action="togglePositionChart" data-arg="TSLA"/);
  assert.match(tableRow(elements, 'HOOD 12/18/26'), new RegExp(`data-action="togglePositionChart" data-arg="${OPT}"`));
  assert.match(tableRow(elements, 'HOOD 12/18/26'), /data-action="simPosition"/, 'Simulate stays beside it');
  assert.doesNotMatch(tableRow(elements, 'SWVXX'), /togglePositionChart/);
});

test('Chart opens the position\'s daily next to the table, and tapping it again closes it', async () => {
  const { run, elements, tradier } = await chartApp();
  assert.equal(elements.get('posChartSection').style.display, 'none');
  run("actions.togglePositionChart({ dataset: { arg: 'HOOD' } })");
  await settle();
  assert.equal(elements.get('posChartSection').style.display, '');
  assert.ok(elements.get('positionsSplit').classList.contains('open'), 'beside the table on the desktop shell');
  assert.match(tableRow(elements, 'HOOD'), /class="pos-act active" aria-pressed="true" data-action="togglePositionChart"/);
  assert.equal(tradier.length, 1);
  assert.match(tradier[0], /symbol=HOOD&interval=daily/);
  assert.equal(run('posChart.bars.length'), 260);
  assert.equal(elements.get('posChartPlot').style.display, '');
  assert.equal(elements.get('posChartStatus').textContent, '');
  assert.equal(elements.get('posChartTitle').textContent, 'HOOD');
  assert.equal(elements.get('posChartMeta').textContent, 'Long 300 shares · avg $38.20 · now $41.10');
  assert.equal(elements.get('posTargetQtyLabel').textContent, 'Shares to sell');
  assert.match(elements.get('posTargetSummary').innerHTML, /Tap the chart above the price for a target, then pick how much to sell/);
  assert.equal(elements.get('posTargetReview').disabled, true);

  run("togglePositionChart('HOOD')");
  assert.equal(elements.get('posChartSection').style.display, 'none');
  assert.ok(!elements.get('positionsSplit').classList.contains('open'));
  assert.equal(run('posChart'), null);
  assert.match(tableRow(elements, 'HOOD'), /aria-pressed="false" data-action="togglePositionChart"/);
});

test('without a Tradier key the chart says so and the target can still be typed', async () => {
  const { run, elements, tradier } = await chartApp({ key: false });
  run("togglePositionChart('HOOD')");
  await settle();
  assert.equal(tradier.length, 0);
  assert.match(elements.get('posChartStatus').textContent, /The chart needs a Tradier key/);
  assert.equal(elements.get('posChartPlot').style.display, 'none');
  elements.get('posTargetPrice').value = '50';
  elements.get('posTargetQty').value = '100';
  run('posTargetChanged()');
  assert.match(elements.get('posTargetSummary').innerHTML, /Sells 100 of 300 shares at \$50\.00/);
  assert.equal(elements.get('posTargetReview').disabled, false);
  assert.equal(elements.get('posTargetReview').dataset.arg, 'HOOD');
});

test('portion chips take a share of the position, never more than the other targets leave', async () => {
  const { run, elements } = await chartApp();
  run("togglePositionChart('HOOD')");
  await settle();
  const chips = () => elements.get('posTargetPortions').innerHTML;
  assert.match(chips(), /data-arg="0\.25" title="75 shares">¼</);
  assert.match(chips(), /data-arg="0\.3333333333333333" title="100 shares">⅓</);
  assert.match(chips(), /data-arg="0\.5" title="150 shares">½</);
  assert.match(chips(), /data-arg="1" title="200 shares">All</, 'the limit for 100 already holds a third');
  run("actions.setPosTargetPortion({ dataset: { arg: String(1 / 3) } })");
  assert.equal(elements.get('posTargetQty').value, '100');
  assert.match(chips(), /class="filter-btn active" aria-pressed="true" data-action="setPosTargetPortion" data-arg="0\.3333333333333333"/);
  assert.match(elements.get('posTargetSummary').innerHTML, /Tap the chart or type a target price/);
  run("setPosTargetPortion(1)");
  assert.equal(run('posChart.qty'), 200);
});

test('tapping the chart sets the target price, taking a candle\'s exact high when it lands near one', async () => {
  const { run, elements, canvas } = await chartApp();
  run("togglePositionChart('HOOD')");
  await settle();
  const g = run('candleGeom(posChart.bars, posChart.view, 458, positionLevels(positions.rows.find(r => r.symbol === "HOOD")).map(l => l.price))');
  const lastX = g.x(259);
  canvas('mousedown', { clientX: lastX });
  canvas('click', { clientX: lastX, clientY: g.y(46) + 4 });
  assert.equal(run('posChart.price'), 46, 'the last session\'s high');
  assert.equal(elements.get('posTargetPrice').value, '46.00');
  canvas('click', { clientX: lastX, clientY: g.y(45.3) });
  assert.ok(Math.abs(run('posChart.price') - 45.3) <= 0.01, 'off the wick: the price under the pointer, on the tick');
  assert.equal(run('posChart.price'), run('priceTick(posChart.price)'));
  canvas('click', { clientX: lastX, clientY: 250 });
  assert.ok(Math.abs(run('posChart.price') - 45.3) <= 0.01, 'the date axis is not a price');

  run('setPosTargetPortion(0.5)');
  const sum = elements.get('posTargetSummary').innerHTML;
  assert.match(sum, /<strong>Sells 150 of 300 shares at \$45\.\d\d<\/strong>/);
  assert.match(sum, /over cost · 2\.\dR/);
  assert.match(sum, /Paired with a stop at \$35\.50 for the same shares: one cancels the other\./);
  assert.equal(elements.get('posTargetReview').disabled, false);
});

test('hover shows the price and its distance from now, snapped like a tap', async () => {
  const { run, elements, canvas } = await chartApp();
  run("togglePositionChart('HOOD')");
  await settle();
  const g = run('candleGeom(posChart.bars, posChart.view, 458, positionLevels(positions.rows.find(r => r.symbol === "HOOD")).map(l => l.price))');
  elements.get('posChart').clientWidth = 458;
  elements.get('posChart').getContext = () => new Proxy({ measureText: () => ({ width: 40 }) }, { get: (o, k) => k in o ? o[k] : () => {}, set: (o, k, v) => { o[k] = v; return true; } });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  canvas('mousemove', { clientX: g.x(259), clientY: g.y(46) + 3 });
  assert.equal(run('posChart.hover'), 259);
  assert.ok(Math.abs(run('posChart.hoverY') - g.y(46)) < 1e-9, 'the crosshair sits on the high');
  assert.match(elements.get('posChartOhlc').innerHTML, /^\$46\.00 \(\+11\.9% from now\)/);
  canvas('mouseleave', {});
  assert.equal(run('posChart.hover'), -1);
  assert.equal(elements.get('posChartOhlc').textContent, '');
  delete globalThis.getComputedStyle;
});

test('the form says what blocks a target before review', async () => {
  const { run, elements } = await chartApp();
  run("togglePositionChart('HOOD')");
  await settle();
  elements.get('posTargetPrice').value = '41';
  elements.get('posTargetQty').value = '100';
  run('posTargetChanged()');
  assert.match(elements.get('posTargetSummary').innerHTML, /The target \$41\.00 is at or below the price \$41\.10/);
  assert.ok(elements.get('posTargetSummary').className.includes('warn'));
  assert.equal(elements.get('posTargetReview').disabled, true);
  elements.get('posTargetPrice').value = '50';
  elements.get('posTargetQty').value = '250';
  run('posTargetChanged()');
  assert.match(elements.get('posTargetSummary').innerHTML, /Your other targets hold 100 of the 300 shares, so this one can take up to 200/);
});

test('a short reads as buying back', async () => {
  const { run, elements } = await chartApp();
  run("togglePositionChart('TSLA')");
  await settle();
  assert.equal(elements.get('posTargetQtyLabel').textContent, 'Shares to buy back');
  assert.match(elements.get('posTargetSummary').innerHTML, /how much to buy back/);
  elements.get('posTargetPrice').value = '240';
  elements.get('posTargetQty').value = '20';
  run('posTargetChanged()');
  assert.match(elements.get('posTargetSummary').innerHTML, /Buys back 20 of 40 shares at \$240\.00/);
  assert.match(elements.get('posTargetSummary').innerHTML, /no stop, so the target goes alone/);
});

test('range chips and Today work on the position chart\'s own view', async () => {
  const { run, elements } = await chartApp();
  run("togglePositionChart('HOOD')");
  await settle();
  run("actions.setPosChartRange({ dataset: { arg: '252' } })");
  assert.deepEqual({ ...run('viewRange(posChart.view, 260)') }, { start: 8, end: 260 });
  assert.equal(run('dailyView.count'), 63, 'the calculator\'s daily is untouched');
  run('posChart.view = panView(posChart.view, 260, 5); drawPositionChart()');
  assert.equal(elements.get('posChartToday').style.display, '');
  run('actions.posChartToday()');
  assert.equal(run('posChart.view.offset'), 0);
  assert.equal(elements.get('posChartToday').style.display, 'none');
});

test('leaving Positions hides the chart; coming back shows it again; switching accounts closes it', async () => {
  const { run, elements } = await chartApp();
  run("togglePositionChart('HOOD')");
  await settle();
  run("setView('calc')");
  assert.equal(elements.get('posChartSection').style.display, 'none');
  run("setView('positions')");
  await settle();
  assert.equal(elements.get('posChartSection').style.display, '');
  run('positionsAccountChanged()');
  await settle();
  assert.equal(run('posChart'), null);
  assert.equal(elements.get('posChartSection').style.display, 'none');
});

test('a position Schwab stops showing leaves the chart up but blocks the review', async () => {
  const { run, elements } = await chartApp();
  run("togglePositionChart('HOOD')");
  await settle();
  run("positions = { ...positions, rows: positions.rows.filter(r => r.symbol !== 'HOOD') }; renderPositions()");
  assert.match(elements.get('posTargetSummary').innerHTML, /Schwab no longer shows a HOOD position/);
  assert.equal(elements.get('posTargetReview').disabled, true);
  assert.equal(elements.get('posChartMeta').textContent, '');
});

test('no daily history says so instead of drawing', async () => {
  const { run, elements } = await chartApp({ bars: [] });
  run("togglePositionChart('HOOD')");
  await settle();
  assert.match(elements.get('posChartStatus').textContent, /Tradier has no daily history for HOOD/);
  assert.equal(elements.get('posChartPlot').style.display, 'none');
});

// ---------- option positions: the contract's own 5-minute chart ----------

test('an option\'s chart is the contract\'s 5-minute bars from Tradier, with session chips and contract wording', async () => {
  const { run, elements, tradier } = await chartApp();
  run(`togglePositionChart('${OPT}')`);
  await settle();
  assert.equal(tradier.length, 1);
  assert.match(decodeURIComponent(tradier[0]), /\/markets\/timesales\?symbol=HOOD261218C00050000&interval=5min&start=\S+ 09:30&end=\S+ 16:00&session_filter=open/);
  assert.equal(run('posChart.bars.length'), 30);
  assert.deepEqual({ ...run('posChart.bars[29]') }, { date: '2026-10-12', time: '10:15', open: 3, high: 3.6, low: 2.8, close: 3.1 });
  assert.equal(elements.get('posChartTitle').textContent, 'HOOD 12/18/26 50C');
  assert.equal(elements.get('posChartMeta').textContent, 'Long 2 contracts · avg $2.50 · now $3.00');
  assert.equal(elements.get('posChartKind').textContent, '5 min');
  assert.equal(elements.get('posTargetQtyLabel').textContent, 'Contracts to sell');
  const chips = () => elements.get('posChartRanges').innerHTML;
  for (const [n, label] of [[1, '1D'], [2, '2D'], [5, '5D'], [10, '10D']]) assert.match(chips(), new RegExp(`data-action="setPosChartRange" data-arg="${n}"[^>]*>${label}<`));
  assert.match(chips(), /class="filter-btn active" data-action="setPosChartRange" data-arg="2"/, 'two sessions to start');
  assert.equal(run('posChart.view.count'), 20, 'the bars of the last two sessions, however many traded');
  run("actions.setPosChartRange({ dataset: { arg: '1' } })");
  assert.equal(run('posChart.view.count'), 10);
  assert.match(chips(), /class="filter-btn active" data-action="setPosChartRange" data-arg="1"/);
  run('setPosChartRange(10)');
  assert.equal(run('posChart.view.count'), 30, 'all there is');

  // a stock's chart keeps the daily chips
  run("togglePositionChart('HOOD')");
  await settle();
  assert.equal(elements.get('posChartKind').textContent, 'Daily');
  assert.match(chips(), /data-arg="63"[^>]*>3M</);
});

test('tapping an option\'s chart sets the target on the option price grid, and the review pairs it with the option\'s stop', async () => {
  const { run, elements, canvas } = await chartApp();
  run(`togglePositionChart('${OPT}')`);
  await settle();
  const g = run(`candleGeom(posChart.bars, posChart.view, 458, positionLevels(positions.rows.find(r => r.symbol === '${OPT}')).map(l => l.price))`);
  canvas('mousedown', { clientX: g.x(29) });
  canvas('click', { clientX: g.x(29), clientY: g.y(3.47) });
  assert.equal(run('posChart.price'), 3.5, '$0.10 steps from $3');
  assert.equal(elements.get('posTargetPrice').value, '3.50');
  run('setPosTargetPortion(0.5)');
  assert.equal(run('posChart.qty'), 1);
  const sum = elements.get('posTargetSummary').innerHTML;
  assert.match(sum, /<strong>Sells 1 of 2 contracts at \$3\.50<\/strong>/);
  assert.match(sum, /\+\$100\.00<\/span> \(\+40\.0%\) over cost/);
  assert.match(sum, /Paired with a stop at \$2\.00 for the same contracts: one cancels the other\./);
  assert.equal(elements.get('posTargetReview').disabled, false);
  assert.equal(elements.get('posTargetReview').dataset.arg, OPT);

  await run(`openPositionTrade('${OPT}', 'target')`);
  await settle();
  const t = run('posTicket');
  assert.equal(t.error, '');
  assert.equal(t.price, 3.5);
  assert.deepEqual(t.steps.map(s => [s.kind, s.orderId ?? null]), [['replace', 104], ['place', null]]);
  const [limit, stop] = t.steps[1].order.childOrderStrategies;
  assert.deepEqual([limit.orderType, limit.price, limit.orderLegCollection[0].instruction, limit.orderLegCollection[0].instrument.assetType], ['LIMIT', 3.5, 'SELL_TO_CLOSE', 'OPTION']);
  assert.equal(stop.stopPrice, 2);
  assert.match(elements.get('posTradeBody').innerHTML, /Schwab won&#39;t take orders to sell to close more than you hold, so the target is paired with a stop for the same contracts/);
  assert.match(elements.get('posTradeBody').innerHTML, /While the target goes in, 1 contract has no stop for a moment/);
});

test('an option\'s hover readout shows the bar\'s time', async () => {
  const { run, elements, canvas } = await chartApp();
  run(`togglePositionChart('${OPT}')`);
  await settle();
  const g = run(`candleGeom(posChart.bars, posChart.view, 458, positionLevels(positions.rows.find(r => r.symbol === '${OPT}')).map(l => l.price))`);
  elements.get('posChart').clientWidth = 458;
  elements.get('posChart').getContext = () => new Proxy({ measureText: () => ({ width: 40 }) }, { get: (o, k) => k in o ? o[k] : () => {}, set: (o, k, v) => { o[k] = v; return true; } });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  canvas('mousemove', { clientX: g.x(29), clientY: g.y(3.3) });
  assert.match(elements.get('posChartOhlc').innerHTML, /\(\+10\.0% from now\) &nbsp; 5m 10\/12 10:15 &nbsp; O 3\.00/);
  delete globalThis.getComputedStyle;
});

test('Avg hides the average cost line and lets the scale fit without it; the choice stays on this device', async () => {
  const { run, elements, storage } = await chartApp();
  run(`togglePositionChart('${OPT}')`);
  await settle();
  const texts = [];
  elements.get('posChart').clientWidth = 458;
  elements.get('posChart').getContext = () => new Proxy({ measureText: () => ({ width: 40 }), fillText: t => texts.push(t) }, { get: (o, k) => k in o ? o[k] : () => {}, set: (o, k, v) => { o[k] = v; return true; } });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  const btn = elements.get('posChartAvgBtn');
  run('drawPositionChart()');
  assert.ok(texts.includes('avg 2.50'), 'shown by default');
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.ok(btn.classList.contains('active'));

  texts.length = 0;
  run('actions.togglePosChartAvg()');
  assert.ok(!texts.includes('avg 2.50'));
  assert.ok(texts.includes('stop 2.00 ×2'), 'the other lines stay');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.ok(!btn.classList.contains('active'));
  assert.equal(storage.get('pos_chart_avg'), '0');
  // a stock's chart hides it too, and the scale fits the bars, not a cost far from them: TSLA's $262 against bars of $39 to $46
  run("togglePositionChart('TSLA')");
  await settle();
  texts.length = 0;
  run('drawPositionChart()');
  assert.ok(!texts.some(t => t.startsWith('avg ')));
  assert.ok(texts.includes('$46.35'), 'top gridline: the $46 high plus 5% of the range');
  run('actions.togglePosChartAvg()');
  assert.ok(texts.includes('avg 262.00'));
  run('actions.togglePosChartAvg()'); // off again: a new visit starts with it hidden
  delete globalThis.getComputedStyle;

  const again = await app({ fetch: async () => json({}), storage });
  assert.equal(again.run('posChartAvg'), false);
});

test('tapping below the price on a long sets the stop instead, and the stop form says what it covers and risks', async () => {
  const { run, elements, canvas } = await chartApp();
  run("togglePositionChart('HOOD')");
  await settle();
  assert.equal(elements.get('posStopSummary').innerHTML, 'Tap the chart below the price, or type a stop.');
  assert.equal(elements.get('posStopReview').disabled, true);
  const g = run('candleGeom(posChart.bars, posChart.view, 458, positionLevels(positions.rows.find(r => r.symbol === "HOOD")).map(l => l.price))');
  canvas('mousedown', { clientX: g.x(259) });
  canvas('click', { clientX: g.x(259), clientY: g.y(39) - 3 });
  assert.equal(run('posChart.stop'), 39, 'the session\'s low');
  assert.equal(run('posChart.price'), null, 'the target is untouched');
  assert.equal(elements.get('posChartStopPrice').value, '39.00');
  const sum = elements.get('posStopSummary').innerHTML;
  assert.match(sum, /<strong>Stop at \$39\.00 for 300 shares<\/strong> · <span class="pos-locked">\+\$240\.00 locked<\/span>/);
  assert.match(sum, /Your limit already closes part of it: the review asks what the stop covers\./);
  assert.equal(elements.get('posStopReview').disabled, false);
  assert.equal(elements.get('posStopReview').dataset.arg, 'HOOD');

  elements.get('posChartStopPrice').value = '37';
  elements.get('riskDollar').value = '300';
  run('posChartStopChanged()');
  const risky = elements.get('posStopSummary').innerHTML;
  assert.match(risky, /<span class="pos-loss">−\$360\.00<\/span> \(0\.36% of acct\) from cost/);
  assert.match(risky, /More than your max loss per trade, \$300\.00\./);
  elements.get('posChartStopPrice').value = '42';
  run('posChartStopChanged()');
  assert.match(elements.get('posStopSummary').innerHTML, /The stop \$42\.00 is at or above the price \$41\.10/);
  assert.equal(elements.get('posStopReview').disabled, true);
});

test('Review stop opens the stop sheet at the chart\'s price, warns past the max loss, and a placed stop clears the form', async () => {
  const { run, elements } = await chartApp();
  run("togglePositionChart('HOOD')");
  await settle();
  elements.get('posChartStopPrice').value = '37';
  elements.get('riskDollar').value = '300';
  run('posChartStopChanged()');
  await run("openPositionTrade('HOOD', 'stop')");
  const body = elements.get('posTradeBody').innerHTML;
  assert.match(body, /id="posStopPrice"[^>]*value="37\.00"/);
  assert.match(body, /At the stop this loses \$360\.00, more than your max loss per trade, \$300\.00\./);
  elements.get('riskDollar').value = '1000';
  run("setPositionStopPrice('37')");
  assert.doesNotMatch(elements.get('posTradeDetail').innerHTML, /max loss/);
  run("positionStopPlaced('HOOD')");
  assert.equal(run('posChart.stop'), null);
  assert.equal(elements.get('posChartStopPrice').value, '');
});

test('a short\'s stop is above the price', async () => {
  const { run, elements } = await chartApp();
  run("togglePositionChart('TSLA')");
  await settle();
  assert.equal(elements.get('posStopSummary').innerHTML, 'Tap the chart above the price, or type a stop.');
  elements.get('posChartStopPrice').value = '266';
  run('posChartStopChanged()');
  assert.match(elements.get('posStopSummary').innerHTML, /Stop at \$266\.00 for 40 shares<\/strong> · <span class="pos-loss">−\$160\.00<\/span>/);
});
