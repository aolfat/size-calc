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
function network({ bars = BARS, fiveFails = false } = {}) {
  const tradier = [];
  const fetch = async (url) => {
    if (url.startsWith(PROXY)) {
      const path = url.slice(PROXY.length);
      return path.includes('/orders?') ? json(ORDERS) : path.endsWith('?fields=positions') ? json(ACCOUNT) : json({}, 404);
    }
    if (url.includes('/markets/history')) { tradier.push(url); return json({ history: bars.length ? { day: bars } : null }); }
    if (url.includes('/markets/timesales')) { tradier.push(url); return fiveFails ? json({}, 400) : json({ series: { data: OPT_BARS } }); }
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
  // canvas: the daily pane, canvas5: the 5-minute pane
  const canvas5 = fakeCanvas(h.elements.get('posChart5')), canvas = fakeCanvas(h.elements.get('posChartD'));
  globalThis.window.addEventListener = () => {};
  h.run('initPositionChartEvents()');
  h.run("setView('positions')");
  await settle();
  return { ...h, canvas, canvas5, tradier: net.tradier };
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

test('Chart opens the position\'s 5-minute and daily charts next to the table, and tapping it again closes it', async () => {
  const { run, elements, tradier } = await chartApp();
  assert.equal(elements.get('posChartSection').style.display, 'none');
  run("actions.togglePositionChart({ dataset: { arg: 'HOOD' } })");
  await settle();
  assert.equal(elements.get('posChartSection').style.display, '');
  assert.ok(elements.get('positionsSplit').classList.contains('open'), 'beside the table on the desktop shell');
  assert.match(tableRow(elements, 'HOOD'), /class="pos-act active" aria-pressed="true" data-action="togglePositionChart"/);
  assert.equal(tradier.length, 2, 'both at once');
  assert.match(decodeURIComponent(tradier[0]), /\/markets\/timesales\?symbol=HOOD&interval=5min/);
  assert.match(tradier[1], /symbol=HOOD&interval=daily/);
  assert.equal(run('posChart.five.bars.length'), 10, 'today\'s session only: the latest of the three');
  assert.equal(run('posChart.daily.bars.length'), 260);
  assert.equal(elements.get('posChartPlot').style.display, '');
  assert.equal(elements.get('posCol5').style.display, '');
  assert.equal(elements.get('posColD').style.display, '');
  assert.equal(elements.get('posChartStatus').textContent, '');
  assert.equal(elements.get('posChartTitle').textContent, 'HOOD');
  assert.equal(elements.get('posChartMeta').textContent, 'Long 300 shares · avg $38.20 · now $41.10');
  assert.equal(elements.get('posTargetQtyLabel').textContent, 'Shares to sell');
  assert.match(elements.get('posTargetSummary').innerHTML, /Tap the chart for a target price, then pick how much to sell/);
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
  assert.match(chips(), /data-arg="0\.1" title="30 shares">10%</);
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

test('a target in R: the chips and the R box set the price from your cost and the nearest stop, and a price reads back in R', async () => {
  const { run, elements } = await chartApp();
  run("togglePositionChart('HOOD')");
  await settle();
  // HOOD: 300 at $38.20, nearest stop $35.50, so 1R = $2.70 a share
  const chips = () => elements.get('posTargetRChips').innerHTML;
  assert.match(chips(), /data-action="setPosTargetR" data-arg="1" title="\$40\.90">1R</);
  assert.match(chips(), /data-arg="5" title="\$51\.70">5R</);
  run("actions.setPosTargetR({ dataset: { arg: '5' } })");
  assert.equal(run('posChart.price'), 51.7);
  assert.equal(elements.get('posTargetPrice').value, '51.70');
  assert.equal(elements.get('posTargetR').value, '5');
  assert.match(chips(), /class="filter-btn active" aria-pressed="true" data-action="setPosTargetR" data-arg="5"/);

  run("actions.setPosTargetPortion({ dataset: { arg: '0.1' } })");
  assert.equal(elements.get('posTargetQty').value, '30', '10% of 300');
  const sum = elements.get('posTargetSummary').innerHTML;
  assert.match(sum, /<strong>Sells 30 of 300 shares at \$51\.70<\/strong> · <span class="pos-locked">\+\$405\.00<\/span> \(\+35\.3%\) over cost · 5\.0R/);
  assert.match(sum, /1R is \$2\.70 a share, from the stop \$35\.50\./);
  assert.equal(elements.get('posTargetReview').disabled, false);

  elements.get('posTargetR').value = '2.5';
  run('actions.posTargetRChanged()');
  assert.equal(elements.get('posTargetPrice').value, '44.95', 'typing R moves the price');
  assert.doesNotMatch(chips(), /active/);
  elements.get('posTargetPrice').value = '46';
  run('posTargetChanged()');
  assert.equal(run('posChart.r'), null, 'a typed price is a price');
  assert.equal(elements.get('posTargetR').value, '2.9', 'and the R box follows it');
});

test('a target in R needs a risk to count from: a short with no stop greys the chips out', async () => {
  const { run, elements } = await chartApp();
  run("togglePositionChart('TSLA')");
  await settle();
  assert.match(elements.get('posTargetRChips').innerHTML, /data-arg="5" title="No stop to count R from\." disabled>5R</);
  elements.get('posTargetR').value = '3';
  run('posTargetRChanged()');
  assert.equal(elements.get('posTargetPrice').value, '');
  assert.match(elements.get('posTargetSummary').innerHTML, /No target in R: No stop to count R from\./);
  assert.equal(elements.get('posTargetReview').disabled, true);
});

test('tapping the chart sets the target price, taking a candle\'s exact high when it lands near one', async () => {
  const { run, elements, canvas } = await chartApp();
  run("togglePositionChart('HOOD')");
  await settle();
  const g = run('candleGeom(posChart.daily.bars, posChart.daily.view, 458, positionLevels(positions.rows.find(r => r.symbol === "HOOD")).map(l => l.price))');
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
  const g = run('candleGeom(posChart.daily.bars, posChart.daily.view, 458, positionLevels(positions.rows.find(r => r.symbol === "HOOD")).map(l => l.price))');
  elements.get('posChartD').clientWidth = 458;
  elements.get('posChartD').getContext = () => new Proxy({ measureText: () => ({ width: 40 }) }, { get: (o, k) => k in o ? o[k] : () => {}, set: (o, k, v) => { o[k] = v; return true; } });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  canvas('mousemove', { clientX: g.x(259), clientY: g.y(46) + 3 });
  assert.equal(run('posChart.daily.hover'), 259);
  assert.ok(Math.abs(run('posChart.daily.hoverY') - g.y(46)) < 1e-9, 'the crosshair sits on the high');
  assert.match(elements.get('posChartOhlc').innerHTML, /^\$46\.00 \(\+11\.9% from now\)/);
  canvas('mouseleave', {});
  assert.equal(run('posChart.daily.hover'), -1);
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

test('the daily\'s range chips and each pane\'s Today work on its own view', async () => {
  const { run, elements } = await chartApp();
  run("togglePositionChart('HOOD')");
  await settle();
  assert.match(elements.get('posChartRangesD').innerHTML, /class="filter-btn active" data-action="setPosChartRange" data-arg="63">3M</);
  run("actions.setPosChartRange({ dataset: { arg: '252' } })");
  assert.deepEqual({ ...run('viewRange(posChart.daily.view, 260)') }, { start: 8, end: 260 });
  assert.equal(run('posChart.five.view.count'), 10, 'the 5-minute pane keeps its session');
  assert.equal(run('dailyView.count'), 63, 'the calculator\'s daily is untouched');
  run('posChart.daily.view = panView(posChart.daily.view, 260, 5); drawPositionChart()');
  assert.equal(elements.get('posChartTodayD').style.display, '');
  assert.equal(elements.get('posChartToday5').style.display, 'none');
  run("actions.posChartToday({ dataset: { arg: 'daily' } })");
  assert.equal(run('posChart.daily.view.offset'), 0);
  assert.equal(elements.get('posChartTodayD').style.display, 'none');
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

test('no daily history says so, and the 5-minute chart takes the card', async () => {
  const { run, elements } = await chartApp({ bars: [] });
  run("togglePositionChart('HOOD')");
  await settle();
  assert.match(elements.get('posChartStatus').textContent, /^Tradier has no daily history for HOOD\.$/);
  assert.equal(elements.get('posChartPlot').style.display, '');
  assert.equal(elements.get('posCol5').style.display, '');
  assert.equal(elements.get('posColD').style.display, 'none');
});

test('5-minute bars Tradier won\'t send say so, and the daily takes the card', async () => {
  const { run, elements } = await chartApp({ fiveFails: true });
  run("togglePositionChart('HOOD')");
  await settle();
  assert.equal(elements.get('posChartStatus').textContent, "Tradier would not send HOOD's 5-minute bars. They need a brokerage-linked key.");
  assert.equal(elements.get('posCol5').style.display, 'none');
  assert.equal(elements.get('posColD').style.display, '');
  assert.equal(run('posChart.daily.bars.length'), 260);
});

test('neither chart: the plot hides and the note says why for each', async () => {
  const { run, elements } = await chartApp({ bars: [], fiveFails: true });
  run("togglePositionChart('HOOD')");
  await settle();
  assert.equal(elements.get('posChartStatus').textContent, "Tradier would not send HOOD's 5-minute bars. They need a brokerage-linked key. Tradier has no daily history for HOOD.");
  assert.equal(elements.get('posChartPlot').style.display, 'none');
});

test('while they load the note says so, and a chart closed meanwhile stays closed', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const net = network();
  const h = await app({ fetch: async url => { if (url.includes('/markets/')) await gate; return net.fetch(url); }, storage: connected([['tradier_key', 'tk']]) });
  h.elements.get('apiKey').value = 'tk';
  h.run("setView('positions')");
  await settle();
  h.run("togglePositionChart('HOOD')");
  assert.equal(h.elements.get('posChartStatus').textContent, 'Loading the HOOD 5-minute chart… Loading the HOOD daily chart…');
  assert.equal(h.elements.get('posChartPlot').style.display, 'none');
  h.run('closePositionChart()');
  release();
  await settle();
  assert.equal(h.run('posChart'), null);
});

// ---------- the 5-minute pane: VWAP, the prior day's levels ----------

test('the 5-minute pane carries volume and its session VWAP, and draws the prior day\'s levels that fit its scale', async () => {
  // daily bars to 10/09 and 10/12, the second inside the 5-minute chart's $2.80 to $3.60
  const days = [{ date: '2026-10-09', open: 3, high: 3.4, low: 2.9, close: 3.05 }, { date: '2026-10-12', open: 3, high: 3.6, low: 2.8, close: 3.1 }];
  const { run, elements } = await chartApp({ bars: days });
  run(`togglePositionChart('${OPT}')`);
  await settle();
  assert.deepEqual({ ...run('posChart.five.bars[9]') }, { date: '2026-10-12', time: '10:15', open: 3, high: 3.6, low: 2.8, close: 3.1, volume: 5 });
  assert.equal(run('posChart.five.vwap.length'), 10);
  assert.ok(Math.abs(run('posChart.five.vwap[0]') - 9.1 / 3) < 1e-9, 'the first bar\'s typical price');
  assert.equal(run('posChart.daily.vwap.length'), 0, 'the daily has none');
  assert.deepEqual({ ...run('priorDay(posChart.five.bars, posChart.daily.bars)') }, { h: 3.4, l: 2.9, c: 3.05 }, 'the session before 10/12, not 10/12 itself');
  assert.equal(run('priorDay([], posChart.daily.bars)'), null);

  const texts = [];
  for (const id of ['posChart5', 'posChartD']) {
    elements.get(id).clientWidth = 458;
    elements.get(id).getContext = () => new Proxy({ measureText: () => ({ width: 40 }), fillText: t => texts.push(id + ':' + t) }, { get: (o, k) => k in o ? o[k] : () => {}, set: (o, k, v) => { o[k] = v; return true; } });
  }
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  run('drawPositionChart()');
  for (const l of ['PDH', 'PDL', 'PDC']) assert.ok(texts.includes('posChart5:' + l), l + ' on the 5-minute pane');
  assert.ok(!texts.some(t => /^posChartD:PD/.test(t)), 'not on the daily');
  assert.ok(texts.includes('posChart5:avg 2.50') && texts.includes('posChartD:avg 2.50'), 'your lines on both');

  // a prior day far from the bars stays off the chart and off its scale
  texts.length = 0;
  run("posChart.daily.bars = [{ date: '2026-10-09', open: 9, high: 9.5, low: 8, close: 9 }, ...posChart.daily.bars.slice(1)]; drawPositionChart()");
  assert.ok(!texts.some(t => /^posChart5:PD/.test(t)));
  assert.ok(!texts.some(t => /^posChart5:\$9/.test(t)), 'the scale ignores it');
  delete globalThis.getComputedStyle;
});

// ---------- option positions: the contract's own charts ----------

test('an option\'s charts are the contract\'s own bars from Tradier, its 5-minute only the latest session it traded, in contract wording', async () => {
  const { run, elements, tradier } = await chartApp();
  run(`togglePositionChart('${OPT}')`);
  await settle();
  assert.equal(tradier.length, 2);
  assert.match(decodeURIComponent(tradier[0]), /\/markets\/timesales\?symbol=HOOD261218C00050000&interval=5min&start=\S+ 09:30&end=\S+ 16:00&session_filter=open/);
  assert.match(tradier[1], /\/markets\/history\?symbol=HOOD261218C00050000&interval=daily/);
  assert.equal(run('posChart.five.bars.length'), 10, 'the 10/12 session, not the two before it');
  assert.ok(run('posChart.five.bars.every(b => b.date === "2026-10-12")'));
  assert.equal(run('posChart.five.view.count'), 10, 'the whole session');
  assert.equal(elements.get('posChartTitle').textContent, 'HOOD 12/18/26 50C');
  assert.equal(elements.get('posChartMeta').textContent, 'Long 2 contracts · avg $2.50 · now $3.00');
  assert.equal(elements.get('posTargetQtyLabel').textContent, 'Contracts to sell');
  assert.equal(elements.get('posChartDay5').textContent, 'Mon 10/12', 'not today, so the caption names the day');
});

test('the 5-minute caption says today, or the day its session is from', async () => {
  const { run } = await chartApp();
  assert.equal(run("sessionWords('2026-10-27', '2026-10-27')"), 'today');
  assert.equal(run("sessionWords('2026-10-23', '2026-10-27')"), 'Fri 10/23');
  assert.equal(run("latestSession([]).length"), 0);
});

test('an option with no daily history says so in its own words', async () => {
  const { run, elements } = await chartApp({ bars: [] });
  run(`togglePositionChart('${OPT}')`);
  await settle();
  assert.match(elements.get('posChartStatus').textContent, /Tradier has no daily history for HOOD 12\/18\/26 50C\./);
});

test('tapping an option\'s chart sets the target on the option price grid, and the review pairs it with the option\'s stop', async () => {
  const { run, elements, canvas5 } = await chartApp();
  run(`togglePositionChart('${OPT}')`);
  await settle();
  const g = run(`candleGeom(posChart.five.bars, posChart.five.view, 458, positionLevels(positions.rows.find(r => r.symbol === '${OPT}')).map(l => l.price))`);
  canvas5('mousedown', { clientX: g.x(9) });
  canvas5('click', { clientX: g.x(9), clientY: g.y(3.47) });
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

test('a 5-minute hover readout shows the bar\'s time and its VWAP', async () => {
  const { run, elements, canvas5 } = await chartApp();
  run(`togglePositionChart('${OPT}')`);
  await settle();
  const g = run(`candleGeom(posChart.five.bars, posChart.five.view, 458, positionLevels(positions.rows.find(r => r.symbol === '${OPT}')).map(l => l.price))`);
  elements.get('posChart5').clientWidth = 458;
  elements.get('posChart5').getContext = () => new Proxy({ measureText: () => ({ width: 40 }) }, { get: (o, k) => k in o ? o[k] : () => {}, set: (o, k, v) => { o[k] = v; return true; } });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  canvas5('mousemove', { clientX: g.x(9), clientY: g.y(3.3) });
  assert.match(elements.get('posChartOhlc').innerHTML, /\(\+10\.0% from now\) · 1\.6R &nbsp; 5m 10\/12 10:15 &nbsp; O 3\.00/);
  // the last session's typical prices: nine bars of (3.2 + 2.8 + 3.1) / 3 and one of (3.6 + 2.8 + 3.1) / 3, equal volume
  assert.match(elements.get('posChartOhlc').innerHTML, /&nbsp; VWAP 3\.05$/);
  delete globalThis.getComputedStyle;
});

test('Avg hides the average cost line and lets the scale fit without it; the choice stays on this device', async () => {
  const { run, elements, storage } = await chartApp();
  run(`togglePositionChart('${OPT}')`);
  await settle();
  const texts = [];
  elements.get('posChartD').clientWidth = 458;
  elements.get('posChartD').getContext = () => new Proxy({ measureText: () => ({ width: 40 }), fillText: t => texts.push(t) }, { get: (o, k) => k in o ? o[k] : () => {}, set: (o, k, v) => { o[k] = v; return true; } });
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

test('the Stop tool: a tap sets the stop, and the stop form says what it covers and risks', async () => {
  const { run, elements, canvas } = await chartApp();
  run("togglePositionChart('HOOD')");
  await settle();
  assert.equal(elements.get('posStopForm').style.display, 'none', 'the target form shows first');
  run("actions.setPosChartTool({ dataset: { arg: 'stop' } })");
  assert.equal(elements.get('posStopForm').style.display, '');
  assert.equal(elements.get('posTargetForm').style.display, 'none');
  assert.equal(elements.get('posAddForm').style.display, 'none');
  assert.equal(elements.get('posToolStop').getAttribute('aria-pressed'), 'true');
  assert.equal(elements.get('posChartTapHint').textContent, 'Tap the chart to set the stop');
  assert.equal(elements.get('posStopSummary').innerHTML, 'Tap the chart below the price, or type a stop.');
  assert.equal(elements.get('posStopReview').disabled, true);
  const g = run('candleGeom(posChart.daily.bars, posChart.daily.view, 458, positionLevels(positions.rows.find(r => r.symbol === "HOOD")).map(l => l.price))');
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

// ---------- Move breakeven: how many to add so the average cost lands on a stop ----------

test('breakevenAdd: shares to add at the price so the average lands on the stop, rounded down so the stop locks a little', async () => {
  const { run } = await chartApp();
  const hood = 'positions.rows.find(r => r.symbol === "HOOD")';
  // 300 at $38.20, now $41.10: a stop at $40 needs 300 × 1.80 / 1.10 = 490.9 → 490
  const a = run(`breakevenAdd(${hood}, { stop: 40 })`);
  assert.equal(a.error, '');
  assert.equal(a.qty, 490);
  assert.equal(a.newQty, 790);
  assert.equal(a.price, 41.1, 'the mark when no price is typed');
  assert.ok(a.avg <= 40 && a.avg > 39.99, `avg ${a.avg} just under the stop`);
  assert.ok(Math.abs(a.cost - 490 * 41.1) < 1e-6);
  assert.ok(Math.abs(a.value - 790 * 41.1) < 1e-6);
  assert.ok(a.locked > 0 && a.locked < 2, 'the stop locks the rounding');
  assert.equal(run(`breakevenAdd(${hood}, { stop: 40, price: 40.5 })`).qty, 1080, 'a typed add price: 300 × 1.80 / 0.50');

  // a short: 40 at $262, now $255.30; a stop at $258 needs 40 × 4 / 2.70 = 59.3 → 59, the average just over it
  const s = run('breakevenAdd(positions.rows.find(r => r.symbol === "TSLA"), { stop: 258 })');
  assert.equal(s.qty, 59);
  assert.ok(s.avg >= 258 && s.avg < 258.01);
  assert.ok(s.locked > 0);

  // an option: 2 at $2.50, now $3.00; a stop at $2.80 needs 2 × 0.30 / 0.20 = 3 contracts
  const o = run(`breakevenAdd(positions.rows.find(r => r.symbol === ${JSON.stringify(OPT)}), { stop: 2.8 })`);
  assert.equal(o.qty, 3);
  assert.ok(Math.abs(o.cost - 900) < 1e-6, '3 contracts × $3.00 × 100');
});

test('breakevenAdd: a stop has to sit between your cost and the add price', async () => {
  const { run } = await chartApp();
  const hood = 'positions.rows.find(r => r.symbol === "HOOD")';
  assert.match(run(`breakevenAdd(${hood}, { stop: 42 })`).error, /The stop \$42\.00 is at or above the price \$41\.10/);
  assert.match(run(`breakevenAdd(${hood}, { stop: 40, price: 39.5 })`).error, /at or above the add price \$39\.50/);
  assert.match(run(`breakevenAdd(${hood}, { stop: 37 })`).error, /Your breakeven is \$38\.20, and adding at \$41\.10 moves it up toward \$41\.10\. Pick a stop between the two\./);
  assert.match(run(`breakevenAdd(${hood}, { stop: 38.2 })`).error, /Your breakeven is \$38\.20/);
  assert.match(run('breakevenAdd(positions.rows.find(r => r.symbol === "TSLA"), { stop: 254 })').error, /at or below the price \$255\.30/);
  assert.match(run(`breakevenAdd({ ...${hood}, qty: 10 }, { stop: 38.3 })`).error, /Less than 1 share gets your breakeven to \$38\.30/);
  assert.match(run(`breakevenAdd({ ...${hood}, avg: 0 }, { stop: 40 })`).error, /no cost basis/);
  assert.match(run(`breakevenAdd(${hood}, { stop: null })`).error, /Tap the chart where you want the stop/);
});

test('Move breakeven: a tap sets the stop, and the form says how many to add', async () => {
  const { run, elements, canvas } = await chartApp();
  run("togglePositionChart('HOOD')");
  await settle();
  assert.equal(elements.get('posAddForm').style.display, 'none', 'the target form shows first');
  run("actions.setPosChartTool({ dataset: { arg: 'add' } })");
  assert.equal(elements.get('posTargetForm').style.display, 'none');
  assert.equal(elements.get('posAddForm').style.display, '');
  assert.equal(elements.get('posToolAdd').getAttribute('aria-pressed'), 'true');
  assert.equal(elements.get('posChartTapHint').textContent, 'Tap the chart where you want your stop');
  assert.equal(elements.get('posAddPrice').placeholder, 'now 41.10');
  assert.match(elements.get('posAddSummary').innerHTML, /Tap the chart where you want your stop, between your cost \$38\.20 and the price/);

  const g = run('candleGeom(posChart.daily.bars, posChart.daily.view, 458, positionLevels(positions.rows.find(r => r.symbol === "HOOD")).map(l => l.price))');
  canvas('mousedown', { clientX: g.x(200) });
  canvas('click', { clientX: g.x(200), clientY: g.y(40) });
  assert.ok(Math.abs(run('posChart.addStop') - 40) <= 0.01, 'the tap is the stop, not the target');
  assert.equal(run('posChart.price'), null);
  assert.equal(elements.get('posAddStop').value, run('posChart.addStop.toFixed(2)'));

  elements.get('posAddStop').value = '40';
  run('posAddChanged()');
  const sum = elements.get('posAddSummary').innerHTML;
  assert.match(sum, /<strong>Buy 490 shares at \$41\.10 \(now\)<\/strong> · \$20,139\.00 → 790 shares, avg \$40\.00\. A stop at \$40\.00 for all 790 then risks nothing \(locks <span class="pos-locked">\+\$1\.00<\/span>\)\./);
  assert.match(sum, /Position \$32,469\.00 \(32\.5% of account\) at that price\. Your stops risk −\$540\.00 now\. Once it fills, move your stop to \$40\.00 for every share\./);

  elements.get('posAddPrice').value = '40.5';
  run('posAddChanged()');
  assert.match(elements.get('posAddSummary').innerHTML, /<strong>Buy 1,080 shares at \$40\.50<\/strong>/);
  elements.get('posAddStop').value = '37';
  run('posAddChanged()');
  assert.equal(elements.get('posAddSummary').className, 'pos-target-sum warn');
  assert.match(elements.get('posAddSummary').innerHTML, /Your breakeven is \$38\.20/);

  run("setPosChartTool('target')");
  assert.equal(elements.get('posTargetForm').style.display, '');
  canvas('click', { clientX: g.x(200), clientY: g.y(43) });
  assert.ok(Math.abs(run('posChart.price') - 43) <= 0.01, 'back on targets, a tap is the target again');
  assert.equal(run('posChart.addStop'), 37);
});

test('Move breakeven: hovering says how many to add for a stop right there', async () => {
  const { run, elements, canvas } = await chartApp();
  run("togglePositionChart('HOOD')");
  await settle();
  run("setPosChartTool('add')");
  const g = run('candleGeom(posChart.daily.bars, posChart.daily.view, 458, positionLevels(positions.rows.find(r => r.symbol === "HOOD")).map(l => l.price))');
  elements.get('posChartD').clientWidth = 458;
  elements.get('posChartD').getContext = () => new Proxy({ measureText: () => ({ width: 40 }) }, { get: (o, k) => k in o ? o[k] : () => {}, set: (o, k, v) => { o[k] = v; return true; } });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  canvas('mousemove', { clientX: g.x(200), clientY: g.y(40) });
  assert.match(elements.get('posChartOhlc').innerHTML, /from now\) · add \d{3}/);
  canvas('mousemove', { clientX: g.x(200), clientY: g.y(43) });
  assert.doesNotMatch(elements.get('posChartOhlc').innerHTML, /· add/, 'over the price: no add');
  delete globalThis.getComputedStyle;
});
