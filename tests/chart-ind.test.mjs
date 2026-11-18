// Run with: node --test
// The Size tab charts' indicator chips (5 min: 8 and 21 EMA, VWAP; daily: 8 and 21 EMA, 50, 100 and 200 SMA), what's
// off kept on this device, and the warm-up the averages start from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const ids = html => [...html.matchAll(/data-arg="([^"]+)"/g)].map(m => m[1]);
const lit = html => [...html.matchAll(/class="ind-chip active"[^>]*data-arg="([^"]+)"/g)].map(m => m[1]);

test('each chart has its own indicator chips, all on until one is turned off', async () => {
  const { run, elements } = await app();
  run('renderChartInd()');
  assert.deepEqual(ids(elements.get('chartInd').innerHTML), ['ema8', 'ema21', 'vwap']);
  assert.deepEqual(ids(elements.get('dailyInd').innerHTML), ['ema8', 'ema21', 'sma50', 'sma100', 'sma200']);
  assert.deepEqual(lit(elements.get('chartInd').innerHTML), ['ema8', 'ema21', 'vwap']);
  assert.match(elements.get('chartInd').innerHTML, /data-action="toggleChartInd"/);
  assert.match(elements.get('dailyInd').innerHTML, /data-action="toggleDailyInd"/);
});

test('a chip hides its line on its own chart only, and what is off is kept on this device', async () => {
  const { run, elements, storage } = await app();
  run("toggleChartInd('ema21')");
  assert.equal(storage.get('chart_ind_off'), '["ema21"]');
  assert.deepEqual(lit(elements.get('chartInd').innerHTML), ['ema8', 'vwap']);
  assert.equal(run("indOn('daily', 'ema21')"), true, 'the daily keeps its 21 EMA');
  run("toggleDailyInd('sma200')");
  run("toggleDailyInd('sma100')");
  assert.equal(storage.get('daily_ind_off'), '["sma200","sma100"]');
  run("toggleDailyInd('sma200')");
  assert.equal(storage.get('daily_ind_off'), '["sma100"]', 'tapped again, it comes back');
  run("toggleChartInd('sma200')");
  assert.equal(storage.get('chart_ind_off'), '["ema21"]', 'an indicator the 5 min chart has not got changes nothing');
  const again = await app({ storage });
  assert.deepEqual(again.run('JSON.stringify([chartIndOff, dailyIndOff])'), JSON.stringify([['ema21'], ['sma100']]), 'a reload keeps them off');
});

test('only the lines that are on are worked out, each one value per bar', async () => {
  const { run } = await app();
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const avgs = () => run(`JSON.stringify(chartAverages('daily', [], ${JSON.stringify(closes)}, c => c).map(m => [m.id, m.color, m.values.length]))`);
  assert.equal(avgs(), JSON.stringify([['ema8', '--purple', 30], ['ema21', '--amber', 30], ['sma50', '--pink', 30], ['sma100', '--teal', 30], ['sma200', '--text', 30]]));
  run("toggleDailyInd('ema8')");
  assert.deepEqual(JSON.parse(avgs()).map(m => m[0]), ['ema21', 'sma50', 'sma100', 'sma200']);
  assert.equal(run(`JSON.stringify(chartAverages('intraday', [], ${JSON.stringify(closes)}, c => c).map(m => m.id))`), '["ema8","ema21"]', 'VWAP is drawn on its own');
});

// a weekday series of daily bars ending on a date, oldest first
function weekdays(end, n) {
  const out = [];
  for (let d = new Date(end + 'T12:00:00Z'); out.length < n; d = new Date(d.getTime() - 864e5)) {
    const day = d.getUTCDay();
    if (day === 0 || day === 6) continue;
    out.unshift({ date: d.toISOString().slice(0, 10), open: 100, high: 101, low: 99, close: 100 + out.length });
  }
  return out;
}

test('the daily pane fetches enough history for a 200 SMA across the 1Y view, and shows only the year', async () => {
  const urls = [];
  const days = weekdays('2026-11-18', 480);
  const fetch = async url => { urls.push(String(url)); return { ok: true, json: async () => ({ history: { day: days } }) }; };
  const { run } = await app({ fetch });
  await run("applyDailyHistory([], '2026-11-18'); fetchAdr('AAA')");
  const start = new URL(urls.find(u => u.includes('/markets/history'))).searchParams.get('start');
  const back = (Date.now() - Date.parse(start + 'T12:00:00Z')) / 864e5;
  assert.ok(back > 670 && back < 690, `fetched from ${start}`);
  run("applyDailyHistory(" + JSON.stringify(days) + ", '2026-11-18')");
  const shown = run('dailyBars.length'), warm = run('dailyWarm.length');
  assert.equal(shown + warm, 480);
  assert.ok(shown > 250 && shown < 280, `a year shown: ${shown}`);
  assert.equal(run('dailyBars[0].date >= "2025-11-03"'), true);
  // the 200 SMA has a value on the 1Y view's first bar, from the closes fetched before the year
  const first = run(`chartAverages('daily', dailyWarm, dailyBars.map(b => b.close), c => c).find(m => m.id === 'sma200').values[${shown - 252}]`);
  assert.ok(first > 0, `200 SMA at the 1Y view's first bar: ${first}`);
  assert.ok(run('hvDist.length') < shown, 'IV percentile still ranks against the year shown');
});

test('a short history starts the 200 SMA where it has 200 closes, and leaves nothing warm', async () => {
  const { run } = await app();
  run(`applyDailyHistory(${JSON.stringify(weekdays('2026-11-18', 230))}, '2026-11-18')`);
  assert.equal(run('dailyWarm.length'), 0);
  const v = JSON.parse(run("JSON.stringify(chartAverages('daily', dailyWarm, dailyBars.map(b => b.close), c => c).find(m => m.id === 'sma200').values)"));
  assert.equal(v[198], null);
  assert.ok(v[199] > 0);
});

test('the intraday EMAs warm up on the earlier days fetched, at the chosen interval', async () => {
  // three sessions of 5-minute bars; the 5m chart shows the last one
  const data = [];
  for (const day of ['2026-11-16', '2026-11-17', '2026-11-18'])
    for (let i = 0; i < 78; i++) {
      const m = 9 * 60 + 30 + i * 5, t = `${day}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
      data.push({ time: t, timestamp: 0, open: 100, high: 101, low: 99, close: 100 + data.length / 100, volume: 1000 });
    }
  const fetch = async () => ({ ok: true, json: async () => ({ series: { data } }) });
  const { run } = await app({ fetch });
  run("quoteData = { symbol: 'AAA', last: 101, low: 99, high: 102 }; chartInterval = 5");
  await run("fetchChart('AAA')");
  assert.equal(run('chartBars.length'), 78);
  assert.equal(run('chartWarm.length'), 156, 'the two days before');
  assert.equal(run('chartWarm[155]'), data[155].close);
  run('setChartInterval(15)');
  assert.equal(run('chartBars.length'), 52, 'two sessions at 15m');
  assert.equal(run('chartWarm.length'), 26, 'the day before them, in 15-minute bars');
});
