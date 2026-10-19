// @ts-check
// Level features: where the stock was against its own levels when you got in (an option's underlying, never the
// contract's own price).
import { family, feature } from './define.js';

export const LEVELS_FAMILY = family({ key: 'levels', name: 'Levels', version: 1 });

/** the stock's price at the moment: your fill for a stock, the underlying's last price for an option or spread */
const stockPrice = (/** @type {import('./context.js').FeatureContext} */ ctx, /** @type {{ price: number | null } | null} */ s) => ctx.entryPrice ?? s?.price ?? null;
const md = (/** @type {string} */ d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}/${d.slice(2, 4)}`;

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
];
