// @ts-check
// Market breadth (docs/journal-features.md): the % of US common stocks above their 5 / 20 / 50 / 100 / 200-day simple
// averages at each day's close, the app's own take on Barchart's $MMFD / $MMTW / $MMFI / $MMOH / $MMTH. Worked out from
// every stock's daily close (Massive's grouped daily bars, one call a day), never fetched as a number. Pure: no DOM, no
// state. A day is { day, closed } for a weekday the market was shut, else { day, tickers, closes }; days are read in
// order, and a weekday missing from them breaks every average, so nothing is counted across a gap.
import { nyDay, weekdaysBefore, weekdaysBetween } from './bars.js';

/** the averages counted, in sessions: Barchart's FD, TW, FI, OH and TH */
export const BREADTH_LENGTHS = [5, 20, 50, 100, 200];
/** how far back the provider's daily bars reach (Massive's free plan: two years) */
export const BREADTH_HISTORY_DAYS = 730;
/** the universe the counts are over: US-listed common stocks (Massive's type CS), so no ETFs, funds, warrants or preferreds */
export const BREADTH_UNIVERSE = 'us_common';

const DAY_MS = 86400000;

/**
 * @typedef {{ day: string, closed?: boolean, tickers?: string[], closes?: number[] }} BreadthDay
 * @typedef {Record<string, [number, number] | boolean>} BreadthCounts
 */

/**
 * Each day's counts: for every length n, [stocks closing above their n-day SMA (that day's close in it), stocks with n
 * closes to average]. A stock that didn't trade a day isn't counted that day and its average carries on from its last
 * close. Days without enough sessions since the last gap for an n leave that n out.
 * @param {BreadthDay[]} days any order @returns {Map<string, BreadthCounts>}
 */
export function breadthCounts(days) {
  const byDay = new Map(days.map(d => [d.day, d]));
  const sorted = [...byDay.keys()].sort();
  /** @type {Map<string, BreadthCounts>} */
  const out = new Map();
  if (!sorted.length) return out;
  const max = Math.max(...BREADTH_LENGTHS);
  /** @type {Map<string, { closes: number[], sums: number[] }>} */
  let state = new Map();
  let sessions = 0; // sessions since the last gap
  for (const d of weekdaysBetween(sorted[0], sorted[sorted.length - 1])) {
    const row = byDay.get(d);
    if (!row) { state = new Map(); sessions = 0; continue; } // a gap: start over
    if (row.closed) { out.set(d, { closed: true }); continue; }
    sessions++;
    /** @type {BreadthCounts} */
    const counts = {};
    const tally = BREADTH_LENGTHS.map(() => [0, 0]);
    const tickers = row.tickers || [], closes = row.closes || [];
    for (let i = 0; i < tickers.length; i++) {
      const c = closes[i];
      if (!(c > 0)) continue;
      let st = state.get(tickers[i]);
      if (!st) state.set(tickers[i], st = { closes: [], sums: BREADTH_LENGTHS.map(() => 0) });
      st.closes.push(c);
      const len = st.closes.length;
      BREADTH_LENGTHS.forEach((n, k) => {
        st.sums[k] += c;
        if (len > n) st.sums[k] -= st.closes[len - 1 - n];
        if (len >= n) { tally[k][1]++; if (c > st.sums[k] / n) tally[k][0]++; }
      });
      if (len > max + 50) { st.closes = st.closes.slice(-max); } // keep the window, not the whole history
    }
    BREADTH_LENGTHS.forEach((n, k) => { if (sessions >= n && tally[k][1] > 0) counts[String(n)] = /** @type {[number, number]} */ (tally[k]); });
    out.set(d, counts);
  }
  return out;
}

/** the averages a day can ever have: those whose sessions before it are inside the provider's reach @param {string} day @param {number} now */
export function reachableLengths(day, now) {
  const start = nyDay(now - BREADTH_HISTORY_DAYS * DAY_MS);
  return BREADTH_LENGTHS.filter(n => weekdaysBefore(day, Math.ceil(n * 1.05) + 2)[0] >= start);
}

/** a day's counts are done: a shut day, or every average it can ever have @param {BreadthCounts | undefined} row @param {string} day @param {number} now */
export function breadthDone(row, day, now) {
  if (!row) return false;
  if (row.closed) return true;
  return reachableLengths(day, now).every(n => Array.isArray(row[String(n)]));
}

/**
 * The days whose closes still have to be read for the features to have their breadth: every weekday from the session
 * before the first moment through `through` that isn't done, and for each the sessions its longest average needs before
 * it; less what's already read, inside the provider's reach, newest first (so recent trades fill in first).
 * @param {{ moments: string[], rows: Map<string, BreadthCounts>, read: Set<string>, now: number, through: string }} p
 * @returns {string[]}
 */
export function breadthDaysToRead({ moments, rows, read, now, through }) {
  if (!moments.length) return [];
  const start = nyDay(now - BREADTH_HISTORY_DAYS * DAY_MS);
  const first = weekdaysBefore([...moments].sort()[0], 1)[0];
  const need = new Set();
  for (const d of weekdaysBetween(first < start ? start : first, through)) {
    if (breadthDone(rows.get(d), d, now)) continue;
    const lengths = reachableLengths(d, now);
    const back = lengths.length ? Math.ceil(Math.max(...lengths) * 1.05) + 2 : 0; // room for holidays in the window
    need.add(d);
    for (const b of back ? weekdaysBefore(d, back) : []) need.add(b);
  }
  return [...need].filter(d => d >= start && d <= through && !read.has(d)).sort().reverse();
}

/**
 * One day of Massive's grouped daily bars as a BreadthDay: the universe's closes, or the market shut. An empty answer
 * for a day not yet two days old is no answer (Massive's free plan posts the day after), so null: read it again later.
 * @param {string} day @param {{ resultsCount?: number, results?: { T?: string, c?: number }[] } | null} body
 * @param {Set<string>} universe @param {number} now @returns {BreadthDay | null}
 */
export function groupedToDay(day, body, universe, now) {
  const results = Array.isArray(body?.results) ? body.results : [];
  if (!results.length) return day < nyDay(now - 2 * DAY_MS) ? { day, closed: true } : null;
  const tickers = [], closes = [];
  for (const r of results) if (r && typeof r.T === 'string' && universe.has(r.T) && r.c > 0) { tickers.push(r.T); closes.push(+r.c); }
  return { day, tickers, closes };
}
