// @ts-check
// Quick lookup shorthand: order-free tokens (ticker, strike, date, call/put, spread) parsed into a contract or spread.
import { nyDate } from './options.js';

/**
 * @typedef {{ ticker: string, strike: number, strike2?: number, optType: string, spread?: boolean, credit?: boolean,
 *   expStr: string, occ: string, occ2?: string, display: string }} QuickParse
 */

const SPREAD_HINT = 'add cds, pds, ccs or pcs for a spread';

/** Days in a month; Feb has 29 when the year isn't known yet. @param {number} m 1-12 @param {number} [y] */
const daysIn = (m, y = 2000) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * The parse, a short hint string when the words can't make one contract (impossible date, a number
 * too many), or null when something is missing or unrecognized. @param {string} str @returns {QuickParse | string | null}
 */
function parse(str) {
  const s = str.trim();
  if (!s) return null;
  // order-free tokens: ticker, strike, expiry (m/d, m.d, m/d/yy), call/put
  const tokens = s.split(/\s+/);
  const isAlpha = /** @param {string} t */ t => /^[A-Za-z]{1,5}$/.test(t);
  /** @param {string} t */
  const isDate = t => {
    const m = t.match(/^(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?$/);
    if (!m || !(+m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31)) return false;
    // a dotted number that can't be a calendar day (9.31) is a price; a slashed one stays a (bad) date
    return t.includes('/') || +m[2] <= daysIn(+m[1], m[3] ? (+m[3] < 100 ? +m[3] + 2000 : +m[3]) : undefined);
  };
  const alphaCount = tokens.filter(isAlpha).length;
  /** @type {string | null} */
  let ticker = null, optType = null, dateTok = null;
  /** @type {number[] | null} */
  let pair = null;
  let spread = false, creditSpread = false;
  /** @type {number[]} */
  const nums = [];
  for (const raw of tokens) {
    const t = raw.replace(/^\$/, '');
    const low = t.toLowerCase();
    if ((low === 'cds' || low === 'pds' || low === 'ccs' || low === 'pcs') && !spread) { spread = true; creditSpread = low[1] === 'c'; optType = low[0] === 'c' ? 'call' : 'put'; continue; }
    if ((low === 'call' || low === 'put') && !optType) { optType = low; continue; }
    // bare c/p means the type only when another word can be the ticker (C and P are real tickers)
    if ((low === 'c' || low === 'p') && alphaCount > 1 && !optType) { optType = low === 'c' ? 'call' : 'put'; continue; }
    if (t.includes('/') && isDate(t) && !dateTok) { dateTok = t; continue; }
    // a strike pair (105/115) is anything slashed that can't be a date
    if (!pair && /^\d+(\.\d+)?\/\d+(\.\d+)?$/.test(t) && !isDate(t)) { pair = t.split('/').map(Number); continue; }
    if (isAlpha(t) && !ticker) { ticker = t.toUpperCase(); continue; }
    // a strike can carry its type: 245c, 580.5p
    const suffixed = t.match(/^(\d+(?:\.\d+)?)([cp])$/i);
    if (suffixed) {
      const suffixType = suffixed[2].toLowerCase() === 'c' ? 'call' : 'put';
      if (optType && optType !== suffixType) return null;
      optType = suffixType; nums.push(parseFloat(suffixed[1])); continue;
    }
    if (/^\d+(\.\d+)?$/.test(t)) {
      // a dotted number (9.18) is a date unless one is already set, then it's a strike
      if (t.includes('.') && !dateTok && isDate(t)) { dateTok = t; continue; }
      nums.push(parseFloat(t)); continue;
    }
    if (isDate(t) && !dateTok) { dateTok = t; continue; } // dotted with year: 9.18.26
    return null; // unrecognized token
  }
  if (!ticker) return null;
  const type = optType || 'call';
  let strike = 0, strike2 = 0;
  if (spread) {
    if (pair && nums.length) return 'A number too many: one strike pair per spread';
    if (!pair && nums.length > 2) return 'A number too many: a spread takes two strikes';
    const pr = pair || (nums.length === 2 ? nums : null);
    if (!pr || pr[0] === pr[1] || !(pr[0] > 0) || !(pr[1] > 0)) return null;
    const lo = Math.min(pr[0], pr[1]), hi = Math.max(pr[0], pr[1]);
    strike = type === 'call' ? lo : hi;  // near leg first: debit buys it, credit sells it
    strike2 = type === 'call' ? hi : lo; // the further-out leg
  } else {
    if (pair) return 'A strike pair needs cds, pds, ccs or pcs';
    if (nums.length > 1) return `Two strikes: ${SPREAD_HINT}, or keep one`;
    if (!nums.length) return null;
    strike = nums[0];
  }
  if (!dateTok) return null;
  const parts = dateTok.split(/[\/.]/).map(Number);
  const month = parts[0];
  const day = parts[1];
  let year;
  if (parts.length > 2) year = parts[2] < 100 ? parts[2] + 2000 : parts[2];
  else {
    // no year: this year, or next once the date has passed in New York (today still counts, 0DTE)
    const [ty, tm, td] = nyDate().split('-').map(Number);
    year = month < tm || (month === tm && day < td) ? ty + 1 : ty;
  }
  if (day > daysIn(month, year)) return `No such date: ${month}/${day}/${year}`;
  const yyyy = String(year);
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const expStr = `${yyyy}-${mm}-${dd}`;
  const typeChar = type === 'call' ? 'C' : 'P';
  const sym = ticker;
  const mkOcc = /** @param {number} k */ k => `${sym}${yyyy.slice(2)}${mm}${dd}${typeChar}${String(Math.round(k * 1000)).padStart(8, '0')}`;
  const occ = mkOcc(strike);
  if (spread) {
    return { ticker, strike, strike2, optType: type, spread: true, credit: creditSpread, expStr, occ, occ2: mkOcc(strike2),
      display: `${ticker} $${strike}/$${strike2} ${type} ${creditSpread ? 'credit' : 'debit'} spread ${expStr}` };
  }
  return { ticker, strike, optType: type, expStr, occ, display: `${ticker} $${strike} ${type} ${expStr}` };
}

/** @param {string} str @returns {QuickParse | null} */
export function parseQuickStr(str) {
  const r = parse(str);
  return typeof r === 'string' ? null : r;
}

/** Why the words can't pin one contract (impossible date, an extra number), or '' (fine, or just incomplete). @param {string} str @returns {string} */
export function quickParseHint(str) {
  const r = parse(str);
  return typeof r === 'string' ? r : '';
}

// the ticker field is the one search box: a symbol loads its quote, shorthand pins a contract

/** @param {string} v @returns {boolean} */
export function isShorthand(v) { return v.trim().split(/\s+/).length > 1; }
