// @ts-check
// Bar math: client-side interval aggregation, HV20 from daily closes, percentile ranks; and which 5-minute bars the
// journal's trades need saved (barsNeeded: the days they were open, the sessions before for comparisons, the market basket)
// and a provider's 5-minute bars split into one packed array per day (barsByDay).

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

/** when a New York day's bars are all in: extended hours end at 20:00, the end of what timesales is asked for */
export const DAY_DONE = '20:00';
const NY_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * Saved every weekday whether you traded or not, so features about the market at a trade's entry (SPY over its 8 EMA,
 * how the sector did) work for every trade: the broad indexes and the 11 sector SPDRs (docs/journal-features.md).
 */
export const MARKET_BASKET = ['SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLV', 'XLY', 'XLC', 'XLI', 'XLP', 'XLE', 'XLU', 'XLB', 'XLRE'];

/** weekdays saved before a trade's open for its stock (an option's underlying): what a volume run rate compares against */
export const LOOKBACK_DAYS = 20;

/** the newest New York day whose bars are all in: today from 20:00 on, else yesterday. @param {number} now */
export function lastDoneDay(now) {
  const today = nyDay(now);
  return NY_CLOCK.format(new Date(now)) >= DAY_DONE ? today : nyDay(Date.parse(today + 'T12:00:00Z') - DAY_MS);
}

/** the symbols a trade's charts need, in Tradier's form: the stock; an option and its underlying; none for a future (Tradier has none). @param {{ symbol: string, assetType: string }} trade */
export function tradeBarSymbols(trade) {
  if (trade.assetType === 'FUTURE') return [];
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

/** the `n` weekdays before a New York day, oldest first, the day itself left out. @param {string} day @param {number} n */
export function weekdaysBefore(day, n) {
  /** @type {string[]} */
  const out = [];
  for (let t = Date.parse(day + 'T12:00:00Z') - DAY_MS; out.length < n; t -= DAY_MS) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * The bars the trades need: for each trade, every weekday it was open (opened to closed, or to now), and the `lookback`
 * weekdays before its open for its stock (an option's underlying, not the contract); and every weekday for each `market`
 * symbol. Finished days only (today once extended hours end at 20:00: lastDoneDay; a day saved early would stay cut
 * short), and only within the last `keepDays`. Trades from before the history have no open date, so none. A holiday
 * comes back empty and is kept empty.
 * @param {{ symbol: string, assetType: string, status: string, openedAt: string, closedAt: string | null }[]} trades
 * @param {number} now @param {{ keepDays?: number, lookback?: number, market?: string[] }} [opts]
 * @returns {Map<string, string[]>} symbol → days, oldest first
 */
export function barsNeeded(trades, now, { keepDays = BARS_KEEP_DAYS, lookback = LOOKBACK_DAYS, market = [] } = {}) {
  const earliest = nyDay(now - keepDays * DAY_MS);
  const done = lastDoneDay(now);
  /** @type {Map<string, Set<string>>} */
  const need = new Map();
  /** @param {string} sym @param {string[]} days */
  const add = (sym, days) => {
    if (!need.has(sym)) need.set(sym, new Set());
    for (const d of days) if (d >= earliest && d <= done) /** @type {Set<string>} */ (need.get(sym)).add(d);
  };
  for (const t of trades) {
    if (t.status === 'history' || !t.openedAt) continue;
    const open = nyDay(t.openedAt);
    let from = open, to = t.closedAt ? nyDay(t.closedAt) : done;
    if (from < earliest) from = earliest;
    if (to > done) to = done;
    const syms = tradeBarSymbols(t);
    if (from <= to) for (const sym of syms) add(sym, weekdaysBetween(from, to));
    if (lookback > 0 && open > earliest) add(syms[syms.length - 1], weekdaysBefore(open, lookback));
  }
  if (market.length && earliest <= done) for (const sym of market) add(sym, weekdaysBetween(earliest, done));
  return new Map([...need].filter(([, days]) => days.size).map(([sym, days]) => [sym, [...days].sort()]));
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
