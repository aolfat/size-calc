// Run with: node --test
// The Journal's trade page: the bars inside a hold, where fills land on a chart, the daily window, the excursions (MFE,
// MAE, exit efficiency), the series its charts get, and the page itself (opened from a row, saved bars read, the charts
// drawn by Lightweight Charts (a fake here: helpers/charts.mjs), Edit, back to the list).
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeCharts } from './helpers/charts.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const json = (run, code) => JSON.parse(run(`JSON.stringify(${code})`));
const bar = (date, time, open, high, low, close) => ({ date, time, open, high, low, close });
const long = { direction: 'long', avgEntry: 100, entryQty: 100, multiplier: 1, openedAt: '2026-10-13T13:40:10.000Z', closedAt: '2026-10-13T14:31:00.000Z', status: 'win', pnl: 200, risk: 200 };
const BARS = [
  bar('2026-10-13', '09:30', 99, 105, 98, 100), // before the entry (09:40): not part of the hold
  bar('2026-10-13', '09:40', 100, 101, 99.5, 100.5),
  bar('2026-10-13', '09:45', 100.5, 103, 99, 102),
  bar('2026-10-13', '10:30', 102, 102.5, 101, 102),
  bar('2026-10-13', '10:35', 102, 110, 101, 109), // after the exit (10:31): not part of it either
];

test('New York stamps, bars unpacked, regular hours unless a fill was outside them', async () => {
  const { run } = await app();
  assert.equal(run("nyStamp('2026-10-13T13:41:02.000Z')"), '2026-10-13 09:41', 'EDT');
  assert.equal(run("nyStamp('2026-12-01T15:05:00.000Z')"), '2026-12-01 10:05', 'EST');
  assert.equal(run("barStart('2026-10-13 09:44')"), '2026-10-13 09:40');
  const rows = [{ day: '2026-10-14', bars: [['09:30', 1, 2, 0.5, 1.5, 10]] }, { day: '2026-10-13', bars: [['16:05', 1, 1, 1, 1, 0], ['09:35', 2, 3, 1, 2.5, 5]] }];
  const all = json(run, `unpackBars(${JSON.stringify(rows)})`);
  assert.deepEqual(all.map(b => `${b.date} ${b.time}`), ['2026-10-13 09:35', '2026-10-13 16:05', '2026-10-14 09:30'], 'oldest first');
  assert.equal(json(run, `holdChartBars(${JSON.stringify(all)}, [{ time: '2026-10-13T13:40:00.000Z' }])`).length, 2, 'the after-hours bar drops');
  assert.equal(json(run, `holdChartBars(${JSON.stringify(all)}, [{ time: '2026-10-13T20:10:00.000Z' }])`).length, 3, 'unless a fill happened then');
});

test('fills land on the bar they happened in, or their day on a daily chart; the daily view frames the trade', async () => {
  const { run } = await app();
  const fills = [{ time: '2026-10-13T13:40:10.000Z', side: 'buy', qty: 100, price: 100 }, { time: '2026-10-13T14:31:00.000Z', side: 'sell', qty: 100, price: 102 }, { time: '2026-10-20T14:00:00.000Z', side: 'sell', qty: 1, price: 1 }];
  assert.deepEqual(json(run, `fillMarks(${JSON.stringify(BARS)}, ${JSON.stringify(fills)})`).map(m => [m.index, m.side]), [[1, 'buy'], [3, 'sell']], 'a fill off the chart is left out');
  const daily = Array.from({ length: 100 }, (_, i) => { const d = new Date(Date.UTC(2026, 5, 1) + i * 864e5).toISOString().slice(0, 10); return { date: d, open: 1, high: 1, low: 1, close: 1 }; });
  assert.deepEqual(json(run, `fillMarks(${JSON.stringify(daily)}, ${JSON.stringify(fills.slice(0, 1))})`), [], 'no bar that day: left out');
  const oct = [{ date: '2026-10-12', open: 1, high: 1, low: 1, close: 1 }, { date: '2026-10-13', open: 1, high: 1, low: 1, close: 1 }];
  assert.deepEqual(json(run, `fillMarks(${JSON.stringify(oct)}, ${JSON.stringify(fills)})`).map(m => [m.index, m.side]), [[1, 'buy'], [1, 'sell']], 'on a daily chart, the fill\'s day');
  const win = json(run, `dailyWindow(${JSON.stringify(daily)}, { openedAt: '${daily[60].date}T15:00:00.000Z', closedAt: '${daily[70].date}T15:00:00.000Z' })`);
  assert.deepEqual(win, { count: 61, offset: 19 }, '40 sessions before the open through 10 after the close');
});

test('chart series: New York wall-clock times, the 8 EMA warmed up from the first close, volume, and the fills as markers', async () => {
  const { run } = await app();
  const fills = [{ time: '2026-10-13T14:31:00.000Z', side: 'sell', qty: 100, price: 102 }, { time: '2026-10-13T13:40:10.000Z', side: 'buy', qty: 100, price: 100 }];
  const s = json(run, `chartSeries(${JSON.stringify(BARS.map((b, i) => ({ ...b, volume: i * 10 })))}, ${JSON.stringify(fills)})`);
  const at = (d, hh, mm) => Date.UTC(2026, 9, d, hh, mm) / 1000;
  assert.deepEqual(s.candles[1], { time: at(13, 9, 40), open: 100, high: 101, low: 99.5, close: 100.5 }, '09:40 New York reads 09:40 on the axis, which shows UTC');
  assert.equal(s.ema[0].value, 100);
  assert.ok(Math.abs(s.ema[1].value - (100.5 * 2 / 9 + 100 * 7 / 9)) < 1e-9);
  assert.deepEqual(s.volume.slice(0, 3), [{ time: at(13, 9, 30), value: 0, up: true }, { time: at(13, 9, 40), value: 10, up: true }, { time: at(13, 9, 45), value: 20, up: true }]);
  assert.equal(s.volume[3].up, true, 'flat counts as up, like the candles');
  assert.deepEqual(s.markers, [{ time: at(13, 9, 40), side: 'buy', qty: 100, price: 100 }, { time: at(13, 10, 30), side: 'sell', qty: 100, price: 102 }], 'oldest first, on the bar each happened in');
  const daily = json(run, `chartSeries([{ date: '2026-10-13', open: 1, high: 2, low: 0.5, close: 0.8 }], ${JSON.stringify(fills)})`);
  assert.equal(daily.candles[0].time, '2026-10-13', 'a daily bar is its day');
  assert.equal(daily.volume[0].up, false);
  assert.deepEqual(daily.markers.map(m => [m.time, m.side]), [['2026-10-13', 'buy'], ['2026-10-13', 'sell']]);
});

test('intervals: 5-minute bars rolled up from the 9:30 open, fills on the bucket they fell in, the hold framed, volume in words', async () => {
  const { run } = await app();
  const rolled = json(run, `rollUp(${JSON.stringify(BARS.map(b => ({ ...b, volume: 10 })))}, 65)`);
  assert.deepEqual(rolled, [
    { date: '2026-10-13', time: '09:30', open: 99, high: 105, low: 98, close: 102, volume: 40 },
    { date: '2026-10-13', time: '10:35', open: 102, high: 110, low: 101, close: 109, volume: 10 },
  ], '09:30 through 10:34 is the first 65-minute bar');
  assert.deepEqual(json(run, `rollUp(${JSON.stringify(BARS)}, 5)`), BARS, '5m is the bars as they are');
  const fills = [{ time: '2026-10-13T13:40:10.000Z', side: 'buy', qty: 100, price: 100 }, { time: '2026-10-13T14:31:00.000Z', side: 'sell', qty: 100, price: 102 }];
  assert.deepEqual(json(run, `fillMarks(${JSON.stringify(rolled)}, ${JSON.stringify(fills)}, 65)`).map(m => m.index), [0, 0], 'both inside the first 65 minutes');
  assert.deepEqual(json(run, `chartSeries(${JSON.stringify(rolled)}, ${JSON.stringify(fills)}, 65)`).markers.map(m => m.side), ['buy', 'sell']);

  const day = Array.from({ length: 120 }, (_, i) => { const m = 570 + i * 5; return bar('2026-10-13', `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, 1, 1, 1, 1); });
  const trade = { openedAt: '2026-10-13T18:30:00.000Z', closedAt: '2026-10-13T18:57:00.000Z' }; // 14:30 (bar 60) to 14:57 (bar 65)
  assert.deepEqual(json(run, `holdView(${JSON.stringify(day)}, ${JSON.stringify(trade)})`), { start: 26, end: 86 },
    'six bars either side, then widened to 60 bars, two thirds of it before the open (the context)');
  assert.deepEqual(json(run, `holdView(${JSON.stringify(day)}, ${JSON.stringify({ openedAt: '2026-10-13T13:35:00.000Z', closedAt: '2026-10-13T13:57:00.000Z' })})`), { start: 0, end: 60 },
    'near the first bar: what the left can\'t take goes right');
  assert.deepEqual(json(run, `holdView(${JSON.stringify(day)}, ${JSON.stringify({ ...trade, closedAt: null })})`), { start: 30, end: 120 }, 'open: through the latest bar, the padding the right can\'t take before it');
  const NOW = Date.parse('2026-10-16T18:00:00Z');
  assert.deepEqual(json(run, `contextDays({ openedAt: '2026-10-13T13:40:00.000Z', status: 'win' }, ${NOW})`),
    ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12'], 'the two weeks before the open');
  assert.equal(json(run, `contextDays({ openedAt: '2026-09-15T13:40:00.000Z', status: 'win' }, ${NOW})`)[0], '2026-09-11', 'nothing Tradier no longer keeps');
  assert.deepEqual(json(run, `contextDays({ openedAt: '2026-08-03T13:40:00.000Z', status: 'win' }, ${NOW})`), []);
  assert.deepEqual(json(run, `contextDays({ openedAt: '', status: 'history' }, ${NOW})`), []);

  assert.deepEqual(['compactVolume(742580)', 'compactVolume(1234567)', 'compactVolume(950)', 'compactVolume(0)'].map(c => run(c)), ['742.58K', '1.23M', '950', '0']);
});

test('excursions: the best and worst while it was open, in dollars and R, and the share of the best move kept', async () => {
  const { run } = await app();
  const ex = json(run, `excursions(${JSON.stringify(long)}, ${JSON.stringify(BARS)})`);
  assert.deepEqual(ex, { mfe: 300, mae: -100, mfePrice: 103, maePrice: 99, mfeR: 1.5, maeR: -0.5, bars: 3, efficiency: 0.667 },
    'the 09:30 high of 105 and the 10:35 run to 110 were outside the hold');
  const short = json(run, `excursions(${JSON.stringify({ ...long, direction: 'short', avgEntry: 102, pnl: -50 })}, ${JSON.stringify(BARS)})`);
  assert.deepEqual([short.mfe, short.mae, short.mfePrice, short.maePrice, short.efficiency], [300, -100, 99, 103, null], 'a short: lows for, highs against; a loser has no efficiency');
  const opt = json(run, `excursions(${JSON.stringify({ ...long, multiplier: 100, entryQty: 2, pnl: 999999 })}, ${JSON.stringify(BARS)})`);
  assert.equal(opt.mfe, 600, '×100 a contract');
  assert.equal(opt.efficiency, 1, 'never more than all of it');
  const open = json(run, `excursions(${JSON.stringify({ ...long, status: 'open', closedAt: null })}, ${JSON.stringify(BARS)})`);
  assert.equal(open.mfe, 1000, 'open: through the latest bar');
  assert.equal(open.efficiency, null);
  assert.equal(run(`excursions(${JSON.stringify({ ...long, legs: [] })}, ${JSON.stringify(BARS)})`), null, 'spreads come later');
  assert.equal(run(`excursions(${JSON.stringify(long)}, [])`), null, 'no bars, no numbers');
});

// ---------- the page ----------

const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
// 100 AAPL bought 10/1 10:30 ET at 100.02 with a trigger stop at 95, which filled 10/2 at 94.98
const ENTRY = {
  orderId: 501, enteredTime: '2026-10-01T14:30:00+0000', status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction: 'BUY', quantity: 100, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7001, executionLegs: [{ legId: 1, quantity: 100, price: 100.02, time: '2026-10-01T14:30:01+0000' }] }],
  childOrderStrategies: [{
    orderId: 502, status: 'FILLED', orderType: 'STOP', stopPrice: 95,
    orderLegCollection: [{ legId: 1, instruction: 'SELL', quantity: 100, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7002, executionLegs: [{ legId: 1, quantity: 100, price: 94.98, time: '2026-10-02T15:00:00+0000' }] }],
  }],
};
const KEY = '6789|AAPL|long|2026-10-01T14:30:01.000Z';
const TODAY = Date.parse('2026-10-16T18:00:00Z');
const day = (d, rows) => ({ user_id: 'user-1', symbol: 'AAPL', day: d, bars: rows });

async function page(opts = {}, t) {
  // canvases can't read CSS variables, so the colors come from the stylesheet: here, each variable's own name
  globalThis.getComputedStyle = () => ({ getPropertyValue: n => n });
  t?.after(() => { delete globalThis.getComputedStyle; });
  const charts = opts.charts || fakeCharts();
  const supabase = fakeRecords([{ kind: 'order', record_id: '501', account: '6789', entered_at: '2026-10-01T14:30:00Z', data: ENTRY }]);
  supabase.bars.set('user-1:AAPL:2026-10-01', day('2026-10-01', [['10:25', 100, 100.5, 99.8, 100.2, 1], ['10:30', 100, 101.5, 99, 101, 1], ['15:55', 101, 103, 100.5, 102, 1]]));
  supabase.bars.set('user-1:AAPL:2026-10-02', day('2026-10-02', [['09:30', 102, 104, 97, 98, 1], ['11:00', 96, 96.5, 94.5, 95, 1]]));
  const a = await app({ supabase, session: SESSION, fetch: opts.fetch, charts, clock: true, now: TODAY, storage: opts.storage });
  if (opts.key) a.elements.get('apiKey').value = 'test-key';
  a.run("setView('journal')");
  await a.run('loadJournal()');
  const chart = id => (typeof charts === 'function' ? [] : charts.charts).find(c => c.container.id === id && !c.removed);
  return { ...a, supabase, charts, chart, body: () => a.elements.get('jtBody').innerHTML, head: () => a.elements.get('jtHead').innerHTML };
}
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

test('a row opens the trade page: its saved bars, MFE and MAE, the fills and stops; Edit and back', async t => {
  const { run, state, elements, supabase, body, head } = await page({}, t);
  run(`openTradeRow('${KEY}', { target: { closest: () => null } })`);
  await settle();
  assert.equal(elements.get('journalSection').style.display, 'none', 'the list steps aside');
  assert.equal(elements.get('journalTradeSection').style.display, '');
  assert.match(head(), /data-action="closeJournalTrade">← Trades/);
  assert.match(head(), /id="jtTitle">AAPL<\/span>/);
  assert.match(head(), /Long 100 at \$100\.02 → \$94\.98/);
  assert.ok(supabase.reads.some(r => r.table === 'bars_5m' && r.cols === 'day,bars'), 'the saved bars are read');
  assert.equal(state.journalTrade.five.length, 5, 'the hold\'s days, regular hours');
  assert.match(body(), /<dt>MFE<\/dt><dd class="journal-buy">\+\$398\.00<span class="pos-sub">\+0\.79R · best \$104\.00<\/span>/, '(104 − 100.02) × 100, the 10:25 bar before the entry left out');
  assert.match(body(), /<dt>MAE<\/dt><dd class="journal-sell">−\$552\.00<span class="pos-sub">−1\.10R · worst \$94\.50<\/span>/);
  assert.match(body(), /<dt>Exit efficiency<\/dt><dd class="">—<span class="pos-sub">winners only<\/span>/);
  assert.match(body(), /From 4 five-minute bars while it was open/);
  assert.match(body(), /<td>10\/1, 10:30 AM<\/td><td class="journal-buy">Buy<\/td><td>100<\/td><td>\$100\.02<\/td>/, 'the fills, in New York time');
  assert.match(body(), /\$95\.00 <span class="journal-tag journal-tag-quiet">first<\/span><\/td><td>filled<\/td>/, 'the stop orders');
  assert.match(elements.get('jtStatusD').textContent, /Add a Tradier key in Settings for the daily chart/);
  run('editJournalTrade()');
  assert.equal(state.openSheetName, 'tradeReview');
  run('closeSheet(); closeJournalTrade()');
  assert.equal(state.journalTrade, null);
  assert.equal(elements.get('journalSection').style.display, '');
  assert.equal(elements.get('journalTradeSection').style.display, 'none');
});

test('the 5-minute chart: candles, 8 EMA and volume, the fills marked, entry, exit and stop drawn, the readout', async t => {
  const { run, chart, charts, elements } = await page({}, t);
  run(`openJournalTrade('${KEY}')`);
  await settle();
  const c = chart('jtChart5');
  assert.ok(c, 'drawn into the 5-minute box');
  assert.equal(c.options.handleScroll.vertTouchDrag, false, 'a vertical swipe on a phone still moves the page');
  assert.equal(c.options.layout.textColor, '--text3');
  const [candles, ema, volume] = c.series;
  assert.deepEqual([candles.type, ema.type, volume.type], ['Candlestick', 'Line', 'Histogram']);
  assert.equal(candles.data.length, 5);
  assert.equal(candles.data[0].time, Date.UTC(2026, 9, 1, 10, 25) / 1000);
  assert.equal(ema.options.color, '--purple');
  assert.equal(volume.data.length, 5);
  assert.deepEqual(candles.lines.map(l => [l.options.title, l.options.price, l.options.color]),
    [['entry', 100.02, '--blue'], ['exit', 94.98, '--amber'], ['stop', 95, '--red']]);
  assert.deepEqual(candles.markers.map(m => [m.time, m.position, m.shape, m.color, m.text]), [
    [Date.UTC(2026, 9, 1, 10, 30) / 1000, 'belowBar', 'arrowUp', '--blue', '100'],
    [Date.UTC(2026, 9, 2, 11, 0) / 1000, 'aboveBar', 'arrowDown', '--amber', '100'],
  ], 'the buy under its bar, the stop-out over 11:00 the next day');
  assert.deepEqual(c.range, { from: 0, to: 4 }, 'framed on the hold');

  const legend = () => elements.get('jtLegend5').innerHTML;
  assert.match(legend(), /AAPL · 5m/);
  assert.match(legend(), /O&nbsp;<b[^>]*>96\.00<\/b>.*C&nbsp;<b[^>]*>95\.00<\/b>.*−3\.00&nbsp;\(−3\.06%\)/, 'the latest bar until you hover, against the bar before');
  assert.match(legend(), /Vol <b>1<\/b>/);
  assert.match(legend(), /EMA 8 <b[^>]*>\d+\.\d\d<\/b>/);
  c.hover({ time: candles.data[2].time, logical: 2 });
  assert.match(legend(), /O&nbsp;<b[^>]*>101\.00<\/b>/, 'the hovered bar');
  c.hover({});
  assert.match(legend(), /O&nbsp;<b[^>]*>96\.00<\/b>/, 'off the bars: back to the latest');
  assert.equal(ema.options.lastValueVisible, true, "the EMA's value tagged on the price axis");

  run('renderJournalTrade()');
  assert.equal(charts.charts.length, 1, 'redrawn in place, not made again');
  assert.equal(candles.lines.length, 3, 'the lines replaced, not stacked');

  run('closeJournalTrade()');
  assert.equal(c.removed, true, 'closing the page lets the chart go');
});

test("the chart library didn't load: the page says so and keeps the rest", async t => {
  const { run, elements, body } = await page({ charts: async () => { throw new Error('offline'); } }, t);
  run(`openJournalTrade('${KEY}')`);
  await settle();
  assert.match(elements.get('jtStatus5').textContent, /Couldn't load the charts/);
  assert.match(body(), /<dt>MFE<\/dt>/);
});

test('with a key: the daily chart from Tradier, framed on the trade', async t => {
  const days = Array.from({ length: 80 }, (_, i) => { const d = new Date(Date.UTC(2026, 7, 1) + i * 864e5).toISOString().slice(0, 10); return { date: d, open: 100, high: 101, low: 99, close: 100, volume: 1 }; });
  const fetch = async url => {
    if (String(url).includes('/markets/history')) return new Response(JSON.stringify({ history: { day: days } }), { status: 200 });
    if (String(url).includes('/markets/timesales')) return new Response(JSON.stringify({ series: null }), { status: 200 });
    throw new Error('unexpected ' + url);
  };
  const { run, state, elements, chart } = await page({ key: true, fetch }, t);
  run(`openJournalTrade('${KEY}')`);
  await settle();
  assert.equal(state.journalTrade.daily.length, 80);
  assert.equal(elements.get('jtStatusD').textContent, '');
  const c = chart('jtChartD');
  assert.equal(c.series[0].data[0].time, '2026-08-01', 'a daily bar is its day');
  assert.equal(c.series[2].data[0].value, 1, 'with its volume');
  assert.equal(c.options.timeScale.timeVisible, false);
  assert.deepEqual(c.series[0].lines, [], "an underlying's chart gets no lines: they're the trade's prices");
  const at = days.findIndex(d => d.date === '2026-10-01');
  assert.deepEqual(c.range, { from: at - 40, to: Math.min(80, days.findIndex(d => d.date === '2026-10-02') + 11) - 1 }, '40 sessions before through 10 after');
  assert.match(elements.get('jtLegendD').innerHTML, /AAPL · 1D/);

  // range chips: the trade's framing, or 3 / 6 / 12 months ending at the same right edge; log scale
  const end = Math.min(80, days.findIndex(d => d.date === '2026-10-02') + 11);
  assert.match(elements.get('jtToolsD').innerHTML, /data-action="setJournalRange" data-arg="trade"[^>]*class="filter-btn active"/);
  run("setJournalRange('63')");
  assert.deepEqual(c.range, { from: end - 63, to: end - 1 });
  assert.match(elements.get('jtToolsD').innerHTML, /data-arg="63"[^>]*class="filter-btn active"/);
  run("setJournalRange('trade')");
  assert.deepEqual(c.range, { from: at - 40, to: end - 1 });
  run("toggleJournalLog('D')");
  assert.equal(c.scales.right.mode, 1, 'logarithmic');
  assert.match(elements.get('jtToolsD').innerHTML, /data-action="toggleJournalLog" data-arg="D"[^>]*class="filter-btn active"/);
  run("toggleJournalLog('D')");
  assert.equal(c.scales.right.mode, 0);
});

test('with a key: two weeks before the open come from Tradier for context, and the interval chips roll the bars up', async t => {
  const calls = [];
  const fetch = async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/markets/history')) return new Response(JSON.stringify({ history: null }), { status: 200 });
    if (u.pathname.endsWith('/markets/timesales')) {
      calls.push([u.searchParams.get('symbol'), u.searchParams.get('start'), u.searchParams.get('end')]);
      return new Response(JSON.stringify({ series: { data: [{ time: '2026-09-30T15:00:00', open: 98, high: 99, low: 97, close: 98.5, volume: 5 }, { time: '2026-09-30T15:55:00', open: 98.5, high: 99.5, low: 98, close: 99, volume: 5 }] } }), { status: 200 });
    }
    throw new Error('unexpected ' + url);
  };
  const storage = new Map();
  const { run, state, chart, elements, body } = await page({ key: true, fetch, storage }, t);
  run(`openJournalTrade('${KEY}')`);
  await settle();
  assert.deepEqual(calls, [['AAPL', '2026-09-17 04:00', '2026-09-30 20:00']], 'one call for the sessions before the open, not saved');
  assert.equal(state.journalTrade.five.length, 7, "the hold's 5 bars after 9/30's 2");
  const c = chart('jtChart5');
  assert.equal(c.series[0].data[0].time, Date.UTC(2026, 8, 30, 15, 0) / 1000);
  assert.deepEqual(c.range, { from: 0, to: 6 }, 'framed on the hold, with the context to pan back into');
  assert.match(body(), /<dt>MFE<\/dt><dd class="journal-buy">\+\$398\.00/, 'excursions count the hold only');

  assert.match(elements.get('jtTools5').innerHTML, /data-action="setJournalInterval" data-arg="5"[^>]*class="filter-btn active"/);
  run('setJournalInterval(65)');
  // 65-minute buckets from 9:30: 9/30 14:55-15:59 holds both context bars; 10/1 9:30-10:34 holds 10:25 and 10:30
  assert.deepEqual(c.series[0].data.map(b => b.time), [Date.UTC(2026, 8, 30, 15, 0), Date.UTC(2026, 9, 1, 10, 25), Date.UTC(2026, 9, 1, 15, 55), Date.UTC(2026, 9, 2, 9, 30), Date.UTC(2026, 9, 2, 11, 0)].map(ms => ms / 1000));
  assert.deepEqual(c.series[0].markers.map(m => m.time), [Date.UTC(2026, 9, 1, 10, 25) / 1000, Date.UTC(2026, 9, 2, 11, 0) / 1000], 'the fills move to their buckets');
  assert.equal(storage.get('journal_chart_iv'), '65', 'kept on this device');
  assert.match(elements.get('jtLegend5').innerHTML, /AAPL · 65m/);
  run("toggleJournalLog('5')");
  assert.equal(c.scales.right.mode, 1);
});

test('a trade with nothing saved says why', async t => {
  const { run, state, supabase, elements, chart } = await page({}, t);
  supabase.bars.clear();
  run(`openJournalTrade('${KEY}')`);
  await settle();
  assert.equal(state.journalTrade.five.length, 0);
  assert.equal(chart('jtChart5'), undefined, 'no bars, no chart');
  assert.match(elements.get('jtStatus5').textContent, /Add a Tradier key in Settings to load this trade(?:'|’)s 5-minute bars|No 5-minute bars were saved/);
});
