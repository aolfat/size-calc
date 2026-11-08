// @ts-check
// Level features: where the stock was against its own levels when you got in (an option's underlying, never the
// contract's own price). A distance inside the day (VWAP, the low and high of day) is also given in ADRs, one that
// reaches across days (the gap, the all-time high) in ATRs, beside the %.
import { ADR_N, ATR_N, DAILY_SESSIONS } from './averages.js';
import { family, feature } from './define.js';

export const LEVELS_FAMILY = family({ key: 'levels', name: 'Levels', version: 1 });

/** the stock's price at the moment: your fill for a stock, the underlying's last price for an option or spread */
const stockPrice = (/** @type {import('./context.js').FeatureContext} */ ctx, /** @type {{ price: number | null } | null} */ s) => ctx.entryPrice ?? s?.price ?? null;
const noPrice = { value: null, note: 'no price for the stock at your entry' };
const offHistory = { value: null, note: "the daily history doesn't line up with your entry (a split?)" };
const fewer = (/** @type {number} */ n, /** @type {string} */ what) => ({ value: null, note: `fewer than ${n} daily sessions before, for the ${what}` });
const md = (/** @type {string} */ d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}/${d.slice(2, 4)}`;

/**
 * Your entry's distance from the low or the high of the day so far, in ADRs: the dollars between them over the 20-day
 * average daily range. The day is the regular session from 9:30 (after-hours bars too, for an entry after the close),
 * the premarket from 4:00 before then; your fill counts, since it traded.
 * @param {'low' | 'high'} side
 */
const fromDayRange = side => feature(LEVELS_FAMILY, {
  key: side === 'low' ? 'adr_from_lod' : 'adr_from_hod',
  name: side === 'low' ? 'ADRs above the low of day' : 'ADRs below the high of day',
  desc: side === 'low'
    ? "How far your entry was above the day's low so far, in ADRs: (entry − low) ÷ the 20-day average daily range (high − low). 0 = at the low. The low is from 9:30, or the premarket's before the open. An option uses its underlying."
    : "How far your entry was below the day's high so far, in ADRs: (high − entry) ÷ the 20-day average daily range (high − low). 0 = at the high. The high is from 9:30, or the premarket's before the open. An option uses its underlying.",
  version: 1, at: 'entry', unit: 'adr', bins: [0.25, 0.5, 1],
  needs: { intraday: ['$underlying'], daily: ['$underlying'], dailySessions: ADR_N, session: 'all' },
  compute: ctx => {
    const s = ctx.intraday('$underlying', { session: 'all' }), d = ctx.daily('$underlying', ADR_N);
    if (!s || !d || s.missing) return null;
    const price = stockPrice(ctx, s);
    if (!price) return noPrice;
    const r = s.rangeSince(ctx.clock >= '09:30' ? '09:30' : '04:00');
    const low = Math.min(r?.low ?? price, price), high = Math.max(r?.high ?? price, price);
    const basis = ctx.dailyBasis('$underlying', price), adr = d.adr(ADR_N);
    if (basis === null) return offHistory;
    if (!adr) return fewer(ADR_N, 'ADR');
    const dayAdr = adr / basis, level = side === 'low' ? low : high;
    return { value: Math.abs(price - level) / dayAdr, note: `${side} ${level.toFixed(2)} · ADR ${dayAdr.toFixed(2)}` };
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
    key: 'adr_from_vwap',
    name: 'ADRs from VWAP',
    desc: "Your entry against the stock's session VWAP at that moment, in ADRs: (entry − VWAP) ÷ the 20-day average daily range (high − low). Above 0 = over it. An option uses its underlying.",
    version: 1, at: 'entry', unit: 'adr', bins: [-0.5, 0, 0.5, 1],
    needs: { intraday: ['$underlying'], daily: ['$underlying'], dailySessions: ADR_N, session: 'regular' },
    compute: ctx => {
      const s = ctx.intraday('$underlying'), d = ctx.daily('$underlying', ADR_N);
      if (!s || !d) return null;
      if (ctx.clock < '09:35') return { value: null, note: ctx.clock < '09:30' ? 'entered before the open' : 'no VWAP yet in the first 5 minutes' };
      const vwap = s.vwap(), price = stockPrice(ctx, s);
      if (!vwap || !price) return null;
      const basis = ctx.dailyBasis('$underlying', price), adr = d.adr(ADR_N);
      if (basis === null) return offHistory;
      if (!adr) return fewer(ADR_N, 'ADR');
      return { value: (price - vwap) * basis / adr, note: `VWAP ${vwap.toFixed(2)} · ADR ${(adr / basis).toFixed(2)}` };
    },
  }),
  fromDayRange('low'), fromDayRange('high'),
  feature(LEVELS_FAMILY, {
    key: 'gap_atr',
    name: 'Gap at the open, in ATRs',
    desc: "The stock's open that day against the close the day before, in daily ATRs: (open − prior close) ÷ the 14-day ATR (Wilder's). Known from 9:30, so an entry before the open has none.",
    version: 1, at: 'entry', unit: 'atr', bins: [-1, 0, 1],
    needs: { daily: ['$underlying'], dailySessions: DAILY_SESSIONS },
    compute: ctx => {
      const d = ctx.daily('$underlying', DAILY_SESSIONS);
      if (!d) return null;
      if (ctx.clock < '09:30') return { value: null, note: 'entered before the open' };
      const atr = d.atr(ATR_N);
      if (!d.todayOpen || !d.prevClose) return null;
      if (!atr) return fewer(ATR_N + 1, 'ATR');
      return { value: (d.todayOpen - d.prevClose) / atr, note: `ATR ${atr.toFixed(2)}` };
    },
  }),
  feature(LEVELS_FAMILY, {
    key: 'atr_from_ath',
    name: 'ATRs from the all-time high',
    desc: "Your entry against the highest high before it (every day before, and that day's high before your entry), in daily ATRs: (entry − high) ÷ the 14-day ATR (Wilder's). 0 = at the high, below 0 = under it.",
    version: 1, at: 'entry', unit: 'atr', bins: [-10, -3, -1],
    needs: { intraday: ['$underlying'], daily: ['$underlying'] },
    compute: ctx => {
      const d = ctx.daily('$underlying'), a = ctx.daily('$underlying', DAILY_SESSIONS), s = ctx.intraday('$underlying');
      if (!d || !a || !s) return null;
      const price = stockPrice(ctx, s), top = d.maxHigh();
      if (!price || !top) return null;
      const basis = ctx.dailyBasis('$underlying', price);
      if (basis === null) return offHistory;
      const atr = a.atr(ATR_N);
      if (!atr) return fewer(ATR_N + 1, 'ATR');
      const today = s.high === null ? -Infinity : s.high * basis;
      const high = Math.max(top.high, today);
      return { value: (price * basis - high) / atr, note: `high ${high.toFixed(2)} ${today >= top.high ? 'that day' : `on ${md(top.date)}`} · ATR ${atr.toFixed(2)}` };
    },
  }),
];
