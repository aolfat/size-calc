// @ts-check
// Journal trades, pure: kept fills grouped into trades (flat back to flat, first in first out, scale-ins, partial exits,
// flips, ×100 for options), each with P&L, hold time, its initial stop and R. Trades are computed every time from the kept
// fills, never stored (docs/journal-step-2.md). Schwab's orders carry no fees, so P&L here is before fees.
import { schwabTime } from './positions.js';

const EPS = 1e-9;
const DAY = 86400000;
/** a stop entered this long before the first fill still counts as the trade's: a trigger's stop is entered with its entry */
export const STOP_LEAD_MS = 5 * 60000;

/** @param {string} assetType */
export const multiplierOf = assetType => assetType === 'OPTION' ? 100 : 1;

/**
 * @typedef {{ id: string, orderId: string, account?: string, time: string, symbol: string, label: string, assetType: string,
 *   instruction: string, side: 'buy' | 'sell', qty: number, price: number }} Fill
 * @typedef {{ orderId: string, rootId: string, account: string, symbol: string, instruction: string, stopPrice: number, entered: string, status: string }} StopOrder
 * @typedef {{ key: string, account: string, symbol: string, label: string, assetType: string, multiplier: number,
 *   direction: 'long' | 'short', openedAt: string, closedAt: string | null, entryQty: number, openQty: number,
 *   avgEntry: number, avgExit: number | null, pnl: number, exits: number, fillIds: string[], entryOrderIds: string[], holdMs: number | null,
 *   status: 'open' | 'win' | 'loss' | 'breakeven', stop: number | null, stopOrderId: string, risk: number | null,
 *   rBasis: 'stop' | 'premium' | null, r: number | null }} Trade
 */

/**
 * a trade being built: its open lots, first in first out
 * @param {Fill} fill @param {string} account @param {'long' | 'short'} direction
 */
function startTrade(fill, account, direction) {
  return {
    key: `${account}|${fill.symbol}|${direction}|${fill.time}`,
    account, symbol: fill.symbol, label: fill.label || fill.symbol, assetType: fill.assetType, multiplier: multiplierOf(fill.assetType),
    direction, openedAt: fill.time, closedAt: /** @type {string | null} */ (null), entryQty: 0, entryNotional: 0, exitQty: 0, exitNotional: 0,
    pnl: 0, exits: 0, fillIds: [], entryOrderIds: /** @type {string[]} */ ([]), lots: /** @type {{ qty: number, price: number }[]} */ ([]),
  };
}

/** @param {ReturnType<typeof startTrade>} t @returns {Trade} */
function finish(t) {
  const openQty = t.lots.reduce((/** @type {number} */ n, l) => n + l.qty, 0);
  const closed = openQty <= EPS;
  const pnl = Math.round(t.pnl * 100) / 100;
  return {
    key: t.key, account: t.account, symbol: t.symbol, label: t.label, assetType: t.assetType, multiplier: t.multiplier,
    direction: t.direction, openedAt: t.openedAt, closedAt: closed ? t.closedAt : null,
    entryQty: t.entryQty, openQty: closed ? 0 : openQty,
    avgEntry: t.entryQty ? t.entryNotional / t.entryQty : 0,
    avgExit: t.exitQty ? t.exitNotional / t.exitQty : null,
    pnl, exits: t.exits, fillIds: t.fillIds, entryOrderIds: t.entryOrderIds,
    holdMs: closed && t.closedAt ? Date.parse(t.closedAt) - Date.parse(t.openedAt) : null,
    status: !closed ? 'open' : pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven',
    stop: null, stopOrderId: '', risk: null, rBasis: null, r: null,
  };
}

/**
 * Fills → trades, per account and symbol (an option's symbol is its contract), in time order. A fill that takes the
 * position through zero closes the trade and opens the next one in the other direction with what's left (a flip).
 * @param {Fill[]} fills
 * @returns {Trade[]}
 */
export function buildTrades(fills) {
  /** @type {Map<string, Fill[]>} */
  const groups = new Map();
  for (const f of fills) {
    if (!f.symbol || !(f.qty > 0) || !(f.price > 0) || !f.time) continue;
    const k = `${f.account || ''}|${f.symbol}`;
    if (!groups.has(k)) groups.set(k, []);
    /** @type {Fill[]} */ (groups.get(k)).push(f);
  }
  /** @type {Trade[]} */
  const trades = [];
  for (const list of groups.values()) {
    list.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.id < b.id ? -1 : 1));
    /** @type {any} */
    let t = null;
    for (const f of list) {
      const account = f.account || '';
      let qty = f.qty;
      const buying = f.side === 'buy';
      if (!t) t = startTrade(f, account, buying ? 'long' : 'short');
      const adds = (t.direction === 'long') === buying;
      t.fillIds.push(f.id);
      if (adds) {
        t.lots.push({ qty, price: f.price });
        t.entryQty += qty;
        t.entryNotional += qty * f.price;
        if (!t.entryOrderIds.includes(f.orderId)) t.entryOrderIds.push(f.orderId);
        continue;
      }
      // reducing: match the oldest lots first
      t.exits++;
      const sign = t.direction === 'long' ? 1 : -1;
      while (qty > EPS && t.lots.length) {
        const lot = t.lots[0];
        const take = Math.min(lot.qty, qty);
        t.pnl += (f.price - lot.price) * take * sign * t.multiplier;
        t.exitQty += take;
        t.exitNotional += take * f.price;
        lot.qty -= take;
        qty -= take;
        if (lot.qty <= EPS) t.lots.shift();
      }
      if (!t.lots.length) {
        t.closedAt = f.time;
        trades.push(finish(t));
        t = null;
        if (qty > EPS) { // a flip: what's left opens the other way
          t = startTrade(f, account, buying ? 'long' : 'short');
          t.fillIds.push(f.id);
          t.lots.push({ qty, price: f.price });
          t.entryQty += qty;
          t.entryNotional += qty * f.price;
          t.entryOrderIds.push(f.orderId);
        }
      }
    }
    if (t) trades.push(finish(t));
  }
  return trades;
}

const CLOSES = { long: /^(SELL|SELL_TO_CLOSE)$/, short: /^(BUY|BUY_TO_COVER|BUY_TO_CLOSE)$/ };

/**
 * Every stop order in the kept orders, children of triggers and one-cancels-other pairs included, whatever happened to it
 * (a stop that was replaced or canceled still says where you first put it). A child without its own entered time takes
 * its parent's: the stop of a trigger goes in with its entry. rootId is the top order, a trigger's entry.
 * @param {{ kind: string, account?: string, data: any }[]} records
 * @returns {StopOrder[]}
 */
export function stopOrdersFrom(records) {
  /** @type {StopOrder[]} */
  const out = [];
  const walk = (/** @type {any} */ o, /** @type {string} */ account, /** @type {string} */ parentEntered, /** @type {string} */ rootId) => {
    if (!o || typeof o !== 'object') return;
    const enteredRaw = o.enteredTime || parentEntered;
    const stopPrice = Number(o.stopPrice);
    if (/^(STOP|STOP_LIMIT|TRAILING_STOP|TRAILING_STOP_LIMIT)$/.test(o.orderType || '') && stopPrice > 0) {
      const leg = (o.orderLegCollection || [])[0] || {};
      const ms = schwabTime(enteredRaw);
      out.push({
        orderId: String(o.orderId ?? ''), rootId, account, symbol: leg.instrument?.symbol || '', instruction: leg.instruction || '',
        stopPrice, entered: Number.isFinite(ms) ? new Date(ms).toISOString() : '', status: o.status || '',
      });
    }
    (o.childOrderStrategies || []).forEach((/** @type {any} */ c) => walk(c, account, enteredRaw, rootId));
  };
  for (const r of records) if (r.kind === 'order') walk(r.data, r.account || '', '', String(r.data?.orderId ?? ''));
  return out;
}

/**
 * The trade's initial stop and R. The stop is the first stop order that closes this position, entered from just before
 * the first fill until the trade closed (or attached to an order that opened it, whenever that was entered: a resting
 * entry's stop goes in with it, hours before the fill), on the loss side of the entry (a stop above a long's entry protects profit, it
 * isn't the risk). R = P&L ÷ risk, risk = |entry − stop| × quantity × multiplier. A long option with no stop risks its
 * premium. Open trades get their stop and risk, but no R yet.
 * @param {Trade} trade @param {StopOrder[]} stops
 * @returns {Trade}
 */
export function withRisk(trade, stops) {
  const opened = Date.parse(trade.openedAt);
  const until = trade.closedAt ? Date.parse(trade.closedAt) : Infinity;
  const lossSide = (/** @type {number} */ p) => trade.direction === 'long' ? p < trade.avgEntry : p > trade.avgEntry;
  const first = stops
    .filter(s => s.account === trade.account && s.symbol === trade.symbol && CLOSES[trade.direction].test(s.instruction) && lossSide(s.stopPrice))
    .filter(s => trade.entryOrderIds.includes(s.rootId) || (t => t >= opened - STOP_LEAD_MS && t <= until)(Date.parse(s.entered)))
    .sort((a, b) => (a.entered < b.entered ? -1 : a.entered > b.entered ? 1 : 0))[0];
  let risk = null, rBasis = /** @type {Trade['rBasis']} */ (null);
  if (first) {
    risk = Math.abs(trade.avgEntry - first.stopPrice) * trade.entryQty * trade.multiplier;
    rBasis = 'stop';
  } else if (trade.assetType === 'OPTION' && trade.direction === 'long') {
    risk = trade.avgEntry * trade.entryQty * trade.multiplier;
    rBasis = 'premium';
  }
  const r = risk && risk > EPS && trade.status !== 'open' ? Math.round((trade.pnl / risk) * 100) / 100 : null;
  return { ...trade, stop: first ? first.stopPrice : null, stopOrderId: first ? first.orderId : '', risk: risk ? Math.round(risk * 100) / 100 : null, rBasis, r };
}

/**
 * The journal's trades from its kept records: fills grouped, each given its stop and R, newest first (by when it
 * closed, or opened if it's still open).
 * @param {Fill[]} fills @param {{ kind: string, account?: string, data: any }[]} records
 */
export function journalTrades(fills, records) {
  const stops = stopOrdersFrom(records);
  return buildTrades(fills).map(t => withRisk(t, stops))
    .sort((a, b) => { const ka = a.closedAt || a.openedAt, kb = b.closedAt || b.openedAt; return ka < kb ? 1 : ka > kb ? -1 : 0; });
}

/** closed trades in numbers: count, wins, losses, win rate, P&L, average R (over trades that have one). @param {Trade[]} trades */
export function tradesSummary(trades) {
  const closed = trades.filter(t => t.status !== 'open');
  const wins = closed.filter(t => t.status === 'win').length;
  const losses = closed.filter(t => t.status === 'loss').length;
  const rs = closed.map(t => t.r).filter(r => r !== null);
  return {
    closed: closed.length, open: trades.length - closed.length, wins, losses,
    winRate: closed.length ? Math.round((wins / closed.length) * 1000) / 10 : null,
    pnl: Math.round(closed.reduce((n, t) => n + t.pnl, 0) * 100) / 100,
    avgR: rs.length ? Math.round((rs.reduce((n, r) => n + /** @type {number} */ (r), 0) / rs.length) * 100) / 100 : null,
    withR: rs.length,
  };
}

/** '45m', '3h 10m', '2d 4h'. @param {number | null} ms */
export function holdWords(ms) {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  if (ms < DAY) return `${Math.floor(m / 60)}h ${m % 60}m`;
  const d = Math.floor(ms / DAY);
  return `${d}d ${Math.floor((ms - d * DAY) / 3600000)}h`;
}

