// @ts-check
// Market features: where the market stood when you took the trade. One generator per kind, so SPY / QQQ / IWM over their
// daily EMAs are one line each.
import { family, feature } from './define.js';

export const MARKET_FAMILY = family({ key: 'market', name: 'Market', version: 1 });

/** sessions of daily history an EMA is worked out over: enough for a 21 EMA to settle, the same window every time */
const EMA_SESSIONS = 60;

/**
 * An index's price at the moment against its daily EMA moved on by that price (so it never sees the day's close), as a %.
 * Without its 5-minute bars that day: the close the day before against the EMA the day before, noted 'prior close'.
 * @param {string} symbol @param {number} n
 */
const vsDailyEma = (symbol, n) => feature(MARKET_FAMILY, {
  key: `${symbol.toLowerCase()}_vs_daily_ema${n}`,
  name: `${symbol} vs daily ${n} EMA`,
  desc: `${symbol}'s price at your entry against its daily ${n} EMA, as a %. Above 0 = over it.`,
  version: 1, at: 'entry', unit: '%', bins: [0],
  needs: { intraday: [symbol], daily: [symbol], dailySessions: EMA_SESSIONS, session: 'all' },
  compute: ctx => {
    const d = ctx.daily(symbol, EMA_SESSIONS), s = ctx.intraday(symbol, { session: 'all' });
    if (!d || !s) return null;
    if (s.price !== null) {
      const basis = ctx.dailyBasis(symbol, s.price);
      if (basis === null) return { value: null, note: "the daily history doesn't line up with the day's prices" };
      const price = s.price * basis, e = d.emaWith(n, price);
      return e ? (price / e - 1) * 100 : null;
    }
    const e = d.ema(n);
    return e && d.prevClose ? { value: (d.prevClose / e - 1) * 100, note: 'prior close' } : null;
  },
});

export const MARKET_FEATURES = [vsDailyEma('SPY', 8), vsDailyEma('QQQ', 8)];
