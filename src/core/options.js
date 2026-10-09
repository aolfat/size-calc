// @ts-check
// Option and spread math: labels, direction, width, Black-Scholes card value, defined-risk unit, expiry helpers.
import { RISK_FREE, bsPrice } from './black-scholes.js';
import { nyDateStr } from './format.js';

/** @typedef {{ K: number, iv?: number, side: number, occ?: string, mid?: number, delta?: number }} Leg */
/**
 * The card fields this math reads. Spread legs are always the debit-spread legs (near +1, far −1);
 * a credit spread is credit:true on top, and mid is the net either way.
 * @typedef {{ kind?: string, isCall: boolean, credit?: boolean, legs?: Leg[], parsed: { strike: number }, iv: number,
 *   mid: number, lossPerContract: number, sizing?: string, shortPut?: boolean }} Card
 */

/** @param {Card} d @returns {string} */
export function strikesLabel(d) {
  return d.kind === 'spread' && d.legs ? `$${+d.legs[0].K}/$${+d.legs[1].K}` : `$${+d.parsed.strike}`;
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

// Calendar math runs in UTC so the browser's own time zone never shifts a date.
/** @param {number} y @param {number} m 1-12 @param {number} d */
const weekday = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** Easter Sunday, Gregorian (anonymous algorithm). @param {number} y @returns {number} epoch ms at UTC midnight */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return Date.UTC(y, Math.floor(n / 31) - 1, n % 31 + 1);
}

/**
 * NYSE closed on this third Friday (the 15th to 21st)? Only two holidays can land there: Good Friday, and
 * Juneteenth (from 2022; a Saturday 19th closes Friday the 18th). The rest are Mondays, Thanksgiving, or
 * fixed dates outside that week. @param {number} y @param {number} m @param {number} d @returns {boolean}
 */
function thirdFridayHoliday(y, m, d) {
  if (Date.UTC(y, m - 1, d) === easter(y) - 2 * 864e5) return true;
  return y >= 2022 && m === 6 && (d === 19 || (d === 18 && weekday(y, 6, 19) === 6));
}

/** @param {string} expStr YYYY-MM-DD @returns {boolean} */
export function isMonthlyExp(expStr) {
  // standard monthly = third Friday; when that Friday is an NYSE holiday the
  // expiry moves to the Thursday before, and only then is a Thursday monthly
  const [y, m, d] = expStr.split('-').map(Number);
  const thirdFri = 1 + (5 - weekday(y, m, 1) + 7) % 7 + 14;
  const holiday = thirdFridayHoliday(y, m, thirdFri);
  return d === thirdFri ? !holiday : d === thirdFri - 1 && holiday;
}

/** @param {number} lossPct @returns {string} */
export function lossClass(lossPct) {
  if (lossPct < 25) return 'loss-low';
  if (lossPct < 60) return 'loss-mid';
  return 'loss-high';
}

/** New York wall clock at an instant, as numbers. @param {number} ms @returns {Record<string, number>} */
function nyParts(ms) {
  /** @type {Record<string, number>} */
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ms))) p[x.type] = +x.value;
  return p;
}

/** The New York calendar date at an instant, YYYY-MM-DD. @param {number} [ms] @returns {string} */
export function nyDate(ms = Date.now()) { return nyDateStr(new Date(ms)); }

/** The 4pm New York close on expiry as epoch ms, whatever the browser's time zone; NaN when invalid. @param {string | undefined} expStr YYYY-MM-DD @returns {number} */
export function expiryCloseMs(expStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expStr || '');
  if (!m) return NaN;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], 16); // 4pm as if New York were UTC; DST never switches mid-afternoon
  const p = nyParts(wall);
  return wall - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wall); // less New York's offset that day
}

/** Years until the 4pm New York close on expiry, less `daysLess` days, floored at zero. @param {string | undefined} expStr @param {number} [daysLess] @returns {number} */
export function yearsToExp(expStr, daysLess = 0) {
  if (!expStr) return 0;
  const ms = expiryCloseMs(expStr) - Date.now();
  return Math.max(0, ms / (365 * 24 * 3600 * 1000) - daysLess / 365);
}
