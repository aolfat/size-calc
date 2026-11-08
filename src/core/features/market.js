// @ts-check
// Market features: where the market stood when you took the trade. One generator per kind, so SPY / QQQ / IWM over their
// daily EMAs are one line each. The VIX reading at the entry, and its move on the day.
import { ATR_N, DAILY_SESSIONS } from './averages.js';
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

/**
 * The same, in the index's own daily ATRs: (price − EMA) ÷ its 14-day ATR (Wilder's, the sessions before that day).
 * @param {string} symbol @param {number} n
 */
const atrsFromDailyEma = (symbol, n) => feature(MARKET_FAMILY, {
  key: `${symbol.toLowerCase()}_atr_from_daily_ema${n}`,
  name: `${symbol} ATRs from the daily ${n} EMA`,
  desc: `${symbol}'s price at your entry against its daily ${n} EMA, in its own daily ATRs: (price − EMA) ÷ the 14-day ATR (Wilder's). Above 0 = over it.`,
  version: 1, at: 'entry', unit: 'atr', bins: [-1, 0, 1, 2],
  needs: { intraday: [symbol], daily: [symbol], dailySessions: DAILY_SESSIONS, session: 'all' },
  compute: ctx => {
    const d = ctx.daily(symbol, EMA_SESSIONS), a = ctx.daily(symbol, DAILY_SESSIONS), s = ctx.intraday(symbol, { session: 'all' });
    if (!d || !a || !s) return null;
    const atr = a.atr(ATR_N);
    if (s.price !== null) {
      const basis = ctx.dailyBasis(symbol, s.price);
      if (basis === null) return { value: null, note: "the daily history doesn't line up with the day's prices" };
      const price = s.price * basis, e = d.emaWith(n, price);
      return e && atr ? { value: (price - e) / atr, note: `ATR ${atr.toFixed(2)}` } : null;
    }
    const e = d.ema(n);
    return e && atr && d.prevClose ? { value: (d.prevClose - e) / atr, note: `prior close · ATR ${atr.toFixed(2)}` } : null;
  },
});

/** the CBOE volatility index, as Tradier names it */
const VIX = 'VIX';

/**
 * VIX at the moment: the last 5-minute value (extended hours too, where the provider has them). Without that day's bars,
 * or before any that day: the day's open once it's 9:30, else the close before, said in the note (`from`).
 * @param {import('./context.js').FeatureContext} ctx
 * @returns {{ value: number, prev: number | null, from: string } | null}
 */
function vixNow(ctx) {
  const d = ctx.daily(VIX, 5), s = ctx.intraday(VIX, { session: 'all' });
  if (!d || !s) return null;
  if (s.price !== null) return { value: s.price, prev: d.prevClose, from: '' };
  if (d.todayOpen) return { value: d.todayOpen, prev: d.prevClose, from: 'the open' };
  return d.prevClose ? { value: d.prevClose, prev: null, from: 'prior close' } : null;
}

const VIX_NEEDS = { intraday: [VIX], daily: [VIX], dailySessions: 5, session: /** @type {'all'} */ ('all') };

export const MARKET_FEATURES = [
  vsDailyEma('SPY', 8), vsDailyEma('QQQ', 8), atrsFromDailyEma('SPY', 8), atrsFromDailyEma('QQQ', 8),
  feature(MARKET_FAMILY, {
    key: 'vix_at_entry',
    name: 'VIX at entry',
    desc: "The VIX at your entry: its last 5-minute value. Without that day's VIX bars, the day's open (from 9:30) or the close before.",
    version: 1, at: 'entry', unit: '', bins: [15, 20, 25, 30],
    needs: VIX_NEEDS,
    compute: ctx => {
      const v = vixNow(ctx);
      return v && { value: Math.round(v.value * 100) / 100, note: v.from };
    },
  }),
  feature(MARKET_FAMILY, {
    key: 'vix_change_at_entry',
    name: 'VIX change at entry',
    desc: "The VIX at your entry against its close the day before, as a %. Above 0 = fear rising that day.",
    version: 1, at: 'entry', unit: '%', bins: [-5, 0, 5],
    needs: VIX_NEEDS,
    compute: ctx => {
      const v = vixNow(ctx);
      if (!v) return null;
      if (v.prev === null) return { value: null, note: v.from === 'prior close' ? 'entered before any VIX that day' : 'no VIX close the day before' };
      return { value: (v.value / v.prev - 1) * 100, note: v.from };
    },
  }),
];
