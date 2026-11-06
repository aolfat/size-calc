// Run with: node --test
// The intraday chart sets the trade (owner request): press on the stop or the entry line and drag it. In Stocks & futures
// the direction follows the stop (above the entry is a short's); a stop let go on the adjusted LOD / HOD goes back to it,
// an entry let go on the price goes back to now, and the scale holds still while a line moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const NOON = Date.parse('2026-11-04T17:00:00Z'); // regular hours in New York: the entry 'now' is the last trade
const QUOTE = { symbol: 'RIOT', last: 16.71, low: 14.87, high: 17.12, bid: 16.7, ask: 16.72, close: null, prevclose: 14.76, type: 'stock' };
const BARS = [
  { t: '2026-11-04T09:30:00', o: 15.4, h: 15.95, l: 14.87, c: 15.6, v: 1 },
  { t: '2026-11-04T09:35:00', o: 15.6, h: 16.9, l: 15.5, c: 16.8, v: 1 },
  { t: '2026-11-04T09:40:00', o: 16.8, h: 17.12, l: 16.6, c: 16.71, v: 1 },
];

const event = e => ({ button: 0, clientY: 100, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...e });

// the chart canvas as a recording element: a 260px box at the top of the page (no clientWidth, so nothing paints)
async function chartApp(opts = {}) {
  const h = await app({ width: 1400, clock: true, now: NOON, ...opts });
  const on = {}, win = {};
  const canvas = h.elements.get('chart');
  Object.assign(canvas, {
    addEventListener: (type, fn) => { (on[type] ||= []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 458, height: 260, right: 458, bottom: 260 }),
  });
  globalThis.requestAnimationFrame = fn => { fn(); return 0; }; // every move lands at once
  globalThis.window.addEventListener = (type, fn) => { (win[type] ||= []).push(fn); };
  globalThis.window.removeEventListener = (type, fn) => { win[type] = (win[type] || []).filter(f => f !== fn); };
  h.run(`quoteData = ${JSON.stringify(QUOTE)}; chartBars = ${JSON.stringify(BARS)}; currentMode = 'shares'; setDirection('long'); initChartEvents()`);
  const fire = (type, e) => { e = event(e); for (const fn of on[type] || []) fn(e); return e; };
  const fireWin = (type, e) => { e = event(e); for (const fn of [...(win[type] || [])]) fn(e); return e; };
  /** the pixel a price sits at, on the scale as it is now */
  const yOf = price => { const { lo, hi } = h.run('chartRange()'); return 12 + (hi - price) / (hi - lo) * 224; };
  const field = id => h.elements.get(id).value;
  return { ...h, fire, fireWin, yOf, field };
}

test('the lines you can pick up: the entry (now, until one is typed) and the stop for your side', async () => {
  const { run, yOf } = await chartApp();
  assert.deepEqual(run('chartLines()'), [{ id: 'entry', price: 16.71 }, { id: 'stopLong', price: 14.87 }]);
  assert.equal(run(`chartLineAt(${yOf(14.87) + 3}, GRAB_PX.mouse)`), 'stopLong', 'a few px off the LOD stop picks it up');
  assert.equal(run(`chartLineAt(${yOf(16.71) - 4}, GRAB_PX.mouse)`), 'entry');
  assert.equal(run(`chartLineAt(${yOf(16)}, GRAB_PX.mouse)`), null, 'between the lines: nothing to pick up');
  assert.equal(run(`chartLineAt(${yOf(14.87) + 12}, GRAB_PX.touch)`), 'stopLong', 'a finger gets more room');
  run("setDirection('short')");
  assert.deepEqual(run('chartLines()').map(l => l.id), ['entry', 'stopShort']);
  run("sizingMode = 'allocation'");
  assert.deepEqual(run('chartLines()'), [], 'allocation sizing has no stop to drag');
});

test('dragging the stop with the mouse writes a custom stop; the scale holds still until you let go', async () => {
  const { run, fire, fireWin, yOf, field, state } = await chartApp();
  const scale = run('chartRange()');
  const down = fire('mousedown', { clientY: yOf(14.87) });
  assert.ok(down.prevented, 'the press is the chart\'s: no text selection');
  fireWin('mousemove', { clientY: yOf(16.2) });
  assert.equal(field('stopLong'), '16.20');
  assert.deepEqual(run('chartRange()'), scale, 'held while dragging');
  assert.equal(run('stopSourceName(true)'), 'Custom stop');
  fireWin('mouseup', {});
  assert.equal(state.chartDragRange, null);
  assert.equal(field('stopLong'), '16.20');
  // the click that ends the press doesn't set a stop at the pointer
  fire('click', { clientY: yOf(15) });
  assert.equal(field('stopLong'), '16.20');
});

test('a stop dragged above the entry makes the trade a short, and back below a long again', async () => {
  const { run, fire, fireWin, yOf, field, state } = await chartApp();
  fire('mousedown', { clientY: yOf(14.87) });
  fireWin('mousemove', { clientY: yOf(17.0) });
  assert.equal(state.direction, 'short');
  assert.equal(field('stopShort'), '17.00');
  fireWin('mousemove', { clientY: yOf(15.5) });
  assert.equal(state.direction, 'long');
  assert.equal(field('stopLong'), '15.50');
  assert.equal(field('stopShort'), '', 'the short side is left as it was before the drag');
  fireWin('mouseup', {});
  assert.equal(run('tradeCtx()'), 'long');
  // let go as a short: the long stop you dragged from stays what it was, not the last price it passed
  run("document.getElementById('stopLong').value = '15.20'; stopsChanged()");
  fire('mousedown', { clientY: yOf(15.2) });
  fireWin('mousemove', { clientY: yOf(16.6) });
  assert.equal(field('stopLong'), '16.60');
  fireWin('mousemove', { clientY: yOf(17.0) });
  fireWin('mouseup', {});
  assert.equal(state.direction, 'short');
  assert.equal(field('stopShort'), '17.00');
  assert.equal(field('stopLong'), '15.20');
});

test('the entry stays on its side of the stop', async () => {
  const { run, fire, fireWin, yOf, field } = await chartApp();
  run("document.getElementById('stopLong').value = '15.50'; stopsChanged()");
  fire('mousedown', { clientY: yOf(16.71) });
  fireWin('mousemove', { clientY: yOf(15.0) });
  fireWin('mouseup', {});
  assert.equal(field('entryPrice'), '15.51', 'a cent over the long stop');
  run("setDirection('short'); document.getElementById('entryPrice').value = ''; stopsChanged()");
  fire('mousedown', { clientY: yOf(16.71) });
  fireWin('mousemove', { clientY: yOf(17.3) });
  fireWin('mouseup', {});
  assert.equal(field('entryPrice'), '17.11', 'a cent under the HOD stop');
});

test('let go on the LOD (or on the adjusted LOD) the stop goes back to it; the entry let go on the price goes back to now', async () => {
  const { run, fire, fireWin, yOf, field } = await chartApp();
  run("document.getElementById('stopLong').value = '15.50'; stopsChanged()");
  fire('mousedown', { clientY: yOf(15.5) });
  fireWin('mousemove', { clientY: yOf(14.87) + 1 });
  fireWin('mouseup', {});
  assert.equal(field('stopLong'), '', 'back on the LOD: the field blanks');
  assert.equal(run('stopSourceName(true, true)'), 'Low of day (LOD)');
  // with a percent adjustment the snap is to the adjusted stop, not the raw low
  run("setStopPercent(0.5)");
  const adjusted = run('stopLongVal()');
  assert.equal(adjusted, 14.79);
  run("document.getElementById('stopLong').value = '15.50'; stopsChanged()");
  fire('mousedown', { clientY: yOf(15.5) });
  fireWin('mousemove', { clientY: yOf(adjusted) });
  fireWin('mouseup', {});
  assert.equal(field('stopLong'), '');
  // the entry
  fire('mousedown', { clientY: yOf(16.71) });
  fireWin('mousemove', { clientY: yOf(16.3) });
  assert.equal(field('entryPrice'), '16.30');
  fireWin('mousemove', { clientY: yOf(16.71) });
  assert.equal(field('entryPrice'), '', 'back on the price: entry is now');
  fireWin('mouseup', {});
});

test('one finger on a line drags it at once and keeps the touch from the crosshair and the page', async () => {
  const { run, fire, yOf, field } = await chartApp();
  const start = fire('touchstart', { touches: [{ clientX: 100, clientY: yOf(14.87) + 8 }] });
  assert.ok(start.stopped, 'the long-press crosshair never arms');
  const move = fire('touchmove', { touches: [{ clientX: 100, clientY: yOf(15.8) }] });
  assert.ok(move.prevented, 'the page holds still');
  assert.equal(field('stopLong'), '15.80');
  fire('touchend', { touches: [] });
  assert.equal(run('chartDragRange'), null);
  // a touch away from the lines is left to the crosshair and the page
  const other = fire('touchstart', { touches: [{ clientX: 100, clientY: yOf(16.2) }] });
  assert.ok(!other.stopped);
});

test('a tap above the entry sets a short stop and turns the trade short', async () => {
  const { run, field, state } = await chartApp();
  run('setStopFromPrice(17.3)');
  assert.equal(state.direction, 'short');
  assert.equal(field('stopShort'), '17.30');
  run('setStopFromPrice(15.1)');
  assert.equal(state.direction, 'long');
  assert.equal(field('stopLong'), '15.10');
});

test('options: the chain side decides; dragging never changes it, and the Both view moves the line you picked up', async () => {
  const { run, fire, fireWin, yOf, field, state } = await chartApp();
  run("currentMode = 'options'; chainSide = 'both'");
  assert.deepEqual(run('chartLines()').map(l => l.id), ['entry', 'stopLong', 'stopShort']);
  fire('mousedown', { clientY: yOf(17.12) });
  fireWin('mousemove', { clientY: yOf(17.4) });
  fireWin('mouseup', {});
  assert.equal(field('stopShort'), '17.40');
  assert.equal(field('stopLong'), '');
  assert.equal(state.direction, 'long', 'the shares direction is untouched');
});
