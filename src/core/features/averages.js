// @ts-check
// Moving-average features: how far the stock was from each of its daily and weekly averages at your entry, in daily
// ATRs (an option's underlying, never the contract). One generator, so each average is one line.
import { family, feature } from './define.js';

export const AVERAGES_FAMILY = family({ key: 'averages', name: 'Moving averages', version: 1 });

/** daily sessions a daily average and the ATR are worked out over: room for a 200 SMA, and for a 50 EMA to settle */
export const DAILY_SESSIONS = 300;
/** daily sessions the weekly closes come from: about five years, so a weekly 50 EMA settles */
const WEEKLY_SESSIONS = 1300;
/** the ATR's length, in sessions */
export const ATR_N = 14;
/** the ADR's length, in sessions: what a distance inside the day is measured in */
export const ADR_N = 20;

/**
 * The stock's price at the moment, in the daily history's terms: your fill for a stock, the underlying's last price for
 * an option or spread (extended hours too), lined up with the history across a split.
 * @param {import('./context.js').FeatureContext} ctx
 * @returns {{ price: number, basis: number } | { value: null, note: string } | null}
 */
export function priceNow(ctx) {
  const raw = ctx.entryPrice ?? ctx.intraday('$underlying', { session: 'all' })?.price ?? null;
  if (!raw) return { value: null, note: 'no price for the stock at your entry' };
  const basis = ctx.dailyBasis('$underlying', raw);
  if (basis === null) return { value: null, note: "the daily history doesn't line up with your entry (a split?)" };
  return { price: raw * basis, basis };
}

/**
 * A yardstick in words, both ways: 'ATR $2.50 (2.10%)', the dollars in the day's own prices (the history's over `basis`),
 * the % of the close before. Without a close, the dollars alone.
 * @param {string} name @param {number} value in the daily history's terms @param {number} basis @param {number | null} prevClose
 */
export const yardstickWords = (name, value, basis, prevClose) => `${name} $${(value / basis).toFixed(2)}${prevClose ? ` (${(value / prevClose * 100).toFixed(2)}%)` : ''}`;

/**
 * The stock's distance from a daily or weekly EMA or SMA at the entry, in daily ATRs: (price − average) ÷ ATR(14). The
 * average takes the price at the entry as its latest close (the day's, or the week's), so it never sees a close to
 * come; the ATR is Wilder's over the sessions before the entry's day.
 * @param {'daily' | 'weekly'} frame @param {'ema' | 'sma'} kind @param {number} n
 */
const atrsFrom = (frame, kind, n) => {
  const words = `${frame} ${n} ${kind.toUpperCase()}`, sessions = frame === 'weekly' ? WEEKLY_SESSIONS : DAILY_SESSIONS;
  return feature(AVERAGES_FAMILY, {
    key: `atr_from_${frame}_${kind}${n}`,
    name: `ATRs from the ${words}`,
    desc: `How far the stock was from its ${words} at your entry, in daily ATRs: (price − ${n} ${kind.toUpperCase()}) ÷ the 14-day ATR (Wilder's, the sessions before that day). The ${kind.toUpperCase()} counts your entry price as the ${frame === 'weekly' ? "week's" : "day's"} close. +4 = four ATRs above it. An option uses its underlying.`,
    version: 1, at: 'entry', unit: 'atr', bins: [-2, 0, 2, 4],
    needs: { intraday: ['$underlying'], daily: ['$underlying'], dailySessions: sessions, session: 'all' },
    compute: ctx => {
      const d = ctx.daily('$underlying', sessions), a = frame === 'weekly' ? ctx.daily('$underlying', DAILY_SESSIONS) : d;
      if (!d || !a) return null;
      const p = priceNow(ctx);
      if (!p || !('price' in p)) return p;
      const avg = d.averageWith(kind, n, p.price, frame), atr = a.atr(ATR_N);
      const need = kind === 'sma' ? n - 1 : n;
      if (avg === null) return { value: null, note: `fewer than ${need} ${frame === 'weekly' ? 'weeks' : 'daily sessions'} before` };
      if (!atr) return { value: null, note: `fewer than ${ATR_N + 1} daily sessions before, for the ATR` };
      return { value: (p.price - avg) / atr, note: `${n} ${kind.toUpperCase()} ${(avg / p.basis).toFixed(2)} · ${yardstickWords('ATR', atr, p.basis, a.prevClose)}` };
    },
  });
};

export const AVERAGE_FEATURES = [
  atrsFrom('daily', 'ema', 8), atrsFrom('daily', 'ema', 9), atrsFrom('daily', 'sma', 10), atrsFrom('daily', 'sma', 20),
  atrsFrom('daily', 'ema', 21), atrsFrom('daily', 'sma', 50), atrsFrom('daily', 'ema', 50), atrsFrom('daily', 'sma', 100),
  atrsFrom('daily', 'sma', 200),
  atrsFrom('weekly', 'ema', 8), atrsFrom('weekly', 'ema', 9), atrsFrom('weekly', 'sma', 10), atrsFrom('weekly', 'ema', 21),
  atrsFrom('weekly', 'sma', 50), atrsFrom('weekly', 'ema', 50),
];
