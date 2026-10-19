// @ts-check
// What a feature sees (docs/journal-features.md, part 2): one trade at one moment (its entry, or its exit), with the data
// cut off there, so no feature can look ahead. Intraday bars are the saved 5-minute ones: a bar counts once it has ended
// (it starts 09:40 and the moment is 09:45 or later); the bar the moment falls in shows only its open, which was known
// when it started. Daily bars are the days before the moment's day, plus that day's open once it's 9:30. The shared
// helpers (VWAP, volume so far, the volume by the same time on earlier days, EMAs, highs) are worked out once per trade
// and moment, whichever feature asks first. Every read notes what was missing: data that could still come (a day the
// bar saver hasn't got to, today's bars, daily bars not read yet) makes the feature wait; data gone for good makes it
// unknown. Every read is also recorded, so a test can check a feature only reads what its `needs` declare.
import { BARS_KEEP_DAYS, lastDoneDay, nyDay, weekdaysBefore } from '../bars.js';
import { parseSchwabOption, tradierSymbol } from '../positions.js';
import { nyStamp } from '../trade-page.js';

/**
 * @typedef {{ date: string, time?: string, open: number, high: number, low: number, close: number, volume?: number }} Candle
 * @typedef {{ intraday: Map<string, Map<string, Candle[]>>, daily: Map<string, Candle[] | null> }} FeatureData
 *   intraday: symbol → New York day → that day's 5-minute bars, oldest first ([] = kept empty, a holiday; a day not in
 *   the map wasn't kept). daily: symbol → daily bars, oldest first ([] = the provider has none; null or absent = not
 *   read, try again).
 * @typedef {{ symbol: string, assetType: string, openedAt: string, closedAt: string | null }} FeatureTrade
 * @typedef {{ kind: 'intraday' | 'daily', symbol: string, session?: string, sessions?: number, lookback?: number }} FeatureRead
 */

const DAY_MS = 86400000;
/** the regular session, by the bars' start times */
const OPEN = '09:30', CLOSE = '16:00';
const minutes = (/** @type {string} */ hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** `$self` (the traded symbol; a spread has none), `$underlying` (the stock; an option's underlying), or a symbol by name. @param {string} token @param {FeatureTrade} trade */
export function featureSymbol(token, trade) {
  const opt = trade.assetType === 'OPTION' ? parseSchwabOption(trade.symbol) : null;
  if (token === '$self') return trade.assetType === 'SPREAD' ? null : opt ? tradierSymbol(trade.symbol) : trade.symbol;
  if (token === '$underlying') return opt ? opt.root : trade.symbol;
  return token;
}

/** prices a split could leave between two series: the daily history and the day's own prices */
const SPLITS = [2, 3, 4, 5, 8, 10, 15, 20, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 8, 1 / 10, 1 / 15, 1 / 20];

/**
 * The context one trade's features read at one moment. `entryPrice` is the first fill's price for a stock (an option's
 * or spread's is no price on the stock). `now` decides what could still come: days the bar saver will still fetch
 * (inside BARS_KEEP_DAYS, or not finished yet).
 * @param {FeatureTrade} trade @param {number} at the moment, ms @param {FeatureData} data
 * @param {{ now: number, entryPrice?: number | null }} opts
 */
export function featureContext(trade, at, data, { now, entryPrice = null }) {
  const stamp = nyStamp(new Date(at).toISOString());
  const day = stamp.slice(0, 10), clock = stamp.slice(11, 16), clockMin = minutes(clock);
  const earliest = nyDay(now - BARS_KEEP_DAYS * DAY_MS), done = lastDoneDay(now);
  const couldCome = (/** @type {string} */ d) => d > done || d >= earliest;
  /** the feature being computed: what it waits on, what's gone, what it read */
  let cur = { waits: new Set(), gones: new Set(), reads: /** @type {FeatureRead[]} */ ([]) };
  /** @type {Map<string, any>} */
  const memo = new Map();
  const once = (/** @type {string} */ k, /** @type {() => any} */ fn) => { if (!memo.has(k)) memo.set(k, fn()); return memo.get(k); };
  /** a series' gaps count against every feature that reads it */
  const note = (/** @type {{ waits: string[], gones: string[] }} */ g) => { g.waits.forEach(w => cur.waits.add(w)); g.gones.forEach(w => cur.gones.add(w)); };
  const sym = (/** @type {string} */ token) => featureSymbol(token, trade);
  const md = (/** @type {string} */ d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

  /** a day's kept bars for a symbol, or why not: undefined = not kept */
  const dayBars = (/** @type {string} */ s, /** @type {string} */ d) => data.intraday.get(s)?.get(d);

  /** @param {string} s @param {string} session */
  function intradaySeries(s, session) {
    const regular = session === 'regular';
    const inSession = (/** @type {Candle} */ b) => !regular || ((b.time || '') >= OPEN && (b.time || '') < CLOSE);
    const kept = dayBars(s, day);
    const gaps = { waits: /** @type {string[]} */ ([]), gones: /** @type {string[]} */ ([]) };
    if (kept === undefined) (couldCome(day) ? gaps.waits : gaps.gones).push(`${s} 5-minute bars on ${md(day)}`);
    const all = (kept || []).filter(inSession);
    const bars = all.filter(b => minutes(b.time || '00:00') + 5 <= clockMin); // ended by the moment
    const now = all.find(b => { const m = minutes(b.time || '00:00'); return m <= clockMin && clockMin < m + 5; });
    const stub = now ? now.open : null; // the bar in progress: only its open is known
    const first = all.find(b => b.time === OPEN);
    const series = {
      symbol: s, missing: kept === undefined, bars,
      /** the last price known at the moment: the last ended bar's close, else the open of the one in progress */
      price: bars.length ? bars[bars.length - 1].close : stub,
      /** the regular open, once it's 9:30 */
      open: first && clock >= OPEN ? first.open : null,
      /** the high so far: ended bars, and the open of the one in progress */
      high: bars.length || stub !== null ? Math.max(...bars.map(b => b.high), ...(stub === null ? [] : [stub])) : null,
      /** the session VWAP over the ended bars (typical price × volume); null before any volume */
      vwap: () => {
        let pv = 0, v = 0;
        for (const b of bars) { const vol = b.volume || 0; pv += ((b.high + b.low + b.close) / 3) * vol; v += vol; }
        return v > 0 ? pv / v : null;
      },
      /** volume over the ended bars of the session */
      volumeSoFar: () => bars.reduce((n, b) => n + (b.volume || 0), 0),
      /**
       * the average volume to the same clock time over the `n` weekdays before (holidays skipped), or null with fewer
       * than half of them kept; a day the saver will still fetch makes the feature wait
       * @param {number} n
       */
      avgVolumeByTime: n => {
        cur.reads.push({ kind: 'intraday', symbol: s, session, lookback: n });
        const r = once(`avgvol|${s}|${session}|${n}`, () => {
          const g = { waits: /** @type {string[]} */ ([]), gones: /** @type {string[]} */ ([]) };
          const totals = [];
          for (const d of weekdaysBefore(day, n)) {
            const rows = dayBars(s, d);
            if (rows === undefined) { if (couldCome(d)) g.waits.push(`${s} 5-minute bars on ${md(d)}`); continue; }
            if (!rows.length) continue; // a holiday
            totals.push(rows.filter(b => inSession(b) && minutes(b.time || '00:00') + 5 <= clockMin).reduce((t, b) => t + (b.volume || 0), 0));
          }
          if (totals.length < Math.ceil(n / 2)) g.gones.push(`fewer than ${Math.ceil(n / 2)} of the ${n} sessions before`);
          return { gaps: g, value: totals.length >= Math.ceil(n / 2) ? totals.reduce((a, b) => a + b, 0) / totals.length : null };
        });
        note(r.gaps);
        return r.value;
      },
    };
    return { series, gaps };
  }

  /** @param {string} s @param {number} sessions */
  function dailySeries(s, sessions) {
    const rows = data.daily.get(s);
    const gaps = { waits: /** @type {string[]} */ ([]), gones: /** @type {string[]} */ ([]) };
    if (!rows) gaps.waits.push(`${s} daily bars`);
    else if (!rows.length) gaps.gones.push(`no daily history for ${s}`);
    const prior = (rows || []).filter(b => b.date < day);
    const bars = Number.isFinite(sessions) ? prior.slice(-sessions) : prior; // a fixed window, so an EMA never depends on how much was fetched
    const today = (rows || []).find(b => b.date === day);
    const k = (/** @type {number} */ n) => 2 / (n + 1);
    /** the EMA of the closes, seeded with the first `n` closes' average; null with fewer than `n` */
    const ema = (/** @type {number} */ n) => once(`ema|${s}|${sessions}|${n}`, () => {
      if (bars.length < n) return null;
      let e = bars.slice(0, n).reduce((a, b) => a + b.close, 0) / n;
      for (const b of bars.slice(n)) e = b.close * k(n) + e * (1 - k(n));
      return e;
    });
    const top = once(`high|${s}|${sessions}`, () => bars.reduce((m, b) => (b.high > m.high ? { high: b.high, date: b.date } : m), { high: -Infinity, date: '' }));
    const series = {
      symbol: s, missing: !rows, bars,
      /** the first day the history has (the listing, or where the provider's history starts) */
      first: rows && rows.length ? rows[0].date : null,
      prevClose: bars.length ? bars[bars.length - 1].close : null,
      /** the moment's day's regular open, once it's 9:30 */
      todayOpen: today && clock >= OPEN ? today.open : null,
      ema,
      /** the EMA moved on by one more close: today's price so far, so it never sees the day's close @param {number} n @param {number} price */
      emaWith: (n, price) => { const e = ema(n); return e === null ? null : price * k(n) + e * (1 - k(n)); },
      /** the highest prior high and its day */
      maxHigh: () => top.high === -Infinity ? null : top,
    };
    return { series, gaps };
  }

  const closed = trade.closedAt && Date.parse(trade.closedAt) <= at ? trade.closedAt : null;
  const ctx = {
    /** what's known about the trade at the moment: never its exit or result before then */
    trade: { symbol: trade.symbol, assetType: trade.assetType, openedAt: trade.openedAt, closedAt: closed },
    at, day, clock,
    /** a stock's first fill price; null for options and spreads */
    entryPrice: trade.assetType === 'OPTION' || trade.assetType === 'SPREAD' ? null : entryPrice,
    symbol: sym,
    /**
     * a symbol's 5-minute bars on the moment's day, cut off at the moment; null when the trade has no such symbol (a
     * spread's $self). Regular hours (09:30 to 16:00) by default, or 'all' for extended hours too.
     * @param {string} token @param {{ session?: 'regular' | 'all' }} [opts]
     */
    intraday(token, { session = 'regular' } = {}) {
      const s = sym(token);
      if (!s) { cur.gones.add(`no ${token.replace('$', '')} symbol for this trade`); return null; }
      cur.reads.push({ kind: 'intraday', symbol: s, session });
      const r = once(`in|${s}|${session}`, () => intradaySeries(s, session));
      note(r.gaps);
      return r.series;
    },
    /**
     * a symbol's daily bars before the moment's day: the last `sessions` of them, or all of them back to the listing
     * @param {string} token @param {number} [sessions]
     */
    daily(token, sessions = Infinity) {
      const s = sym(token);
      if (!s) { cur.gones.add(`no ${token.replace('$', '')} symbol for this trade`); return null; }
      cur.reads.push({ kind: 'daily', symbol: s, sessions });
      const r = once(`d|${s}|${sessions}`, () => dailySeries(s, sessions));
      note(r.gaps);
      return r.series;
    },
    /**
     * What turns a price from the day itself (a fill, a 5-minute bar) into the daily history's terms: 1 when they agree, a
     * split's ratio when the history was adjusted for a split since (or wasn't, and the day was after one), null when they
     * can't be lined up. Best: the day's own 9:30 open against the daily bar's open. Else `price` against that open, or
     * the day before's close, allowing for a day's move.
     * @param {string} token @param {number | null} price
     */
    dailyBasis(token, price) {
      const s = sym(token);
      if (!s) return null;
      const d = once(`d|${s}|${Infinity}`, () => dailySeries(s, Infinity)).series;
      const kept = dayBars(s, day), first = (kept || []).find(b => b.time === OPEN);
      if (first && d.todayOpen) {
        const ratio = d.todayOpen / first.open;
        return Math.abs(ratio - 1) <= 0.02 ? 1 : ratio;
      }
      const ref = d.todayOpen ?? d.prevClose;
      if (!ref || !price) return null;
      // the nearest of no split and the usual split ratios, allowing for the day's move (30%)
      const ratio = ref / price, off = (/** @type {number} */ x) => Math.abs(Math.log(ratio / x));
      const best = [1, ...SPLITS].reduce((a, b) => (off(b) < off(a) ? b : a));
      return off(best) <= Math.log(1.3) ? best : null;
    },
    /** start a feature: its own waits, gones and reads @returns {void} */
    begin() { cur = { waits: new Set(), gones: new Set(), reads: [] }; },
    /** what the feature just computed read and missed */
    report() { return { waits: [...cur.waits], gones: [...cur.gones], reads: cur.reads }; },
  };
  return ctx;
}

/** @typedef {ReturnType<typeof featureContext>} FeatureContext */
