// @ts-check
// The Journal's trade page, pure: a trade's saved 5-minute bars unpacked and cut to its hold, rolled up to longer
// intervals, the sessions before it fetched for context, where its fills land on a chart, the views framing it, what the
// charts draw, and its excursions (MFE, MAE, exit efficiency; docs/journal-step-2.md, slice 3). Times are New York's, the
// way the bars are stamped.
import { aggregateBars, BARS_KEEP_DAYS, nyDay, weekdaysBetween } from './bars.js';
import { nyWallIn } from './format.js';

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
 * A bar's time the way Lightweight Charts takes it: a daily bar's day ('YYYY-MM-DD'), an intraday bar's wall clock in
 * `zone` as if it were UTC seconds (the library has no time zones and labels its axis in UTC, so this reads as that
 * zone's time; New York's by default, the way the bars are stamped).
 * @param {Candle} b @param {string} [zone] @returns {string | number}
 */
export function chartTime(b, zone = 'America/New_York') {
  if (!b.time) return b.date;
  const w = nyWallIn(b.date, b.time, zone);
  const [y, m, d] = w.day.split('-').map(Number), [hh, mm] = w.time.split(':').map(Number);
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
 * The New York weekdays in the two weeks before a trade opened that Tradier still keeps (BARS_KEEP_DAYS) and that are over:
 * the intraday chart's context, fetched when the page opens and never saved.
 * @param {{ openedAt: string, status: string }} trade @param {number} now @returns {string[]}
 */
export function contextDays(trade, now) {
  if (trade.status === 'history' || !trade.openedAt) return [];
  const open = Date.parse(trade.openedAt), oldest = nyDay(now - BARS_KEEP_DAYS * 864e5), today = nyDay(now);
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
 * Times read in `zone` (chartTime).
 * @param {Candle[]} bars @param {{ time: string, side: 'buy' | 'sell', qty: number, price: number }[]} fills @param {number} [iv] @param {string} [zone]
 */
export function chartSeries(bars, fills, iv = 5, zone = 'America/New_York') {
  const times = bars.map(b => chartTime(b, zone)), k = 2 / 9;
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

/** an exit score at or over this is a good exit: you got out in the top 30% of what holding offered from your entry */
export const GOOD_EXIT = 0.7;
/** a position held overnight is held this many sessions past the exit's day, on the daily bars, when judging its exit */
export const SWING_SESSIONS = 5;
/** the sessions after the exit the daily bars are read over for context (no stop) */
export const AFTER_SESSIONS = [1, 3, 10];

/** @typedef {{ price: number, date: string, time: string, how: 'stop' | 'close' | 'sessions', sessions: number }} HoldEnd */

/**
 * Holding on from an exit with the stop in: the rest of its day's 5-minute bars, then `days` (a swing's sessions), until a
 * bar reaches the stop (out at the stop, or at the bar's open when it gapped through). The bars held through, the stop's
 * bar included, and where it ended: the stop, the day's close, or the last session's close; null with nothing after.
 * @param {Candle[]} rest @param {Candle[]} days @param {number | null} stop @param {boolean} long
 * @returns {{ path: Candle[], end: HoldEnd | null }}
 */
function holdOn(rest, days, stop, long) {
  /** @type {Candle[]} */
  const path = [];
  for (const b of [...rest, ...days]) {
    path.push(b);
    if (stop !== null && (long ? b.low <= stop : b.high >= stop)) {
      const gapped = long ? b.open < stop : b.open > stop;
      return { path, end: { price: gapped ? b.open : stop, date: b.date, time: b.time || '', how: 'stop', sessions: 0 } };
    }
  }
  const last = path[path.length - 1];
  if (!last) return { path, end: null };
  return { path, end: days.length ? { price: last.close, date: last.date, time: '', how: 'sessions', sessions: days.length }
    : { price: last.close, date: last.date, time: last.time || '', how: 'close', sessions: 0 } };
}

/**
 * How good the exit was, against holding on with your stop in place (owner request: what holding would really have
 * paid, not the best tick). Each exit fill is judged on its own and weighted by what it closed.
 * - The hold: from each exit, your stop stays in (the last one you moved it to, else the first). A bar that reaches it
 *   takes you out at the stop, or at its open when it gapped through. Otherwise a day trade is held to that day's close;
 *   a position held overnight (opened before the exit's day) goes on SWING_SESSIONS sessions on the daily bars, or as
 *   many as there are so far. An exit at or through the stop has nothing to hold.
 * - held: what that hold would have made against your exit (plus: holding would have made more), and out, where it ended.
 * - score: where the exit sat in the range from the entry's bar to the end of the hold (long: 0 = the low, 1 = the high;
 *   short the other way), so getting out too soon and too late both pull it down. GOOD_EXIT and up is a good exit.
 * - left: the best price during the hold after each exit, in your favor (a ceiling: the best tick). against: the worst,
 *   against you (what getting out kept you from); stopHit when the hold reached the stop.
 * - verdict: 'stopped' (out at or through the stop), 'good' (score ≥ GOOD_EXIT), else 'early' when the move after the exit
 *   ran farther past it than the best while you held had (the move went on without you), 'late' when you gave back more.
 * - sessions: context with no stop: for each of AFTER_SESSIONS the daily bars after the last exit's day have, the best high
 *   (a short's low) and the close that many sessions on, against the average exit, as % and R.
 * Dollars on what each exit closed (quantity × multiplier), R against the trade's risk. Times are New York's. Regular
 * hours unless the exit was outside them. Null for spreads, trades before the history, and with no exits or bars.
 * @param {{ direction: 'long' | 'short', multiplier: number, openedAt: string, status: string, risk: number | null,
 *   stop?: number | null, movedTo?: number | null, legs?: any[] }} trade
 * @param {{ time: string, qty: number, price: number }[]} exits the fills that closed it
 * @param {Candle[]} bars 5-minute bars @param {Candle[]} [daily] the same symbol's daily bars, oldest first
 */
export function afterExit(trade, exits, bars, daily = []) {
  if (trade.legs || trade.status === 'history' || !trade.openedAt || !exits.length || !bars.length) return null;
  const long = trade.direction === 'long', sign = long ? 1 : -1, mult = trade.multiplier || 1;
  const fav = (/** @type {Candle} */ b) => (long ? b.high : b.low), adv = (/** @type {Candle} */ b) => (long ? b.low : b.high);
  const better = (/** @type {number} */ a, /** @type {number} */ b) => (a - b) * sign > 0; // a is further in your favor than b
  const firstStop = trade.stop && trade.stop > 0 ? trade.stop : null;
  const stop = trade.movedTo && trade.movedTo > 0 ? trade.movedTo : firstStop;
  const from = barStart(nyStamp(trade.openedAt)), openDay = from.slice(0, 10);
  const round = (/** @type {number} */ v) => Math.round(v * 100) / 100;
  const r = (/** @type {number} */ v) => (trade.risk && trade.risk > 0 ? Math.round((v / trade.risk) * 100) / 100 : null);
  let qty = 0, scored = 0, scoreSum = 0, left = 0, against = 0, held = 0, missed = 0, gave = 0, pxSum = 0, lastDay = '', judged = 0;
  /** @type {Candle | null} */ let best = null;
  /** @type {Candle | null} */ let worst = null;
  /** @type {HoldEnd | null} */ let out = null;
  let stopHit = false;
  for (const e of [...exits].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))) {
    const s = nyStamp(e.time);
    if (!s || !(e.qty > 0) || !(e.price > 0)) continue;
    const day = s.slice(0, 10), at = barStart(s), regular = s.slice(11) >= '09:30' && s.slice(11) < '16:00';
    const window = bars.filter(b => { const st = stampOf(b); return st >= from && b.date <= day && (!regular || REGULAR(b)); });
    if (!window.length) continue;
    const p = e.price, size = e.qty * mult;
    qty += e.qty; pxSum += p * e.qty; lastDay = day > lastDay ? day : lastDay;
    const heldBest = window.filter(b => stampOf(b) <= at).reduce((m, b) => (better(fav(b), m) ? fav(b) : m), p);
    gave += Math.max(0, (heldBest - p) * sign) * size;
    // the hold after this exit: the rest of the day, then a swing's sessions, until a bar reaches the stop
    // (out at or through the stop already: the stop is where holding would have ended too)
    const { path, end } = stop !== null && !better(p, stop) ? { path: [], end: /** @type {HoldEnd} */ ({ price: p, date: day, time: s.slice(11), how: 'stop', sessions: 0 }) }
      : holdOn(window.filter(b => b.date === day && stampOf(b) > at), day > openDay ? daily.filter(b => b.date > day).slice(0, SWING_SESSIONS) : [], stop, long);
    if (end) { held += (end.price - p) * sign * size; out = end; }
    // the range the exit is scored in: the entry through the end of the hold, no worse than where the stop took you out
    const stopPx = end?.how === 'stop' ? end.price : null;
    const clamp = (/** @type {Candle} */ b) => (stopPx === null ? b : long ? { ...b, low: Math.max(b.low, stopPx) } : { ...b, high: Math.min(b.high, stopPx) });
    const range = [...window.filter(b => stampOf(b) <= at), ...path.map(clamp)];
    const hi = Math.max(p, ...range.map(b => b.high)), lo = Math.min(p, ...range.map(b => b.low));
    if (hi > lo) { scoreSum += ((long ? p - lo : hi - p) / (hi - lo)) * e.qty; scored += e.qty; }
    if (!path.length) continue;
    judged += e.qty;
    const bestAfter = path.reduce((m, b) => (better(fav(b), fav(m)) ? b : m));
    const worstAfter = path.reduce((m, b) => (better(adv(m), adv(b)) ? b : m));
    const ran = Math.max(0, (fav(bestAfter) - p) * sign) * size;
    left += ran; missed += ran;
    // against you, no further than where the stop would have taken you out
    const worstPx = stopPx !== null && better(stopPx, adv(worstAfter)) ? stopPx : adv(worstAfter);
    against += Math.min(0, (worstPx - p) * sign) * size;
    if (!best || better(fav(bestAfter), fav(best))) best = bestAfter;
    if (!worst || better(adv(worst), adv(worstAfter))) worst = worstAfter;
    if (end?.how === 'stop') stopHit = true;
  }
  if (!qty) return null;
  const avgExit = pxSum / qty, score = scored ? Math.round((scoreSum / scored) * 1000) / 1000 : null;
  const stopped = !!(firstStop && !better(avgExit, firstStop + sign * firstStop * 0.001));
  const verdict = stopped ? 'stopped' : score === null ? null : score >= GOOD_EXIT ? 'good' : missed > gave ? 'early' : 'late';
  const later = daily.filter(b => b.date > lastDay);
  const sessions = AFTER_SESSIONS.filter(n => later.length >= n).map(n => {
    const span = later.slice(0, n), top = span.reduce((m, b) => (better(fav(b), m) ? fav(b) : m), fav(span[0])), close = span[n - 1].close;
    const pct = (/** @type {number} */ v) => Math.round(((v - avgExit) * sign / avgExit) * 10000) / 100;
    return { n, best: top, close, bestPct: pct(top), closePct: pct(close), bestR: r((top - avgExit) * sign * qty * mult), closeR: r((close - avgExit) * sign * qty * mult) };
  });
  const at = (/** @type {Candle | null} */ b, /** @type {(b: Candle) => number} */ f) => (b ? { price: f(b), date: b.date, time: b.time || '' } : null);
  return {
    score, verdict, avgExit: Math.round(avgExit * 1e4) / 1e4, qty, stop,
    held: out ? round(held) : null, heldR: out ? r(held) : null, out,
    left: round(left), leftR: r(left), best: judged ? at(best, fav) : null,
    against: round(against), againstR: r(against), worst: judged ? at(worst, adv) : null, stopHit,
    sessions,
  };
}
