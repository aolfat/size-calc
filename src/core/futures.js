// @ts-check
// Futures sizing: risk per tick between entry and stop, and the live quote (Schwab's) that can fill them.
import { wallClock } from './format.js';
import { unitsFor } from './sizing.js';

// Outright contract specs (CME, checked September 2026):
// https://www.cmegroup.com/trading/equity-index/files/cme-micro-e-mini-futures-fact-card.pdf
// https://www.cmegroup.com/education/modules/files/EQ240_EQ_for_AIT.pdf
// https://www.cmegroup.com/education/courses/futures-vs-etfs/reasons-to-trade-e-mini-russell-2000-futures-over-russell-2000-etf
// https://www.cmegroup.com/education/articles-and-reports/micro-wti-crude-oil-futures-faq
// https://www.cmegroup.com/education/lessons/micro-gold-and-micro-silver-futures-product-overview
// https://www.cmegroup.com/trading/metals/files/fact-card-gold-futures-options.pdf

/** @type {Record<string, { name: string, tickSize: number, tickValue: number }>} */
export const FUTURES_CONTRACTS = {
  MES: { name: 'Micro E-mini S&P 500', tickSize: 0.25, tickValue: 1.25 },
  ES:  { name: 'E-mini S&P 500', tickSize: 0.25, tickValue: 12.5 },
  MNQ: { name: 'Micro E-mini Nasdaq-100', tickSize: 0.25, tickValue: 0.5 },
  NQ:  { name: 'E-mini Nasdaq-100', tickSize: 0.25, tickValue: 5 },
  MYM: { name: 'Micro E-mini Dow', tickSize: 1, tickValue: 0.5 },
  YM:  { name: 'E-mini Dow', tickSize: 1, tickValue: 5 },
  M2K: { name: 'Micro E-mini Russell 2000', tickSize: 0.1, tickValue: 0.5 },
  RTY: { name: 'E-mini Russell 2000', tickSize: 0.1, tickValue: 5 },
  MCL: { name: 'Micro WTI Crude Oil', tickSize: 0.01, tickValue: 1 },
  CL:  { name: 'WTI Crude Oil', tickSize: 0.01, tickValue: 10 },
  MGC: { name: 'Micro Gold', tickSize: 0.1, tickValue: 1 },
  GC:  { name: 'Gold', tickSize: 0.1, tickValue: 10 }
};

/**
 * Contracts that fit the risk budget between entry and stop, on whole ticks.
 * @param {{ risk: number, entry: number, stop: number, direction: string, tickSize: number, tickValue: number, fees?: number }} input
 * @returns {{ error: string } | { ticks: number, points: number, riskPerContract: number, contracts: number, totalRisk: number }}
 */
export function calcFutures({ risk, entry, stop, direction, tickSize, tickValue, fees = 0 }) {
  if (![tickSize, tickValue].every(v => Number.isFinite(v) && v > 0)) return { error: 'Enter a positive tick size and dollar tick value.' };
  if (![entry, stop].every(Number.isFinite)) return { error: 'Enter your futures entry and stop prices.' };
  if (!Number.isFinite(risk) || risk < 0) return { error: 'Enter a valid risk budget of zero or more.' };
  if (!Number.isFinite(fees) || fees < 0) return { error: 'Fees must be zero or more.' };
  if (direction !== 'long' && direction !== 'short') return { error: 'Choose Long or Short.' };
  if ((direction === 'long' ? entry - stop : stop - entry) <= 0) {
    return { error: `Stop must be ${direction === 'long' ? 'below' : 'above'} entry for a ${direction}.` };
  }
  const entryTicks = entry / tickSize, stopTicks = stop / tickSize;
  // Check both prices, not just their distance. Tolerance only absorbs binary float noise.
  if ([entryTicks, stopTicks].some(v => !Number.isSafeInteger(Math.round(v)) || Math.abs(v - Math.round(v)) > 1e-7)) {
    return { error: `Entry and stop must use ${tickSize}-point tick increments.` };
  }
  const ticks = Math.abs(Math.round(entryTicks) - Math.round(stopTicks));
  const riskPerContract = ticks * tickValue + fees;
  const contracts = unitsFor(risk, riskPerContract);
  if (!Number.isSafeInteger(ticks) || ticks < 1 || !Number.isFinite(riskPerContract) || !(riskPerContract > 0) || !Number.isSafeInteger(contracts)) {
    return { error: 'These values are outside the supported sizing range.' };
  }
  return { ticks, points: ticks * tickSize, riskPerContract, contracts, totalRisk: contracts * riskPerContract };
}

const MONTHS = { F: 'Jan', G: 'Feb', H: 'Mar', J: 'Apr', K: 'May', M: 'Jun', N: 'Jul', Q: 'Aug', U: 'Sep', V: 'Oct', X: 'Nov', Z: 'Dec' };

/**
 * A futures contract from Schwab's symbol ('/MNQZ26', '/ESH6', an exchange suffix like ':XCME' allowed): its root, month,
 * year and dollars per point (tick value ÷ tick size), or null for a root FUTURES_CONTRACTS doesn't know.
 * @param {string} symbol
 * @returns {{ root: string, name: string, month: string, year: number, pointValue: number } | null}
 */
export function futuresSpec(symbol) {
  const m = /^\/([A-Z0-9]{1,4})([FGHJKMNQUVXZ])(\d{1,2})(?::[A-Z]+)?$/.exec(String(symbol || '').trim().toUpperCase());
  const spec = m && FUTURES_CONTRACTS[m[1]];
  if (!m || !spec) return null;
  const yy = Number(m[3]);
  return {
    root: m[1], name: spec.name, month: MONTHS[/** @type {keyof typeof MONTHS} */ (m[2])],
    year: m[3].length === 2 ? 2000 + yy : 2020 + yy,
    pointValue: Math.round(spec.tickValue / spec.tickSize * 1e6) / 1e6,
  };
}

/**
 * A futures ticker as typed in the ticker box: a root ('/MES', the active contract) or one month ('/MESZ26'), for a root
 * FUTURES_CONTRACTS knows. Null for anything else, a stock ticker included.
 * @param {string} text
 * @returns {{ symbol: string, root: string, month: boolean } | null}
 */
export function futuresSymbol(text) {
  const s = String(text || '').trim().toUpperCase();
  if (!s.startsWith('/')) return null;
  if (/^\/[A-Z0-9]{1,4}$/.test(s) && Object.hasOwn(FUTURES_CONTRACTS, s.slice(1))) return { symbol: s, root: s.slice(1), month: false };
  const spec = futuresSpec(s);
  return spec ? { symbol: s, root: spec.root, month: true } : null;
}

/** a price on the contract's tick grid (the nearest tick), without binary float dust @param {number} price @param {number} tickSize */
export function onTick(price, tickSize) {
  return Number((Math.round(price / tickSize) * tickSize).toFixed(10));
}

/**
 * The app's quote for a futures ticker (the fields the quote bar and sizing read, as a Tradier quote names them, plus
 * the futures ones): symbol is what was asked for ('/MES'), contract the month it is ('/MESZ26').
 * @typedef {{ symbol: string, type: 'future', root: string, contract: string, description: string, last: number | null,
 *   bid: number | null, ask: number | null, high: number | null, low: number | null, prevclose: number | null,
 *   change: number | null, change_percentage: number | null, volume: number, realtime: boolean | null, time: number | null,
 *   tickSize: number, tickValue: number, specMismatch: { tick: number, tickAmount: number } | null }} FuturesQuote
 */

/**
 * One futures ticker's quote from Schwab's /marketdata/v1/quotes answer ('/MES' answers with the active contract, a
 * month answers as itself): its prices, or null when it isn't there, isn't that root's, or has no price. A zero price is
 * no price; a crossed bid and ask is no market. specMismatch is Schwab's tick when it disagrees with FUTURES_CONTRACTS.
 * @param {any} body @param {string} symbol
 * @returns {FuturesQuote | null}
 */
export function parseFuturesQuote(body, symbol) {
  const asked = futuresSymbol(symbol);
  if (!asked || !body || typeof body !== 'object') return null;
  const entry = body[asked.symbol] ?? Object.values(body).find(e => !asked.month && e?.reference?.product === asked.symbol);
  if (!entry || typeof entry !== 'object') return null;
  const q = entry.quote || {}, ref = entry.reference || {};
  const contract = asked.month ? asked.symbol : String(ref.futureActiveSymbol || entry.symbol || '').trim().toUpperCase();
  if (contract !== asked.symbol && futuresSpec(contract)?.root !== asked.root) return null;
  if (asked.month && String(entry.symbol || asked.symbol).toUpperCase() !== asked.symbol) return null;
  /** @param {unknown} v */
  const price = v => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : null);
  let bid = price(q.bidPrice), ask = price(q.askPrice);
  if (bid !== null && ask !== null && bid > ask) bid = ask = null;
  const last = price(q.lastPrice) ?? price(q.mark);
  if (last === null && bid === null && ask === null) return null;
  const close = price(q.closePrice);
  const change = last !== null && close !== null ? last - close : null;
  const spec = FUTURES_CONTRACTS[asked.root];
  const tick = price(q.tick), tickAmount = price(q.tickAmount);
  const mismatch = tick !== null && tickAmount !== null
    && (Math.abs(tick - spec.tickSize) > 1e-9 || Math.abs(tickAmount - spec.tickValue) > 1e-9);
  const time = [q.tradeTime, q.quoteTime].find(t => typeof t === 'number' && Number.isFinite(t) && t > 0);
  return {
    symbol: asked.symbol, type: 'future', root: asked.root, contract, description: spec.name,
    last, bid, ask, high: price(q.highPrice), low: price(q.lowPrice), prevclose: close,
    change, change_percentage: change !== null && close !== null ? change / close * 100 : null,
    volume: typeof q.totalVolume === 'number' && Number.isFinite(q.totalVolume) ? q.totalVolume : 0,
    realtime: typeof entry.realtime === 'boolean' ? entry.realtime : null,
    time: time ?? null, tickSize: spec.tickSize, tickValue: spec.tickValue,
    specMismatch: mismatch ? { tick: /** @type {number} */ (tick), tickAmount: /** @type {number} */ (tickAmount) } : null,
  };
}

/**
 * The trading day a futures moment belongs to, and its New York clock: CME's day opens at 18:00 New York the evening
 * before (Sunday's evening is Monday's), so a bar from 18:00 on carries the next day's date.
 * @param {number} ms
 */
export function futuresSessionClock(ms) {
  const { day, time } = wallClock(ms, 'America/New_York');
  if (time < '18:00') return { day, time };
  const next = new Date(Date.parse(day + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
  return { day: next, time };
}

/**
 * Schwab's price history candles ({ open, high, low, close, volume, datetime ms }) as the chart's bars: t is the trading
 * day and the New York clock of the bar's start ('2026-10-27T18:05:00' is 18:05 on Monday evening, Tuesday's session),
 * ts its start in seconds, oldest first; broken candles are dropped.
 * @param {any} body
 * @returns {{ t: string, ts: number, o: number, h: number, l: number, c: number, v: number }[]}
 */
export function futuresBars(body) {
  /** @type {any[]} */
  const candles = Array.isArray(body?.candles) ? body.candles : [];
  return candles
    .filter(c => [c?.open, c?.high, c?.low, c?.close, c?.datetime].every(v => typeof v === 'number' && Number.isFinite(v)) && c.high >= c.low)
    .sort((a, b) => a.datetime - b.datetime)
    .map(c => {
      const { day, time } = futuresSessionClock(c.datetime);
      return { t: `${day}T${time}:00`, ts: Math.floor(c.datetime / 1000), o: c.open, h: c.high, l: c.low, c: c.close, v: +c.volume || 0 };
    });
}

/**
 * Schwab's daily candles as the daily chart's days ({ date, open, high, low, close, volume }, oldest first), dated by
 * trading day whichever hour Schwab stamps them with.
 * @param {any} body
 * @returns {{ date: string, open: number, high: number, low: number, close: number, volume: number }[]}
 */
export function futuresDays(body) {
  const seen = new Set();
  return futuresBars(body).map(b => ({ date: b.t.slice(0, 10), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }))
    .filter(d => !seen.has(d.date) && seen.add(d.date));
}

/**
 * Contracts for a futures plan, from the entry and stop the ticket resolved (LOD, a buffer, a chart click: any price):
 * the entry goes to the nearest tick and the stop to the tick past it, away from the entry, so the risk counted is
 * never less than the stop's. Answers calcFutures' result with the prices it used.
 * @param {{ risk: number, entry: number, stop: number, direction: string, root: string, fees?: number }} input
 */
export function futuresPlan({ risk, entry, stop, direction, root, fees = 0 }) {
  const spec = FUTURES_CONTRACTS[root];
  if (!spec) return { error: 'Not a futures contract this app knows.' };
  if (![entry, stop].every(Number.isFinite)) return { error: 'No valid stop price. Check the LOD / HOD, or enter a stop.' };
  const t = spec.tickSize;
  const e = onTick(entry, t);
  const away = direction === 'short' ? Math.ceil(stop / t - 1e-9) : Math.floor(stop / t + 1e-9);
  const s = Number((away * t).toFixed(10));
  const result = calcFutures({ risk, entry: e, stop: s, direction, tickSize: t, tickValue: spec.tickValue, fees });
  return { ...result, entry: e, stop: s, tickSize: t, tickValue: spec.tickValue, pointValue: spec.tickValue / t };
}

/** a quote the futures path loaded (parseFuturesQuote), not a stock's @param {any} q */
export const isFuturesQuote = q => q?.type === 'future';

/** how a chart labels its prices: a futures quote's on its tick's decimals, anything else in dollars @param {any} q */
export function priceLabeler(q) {
  return isFuturesQuote(q) ? (/** @type {number} */ v) => fmtTicks(v, q.tickSize) : (/** @type {number} */ v) => '$' + v.toFixed(2);
}

/** a futures price with the decimals its tick has ('6,012.25', '21,000.00', '44,210') @param {number} v @param {number} tickSize */
export function fmtTicks(v, tickSize) {
  const d = Math.min(6, (String(tickSize).split('.')[1] || '').length);
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
