// @ts-check
// Journal trades, pure: kept fills grouped into trades (flat back to flat, first in first out, scale-ins, partial exits,
// flips, ×100 for options), each with P&L, hold time, its initial stop and R. Trades are computed every time from the kept
// fills, never stored (docs/journal-step-2.md). Schwab's orders carry no fees; they come from its TRADE transactions
// (feesByOrder), split across trades by quantity, and P&L is before or after them by your choice (withFees). Your own word
// on a trade (trade_reviews, keyed by the trade key) overrides its stop and can delete it from the journal. Option legs
// opened in one multi-leg order, or that you combine, become one spread trade (combineSpreads).
import { expiryCloseMs } from './options.js';
import { parseSchwabOption, schwabTime } from './positions.js';

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
 *   status: 'open' | 'win' | 'loss' | 'breakeven' | 'history', expired: boolean, stop: number | null, stopOrderId: string, risk: number | null,
 *   rBasis: 'stop' | 'premium' | 'debit' | 'width' | null, r: number | null, stopSource: 'yours' | 'schwab' | null, schwabStop: number | null,
 *   stopTrail: StopOrder[], movedTo: number | null, ownStopIgnored: boolean, deleted: boolean,
 *   orderQty: Record<string, number>, fees: number, feesMissing: number, grossPnl: number, afterFees: boolean,
 *   legs?: Trade[], group?: 'auto' | 'yours', spreadKind?: 'debit' | 'credit' }} Trade
 * @typedef {{ stop?: number | null, hidden?: boolean, group_key?: string | null }} TradeReview  group_key: the spread
 *   it's combined into ('solo' = keep it on its own, even if its order opened other legs)  hidden is the delete marker (the column's first name)
 */

/** instructions that only ever close: a plain Sell can't open a short at Schwab (that's Sell short), nor Buy to cover a long */
const CLOSING_ONLY = { SELL: 'long', SELL_TO_CLOSE: 'long', BUY_TO_COVER: 'short', BUY_TO_CLOSE: 'short' };

/**
 * a trade being built: its open lots, first in first out
 * @param {Fill} fill @param {string} account @param {'long' | 'short'} direction
 */
function startTrade(fill, account, direction) {
  return {
    key: `${account}|${fill.symbol}|${direction}|${fill.time}`,
    account, symbol: fill.symbol, label: fill.label || fill.symbol, assetType: fill.assetType, multiplier: multiplierOf(fill.assetType),
    direction, openedAt: fill.time, closedAt: /** @type {string | null} */ (null), entryQty: 0, entryNotional: 0, exitQty: 0, exitNotional: 0,
    pnl: 0, exits: 0, fillIds: [], entryOrderIds: /** @type {string[]} */ ([]), orderQty: /** @type {Record<string, number>} */ ({}), history: false, expired: false, lots: /** @type {{ qty: number, price: number }[]} */ ([]),
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
    pnl, exits: t.exits, fillIds: t.fillIds, entryOrderIds: t.entryOrderIds, orderQty: t.orderQty,
    holdMs: closed && t.closedAt ? Date.parse(t.closedAt) - Date.parse(t.openedAt) : null,
    status: t.history ? 'history' : !closed ? 'open' : pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven', expired: !!t.expired,
    stop: null, stopOrderId: '', risk: null, rBasis: null, r: null,
    stopSource: null, schwabStop: null, stopTrail: [], movedTo: null, ownStopIgnored: false, deleted: false,
    fees: 0, feesMissing: 0, grossPnl: pnl, afterFees: false,
  };
}

/**
 * Fills → trades, per account and symbol (an option's symbol is its contract), in time order. A fill that takes the
 * position through zero closes the trade and opens the next one in the other direction with what's left (a flip), unless
 * its instruction only ever closes (Sell, Buy to cover, Sell to close, Buy to close): then what it closes beyond the
 * position was opened before the journal's history (Schwab's API gives 60 days of orders), and those closing fills
 * become a 'history' trade: its exits known, its entry and P&L not, kept out of the stats. With `now`, an option still
 * open after its expiry's 4pm New York close is closed there at $0 (expired, assumed worthless: an exercise or an
 * assignment isn't in the orders).
 * @param {Fill[]} fills @param {{ now?: number }} [opts]
 * @returns {Trade[]}
 */
export function buildTrades(fills, opts = {}) {
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
    /** @type {any} closing fills with nothing open to close: opened before the history */
    let gap = null;
    const endGap = () => { if (gap) trades.push(finish(gap)); gap = null; };
    const toGap = (/** @type {Fill} */ f, /** @type {string} */ account, /** @type {'long' | 'short'} */ direction, /** @type {number} */ qty) => {
      if (gap && gap.direction !== direction) endGap();
      if (!gap) { gap = startTrade(f, account, direction); gap.key = `${account}|${f.symbol}|${direction}|before|${f.time}`; gap.history = true; }
      gap.fillIds.push(f.id);
      gap.exits++;
      gap.entryQty += qty;
      gap.exitQty += qty;
      gap.exitNotional += qty * f.price;
      gap.orderQty[f.orderId] = (gap.orderQty[f.orderId] || 0) + qty;
      gap.closedAt = f.time;
    };
    for (const f of list) {
      const account = f.account || '';
      let qty = f.qty;
      const buying = f.side === 'buy';
      const closes = /** @type {'long' | 'short' | undefined} */ (CLOSING_ONLY[/** @type {keyof typeof CLOSING_ONLY} */ (f.instruction)]);
      // a close with nothing (or the other side) open: the position is older than the history
      if (closes && (!t || t.direction !== closes)) { toGap(f, account, closes, qty); continue; }
      if (!closes) endGap();
      if (!t) t = startTrade(f, account, buying ? 'long' : 'short');
      const adds = (t.direction === 'long') === buying;
      t.fillIds.push(f.id);
      const used = (/** @type {number} */ n) => { t.orderQty[f.orderId] = (t.orderQty[f.orderId] || 0) + n; };
      if (adds) {
        used(qty);
        t.lots.push({ qty, price: f.price });
        t.entryQty += qty;
        t.entryNotional += qty * f.price;
        if (!t.entryOrderIds.includes(f.orderId)) t.entryOrderIds.push(f.orderId);
        continue;
      }
      // reducing: match the oldest lots first
      t.exits++;
      const before = qty;
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
      used(before - qty);
      if (!t.lots.length) {
        t.closedAt = f.time;
        const direction = t.direction;
        trades.push(finish(t));
        t = null;
        if (qty > EPS && closes) toGap(f, account, direction, qty); // sold more than the history holds
        else if (qty > EPS) { // a flip: what's left opens the other way
          t = startTrade(f, account, buying ? 'long' : 'short');
          t.fillIds.push(f.id);
          t.lots.push({ qty, price: f.price });
          t.entryQty += qty;
          t.entryNotional += qty * f.price;
          t.entryOrderIds.push(f.orderId);
          t.orderQty[f.orderId] = qty;
        }
      }
    }
    endGap();
    if (t && t.assetType === 'OPTION' && opts.now !== undefined) expire(t, opts.now);
    if (t) trades.push(finish(t));
  }
  return trades;
}

/** an option still open after its expiry's close: closed there at $0. @param {any} t @param {number} now */
function expire(t, now) {
  const opt = parseSchwabOption(t.symbol);
  const close = opt ? expiryCloseMs(opt.exp) : NaN;
  if (!Number.isFinite(close) || now <= close) return;
  const sign = t.direction === 'long' ? 1 : -1;
  for (const lot of t.lots) {
    t.pnl += (0 - lot.price) * lot.qty * sign * t.multiplier;
    t.exitQty += lot.qty;
  }
  t.lots = [];
  t.exits++;
  t.closedAt = new Date(close).toISOString();
  t.expired = true;
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
  if (trade.status === 'history') return trade; // no entry, so no stop or risk to speak of
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
 * Fees per order, from Schwab's TRADE transactions: each one names its order (orderId) and lists its fees as transfer
 * items with a feeType (COMMISSION, SEC_FEE, TAF_FEE, OPT_REG_FEE, ...), charged as a negative cost. An order filled in
 * pieces has a transaction per piece, so they add up. Only orders with a transaction are in the map.
 * @param {{ kind: string, data: any }[]} records
 * @returns {Map<string, number>}
 */
export function feesByOrder(records) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const r of records) {
    const tx = r.kind === 'transaction' ? r.data : null;
    if (!tx || tx.type !== 'TRADE' || tx.orderId === undefined || tx.orderId === null) continue;
    let fee = 0;
    for (const item of Array.isArray(tx.transferItems) ? tx.transferItems : []) {
      if (!item?.feeType) continue;
      const v = Number(item.cost ?? item.amount);
      if (Number.isFinite(v)) fee -= v; // charged as a negative cost; a rebate comes back positive
    }
    const k = String(tx.orderId);
    out.set(k, (out.get(k) || 0) + fee);
  }
  return out;
}

/**
 * The trade's share of its orders' fees, by quantity: an order that closes one trade and opens the next (a flip) splits
 * its fees between them. feesMissing counts the trade's orders with no transaction yet (Schwab posts them after the
 * fill, and orders older than the kept transactions have none). With afterFees, P&L, the result and R are net of them.
 * @param {Trade} trade @param {Map<string, number>} fees @param {Map<string, number>} orderTotals @param {boolean} afterFees
 * @returns {Trade}
 */
export function withFees(trade, fees, orderTotals, afterFees) {
  let total = 0, missing = 0;
  for (const [id, qty] of Object.entries(trade.orderQty)) {
    const fee = fees.get(id);
    if (fee === undefined) { missing++; continue; }
    const all = orderTotals.get(id) || qty;
    total += fee * (all > 0 ? qty / all : 1);
  }
  const feesRounded = Math.round(total * 100) / 100;
  if (!afterFees || trade.status === 'history') return { ...trade, fees: feesRounded, feesMissing: missing, grossPnl: trade.pnl, afterFees: false };
  const pnl = Math.round((trade.pnl - total) * 100) / 100;
  const closed = trade.status !== 'open';
  return {
    ...trade, fees: feesRounded, feesMissing: missing, grossPnl: trade.pnl, afterFees: true, pnl,
    status: !closed ? 'open' : pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven',
    r: closed && trade.risk && trade.risk > EPS ? Math.round((pnl / trade.risk) * 100) / 100 : trade.r,
  };
}

/**
 * The journal's trades from its kept records: fills grouped, each given its stop and R (your stop first) and whether
 * you deleted it, newest first (by when it closed, or opened if it's still open). Deleted trades stay in the list,
 * flagged: their fills still group with the rest (so the trades around them add up), and the view leaves them out.
 * Imports can't bring one back, since the mark is on the trade key, not on Schwab's records.
 * @param {Fill[]} fills @param {{ kind: string, account?: string, data: any }[]} records
 * @param {Record<string, TradeReview>} [reviews] @param {{ afterFees?: boolean, now?: number }} [opts]
 */
export function journalTrades(fills, records, reviews = {}, opts = {}) {
  const stops = stopOrdersFrom(records);
  const fees = feesByOrder(records);
  /** @type {Map<string, number>} */
  const orderTotals = new Map();
  for (const f of fills) orderTotals.set(f.orderId, (orderTotals.get(f.orderId) || 0) + f.qty);
  const legs = buildTrades(fills, { now: opts.now }).map(t => {
    const rv = reviews[t.key] || {};
    return { ...withFees(withRisk(t, stops, rv.stop ?? null), fees, orderTotals, !!opts.afterFees), deleted: !!rv.hidden };
  });
  return combineSpreads(legs, reviews)
    .sort((a, b) => { const ka = a.closedAt || a.openedAt, kb = b.closedAt || b.openedAt; return ka < kb ? 1 : ka > kb ? -1 : 0; });
}

/** closed trades in numbers: count, wins, losses, win rate, P&L, average R (over trades that have one), fees. @param {Trade[]} trades */
export function tradesSummary(trades) {
  const closed = trades.filter(t => t.status !== 'open' && t.status !== 'history');
  const wins = closed.filter(t => t.status === 'win').length;
  const losses = closed.filter(t => t.status === 'loss').length;
  const rs = closed.map(t => t.r).filter(r => r !== null);
  return {
    closed: closed.length, open: trades.filter(t => t.status === 'open').length, history: trades.filter(t => t.status === 'history').length, wins, losses,
    winRate: closed.length ? Math.round((wins / closed.length) * 1000) / 10 : null,
    pnl: Math.round(closed.reduce((n, t) => n + t.pnl, 0) * 100) / 100,
    avgR: rs.length ? Math.round((rs.reduce((n, r) => n + /** @type {number} */ (r), 0) / rs.length) * 100) / 100 : null,
    withR: rs.length,
    fees: Math.round(closed.reduce((n, t) => n + (t.fees || 0), 0) * 100) / 100,
    feesMissing: closed.filter(t => t.feesMissing > 0).length,
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


// ---------- spreads: option legs as one trade ----------

const isLeg = (/** @type {Trade} */ t) => t.assetType === 'OPTION' && t.status !== 'history' && !t.legs;
const rootOf = (/** @type {Trade} */ t) => parseSchwabOption(t.symbol)?.root || t.symbol;

/**
 * Which spread each option leg belongs to: the one you combined it into (its review's group_key), else, when one order
 * opened it along with other contracts (a multi-leg order), that order's spread. 'solo' keeps a leg on its own.
 * @param {Trade[]} trades @param {Record<string, TradeReview>} reviews
 * @returns {Map<string, { key: string, group: 'auto' | 'yours' }>} leg key → spread
 */
export function spreadGroups(trades, reviews = {}) {
  /** @type {Map<string, { key: string, group: 'auto' | 'yours' }>} */
  const out = new Map();
  const legs = trades.filter(isLeg);
  for (const t of legs) {
    const g = reviews[t.key]?.group_key;
    if (g && g !== 'solo') out.set(t.key, { key: g, group: 'yours' });
  }
  // a multi-leg order: the legs it opened, by order id, each leg in one spread at most (the first order that joins it)
  /** @type {Map<string, Trade[]>} */
  const byOrder = new Map();
  for (const t of legs) {
    if (out.has(t.key) || reviews[t.key]?.group_key === 'solo') continue;
    for (const id of t.entryOrderIds) {
      const k = `${t.account}|${id}`;
      if (!byOrder.has(k)) byOrder.set(k, []);
      /** @type {Trade[]} */ (byOrder.get(k)).push(t);
    }
  }
  for (const [, list] of byOrder) {
    const free = list.filter(t => !out.has(t.key));
    if (new Set(free.map(t => t.symbol)).size < 2) continue;
    const first = free.reduce((a, b) => (a.openedAt <= b.openedAt ? a : b));
    const key = `${first.account}|${rootOf(first)}|spread|${first.openedAt}`;
    for (const t of free) out.set(t.key, { key, group: 'auto' });
  }
  return out;
}

/** '245/255C' for a vertical, '230P/260C' for a strangle, by strike; '' when the legs don't share an expiry. @param {Trade[]} legs */
function spreadName(legs) {
  const opts = legs.map(l => parseSchwabOption(l.symbol));
  if (opts.some(o => !o) || new Set(opts.map(o => o?.exp)).size !== 1) return '';
  const o0 = /** @type {{ root: string, exp: string, type: string, strike: number }} */ (opts[0]);
  const [y, mo, d] = o0.exp.split('-');
  const date = `${+mo}/${+d}/${y.slice(2)}`;
  const types = new Set(opts.map(o => o?.type));
  const sorted = [.../** @type {{ type: string, strike: number }[]} */ (opts)].sort((a, b) => a.strike - b.strike);
  const strikes = types.size === 1 ? `${sorted.map(o => o.strike).join('/')}${o0.type}` : sorted.map(o => `${o.strike}${o.type}`).join('/');
  return `${o0.root} ${date} ${strikes}`;
}

/** '+3 245C −3 255C' (+ bought, − sold). @param {Trade[]} legs */
export function legWords(legs) {
  return legs.map(l => { const o = parseSchwabOption(l.symbol); return `${l.direction === 'long' ? '+' : '−'}${l.entryQty} ${o ? `${o.strike}${o.type}` : l.label}`; }).join(' ');
}

/**
 * One trade from its legs. Units = the smallest leg's size (a vertical's legs match). Entry and exit are the net per
 * unit, paid (a debit) or received (a credit). P&L, fees and exits add up; it's open while any leg is. Risk: a debit
 * risks what it paid; a two-leg vertical credit (same expiry and type) risks its width less the credit; anything else
 * has no R until step 3 asks.
 * @param {string} key @param {'auto' | 'yours'} group @param {Trade[]} legs @param {Record<string, TradeReview>} reviews
 * @returns {Trade}
 */
export function spreadTrade(key, group, legs, reviews = {}) {
  legs = [...legs].sort((a, b) => (parseSchwabOption(a.symbol)?.strike || 0) - (parseSchwabOption(b.symbol)?.strike || 0));
  const units = Math.min(...legs.map(l => l.entryQty)) || 1;
  const signed = (/** @type {Trade} */ l, /** @type {number} */ p) => (l.direction === 'long' ? 1 : -1) * p * l.entryQty;
  const net = legs.reduce((n, l) => n + signed(l, l.avgEntry), 0) / units;
  const kind = net >= 0 ? 'debit' : 'credit';
  const open = legs.some(l => l.status === 'open');
  const closedAt = open ? null : legs.reduce((m, l) => (l.closedAt && l.closedAt > m ? l.closedAt : m), '');
  const openedAt = legs.reduce((m, l) => (l.openedAt < m ? l.openedAt : m), legs[0].openedAt);
  const netExit = open ? null : legs.reduce((n, l) => n + signed(l, l.avgExit ?? 0), 0) / units;
  const pnl = Math.round(legs.reduce((n, l) => n + l.pnl, 0) * 100) / 100;
  const opts = legs.map(l => parseSchwabOption(l.symbol));
  const vertical = legs.length === 2 && opts.every(Boolean) && opts[0]?.exp === opts[1]?.exp && opts[0]?.type === opts[1]?.type && legs[0].direction !== legs[1].direction && legs[0].entryQty === legs[1].entryQty;
  let risk = null, rBasis = /** @type {Trade['rBasis']} */ (null);
  if (kind === 'debit' && net > 0) { risk = net * units * 100; rBasis = 'debit'; }
  else if (kind === 'credit' && vertical) {
    const width = Math.abs(/** @type {number} */ (opts[0]?.strike) - /** @type {number} */ (opts[1]?.strike));
    if (width + net > 0) { risk = (width + net) * units * 100; rBasis = 'width'; }
  }
  const status = open ? 'open' : pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven';
  const orderQty = /** @type {Record<string, number>} */ ({});
  for (const l of legs) for (const [id, q] of Object.entries(l.orderQty)) orderQty[id] = (orderQty[id] || 0) + q;
  const name = spreadName(legs);
  return {
    key, account: legs[0].account, symbol: rootOf(legs[0]), label: name || `${rootOf(legs[0])} ${legs.length}-leg spread`,
    assetType: 'SPREAD', multiplier: 100, direction: kind === 'debit' ? 'long' : 'short', openedAt, closedAt,
    entryQty: units, openQty: open ? units : 0, avgEntry: Math.abs(net), avgExit: netExit === null ? null : Math.abs(netExit),
    pnl, exits: legs.reduce((n, l) => n + l.exits, 0), fillIds: legs.flatMap(l => l.fillIds), entryOrderIds: [...new Set(legs.flatMap(l => l.entryOrderIds))],
    orderQty, holdMs: closedAt ? Date.parse(closedAt) - Date.parse(openedAt) : null, status, expired: legs.every(l => l.expired),
    stop: null, stopOrderId: '', risk: risk ? Math.round(risk * 100) / 100 : null, rBasis,
    r: risk && !open ? Math.round((pnl / risk) * 100) / 100 : null,
    stopSource: null, schwabStop: null, stopTrail: [], movedTo: null, ownStopIgnored: false, deleted: !!reviews[key]?.hidden,
    fees: Math.round(legs.reduce((n, l) => n + l.fees, 0) * 100) / 100, feesMissing: legs.reduce((n, l) => n + l.feesMissing, 0),
    grossPnl: Math.round(legs.reduce((n, l) => n + l.grossPnl, 0) * 100) / 100, afterFees: legs[0].afterFees,
    legs, group, spreadKind: kind,
  };
}

/** the trades with each spread's legs folded into one spread trade (a lone leg left in a spread stays itself). @param {Trade[]} trades @param {Record<string, TradeReview>} [reviews] */
export function combineSpreads(trades, reviews = {}) {
  const groups = spreadGroups(trades, reviews);
  /** @type {Map<string, { group: 'auto' | 'yours', legs: Trade[] }>} */
  const spreads = new Map();
  for (const t of trades) {
    const g = groups.get(t.key);
    if (!g) continue;
    if (!spreads.has(g.key)) spreads.set(g.key, { group: g.group, legs: [] });
    /** @type {{ legs: Trade[] }} */ (spreads.get(g.key)).legs.push(t);
  }
  const folded = new Set();
  /** @type {Trade[]} */
  const out = [];
  for (const [key, sp] of spreads) {
    if (sp.legs.length < 2) continue;
    sp.legs.forEach(l => folded.add(l.key));
    out.push(spreadTrade(key, sp.group, sp.legs, reviews));
  }
  return [...trades.filter(t => !folded.has(t.key)), ...out];
}

/**
 * The trades a leg (or a spread) can combine with: other option legs in the same account on the same underlying, not
 * deleted, whose time overlaps (one opened before the other closed). Newest first.
 * @param {Trade[]} trades the journal's trades (spreads folded) @param {string} key
 */
export function combineCandidates(trades, key) {
  const t = trades.find(x => x.key === key);
  if (!t || (t.assetType !== 'OPTION' && !t.legs) || t.status === 'history') return [];
  const root = t.symbol && t.legs ? t.symbol : rootOf(t);
  const end = (/** @type {Trade} */ x) => x.closedAt || '9999';
  return trades.filter(x => x.key !== key && isLeg(x) && !x.deleted && x.account === t.account && rootOf(x) === root
    && x.openedAt <= end(t) && t.openedAt <= end(x));
}
