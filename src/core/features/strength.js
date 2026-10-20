// @ts-check
// Relative strength features: the stock against SPY at your entry (an option's underlying): over the weeks before, and
// on the day itself.
import { family, feature } from './define.js';
import { dailyTermsPrice, monthDay } from './prices.js';

export const STRENGTH_FAMILY = family({ key: 'strength', name: 'Relative strength', version: 1 });

/**
 * The closes both histories have, matched by day, the last `n` of them.
 * @param {{ bars: { date: string, close: number }[] }} a @param {{ bars: { date: string, close: number }[] }} b @param {number} n
 */
function matched(a, b, n) {
  const spy = new Map(b.bars.map(x => [x.date, x.close]));
  return a.bars.filter(x => spy.has(x.date)).slice(-n).map(x => ({ date: x.date, stock: x.close, spy: /** @type {number} */ (spy.get(x.date)) }));
}

/** the stock's return over `n` sessions to the close before, less SPY's, in % points @param {number} n */
const returnVsSpy = n => feature(STRENGTH_FAMILY, {
  key: `rs_${n}d_vs_spy`,
  name: `${n}-day return vs SPY`,
  desc: `The stock's return over the ${n} sessions to the close before your entry, less SPY's over the same days, in % points. Above 0 = it outran the market.`,
  version: 1, at: 'entry', unit: '%', bins: [-10, 0, 10, 25],
  needs: { daily: ['$underlying', 'SPY'], dailySessions: n + 1 },
  compute: ctx => {
    const a = ctx.daily('$underlying', n + 1), b = ctx.daily('SPY', n + 1);
    if (!a || !b || a.missing || b.missing) return null;
    const m = matched(a, b, n + 1);
    if (m.length < n + 1) return { value: null, note: `fewer than ${n + 1} sessions both have` };
    const first = m[0], last = m[m.length - 1];
    return ((last.stock / first.stock) - (last.spy / first.spy)) * 100;
  },
});

export const STRENGTH_FEATURES = [
  returnVsSpy(20), returnVsSpy(63),
  feature(STRENGTH_FAMILY, {
    key: 'rs_line_50d_high',
    name: 'RS line at a 50-day high',
    desc: "Whether the stock's relative strength line (its close over SPY's) was at its highest of the 50 sessions before your entry, as of the close before. A leader's tell.",
    version: 1, at: 'entry', unit: '', values: [['yes', 'At a high'], ['no', 'Not at a high']],
    needs: { daily: ['$underlying', 'SPY'], dailySessions: 50 },
    compute: ctx => {
      const a = ctx.daily('$underlying', 50), b = ctx.daily('SPY', 50);
      if (!a || !b || a.missing || b.missing) return null;
      const m = matched(a, b, 50);
      if (m.length < 50) return { value: null, note: 'fewer than 50 sessions both have' };
      const ratios = m.map(x => x.stock / x.spy), last = ratios[ratios.length - 1];
      return last >= Math.max(...ratios) ? 'yes' : { value: 'no', note: `${((last / Math.max(...ratios) - 1) * 100).toFixed(1)}% off its high on ${monthDay(m[ratios.indexOf(Math.max(...ratios))].date)}` };
    },
  }),
  feature(STRENGTH_FAMILY, {
    key: 'day_vs_spy',
    name: 'Day so far vs SPY',
    desc: "The stock's move from the close before to your entry, less SPY's over the same time, in % points. Extended hours count. An option uses its underlying.",
    version: 1, at: 'entry', unit: '%', bins: [-2, 0, 2, 5],
    needs: { intraday: ['$underlying', 'SPY'], daily: ['$underlying', 'SPY'], dailySessions: 5, session: 'all' },
    compute: ctx => {
      const a = ctx.daily('$underlying', 5), b = ctx.daily('SPY', 5);
      const pa = dailyTermsPrice(ctx), pb = dailyTermsPrice(ctx, 'SPY');
      if (!a || !b || !pa || !pb) return null;
      return a.prevClose && b.prevClose ? (pa.price / a.prevClose - pb.price / b.prevClose) * 100 : null;
    },
  }),
];
