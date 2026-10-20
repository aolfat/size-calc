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
import { earlyCloseDay, weekdaysBefore, weekdaysBetween } from '../src/core/bars.js';
import { breadthCounts, breadthDaysToRead, groupedToDay } from '../src/core/breadth.js';
import { bsPrice, normCdf, RISK_FREE } from '../src/core/black-scholes.js';
import { expiryCloseMs } from '../src/core/options.js';
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
  for (const d of weekdaysBefore(D, 50)) m.set(d, day(d, base, 1000));
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
const SECTORS = ['XLK', 'XLF', 'XLV', 'XLY', 'XLC', 'XLI', 'XLP', 'XLE', 'XLU', 'XLB', 'XLRE'];
/** the market breadth at the close of each weekday before D: 60% over the 5-day, falling to 40% over the 200-day */
function breadthRows() {
  const m = new Map();
  for (const d of weekdaysBefore(D, 30)) m.set(d, { 5: [600, 1000], 20: [550, 1000], 50: [500, 1000], 100: [450, 1000], 200: [400, 1000] });
  for (const d of [D, ...AFTER]) m.set(d, { 5: [990, 1000], 20: [990, 1000], 50: [990, 1000], 100: [990, 1000], 200: [990, 1000] });
  return m;
}
function world() {
  const aapl = intraday(100), spy = intraday(500, 3000), qqq = intraday(400), iwm = intraday(200);
  const sectors = SECTORS.map((s, i) => [s, intraday(50 + i * 5)]);
  return {
    intraday: new Map([['AAPL', aapl], ['SPY', spy], ['QQQ', qqq], ['IWM', iwm], ...sectors]),
    daily: new Map([['AAPL', daily(100, aapl)], ['SPY', daily(500, spy)], ['QQQ', daily(400, qqq)], ['IWM', daily(200, iwm)], ...sectors.map(([s, m], i) => [s, daily(50 + i * 5, m)])]),
    breadth: breadthRows(),
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
  // the breadth at the moment's day's close and later isn't known at the moment
  const breadth = data.breadth && new Map([...data.breadth].flatMap(([dd, c]) => dd < d ? [[dd, c]] : cut ? [] : [[dd, { 5: [1, 1000], 20: [2, 1000], 50: [3, 1000], 100: [4, 1000], 200: [5, 1000] }]]));
  return { intraday: intra, daily: dly, breadth };
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
    assert.ok(['%', 'x', '$', ''].includes(f.unit));
    assert.deepEqual(Object.keys(f.needs).filter(k => !['intraday', 'lookback', 'daily', 'dailySessions', 'session', 'breadth'].includes(k)), [], `${f.key}: only known needs`);
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
        if (read.kind === 'breadth') assert.equal(f.needs.breadth, true, `${f.key} reads the market's breadth: declare breadth`);
        else if (read.kind === 'intraday') {
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
  assert.deepEqual([...needs.intraday.keys()].sort(), ['AAPL', 'IWM', 'QQQ', 'SPY', ...SECTORS].sort(), "the option's underlying, never the contract, for these");
  assert.equal(needs.intraday.get('AAPL').length, 51, 'the day and the 50 weekdays before (the run rate\'s curve)');
  assert.deepEqual(needs.intraday.get('SPY'), [D]);
  assert.equal(needs.daily.get('AAPL'), '1960-01-01', 'the all-time high wants every day');
  assert.ok(needs.daily.get('SPY') < '2026-01-10' && needs.daily.get('SPY') > '2025-12-01', 'the 200 SMA: 200 sessions and room for holidays');
  assert.ok(needs.daily.get('XLK') < '2026-07-20' && needs.daily.get('XLK') > '2026-06-01', 'the sectors\' EMAs: 60 sessions');
  assert.equal(needs.breadth, true, 'and the market breadth');
  assert.equal(featureDataNeeds([{ trade: call('10:02'), features: [byKey('rvol_at_entry')] }]).breadth, false);
  assert.deepEqual(featureBarNeeds(), { market: ['SPY', 'QQQ', 'IWM', ...SECTORS], lookback: 50 }, 'the bar saver keeps what features name');
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
  for (const [d, counts] of w.breadth) if (d < D) supabase.tables.market_breadth.set(`user-1:us_common:${d}`, { user_id: 'user-1', universe: 'us_common', day: d, counts });
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
  near(row.stamps.breadth_sma20.value, 55, "the market breadth from the account's counts");
  assert.equal(typeof row.stamps.run_rate_20.value, 'number', 'the run rate, from 50 saved sessions');
  assert.equal(row.stamps.iv_at_entry.note, 'not an option', 'a stock has no option features');
  assert.equal(j.calls.filter(c => c.startsWith('/v1/markets/history')).length, 15, 'one daily read per symbol: AAPL, SPY, QQQ, IWM and the 11 sectors');
  assert.equal(a.state.featuresBusy, false);
  assert.equal(a.state.featuresLast.waiting, 0);
  assert.equal(a.state.featuresLast.value + a.state.featuresLast.unknown, FEATURES.length);
  const values = a.state.featuresLast.value;
  // nothing due: the next load reads, stamps nothing
  const writes = j.supabase.writes.filter(w => w.table === 'trade_features').length;
  await a.run('loadJournal()');
  await settle();
  assert.equal(j.supabase.writes.filter(w => w.table === 'trade_features').length, writes, 'nothing new to stamp');
  // the Features tab
  a.run("setJournalTab('features')");
  const html = a.elements.get('journalSection').innerHTML;
  assert.match(html, /Relative volume by time of day/);
  assert.match(html, /Volume run rate \(20-day\)/);
  assert.match(html, /<th colspan="4" scope="colgroup">Market breadth<\/th>/);
  assert.match(html, /<b>1 of 1<\/b>/);
  assert.match(html, /5-minute bars: the stock, and the 20 sessions before/);
  assert.match(html, /Last stamped/);
  // the trade page
  a.run(`openJournalTrade('${KEY}')`);
  await settle();
  const body = () => a.elements.get('jtBody').innerHTML;
  assert.match(body(), new RegExp(`data-action="setJournalTradeTab" data-arg="features">Features <span class="jt-tab-n">${values}<\\/span>`), 'a Features tab with how many have a value');
  assert.doesNotMatch(body(), /id="jtFeatures"/, 'the review shows first');
  assert.match(body(), /class="journal-review|Review/);
  a.run("setJournalTradeTab('features')");
  assert.match(body(), new RegExp(`${FEATURES.length} features: ${values} with a value, ${FEATURES.length - values} unknown\\. Tap one for what it measures`));
  assert.match(body(), /<div class="jf-fam">Market<\/div>/, 'by family');
  assert.match(body(), /<span class="jf-name">Relative volume by time of day<\/span><span class="jf-val">\d\.\d\d×<\/span>/);
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
  assert.match(a.elements.get('jtBody').innerHTML, /\d+ with a value, \d+ unknown, \d+ still to come/);
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
  assert.equal(stamps().gap_at_open.v, '1.1', 'restamped');
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
  assert.equal(new Set(keep.market).size, keep.market.length);
  assert.equal(keep.lookback, 50, "the run rate's curve: 50 sessions");
});

// ---------- the run rate ----------

const sumVol = rows => rows.reduce((n, b) => n + (b.volume || 0), 0);
const regularTo = (rows, cut) => sumVol(rows.filter(b => b.time >= '09:30' && b.time < cut));
const premarket = rows => sumVol(rows.filter(b => b.time < '09:30'));

test('run rate: the premarket plus the prints so far over the curve, against the median day', () => {
  const data = world();
  const bars = data.intraday.get('AAPL'), totals = new Map(data.daily.get('AAPL').map(b => [b.date, b.volume]));
  // the bars ended by 10:02 run to the 9:55 bar: the curve is read at the same 10:00 mark on every day
  const shares = weekdaysBefore(D, 50).map(d => regularTo(bars.get(d), '10:00') / (totals.get(d) - premarket(bars.get(d))));
  const u = shares.reduce((a, b) => a + b, 0) / shares.length;
  const projected = premarket(bars.get(D)) + regularTo(bars.get(D), '10:00') / u;
  const r = result(byKey('run_rate_20'), stock('10:02'), data);
  near(r.value, (projected / 1e6 - 1) * 100, 'projected over the median daily total');
  assert.match(r.note, /^projected [\d.]+[kM] vs median 1\.00M · curve from 50 sessions$/);
  assert.equal(result(byKey('run_rate_50'), stock('10:02'), data).value, r.value, 'every day here is 1M, so the 50-day median is the same');
  assert.equal(result(byKey('run_rate_20'), call('10:02'), data).value, r.value, 'an option reads its underlying');
  // the denominator is the whole day, not the bars: a day's 5-minute bars sum to well under its total
  assert.ok(u < 0.1, 'the fixture\'s bars are a small share of its daily totals');
  assert.match(result(byKey('run_rate_20'), stock('09:41'), data).note, /~ first 15 minutes, noisy$/);
  assert.doesNotMatch(result(byKey('run_rate_20'), stock('09:47'), data).note, /first 15/);
  assert.deepEqual(result(byKey('run_rate_20'), stock('09:31'), data), { state: 'unknown', value: null, note: 'entered in the first 5 minutes' });
  assert.equal(result(byKey('run_rate_20'), stock('08:10'), data).note, 'entered before the open');
  assert.equal(result(byKey('run_rate_20'), stock('17:05'), data).state, 'value', 'after hours: the whole regular session over the curve at the close');
  // too few sessions kept for the curve: unknown, once nothing more can come
  const thin = { ...data, intraday: new Map([...data.intraday].map(([s, m]) => [s, s === 'AAPL' ? new Map([...m].filter(([d]) => d >= '2026-09-30')) : m])) };
  const old = computeFeature(byKey('run_rate_20'), featureContext(stock('10:02'), at('10:02'), thin, { now: NOW + 60 * 864e5 }));
  assert.deepEqual([old.state, old.note], ['unknown', 'the curve needs 15 of the 50 sessions before; 10 kept']);
  assert.equal(result(byKey('run_rate_20'), stock('10:02'), thin).state, 'waiting', 'inside the window the saver still fetches them');
  // at the exit: the same, cut at 15:00
  assert.equal(result(byKey('run_rate_20_at_exit'), stock('10:02'), data).state, 'value');
});

test('half days: 1pm closes are July 3 and Christmas Eve Monday to Thursday, and the day after Thanksgiving', () => {
  for (const d of ['2025-07-03', '2026-12-24', '2026-11-27', '2025-11-28', '2024-12-24']) assert.equal(earlyCloseDay(d), true, d);
  for (const d of ['2026-07-03', '2027-12-24', '2026-11-20', '2026-11-26', '2026-10-14']) assert.equal(earlyCloseDay(d), false, d);
  const data = world();
  const t = { ...stock('10:02'), openedAt: '2026-11-27T15:02:20.000Z' };
  assert.equal(computeFeature(byKey('run_rate_20'), featureContext(t, Date.parse(t.openedAt), { ...data, intraday: new Map([['AAPL', new Map([['2026-11-27', day('2026-11-27', 100, 1000)]])]]) }, { now: Date.parse('2026-12-20T12:00:00Z') })).note, 'a half day: no curve for it');
});

test('premarket and last-bar volume against their usual', () => {
  const data = world();
  const bars = data.intraday.get('AAPL');
  const pm = result(byKey('premarket_rvol'), stock('08:10'), data);
  near(pm.value, sumVol(bars.get(D).filter(b => b.time < '08:10')) / sumVol(bars.get(weekdaysBefore(D, 1)[0]).filter(b => b.time < '08:10')), 'to the same time on each day');
  assert.match(pm.note, /vs a usual/);
  const prev = result(byKey('prev_bar_rvol'), stock('10:02'), data);
  assert.equal(prev.note, 'the 09:55 bar', 'the bar before the one you entered in');
  near(prev.value, bars.get(D).find(b => b.time === '09:55').volume / bars.get(weekdaysBefore(D, 1)[0]).find(b => b.time === '09:55').volume, 'against that bar on the days before');
  assert.equal(result(byKey('dollar_volume_20'), stock('10:02'), data).state, 'value');
  assert.equal(featureValueWords(byKey('dollar_volume_20'), 108950000), '$109.0M');
  assert.equal(result(byKey('up_down_volume_50'), stock('10:02'), data).note, 'no down days in the 50 sessions', 'the fixture only rises');
});

// ---------- market breadth ----------

test('breadth features: the close before the entry; a shut day stepped over; a day not counted yet waits, an old one is gone', () => {
  const data = world();
  const f = byKey('breadth_sma20');
  const r = result(f, stock('10:02'), data);
  assert.deepEqual(r, { state: 'value', value: 55, note: 'close of 10/13, 1,000 stocks' });
  assert.equal(result(f, stock('08:10'), data).value, 55, 'a premarket entry: the same close');
  assert.equal(result(byKey('breadth_sma200'), stock('10:02'), data).value, 40);
  data.breadth.set('2026-10-13', { closed: true });
  assert.equal(result(f, stock('10:02'), data).note, 'close of 10/12, 1,000 stocks', 'a weekday the market was shut is stepped over');
  data.breadth.delete('2026-10-13');
  assert.deepEqual(result(f, stock('10:02'), data), { state: 'waiting', value: null, note: 'waiting for market breadth on 10/13' });
  const later = computeFeature(f, featureContext(stock('10:02'), at('10:02'), data, { now: NOW + 800 * 864e5 }));
  assert.equal(later.state, 'unknown', 'past what the provider reaches: gone');
  assert.match(later.note, /^market breadth from before /);
  data.breadth.set('2026-10-13', { 5: [1, 2] });
  assert.equal(result(f, stock('10:02'), data).note, 'waiting for 20-day breadth on 10/13', 'counted without enough history for the 20-day yet');
  assert.equal(result(f, stock('10:02'), { ...data, breadth: null }).state, 'waiting', 'not read (no table yet, a failed read): wait');
});

test('breadth counts: each stock\'s close over its n-day average; nothing across a gap; shut days stepped over', () => {
  const days = weekdaysBetween('2025-11-03', '2026-10-13');
  const rows = days.map((d, i) => ({ day: d, tickers: ['UP', 'DOWN', 'FLAT'], closes: [100 + i, 400 - i, 50] }));
  rows[100] = { day: days[100], closed: true };
  rows[150].tickers = ['UP', 'FLAT']; rows[150].closes = [250, 50]; // DOWN didn't trade
  const counts = breadthCounts(rows);
  assert.deepEqual(counts.get(days.at(-1)), { 5: [1, 3], 20: [1, 3], 50: [1, 3], 100: [1, 3], 200: [1, 3] }, 'only the riser is over its averages; flat is not over');
  assert.deepEqual(counts.get(days[100]), { closed: true });
  assert.deepEqual(counts.get(days[150])['5'], [1, 2], 'a stock that didn\'t trade isn\'t counted that day');
  assert.deepEqual(Object.keys(counts.get(days[3])), [], 'four sessions in: no 5-day yet');
  assert.deepEqual(Object.keys(counts.get(days[4])), ['5']);
  // a weekday missing from the closes starts every average over
  const gap = breadthCounts(rows.filter((_, i) => i !== 230));
  assert.equal(gap.has(days[230]), false);
  assert.deepEqual(Object.keys(gap.get(days[233])), [], 'three sessions after the gap');
  assert.deepEqual(Object.keys(gap.get(days[235])), ['5']);
});

test('which days to read: what the trades need, the sessions before for the longest average, newest first, inside the reach', () => {
  const days = breadthDaysToRead({ moments: [D], rows: new Map(), read: new Set(), now: NOW, through: '2026-10-14' });
  assert.equal(days[0], '2026-10-14', 'newest first');
  assert.ok(days.includes('2026-10-13') && days.length > 200 && days.length < 230, 'the session before, and the 200 before it with room for holidays');
  assert.deepEqual([...days].sort().reverse(), days);
  const done = new Map([['2026-10-13', { 5: [1, 2], 20: [1, 2], 50: [1, 2], 100: [1, 2], 200: [1, 2] }], ['2026-10-14', { 5: [1, 2], 20: [1, 2], 50: [1, 2], 100: [1, 2], 200: [1, 2] }]]);
  assert.deepEqual(breadthDaysToRead({ moments: [D], rows: done, read: new Set(), now: NOW, through: '2026-10-14' }), [], 'counted already: nothing');
  assert.deepEqual(breadthDaysToRead({ moments: [D], rows: new Map(), read: new Set(days), now: NOW, through: '2026-10-14' }), [], 'read already: nothing more to ask for');
  const old = breadthDaysToRead({ moments: ['2024-12-02'], rows: new Map(), read: new Set(), now: NOW, through: '2024-12-03' });
  assert.ok(old.every(d => d >= '2024-10-15'), 'never before the two years the provider reaches');
  const universe = new Set(['AAPL', 'MSFT']);
  assert.deepEqual(groupedToDay('2026-10-09', { results: [{ T: 'AAPL', c: 245 }, { T: 'SPY', c: 600 }, { T: 'MSFT', c: 0 }] }, universe, NOW), { day: '2026-10-09', tickers: ['AAPL'], closes: [245] }, 'common stocks only, real closes only');
  assert.deepEqual(groupedToDay('2026-10-12', { resultsCount: 0 }, universe, NOW), { day: '2026-10-12', closed: true }, 'an old empty day: shut');
  assert.equal(groupedToDay('2026-10-14', { resultsCount: 0 }, universe, NOW), null, 'yesterday empty: not posted yet, ask again');
});

test('the breadth fill reads Massive\'s closes newest first, saves the counts, and the breadth features stamp from them', async () => {
  const j = journalApp();
  j.supabase.tables.market_breadth.clear();
  const tickers = Array.from({ length: 1200 }, (_, i) => `T${i}`);
  const order = weekdaysBetween('2024-01-01', '2026-10-16');
  const massive = [];
  const fetch = async (url, opts) => {
    const u = new URL(url);
    if (u.hostname !== 'api.massive.com') return j.fetch(url, opts);
    massive.push(u.pathname + u.search);
    assert.equal(opts.headers.Authorization, 'Bearer mk-test', 'the key goes in a header, never the address');
    if (u.pathname === '/v3/reference/tickers') {
      const second = u.searchParams.get('cursor') === '2';
      return new Response(JSON.stringify({ results: (second ? tickers.slice(1000) : tickers.slice(0, 1000)).map(ticker => ({ ticker })), ...(second ? {} : { next_url: 'https://api.massive.com/v3/reference/tickers?cursor=2' }) }), { status: 200 });
    }
    const d = u.pathname.split('/').pop(), i = order.indexOf(d);
    return new Response(JSON.stringify({ resultsCount: 1201, results: [...tickers.map((T, k) => ({ T, c: k < 700 ? 100 + i : 900 - i })), { T: 'SPY', c: 600 }] }), { status: 200 });
  };
  const a = await app({ supabase: j.supabase, session: SESSION, fetch, clock: true, now: NOW, storage: new Map([['journal_bars', JSON.stringify({ user: 'user-1', at: NOW })], ['massive_key', 'mk-test']]) });
  a.run('wait = async () => {}');
  a.elements.get('apiKey').value = 'test-key';
  a.run("setView('journal')");
  await a.run('loadJournal()');
  for (let i = 0; i < 400 && (a.state.breadthBusy || a.state.featuresBusy || a.state.featuresRerun); i++) await settle();
  await settle();
  const grouped = massive.filter(p => p.startsWith('/v2/aggs/grouped/')).map(p => p.split('/').pop().slice(0, 10));
  assert.equal(massive.filter(p => p.startsWith('/v3/reference/tickers')).length, 2, 'the common-stock list, both pages');
  assert.equal(grouped[0], '2026-10-14', 'newest first');
  assert.deepEqual([...grouped].sort().reverse(), grouped);
  const row = j.supabase.tables.market_breadth.get('user-1:us_common:2026-10-13');
  assert.deepEqual(row.counts['200'], [700, 1200], 'the risers are over their 200-day; SPY is no common stock');
  assert.equal(row.source, 'massive');
  const stamps = j.supabase.tables.trade_features.get(`user-1:${KEY}`).stamps;
  near(stamps.breadth_sma200.value, 58.3, 'stamped from the counts');
  assert.equal(JSON.parse(a.storage.get('journal_breadth')).error, '');
  // within the hour: nothing more is asked of Massive
  const n = massive.length;
  await a.run('loadJournal()');
  await settle();
  assert.equal(massive.length, n);
});

test('without a Massive key nothing is fetched and the Features tab says what breadth needs', async () => {
  const j = journalApp();
  j.supabase.tables.market_breadth.clear();
  const a = await app({ supabase: j.supabase, session: SESSION, fetch: j.fetch, clock: true, now: NOW, storage: new Map([['journal_bars', JSON.stringify({ user: 'user-1', at: NOW })]]) });
  a.elements.get('apiKey').value = 'test-key';
  a.run("setView('journal')");
  await a.run('loadJournal()');
  await settle();
  assert.ok(!('breadth_sma20' in j.supabase.tables.trade_features.get(`user-1:${KEY}`).stamps), 'waiting, not stamped');
  a.run("setJournalTab('features')");
  assert.match(a.elements.get('journalSection').innerHTML, /Market breadth needs a Massive API key \(free\) in Settings/);
});

// ---------- the other families ----------

test('option features: days to expiry, the strike against the stock, and the IV and delta your fill implies', () => {
  const data = world();
  const S = data.intraday.get('AAPL').get(D).find(b => b.time === '09:55').close;
  const T = (expiryCloseMs('2026-12-18') - at('10:02')) / (365 * 864e5);
  const fill = bsPrice(true, S, 245, T, 0.45, RISK_FREE);
  near(result(byKey('iv_at_entry'), call('10:02'), data, fill).value, 45, 'the IV that prices your fill');
  const d1 = (Math.log(S / 245) + (RISK_FREE + 0.45 ** 2 / 2) * T) / (0.45 * Math.sqrt(T));
  near(result(byKey('delta_at_entry'), call('10:02'), data, fill).value, normCdf(d1), 'its delta');
  near(result(byKey('dte_at_entry'), call('10:02'), data, fill).value, T * 365, 'calendar days to the 4pm close on expiry');
  near(result(byKey('strike_vs_stock'), call('10:02'), data, fill).value, (245 / S - 1) * 100, 'a call above the stock: out of the money');
  near(result(byKey('premium_pct_of_stock'), call('10:02'), data, fill).value, fill / S * 100, 'premium over the stock');
  assert.match(result(byKey('iv_at_entry'), call('10:02'), data, S + 1).note, /can't be priced by Black-Scholes/);
  for (const k of ['iv_at_entry', 'dte_at_entry', 'strike_vs_stock']) assert.equal(result(byKey(k), stock('10:02'), data).note, 'not an option');
});

test('trend, levels, strength and timing on the fixture', () => {
  const data = world();
  const prior = data.daily.get('AAPL').filter(b => b.date < D);
  const sma200 = (prior.slice(-199).reduce((a, b) => a + b.close, 0) + 101.37) / 200;
  near(result(byKey('stock_vs_daily_sma200'), stock('10:02'), data, 101.37).value, (101.37 / sma200 - 1) * 100, 'your fill against the 200 SMA moved on by it');
  const bars = data.intraday.get('AAPL').get(D);
  const or5 = bars.find(b => b.time === '09:30');
  assert.equal(result(byKey('orb_5'), stock('10:02'), data, or5.high + 1).value, 'above');
  assert.equal(result(byKey('orb_5'), stock('10:02'), data, or5.low - 1).value, 'below');
  assert.equal(result(byKey('orb_30'), stock('09:47'), data).note, 'entered before the first 30 minutes were over');
  const pos = result(byKey('day_range_position'), call('10:02'), data).value;
  assert.ok(pos >= 0 && pos <= 100);
  const sectors = result(byKey('sectors_above_ema8'), stock('10:02'), data);
  assert.ok(Number.isInteger(sectors.value) && sectors.value >= 0 && sectors.value <= 11, 'a count of the 11');
  assert.deepEqual(result(byKey('minutes_from_open'), stock('10:02'), data), { state: 'value', value: 32, note: '' });
  assert.equal(result(byKey('minutes_from_open'), stock('08:10'), data).value, -80);
  assert.equal(result(byKey('session_at_entry'), stock('17:05'), data).value, 'afterhours');
  assert.equal(result(byKey('rs_20d_vs_spy'), stock('10:02'), data).value, 0, 'both rise at the same pace in the fixture');
  // an inside day the day before
  const inside = world();
  const dd = inside.daily.get('AAPL'), i = dd.findIndex(b => b.date === D);
  Object.assign(dd[i - 1], { high: dd[i - 2].high - 0.01, low: dd[i - 2].low + 0.01 });
  assert.equal(result(byKey('prior_day_pattern'), stock('10:02'), inside).value, 'inside', 'inside the day before, not the narrowest of 7');
  Object.assign(dd[i - 1], { high: dd[i - 2].high - 0.5, low: dd[i - 2].high - 0.6 });
  assert.equal(result(byKey('prior_day_pattern'), stock('10:02'), inside).value, 'inside_nr7', 'and the narrowest of 7 too');
});
