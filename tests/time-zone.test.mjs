// Run with: node --test
// The Times switch in Settings: every clock time shown in ET or PT, while the market's days and sessions stay New York's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const json = (run, code) => JSON.parse(run(`JSON.stringify(${code})`));

test('a New York wall clock in Pacific time, on both sides of daylight time', async () => {
  const { run } = await app();
  assert.deepEqual(json(run, "nyWallIn('2026-10-26', '09:30', 'America/Los_Angeles')"), { day: '2026-10-26', time: '06:30' });
  assert.deepEqual(json(run, "nyWallIn('2026-12-01', '16:00', 'America/Los_Angeles')"), { day: '2026-12-01', time: '13:00' });
  assert.deepEqual(json(run, "nyWallIn('2026-10-27', '01:30', 'America/Los_Angeles')"), { day: '2026-10-26', time: '22:30' }, 'after midnight in New York is the evening before');
  assert.deepEqual(json(run, "nyWallIn('2026-10-26', '09:30', 'America/New_York')"), { day: '2026-10-26', time: '09:30' });
  assert.equal(run("new Date(nyWallMs('2026-07-01', '09:30')).toISOString()"), '2026-07-01T13:30:00.000Z');
  assert.equal(run("new Date(nyWallMs('2026-01-05', '09:30')).toISOString()"), '2026-01-05T14:30:00.000Z');
});

test('the switch: ET by default, PT kept on this device, and shown times follow it', async () => {
  const storage = new Map();
  const { run, elements, state } = await app({ storage });
  assert.equal(state.timeZone, 'et');
  run('syncTimeZone()'); // what boot does (main.js)
  assert.equal(elements.get('zoneEt').getAttribute('aria-pressed'), 'true');
  assert.equal(run("clockTime('2026-10-13T15:47:00Z')"), '10/13, 11:47 AM');
  assert.equal(run("zoneClock('2026-10-13', '09:30')"), '09:30');

  run("actions.setTimeZone({ dataset: { arg: 'pt' } })");
  assert.equal(storage.get('time_zone'), 'pt');
  assert.equal(elements.get('zonePt').getAttribute('aria-pressed'), 'true');
  assert.equal(elements.get('zoneEt').getAttribute('aria-pressed'), 'false');
  assert.equal(run("clockTime('2026-10-13T15:47:00Z')"), '10/13, 8:47 AM');
  assert.equal(run("zoneClock('2026-10-13', '09:30')"), '06:30');
  assert.equal(run("zoneWords('2026-10-13', '16:00')"), '1:00 PT');
  assert.equal(run("nyDateStr(new Date('2026-10-14T02:00:00Z'))"), '2026-10-13', 'the market day is still New York\'s');

  const again = await app({ storage });
  assert.equal(again.state.timeZone, 'pt', 'read back on the next open');
  again.run('syncTimeZone()');
  assert.equal(again.elements.get('zonePt').getAttribute('aria-pressed'), 'true');
});

test('the trade chart\'s axis reads in the zone; the bars stay stamped in New York time', async () => {
  const { run } = await app();
  const bars = "[{ date: '2026-10-13', time: '09:30', open: 1, high: 2, low: 0.5, close: 1.5 }, { date: '2026-10-13', time: '09:35', open: 1.5, high: 2, low: 1, close: 1.8 }]";
  const fills = "[{ time: '2026-10-13T13:36:00Z', side: 'buy', qty: 1, price: 1.6 }]";
  const et = json(run, `chartSeries(${bars}, ${fills})`), pt = json(run, `chartSeries(${bars}, ${fills}, 5, 'America/Los_Angeles')`);
  assert.equal(et.candles[0].time, Date.UTC(2026, 9, 13, 9, 30) / 1000);
  assert.equal(pt.candles[0].time, Date.UTC(2026, 9, 13, 6, 30) / 1000);
  assert.equal(pt.markers[0].time, pt.candles[1].time, 'the fill lands on the same bar');
  assert.equal(json(run, `chartSeries([{ date: '2026-10-13', open: 1, high: 2, low: 0.5, close: 1.5 }], [], 5, 'America/Los_Angeles')`).candles[0].time, '2026-10-13', 'a daily bar is its day');
});
