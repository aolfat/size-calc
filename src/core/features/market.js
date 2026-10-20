// @ts-check
// Market features: where the market stood when you took the trade. One generator per kind, so SPY / QQQ / IWM over their
// daily averages are one line each.
import { MARKET_BASKET } from '../bars.js';
import { family, feature } from './define.js';
import { dailyTermsPrice } from './prices.js';

export const MARKET_FAMILY = family({ key: 'market', name: 'Market', version: 1 });

/** sessions of daily history an EMA is worked out over: enough for a 21 EMA to settle, the same window every time */
const EMA_SESSIONS = 60;
/** the 11 sector SPDRs, from the market basket the bar saver keeps every day */
const SECTORS = MARKET_BASKET.filter(s => s.startsWith('XL'));

/**
 * An index's price at the moment against its daily EMA (or SMA) moved on by that price (so it never sees the day's
 * close), as a %. Without its 5-minute bars that day: the close the day before against the average the day before,
 * noted 'prior close'.
 * @param {import('./context.js').FeatureContext} ctx @param {string} symbol @param {'ema' | 'sma'} kind @param {number} n
 */
function vsAverage(ctx, symbol, kind, n) {
  const sessions = kind === 'ema' ? EMA_SESSIONS : n;
  const d = ctx.daily(symbol, sessions), s = ctx.intraday(symbol, { session: 'all' });
  if (!d || !s) return null;
  if (s.price !== null) {
    const basis = ctx.dailyBasis(symbol, s.price);
    if (basis === null) return { value: null, note: "the daily history doesn't line up with the day's prices" };
    const price = s.price * basis, avg = kind === 'ema' ? d.emaWith(n, price) : d.smaWith(n, price);
    return avg ? (price / avg - 1) * 100 : null;
  }
  const avg = kind === 'ema' ? d.ema(n) : d.sma(n);
  return avg && d.prevClose ? { value: (d.prevClose / avg - 1) * 100, note: 'prior close' } : null;
}

/** @param {string} symbol @param {'ema' | 'sma'} kind @param {number} n */
const vsDaily = (symbol, kind, n) => feature(MARKET_FAMILY, {
  key: `${symbol.toLowerCase()}_vs_daily_${kind}${n}`,
  name: `${symbol} vs daily ${n} ${kind.toUpperCase()}`,
  desc: `${symbol}'s price at your entry against its daily ${n} ${kind.toUpperCase()}, as a %. Above 0 = over it.`,
  version: 1, at: 'entry', unit: '%', bins: [0],
  needs: { intraday: [symbol], daily: [symbol], dailySessions: kind === 'ema' ? EMA_SESSIONS : n, session: 'all' },
  compute: ctx => vsAverage(ctx, symbol, kind, n),
});

/** @param {string} symbol */
const dayChange = symbol => feature(MARKET_FAMILY, {
  key: `${symbol.toLowerCase()}_day_change`,
  name: `${symbol} on the day`,
  desc: `${symbol}'s price at your entry against its close the day before, as a %. Extended hours count.`,
  version: 1, at: 'entry', unit: '%', bins: [-1, 0, 1],
  needs: { intraday: [symbol], daily: [symbol], dailySessions: 5, session: 'all' },
  compute: ctx => {
    const d = ctx.daily(symbol, 5), p = dailyTermsPrice(ctx, symbol);
    if (!p || !d) return null;
    return d.prevClose ? (p.price / d.prevClose - 1) * 100 : null;
  },
});

/** @param {string} symbol */
const vsVwap = symbol => feature(MARKET_FAMILY, {
  key: `${symbol.toLowerCase()}_vs_vwap`,
  name: `${symbol} vs VWAP`,
  desc: `${symbol}'s price at your entry against its session VWAP, as a %. Above 0 = over it.`,
  version: 1, at: 'entry', unit: '%', bins: [0],
  needs: { intraday: [symbol], session: 'regular' },
  compute: ctx => {
    if (ctx.clock < '09:35') return { value: null, note: ctx.clock < '09:30' ? 'entered before the open' : 'no VWAP yet in the first 5 minutes' };
    const s = ctx.intraday(symbol);
    const vwap = s?.vwap();
    return vwap && s?.price ? (s.price / vwap - 1) * 100 : null;
  },
});

/** how many of the 11 sector SPDRs were over their daily EMA at the moment @param {number} n */
const sectorsAbove = n => feature(MARKET_FAMILY, {
  key: `sectors_above_ema${n}`,
  name: `Sectors over their daily ${n} EMA`,
  desc: `How many of the 11 sector SPDRs (XLK, XLF, ...) were over their daily ${n} EMA at your entry, 0 to 11. A quick read of how broad the market's move was.`,
  version: 1, at: 'entry', unit: '', bins: [3, 6, 9],
  needs: { intraday: SECTORS, daily: SECTORS, dailySessions: EMA_SESSIONS, session: 'all' },
  compute: ctx => {
    let above = 0, counted = 0, prior = 0;
    for (const sym of SECTORS) {
      const r = vsAverage(ctx, sym, 'ema', n);
      const v = r && typeof r === 'object' ? r.value : r;
      if (typeof v !== 'number') continue;
      counted++;
      if (v > 0) above++;
      if (r && typeof r === 'object' && r.note === 'prior close') prior++;
    }
    if (counted < SECTORS.length) return { value: null, note: `${counted} of ${SECTORS.length} sectors known` };
    return prior ? { value: above, note: `${prior} at the prior close` } : above;
  },
});

export const MARKET_FEATURES = [
  vsDaily('SPY', 'ema', 8), vsDaily('QQQ', 'ema', 8), vsDaily('IWM', 'ema', 8),
  vsDaily('SPY', 'ema', 21), vsDaily('QQQ', 'ema', 21), vsDaily('IWM', 'ema', 21),
  vsDaily('SPY', 'sma', 50), vsDaily('QQQ', 'sma', 50), vsDaily('IWM', 'sma', 50),
  vsDaily('SPY', 'sma', 200), vsDaily('QQQ', 'sma', 200), vsDaily('IWM', 'sma', 200),
  dayChange('SPY'), dayChange('QQQ'), dayChange('IWM'),
  vsVwap('SPY'), vsVwap('QQQ'),
  sectorsAbove(8), sectorsAbove(21),
];
