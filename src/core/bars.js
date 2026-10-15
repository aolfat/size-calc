// @ts-check
// Bar math: client-side interval aggregation, HV20 from daily closes, percentile ranks; and which 5-minute bars the
// journal's trades need saved (barsNeeded) and Tradier's timesales split into one packed array per day (barsByDay).

import { nyDateStr } from './format.js';
import { parseSchwabOption } from './positions.js';

/** @typedef {{ t: string, o: number, h: number, l: number, c: number, v?: number }} Bar */

/**
 * Roll 5-minute bars up to `iv` minutes by clock time from the 9:30 open (exchange-local `t`), so a missing
 * 5m bar leaves the later buckets where they belong; buckets never cross a session. @param {Bar[]} bars5 @param {number} iv @returns {Bar[]}
 */
export function aggregateBars(bars5, iv) {
  if (iv <= 5) return bars5;
  const chunk = Math.round(iv / 5);
  /** @type {Bar[]} */
  const out = [];
  /** @type {string | null} */
  let day = null, key = null;
  let idx = 0;
  for (const b of bars5) {
    const t = b.t || '';
    const d = t.slice(0, 10);
    if (d !== day) { day = d; idx = 0; } // buckets never cross a session boundary
    const mins = +t.slice(11, 13) * 60 + +t.slice(14, 16) - (9 * 60 + 30);
    const bucket = d + ':' + (/T\d\d:\d\d/.test(t) ? Math.floor(mins / (chunk * 5)) : Math.floor(idx / chunk)); // no clock time: by count
    idx++;
    if (bucket !== key) { key = bucket; out.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }); }
    else {
      const cur = out[out.length - 1];
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v = (cur.v || 0) + (b.v || 0);
    }
  }
  return out;
}

// annualized 20-day HV ending at index `end` (exclusive); shared with the lev ETF target tool

/** @param {number[]} closes @param {number} end @returns {number} */
export function hv20At(closes, end) {
  const rets = [];
  for (let i = end - 19; i < end; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
  return Math.sqrt(v * 252);
}

/** Rank of `value` within `arr` (0–100), or null without 20 samples. @param {number} value @param {number[]} arr @returns {number | null} */
export function percentileOf(value, arr) {
  if (!(value > 0) || arr.length < 20) return null;
  return Math.round(arr.filter(v => v < value).length / arr.length * 100);
}

// ---------- saving 5-minute bars for the journal ----------

const DAY_MS = 86400000;
/** how far back bars are asked for: Tradier serves about 40 days of 5-minute bars, so stay well inside it */
export const BARS_KEEP_DAYS = 35;

/** the New York trading day of a time. @param {string | number} t */
export const nyDay = t => nyDateStr(new Date(t));

/** the symbols a trade's charts need, in Tradier's form: the stock; an option and its underlying. @param {{ symbol: string, assetType: string }} trade */
export function tradeBarSymbols(trade) {
  const o = trade.assetType === 'OPTION' ? parseSchwabOption(trade.symbol) : null;
  return o ? [trade.symbol.replace(/\s+/g, ''), o.root] : [trade.symbol];
}

/** weekdays from one New York day to another, both included ('YYYY-MM-DD'). @param {string} from @param {string} to */
export function weekdaysBetween(from, to) {
  /** @type {string[]} */
  const out = [];
  for (let t = Date.parse(from + 'T12:00:00Z'), end = Date.parse(to + 'T12:00:00Z'); t <= end; t += DAY_MS) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * The bars the trades need: for each trade, every weekday it was open (opened to closed, or to now), finished days only
 * (today's session isn't over), and only within the last BARS_KEEP_DAYS. Trades from before the history have no open
 * date, so none. A holiday comes back empty from Tradier and is kept empty.
 * @param {{ symbol: string, assetType: string, status: string, openedAt: string, closedAt: string | null }[]} trades
 * @param {number} now @param {number} [keepDays]
 * @returns {Map<string, string[]>} Tradier symbol → days, oldest first
 */
export function barsNeeded(trades, now, keepDays = BARS_KEEP_DAYS) {
  const earliest = nyDay(now - keepDays * DAY_MS);
  const yesterday = nyDay(Date.parse(nyDay(now) + 'T12:00:00Z') - DAY_MS);
  /** @type {Map<string, Set<string>>} */
  const need = new Map();
  for (const t of trades) {
    if (t.status === 'history' || !t.openedAt) continue;
    let from = nyDay(t.openedAt), to = t.closedAt ? nyDay(t.closedAt) : yesterday;
    if (from < earliest) from = earliest;
    if (to > yesterday) to = yesterday;
    if (from > to) continue;
    const days = weekdaysBetween(from, to);
    for (const sym of tradeBarSymbols(t)) {
      if (!need.has(sym)) need.set(sym, new Set());
      for (const d of days) /** @type {Set<string>} */ (need.get(sym)).add(d);
    }
  }
  return new Map([...need].map(([sym, days]) => [sym, [...days].sort()]));
}

/**
 * Tradier's timesales split into New York days, each packed as [time, open, high, low, close, volume] rows
 * ('09:30', exchange-local, as Tradier sends it), oldest first.
 * @param {{ time: string, open: number, high: number, low: number, close: number, volume?: number }[]} data
 * @returns {Map<string, (string | number)[][]>}
 */
export function barsByDay(data) {
  /** @type {Map<string, (string | number)[][]>} */
  const out = new Map();
  for (const b of data || []) {
    const day = String(b?.time || '').slice(0, 10), time = String(b?.time || '').slice(11, 16);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !time || ![b.open, b.high, b.low, b.close].every(Number.isFinite)) continue;
    if (!out.has(day)) out.set(day, []);
    /** @type {(string | number)[][]} */ (out.get(day)).push([time, b.open, b.high, b.low, b.close, Number(b.volume) || 0]);
  }
  for (const rows of out.values()) rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return out;
}
