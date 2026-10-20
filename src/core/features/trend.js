// @ts-check
// Trend features: the stock against its own daily averages and ranges at your entry (an option's underlying, never the
// contract): how extended it was, how volatile, how near its 52-week high, how tight its last days were.
import { family, feature } from './define.js';
import { dailyTermsPrice, monthDay } from './prices.js';

export const TREND_FAMILY = family({ key: 'trend', name: 'Trend', version: 1 });

const EMA_SESSIONS = 60;
const YEAR = 252;
/** too few daily sessions, said when the history was read but is short; null (wait or gone, from the read) when it wasn't */
const short = (/** @type {{ missing: boolean } | null} */ d, /** @type {number} */ n) => d && !d.missing ? { value: null, note: `fewer than ${n} daily sessions before` } : null;

/**
 * The stock against its daily EMA or SMA moved on by its price at the moment, as a %.
 * @param {'ema' | 'sma'} kind @param {number} n @param {'entry' | 'exit'} [at]
 */
const vsAverage = (kind, n, at = 'entry') => feature(TREND_FAMILY, {
  key: at === 'entry' ? `stock_vs_daily_${kind}${n}` : `exit_vs_daily_${kind}${n}`,
  name: at === 'entry' ? `Stock vs daily ${n} ${kind.toUpperCase()}` : `Exit vs daily ${n} ${kind.toUpperCase()}`,
  desc: `The stock's price at your ${at} (your fill, for a stock entry) against its daily ${n} ${kind.toUpperCase()} moved on by that price, as a %. Above 0 = over it. An option uses its underlying.`,
  version: 1, at, unit: '%', bins: [-5, 0, 5, 10],
  needs: { intraday: ['$underlying'], daily: ['$underlying'], dailySessions: kind === 'ema' ? EMA_SESSIONS : n, session: 'all' },
  compute: ctx => {
    const d = ctx.daily('$underlying', kind === 'ema' ? EMA_SESSIONS : n);
    const p = dailyTermsPrice(ctx);
    if (!p || !d) return null;
    const avg = kind === 'ema' ? d.emaWith(n, p.price) : d.smaWith(n, p.price);
    return avg ? (p.price / avg - 1) * 100 : short(d, n);
  },
});

export const TREND_FEATURES = [
  vsAverage('ema', 8), vsAverage('ema', 21), vsAverage('sma', 50), vsAverage('sma', 200),
  vsAverage('ema', 8, 'exit'),
  feature(TREND_FAMILY, {
    key: 'ext_ema21_adr',
    name: 'Extension from the 21 EMA, in ADRs',
    desc: "How far the stock was from its daily 21 EMA at your entry, in average daily ranges (20 days). 2 = two days' worth of range above it: extended.",
    version: 1, at: 'entry', unit: '', bins: [0, 1, 2, 3],
    needs: { intraday: ['$underlying'], daily: ['$underlying'], dailySessions: EMA_SESSIONS, session: 'all' },
    compute: ctx => {
      const d = ctx.daily('$underlying', EMA_SESSIONS), p = dailyTermsPrice(ctx);
      if (!p || !d) return null;
      const e = d.emaWith(21, p.price), adr = d.adr(20);
      return e && adr ? (p.price - e) / adr : short(d, 21);
    },
  }),
  feature(TREND_FAMILY, {
    key: 'adr_pct_20',
    name: 'ADR % (20 days)',
    desc: "The stock's average daily range over the 20 sessions before, as a % (high over low). How much it moves in a day.",
    version: 1, at: 'entry', unit: '', bins: [2, 4, 6, 10],
    needs: { daily: ['$underlying'], dailySessions: 20 },
    compute: ctx => { const d = ctx.daily('$underlying', 20); return d?.adrPct(20) ?? short(d, 20); },
  }),
  feature(TREND_FAMILY, {
    key: 'atr_pct_14',
    name: 'ATR % (14 days)',
    desc: "The stock's 14-day average true range (Wilder's, gaps included) over the close before, as a %.",
    version: 1, at: 'entry', unit: '', bins: [2, 4, 6, 10],
    needs: { daily: ['$underlying'], dailySessions: EMA_SESSIONS },
    compute: ctx => {
      const d = ctx.daily('$underlying', EMA_SESSIONS), atr = d?.atr(14);
      return atr && d?.prevClose ? atr / d.prevClose * 100 : short(d, 15);
    },
  }),
  feature(TREND_FAMILY, {
    key: 'dist_from_52w_high',
    name: 'Distance from the 52-week high',
    desc: "Your entry against the highest high of the 252 sessions before and that day's high before your entry, as a %. 0 = at the high.",
    version: 1, at: 'entry', unit: '%', bins: [-25, -10, -3],
    needs: { intraday: ['$underlying'], daily: ['$underlying'], dailySessions: YEAR, session: 'all' },
    compute: ctx => {
      const d = ctx.daily('$underlying', YEAR), s = ctx.intraday('$underlying'), p = dailyTermsPrice(ctx);
      if (!p || !d || !s) return null;
      const top = d.maxHigh();
      if (!top) return short(d, 1);
      const today = s.high === null ? -Infinity : s.high * p.basis, high = Math.max(top.high, today);
      return { value: (p.price / high - 1) * 100, note: today >= top.high ? 'high that day' : `high ${high.toFixed(2)} on ${monthDay(top.date)}` };
    },
  }),
  feature(TREND_FAMILY, {
    key: 'days_since_52w_high',
    name: 'Sessions since the 52-week high',
    desc: 'How many sessions before your entry day the stock made its 52-week high (0 = the day before). Small = near highs; large = a long way off them.',
    version: 1, at: 'entry', unit: '', bins: [5, 20, 60, 120],
    needs: { daily: ['$underlying'], dailySessions: YEAR },
    compute: ctx => {
      const d = ctx.daily('$underlying', YEAR);
      if (!d || !d.bars.length) return short(d, 1);
      const top = d.maxHigh();
      return top ? d.bars.length - 1 - d.bars.findIndex(b => b.date === top.date) : null;
    },
  }),
  feature(TREND_FAMILY, {
    key: 'range_10d_adr',
    name: 'Tightness: 10-day range in ADRs',
    desc: "The stock's high-to-low range over the 10 sessions before, in average daily ranges (20 days). Low = a tight base, high = a wide, loose one.",
    version: 1, at: 'entry', unit: '', bins: [2, 3, 5],
    needs: { daily: ['$underlying'], dailySessions: 20 },
    compute: ctx => {
      const d = ctx.daily('$underlying', 20), adr = d?.adr(20);
      if (!d || !adr) return short(d, 20);
      const last = d.bars.slice(-10);
      return (Math.max(...last.map(b => b.high)) - Math.min(...last.map(b => b.low))) / adr;
    },
  }),
  feature(TREND_FAMILY, {
    key: 'prior_day_pattern',
    name: "Prior day's range",
    desc: 'The day before your entry: an inside day (inside the range of the day before it), an NR7 (its narrowest range of 7 days), both, or neither.',
    version: 1, at: 'entry', unit: '', values: [['inside_nr7', 'Inside day and NR7'], ['inside', 'Inside day'], ['nr7', 'NR7'], ['none', 'Neither']],
    needs: { daily: ['$underlying'], dailySessions: 7 },
    compute: ctx => {
      const d = ctx.daily('$underlying', 7);
      if (!d || d.bars.length < 7) return short(d, 7);
      const [b0, b1] = d.bars.slice(-2), range = (/** @type {{ high: number, low: number }} */ b) => b.high - b.low;
      const inside = b1.high <= b0.high && b1.low >= b0.low;
      const nr7 = d.bars.slice(0, -1).every(b => range(b1) < range(b));
      return inside && nr7 ? 'inside_nr7' : inside ? 'inside' : nr7 ? 'nr7' : 'none';
    },
  }),
  feature(TREND_FAMILY, {
    key: 'prior_day_change',
    name: "Prior day's change",
    desc: "The day before your entry: its close against the close before it, as a %.",
    version: 1, at: 'entry', unit: '%', bins: [-3, 0, 3],
    needs: { daily: ['$underlying'], dailySessions: 2 },
    compute: ctx => {
      const d = ctx.daily('$underlying', 2);
      if (!d || d.bars.length < 2) return short(d, 2);
      return (d.bars[1].close / d.bars[0].close - 1) * 100;
    },
  }),
];
