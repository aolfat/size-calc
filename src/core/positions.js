// @ts-check
// Schwab positions as table rows (price, share of the account, stop and risk from working stop orders),
// and the order plans for a breakeven stop or a market close on one of them.
import { closeLimitOrder, closeMarketOrder, closeStopOrder, closingInstruction, fmtTick, ocoOrder, optionStopTick, stopTick } from './orders.js';

/**
 * @typedef {import('./orders.js').TradeAs} TradeAs
 * @typedef {import('./orders.js').StopDuration} StopDuration
 * @typedef {{ assetType?: string, type?: string, symbol?: string, underlyingSymbol?: string, optionMultiplier?: number }} Instrument
 * @typedef {{ longQuantity?: number, shortQuantity?: number, averagePrice?: number, averageLongPrice?: number, averageShortPrice?: number, marketValue?: number, instrument?: Instrument }} Position
 * @typedef {{ instruction?: string, quantity?: number, instrument?: { symbol?: string } }} OrderLeg
 * @typedef {{ orderId?: number | string, orderType?: string, orderStrategyType?: string, status?: string, stopPrice?: number, price?: number, quantity?: number, remainingQuantity?: number,
 *   duration?: string, session?: string, enteredTime?: string, orderLegCollection?: OrderLeg[], childOrderStrategies?: Order[] }} Order
 * @typedef {{ orderId: number | string | null, symbol: string, closes: 'long' | 'short', orderType: string, stop: number | null, price: number | null, qty: number,
 *   oco: number | string | null, duration: string, session: string }} Resting
 * @typedef {{ symbol: string, label: string, under: string, option: { root: string, exp: string, type: string, strike: number } | null,
 *   tradeAs: TradeAs | null, qty: number, mult: number, avg: number, be: number | null, price: number, value: number, pctAcct: number,
 *   stop: number | null, stops: number, covered: number, risk: number | null, riskPct: number | null, stopOrders: Resting[], closers: Resting[] }} Row
 * @typedef {{ kind: 'cancel' | 'replace' | 'place', orderId?: number | string | null, was?: Resting, order?: object, pairs?: Resting }} Step
 * @typedef {{ error: string, stop: number, steps: Step[], paired: Resting[], rest: number, bare: number }} Plan
 */

/** 'AAPL  260620C00245000' → { root, exp, type, strike }; null for anything else. @param {string} symbol */
export function parseSchwabOption(symbol) {
  const m = String(symbol || '').match(/^([A-Z0-9.]{1,6})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  return m ? { root: m[1], exp: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5], strike: Number(m[6]) / 1000 } : null;
}

/** what the table shows: the symbol, or 'AAPL 6/20/26 245C' for an option. @param {Instrument} instrument */
export function positionLabel(instrument) {
  const o = instrument.assetType === 'OPTION' ? parseSchwabOption(instrument.symbol || '') : null;
  if (!o) return instrument.symbol || '';
  const [y, mo, d] = o.exp.split('-');
  return `${o.root} ${+mo}/${+d}/${y.slice(2)} ${o.strike}${o.type}`;
}

// an order is in play until it ends; Schwab's other statuses (NEW, PENDING_*, AWAITING_*, QUEUED, WORKING...) still hold shares.
// AWAITING_PARENT_ORDER waits on an entry that hasn't filled, so it holds nothing yet
const ENDED = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'REPLACED', 'AWAITING_PARENT_ORDER']);
// a cancel Schwab refused still did its job when the order is already on its way out
const GONE = new Set(['CANCELED', 'PENDING_CANCEL', 'EXPIRED', 'REJECTED', 'REPLACED']);
/** @param {string} status */
export const orderGone = status => GONE.has(status);

/** @type {Record<string, 'long' | 'short'>} */
const CLOSES = { SELL: 'long', SELL_TO_CLOSE: 'long', BUY_TO_COVER: 'short', BUY_TO_CLOSE: 'short', BUY: 'short' };
const num = (/** @type {unknown} */ v) => Number(v) > 0 ? Number(v) : null;
/** @param {Order} o @param {OrderLeg} leg */
const orderQty = (o, leg) => Number(o.remainingQuantity) > 0 ? Number(o.remainingQuantity) : Number(o.quantity) || Number(leg.quantity) || 0;

/** every order in play that closes a position, children of trigger and one-cancels-other orders included. @param {Order[]} orders @returns {Resting[]} */
export function restingOrders(orders) {
  /** @type {Resting[]} */
  const out = [];
  let pairs = 0;
  /** @param {Order} o @param {number | string | null} oco */
  const walk = (o, oco) => {
    const legs = o.orderLegCollection || [];
    const closes = legs.length === 1 ? CLOSES[legs[0].instruction || ''] : undefined;
    if (o.status && !ENDED.has(o.status) && closes) {
      const qty = orderQty(o, legs[0]);
      if (qty > 0) out.push({ orderId: o.orderId ?? null, symbol: legs[0].instrument?.symbol || '', closes, orderType: o.orderType || '',
        stop: num(o.stopPrice), price: num(o.price), qty, oco, duration: o.duration || '', session: o.session || '' });
    }
    const group = o.orderStrategyType === 'OCO' ? o.orderId ?? `oco-${++pairs}` : null;
    (o.childOrderStrategies || []).forEach(c => walk(c, group));
  };
  (orders || []).forEach(o => walk(o, null));
  return out;
}

/** every single-leg order Schwab lists on a symbol, whatever its status, newest first. @param {Order[]} orders @param {string} symbol */
export function ordersFor(orders, symbol) {
  /** @type {{ orderId: number | string | null, orderType: string, status: string, instruction: string, stop: number | null, price: number | null, qty: number, entered: string }[]} */
  const out = [];
  /** @param {Order} o */
  const walk = o => {
    const legs = o.orderLegCollection || [];
    if (legs.length === 1 && legs[0].instrument?.symbol === symbol) {
      out.push({ orderId: o.orderId ?? null, orderType: o.orderType || '', status: o.status || '', instruction: legs[0].instruction || '',
        stop: num(o.stopPrice), price: num(o.price), qty: orderQty(o, legs[0]), entered: o.enteredTime || '' });
    }
    (o.childOrderStrategies || []).forEach(walk);
  };
  (orders || []).forEach(walk);
  return out.sort((a, b) => b.entered.localeCompare(a.entered)).slice(0, 8);
}

/** what orders here can trade it as: stocks, ETFs and closed-end funds as equity, options as options. @param {Instrument} i @returns {TradeAs | null} */
function tradeAs(i) {
  if (i.assetType === 'OPTION') return 'OPTION';
  return i.assetType === 'EQUITY' || (i.assetType === 'COLLECTIVE_INVESTMENT' && (i.type === 'EXCHANGE_TRADED_FUND' || i.type === 'CLOSED_END_FUND')) ? 'EQUITY' : null;
}

/** @param {Resting} o */
const isStop = o => /STOP/.test(o.orderType) && o.stop !== null;

/**
 * The account's positions as rows sorted by underlying (stock before its options), with totals.
 * Risk is what a stop fill loses from the average cost; negative when the stop locks a gain. Totals count losses only.
 * @param {{ positions?: Position[], currentBalances?: { liquidationValue?: number, cashBalance?: number } }} account
 * @param {Order[]} orders
 */
export function positionRows(account, orders) {
  const value = Number(account.currentBalances?.liquidationValue) || 0;
  const cash = Number(account.currentBalances?.cashBalance) || 0;
  const pct = (/** @type {number} */ v) => value > 0 ? v * 100 / value : 0;
  const resting = restingOrders(orders);
  /** @type {Row[]} */
  const rows = [];
  for (const p of account.positions || []) {
    const instrument = p.instrument || {};
    const qty = (Number(p.longQuantity) || 0) - (Number(p.shortQuantity) || 0);
    if (!qty) continue;
    const long = qty > 0;
    const option = instrument.assetType === 'OPTION' ? parseSchwabOption(instrument.symbol || '') : null;
    const mult = instrument.assetType === 'OPTION' ? Number(instrument.optionMultiplier) || 100 : 1;
    const avg = Number(long ? p.averageLongPrice ?? p.averagePrice : p.averageShortPrice ?? p.averagePrice) || 0;
    const mv = Number(p.marketValue) || 0;
    const as = tradeAs(instrument);
    const closers = resting.filter(o => o.symbol === instrument.symbol && o.closes === (long ? 'long' : 'short'));
    // nearest stop first; each fills against the shares the ones before it left
    const mine = closers.filter(isStop).sort((a, b) => long ? Number(b.stop) - Number(a.stop) : Number(a.stop) - Number(b.stop));
    let left = Math.abs(qty), loss = 0;
    for (const s of mine) {
      const q = Math.min(left, s.qty);
      loss += (long ? avg - Number(s.stop) : Number(s.stop) - avg) * q * mult;
      left -= q;
    }
    const risk = mine.length && avg > 0 ? loss : null;
    rows.push({
      symbol: instrument.symbol || '', label: positionLabel(instrument), under: instrument.underlyingSymbol || option?.root || instrument.symbol || '', option,
      tradeAs: as, qty, mult, avg, be: as && avg > 0 ? (as === 'OPTION' ? optionStopTick(avg, long) : stopTick(avg, long)) : null,
      price: mv / (qty * mult), value: mv, pctAcct: pct(Math.abs(mv)),
      stop: mine.length ? mine[0].stop : null, stops: mine.length, covered: Math.abs(qty) - left,
      risk, riskPct: risk === null ? null : pct(risk), stopOrders: mine, closers,
    });
  }
  const key = (/** @type {Row} */ r) => [r.under, r.option ? 1 : 0, r.option?.exp || '', (r.option?.strike ?? 0).toFixed(3).padStart(12, '0'), r.option?.type || ''].join('|');
  rows.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  const total = rows.reduce((s, r) => s + r.value, 0);
  const risk = rows.reduce((s, r) => s + Math.max(0, r.risk || 0), 0);
  return { value, cash, rows, total, totalPct: pct(total), risk, riskPct: pct(risk) };
}

/** A price as Schwab takes it for this instrument: cents for options, four decimals for stock under $1. @param {number} p @param {TradeAs | null} as */
export function fmtPositionPrice(p, as) { return as === 'OPTION' ? '$' + Number(p).toFixed(2) : fmtTick(p); }

/** @type {Record<string, string>} */
export const INSTRUCTION_WORDS = { SELL: 'sell', BUY_TO_COVER: 'buy to cover', SELL_TO_CLOSE: 'sell to close', BUY_TO_CLOSE: 'buy to close', BUY: 'buy', SELL_SHORT: 'sell short', BUY_TO_OPEN: 'buy to open', SELL_TO_OPEN: 'sell to open' };
/** @type {Record<string, string>} */
const ORDER_WORDS = { STOP: 'stop', STOP_LIMIT: 'stop limit', LIMIT: 'limit', TRAILING_STOP: 'trailing stop', TRAILING_STOP_LIMIT: 'trailing stop limit', MARKET: 'market' };
/** 'STOP_LIMIT' → 'stop limit'. @param {string} type */
export const orderTypeWord = type => ORDER_WORDS[type] || String(type || 'order').toLowerCase().replace(/_/g, ' ');

/** @param {Row} row @returns {string} why orders can't go out for this row, or '' */
function tradeError(row) {
  if (!row.tradeAs) return 'Orders from here cover stocks, ETFs and options only.';
  if (!Number.isInteger(row.qty)) return 'Fractional shares can\'t be traded from here.';
  return '';
}

/** an order Schwab listed without an id can't be cancelled or replaced from here. @param {Step[]} steps */
const unnamed = steps => steps.some(s => s.kind !== 'place' && s.orderId === null) ? 'Schwab listed an order on this position without an id. Change it in Schwab.' : '';

/** @param {Resting[]} legs @returns {Step[]} */
const cancels = legs => legs.map(was => ({ kind: 'cancel', orderId: was.orderId, was }));

/**
 * A breakeven stop without selling more than you hold, which Schwab refuses. The shares outside any limit target (rest)
 * get one plain stop. pair: the shares a limit holds get a stop paired with that limit too (one cancels the other);
 * without it the limits are left as they are and their shares (bare) keep no stop.
 * Order: the limits being re-paired are cancelled first, then the plain stops are cut down to the rest (others cancelled,
 * the nearest replaced), then each limit is placed again with its stop. Between those, the paired shares have no stop for a moment.
 * @param {Row} row @param {StopDuration} stopDuration @param {{ pair?: boolean }} [opts] @returns {Plan}
 */
export function breakevenPlan(row, stopDuration, { pair = true } = {}) {
  const fail = (/** @type {string} */ error) => ({ error, stop: row.be || 0, steps: [], paired: [], rest: 0, bare: 0 });
  const blocked = tradeError(row);
  if (blocked) return fail(blocked);
  if (!(row.avg > 0) || row.be === null) return fail('Schwab shows no cost basis for this position, so it has no breakeven.');
  const long = row.qty > 0, be = row.be, held = Math.abs(row.qty), as = row.tradeAs || 'EQUITY', symbol = row.symbol;
  const px = (/** @type {number} */ p) => fmtPositionPrice(p, as);
  if (long ? !(row.price > be) : !(row.price < be)) {
    return fail(`The price ${px(row.price)} is at or ${long ? 'below' : 'above'} the breakeven stop ${px(be)}. It would ${INSTRUCTION_WORDS[closingInstruction(as, long)]} right away.`);
  }
  const odd = row.closers.find(o => o.oco === null && !isStop(o) && (o.orderType !== 'LIMIT' || o.price === null));
  if (odd) return fail(`A ${orderTypeWord(odd.orderType)} order for ${odd.qty} is waiting to close part of this position. Change it in Schwab first.`);
  /** @type {Map<number | string, Resting[]>} */
  const groups = new Map();
  for (const o of row.closers) if (o.oco !== null) groups.set(o.oco, [...(groups.get(o.oco) || []), o]);
  const targets = row.closers.filter(o => o.oco === null && !isStop(o)).map(limit => ({ limit, legs: [limit] }));
  const pairs = [...groups.values()].map(legs => ({ limit: legs.find(l => !isStop(l)), legs }));
  if (pairs.some(p => !p.limit)) return fail('A one-cancels-other order on this position has no limit in it. Change it in Schwab first.');
  const reserved = [...targets, ...pairs].reduce((n, p) => n + Number(p.limit?.qty), 0);
  if (reserved > held) return fail(`The ${long ? 'sell' : 'buy'} orders on this position already add up to ${reserved}, more than the ${held} you hold. Fix them in Schwab first.`);
  const rest = held - reserved;
  const stopFor = (/** @type {number} */ qty) => closeStopOrder({ symbol, assetType: as, isLong: long, qty, stop: be, stopDuration });
  if (!pair && rest === 0) return fail('Your limit holds the whole position, so no shares are left for a separate stop. Pair it with a stop instead.');
  // a pair whose stop is already at breakeven stays as it is; without pairing, every limit does
  const repair = pair ? [...targets, ...pairs.filter(p => !p.legs.some(l => isStop(l) && l.stop === be))] : [];
  const bare = pair ? 0 : targets.reduce((n, p) => n + p.limit.qty, 0);
  const plain = row.stopOrders.filter(o => o.oco === null); // nearest first
  const keep = rest > 0 ? plain[0] : undefined;
  const drop = (rest > 0 ? plain.slice(1) : plain).reverse(); // farthest first, so the nearest goes last
  /** @type {Step[]} */
  const steps = [];
  for (const p of repair) steps.push(...cancels([...p.legs].sort((a, b) => Number(isStop(a)) - Number(isStop(b)))).map(s => ({ ...s, pairs: p.limit })));
  steps.push(...cancels(drop));
  if (rest > 0 && !keep) steps.push({ kind: 'place', order: stopFor(rest) });
  if (keep && !(keep.stop === be && keep.qty === rest)) steps.push({ kind: 'replace', orderId: keep.orderId, was: keep, order: stopFor(rest) });
  for (const { limit } of repair) {
    if (!limit || limit.price === null) continue;
    const target = closeLimitOrder({ symbol, assetType: as, isLong: long, qty: limit.qty, price: limit.price, duration: stopDuration });
    steps.push({ kind: 'place', order: ocoOrder(target, stopFor(limit.qty)), pairs: limit });
  }
  if (!steps.length) return fail(pair ? 'The position is already at breakeven: every share has a breakeven stop.' : 'The stop outside your limit is already at breakeven.');
  return { error: unnamed(steps), stop: be, steps, paired: repair.flatMap(p => p.limit ? [p.limit] : []), rest, bare };
}

/**
 * Close the whole position at market. Every order in play that would close it is cancelled first so nothing can sell twice:
 * targets first and the nearest stop last, so the position keeps a stop as long as it can. The close goes only if every cancel went through.
 * @param {Row} row @returns {Plan}
 */
export function closePlan(row) {
  const blocked = tradeError(row);
  if (blocked) return { error: blocked, stop: 0, steps: [], paired: [], rest: 0, bare: 0 };
  const others = row.closers.filter(o => !row.stopOrders.includes(o));
  const steps = cancels([...others, ...[...row.stopOrders].reverse()]);
  steps.push({ kind: 'place', order: closeMarketOrder({ symbol: row.symbol, assetType: row.tradeAs || 'EQUITY', isLong: row.qty > 0, qty: Math.abs(row.qty) }) });
  return { error: unnamed(steps), stop: 0, steps, paired: [], rest: 0, bare: 0 };
}
