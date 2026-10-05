// @ts-check
// Option and spread math: labels, direction, width, Black-Scholes card value, defined-risk unit, expiry helpers.
import { RISK_FREE, bsPrice } from './black-scholes.js';

/** @typedef {{ K: number, iv?: number, side: number, occ?: string, mid?: number, delta?: number }} Leg */
/**
 * The card fields this math reads. Spread legs are always the debit-spread legs (near +1, far −1);
 * a credit spread is credit:true on top, and mid is the net either way.
 * @typedef {{ kind?: string, isCall: boolean, credit?: boolean, legs?: Leg[], parsed?: { strike: number }, iv?: number,
 *   mid?: number, lossPerContract?: number, sizing?: string, shortPut?: boolean }} Card
 */

/** @param {Card} d @returns {string} */
export function strikesLabel(d) {
  return d.kind === 'spread' ? `$${+d.legs[0].K}/$${+d.legs[1].K}` : `$${+d.parsed.strike}`;
}

/** @param {Card} d @returns {string} */
export function typeLabel(d) {
  if (d.sizing === 'allocation') return d.shortPut ? 'short put' : 'long ' + (d.isCall ? 'call' : 'put');
  return `${d.isCall ? 'call' : 'put'}${d.kind === 'spread' ? (d.credit ? ' credit spread' : ' debit spread') : ''}`;
}

// trade direction: long calls and put credit spreads win up, long puts and call credit spreads win down

/** @param {Card} d @returns {boolean} */
export function isBull(d) { return d.credit ? !d.isCall : d.isCall; }

/** @param {Card} d @returns {number} */
export function spreadWidth(d) { return d.legs ? Math.abs(d.legs[1].K - d.legs[0].K) : 0; }

// net Black-Scholes value of a card at underlying S with T years left (legs-aware)

/** @param {Card} d @param {number} S @param {number} T years @returns {number} */
export function cardValueAt(d, S, T) {
  const TT = Math.max(0, T);
  if (d.legs) return d.legs.reduce((a, L) => a + L.side * bsPrice(d.isCall, S, L.K, TT, L.iv || d.iv, RISK_FREE), 0);
  return bsPrice(d.isCall, S, d.parsed.strike, TT, d.iv, RISK_FREE);
}

/** @param {Card} d @returns {number} */
export function sizeUnit(d) { // $ risked per contract for sizing: defined risk for spreads (full debit, or width − credit), loss@stop for singles
  if (d.kind === 'spread') return (d.credit ? spreadWidth(d) - d.mid : d.mid) * 100;
  return d.lossPerContract;
}

/** @param {string} expStr YYYY-MM-DD @returns {boolean} */
export function isMonthlyExp(expStr) {
  // standard monthly = third Friday; if that Friday is a holiday the listed
  // expiry lands on the Thursday before, so accept that too
  const [y, m, d] = expStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow = date.getDay();
  // third Friday of this month
  const first = new Date(y, m - 1, 1);
  const firstFriOffset = (5 - first.getDay() + 7) % 7;
  const thirdFri = 1 + firstFriOffset + 14;
  if (dow === 5 && d === thirdFri) return true;
  if (dow === 4 && d === thirdFri - 1) return true; // holiday Thursday case
  return false;
}

/** @param {number} lossPct @returns {string} */
export function lossClass(lossPct) {
  if (lossPct < 25) return 'loss-low';
  if (lossPct < 60) return 'loss-mid';
  return 'loss-high';
}

/** Years until the 4pm close on expiry, less `daysLess` days, floored at zero. @param {string} expStr @param {number} [daysLess] @returns {number} */
export function yearsToExp(expStr, daysLess = 0) {
  if (!expStr) return 0;
  const ms = new Date(expStr + 'T16:00:00').getTime() - Date.now();
  return Math.max(0, ms / (365 * 24 * 3600 * 1000) - daysLess / 365);
}
