// @ts-check
// Breadth features: how much of the market was in an uptrend, as the % of US common stocks over their 5 / 20 / 50 / 100
// / 200-day averages at the close before your entry. The app's own count from every stock's daily close (core/breadth.js,
// filled in from Massive), on Barchart's lines: $MMFD, $MMTW, $MMFI, $MMOH, $MMTH. Close to Barchart's numbers, not the
// same: its universe and filters aren't published.
import { family, feature } from './define.js';
import { monthDay } from './prices.js';

export const BREADTH_FAMILY = family({ key: 'breadth', name: 'Market breadth', version: 1 });

/** @param {number} n @param {string} barchart */
const above = (n, barchart) => feature(BREADTH_FAMILY, {
  key: `breadth_sma${n}`,
  name: `Stocks over their ${n}-day average (${barchart})`,
  desc: `The % of US common stocks closing over their ${n}-day simple average, at the close before your entry. Like Barchart's ${barchart}, counted by the app from every stock's daily close.`,
  version: 1, at: 'entry', unit: '', bins: [20, 40, 60, 80],
  needs: { breadth: true },
  compute: ctx => {
    const b = ctx.breadth(n);
    return b ? { value: Math.round(b.pct * 10) / 10, note: `close of ${monthDay(b.day)}, ${b.counted.toLocaleString('en-US')} stocks` } : null;
  },
});

export const BREADTH_FEATURES = [above(5, '$MMFD'), above(20, '$MMTW'), above(50, '$MMFI'), above(100, '$MMOH'), above(200, '$MMTH')];
