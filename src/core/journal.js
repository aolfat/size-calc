// @ts-check
// Journal trades, pure: kept fills grouped into trades (flat back to flat, first in first out, scale-ins, partial exits,
// flips, ×100 for options), each with P&L, hold time, its initial stop and R. Trades are computed every time from the kept
// fills, never stored (docs/journal-step-2.md). Schwab's orders carry no fees, so P&L here is before fees. Your own word on
// a trade (trade_reviews, keyed by the trade key) overrides its stop and can hide it.
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
 *   rBasis: 'stop' | 'premium' | null, r: number | null, stopSource: 'yours' | 'schwab' | null, schwabStop: number | null,
 *   stopTrail: StopOrder[], movedTo: number | null, ownStopIgnored: boolean, hidden: boolean }} Trade
 * @typedef {{ stop?: number | null, hidden?: boolean }} TradeReview
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
    stopSource: null, schwabStop: null, stopTrail: [], movedTo: null, ownStopIgnored: false, hidden: false,
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

/** the dollars at risk from the average entry to a stop, for the whole entry. @param {Trade} trade @param {number} stop */
export const riskAt = (trade, stop) => Math.abs(trade.avgEntry - stop) * trade.entryQty * trade.multiplier;

/** a stop on the loss side of the trade's average entry: below a long's, above a short's. @param {Trade} trade @param {number} p */
const lossSide = (trade, p) => trade.direction === 'long' ? p < trade.avgEntry : p > trade.avgEntry;

/**
 * Why a stop you type can't be this trade's, or '' when it can: a price, on the loss side of the average entry.
 * @param {Trade} trade @param {number} price
 */
export function ownStopError(trade, price) {
  if (!Number.isFinite(price) || price <= 0) return 'Type a stop price.';
  if (!lossSide(trade, price)) return `A ${trade.direction}'s stop goes ${trade.direction === 'long' ? 'below' : 'above'} the entry.`;
  return '';
}

/**
 * The trade's initial stop and R. Your own stop wins when you've set one (an option's mental stop, or a correction).
 * Otherwise it's the first stop order that closes this position, entered from just before the first fill until the
 * trade closed (or attached to an order that opened it, whenever that was entered: a resting entry's stop goes in with
 * it, hours before the fill), on the loss side of the entry (a stop above a long's entry protects profit, it isn't the
 * risk). A moved stop doesn't change R: it's measured against the risk at entry, and the trail of stops shows the moves.
 * R = P&L ÷ risk, risk = |entry − stop| × quantity × multiplier. A long option with no stop risks its premium. Open
 * trades get their stop and risk, but no R yet.
 * @param {Trade} trade @param {StopOrder[]} stops @param {number | null} [ownStop]
 * @returns {Trade}
 */
export function withRisk(trade, stops, ownStop = null) {
  const opened = Date.parse(trade.openedAt);
  const until = trade.closedAt ? Date.parse(trade.closedAt) : Infinity;
  const trail = stops
    .filter(s => s.account === trade.account && s.symbol === trade.symbol && CLOSES[trade.direction].test(s.instruction))
    .filter(s => trade.entryOrderIds.includes(s.rootId) || (t => t >= opened - STOP_LEAD_MS && t <= until)(Date.parse(s.entered)))
    .sort((a, b) => (a.entered < b.entered ? -1 : a.entered > b.entered ? 1 : 0));
  const first = trail.find(s => lossSide(trade, s.stopPrice));
  const last = trail[trail.length - 1];
  const own = ownStop !== null && ownStop !== undefined && !ownStopError(trade, ownStop) ? ownStop : null;
  const stop = own ?? (first ? first.stopPrice : null);
  let risk = null, rBasis = /** @type {Trade['rBasis']} */ (null);
  if (stop !== null) {
    risk = riskAt(trade, stop);
    rBasis = 'stop';
  } else if (trade.assetType === 'OPTION' && trade.direction === 'long') {
    risk = trade.avgEntry * trade.entryQty * trade.multiplier;
    rBasis = 'premium';
  }
  const r = risk && risk > EPS && trade.status !== 'open' ? Math.round((trade.pnl / risk) * 100) / 100 : null;
  return {
    ...trade, stop, stopOrderId: own === null && first ? first.orderId : '', risk: risk ? Math.round(risk * 100) / 100 : null, rBasis, r,
    stopSource: own !== null ? 'yours' : first ? 'schwab' : null, schwabStop: first ? first.stopPrice : null,
    stopTrail: trail, movedTo: first && last && last !== first && last.stopPrice !== first.stopPrice ? last.stopPrice : null,
    ownStopIgnored: ownStop !== null && ownStop !== undefined && own === null,
  };
}

/**
 * The journal's trades from its kept records: fills grouped, each given its stop and R (your stop first) and your
 * hidden flag, newest first (by when it closed, or opened if it's still open). Hidden trades stay in the list, flagged:
 * their fills still group with the rest, and the view decides whether to show them.
 * @param {Fill[]} fills @param {{ kind: string, account?: string, data: any }[]} records
 * @param {Record<string, TradeReview>} [reviews]
 */
export function journalTrades(fills, records, reviews = {}) {
  const stops = stopOrdersFrom(records);
  return buildTrades(fills).map(t => { const rv = reviews[t.key] || {}; return { ...withRisk(t, stops, rv.stop ?? null), hidden: !!rv.hidden }; })
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

