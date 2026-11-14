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

test("extended hours: each intraday bar's session, a faint band behind the pre-market and after-hours bars, named in the legend", async t => {
  globalThis.getComputedStyle = () => ({ getPropertyValue: n => n });
  t.after(() => { delete globalThis.getComputedStyle; });
  const lib = fakeCharts();
  const { run, elements } = await app({ charts: lib });
  const bars = [['08:15', 1], ['09:25', 2], ['09:30', 3], ['15:55', 4], ['16:00', 5], ['19:55', 6]].map(([time, c]) => ({ date: '2026-10-13', time, open: c, high: c, low: c, close: c, volume: 1 }));
  assert.deepEqual(json(run, `chartSeries(${JSON.stringify(bars)}, []).session`), ['pre', 'pre', '', '', 'post', 'post'], '9:30 opens the session, 16:00 ends it');
  assert.deepEqual(json(run, `chartSeries([{ date: '2026-10-13', open: 1, high: 1, low: 1, close: 1 }], []).session`), [], 'none on daily bars');

  await run('loadTradeChartLibrary()');
  run("var h = makeTradeChart(chartLib, document.getElementById('jtChart5'), document.getElementById('jtLegend5'), { daily: false })");
  run(`paintTradeChart(h, ${JSON.stringify(bars)}, { fills: [], lines: [], title: 'AAPL · 5m' })`);
  const c = lib.charts[0], [candles] = c.series;
  assert.equal(c.series.length, 4, 'candles, EMA, volume, VWAP: the band is no series of its own');
  const [band] = candles.primitives;
  assert.equal(band.paneViews()[0].zOrder(), 'bottom', 'behind the candles');
  assert.ok(candles.updates >= 1, 'redrawn when the bars are painted');
  assert.deepEqual(json(run, 'h.bands'), [[0, 1], [4, 5]], 'one band per run of extended bars');
  assert.deepEqual(json(run, "extendedRuns(['post', 'post', 'pre', '', 'pre', '', ''])"), [[0, 2], [4, 4]], 'the night between two days is one run');
  // drawn edge to edge of its bars: bars 10px apart
  const rects = [];
  const target = { useMediaCoordinateSpace: fn => fn({ context: { fillRect: (...r) => rects.push(r) }, mediaSize: { width: 100, height: 200 } }) };
  c.timeScale = () => ({ logicalToCoordinate: i => 5 + i * 10 });
  band.paneViews()[0].renderer().draw(target);
  assert.deepEqual(rects, [[0, 0, 20, 200], [40, 0, 20, 200]]);
  const legend = () => elements.get('jtLegend5').innerHTML;
  assert.match(legend(), /<span class="jt-legend-ext">After hours<\/span>/, 'the latest bar is after hours');
  c.hover({ time: c.series[0].data[0].time, logical: 0 });
  assert.match(legend(), /Pre-market/);
  c.hover({ time: c.series[0].data[2].time, logical: 2 });
  assert.doesNotMatch(legend(), /jt-legend-ext/, 'nothing on a regular-hours bar');

  run("var d = makeTradeChart(chartLib, document.getElementById('jtChartD'), document.getElementById('jtLegendD'), { daily: true })");
  assert.equal(lib.charts[1].series.length, 3, 'no band on the daily chart');
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

test('VWAP: typical price weighted by volume, starting over each day, the typical price until there is volume; none on daily bars', async () => {
  const { run } = await app();
  const bars = [
    { ...bar('2026-10-13', '09:30', 100, 102, 98, 101), volume: 0 },
    { ...bar('2026-10-13', '09:35', 101, 103, 100, 102), volume: 100 },
    { ...bar('2026-10-13', '09:40', 102, 106, 101, 105), volume: 300 },
    { ...bar('2026-10-14', '09:30', 90, 93, 87, 90), volume: 50 },
  ];
  const v = json(run, `sessionVwap(${JSON.stringify(bars)})`);
  assert.ok(Math.abs(v[0] - 301 / 3) < 1e-9, 'no volume yet: the typical price');
  assert.ok(Math.abs(v[1] - 305 / 3) < 1e-9);
  assert.ok(Math.abs(v[2] - (305 / 3 * 100 + 104 * 300) / 400) < 1e-9, 'weighted by volume');
  assert.equal(v[3], 90, 'a new day starts over');
  assert.deepEqual(json(run, `sessionVwap([{ date: '2026-10-13', open: 1, high: 2, low: 0.5, close: 0.8, volume: 10 }])`), [], 'daily bars have none');
  const s = json(run, `chartSeries(${JSON.stringify(bars)}, [])`);
  assert.deepEqual(s.vwap.map(p => p.end), [false, false, true, false], "a day's last bar, when another day follows");
  assert.equal(s.vwap[3].time, Date.UTC(2026, 9, 14, 9, 30) / 1000);
  assert.deepEqual(json(run, `chartSeries([{ date: '2026-10-13', open: 1, high: 2, low: 0.5, close: 0.8 }], [])`).vwap, []);
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

test('after the exit: held on with the stop in, where the exit sat in that, what the hold and the next sessions did', async () => {
  const { run } = await app();
  // long 100 from 09:40, stop 98; sold 100 at 102 at 10:31 (the 10:30 bar); then 10:35 runs to 110, the day closes 108
  const day = [...BARS, bar('2026-10-13', '15:55', 109, 109, 106, 108), bar('2026-10-13', '16:05', 108, 120, 108, 120)];
  const t = { ...long, stop: 98 };
  const sold = [{ time: '2026-10-13T14:31:00.000Z', qty: 100, price: 102 }];
  const a = json(run, `afterExit(${JSON.stringify(t)}, ${JSON.stringify(sold)}, ${JSON.stringify(day)})`);
  assert.deepEqual([a.held, a.heldR, a.out], [600, 3, { price: 108, date: '2026-10-13', time: '15:55', how: 'close', sessions: 0 }], 'a day trade: held to the close, the stop never reached');
  // the range from the entry's bar to the end of the hold: 99 to 110, 102 sits 3 of 11 up
  assert.equal(a.score, 0.273);
  assert.equal(a.verdict, 'early', 'it ran 8 past the exit, more than the 1 given back from 103');
  assert.deepEqual([a.left, a.leftR, a.best], [800, 4, { price: 110, date: '2026-10-13', time: '10:35' }], 'the best during the hold; after hours left out');
  assert.deepEqual([a.against, a.againstR, a.stopHit], [-100, -0.5, false], 'down to 101 in the 10:35 bar, nowhere near the stop');
  assert.deepEqual(a.sessions, [], 'no daily bars, no sessions');

  // sold at 109 in the 10:35 bar: a good exit, and holding to the 108 close would have made less
  const top = json(run, `afterExit(${JSON.stringify(t)}, ${JSON.stringify([{ time: '2026-10-13T14:36:00.000Z', qty: 100, price: 109 }])}, ${JSON.stringify(day)})`);
  assert.equal(top.verdict, 'good');
  assert.equal(top.score, 0.909);
  assert.deepEqual([top.left, top.against, top.held], [0, -300, -100]);

  // a trim and the rest: each weighted by what it closed
  const two = json(run, `afterExit(${JSON.stringify(t)}, ${JSON.stringify([{ time: '2026-10-13T14:31:00.000Z', qty: 50, price: 102 }, { time: '2026-10-13T14:36:00.000Z', qty: 50, price: 109 }])}, ${JSON.stringify(day)})`);
  assert.equal(two.score, 0.591);
  assert.deepEqual([two.left, two.held], [400, 250], 'only the trim missed the run; 50 × 6 up, 50 × 1 down');
  assert.equal(two.avgExit, 105.5);

  // gave it back: sold at 101 after a 103 high, and it never went higher
  const flat = [...BARS.slice(0, 4), bar('2026-10-13', '10:35', 101, 101.5, 100.5, 101)];
  assert.equal(json(run, `afterExit(${JSON.stringify(t)}, ${JSON.stringify([{ time: '2026-10-13T14:36:00.000Z', qty: 100, price: 101 }])}, ${JSON.stringify(flat)})`).verdict, 'late');

  // stopped at 98, then it ran: the stop is where holding ends too, so nothing after counts
  const stopBars = [bar('2026-10-13', '09:40', 100, 100.5, 97.5, 98), bar('2026-10-13', '09:45', 98, 104, 98, 104)];
  const st = json(run, `afterExit(${JSON.stringify(t)}, ${JSON.stringify([{ time: '2026-10-13T13:43:00.000Z', qty: 100, price: 98 }])}, ${JSON.stringify(stopBars)})`);
  assert.equal(st.verdict, 'stopped');
  assert.deepEqual([st.held, st.out.how, st.left, st.best], [0, 'stop', 0, null]);

  // out above the stop, then it fell through it: holding gets stopped at 98, not the 97 low
  const fell = [bar('2026-10-13', '09:40', 100, 101, 99.5, 100.5), bar('2026-10-13', '09:45', 100.5, 100.5, 97, 97)];
  const saved = json(run, `afterExit(${JSON.stringify(t)}, ${JSON.stringify([{ time: '2026-10-13T13:43:00.000Z', qty: 100, price: 100.5 }])}, ${JSON.stringify(fell)})`);
  assert.deepEqual([saved.stopHit, saved.held, saved.against, saved.againstR, saved.out.price, saved.out.time], [true, -250, -250, -1.25, 98, '09:45']);
  // a gap through it: out at the open
  const gap = [fell[0], bar('2026-10-13', '09:45', 96, 97, 95, 96)];
  assert.equal(json(run, `afterExit(${JSON.stringify(t)}, ${JSON.stringify([{ time: '2026-10-13T13:43:00.000Z', qty: 100, price: 100.5 }])}, ${JSON.stringify(gap)})`).out.price, 96);

  // a short: lows for, highs against; the 10:35 run to 110 takes its 104 stop
  const sh = json(run, `afterExit(${JSON.stringify({ ...t, direction: 'short', stop: 104 })}, ${JSON.stringify([{ time: '2026-10-13T14:31:00.000Z', qty: 100, price: 102 }])}, ${JSON.stringify(day)})`);
  assert.deepEqual([sh.score, sh.left, sh.against, sh.held, sh.out.price, sh.stopHit], [0.4, 100, -200, -200, 104, true], 'scored 99 to 104: the stop caps the range');

  // daily bars: context for any trade, and a position held overnight is held SWING_SESSIONS more on them
  const daily = [
    { date: '2026-10-13', open: 1, high: 200, low: 1, close: 1 }, // the exit's day: not after it
    { date: '2026-10-14', open: 102, high: 105, low: 101, close: 104 },
    { date: '2026-10-15', open: 104, high: 107, low: 103, close: 103 },
    { date: '2026-10-16', open: 103, high: 104, low: 99, close: 100 },
  ];
  const ctx = json(run, `afterExit(${JSON.stringify(t)}, ${JSON.stringify(sold)}, ${JSON.stringify(day)}, ${JSON.stringify(daily)})`);
  assert.deepEqual(ctx.sessions.map(x => x.n), [1, 3], 'ten sessions aren\'t there yet');
  assert.deepEqual(ctx.sessions[0], { n: 1, best: 105, close: 104, bestPct: 2.94, closePct: 1.96, bestR: 1.5, closeR: 1 });
  assert.equal(ctx.out.how, 'close', 'a day trade is still held to its day\'s close');
  const swing = { ...t, openedAt: '2026-10-12T14:00:00.000Z' };
  const sw = json(run, `afterExit(${JSON.stringify(swing)}, ${JSON.stringify(sold)}, ${JSON.stringify(day)}, ${JSON.stringify(daily)})`);
  assert.deepEqual([sw.out, sw.held], [{ price: 100, date: '2026-10-16', time: '', how: 'sessions', sessions: 3 }, -200], 'opened the day before: held the 3 sessions there are so far');
  const moved = json(run, `afterExit(${JSON.stringify({ ...swing, movedTo: 100.5 })}, ${JSON.stringify(sold)}, ${JSON.stringify(day)}, ${JSON.stringify(daily)})`);
  assert.deepEqual([moved.out.price, moved.out.date, moved.out.how, moved.held], [100.5, '2026-10-16', 'stop', -150], 'the stop where you moved it');
  // a trim before the stop was raised past its price: judged against the stop in force then, not the later one
  const trail = [{ stopPrice: 98, entered: '2026-10-13T13:40:00.000Z' }, { stopPrice: 103, entered: '2026-10-13T14:40:00.000Z' }];
  const trimmed = json(run, `afterExit(${JSON.stringify({ ...t, stopTrail: trail })}, ${JSON.stringify([{ time: '2026-10-13T14:31:00.000Z', qty: 50, price: 102 }, { time: '2026-10-13T19:56:00.000Z', qty: 50, price: 108 }])}, ${JSON.stringify(day)})`);
  assert.deepEqual([trimmed.left, trimmed.held], [400, 300], 'the 102 trim held with the 98 stop: ran to 110, closed 108');
  const atMoved = json(run, `afterExit(${JSON.stringify({ ...t, movedTo: 102 })}, ${JSON.stringify(sold)}, ${JSON.stringify(day)})`);
  assert.deepEqual([atMoved.held, atMoved.out.how, atMoved.left, atMoved.verdict], [0, 'stop', 0, 'good'], 'out at the stop you moved up: nothing to hold, judged up to the exit (102 of 99 to 103)');

  const noStop = json(run, `afterExit(${JSON.stringify({ ...long })}, ${JSON.stringify(sold)}, ${JSON.stringify(day)})`);
  assert.deepEqual([noStop.held, noStop.stop], [600, null], 'no stop: held to the close');
  assert.equal(run(`afterExit(${JSON.stringify({ ...t, legs: [] })}, ${JSON.stringify(sold)}, ${JSON.stringify(day)})`), null, 'spreads');
  assert.equal(run(`afterExit(${JSON.stringify(t)}, [], ${JSON.stringify(day)})`), null, 'no exits yet');
  assert.equal(run(`afterExit(${JSON.stringify(t)}, ${JSON.stringify(sold)}, [])`), null, 'no bars');
});

test('the stop check: how far past the stop, whether it came back, the stop that would have held at the same risk', async () => {
  const { run } = await app();
  const t = { ...long, stop: 98, closedAt: '2026-10-13T13:42:00.000Z', status: 'loss', pnl: -200, r: -1 };
  const out = [{ time: '2026-10-13T13:42:00.000Z', qty: 100, price: 98 }];
  // stopped at 98 in the 09:40 bar, 25 cents through it, then it ran to 104
  const shook = [bar('2026-10-13', '09:40', 100, 100.5, 97.75, 98.2), bar('2026-10-13', '09:45', 98.2, 101, 98, 100.8), bar('2026-10-13', '09:50', 100.8, 104, 100.5, 103.5)];
  const c = json(run, `stopCheck(${JSON.stringify(t)}, ${JSON.stringify(out)}, ${JSON.stringify(shook)})`);
  assert.deepEqual([c.verdict, c.stopped, c.cameBack, c.swept], ['shaken', true, true, true]);
  assert.deepEqual([c.overshoot, c.overshootR, c.worst], [0.25, 0.13, { price: 97.75, date: '2026-10-13', time: '09:40' }], '0.25 × 100 of a $200 risk');
  assert.equal(c.bestAfterR, 2, 'back to 104: +2R from the entry');
  assert.deepEqual([c.heldStop, c.heldDistance, c.heldSize], [97.74, 1.13, 88], 'a cent under the low, 13% wider: 88 shares for the same $200');
  assert.deepEqual([c.heldPnl, c.heldR, c.r, c.end.how, c.end.price], [308, 1.54, -1, 'close', 103.5], 'held to the 103.50 close with it');
  assert.equal(c.heatR, -1.12, 'down to 97.75 while it was open');

  // stopped, and it kept going: the stop was right
  const fell = [shook[0], bar('2026-10-13', '09:45', 98, 98.5, 96, 96.5), bar('2026-10-13', '09:50', 96.5, 97, 95, 95.5)];
  const right = json(run, `stopCheck(${JSON.stringify(t)}, ${JSON.stringify(out)}, ${JSON.stringify(fell)})`);
  assert.deepEqual([right.verdict, right.cameBack, right.overshootR, right.swept], ['right', false, 1.5, false]);

  // a winner: judged while it was open, and out at your own exit with the size the tighter stop buys
  const win = { ...long, stop: 97, risk: 300, r: 0.67 };
  const sold = [{ time: '2026-10-13T14:31:00.000Z', qty: 100, price: 102 }];
  const room = json(run, `stopCheck(${JSON.stringify(win)}, ${JSON.stringify(sold)}, ${JSON.stringify(BARS)})`);
  assert.deepEqual([room.verdict, room.stopped, room.heatR, room.overshoot], ['room', false, -0.33, 0], 'never within half of the 3 points to its stop');
  assert.deepEqual([room.heldStop, room.heldDistance, room.heldSize, room.heldPnl, room.end.how], [98.5, 0.5, 200, 400, 'exit'],
    'a cent under the 99 low would be a third of the stop: held at half of it, never tighter; the 10:35 run after the exit doesn\'t count');
  const roomier = json(run, `stopCheck(${JSON.stringify({ ...win, stop: 98.5, risk: 150 })}, ${JSON.stringify(sold)}, ${JSON.stringify(BARS)})`);
  assert.deepEqual([roomier.heldStop, roomier.heldSize], [98.99, 148], 'past half the stop: a cent under the low');
  const close = json(run, `stopCheck(${JSON.stringify({ ...win, stop: 98.9, risk: 110 })}, ${JSON.stringify(sold)}, ${JSON.stringify(BARS)})`);
  assert.deepEqual([close.verdict, close.heatR], ['close', -0.91], 'came within a tenth of it');

  // held overnight: the sessions after the stop-out count, on the daily bars
  const swing = { ...t, openedAt: '2026-10-12T14:00:00.000Z' };
  const daily = [{ date: '2026-10-14', open: 97, high: 101, low: 96, close: 100.5 }];
  const sw = json(run, `stopCheck(${JSON.stringify(swing)}, ${JSON.stringify(out)}, ${JSON.stringify(fell)}, ${JSON.stringify(daily)})`);
  assert.deepEqual([sw.verdict, sw.end.how, sw.end.date], ['shaken', 'sessions', '2026-10-14'], 'back over 100 the next day');
  assert.equal(json(run, `stopCheck(${JSON.stringify(t)}, ${JSON.stringify(out)}, ${JSON.stringify(fell)}, ${JSON.stringify(daily)})`).verdict, 'right', 'a day trade stops at its day');

  for (const [x, why] of [[{ ...t, stop: null }, 'no stop'], [{ ...t, status: 'open', closedAt: null }, 'open'], [{ ...t, legs: [] }, 'a spread'], [{ ...t, risk: null }, 'no risk']])
    assert.equal(run(`stopCheck(${JSON.stringify(x)}, ${JSON.stringify(out)}, ${JSON.stringify(shook)})`), null, why);
});

test('the exit and the stop in one sentence: sold too early, out late, a good exit; shaken out, room to spare', async () => {
  const { run } = await app();
  const t = { assetType: 'EQUITY', direction: 'long' };
  const a = { verdict: 'early', held: 420, heldR: 2.1, best: { price: 110 }, gave: 0, gaveR: 0 };
  const say = x => json(run, `exitSay(${JSON.stringify(t)}, ${JSON.stringify(x)})`);
  assert.deepEqual(say(a), ['bad', 'Sold too early: holding on with your stop would have made <b>+$420.00 (+2.10R)</b> more (it reached $110.00).']);
  assert.deepEqual(say({ ...a, held: -100, heldR: -0.5, out: { how: 'close' } }), ['', 'Out before the best of the move (it reached $110.00), but holding on with your stop would have made $100.00 (0.50R) less: it gave it back by the close.'], 'the stop never reached: it says so');
  assert.match(say({ ...a, held: -100, heldR: -0.5, out: { how: 'stop' } })[1], /: it came back to your stop\.$/);
  assert.deepEqual(say({ ...a, verdict: 'late', held: -50, heldR: -0.25, gave: 300, gaveR: 1.5 }), ['bad', 'Out late: you gave back <b>$300.00 (1.50R)</b> from the best while you held, and holding on with your stop would have made $50.00 (0.25R) less.']);
  assert.deepEqual(say({ ...a, verdict: 'good', held: -80, heldR: -0.4 }), ['good', 'Good exit: holding on with your stop would have made $80.00 (0.40R) less.']);
  assert.deepEqual(say({ ...a, verdict: 'good', held: null }), ['good', 'Good exit.']);
  const c = { verdict: 'room', heatR: -0.33, heldStop: 98.5, heldDistance: 0.5, heldSize: 200, heldPnl: 400, heldR: 1.33, r: 0.67, stop: 97, overshoot: 0, overshootR: 0, end: { how: 'exit' } };
  assert.deepEqual(json(run, `stopSay(${JSON.stringify(t)}, ${JSON.stringify(c)})`), ['', 'Room to spare: it came no closer than −0.33R to your stop. A $98.50 stop (50% tighter) would have held: 200 shares at the same risk, <b>+$400.00 (+1.33R)</b> instead of +0.67R at your exit.']);
});

test('the exit in words: one price or the average of several, and how much is closed while it\'s open', async () => {
  const { run } = await app();
  const t = { avgExit: 0.71, exits: 3, entryQty: 100, openQty: 40, direction: 'long', status: 'open' };
  assert.deepEqual(json(run, `exitParts(${JSON.stringify(t)})`), { avg: true, closed: 60, verb: 'sold' });
  assert.equal(run(`exitLineLabel(${JSON.stringify(t)})`), 'avg exit 0.71 · 60 of 100', 'trimmed, still open');
  assert.equal(run(`exitLineLabel(${JSON.stringify({ ...t, openQty: 0, status: 'win' })})`), 'avg exit 0.71', 'closed in pieces');
  assert.equal(run(`exitLineLabel(${JSON.stringify({ ...t, exits: 1, openQty: 0, status: 'win' })})`), 'exit 0.71', 'one exit');
  assert.equal(json(run, `exitParts(${JSON.stringify({ ...t, direction: 'short' })})`).verb, 'bought back');
  assert.equal(json(run, `exitParts(${JSON.stringify({ ...t, legs: [] })})`).verb, 'closed', 'a spread');
  assert.equal(run(`exitParts(${JSON.stringify({ ...t, avgExit: null, exits: 0 })})`), null, 'nothing closed yet');
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
  assert.match(head(), /<button class="jt-back" data-action="closeJournalTrade">[^]*?All trades</);
  assert.match(head(), /id="jtTitle">AAPL<\/span>/);
  assert.match(head(), /Long 100 · 10\/1, 10:30 AM · <button class="pos-link" data-action="editJournalTrade"/);
  assert.match(head(), /<dt>Avg entry<\/dt><dd class="">\$100\.02<\/dd>[^]*<dt>Avg exit<\/dt><dd class="">\$94\.98<\/dd>[^]*<dt>P&amp;L %<\/dt><dd class="journal-sell">−5\.04%<\/dd>[^]*<dt>P&amp;L<\/dt><dd class="journal-sell">−\$504\.00<span class="pos-sub">before fees/, 'the numbers up top');
  assert.ok(supabase.reads.some(r => r.table === 'bars_5m' && r.cols === 'day,bars'), 'the saved bars are read');
  assert.equal(state.journalTrade.five.length, 5, 'the hold\'s days, regular hours');
  assert.match(body(), /<dt>MFE<\/dt><dd class="journal-buy">\+\$398\.00<span class="pos-sub">\+0\.79R · best \$104\.00<\/span>/, '(104 − 100.02) × 100, the 10:25 bar before the entry left out');
  assert.match(body(), /<dt>MAE<\/dt><dd class="journal-sell">−\$552\.00<span class="pos-sub">−1\.10R · worst \$94\.50<\/span>/);
  assert.match(body(), /<dt>Exit efficiency<\/dt><dd class="">—<span class="pos-sub">winners only<\/span>/);
  assert.match(body(), /From 4 five-minute bars while it was open/);
  // After the exit: stopped at 94.98 on 10/2 in the 11:00 bar, 5% up the 94.50 to 104 range from the entry, no bars after
  assert.match(body(), /After the exit<\/div><p class="jt-say">Out at your stop: the stop check below says whether it was too tight\.<\/p><dl class="jt-stats jt-after">/);
  // Stop check: 50 cents through the 95 stop, and no bars after the stop-out here to come back on
  assert.match(body(), /Stop check<\/div><p class="jt-say jt-say-good">Right to stop: it went \$0\.50 \(0\.10R\) past your \$95\.00 stop and never came back to your entry\.<\/p>/);
  assert.match(body(), /<dt>Past your stop<\/dt><dd class="journal-sell">\$0\.50<span class="pos-sub">0\.10R · low \$94\.50 at 11:00 ET<\/span>/, 'a sweep: under a quarter of the stop distance');
  assert.match(body(), /<dt>Came back<\/dt><dd class="journal-buy">No</);
  assert.match(body(), /<dt>Exit score<\/dt><dd class="">5% <span class="journal-tag journal-tag-quiet">Stopped out<\/span><span class="pos-sub">out at your stop<\/span>/);
  assert.match(body(), /<dt>Left on the table<\/dt><dd class="">—<span class="pos-sub">no bars after it<\/span>/);
  assert.match(body(), /<dt>If held<\/dt><dd class="">\$0\.00<span class="pos-sub">\+?0\.00R · stopped \$94\.98 at 11:00 ET<\/span>/, 'out at the stop: holding ends there too');
  assert.match(body(), /<p class="hint">Out at the stop, where holding on would have ended too, so nothing after it counts; all 100 against where each got out\./);
  assert.match(body(), /<td>10\/1, 10:30 AM<\/td><td class="journal-buy">Buy<\/td><td>100<\/td><td>\$100\.02<\/td>/, 'the fills, in New York time');
  assert.match(body(), /\$95\.00 <span class="journal-tag journal-tag-quiet">first<\/span><\/td><td>filled<\/td>/, 'the stop orders');
  assert.match(elements.get('jtStatusD').textContent, /Add a Tradier key or log in to Schwab in Settings for the daily chart/);
  run('editJournalTrade()');
  assert.equal(state.openSheetName, 'tradeReview');
  run('closeSheet(); closeJournalTrade()');
  assert.equal(state.journalTrade, null);
  assert.equal(elements.get('journalSection').style.display, '');
  assert.equal(elements.get('journalTradeSection').style.display, 'none');
});

test('Share: one tap copies a card image with the entry, the stop, the exit, the result, the setup and the entry tactic', async t => {
  const { run, head } = await page({}, t);
  run(`openJournalTrade('${KEY}')`);
  await settle();
  assert.match(head(), /data-action="editJournalTrade"[^>]*>Edit<\/button> · <button class="pos-link jt-share-link" data-action="shareJournalTrade"[^>]*><svg[^]*?<\/svg>Share</);
  // the review's labels: a setup and an entry tactic
  run(`journalReview = { ...(journalReview || {}), reviews: {}, days: {}, library: [], weekly: {}, labels: { '${KEY}': [{ kind: 'setup', value: 'ema21_bounce' }, { kind: 'tactic', value: 'pivot15' }] } }`);
  run('var spec, name; drawShareCard = s => { spec = s; return {}; }; shareCanvasToClipboard = (c, n) => { name = n; }; shareJournalTrade()');
  const spec = json(run, 'spec');
  assert.deepEqual(spec.title.map(p => p.t), ['AAPL  ', 'LONG']);
  assert.match(spec.sub, /^Closed trade · opened 10\/1\/2026 10:30 AM ET · held /);
  assert.deepEqual(spec.stats.map(s => [s.label, s.value, s.sub]), [
    ['Entry', '$100.02', ''],
    ['Stop', '$95.00', '5.0% away · stop order'],
    ['Exit', '$94.98', ''],
    ['Result', '−1.00R', '−5.04%'],
  ], 'no dollars or share count');
  assert.deepEqual(spec.details, [{ label: 'Setup', value: '21 EMA bounce' }, { label: 'Entry tactic', value: '15m pivot' }]);
  assert.equal(run('name'), 'AAPL-trade');
});

test('the share icon on a trade\'s card copies that trade\'s card, without opening it', async t => {
  const { run, state, elements } = await page({}, t);
  const list = elements.get('journalList')?.innerHTML || elements.get('journalSection').innerHTML;
  assert.match(list, new RegExp(`<button class="journal-share-btn" data-action="shareJournalTrade" data-arg="${KEY.replace(/[|.]/g, '\\$&')}" aria-label="Share AAPL as an image"`), 'beside its side tags');
  run(`var spec; drawShareCard = s => { spec = s; return {}; }; shareCanvasToClipboard = () => {}; shareJournalTrade('${KEY}')`);
  assert.deepEqual(json(run, 'spec').title.map(p => p.t), ['AAPL  ', 'LONG']);
  assert.equal(state.journalTrade, null, 'the list stays: no trade page opened');
  assert.equal(run("shareButton({ key: 'x', label: 'X', status: 'history', avgEntry: 0 })"), '', 'none before your history');
});

test('Share on an open trade: where it stands now in R against the stop, the part already closed, or just open', async () => {
  const { run } = await app();
  const AT = Date.parse('2026-10-16T18:00:00Z');
  const open = { key: 'k', label: 'AAPL', symbol: 'AAPL', assetType: 'EQUITY', direction: 'long', status: 'open', avgEntry: 100, avgExit: null, exits: 0, entryQty: 100, openQty: 100, stop: 95, stopSource: 'schwab', movedTo: null, r: null, rBasis: 'stop', openedAt: '2026-10-16T14:00:00.000Z', holdMs: null, pnl: 0 };
  const spec = (t, now) => json(run, `tradeShareSpec(${JSON.stringify(t)}, ${JSON.stringify(now)})`);
  let s = spec(open, { price: 103, at: AT });
  assert.match(s.sub, /^Open trade · opened 10\/16\/2026 10:00 AM ET · held .+ so far$/);
  assert.deepEqual(s.stats.map(x => [x.label, x.value, x.sub]), [
    ['Entry', '$100.00', ''], ['Stop', '$95.00', '5.0% away · stop order'], ['Now', '+0.60R', 'at $103.00 · +3.00% · 2:00 PM ET'],
  ], 'no exit yet: no exit tile, and now in place of a result');
  s = spec({ ...open, avgExit: 102, exits: 2, openQty: 40, pnl: 120 }, { price: 99, at: AT });
  assert.deepEqual(s.stats.slice(2).map(x => [x.label, x.value, x.sub]), [['Avg exit', '$102.00', '+0.40R · part closed'], ['Now', '−0.20R', 'at $99.00 · −1.00% · 2:00 PM ET']]);
  s = spec({ ...open, direction: 'short', avgEntry: 50, stop: 52 }, { price: 49, at: AT });
  assert.equal(s.title[1].t, 'SHORT');
  assert.deepEqual([s.stats[2].value, s.stats[2].sub], ['+0.50R', 'at $49.00 · +2.00% · 2:00 PM ET'], 'a short gains as it falls');
  assert.deepEqual(spec(open, null).stats[2], { label: 'Status', value: 'Open', sub: 'no live price' });
  assert.deepEqual([spec({ ...open, stop: null, stopSource: null, rBasis: null }, { price: 103, at: AT }).stats[2].value], ['+3.00%'], 'no stop: the move in percent');
  assert.equal(run(`sharePriceSymbol(${JSON.stringify({ ...open, assetType: 'OPTION', symbol: 'AAPL  261120C00200000' })})`), 'AAPL261120C00200000', "a contract's own price");
  assert.equal(run(`sharePriceSymbol(${JSON.stringify({ ...open, assetType: 'SPREAD', legs: [] })})`), '', 'none for a spread');
  assert.equal(run(`sharePriceSymbol(${JSON.stringify({ ...open, status: 'win' })})`), '', 'none once closed');
});

test('Share on an open trade reads its price in the same tap, and the card shows it', async t => {
  const supabase = fakeRecords([{ kind: 'order', record_id: '601', account: '6789', entered_at: '2026-10-01T14:30:00Z', data: { ...ENTRY, orderId: 601, childOrderStrategies: [] } }]);
  const fetch = async url => String(url).includes('/markets/quotes')
    ? new Response(JSON.stringify({ quotes: { quote: { symbol: 'AAPL', last: 104, bid: 103.98, ask: 104.02 } } }), { status: 200 })
    : new Response(JSON.stringify({}), { status: 200 });
  globalThis.getComputedStyle = () => ({ getPropertyValue: n => n });
  t.after(() => { delete globalThis.getComputedStyle; });
  const a = await app({ supabase, session: SESSION, fetch, charts: fakeCharts() });
  a.elements.get('apiKey').value = 'test-key';
  a.run("setView('journal')");
  await a.run('loadJournal()');
  a.run(`openJournalTrade('${KEY}')`);
  await settle();
  a.run('var spec, handed; drawShareCard = s => { spec = s; return {}; }; shareCanvasToClipboard = c => { handed = c; }');
  const drawn = a.run('shareJournalTrade()');
  assert.ok(a.run('handed instanceof Promise'), 'the clipboard gets the card inside the tap, as a promise of it');
  assert.equal(a.run('spec'), undefined, 'drawn once the price is in');
  await drawn;
  const spec = json(a.run, 'spec');
  assert.match(spec.sub, /^Open trade · /);
  assert.deepEqual(spec.stats.map(x => x.label), ['Entry', 'Stop', 'Now']);
  assert.equal(spec.stats[2].value, '+3.98%', 'no stop on this one: the move in percent');
  assert.match(spec.stats[2].sub, /^at \$104\.00 · \d+:\d\d [AP]M ET$/);
});

test('the 5-minute chart: candles, 8 EMA and volume, the fills marked, entry, exit and stop drawn, the readout', async t => {
  const { run, chart, charts, elements } = await page({}, t);
  run(`openJournalTrade('${KEY}')`);
  await settle();
  const c = chart('jtChart5');
  assert.ok(c, 'drawn into the 5-minute box');
  assert.equal(c.options.handleScroll.vertTouchDrag, false, 'a vertical swipe on a phone still moves the page');
  assert.equal(c.options.layout.textColor, '--text3');
  const [candles, ema, volume, vwap] = c.series;
  assert.deepEqual([candles.type, ema.type, volume.type, vwap.type], ['Candlestick', 'Line', 'Histogram', 'Line']);
  assert.equal(vwap.options.color, '--teal', 'VWAP in teal: blue is the entry line and the buys');
  assert.deepEqual(vwap.data.map(p => p.color), [undefined, undefined, 'transparent', undefined, undefined], "10/1's last bar goes transparent, so the line breaks before 10/2");
  assert.ok(Math.abs(vwap.data[4].value - 97.5) < 1e-9, "10/2's own VWAP, started over");
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
  assert.match(legend(), /VWAP <b style="color:--teal">97\.50<\/b>/);
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

test('a TradingView | Ours switch: our canvas charts in the same place, the same bars and framing, kept on this device', async t => {
  const storage = new Map();
  const { run, chart, elements, charts, state } = await page({ storage }, t);
  run(`openJournalTrade('${KEY}')`);
  await settle();
  const sw = () => elements.get('jtKindSwitch').innerHTML;
  assert.match(sw(), /data-action="setJournalChartKind" data-arg="tv" class="active"/, 'TradingView by default');
  assert.equal(elements.get('jtClassic5').style.display, 'none');
  run("setJournalChartKind('ours')");
  assert.equal(storage.get('journal_chart_kind'), 'ours');
  assert.match(sw(), /data-arg="ours" class="active"/);
  assert.equal(elements.get('jtClassic5').style.display, '', 'our canvas shows');
  assert.equal(elements.get('jtChart5').style.display, 'none', "TradingView's steps aside");
  assert.equal(elements.get('jtLegend5').style.display, 'none');
  assert.doesNotMatch(elements.get('jtTools5').innerHTML, /toggleJournalLog/, 'no log scale on ours');
  assert.match(elements.get('jtTools5').innerHTML, /setJournalInterval/, 'the intervals still apply');
  assert.deepEqual(json(run, "journalTradeRange('5')"), { start: 0, end: 5 }, 'framed on the hold, like the TradingView chart');
  assert.equal(state.journalTrade.classic[5].vwap.length, 5, 'ours draws VWAP too');
  assert.equal(state.journalTrade.classic.D, null);
  run('setJournalInterval(65)');
  assert.deepEqual(json(run, "journalTradeRange('5')"), { start: 0, end: 4 }, 'the 65-minute bars, framed again');
  run("setJournalChartKind('tv')");
  assert.equal(elements.get('jtChart5').style.display, '');
  assert.equal(chart('jtChart5').series[0].data.length, 4, 'the same bars on both');

  const fresh = fakeCharts();
  const again = await page({ storage, charts: fresh }, t);
  again.run("setJournalChartKind('ours')");
  again.run(`openJournalTrade('${KEY}')`);
  await settle();
  assert.equal(fresh.charts.length, 0, "ours never loads the library");
  assert.equal(again.elements.get('jtClassic5').style.display, '');
  assert.ok(charts.charts.length >= 1);
});

test('while the library loads, the chart says so', async t => {
  let arrive;
  const lib = fakeCharts();
  const { run, elements, chart } = await page({ charts: () => new Promise(r => { arrive = () => r(lib); }) }, t);
  run(`openJournalTrade('${KEY}')`);
  await settle();
  assert.equal(elements.get('jtStatus5').textContent, 'Loading the charts…');
  arrive();
  await settle();
  assert.equal(elements.get('jtStatus5').textContent, '');
  assert.ok(lib.charts.some(c => c.container.id === 'jtChart5'));
});

test("the chart library didn't load: the page says so and keeps the rest", async t => {
  const { run, elements, body } = await page({ charts: async () => { throw new Error('offline'); } }, t);
  run(`openJournalTrade('${KEY}')`);
  await settle();
  assert.match(elements.get('jtStatus5').textContent, /Couldn't load the charts/);
  assert.match(body(), /<dt>MFE<\/dt>/);
});

test('an open trade trimmed twice: how much was sold at what average, and how much is still open', async () => {
  const supabase = fakeRecords([{ kind: 'order', record_id: '601', account: '6789', entered_at: '2026-10-01T14:30:00Z', data: {
    ...ENTRY, orderId: 601, childOrderStrategies: [] } },
  ...[[602, 30, 101, '2026-10-02T15:00:00+0000'], [603, 30, 103, '2026-10-05T15:00:00+0000']].map(([id, qty, price, time]) => ({
    kind: 'order', record_id: String(id), account: '6789', entered_at: time.replace('+0000', 'Z'), data: {
      orderId: id, enteredTime: time, status: 'FILLED',
      orderLegCollection: [{ legId: 1, instruction: 'SELL', quantity: qty, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
      orderActivityCollection: [{ activityType: 'EXECUTION', activityId: id * 10, executionLegs: [{ legId: 1, quantity: qty, price, time }] }],
    } }))]);
  const a = await app({ supabase, session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  a.run(`openJournalTrade('${KEY}')`);
  await settle();
  assert.match(a.elements.get('jtHead').innerHTML, /Long 100 · 40 open · /);
  assert.match(a.elements.get('jtHead').innerHTML, /<dt>Avg exit<\/dt><dd class="">\$102\.00<span class="pos-sub">60 sold<\/span>/);
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
  // the sessions after the 94.98 stop-out, from the daily bars: highs of 101, closes of 100
  assert.match(elements.get('jtBody').innerHTML, /<dt>Next day<\/dt><dd class="">\+6\.34%<span class="pos-sub">best \$101\.00 · close \+5\.29% · \+1\.00R<\/span>/);
  assert.match(elements.get('jtBody').innerHTML, /<dt>Next 10 days<\/dt>/);
  assert.match(elements.get('jtBody').innerHTML, /Next day and on: the daily bars, no stop\./);
  // held overnight: while the daily bars are loading, After the exit and Stop check wait for them
  state.journalTrade.loadingD = true;
  run('renderJournalTrade()');
  assert.match(elements.get('jtBody').innerHTML, /After the exit<\/div><p class="hint">Loading the daily bars: a position held overnight is held on past its exit on them\.<\/p>/);
  assert.match(elements.get('jtBody').innerHTML, /Stop check<\/div><p class="hint">Loading the daily bars for the days after the stop\.<\/p>/);
  state.journalTrade.loadingD = false;
  run('renderJournalTrade()');
  // with the days after on the daily bars, the stop-out came back over the 100.02 entry: shaken out
  assert.match(elements.get('jtBody').innerHTML, /<p class="jt-say jt-say-bad">Shaken out: it went only \$0\.50 \(0\.10R\) past your \$95\.00 stop, then came back to \+0\.20R\. A \$94\.49 stop \(10% wider\) would have held: 90 shares at the same risk, <b>−\$1\.80 \(0\.00R\)<\/b> instead of −1\.00R by the end of the hold\.<\/p>/, 'back over the entry, but it closed under it: the wider stop would only have broken even');
  const c = chart('jtChartD');
  assert.equal(c.series[0].data[0].time, '2026-08-01', 'a daily bar is its day');
  assert.equal(c.series[2].data[0].value, 1, 'with its volume');
  assert.equal(c.series.length, 3, 'no VWAP on the daily chart');
  assert.doesNotMatch(elements.get('jtLegendD').innerHTML, /VWAP/);
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
  run("setJournalChartKind('ours'); setJournalRange('63')");
  assert.deepEqual(json(run, "journalTradeRange('D')"), { start: end - 63, end }, 'our daily chart takes the same ranges');
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
  // the journal's background save ran within the hour, so the only Tradier call is the trade page's own
  const storage = new Map([['journal_bars', JSON.stringify({ user: 'user-1', at: Date.now(), saved: 0, symbols: 0, through: '', failed: [], error: '' })]]);
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

// 2 XLU calls bought 10/16 at 10:00 ET and sold at 11:00, on the day the page is opened
const XLU = 'XLU   261120C00080000';
const XLU_ORDERS = [[701, 'BUY_TO_OPEN', 1.2, '2026-10-16T14:00:00+0000'], [702, 'SELL_TO_CLOSE', 1.5, '2026-10-16T15:00:00+0000']].map(([id, instruction, price, time]) => ({
  kind: 'order', record_id: String(id), account: '6789', entered_at: time.replace('+0000', 'Z'), data: {
    orderId: id, enteredTime: time, status: 'FILLED',
    orderLegCollection: [{ legId: 1, instruction, quantity: 2, instrument: { symbol: XLU, assetType: 'OPTION' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: id * 10, executionLegs: [{ legId: 1, quantity: 2, price, time }] }],
  } }));

async function xluPage(now, t) {
  globalThis.getComputedStyle = () => ({ getPropertyValue: n => n });
  t.after(() => { delete globalThis.getComputedStyle; });
  const calls = [];
  const fetch = async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/markets/history')) return new Response(JSON.stringify({ history: null }), { status: 200 });
    if (!u.pathname.endsWith('/markets/timesales')) throw new Error('unexpected ' + url);
    calls.push([u.searchParams.get('symbol'), u.searchParams.get('start'), u.searchParams.get('end')]);
    const spans = u.searchParams.get('start') <= '2026-10-16 04:00' && u.searchParams.get('end') >= '2026-10-16 20:00'; // any span with the day in it
    const data = spans ? [10, 11].map(h => ({ time: `2026-10-16T${h}:00:00`, open: 1.2, high: 1.6, low: 1.1, close: 1.5, volume: 9 })) : [];
    return new Response(JSON.stringify({ series: data.length ? { data } : null }), { status: 200 });
  };
  const supabase = fakeRecords(XLU_ORDERS), charts = fakeCharts();
  const a = await app({ supabase, session: SESSION, fetch, clock: true, now, charts });
  a.elements.get('apiKey').value = 'test-key';
  a.run("setView('journal')");
  await a.run('loadJournal()');
  a.run(`openJournalTrade('6789|${XLU}|long|2026-10-16T14:00:00.000Z')`);
  await settle();
  const chart = id => charts.charts.find(c => c.container.id === id && !c.removed);
  return { ...a, calls, supabase, chart };
}

test("today's bars: straight from Tradier while the day is on, saved once extended hours end at 20:00 ET", async t => {
  const live = await xluPage(Date.parse('2026-10-16T21:00:00Z'), t); // 5pm ET, the trade closed this morning
  assert.ok(live.calls.some(c => c[0] === 'XLU261120C00080000' && c[1] === '2026-10-16 04:00' && c[2] === '2026-10-16 20:00'), "today asked of Tradier, on the contract's own symbol");
  assert.equal(live.state.journalTrade.five.length, 2, 'drawn from it');
  assert.equal(live.elements.get('jtStatus5').textContent, '');
  assert.equal([...live.supabase.bars.values()].filter(b => b.day === '2026-10-16').length, 0, 'not saved: the day isn\'t over');

  const done = await xluPage(Date.parse('2026-10-17T00:30:00Z'), t); // 8:30pm ET
  const saved = [...done.supabase.bars.values()].filter(b => b.day === '2026-10-16');
  assert.deepEqual(saved.filter(b => b.symbol.startsWith('XLU')).map(b => [b.symbol, b.bars.length]).sort(),
    [['XLU', 2], ['XLU261120C00080000', 2]], 'saved, the contract and its underlying');
  assert.ok(saved.some(b => b.symbol === 'SPY'), "and the market basket's day, from the journal's background save");
  assert.equal(done.state.journalTrade.five.length, 2, 'read back from the saved rows');
});

test("an option: its underlying's 5 minutes beside its own, the same interval and fills, no lines; a stock has none", async t => {
  const { state, elements, chart, calls, run } = await xluPage(Date.parse('2026-10-16T21:00:00Z'), t);
  assert.ok(calls.some(c => c[0] === 'XLU' && c[1] === '2026-10-16 04:00'), "today's underlying bars asked of Tradier");
  assert.equal(state.journalTrade.under.length, 2);
  assert.equal(elements.get('jtWrapU').style.display, '', 'shown for an option');
  assert.ok(elements.get('jtCharts').classList.contains('jt-under'), 'side by side on a wide screen');
  assert.equal(elements.get('jtStatusU').textContent, '');
  const own = chart('jtChart5'), under = chart('jtChartU');
  assert.ok(under, "drawn into the underlying's box");
  assert.deepEqual(under.series[0].lines, [], "no entry, exit or stop: they're the contract's prices");
  assert.equal(own.series[0].lines.length, 2, "the contract's own chart keeps entry and exit");
  assert.deepEqual(under.series[0].markers.map(m => [m.time, m.position]), [[Date.UTC(2026, 9, 16, 10, 0) / 1000, 'belowBar'], [Date.UTC(2026, 9, 16, 11, 0) / 1000, 'aboveBar']], 'the fills on the bars they happened in');
  assert.match(elements.get('jtLegendU').innerHTML, /XLU · 5m/);
  assert.match(elements.get('jtLegend5').innerHTML, /XLU261120C00080000 · 5m/);
  assert.match(elements.get('jtToolsU').innerHTML, /data-action="toggleJournalLog" data-arg="U"/);
  run('setJournalInterval(15)');
  assert.match(elements.get('jtLegendU').innerHTML, /XLU · 15m/, 'one interval for both');
  run("toggleJournalLog('U')");
  assert.equal(under.scales.right.mode, 1);
  assert.notEqual(own.scales.right.mode, 1, 'each its own log scale');
  run("setJournalChartKind('ours')");
  assert.equal(state.journalTrade.classic.U.bars.length, 2, 'ours draws it too');
});

test('a stock trade has no underlying chart', async t => {
  const { run, elements } = await page({}, t);
  run(`openJournalTrade('${KEY}')`);
  await settle();
  assert.equal(elements.get('jtWrapU').style.display, 'none');
  assert.equal(elements.get('jtCharts').classList.contains('jt-under'), false);
});

test('a trade with nothing saved says why', async t => {
  const { run, state, supabase, elements, chart } = await page({}, t);
  supabase.bars.clear();
  run(`openJournalTrade('${KEY}')`);
  await settle();
  assert.equal(state.journalTrade.five.length, 0);
  assert.equal(chart('jtChart5'), undefined, 'no bars, no chart');
  assert.match(elements.get('jtStatus5').textContent, /Add a Tradier key or log in to Schwab in Settings to load this trade(?:'|’)s 5-minute bars|No 5-minute bars were saved/);
});
