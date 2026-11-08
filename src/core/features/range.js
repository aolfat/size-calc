// @ts-check
// Range features: how much the stock moves in a day, the yardsticks the distances are measured in, each in dollars and
// as a % of the close before (an option's underlying, never the contract). ATR counts gaps; ADR is the day's own range.
import { ADR_N, ATR_N, DAILY_SESSIONS, priceNow } from './averages.js';
import { family, feature } from './define.js';

export const RANGE_FAMILY = family({ key: 'range', name: 'Daily range', version: 1 });

const KINDS = {
  atr: { name: `ATR (${ATR_N} days)`, n: ATR_N, sessions: DAILY_SESSIONS, what: `the ${ATR_N}-day average true range (Wilder's, gaps included)` },
  adr: { name: `ADR (${ADR_N} days)`, n: ADR_N, sessions: ADR_N, what: `the ${ADR_N}-day average daily range (high − low)` },
};

/**
 * The ATR or ADR over the sessions before the entry's day, in dollars (the day's own prices, so a split since doesn't
 * shrink it) or as a % of the close before.
 * @param {'atr' | 'adr'} kind @param {'usd' | 'pct'} as
 */
const yardstick = (kind, as) => {
  const k = KINDS[kind], short = (/** @type {{ missing: boolean }} */ d) => d.missing ? null : { value: null, note: `fewer than ${kind === 'atr' ? k.n + 1 : k.n} daily sessions before` };
  return feature(RANGE_FAMILY, {
    key: `${kind}_${k.n}_${as}`,
    name: `${k.name}, ${as === 'usd' ? 'in dollars' : 'as a %'}`,
    desc: as === 'usd'
      ? `The stock's ${k.what} over the sessions before your entry's day, in dollars. An option uses its underlying.`
      : `The stock's ${k.what} over the sessions before your entry's day, as a % of the close before. How much it moves in a day. An option uses its underlying.`,
    version: 1, at: 'entry', unit: as === 'usd' ? '$' : '%', bins: as === 'usd' ? [1, 2, 5, 10] : [2, 3, 5, 8],
    needs: as === 'usd'
      ? { intraday: ['$underlying'], daily: ['$underlying'], dailySessions: k.sessions, session: 'all' }
      : { daily: ['$underlying'], dailySessions: k.sessions },
    compute: ctx => {
      const d = ctx.daily('$underlying', k.sessions);
      if (!d) return null;
      const v = kind === 'atr' ? d.atr(k.n) : d.adr(k.n);
      if (!v) return short(d);
      if (as === 'pct') return d.prevClose ? v / d.prevClose * 100 : short(d);
      const p = priceNow(ctx);
      if (!p || !('price' in p)) return p;
      return v / p.basis;
    },
  });
};

export const RANGE_FEATURES = [yardstick('adr', 'usd'), yardstick('adr', 'pct'), yardstick('atr', 'usd'), yardstick('atr', 'pct')];
