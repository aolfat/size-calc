// @ts-check
// What a feature sees (docs/journal-features.md, part 2): one trade at one moment (its entry, or its exit), with the data
// cut off there, so no feature can look ahead. Intraday bars are the saved 5-minute ones: a bar counts once it has ended
// (it starts 09:40 and the moment is 09:45 or later); the bar the moment falls in shows only its open, which was known
// when it started. Daily bars are the days before the moment's day, plus that day's open once it's 9:30. The shared
// helpers (VWAP, volume so far, the volume by the same time on earlier days, EMAs, highs) are worked out once per trade
// and moment, whichever feature asks first. Every read notes what was missing: data that could still come (a day a
// provider still serves: inside Tradier's window, or a paid Massive plan's years; today's bars; daily bars not read yet)
// makes the feature wait; data gone for good makes it unknown. Every read is also recorded, so a test can check a feature only reads what its `needs` declare.
import { barsReach, lastDoneDay, nyDay, reachFor, weekdaysBefore } from '../bars.js';
import { BREADTH_HISTORY_DAYS } from '../breadth.js';
import { parseSchwabOption, tradierSymbol } from '../positions.js';
import { nyStamp } from '../trade-page.js';

/**
 * @typedef {{ date: string, time?: string, open: number, high: number, low: number, close: number, volume?: number }} Candle
 * @typedef {Record<string, [number, number] | boolean>} BreadthCounts one day's breadth: { '20': [above, counted], ... },
 *   or { closed: true } for a weekday the market was shut
 * @typedef {{ intraday: Map<string, Map<string, Candle[]>>, daily: Map<string, Candle[] | null>, breadth?: Map<string, BreadthCounts> | null }} FeatureData
 *   intraday: symbol → New York day → that day's 5-minute bars, oldest first ([] = kept empty, a holiday; a day not in
 *   the map wasn't kept). daily: symbol → daily bars, oldest first ([] = the provider has none; null or absent = not
 *   read, try again). breadth: New York day → that day's market breadth at the close (market_breadth; a day not in the
 *   map isn't worked out yet; null or absent = not read, try again).
 * @typedef {{ symbol: string, assetType: string, openedAt: string, closedAt: string | null }} FeatureTrade
 * @typedef {{ kind: 'intraday' | 'daily' | 'breadth', symbol: string, session?: string, sessions?: number, lookback?: number }} FeatureRead
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
 * or spread's is no price on the stock). `now` and `reach` decide what could still come: days not finished yet, and days
 * a provider still serves for that kind of symbol (core/bars.js barsReach; Tradier's window by default).
 * @param {FeatureTrade} trade @param {number} at the moment, ms @param {FeatureData} data
 * @param {{ now: number, entryPrice?: number | null, reach?: import('../bars.js').BarsReach }} opts
 */
export function featureContext(trade, at, data, { now, entryPrice = null, reach = barsReach(now) }) {
  const stamp = nyStamp(new Date(at).toISOString());
  const day = stamp.slice(0, 10), clock = stamp.slice(11, 16), clockMin = minutes(clock);
  const done = lastDoneDay(now);
  const couldCome = (/** @type {string} */ s, /** @type {string} */ d) => d > done || d >= reachFor(reach, s);
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
    if (kept === undefined) (couldCome(s, day) ? gaps.waits : gaps.gones).push(`${s} 5-minute bars on ${md(day)}`);
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
      /** the low so far, the same way */
      low: bars.length || stub !== null ? Math.min(...bars.map(b => b.low), ...(stub === null ? [] : [stub])) : null,
      /** the premarket's volume so far (4:00 to 9:30, ended bars); null on a regular-hours series, which has none */
      premarketVolume: () => regular ? null : bars.filter(b => (b.time || '') < OPEN).reduce((n, b) => n + (b.volume || 0), 0),
      /**
       * the `n` weekdays before, whole (they're over by the moment), in the series' hours: [{ day, bars }] oldest first,
       * holidays and days not kept left out. A day the saver will still fetch makes the feature wait; how many were
       * kept is the caller's to judge.
       * @param {number} n @returns {{ day: string, bars: Candle[] }[]}
       */
      priorSessions: n => {
        cur.reads.push({ kind: 'intraday', symbol: s, session, lookback: n });
        const r = once(`prior|${s}|${session}|${n}`, () => {
          const g = { waits: /** @type {string[]} */ ([]), gones: /** @type {string[]} */ ([]) };
          const out = [];
          for (const d of weekdaysBefore(day, n)) {
            const rows = dayBars(s, d);
            if (rows === undefined) { if (couldCome(s, d)) g.waits.push(`${s} 5-minute bars on ${md(d)}`); continue; }
            if (rows.length) out.push({ day: d, bars: rows.filter(inSession) });
          }
          return { gaps: g, value: out };
        });
        note(r.gaps);
        return r.value;
      },
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
            if (rows === undefined) { if (couldCome(s, d)) g.waits.push(`${s} 5-minute bars on ${md(d)}`); continue; }
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
    const lastN = (/** @type {number} */ n) => bars.length >= n ? bars.slice(-n) : null;
    const mean = (/** @type {number[]} */ xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
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
      /** the simple average of the last `n` closes; null with fewer @param {number} n */
      sma: n => { const b = lastN(n); return b ? mean(b.map(x => x.close)) : null; },
      /** the SMA moved on by today's price: the last n − 1 closes and it @param {number} n @param {number} price */
      smaWith: (n, price) => {
        if (n === 1) return price;
        const b = lastN(n - 1);
        return b ? (b.reduce((a, x) => a + x.close, 0) + price) / n : null;
      },
      /** the average daily range in dollars over the last `n` sessions (high − low) @param {number} n */
      adr: n => { const b = lastN(n); return b ? mean(b.map(x => x.high - x.low)) : null; },
      /** the same as a % of the low, averaged (high ÷ low − 1) @param {number} n */
      adrPct: n => { const b = lastN(n); return b && b.every(x => x.low > 0) ? mean(b.map(x => (x.high / x.low - 1) * 100)) : null; },
      /** Wilder's average true range over the window, seeded with the first `n` true ranges' average @param {number} n */
      atr: n => once(`atr|${s}|${sessions}|${n}`, () => {
        const tr = bars.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close)));
        if (tr.length < n) return null;
        let a = mean(tr.slice(0, n));
        for (const x of tr.slice(n)) a = (a * (n - 1) + x) / n;
        return a;
      }),
      /** annualized volatility of the last `n` daily log returns, as a % (HV20 = hv(20)) @param {number} n */
      hv: n => {
        const b = lastN(n + 1);
        if (!b || !b.every(x => x.close > 0)) return null;
        const r = b.slice(1).map((x, i) => Math.log(x.close / b[i].close)), m = mean(r);
        return Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1) * 252) * 100;
      },
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
    /** an option's first fill, the premium per share; null for anything else */
    optionFill: trade.assetType === 'OPTION' ? entryPrice : null,
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
    /**
     * The market's breadth at the last close before the moment's day: the % of US common stocks above their `n`-day
     * simple average, and how many were counted. Weekdays the market was shut are stepped over. A day not worked out
     * yet waits while it's within the provider's reach (BREADTH_HISTORY_DAYS, less the `n` sessions it needs before
     * it); older, it's unknown.
     * @param {number} n @returns {{ pct: number, counted: number, day: string } | null}
     */
    breadth(n) {
      cur.reads.push({ kind: 'breadth', symbol: 'US stocks', sessions: n });
      const rows = data.breadth;
      if (!rows) { cur.waits.add('market breadth'); return null; }
      const reach = nyDay(now - (BREADTH_HISTORY_DAYS - Math.ceil(n * 7 / 5) - 10) * DAY_MS);
      for (const d of weekdaysBefore(day, 10).reverse()) {
        const row = rows.get(d);
        if (!row) { (d >= reach ? cur.waits : cur.gones).add(d >= reach ? `market breadth on ${md(d)}` : `market breadth from before ${md(reach)}`); return null; }
        if (row.closed) continue;
        const c = row[String(n)];
        if (!Array.isArray(c) || !(c[1] > 0)) { (d >= reach ? cur.waits : cur.gones).add(`${n}-day breadth on ${md(d)}`); return null; }
        return { pct: c[0] / c[1] * 100, counted: c[1], day: d };
      }
      cur.gones.add('no session in the 10 weekdays before');
      return null;
    },
    /** say why the feature can't be known, for good (the stamped note when it answers null) @param {string} why @returns {void} */
    unknown(why) { cur.gones.add(why); },
    /** start a feature: its own waits, gones and reads @returns {void} */
    begin() { cur = { waits: new Set(), gones: new Set(), reads: [] }; },
    /** what the feature just computed read and missed */
    report() { return { waits: [...cur.waits], gones: [...cur.gones], reads: cur.reads }; },
  };
  return ctx;
}

/** @typedef {ReturnType<typeof featureContext>} FeatureContext */
