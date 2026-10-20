// @ts-check
// Level features: where the stock was against its own levels when you got in (an option's underlying, never the
// contract's own price).
import { family, feature } from './define.js';
import { clockMinutes, dailyTermsPrice } from './prices.js';

export const LEVELS_FAMILY = family({ key: 'levels', name: 'Levels', version: 1 });

/** the stock's price at the moment: your fill for a stock, the underlying's last price for an option or spread */
const stockPrice = (/** @type {import('./context.js').FeatureContext} */ ctx, /** @type {{ price: number | null } | null} */ s) => ctx.entryPrice ?? s?.price ?? null;
const md = (/** @type {string} */ d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}/${d.slice(2, 4)}`;

/** the opening range's minutes: 5, 15, 30 */
const ORB = [5, 15, 30];
const SIDE_WORDS = /** @type {[string, string][]} */ ([['above', 'Above'], ['inside', 'Inside'], ['below', 'Below']]);

/**
 * Your entry against the high and low of the first `n` minutes, as a word. Known once those minutes are over.
 * @param {number} n
 */
const openingRange = n => feature(LEVELS_FAMILY, {
  key: `orb_${n}`,
  name: `Entry vs the ${n}-minute opening range`,
  desc: `Your entry against the high and low of the first ${n} minutes (9:30 to ${n === 5 ? '9:35' : n === 15 ? '9:45' : '10:00'}): above it (a breakout), inside it, or below it. An option uses its underlying.`,
  version: 1, at: 'entry', unit: '', values: SIDE_WORDS,
  needs: { intraday: ['$underlying'], session: 'regular' },
  compute: ctx => {
    if (clockMinutes(ctx.clock) < 570 + n) return { value: null, note: `entered before the first ${n} minutes were over` };
    const s = ctx.intraday('$underlying');
    if (!s) return null;
    const range = s.bars.filter(b => clockMinutes(b.time || '00:00') < 570 + n);
    const price = stockPrice(ctx, s);
    if (!range.length || !price) return null;
    const hi = Math.max(...range.map(b => b.high)), lo = Math.min(...range.map(b => b.low));
    return price > hi ? 'above' : price < lo ? 'below' : 'inside';
  },
});

/**
 * 5-minute EMA of the regular-hours closes: the two sessions before, then the day's ended bars (enough for a 21 EMA to
 * settle at the open), seeded with the first `n` closes' average.
 * @param {number[]} closes @param {number} n
 */
function emaOf(closes, n) {
  if (closes.length < n) return null;
  const k = 2 / (n + 1);
  let e = closes.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (const c of closes.slice(n)) e = c * k + e * (1 - k);
  return e;
}

/** @param {number} n */
const vsFiveMinEma = n => feature(LEVELS_FAMILY, {
  key: `entry_vs_5m_ema${n}`,
  name: `Entry vs the 5-minute ${n} EMA`,
  desc: `Your entry against the ${n} EMA of the 5-minute bars (regular hours, carried over from the two sessions before), as a %. How stretched the entry was intraday. An option uses its underlying.`,
  version: 1, at: 'entry', unit: '%', bins: [-1, 0, 1, 2],
  needs: { intraday: ['$underlying'], lookback: 2, session: 'regular' },
  compute: ctx => {
    const s = ctx.intraday('$underlying');
    if (!s) return null;
    const prior = s.priorSessions(2);
    if (s.missing) return null;
    const e = emaOf([...prior.flatMap(p => p.bars.map(b => b.close)), ...s.bars.map(b => b.close)], n);
    const price = stockPrice(ctx, s);
    return e && price ? (price / e - 1) * 100 : { value: null, note: 'too few 5-minute bars before' };
  },
});

export const LEVEL_FEATURES = [
  feature(LEVELS_FAMILY, {
    key: 'entry_vs_vwap',
    name: 'Entry vs VWAP',
    desc: "Your entry against the stock's session VWAP at that moment (the regular session's, after the close), as a %. Above 0 = over it. An option uses its underlying.",
    version: 1, at: 'entry', unit: '%', bins: [0],
    needs: { intraday: ['$underlying'], session: 'regular' },
    compute: ctx => {
      const s = ctx.intraday('$underlying');
      if (!s) return null;
      if (ctx.clock < '09:35') return { value: null, note: ctx.clock < '09:30' ? 'entered before the open' : 'no VWAP yet in the first 5 minutes' };
      const vwap = s.vwap(), price = stockPrice(ctx, s);
      return vwap && price ? (price / vwap - 1) * 100 : null;
    },
  }),
  feature(LEVELS_FAMILY, {
    key: 'gap_at_open',
    name: 'Gap at the open',
    desc: "The stock's open that day against the close the day before, as a %. Known from 9:30, so an entry before the open has none.",
    version: 1, at: 'entry', unit: '%', bins: [-2, 0, 2],
    needs: { daily: ['$underlying'], dailySessions: 5 },
    compute: ctx => {
      const d = ctx.daily('$underlying', 5);
      if (!d) return null;
      if (ctx.clock < '09:30') return { value: null, note: 'entered before the open' };
      return d.todayOpen && d.prevClose ? (d.todayOpen / d.prevClose - 1) * 100 : null;
    },
  }),
  feature(LEVELS_FAMILY, {
    key: 'dist_from_ath',
    name: 'Distance from the all-time high',
    desc: "Your entry against the highest high before it (every day before, and that day's high before your entry), as a %. 0 = at the high, below 0 = under it.",
    version: 1, at: 'entry', unit: '%', bins: [-30, -10, -3],
    needs: { intraday: ['$underlying'], daily: ['$underlying'] },
    compute: ctx => {
      const d = ctx.daily('$underlying'), s = ctx.intraday('$underlying');
      if (!d || !s) return null;
      const price = stockPrice(ctx, s), top = d.maxHigh();
      if (!price || !top) return null;
      const basis = ctx.dailyBasis('$underlying', price);
      if (basis === null) return { value: null, note: "the daily history doesn't line up with your entry (a split?)" };
      const today = s.high === null ? -Infinity : s.high * basis;
      const high = Math.max(top.high, today);
      return { value: (price * basis / high - 1) * 100, note: `high ${high.toFixed(2)} ${today >= top.high ? 'that day' : `on ${md(top.date)}`} · history from ${String(d.first).slice(0, 4)}` };
    },
  }),
  feature(LEVELS_FAMILY, {
    key: 'vs_prior_day_range',
    name: "Entry vs the prior day's range",
    desc: "Your entry against the day before's high and low: above its high, inside its range, or below its low. An option uses its underlying.",
    version: 1, at: 'entry', unit: '', values: SIDE_WORDS,
    needs: { intraday: ['$underlying'], daily: ['$underlying'], dailySessions: 5, session: 'all' },
    compute: ctx => {
      const d = ctx.daily('$underlying', 5), p = dailyTermsPrice(ctx);
      if (!p || !d) return null;
      const prev = d.bars[d.bars.length - 1];
      if (!prev) return null;
      return p.price > prev.high ? 'above' : p.price < prev.low ? 'below' : 'inside';
    },
  }),
  ...ORB.map(openingRange),
  feature(LEVELS_FAMILY, {
    key: 'day_range_position',
    name: "Where in the day's range",
    desc: "Your entry within the day's range so far (regular hours): 0 = at the low of day, 100 = at the high. An option uses its underlying.",
    version: 1, at: 'entry', unit: '', bins: [20, 50, 80],
    needs: { intraday: ['$underlying'], session: 'regular' },
    compute: ctx => {
      if (ctx.clock < '09:35') return { value: null, note: ctx.clock < '09:30' ? 'entered before the open' : 'no range yet in the first 5 minutes' };
      const s = ctx.intraday('$underlying');
      if (!s || s.high === null || s.low === null) return null;
      const price = stockPrice(ctx, s);
      if (!price || s.high <= s.low) return null;
      return Math.min(100, Math.max(0, (price - s.low) / (s.high - s.low) * 100));
    },
  }),
  feature(LEVELS_FAMILY, {
    key: 'adr_used',
    name: 'ADR used at entry',
    desc: "The day's range so far (regular hours, high to low) as a % of the stock's average daily range over the 20 sessions before. Over 100 = it already moved more than a usual day.",
    version: 1, at: 'entry', unit: '', bins: [50, 80, 100, 150],
    needs: { intraday: ['$underlying'], daily: ['$underlying'], dailySessions: 20, session: 'regular' },
    compute: ctx => {
      if (ctx.clock < '09:35') return { value: null, note: ctx.clock < '09:30' ? 'entered before the open' : 'no range yet in the first 5 minutes' };
      const s = ctx.intraday('$underlying'), d = ctx.daily('$underlying', 20);
      if (!s || !d || s.high === null || s.low === null || s.price === null) return null;
      const basis = ctx.dailyBasis('$underlying', s.price), adr = d.adr(20);
      if (basis === null) return { value: null, note: "the daily history doesn't line up with the day's prices (a split?)" };
      return adr ? (s.high - s.low) * basis / adr * 100 : null;
    },
  }),
  ...[8, 21].map(vsFiveMinEma),
  feature(LEVELS_FAMILY, {
    key: 'gap_filled',
    name: 'Gap filled by entry',
    desc: "Whether the day's gap (the open against the close before, at least 0.25%) had been filled by your entry: the low reached the close before after a gap up, or the high after a gap down.",
    version: 1, at: 'entry', unit: '', values: [['filled', 'Filled'], ['open', 'Not filled'], ['none', 'No gap']],
    needs: { intraday: ['$underlying'], daily: ['$underlying'], dailySessions: 5, session: 'regular' },
    compute: ctx => {
      if (ctx.clock < '09:30') return { value: null, note: 'entered before the open' };
      const d = ctx.daily('$underlying', 5), s = ctx.intraday('$underlying');
      if (!d || !s || !d.todayOpen || !d.prevClose || s.high === null || s.low === null || s.price === null) return null;
      const gap = d.todayOpen / d.prevClose - 1;
      if (Math.abs(gap) < 0.0025) return 'none';
      const basis = ctx.dailyBasis('$underlying', s.price);
      if (basis === null) return { value: null, note: "the daily history doesn't line up with the day's prices (a split?)" };
      return gap > 0 ? (s.low * basis <= d.prevClose ? 'filled' : 'open') : (s.high * basis >= d.prevClose ? 'filled' : 'open');
    },
  }),
  feature(LEVELS_FAMILY, {
    key: 'entry_vs_open',
    name: "Entry vs the day's open",
    desc: "Your entry against the regular session's 9:30 open, as a %. An option uses its underlying.",
    version: 1, at: 'entry', unit: '%', bins: [-1, 0, 1],
    needs: { intraday: ['$underlying'], session: 'regular' },
    compute: ctx => {
      if (ctx.clock < '09:30') return { value: null, note: 'entered before the open' };
      const s = ctx.intraday('$underlying');
      if (!s || !s.open) return null;
      const price = stockPrice(ctx, s);
      return price ? (price / s.open - 1) * 100 : null;
    },
  }),
  feature(LEVELS_FAMILY, {
    key: 'exit_vs_vwap',
    name: 'Exit vs VWAP',
    desc: "The stock's price at your exit against its session VWAP, as a %. Above 0 = over it. An option uses its underlying.",
    version: 1, at: 'exit', unit: '%', bins: [0],
    needs: { intraday: ['$underlying'], session: 'regular' },
    compute: ctx => {
      if (ctx.clock < '09:35') return { value: null, note: ctx.clock < '09:30' ? 'exited before the open' : 'no VWAP yet in the first 5 minutes' };
      const s = ctx.intraday('$underlying'), vwap = s?.vwap();
      return vwap && s?.price ? (s.price / vwap - 1) * 100 : null;
    },
  }),
];
