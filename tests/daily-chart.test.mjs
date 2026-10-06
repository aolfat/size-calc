// Run with: node --test
// Daily chart: the visible window (range chips, zoom, pan), its fitted price scale, and the gestures that drive it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { MIN_VIEW_BARS, panView, viewRange, zoomView } from '../src/core/chart-view.js';

// a steadily rising series, one dollar a session, so the fitted scale says which bars are on screen
const series = n => Array.from({ length: n }, (_, i) => ({ date: `d${i}`, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i }));

const touches = (...pts) => ({ touches: pts.map(([clientX, clientY]) => ({ clientX, clientY })) });
const event = e => ({ button: 0, clientY: 100, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {}, ...e });

// a recording canvas: listeners by type, a 458px box (400px of plot between the 6px and 52px gutters)
function fakeCanvas(el = {}) {
  const on = {};
  Object.assign(el, {
    style: el.style || {},
    addEventListener: (type, fn) => { (on[type] ||= []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 458, height: 260, right: 458, bottom: 260 }),
  });
  const fire = (type, e) => { e = event(e); for (const fn of on[type] || []) fn(e); return e; };
  return { el, fire };
}

// the real daily chart with its events wired to a recording canvas and window
async function dailyApp(opts) {
  const h = await app(opts);
  const canvas = fakeCanvas(h.elements.get('dailyChart'));
  const win = fakeCanvas({});
  globalThis.window.addEventListener = win.el.addEventListener;
  h.run(`dailyBars = ${JSON.stringify(series(260))}; initDailyChartEvents()`);
  return { ...h, canvas: canvas.fire, win: win.fire, view: () => h.run('viewRange(dailyView, dailyBars.length)') };
}

// ---------- view math ----------

test('the view window counts back from the latest bar and stays inside the series', () => {
  assert.deepEqual(viewRange({ count: 63, offset: 0 }, 260), { start: 197, end: 260 });
  assert.deepEqual(viewRange({ count: 63, offset: 10 }, 260), { start: 187, end: 250 });
  assert.deepEqual(viewRange({ count: 500, offset: 0 }, 260), { start: 0, end: 260 }, 'never wider than the series');
  assert.deepEqual(viewRange({ count: 63, offset: 999 }, 260), { start: 0, end: 63 }, 'cannot pan past the first bar');
  assert.deepEqual(viewRange({ count: 63, offset: -5 }, 260), { start: 197, end: 260 }, 'or past today');
  assert.deepEqual(viewRange({ count: 2, offset: 0 }, 260), { start: 260 - MIN_VIEW_BARS, end: 260 }, 'a floor on zoom');
  assert.deepEqual(viewRange({ count: 63, offset: 0 }, 40), { start: 0, end: 40 }, 'a short history shows everything');
  assert.deepEqual(viewRange({ count: 63, offset: 0 }, 0), { start: 0, end: 0 });
});

test('zoom keeps the bar under the anchor in place', () => {
  assert.deepEqual(viewRange(zoomView({ count: 100, offset: 0 }, 260, 2, 1), 260), { start: 210, end: 260 }, 'right edge: today stays pinned');
  const mid = zoomView({ count: 100, offset: 0 }, 260, 2, 0.5);
  assert.deepEqual(viewRange(mid, 260), { start: 185, end: 235 }, 'bar 210 stays centered');
  assert.deepEqual(viewRange(zoomView(mid, 260, 0.5, 0.5), 260), { start: 160, end: 260 }, 'and zooming out goes back');
  assert.deepEqual(viewRange(zoomView({ count: 200, offset: 30 }, 260, 0.1, 0.5), 260), { start: 0, end: 260 }, 'out to the whole series');
  // a slow pinch is many tiny steps: they add up instead of rounding away
  let v = { count: MIN_VIEW_BARS, offset: 0 };
  for (let i = 0; i < 10; i++) v = zoomView(v, 260, 1 / 1.02, 1);
  const r = viewRange(v, 260);
  assert.ok(r.end - r.start > MIN_VIEW_BARS);
});

test('pan moves the window by bars, back in time for positive values', () => {
  assert.deepEqual(viewRange(panView({ count: 63, offset: 0 }, 260, 10), 260), { start: 187, end: 250 });
  assert.deepEqual(viewRange(panView({ count: 63, offset: 10 }, 260, -25), 260), { start: 197, end: 260 });
  assert.equal(panView({ count: 63, offset: 0 }, 260, 2.4).offset, 2.4, 'fractions kept so slow drags add up');
});

// ---------- window, scale and controls ----------

test('the daily opens on three months and fits its price scale to the bars on screen', async () => {
  const { run } = await app();
  run(`dailyBars = ${JSON.stringify(series(260))}`);
  const g = run('dailyGeom(458)');
  assert.equal(g.start, 197);
  assert.equal(g.end, 260);
  assert.equal(g.slot, 400 / 63);
  // visible lows start at 99 + 197; the whole year would reach down to 99
  assert.ok(g.lo > 290 && g.lo < 296, `lo ${g.lo}`);
  assert.ok(g.hi > 360 && g.hi < 364, `hi ${g.hi}`);
  assert.equal(g.index(6), 197, 'first slot is the first visible bar');
  assert.equal(g.index(6 + 399), 259);
  assert.equal(g.index(3), -1, 'gutter');
  // click-to-stop reads the same scale the candles are drawn on
  assert.ok(Math.abs(run('dailyPriceAtY(12)') - g.hi) < 1e-9);
  assert.ok(Math.abs(run('dailyPriceAtY(238)') - g.lo) < 1e-9);
});

test('range chips set and remember the window; a gesture zoom lights none', async () => {
  const { run, storage } = await app();
  run(`dailyBars = ${JSON.stringify(series(260))}`);
  assert.equal(run('activeDailyRange()'), 63);
  run("actions.setDailyRange({ dataset: { arg: '21' } })");
  assert.equal(storage.get('daily_range'), '21');
  assert.deepEqual(run('viewRange(dailyView, 260)'), { start: 239, end: 260 });
  assert.equal(run('activeDailyRange()'), 21);
  run('dailyView = zoomView(dailyView, 260, 0.5, 1)');
  assert.equal(run('activeDailyRange()'), 0, 'custom zoom');
  run('dailyView = panView(dailyView, 260, 30)');
  run('setDailyRange(21)');
  assert.deepEqual(run('viewRange(dailyView, 260)'), { start: 239, end: 260 }, 'tapping the chip again resets to today');

  const again = await app({ storage });
  assert.equal(again.run('dailyView.count'), 21, 'next visit opens on the saved range');
  storage.set('daily_range', 'junk');
  assert.equal((await app({ storage })).run('dailyView.count'), 63);
});

test('panned back, the Today chip appears and returns to the latest session', async () => {
  const { run, elements } = await app();
  const today = elements.get('dailyToday');
  run(`dailyBars = ${JSON.stringify(series(260))}; drawDailyChart()`);
  assert.equal(today.style.display, 'none');
  run('dailyView = panView(dailyView, 260, 30); drawDailyChart()');
  assert.equal(today.style.display, '');
  run('actions.dailyToday()');
  assert.equal(run('dailyView.offset'), 0);
  assert.equal(run('dailyView.count'), 63, 'keeps the zoom');
  assert.equal(today.style.display, 'none');
});

test('a new symbol opens on the saved range; reloading the same one keeps the zoom', async () => {
  const fetch = async () => ({ ok: true, json: async () => ({ history: { day: series(260) } }) });
  const { run, elements } = await app({ fetch });
  elements.get('ticker').value = 'AAA';
  await run("fetchAdr('AAA')");
  run('dailyView = zoomView(dailyView, 260, 2, 0.5)');
  const zoomed = run('JSON.stringify(dailyView)');
  await run("fetchAdr('AAA')");
  assert.equal(run('JSON.stringify(dailyView)'), zoomed);
  elements.get('ticker').value = 'BBB';
  await run("fetchAdr('BBB')");
  assert.deepEqual(JSON.parse(run('JSON.stringify(dailyView)')), { count: 63, offset: 0 });
});

// ---------- touch: the shared long-press crosshair ----------

test('a second finger cancels the long-press instead of setting a stop', async () => {
  const { api, advance } = await app({ timers: 'fake' });
  const { el, fire } = fakeCanvas();
  const moves = [], ends = [];
  api.attachTouchCrosshair(el, t => moves.push(t), last => ends.push(last));
  fire('touchstart', touches([100, 100]));
  fire('touchstart', touches([100, 100], [200, 100]));
  await advance(300);
  assert.equal(moves.length, 0, 'the hold never arms');
  fire('touchend', { touches: [] });
  assert.deepEqual(ends, []);

  fire('touchstart', touches([100, 100]));
  await advance(300);
  assert.equal(moves.length, 1, 'armed');
  fire('touchstart', touches([100, 100], [200, 100]));
  assert.deepEqual(ends, [null], 'crosshair cancelled with no stop');
  fire('touchend', { touches: [] });
  assert.deepEqual(ends, [null], 'releasing does not set one either');
});

test('with gesture hooks, horizontal swipes pan and two fingers pinch; vertical swipes still scroll', async () => {
  const { api, advance } = await app({ timers: 'fake' });
  const { el, fire } = fakeCanvas();
  const calls = [], moves = [];
  api.attachTouchCrosshair(el, t => moves.push(t), () => {}, {
    start: () => calls.push('start'),
    pan: dx => calls.push(['pan', dx]),
    pinch: (scale, mid0, dMid) => calls.push(['pinch', scale, mid0, dMid]),
  });
  fire('touchstart', touches([100, 100]));
  assert.ok(!fire('touchmove', touches([102, 140])).prevented, 'vertical: the page scrolls');
  assert.ok(!fire('touchmove', touches([160, 150])).prevented, 'and stays a scroll');
  fire('touchend', { touches: [] });
  assert.deepEqual(calls, []);

  fire('touchstart', touches([100, 100]));
  assert.ok(fire('touchmove', touches([130, 104])).prevented, 'horizontal: the chart owns it');
  fire('touchmove', touches([160, 140]));
  fire('touchend', { touches: [] });
  assert.deepEqual(calls, ['start', ['pan', 30], ['pan', 60]]);

  calls.length = 0;
  fire('touchstart', touches([100, 100]));
  fire('touchstart', touches([100, 100], [200, 100]));
  assert.ok(fire('touchmove', touches([50, 100], [250, 100])).prevented);
  assert.deepEqual(calls, ['start', ['pinch', 2, 150, 0]]);
  fire('touchend', { touches: [] });
  await advance(300);
  assert.equal(moves.length, 0, 'no crosshair after a pinch');
});

// ---------- daily chart wiring ----------

test('ctrl+scroll and trackpad pinch zoom around the cursor; plain scroll passes to the page', async () => {
  const d = await dailyApp();
  assert.ok(!d.canvas('wheel', { deltaY: 40, deltaX: 0, clientX: 300 }).prevented);
  assert.deepEqual(d.view(), { start: 197, end: 260 });
  assert.ok(d.canvas('wheel', { deltaY: -40, deltaX: 0, ctrlKey: true, clientX: 406 }).prevented);
  const r = d.view();
  assert.equal(r.end, 260, 'anchored at the right edge');
  assert.ok(r.end - r.start < 63, 'zoomed in');
  d.canvas('wheel', { deltaY: 5000, deltaX: 0, metaKey: true, clientX: 206 });
  assert.ok(d.view().end - d.view().start > r.end - r.start, 'zoomed out');
});

test('horizontal swipes and shift+scroll pan the daily', async () => {
  const d = await dailyApp();
  assert.ok(d.canvas('wheel', { deltaX: -63.5, deltaY: 2 }).prevented);
  assert.deepEqual(d.view(), { start: 187, end: 250 }, '63.5px at 400/63 px a bar = 10 bars back');
  d.canvas('wheel', { deltaX: 0, deltaY: 63.5, shiftKey: true });
  assert.deepEqual(d.view(), { start: 197, end: 260 });
});

test('dragging pans the daily without also setting a stop; a plain click still sets one', async () => {
  const d = await dailyApp();
  d.run("quoteData = { symbol: 'TEST', last: 350, low: 340, high: 355 }");
  const stops = () => d.elements.get('stopLong').value + '|' + d.elements.get('stopShort').value;
  d.canvas('mousedown', { clientX: 200 });
  d.win('mousemove', { clientX: 202 });
  assert.deepEqual(d.view(), { start: 197, end: 260 }, 'a jitter is not a drag');
  d.win('mousemove', { clientX: 263.5 });
  d.win('mouseup', {});
  d.canvas('click', { clientX: 263.5 });
  assert.deepEqual(d.view(), { start: 187, end: 250 });
  assert.equal(stops(), '|');

  d.canvas('mousedown', { clientX: 100 });
  d.win('mouseup', {});
  d.canvas('click', { clientX: 100 });
  assert.notEqual(stops(), '|');
});

test('touch pinch and swipe drive the daily view', async () => {
  const d = await dailyApp({ timers: 'fake' });
  d.canvas('touchstart', touches([206, 100]));
  d.canvas('touchmove', touches([269.5, 102]));
  d.canvas('touchend', { touches: [] });
  assert.deepEqual(d.view(), { start: 187, end: 250 }, 'finger right = back in time');
  d.canvas('touchstart', touches([306, 100]));
  d.canvas('touchstart', touches([306, 100], [406, 100]));
  d.canvas('touchmove', touches([256, 100], [456, 100]));
  d.canvas('touchend', { touches: [] });
  const r = d.view();
  assert.ok(Math.abs(r.end - r.start - 32) <= 1, `about half: ${JSON.stringify(r)}`);
  assert.ok(r.start > 187 && r.end < 250, 'around the fingers');
});

test('Safari trackpad pinch zooms; on iOS the touch pinch owns it and gestures only block page zoom', async () => {
  const d = await dailyApp();
  assert.ok(d.canvas('gesturestart', { clientX: 406 }).prevented);
  d.canvas('gesturechange', { scale: 2, clientX: 406 });
  d.canvas('gestureend', {});
  assert.ok(Math.abs(d.view().end - d.view().start - 32) <= 1);

  const before = JSON.stringify(d.view());
  d.canvas('touchstart', touches([306, 100], [406, 100]));
  assert.ok(d.canvas('gesturestart', { clientX: 356 }).prevented);
  assert.ok(d.canvas('gesturechange', { scale: 3, clientX: 356 }).prevented);
  assert.equal(JSON.stringify(d.view()), before);
});
