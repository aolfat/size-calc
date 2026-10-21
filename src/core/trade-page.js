// @ts-check
// The Journal's trade page, pure: a trade's saved 5-minute bars unpacked and cut to its hold, rolled up to longer
// intervals, the sessions before it fetched for context, where its fills land on a chart, the views framing it, what the
// charts draw, and its excursions (MFE, MAE, exit efficiency; docs/journal-step-2.md, slice 3). Times are New York's, the
// way the bars are stamped.
import { aggregateBars, BARS_KEEP_DAYS, nyDay, weekdaysBetween } from './bars.js';

/** @typedef {{ date: string, time?: string, open: number, high: number, low: number, close: number, volume?: number }} Candle */

const NY_STAMP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** an ISO time as New York's 'YYYY-MM-DD HH:MM'. @param {string} iso */
export function nyStamp(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  /** @type {Record<string, string>} */
  const p = {};
  for (const part of NY_STAMP.formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** the 5-minute bar a stamp falls in: '2026-10-13 09:43' → '2026-10-13 09:40'. @param {string} stamp */
export const barStart = stamp => stamp ? `${stamp.slice(0, 14)}${String(Math.floor(Number(stamp.slice(14, 16)) / 5) * 5).padStart(2, '0')}` : '';

const stampOf = (/** @type {Candle} */ b) => `${b.date} ${b.time || '00:00'}`;

/**
 * Saved rows (bars_5m: { day, bars: [[time, o, h, l, c, v], ...] }) as candles, oldest first.
 * @param {{ day: string, bars: any[] }[]} rows @returns {Candle[]}
 */
export function unpackBars(rows) {
  /** @type {Candle[]} */
  const out = [];
  for (const r of [...rows].sort((a, b) => String(a.day).localeCompare(String(b.day)))) {
    const date = String(r.day).slice(0, 10);
    for (const b of Array.isArray(r.bars) ? r.bars : []) {
      if (!Array.isArray(b) || b.length < 5) continue;
      out.push({ date, time: String(b[0]), open: Number(b[1]), high: Number(b[2]), low: Number(b[3]), close: Number(b[4]), volume: Number(b[5]) || 0 });
    }
  }
  return out.sort((a, b) => stampOf(a).localeCompare(stampOf(b)));
}

const REGULAR = (/** @type {Candle} */ b) => (b.time || '') >= '09:30' && (b.time || '') < '16:00';

/**
 * The bars a chart shows for a trade: its days, regular hours only unless a fill happened outside them.
 * @param {Candle[]} bars @param {{ time: string }[]} fills
 */
export function holdChartBars(bars, fills) {
  const outside = fills.some(f => { const t = nyStamp(f.time).slice(11); return t < '09:30' || t >= '16:00'; });
  return outside ? bars : bars.filter(REGULAR);
}

/** the `iv`-minute bucket a New York stamp falls in, counted from the 9:30 open (aggregateBars' buckets) @param {string} stamp @param {number} iv */
const bucketOf = (stamp, iv) => `${stamp.slice(0, 10)}:${Math.floor((Number(stamp.slice(11, 13)) * 60 + Number(stamp.slice(14, 16)) - 570) / iv)}`;

/**
 * Where each fill lands: the index of the bar it falls in (intraday: the `iv`-minute bar it happened in; daily: its day),
 * and its side. Fills outside the bars are left out.
 * @param {Candle[]} bars @param {{ time: string, side: 'buy' | 'sell', qty: number, price: number }[]} fills @param {number} [iv]
 */
export function fillMarks(bars, fills, iv = 5) {
  const daily = !bars.some(b => b.time);
  /** @type {Map<string, number>} */
  const at = new Map(bars.map((b, i) => [daily ? b.date : bucketOf(stampOf(b), iv), i]));
  /** @type {{ index: number, side: 'buy' | 'sell', qty: number, price: number }[]} */
  const out = [];
  for (const f of fills) {
    const s = nyStamp(f.time);
    const i = s ? at.get(daily ? s.slice(0, 10) : bucketOf(s, iv)) : undefined;
    if (i !== undefined) out.push({ index: i, side: f.side, qty: f.qty, price: f.price });
  }
  return out;
}

/**
 * A bar's time the way Lightweight Charts takes it: a daily bar's day ('YYYY-MM-DD'), an intraday bar's New York wall clock
 * as if it were UTC seconds (the library has no time zones and labels its axis in UTC, so this reads as New York time).
 * @param {Candle} b @returns {string | number}
 */
export function chartTime(b) {
  if (!b.time) return b.date;
  const [y, m, d] = b.date.split('-').map(Number), [hh, mm] = b.time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) / 1000;
}

/**
 * 5-minute bars as `iv`-minute ones, bucketed by clock time from the 9:30 open and never across a session (aggregateBars,
 * the calculator's own); each takes the time of its first 5-minute bar.
 * @param {Candle[]} bars @param {number} iv @returns {Candle[]}
 */
export function rollUp(bars, iv) {
  if (iv <= 5) return bars;
  return aggregateBars(bars.map(b => ({ t: `${b.date}T${b.time}`, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume || 0 })), iv)
    .map(b => ({ date: b.t.slice(0, 10), time: b.t.slice(11, 16), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0 }));
}

/**
 * The New York weekdays in the two weeks before a trade opened that a provider still serves (from `oldest`: Tradier's
 * BARS_KEEP_DAYS by default, a paid Massive plan's years) and that are over: the intraday chart's context, fetched when
 * the page opens and never saved.
 * @param {{ openedAt: string, status: string }} trade @param {number} now @param {string} [oldest] @returns {string[]}
 */
export function contextDays(trade, now, oldest = nyDay(now - BARS_KEEP_DAYS * 864e5)) {
  if (trade.status === 'history' || !trade.openedAt) return [];
  const open = Date.parse(trade.openedAt), today = nyDay(now);
  return weekdaysBetween(nyDay(open - 14 * 864e5), nyDay(open - 864e5)).filter(d => d >= oldest && d < today);
}

const MIN_VIEW = 60;

/**
 * The intraday view of a trade: the bar it opened in through the bar it closed in (or the latest), with a quarter of the
 * hold, at least six bars, either side; then at least 60 bars wide, two thirds of the widening before the open (the
 * context), what one side can't take going to the other. Bar indexes, end exclusive.
 * @param {Candle[]} bars @param {{ openedAt: string, closedAt: string | null }} trade
 */
export function holdView(bars, trade) {
  const n = bars.length;
  const upTo = (/** @type {string} */ s) => { let k = 0; for (let i = 0; i < n && stampOf(bars[i]) <= s; i++) k = i; return k; };
  const a = upTo(nyStamp(trade.openedAt)), b = trade.closedAt ? upTo(nyStamp(trade.closedAt)) : n - 1;
  const pad = Math.max(6, Math.round((b - a + 1) * 0.25));
  let start = a - pad, end = b + 1 + pad;
  const short = MIN_VIEW - (end - start);
  if (short > 0) { start -= Math.ceil(short * 2 / 3); end += short - Math.ceil(short * 2 / 3); }
  if (start < 0) { end -= start; start = 0; }
  if (end > n) { start = Math.max(0, start - (end - n)); end = n; }
  return { start, end };
}

/** a volume the way chart legends say it: 742.58K, 1.23M @param {number} v */
export function compactVolume(v) {
  const a = Math.abs(v);
  for (const [n, unit] of /** @type {[number, string][]} */ ([[1e9, 'B'], [1e6, 'M'], [1e3, 'K']])) if (a >= n) return `${+(v / n).toFixed(2)}${unit}`;
  return String(Math.round(v));
}

/**
 * VWAP on intraday bars, starting over each New York day (the calculator's chart does the same): the running sum of
 * typical price ((high + low + close) / 3) × volume over the running volume, the typical price itself until the day has
 * volume. Over the bars shown, so it starts at 4:00 when the chart has the extended hours. Daily bars have none: [].
 * @param {Candle[]} bars @returns {number[]}
 */
export function sessionVwap(bars) {
  if (!bars.some(b => b.time)) return [];
  let day = '', pv = 0, v = 0;
  return bars.map(b => {
    if (b.date !== day) { day = b.date; pv = 0; v = 0; }
    const tp = (b.high + b.low + b.close) / 3, vol = b.volume || 0;
    pv += tp * vol; v += vol;
    return v > 0 ? pv / v : tp;
  });
}

/**
 * What a trade chart draws, oldest first: the candles, the 8 EMA of the closes (seeded on the first close), the session
 * VWAP on intraday bars (sessionVwap; `end` on a day's last bar when another day follows, so the line can break there),
 * volume (up = closed at or over its open, like the candles), and each fill on its bar (fillMarks), in the order they happened.
 * @param {Candle[]} bars @param {{ time: string, side: 'buy' | 'sell', qty: number, price: number }[]} fills @param {number} [iv]
 */
export function chartSeries(bars, fills, iv = 5) {
  const times = bars.map(chartTime), k = 2 / 9;
  const byTime = [...fills].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  let e = bars.length ? bars[0].close : 0;
  return {
    candles: bars.map((b, i) => ({ time: times[i], open: b.open, high: b.high, low: b.low, close: b.close })),
    ema: bars.map((b, i) => ({ time: times[i], value: (e = i ? b.close * k + e * (1 - k) : e) })),
    vwap: sessionVwap(bars).map((value, i) => ({ time: times[i], value, end: i + 1 < bars.length && bars[i + 1].date !== bars[i].date })),
    volume: bars.map((b, i) => ({ time: times[i], value: b.volume || 0, up: b.close >= b.open })),
    markers: fillMarks(bars, byTime, iv).sort((a, b) => a.index - b.index).map(m => ({ time: times[m.index], side: m.side, qty: m.qty, price: m.price })),
  };
}

/**
 * The daily view around a trade: 40 sessions before it opened through 10 after it closed (or to the latest bar).
 * @param {Candle[]} daily @param {{ openedAt: string, closedAt: string | null }} trade
 * @returns {{ count: number, offset: number }}
 */
export function dailyWindow(daily, trade) {
  const n = daily.length;
  if (!n) return { count: 63, offset: 0 };
  const day = (/** @type {string} */ iso) => nyStamp(iso).slice(0, 10);
  const idx = (/** @type {string} */ d) => { const i = daily.findIndex(b => b.date >= d); return i < 0 ? n - 1 : i; };
  const open = idx(day(trade.openedAt)), close = trade.closedAt ? idx(day(trade.closedAt)) : n - 1;
  const end = Math.min(n, close + 11), start = Math.max(0, open - 40);
  return { count: Math.max(10, end - start), offset: n - end };
}

/**
 * How far the trade went for and against you while it was open, from the bars inside the hold (the bar it opened in
 * through the bar it closed in). Long: the best high and worst low against the average entry; short, the other way.
 * Dollars on the whole entry (quantity × multiplier), R against the trade's risk. Exit efficiency = realized P&L ÷ MFE,
 * winners only (a loser has no gain to keep), at most 100%. Null for spreads, trades from before the history, and
 * holds with no bars.
 * @param {{ direction: 'long' | 'short', avgEntry: number, entryQty: number, multiplier: number, openedAt: string,
 *   closedAt: string | null, status: string, pnl: number, risk: number | null, legs?: any[] }} trade
 * @param {Candle[]} bars
 */
export function excursions(trade, bars) {
  if (trade.legs || trade.status === 'history' || !(trade.avgEntry > 0)) return null;
  const from = barStart(nyStamp(trade.openedAt)), to = trade.closedAt ? nyStamp(trade.closedAt) : '9999';
  const held = bars.filter(b => { const s = stampOf(b); return s >= from && s <= to; });
  if (!held.length) return null;
  const long = trade.direction === 'long', size = trade.entryQty * trade.multiplier;
  let bestPx = long ? -Infinity : Infinity, worstPx = long ? Infinity : -Infinity;
  for (const b of held) {
    if (long) { bestPx = Math.max(bestPx, b.high); worstPx = Math.min(worstPx, b.low); }
    else { bestPx = Math.min(bestPx, b.low); worstPx = Math.max(worstPx, b.high); }
  }
  const sign = long ? 1 : -1;
  const round = (/** @type {number} */ v) => Math.round(v * 100) / 100;
  const mfe = round(Math.max(0, (bestPx - trade.avgEntry) * sign) * size);
  const mae = round(Math.min(0, (worstPx - trade.avgEntry) * sign) * size);
  const r = (/** @type {number} */ v) => trade.risk && trade.risk > 0 ? Math.round((v / trade.risk) * 100) / 100 : null;
  const closed = trade.status !== 'open';
  return {
    mfe, mae, mfePrice: bestPx, maePrice: worstPx, mfeR: r(mfe), maeR: r(mae), bars: held.length,
    efficiency: closed && trade.pnl > 0 && mfe > 0 ? Math.min(1, Math.round((trade.pnl / mfe) * 1000) / 1000) : null,
  };
}

/**
 * The exit in words: one exit's price, or the average of several; while it's open, how much is closed and what closing
 * it was called (sold, bought back, closed for a spread). Null before any exit.
 * @param {{ avgExit: number | null, exits: number, entryQty: number, openQty: number, direction: string, legs?: any[] }} trade
 * @returns {{ avg: boolean, closed: number, verb: string } | null}
 */
export function exitParts(trade) {
  if (trade.avgExit === null) return null;
  return { avg: trade.exits > 1, closed: Math.round((trade.entryQty - trade.openQty) * 1e4) / 1e4,
    verb: trade.legs ? 'closed' : trade.direction === 'short' ? 'bought back' : 'sold' };
}

/** the exit line's label on the trade's chart: 'exit 0.71', 'avg exit 0.71', and while open 'avg exit 0.71 · 60 of 100' */
export function exitLineLabel(/** @type {Parameters<typeof exitParts>[0] & { status: string }} */ trade) {
  const x = exitParts(trade);
  if (!x || trade.avgExit === null) return '';
  return `${x.avg ? 'avg exit' : 'exit'} ${trade.avgExit.toFixed(2)}${trade.status === 'open' ? ` · ${x.closed} of ${trade.entryQty}` : ''}`;
}
