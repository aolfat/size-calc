// @ts-check
// Futures sizing: risk per tick between entry and stop, and the live quote (Schwab's) that can fill them.
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

/** a price on the contract's tick grid (the nearest tick), without binary float dust @param {number} price @param {number} tickSize */
export function onTick(price, tickSize) {
  return Number((Math.round(price / tickSize) * tickSize).toFixed(10));
}

/**
 * @typedef {{ root: string, contract: string, last: number | null, bid: number | null, ask: number | null, high: number | null,
 *   low: number | null, close: number | null, change: number | null, changePct: number | null, realtime: boolean | null,
 *   time: number | null, specMismatch: { tick: number, tickAmount: number } | null }} FuturesQuote
 */

/**
 * One root's quote from Schwab's /marketdata/v1/quotes answer (requested as '/MES', which Schwab answers with the active
 * contract): its prices, or null when it isn't there, isn't that root's, or has no price. A zero price is no price;
 * a crossed bid and ask is no market. specMismatch is Schwab's tick when it disagrees with FUTURES_CONTRACTS.
 * @param {any} body @param {string} root
 * @returns {FuturesQuote | null}
 */
export function parseFuturesQuote(body, root) {
  const key = '/' + root;
  if (!body || typeof body !== 'object') return null;
  const entry = body[key] ?? Object.values(body).find(e => e?.reference?.product === key);
  if (!entry || typeof entry !== 'object') return null;
  const q = entry.quote || {}, ref = entry.reference || {};
  const contract = String(ref.futureActiveSymbol || entry.symbol || '').trim().toUpperCase();
  if (contract !== key && futuresSpec(contract)?.root !== root) return null;
  /** @param {unknown} v */
  const price = v => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : null);
  let bid = price(q.bidPrice), ask = price(q.askPrice);
  if (bid !== null && ask !== null && bid > ask) bid = ask = null;
  const last = price(q.lastPrice) ?? price(q.mark);
  if (last === null && bid === null && ask === null) return null;
  const close = price(q.closePrice);
  const change = last !== null && close !== null ? last - close : null;
  const spec = FUTURES_CONTRACTS[root];
  const tick = price(q.tick), tickAmount = price(q.tickAmount);
  const mismatch = !!spec && tick !== null && tickAmount !== null
    && (Math.abs(tick - spec.tickSize) > 1e-9 || Math.abs(tickAmount - spec.tickValue) > 1e-9);
  const time = [q.tradeTime, q.quoteTime].find(t => typeof t === 'number' && Number.isFinite(t) && t > 0);
  return {
    root, contract, last, bid, ask, high: price(q.highPrice), low: price(q.lowPrice), close,
    change, changePct: change !== null && close !== null ? change / close * 100 : null,
    realtime: typeof entry.realtime === 'boolean' ? entry.realtime : null,
    time: time ?? null,
    specMismatch: mismatch ? { tick: /** @type {number} */ (tick), tickAmount: /** @type {number} */ (tickAmount) } : null,
  };
}

/** where a market entry fills: the ask for a long, the bid for a short, else the last trade @param {FuturesQuote} q @param {string} direction */
export function futuresEntryFrom(q, direction) {
  return (direction === 'short' ? q.bid : q.ask) ?? q.last;
}

/** the default stop: the session low under a long, the high over a short @param {FuturesQuote} q @param {string} direction */
export function futuresStopFrom(q, direction) {
  return direction === 'short' ? q.high : q.low;
}
