// Run with: node --test
// Trade features (docs/journal-features.md, part 2): checks over every feature (no look-ahead: the data after its moment
// changed or cut off never changes what it says; its contract: a unique key, a version, only numbers, its own words or
// null, and only the data its `needs` declare), each feature on fixture bars, stamping (missing or outdated features,
// the three states, a removed feature's stamps dropped), what the bar saver keeps for them, and the Journal: stamped
// after it loads, the Features tab, the trade page, and a database without the table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_FAMILIES, FEATURES, computeFeature, featureBarNeeds, featureCoverage, featureDataNeeds, featureDue, featureNeedsWords, featuresDue, featureValueWords, featureVersion, stampTrade } from '../src/core/features/index.js';
import { featureContext, featureSymbol } from '../src/core/features/context.js';
import { weekdaysBefore } from '../src/core/bars.js';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

// ---------- fixtures: a Wednesday, with every bar before and after it ----------

const D = '2026-10-14'; // Wednesday
const NOW = Date.parse('2026-10-15T18:00:00Z'); // Thursday afternoon: 10/14 is done and inside Tradier's window
const at = hhmm => Date.parse(`${D}T${String(Number(hhmm.slice(0, 2)) + 4).padStart(2, '0')}:${hhmm.slice(3)}:20Z`); // EDT, 20s into the minute
const slots = (from, to) => { const out = []; for (let m = +from.slice(0, 2) * 60 + +from.slice(3); m < +to.slice(0, 2) * 60 + +to.slice(3); m += 5) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`); return out; };
const ALL = slots('04:00', '20:00');

/** a day of 5-minute bars, rising a little each bar; heavier in the regular session */
function day(date, base, vol) {
  return ALL.map((time, i) => {
    const open = +(base + i * 0.05).toFixed(2), regular = time >= '09:30' && time < '16:00';
    return { date, time, open, high: +(open + 0.3).toFixed(2), low: +(open - 0.2).toFixed(2), close: +(open + 0.05).toFixed(2), volume: regular ? vol + (i % 7) * 10 : 50 };
  });
}
const AFTER = ['2026-10-15', '2026-10-16'];
function intraday(base, todayVol = 2000) {
  const m = new Map();
  for (const d of weekdaysBefore(D, 20)) m.set(d, day(d, base, 1000));
  m.set(D, day(D, base, todayVol));
  for (const d of AFTER) m.set(d, day(d, base + 5, 9000));
  return m;
}
/** about 300 sessions of daily bars through two days after D, D's open the same as its 9:30 bar's */
function daily(base, intra) {
  const out = [];
  const days = [...weekdaysBefore(D, 300), D, ...AFTER];
  days.forEach((date, i) => {
    const close = +(base * (0.8 + i * 0.001)).toFixed(2);
    out.push({ date, open: close, high: +(close * 1.01).toFixed(2), low: +(close * 0.99).toFixed(2), close, volume: 1e6 });
  });
  const dd = out.find(b => b.date === D), first = intra.get(D).find(b => b.time === '09:30');
  dd.open = first.open;
  dd.high = Math.max(...intra.get(D).filter(b => b.time >= '09:30' && b.time < '16:00').map(b => b.high));
  return out;
}
/** VIX: an index, so no volume, and bars only from 9:30 to 16:15 */
function vixIntraday() {
  const m = intraday(18);
  for (const [d, bars] of m) m.set(d, bars.filter(b => b.time >= '09:30' && b.time < '16:15').map(b => ({ ...b, volume: 0 })));
  return m;
}
function world() {
  const aapl = intraday(100), spy = intraday(500, 3000), qqq = intraday(400), vix = vixIntraday();
  return {
    intraday: new Map([['AAPL', aapl], ['SPY', spy], ['QQQ', qqq], ['VIX', vix]]),
    daily: new Map([['AAPL', daily(100, aapl)], ['SPY', daily(500, spy)], ['QQQ', daily(400, qqq)], ['VIX', daily(18, vix)]]),
  };
}
const stock = (hhmm = '10:02') => ({ key: `6789|AAPL|long|${hhmm}`, symbol: 'AAPL', assetType: 'EQUITY', status: 'win', openedAt: new Date(at(hhmm)).toISOString(), closedAt: new Date(at('15:00')).toISOString() });
const call = (hhmm = '10:02') => ({ ...stock(hhmm), key: `6789|call|${hhmm}`, symbol: 'AAPL  261218C00245000', assetType: 'OPTION' });
const spread = (hhmm = '10:02') => ({ ...stock(hhmm), key: `6789|spread|${hhmm}`, assetType: 'SPREAD' });

/** a copy with everything after the moment changed (`cut`: removed instead); the bar the moment falls in keeps its open */
function future(data, ms, cut = false) {
  const stamp = new Date(ms).toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 16);
  const d = stamp.slice(0, 10), clock = stamp.slice(11, 16), mins = t => +t.slice(0, 2) * 60 + +t.slice(3);
  const wild = b => ({ ...b, open: b.open * 3, high: b.high * 3 + 7, low: b.low / 3, close: b.close * 2.5, volume: (b.volume || 0) * 40 + 1 });
  const partial = b => ({ ...b, high: b.high * 3 + 7, low: b.low / 3, close: b.close * 2.5, volume: (b.volume || 0) * 40 + 1 });
  const intra = new Map([...data.intraday].map(([s, days]) => [s, new Map([...days].flatMap(([dd, bars]) => {
    if (dd < d) return [[dd, bars]];
    if (dd > d) return cut ? [] : [[dd, bars.map(wild)]];
    return [[dd, bars.flatMap(b => {
      const start = mins(b.time), now = mins(clock);
      if (start + 5 <= now) return [b];
      if (start <= now) return [cut ? { ...b, high: b.open, low: b.open, close: b.open, volume: 0 } : partial(b)];
      return cut ? [] : [wild(b)];
    })]];
  }))]));
  const dly = new Map([...data.daily].map(([s, bars]) => [s, bars.flatMap(b => {
    if (b.date < d) return [b];
    if (b.date > d) return cut ? [] : [wild(b)];
    if (clock < '09:30') return cut ? [] : [wild(b)];
    return [cut ? { ...b, high: b.open, low: b.open, close: b.open, volume: 0 } : partial(b)];
  })]));
  return { intraday: intra, daily: dly };
}

const result = (f, trade, data, entryPrice = 101.37) => {
  const ms = f.at === 'entry' ? Date.parse(trade.openedAt) : Date.parse(trade.closedAt);
  const r = computeFeature(f, featureContext(trade, ms, data, { now: NOW, entryPrice }));
  return { state: r.state, value: r.value, note: r.note };
};
const MOMENTS = ['08:10', '09:31', '09:36', '09:47', '10:02', '13:33', '15:58', '17:05'];

// ---------- checks over every feature ----------

test('no feature looks ahead: changing or cutting off everything after its moment never changes what it says', () => {
  const data = world();
  for (const f of FEATURES) {
    for (const hhmm of MOMENTS) {
      for (const trade of [stock(hhmm), call(hhmm)]) {
        const ms = f.at === 'entry' ? Date.parse(trade.openedAt) : Date.parse(trade.closedAt);
        const base = result(f, trade, data);
        assert.deepEqual(result(f, trade, future(data, ms)), base, `${f.key} at ${hhmm} on ${trade.assetType}: the data after the moment changed`);
        assert.deepEqual(result(f, trade, future(data, ms, true)), base, `${f.key} at ${hhmm} on ${trade.assetType}: the data cut off at the moment`);
      }
    }
  }
});

test('every feature keeps its contract: a unique key, a version, its family, only declared output, and only the data it declares', () => {
  const keys = new Set();
  const data = world();
  for (const f of FEATURES) {
    assert.ok(!keys.has(f.key), `${f.key} is unique`);
    keys.add(f.key);
    assert.match(f.key, /^[a-z][a-z0-9_]{1,63}$/);
    assert.ok(Number.isInteger(f.version) && f.version >= 1, `${f.key} version`);
    assert.ok(f.name && f.desc, `${f.key} has a name and says what it measures`);
    assert.ok(['entry', 'exit'].includes(f.at));
    assert.ok(FEATURE_FAMILIES.includes(f.family), `${f.key} is in a listed family`);
    assert.ok(['%', 'x', '$', 'atr', 'adr', ''].includes(f.unit));
    assert.deepEqual(Object.keys(f.needs).filter(k => !['intraday', 'lookback', 'daily', 'dailySessions', 'session'].includes(k)), [], `${f.key}: only known needs`);
    assert.match(featureVersion(f), /^\d+\.\d+$/);
    assert.ok(featureNeedsWords(f), `${f.key} says what it reads`);
    for (const hhmm of MOMENTS) for (const trade of [stock(hhmm), call(hhmm), spread(hhmm)]) {
      const ms = Date.parse(f.at === 'entry' ? trade.openedAt : trade.closedAt);
      const ctx = featureContext(trade, ms, data, { now: NOW, entryPrice: 101 });
      const r = computeFeature(f, ctx);
      assert.ok(r.value === null || (typeof r.value === 'number' && Number.isFinite(r.value)) || (f.values || []).some(([k]) => k === r.value), `${f.key}: a number, its own word, or null`);
      assert.ok(!/couldn't be worked out/.test(r.note), `${f.key} at ${hhmm} on ${trade.assetType} throws: ${r.note}`);
      const intra = new Set((f.needs.intraday || []).map(s => featureSymbol(s, trade)));
      const dly = new Set((f.needs.daily || []).map(s => featureSymbol(s, trade)));
      for (const read of r.reads) {
        if (read.kind === 'intraday') {
          assert.ok(intra.has(read.symbol), `${f.key} reads ${read.symbol}'s 5-minute bars: declare it`);
          if (read.session === 'all') assert.equal(f.needs.session, 'all', `${f.key} reads extended hours: declare session 'all'`);
          if (read.lookback) assert.ok(read.lookback <= (f.needs.lookback || 0), `${f.key} compares ${read.lookback} sessions back: declare lookback`);
        } else {
          assert.ok(dly.has(read.symbol), `${f.key} reads ${read.symbol}'s daily bars: declare it`);
          assert.ok(read.sessions <= (f.needs.dailySessions ?? Infinity), `${f.key} reads ${read.sessions} daily sessions: declare dailySessions`);
        }
      }
    }
  }
});

test('the cut: a bar counts once it has ended, the one in progress only by its open, the day before by its daily bar', () => {
  const data = world();
  const ctx = featureContext({ ...stock('10:02'), pnl: 260 }, at('10:02'), data, { now: NOW, entryPrice: 101 });
  const s = ctx.intraday('AAPL');
  assert.equal(s.bars.at(-1).time, '09:55', 'the 10:00 bar is still going at 10:02');
  assert.equal(s.price, s.bars.at(-1).close);
  assert.equal(s.high, Math.max(...s.bars.map(b => b.high), data.intraday.get('AAPL').get(D).find(b => b.time === '10:00').open));
  const early = featureContext(stock('09:31'), at('09:31'), data, { now: NOW }).intraday('AAPL');
  assert.deepEqual([early.bars.length, early.price], [0, data.intraday.get('AAPL').get(D).find(b => b.time === '09:30').open], 'only the open at 9:31');
  const d = ctx.daily('AAPL');
  assert.equal(d.bars.at(-1).date, '2026-10-13', 'daily bars before the day');
  assert.equal(d.todayOpen, data.daily.get('AAPL').find(b => b.date === D).open, "and the day's open, known at 9:30");
  assert.equal(featureContext(stock('09:10'), at('09:10'), data, { now: NOW }).daily('AAPL').todayOpen, null, 'not before');
  assert.deepEqual(Object.keys(ctx.trade), ['symbol', 'assetType', 'openedAt', 'closedAt']);
  assert.equal(ctx.trade.closedAt, null, 'at the entry the trade has no exit, nor any result');
  assert.equal(featureSymbol('$underlying', call()), 'AAPL');
  assert.equal(featureSymbol('$self', call()), 'AAPL261218C00245000');
  assert.equal(featureSymbol('$self', spread()), null);
});

// ---------- each feature on fixture bars ----------

const byKey = k => FEATURES.find(f => f.key === k);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-3, `${msg}: ${a} vs ${b}`);

test('SPY and QQQ vs the daily 8 EMA: the price at the entry against the EMA moved on by it; the prior close when the day is gone', () => {
  const data = world();
  const spy = byKey('spy_vs_daily_ema8');
  const prior = data.daily.get('SPY').filter(b => b.date < D).slice(-60);
  let e = prior.slice(0, 8).reduce((a, b) => a + b.close, 0) / 8;
  for (const b of prior.slice(8)) e = b.close * 2 / 9 + e * 7 / 9;
  const price = data.intraday.get('SPY').get(D).find(b => b.time === '09:55').close; // the last bar ended by 10:02
  const r = result(spy, stock('10:02'), data);
  near(r.value, (price / (price * 2 / 9 + e * 7 / 9) - 1) * 100, 'today against the EMA moved on by today');
  assert.equal(r.note, '');
  const pre = result(spy, stock('08:10'), data);
  assert.equal(pre.state, 'value', 'extended hours count for the index');
  assert.equal(result(byKey('qqq_vs_daily_ema8'), stock('10:02'), data).state, 'value');
  // the day's SPY bars not kept: inside the window it waits, older it falls back to the close before
  const noSpy = { ...data, intraday: new Map([...data.intraday].map(([s, m]) => [s, s === 'SPY' ? new Map([...m].filter(([d]) => d !== D)) : m])) };
  const waiting = result(spy, stock('10:02'), noSpy);
  assert.equal(waiting.state, 'waiting');
  assert.match(waiting.note, /SPY 5-minute bars on 10\/14/);
  const later = computeFeature(spy, featureContext(stock('10:02'), at('10:02'), noSpy, { now: NOW + 60 * 864e5 }));
  assert.equal(later.state, 'value');
  assert.equal(later.note, 'prior close');
  near(later.value, (prior.at(-1).close / e - 1) * 100, 'the close before against the EMA before');
  // a split since: the daily history is half the day's prices, so the day's are halved to match
  const halved = { ...data, daily: new Map([...data.daily].map(([s, bars]) => [s, s === 'SPY' ? bars.map(b => ({ ...b, open: b.open / 2, high: b.high / 2, low: b.low / 2, close: b.close / 2 })) : bars])) };
  near(result(spy, stock('10:02'), halved).value, r.value, 'the same answer on split-adjusted history');
});

test('VIX at entry and its change on the day: the last 5-minute value; without the day\'s bars, the open or the close before', () => {
  const data = world();
  const level = byKey('vix_at_entry'), change = byKey('vix_change_at_entry');
  const bars = data.intraday.get('VIX').get(D), prior = data.daily.get('VIX').filter(b => b.date < D).at(-1);
  const price = bars.find(b => b.time === '09:55').close; // the last bar ended by 10:02
  assert.deepEqual(result(level, stock('10:02'), data), { state: 'value', value: price, note: '' });
  near(result(change, stock('10:02'), data).value, (price / prior.close - 1) * 100, 'against the close the day before');
  assert.equal(result(level, call('10:02'), data).value, price, 'the same for an option: the market, not the trade');
  assert.equal(result(level, spread('10:02'), data).value, price, 'and a spread');
  // before 9:30 VIX has no bars that day: the close before, and no change yet
  assert.deepEqual(result(level, stock('08:10'), data), { state: 'value', value: prior.close, note: 'prior close' });
  assert.deepEqual(result(change, stock('08:10'), data), { state: 'unknown', value: null, note: 'entered before any VIX that day' });
  // at 9:31 only the 9:30 bar's open is known
  assert.equal(result(level, stock('09:31'), data).value, bars.find(b => b.time === '09:30').open);
  // the day's VIX bars not kept: inside the window it waits; older, the day's open from the daily bars
  const noVix = { ...data, intraday: new Map([...data.intraday].map(([s, m]) => [s, s === 'VIX' ? new Map([...m].filter(([d]) => d !== D)) : m])) };
  const waiting = result(level, stock('10:02'), noVix);
  assert.equal(waiting.state, 'waiting');
  assert.match(waiting.note, /VIX 5-minute bars on 10\/14/);
  const later = (f, hhmm) => { const r = computeFeature(f, featureContext(stock(hhmm), at(hhmm), noVix, { now: NOW + 60 * 864e5 })); return { state: r.state, value: r.value, note: r.note }; };
  const open = data.daily.get('VIX').find(b => b.date === D).open;
  assert.deepEqual(later(level, '10:02'), { state: 'value', value: open, note: 'the open' });
  near(later(change, '10:02').value, (open / prior.close - 1) * 100, 'the open against the close before');
  assert.deepEqual(later(level, '09:10'), { state: 'value', value: prior.close, note: 'prior close' });
  // no daily history read yet: waits
  assert.equal(result(level, stock('10:02'), { ...data, daily: new Map([...data.daily].filter(([s]) => s !== 'VIX')) }).state, 'waiting');
  assert.equal(featureValueWords(change, 4.5), '+4.50%');
});

test('volume run rate: so far against the same time of day over the 20 sessions before; none in the first 5 minutes', () => {
  const data = world();
  const rvol = byKey('rvol_at_entry');
  const sum = (bars, upTo) => bars.filter(b => b.time >= '09:30' && b.time < upTo).reduce((n, b) => n + b.volume, 0);
  const today = sum(data.intraday.get('AAPL').get(D), '10:00'), before = sum(data.intraday.get('AAPL').get(weekdaysBefore(D, 1)[0]), '10:00');
  const r = result(rvol, stock('10:02'), data);
  near(r.value, Math.round(today / before * 1e4) / 1e4, 'the six bars ended by 10:02, both days');
  assert.ok(r.value > 1.9 && r.value < 2.1, 'twice as heavy as usual');
  assert.equal(result(rvol, call('10:02'), data).value, r.value, 'an option reads its underlying');
  assert.deepEqual(result(rvol, stock('09:31'), data), { state: 'unknown', value: null, note: 'entered in the first 5 minutes' });
  assert.equal(result(rvol, stock('08:10'), data).note, 'entered before the open');
  // lookback days not kept: the ones the saver will still fetch make it wait; older ones are gone
  const thin = { ...data, intraday: new Map([...data.intraday].map(([s, m]) => [s, s === 'AAPL' ? new Map([...m].filter(([d]) => d >= '2026-10-08')) : m])) };
  assert.equal(result(rvol, stock('10:02'), thin).state, 'waiting');
  const old = computeFeature(rvol, featureContext(stock('10:02'), at('10:02'), thin, { now: NOW + 60 * 864e5 }));
  assert.deepEqual([old.state, old.note], ['unknown', 'fewer than 10 of the 20 sessions before'], 'four kept sessions are too few');
});

test('the other volume features: the median run rate, at the exit, the 15 minutes before, the day so far, and the daily ones', () => {
  const data = world();
  const regular = (bars, from, to) => bars.filter(b => b.time >= from && b.time < to).reduce((n, b) => n + b.volume, 0);
  const today = data.intraday.get('AAPL').get(D), prior = data.intraday.get('AAPL').get(weekdaysBefore(D, 1)[0]);
  // median: the same as the average while every day before is alike; one heavy day moves only the average
  const med = byKey('rvol_median_at_entry');
  near(result(med, stock('10:02'), data).value, result(byKey('rvol_at_entry'), stock('10:02'), data).value, 'alike days: median = average');
  const spiky = world();
  for (const b of spiky.intraday.get('AAPL').get(weekdaysBefore(D, 20)[5])) b.volume *= 30;
  near(result(med, stock('10:02'), spiky).value, result(med, stock('10:02'), data).value, 'one heavy day leaves the median');
  assert.ok(result(byKey('rvol_at_entry'), stock('10:02'), spiky).value < 1.5, 'and drags the average');
  assert.equal(result(med, stock('09:31'), data).note, 'entered in the first 5 minutes');
  // at the exit (15:00): the same run rate, to the exit
  near(result(byKey('rvol_at_exit'), stock('10:02'), data).value, Math.round(regular(today, '09:30', '15:00') / regular(prior, '09:30', '15:00') * 1e4) / 1e4, 'to 15:00, both days');
  // the 15 minutes before the entry: 09:45, 09:50, 09:55 at 10:02
  const recent = byKey('rvol_recent_at_entry');
  near(result(recent, stock('10:02'), data).value, Math.round(regular(today, '09:45', '10:00') / regular(prior, '09:45', '10:00') * 1e4) / 1e4, 'the last three bars, both days');
  assert.equal(result(recent, stock('09:41'), data).note, 'entered before 15 minutes of bars');
  // the day so far at the exit against a whole normal session
  near(result(byKey('day_volume_at_exit'), stock('10:02'), data).value, Math.round(regular(today, '09:30', '15:00') / regular(prior, '09:30', '16:00') * 1e4) / 1e4, 'to 15:00 over 09:30 to 16:00');
  // daily: a flat million a day
  const daily = data.daily.get('AAPL').filter(b => b.date < D);
  near(result(byKey('rvol_prior_day'), stock('10:02'), data).value, 1, 'a normal day before');
  const heavy = world();
  heavy.daily.get('AAPL').filter(b => b.date < D).at(-1).volume = 3e6;
  near(result(byKey('rvol_prior_day'), stock('10:02'), heavy).value, 3, 'three times the day before');
  near(result(byKey('volume_trend_5_20'), stock('10:02'), heavy).value, (1 + 2 / 5) / (1 + 2 / 20), 'the heavy day weighs more in 5 days than 20');
  near(result(byKey('avg_dollar_volume_20d'), stock('10:02'), data).value, Math.round(daily.slice(-20).reduce((n, b) => n + b.close, 0) / 20 * 1e4) / 1e4, 'average close × a million, in millions');
  const short = { ...data, daily: new Map([...data.daily].map(([s, b]) => [s, s === 'AAPL' ? b.slice(-12) : b])) };
  assert.equal(result(byKey('rvol_prior_day'), stock('10:02'), short).note, 'only 9 sessions of daily history');
});

test('volume in the session at the entry: the last bar against the average bar, volume over the entry, VWAP bands, on-balance volume', () => {
  const data = world();
  const bars = data.intraday.get('AAPL').get(D).filter(b => b.time >= '09:30' && b.time < '10:00'); // ended by 10:02
  const avg = bars.reduce((n, b) => n + b.volume, 0) / bars.length;
  near(result(byKey('last_bar_vol_vs_session'), stock('10:02'), data).value, Math.round(bars.at(-1).volume / avg * 1e4) / 1e4, "the 09:55 bar over the session's average bar");
  assert.equal(result(byKey('last_bar_vol_vs_session'), stock('09:36'), data).note, 'entered before two bars had ended');
  const above = byKey('volume_above_entry');
  assert.equal(result(above, stock('10:02'), data, 1).value, 100, 'under every low: all of it above');
  assert.equal(result(above, stock('10:02'), data, 1000).value, 0, 'over every high: none');
  const mid = result(above, stock('10:02'), data, (bars[0].low + bars.at(-1).high) / 2).value;
  assert.ok(mid > 0 && mid < 100, 'in the range: some');
  const tp = b => (b.high + b.low + b.close) / 3, v = bars.reduce((n, b) => n + b.volume, 0);
  const vwap = bars.reduce((n, b) => n + tp(b) * b.volume, 0) / v;
  const sd = Math.sqrt(bars.reduce((n, b) => n + b.volume * (tp(b) - vwap) ** 2, 0) / v);
  near(result(byKey('vwap_sd_at_entry'), stock('10:02'), data, 101.37).value, Math.round((101.37 - vwap) / sd * 1e4) / 1e4, 'the fill in standard deviations from VWAP');
  near(result(byKey('vwap_sd_at_entry'), call('10:02'), data).value, Math.round((bars.at(-1).close - vwap) / sd * 1e4) / 1e4, "an option: the underlying's last close");
  const obv = byKey('obv_30m_at_entry');
  assert.equal(result(obv, stock('10:02'), data).value, 100, 'every bar closed higher');
  const falling = world();
  falling.intraday.get('AAPL').get(D).forEach((b, i) => { b.close = 200 - i; });
  assert.equal(result(obv, stock('10:07'), falling).value, -100, 'every bar closed lower than the one before');
  assert.equal(result(obv, stock('09:47'), data).note, 'entered before 30 minutes of bars');
});

test('entry vs VWAP: a stock\'s fill against the session VWAP so far; an option uses its underlying\'s price', () => {
  const data = world();
  const f = byKey('entry_vs_vwap');
  const bars = data.intraday.get('AAPL').get(D).filter(b => b.time >= '09:30' && b.time < '09:45'); // ended by 09:47
  const vwap = bars.reduce((n, b) => n + (b.high + b.low + b.close) / 3 * b.volume, 0) / bars.reduce((n, b) => n + b.volume, 0);
  near(result(f, stock('09:47'), data, 101.37).value, (101.37 / vwap - 1) * 100, 'the fill');
  near(result(f, call('09:47'), data).value, (bars.at(-1).close / vwap - 1) * 100, "the underlying's last close, not the option's fill");
  assert.equal(result(f, stock('09:31'), data).note, 'no VWAP yet in the first 5 minutes');
  assert.equal(result(f, stock('17:05'), data).state, 'value', "after the close, the regular session's VWAP");
  const s = result(f, spread('09:47'), data);
  assert.equal(s.state, 'value', "a spread's underlying is its symbol");
});

test('gap at the open: the open against the close the day before, known from 9:30', () => {
  const data = world();
  const f = byKey('gap_at_open');
  const bars = data.daily.get('AAPL'), i = bars.findIndex(b => b.date === D);
  near(result(f, stock('10:02'), data).value, (bars[i].open / bars[i - 1].close - 1) * 100, 'from the daily bars');
  assert.deepEqual(result(f, stock('08:10'), data), { state: 'unknown', value: null, note: 'entered before the open' });
  const none = { ...data, daily: new Map([...data.daily].map(([s, b]) => [s, s === 'AAPL' ? [] : b])) };
  assert.deepEqual(result(f, stock('10:02'), none), { state: 'unknown', value: null, note: 'no daily history for AAPL' });
  const unread = { ...data, daily: new Map([...data.daily].filter(([s]) => s !== 'AAPL')) };
  assert.equal(result(f, stock('10:02'), unread).state, 'waiting', 'daily bars not read yet (no key, a failed read): try again');
});

test('distance from the all-time high: the highest high before the entry, that day\'s so far too; lined up across a split', () => {
  const data = world();
  const f = byKey('dist_from_ath');
  const prior = data.daily.get('AAPL').filter(b => b.date < D);
  const top = Math.max(...prior.map(b => b.high));
  const r = result(f, stock('10:02'), data, 90);
  near(r.value, (90 / top - 1) * 100, 'under the prior high');
  assert.match(r.note, /^high [\d.]+ on \d+\/\d+\/26 · history from 2025$/);
  // a high made that morning, before the entry, counts; one made after doesn't
  const spiky = world();
  spiky.intraday.get('AAPL').get(D).find(b => b.time === '09:40').high = 200;
  const r2 = result(f, stock('10:02'), spiky, 150);
  near(r2.value, (150 / 200 - 1) * 100, "that day's high before the entry");
  assert.match(r2.note, /high 200\.00 that day/);
  spiky.intraday.get('AAPL').get(D).find(b => b.time === '10:05').high = 300;
  near(result(f, stock('10:02'), spiky, 150).value, r2.value, 'a later high is never seen');
  // the history adjusted for a split since (a quarter of the day's prices): the fill is put in the same terms
  const split = { ...data, daily: new Map([...data.daily].map(([s, b]) => [s, s === 'AAPL' ? b.map(x => ({ ...x, open: x.open / 4, high: x.high / 4, low: x.low / 4, close: x.close / 4 })) : b])) };
  near(result(f, stock('10:02'), split, 90).value, r.value, 'the same distance');
  // no bars that day and a fill the daily history can't explain: unknown rather than a made-up number
  const old = { ...split, intraday: new Map() };
  const later = { now: NOW + 60 * 864e5 };
  const lined = computeFeature(f, featureContext(stock('10:02'), at('10:02'), old, { ...later, entryPrice: 90 }));
  near(lined.value, r.value, 'the fill against the daily open: a 4-for-1 lines up');
  const open = data.daily.get('AAPL').find(b => b.date === D).open;
  const off = computeFeature(f, featureContext(stock('10:02'), at('10:02'), { ...data, intraday: new Map() }, { ...later, entryPrice: open / 1.42 }));
  assert.deepEqual([off.state, off.note], ['unknown', "the daily history doesn't line up with your entry (a split?)"]);
});

test('ATRs from the moving averages: (price − average) ÷ the daily ATR, daily and weekly, the entry as the latest close', () => {
  const data = world();
  const keys = ['daily_ema8', 'daily_ema9', 'daily_sma10', 'daily_sma20', 'daily_ema21', 'daily_sma50', 'daily_ema50', 'daily_sma100', 'daily_sma200',
    'weekly_ema8', 'weekly_ema9', 'weekly_sma10', 'weekly_ema21', 'weekly_sma50', 'weekly_ema50'].map(k => `atr_from_${k}`);
  assert.deepEqual(FEATURES.filter(f => f.family.key === 'averages').map(f => f.key), keys, 'the fifteen averages, in order');
  // worked out here a second way: Wilder's ATR(14) over the 300 sessions before, the averages over their closes
  const prior = data.daily.get('AAPL').filter(b => b.date < D);
  const days = prior.slice(-300), atr = wilder14(prior);
  const ema = (closes, n, price) => {
    let e = closes.slice(0, n).reduce((a, b) => a + b, 0) / n;
    for (const c of closes.slice(n)) e = c * 2 / (n + 1) + e * (1 - 2 / (n + 1));
    return price * 2 / (n + 1) + e * (1 - 2 / (n + 1));
  };
  const sma = (closes, n, price) => (closes.slice(-(n - 1)).reduce((a, b) => a + b, 0) + price) / n;
  // weeks by their number since the epoch (day 0 was a Thursday, so +3 starts them on Monday); the entry's week left out
  const week = d => Math.floor((Date.parse(d + 'T12:00:00Z') / 864e5 + 3) / 7);
  const weekly = [];
  for (const b of prior.filter(b => week(b.date) !== week(D))) {
    if (weekly.length && weekly.at(-1).w === week(b.date)) weekly.at(-1).c = b.close; else weekly.push({ w: week(b.date), c: b.close });
  }
  const wc = weekly.map(x => x.c), dc = days.map(b => b.close);
  const price = 101.37;
  const want = {
    atr_from_daily_ema8: ema(dc, 8, price), atr_from_daily_sma50: sma(dc, 50, price), atr_from_daily_ema50: ema(dc, 50, price), atr_from_daily_sma200: sma(dc, 200, price),
    atr_from_weekly_sma10: sma(wc, 10, price), atr_from_weekly_ema21: ema(wc, 21, price), atr_from_weekly_sma50: sma(wc, 50, price),
  };
  for (const [k, avg] of Object.entries(want)) {
    const r = result(byKey(k), stock('10:02'), data, price);
    assert.equal(r.state, 'value', k);
    near(r.value, (price - avg) / atr, k);
    assert.match(r.note, /^\d+ [ES]MA [\d.]+ · ATR \$[\d.]+ \([\d.]+%\)$/, `${k} says the average and the ATR, in dollars and %`);
  }
  for (const k of keys) assert.equal(result(byKey(k), stock('10:02'), data).state, 'value', `${k} on the fixture`);
  // an option: the underlying's last price at the moment (the 9:55 bar's close at 10:02), never the contract's
  const under = data.intraday.get('AAPL').get(D).find(b => b.time === '09:55').close;
  near(result(byKey('atr_from_daily_sma50'), call('10:02'), data).value, (under - sma(dc, 50, under)) / atr, 'the underlying');
  // the history adjusted for a split since: the fill is put in the same terms, and ATRs don't care about the scale
  const split = { ...data, daily: new Map([...data.daily].map(([s, b]) => [s, s === 'AAPL' ? b.map(x => ({ ...x, open: x.open / 4, high: x.high / 4, low: x.low / 4, close: x.close / 4 })) : b])) };
  near(result(byKey('atr_from_daily_sma50'), stock('10:02'), split, price).value, (price - want.atr_from_daily_sma50) / atr, 'the same across a split');
  // a young stock: too few sessions or weeks for the long averages, said so
  const young = { ...data, daily: new Map([...data.daily].map(([s, b]) => [s, s === 'AAPL' ? b.slice(-110) : b])) };
  assert.deepEqual(result(byKey('atr_from_daily_sma200'), stock('10:02'), young), { state: 'unknown', value: null, note: 'fewer than 199 daily sessions before' });
  assert.deepEqual(result(byKey('atr_from_weekly_sma50'), stock('10:02'), young), { state: 'unknown', value: null, note: 'fewer than 49 weeks before' });
  assert.equal(result(byKey('atr_from_daily_sma100'), stock('10:02'), young).state, 'value', '100 sessions are enough for the 100 SMA');
  // a stock's fill needs no 5-minute bars: an old trade stamps from daily history alone
  const old = computeFeature(byKey('atr_from_weekly_ema8'), featureContext(stock('10:02'), at('10:02'), { ...data, intraday: new Map() }, { now: NOW + 60 * 864e5, entryPrice: price }));
  near(old.value, (price - ema(wc, 8, price)) / atr, 'from the daily bars alone');
  assert.equal(featureValueWords(byKey('atr_from_daily_sma50'), 4.012), '+4.01 ATR');
  assert.equal(featureValueWords(byKey('atr_from_daily_sma50'), -0.5), '−0.50 ATR');
  // the weekly ones read about five years of daily bars
  const needs = featureDataNeeds([{ trade: stock('10:02'), features: [byKey('atr_from_weekly_ema50')] }]);
  assert.ok(needs.daily.get('AAPL') < '2021-11-01', 'five years back for the weekly closes');
});

/** Wilder's ATR(14) over the last 300 sessions before D, worked out here a second way */
function wilder14(bars) {
  const days = bars.filter(b => b.date < D).slice(-300);
  const tr = days.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - days[i].close), Math.abs(b.low - days[i].close)));
  let atr = tr.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
  for (const t of tr.slice(14)) atr = (atr * 13 + t) / 14;
  return atr;
}
const adr20 = bars => bars.filter(b => b.date < D).slice(-20).reduce((a, b) => a + b.high - b.low, 0) / 20;

test('distances inside the day in ADRs: VWAP, the low and the high of day so far; across days in ATRs: the gap, the all-time high, SPY and QQQ', () => {
  const data = world();
  const bars = data.intraday.get('AAPL').get(D), adr = adr20(data.daily.get('AAPL')), atr = wilder14(data.daily.get('AAPL'));
  const price = bars.find(b => b.time === '09:50').close; // a fill inside the morning's range
  // the low and high from 9:30 to 10:02: the bars ended by then and the open of the 10:00 one
  const morning = bars.filter(b => b.time >= '09:30' && b.time < '10:00');
  const low = Math.min(...morning.map(b => b.low)), high = Math.max(...morning.map(b => b.high), bars.find(b => b.time === '10:00').open);
  const lod = result(byKey('adr_from_lod'), stock('10:02'), data, price);
  near(lod.value, (price - low) / adr, 'above the low');
  const prevClose = data.daily.get('AAPL').filter(b => b.date < D).at(-1).close;
  assert.equal(lod.note, `low ${low.toFixed(2)} · ADR $${adr.toFixed(2)} (${(adr / prevClose * 100).toFixed(2)}%)`);
  near(result(byKey('adr_from_hod'), stock('10:02'), data, price).value, (high - price) / adr, 'below the high');
  // the fill traded, so a fill under every bar's low is the low itself
  assert.equal(result(byKey('adr_from_lod'), stock('10:02'), data, low - 1).value, 0);
  // before the open: the premarket's range from 4:00
  const pre = bars.filter(b => b.time < '08:10'), preLow = Math.min(...pre.map(b => b.low)), at810 = bars.find(b => b.time === '08:10').open;
  near(result(byKey('adr_from_lod'), stock('08:10'), data, at810).value, (at810 - Math.min(preLow, at810)) / adr, 'the premarket low');
  // an option: the underlying's last price
  const under = bars.find(b => b.time === '09:55').close;
  near(result(byKey('adr_from_hod'), call('10:02'), data).value, (high - under) / adr, "the underlying's");
  // no 5-minute bars that day: unknown, never 0
  const old = computeFeature(byKey('adr_from_lod'), featureContext(stock('10:02'), at('10:02'), { ...data, intraday: new Map() }, { now: NOW + 60 * 864e5, entryPrice: price }));
  assert.equal(old.state, 'unknown');
  // VWAP: the regular session's over the bars ended by 10:02
  const vol = morning.reduce((a, b) => a + b.volume, 0), vwap = morning.reduce((a, b) => a + (b.high + b.low + b.close) / 3 * b.volume, 0) / vol;
  const v = result(byKey('adr_from_vwap'), stock('10:02'), data, price);
  near(v.value, (price - vwap) / adr, 'from VWAP');
  assert.match(v.note, /^VWAP [\d.]+ · ADR \$[\d.]+ \([\d.]+%\)$/);
  assert.equal(result(byKey('adr_from_vwap'), stock('09:31'), data).note, 'no VWAP yet in the first 5 minutes');
  // the ADR comes from the history, so a split since doesn't change the answer
  const split = { ...data, daily: new Map([...data.daily].map(([s, b]) => [s, s === 'AAPL' ? b.map(x => ({ ...x, open: x.open / 4, high: x.high / 4, low: x.low / 4, close: x.close / 4 })) : b])) };
  near(result(byKey('adr_from_vwap'), stock('10:02'), split, price).value, v.value, 'the same across a split');
  near(result(byKey('adr_from_lod'), stock('10:02'), split, price).value, lod.value, 'and from the low');
  // the gap: the open against the close before, in ATRs, from 9:30
  const dl = data.daily.get('AAPL'), open = dl.find(b => b.date === D).open, prev = dl.filter(b => b.date < D).at(-1).close;
  near(result(byKey('gap_atr'), stock('10:02'), data).value, (open - prev) / atr, 'the gap');
  assert.equal(result(byKey('gap_atr'), stock('08:10'), data).note, 'entered before the open');
  const splitGap = result(byKey('gap_atr'), stock('10:02'), split);
  near(splitGap.value, (open - prev) / atr, 'the gap across a split');
  assert.ok(splitGap.note.startsWith(`ATR $${atr.toFixed(2)} (`), `the note's dollars in the day's own prices: ${splitGap.note}`);
  // the all-time high, in ATRs
  const top = Math.max(...dl.filter(b => b.date < D).map(b => b.high), Math.max(...morning.map(b => b.high), bars.find(b => b.time === '10:00').open));
  near(result(byKey('atr_from_ath'), stock('10:02'), data, 90).value, (90 - top) / atr, 'under the high');
  // SPY and QQQ: their own price and their own ATR
  const spyDaily = data.daily.get('SPY'), spyPrior = spyDaily.filter(b => b.date < D).slice(-60);
  let e = spyPrior.slice(0, 8).reduce((a, b) => a + b.close, 0) / 8;
  for (const b of spyPrior.slice(8)) e = b.close * 2 / 9 + e * 7 / 9;
  const spy = data.intraday.get('SPY').get(D).find(b => b.time === '09:55').close;
  near(result(byKey('spy_atr_from_daily_ema8'), stock('10:02'), data).value, (spy - (spy * 2 / 9 + e * 7 / 9)) / wilder14(spyDaily), 'SPY in its ATRs');
  assert.equal(result(byKey('qqq_atr_from_daily_ema8'), call('10:02'), data).state, 'value');
  assert.equal(featureValueWords(byKey('adr_from_vwap'), 0.5), '+0.50 ADR');
});

test('the daily range: ADR and ATR, each in dollars in the day\'s own prices and as a % of the close before', () => {
  const data = world();
  const dl = data.daily.get('AAPL'), adr = adr20(dl), atr = wilder14(dl), prev = dl.filter(b => b.date < D).at(-1).close;
  assert.deepEqual(FEATURES.filter(f => f.family.key === 'range').map(f => f.key), ['adr_20_usd', 'adr_20_pct', 'atr_14_usd', 'atr_14_pct']);
  near(result(byKey('adr_20_usd'), stock('10:02'), data).value, adr, 'ADR $');
  near(result(byKey('adr_20_pct'), stock('10:02'), data).value, adr / prev * 100, 'ADR %');
  near(result(byKey('atr_14_usd'), stock('10:02'), data).value, atr, 'ATR $');
  near(result(byKey('atr_14_pct'), stock('10:02'), data).value, atr / prev * 100, 'ATR %');
  assert.equal(featureValueWords(byKey('atr_14_usd'), 2.5), '$2.50');
  assert.equal(featureValueWords(byKey('atr_14_pct'), 2.1), '+2.10%');
  // history adjusted for a 4-for-1 since: the dollars stay in the day's prices, the % never changes
  const split = { ...data, daily: new Map([...data.daily].map(([s, b]) => [s, s === 'AAPL' ? b.map(x => ({ ...x, open: x.open / 4, high: x.high / 4, low: x.low / 4, close: x.close / 4 })) : b])) };
  near(result(byKey('atr_14_usd'), stock('10:02'), split).value, atr, "the day's dollars");
  near(result(byKey('adr_20_pct'), stock('10:02'), split).value, adr / prev * 100, 'the same %');
  // a young stock
  const young = { ...data, daily: new Map([...data.daily].map(([s, b]) => [s, s === 'AAPL' ? b.slice(-14) : b])) };
  assert.deepEqual(result(byKey('atr_14_pct'), stock('10:02'), young), { state: 'unknown', value: null, note: 'fewer than 15 daily sessions before' });
});

test("futures: daily history under the contract, no split check, no gap, never waiting on 5-minute bars", () => {
  const data = world();
  // a future's daily bars, as the stamper keeps them: under the contract traded (read from Schwab for its root)
  const fut = data.daily.get('AAPL').map(b => ({ ...b, open: b.open * 200, high: b.high * 200, low: b.low * 200, close: b.close * 200 }));
  data.daily.set('/MNQZ26', fut);
  const trade = { ...stock('10:02'), key: '6789|/MNQZ26|long|10:02', symbol: '/MNQZ26', assetType: 'FUTURE' };
  const prior = fut.filter(b => b.date < D), atr = wilder14(fut);
  const fill = prior.at(-1).close * 1.3; // far from the history: a stock would read it as a split, a future never splits
  const sma = (closes, n, price) => (closes.slice(-(n - 1)).reduce((a, b) => a + b, 0) + price) / n;
  const r = result(byKey('atr_from_daily_sma50'), trade, data, fill);
  assert.equal(r.state, 'value', r.note);
  near(r.value, (fill - sma(prior.slice(-300).map(b => b.close), 50, fill)) / atr, 'ATRs from the 50 SMA, prices as they are');
  near(result(byKey('atr_14_pct'), trade, data, fill).value, atr / prior.at(-1).close * 100, 'ATR as a %');
  assert.equal(result(byKey('rvol_prior_day'), trade, data, fill).state, 'value', 'volume ratios work');
  // no 9:30 gap, no dollar volume
  for (const k of ['gap_at_open', 'gap_atr']) assert.deepEqual(result(byKey(k), trade, data, fill), { state: 'unknown', value: null, note: "a future's daily bar opens at 6 PM the evening before, so it has no 9:30 gap" }, k);
  assert.equal(result(byKey('avg_dollar_volume_20d'), trade, data, fill).note, "a future's price × contracts isn't dollars traded");
  // inside the bar saver's window a stock's day would wait; a future's is gone at once (the saver keeps none)
  const lod = result(byKey('adr_from_lod'), trade, data, fill);
  assert.equal(lod.state, 'unknown');
  assert.match(lod.note, /no 5-minute bars are kept for futures \(\/MNQZ26\)/);
  // its daily history not read yet: waits, like a stock's
  assert.equal(result(byKey('atr_from_daily_sma50'), trade, { ...data, daily: new Map([...data.daily].filter(([k]) => k !== '/MNQZ26')) }, fill).state, 'waiting');
});

// ---------- stamping ----------

test('stamping: missing or outdated features are due, three states, unknown stamped with why, waiting left for later', () => {
  const data = world();
  const t = stock('10:02');
  const due = featuresDue([t, { ...t, key: 'x', deleted: true }, { ...t, key: 'y', status: 'history' }], {});
  assert.deepEqual(due.map(d => d.trade.key), [t.key], 'deleted trades and closes from before the history get none');
  assert.equal(due[0].features.length, FEATURES.length);
  const thin = { ...data, intraday: new Map([...data.intraday].map(([s, m]) => [s, s === 'AAPL' ? new Map([...m].filter(([d]) => d >= '2026-10-08')) : m])) };
  const r = stampTrade(t, { gone_feature: { v: '1.1', value: 3 } }, FEATURES, thin, { now: NOW, entryPrice: 101 });
  assert.ok(r.changed);
  assert.equal(r.results.rvol_at_entry.state, 'waiting');
  assert.ok(!('rvol_at_entry' in r.stamps), 'waiting: not stamped');
  assert.ok(!('gone_feature' in r.stamps), "a removed feature's stamp is dropped");
  assert.deepEqual(Object.keys(r.stamps[('spy_vs_daily_ema8')]), ['v', 'value']);
  assert.equal(r.stamps.spy_vs_daily_ema8.v, '1.1');
  const early = stampTrade(stock('09:31'), {}, FEATURES, data, { now: NOW, entryPrice: 101 });
  assert.deepEqual(early.stamps.rvol_at_entry, { v: '1.1', value: null, note: 'entered in the first 5 minutes' }, 'unknown for good: stamped, with why');
  // a newer version is due again; the current one isn't
  const f = FEATURES[0];
  assert.equal(featureDue(f, r.stamps), false);
  assert.equal(featureDue({ ...f, version: f.version + 1 }, r.stamps), true);
  assert.equal(featureDue({ ...f, family: { ...f.family, version: 2 } }, r.stamps), true, "a family's version restamps every feature in it");
  // how far it's stamped
  const cov = featureCoverage(byKey('rvol_at_entry'), [t, stock('09:31')], { [t.key]: r.stamps, [stock('09:31').key]: early.stamps });
  assert.deepEqual(cov, { total: 2, value: 0, unknown: 1, pending: 1, reasons: [['entered in the first 5 minutes', 1]] });
  assert.equal(featureValueWords(byKey('rvol_at_entry'), 2.345), '2.35×');
  assert.equal(featureValueWords(byKey('entry_vs_vwap'), -0.5), '−0.50%');
  assert.equal(featureValueWords(byKey('entry_vs_vwap'), null), '—');
});

test('what a run reads: the moment\'s day and its lookback per symbol; daily bars from far enough back', () => {
  const needs = featureDataNeeds([{ trade: call('10:02'), features: FEATURES }]);
  assert.deepEqual([...needs.intraday.keys()].sort(), ['AAPL', 'QQQ', 'SPY', 'VIX'], "the option's underlying, never the contract, for these");
  assert.equal(needs.intraday.get('AAPL').length, 21, 'the day and the 20 weekdays before');
  assert.deepEqual(needs.intraday.get('SPY'), [D]);
  assert.equal(needs.daily.get('AAPL'), '1960-01-01', 'the all-time high wants every day');
  assert.ok(needs.daily.get('SPY') < '2025-09-01' && needs.daily.get('SPY') > '2025-07-01', 'the ATR, 300 sessions and room for holidays');
  assert.deepEqual(needs.intraday.get('VIX'), [D]);
  assert.ok(needs.daily.get('VIX') > '2026-09-01', 'VIX: the few sessions before');
  assert.deepEqual(featureBarNeeds(), { market: ['SPY', 'QQQ', 'VIX'], lookback: 20 }, 'the bar saver keeps what features name');
});

// ---------- the Journal ----------

const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const BUY = {
  orderId: 801, enteredTime: '2026-10-14T14:02:00+0000', status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction: 'BUY', quantity: 100, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 8001, executionLegs: [{ legId: 1, quantity: 100, price: 101.37, time: '2026-10-14T14:02:20+0000' }] }],
};
const SELL = {
  orderId: 802, enteredTime: '2026-10-14T19:00:00+0000', status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction: 'SELL', quantity: 100, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 8002, executionLegs: [{ legId: 1, quantity: 100, price: 104, time: '2026-10-14T19:00:00+0000' }] }],
};
const KEY = '6789|AAPL|long|2026-10-14T14:02:20.000Z';
const pack = bars => bars.map(b => [b.time, b.open, b.high, b.low, b.close, b.volume]);

/** the saved bars and Tradier's daily history for the world above */
function journalApp(opts = {}) {
  const w = world();
  const supabase = fakeRecords([
    { kind: 'order', record_id: '801', account: '6789', entered_at: '2026-10-14T14:02:00Z', data: BUY },
    { kind: 'order', record_id: '802', account: '6789', entered_at: '2026-10-14T19:00:00Z', data: SELL },
  ]);
  for (const [sym, days] of w.intraday) for (const [d, bars] of days) if (d <= D) supabase.bars.set(`user-1:${sym}:${d}`, { user_id: 'user-1', symbol: sym, day: d, bars: pack(bars) });
  const calls = [];
  const fetch = async url => {
    const u = new URL(url);
    calls.push(u.pathname + '?' + u.searchParams.get('symbol'));
    if (u.pathname.endsWith('/markets/history')) {
      const rows = (w.daily.get(u.searchParams.get('symbol')) || []).filter(b => b.date >= u.searchParams.get('start') && b.date <= u.searchParams.get('end'));
      return new Response(JSON.stringify({ history: rows.length ? { day: rows } : null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ series: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { w, supabase, calls, fetch, ...opts };
}
const settle = async () => { for (let i = 0; i < 60; i++) await new Promise(r => setImmediate(r)); };
// canvases can't read CSS variables, so the trade page's colors come from the stylesheet: here, each variable's own name
globalThis.getComputedStyle = () => ({ getPropertyValue: n => n });

test('the Journal stamps every trade after it loads, shows the Features tab, and the trade page lists them', async () => {
  const j = journalApp();
  const a = await app({ supabase: j.supabase, session: SESSION, fetch: j.fetch, clock: true, now: NOW, storage: new Map([['journal_bars', JSON.stringify({ user: 'user-1', at: NOW })]]) });
  a.elements.get('apiKey').value = 'test-key';
  a.run("setView('journal')");
  await a.run('loadJournal()');
  await settle();
  const row = j.supabase.tables.trade_features.get(`user-1:${KEY}`);
  assert.ok(row, 'the trade got a trade_features row');
  assert.deepEqual(Object.keys(row.stamps).sort(), FEATURES.map(f => f.key).sort(), 'every feature');
  assert.ok(row.stamps.rvol_at_entry.value > 1.9, 'from the saved bars');
  assert.ok(row.stamps.dist_from_ath.value < 0);
  assert.equal(j.calls.filter(c => c.startsWith('/v1/markets/history')).length, 4, 'one daily read per symbol: AAPL, SPY, QQQ, VIX');
  assert.equal(a.state.featuresBusy, false);
  assert.equal(a.state.featuresLast.value, FEATURES.length);
  // nothing due: the next load reads, stamps nothing
  const writes = j.supabase.writes.filter(w => w.table === 'trade_features').length;
  await a.run('loadJournal()');
  await settle();
  assert.equal(j.supabase.writes.filter(w => w.table === 'trade_features').length, writes, 'nothing new to stamp');
  // the Features tab
  a.run("setJournalTab('features')");
  const html = a.elements.get('journalSection').innerHTML;
  assert.match(html, /Volume run rate at entry/);
  assert.match(html, /<b>1 of 1<\/b>/);
  assert.match(html, /5-minute bars: the stock, and the 20 sessions before/);
  assert.match(html, /Last stamped/);
  // the trade page
  a.run(`openJournalTrade('${KEY}')`);
  await settle();
  const body = () => a.elements.get('jtBody').innerHTML;
  assert.match(body(), new RegExp(`data-action="setJournalTradeTab" data-arg="features">Features <span class="jt-tab-n">${FEATURES.length}</span>`), 'a Features tab with how many have a value');
  assert.doesNotMatch(body(), /id="jtFeatures"/, 'the review shows first');
  assert.match(body(), /class="journal-review|Review/);
  a.run("setJournalTradeTab('features')");
  assert.match(body(), new RegExp(`${FEATURES.length} features at the entry and exit: ${FEATURES.length} with a value\\. Tap one for what it measures`));
  assert.match(body(), /<div class="jf-fam">Market<\/div>/, 'by family');
  assert.match(body(), /<span class="jf-name">Volume run rate at entry<\/span><span class="jf-val">\d\.\d\d×<\/span>/);
  assert.match(body(), /<span class="jf-name">Distance from the all-time high<\/span><span class="jf-val">−[\d.]+%<\/span><span class="jf-how">high [\d.]+ on/);
  assert.match(body(), /<details class="jf-item">[\s\S]*?<p>The stock[^ ]* volume from 9:30[\s\S]*?Reads 5-minute bars: the stock, and the 20 sessions before · version 1\.1 · <span class="jf-key">rvol_at_entry/, 'tap one: what it measures and reads');
  assert.doesNotMatch(body(), /<details class="jf-item[^"]*" open>/, 'closed until tapped');
  a.run('toggleTradeFeatures()');
  assert.match(a.elements.get('jtFeatures').innerHTML, /<details class="jf-item" open>/, 'Expand all opens every one, in place');
  assert.match(a.elements.get('jtFeatures').innerHTML, />Collapse all</);
  a.run("setJournalTradeTab('review')");
  assert.doesNotMatch(body(), /id="jtFeatures"/);
  assert.match(body(), /Fills/, 'the fills stay under Review');
});

test('a feature waiting for its data is tried again later, not stamped; a new version restamps', async () => {
  const j = journalApp();
  j.supabase.bars.delete(`user-1:SPY:${D}`); // the saver hasn't got SPY's day yet
  const a = await app({ supabase: j.supabase, session: SESSION, fetch: j.fetch, clock: true, now: NOW, storage: new Map([['journal_bars', JSON.stringify({ user: 'user-1', at: NOW })]]) });
  a.elements.get('apiKey').value = 'test-key';
  a.run("setView('journal')");
  await a.run('loadJournal()');
  await settle();
  const stamps = () => j.supabase.tables.trade_features.get(`user-1:${KEY}`).stamps;
  assert.ok(!('spy_vs_daily_ema8' in stamps()), 'waiting: no stamp');
  assert.ok('qqq_vs_daily_ema8' in stamps());
  assert.match(a.state.featureWaits[KEY].spy_vs_daily_ema8, /SPY 5-minute bars on 10\/14/);
  a.run(`openJournalTrade('${KEY}')`);
  await settle();
  a.run("setJournalTradeTab('features')");
  assert.match(a.elements.get('jtBody').innerHTML, /<details class="jf-item jf-quiet">\s*<summary><span class="jf-name">SPY vs daily 8 EMA<\/span><span class="jf-val">—<\/span><span class="jf-how">waiting for SPY 5-minute bars on 10\/14/);
  assert.match(a.state.featureWaits[KEY].spy_atr_from_daily_ema8, /SPY 5-minute bars on 10\/14/, 'and in ATRs');
  assert.match(a.elements.get('jtBody').innerHTML, new RegExp(`${FEATURES.length - 2} with a value, 2 still to come`));
  a.run('closeJournalTrade()');
  // SPY's day saved: the next run waits out the retry gap, then stamps it
  j.supabase.bars.set(`user-1:SPY:${D}`, { user_id: 'user-1', symbol: 'SPY', day: D, bars: pack(j.w.intraday.get('SPY').get(D)) });
  await a.run('loadJournal()');
  await settle();
  assert.ok(!('spy_vs_daily_ema8' in stamps()), 'within the retry gap: not tried');
  await a.advance(16 * 60000);
  await a.run('loadJournal()');
  await settle();
  assert.equal(typeof stamps().spy_vs_daily_ema8.value, 'number', 'tried again and stamped');
  // an outdated stamp (an older version) is due again
  j.supabase.tables.trade_features.get(`user-1:${KEY}`).stamps.gap_at_open.v = '1.0';
  await a.run('loadJournal()');
  await settle();
  assert.equal(stamps().gap_at_open.v, featureVersion(byKey('gap_at_open')), 'restamped');
});

test('before the trade_features table is pushed, the Journal works and says what features need', async () => {
  const j = journalApp();
  j.supabase.failTable('trade_features');
  const a = await app({ supabase: j.supabase, session: SESSION, fetch: j.fetch, clock: true, now: NOW, storage: new Map([['journal_bars', JSON.stringify({ user: 'user-1', at: NOW })]]) });
  a.elements.get('apiKey').value = 'test-key';
  a.run("setView('journal')");
  await a.run('loadJournal()');
  await settle();
  assert.match(a.state.featuresError, /trade_features table yet: npx supabase db push/);
  assert.match(a.elements.get('journalSection').innerHTML, /AAPL/, 'the trades still show');
  assert.equal(j.calls.filter(c => c.startsWith('/v1/markets/history')).length, 0, 'nothing is worked out that can\'t be saved');
  a.run("setJournalTab('features')");
  assert.match(a.elements.get('journalSection').innerHTML, /Features can't be saved yet/);
  a.run(`openJournalTrade('${KEY}')`);
  await settle();
  a.run("setJournalTradeTab('features')");
  assert.match(a.elements.get('jtBody').innerHTML, /Features need the database update: npx supabase db push/);
});

test('the bar saver keeps what the features name, on top of the market basket', async () => {
  const { run } = await app();
  const keep = JSON.parse(run('JSON.stringify(barsToKeep())'));
  assert.ok(keep.market.includes('SPY') && keep.market.includes('XLK'));
  assert.ok(keep.market.includes('VIX'), 'VIX, for the VIX features');
  assert.equal(new Set(keep.market).size, keep.market.length);
  assert.equal(keep.lookback, 20);
});
