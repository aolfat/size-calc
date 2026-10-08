// @ts-check
// Schwab positions as table rows (price, share of the account, stop and risk from working stop orders),
// and the order plans for a breakeven stop or a market close on one of them.
import { closeMarketOrder, closeStopOrder, closingInstruction, fmtTick, optionStopTick, stopTick } from './orders.js';

/**
 * @typedef {import('./orders.js').TradeAs} TradeAs
 * @typedef {import('./orders.js').StopDuration} StopDuration
 * @typedef {{ assetType?: string, type?: string, symbol?: string, underlyingSymbol?: string, optionMultiplier?: number }} Instrument
 * @typedef {{ longQuantity?: number, shortQuantity?: number, averagePrice?: number, averageLongPrice?: number, averageShortPrice?: number, marketValue?: number, instrument?: Instrument }} Position
 * @typedef {{ instruction?: string, quantity?: number, instrument?: { symbol?: string } }} OrderLeg
 * @typedef {{ orderId?: number | string, orderType?: string, status?: string, stopPrice?: number, price?: number, quantity?: number, remainingQuantity?: number, orderLegCollection?: OrderLeg[], childOrderStrategies?: Order[] }} Order
 * @typedef {{ orderId: number | string | null, symbol: string, closes: 'long' | 'short', orderType: string, stop: number | null, price: number | null, qty: number }} Resting
 * @typedef {{ symbol: string, label: string, under: string, option: { root: string, exp: string, type: string, strike: number } | null,
 *   tradeAs: TradeAs | null, qty: number, mult: number, avg: number, be: number | null, price: number, value: number, pctAcct: number,
 *   stop: number | null, stops: number, covered: number, risk: number | null, riskPct: number | null, stopOrders: Resting[], closers: Resting[] }} Row
 * @typedef {{ kind: 'cancel' | 'replace' | 'place', orderId?: number | string | null, was?: Resting, order?: object }} Step
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

// statuses of an order resting at Schwab; AWAITING_PARENT_ORDER guards a position that isn't open yet
const RESTING = new Set(['WORKING', 'ACCEPTED', 'QUEUED', 'PENDING_ACTIVATION', 'AWAITING_CONDITION', 'AWAITING_STOP_CONDITION', 'AWAITING_MANUAL_REVIEW', 'AWAITING_RELEASE_TIME']);
/** @type {Record<string, 'long' | 'short'>} */
const CLOSES = { SELL: 'long', SELL_TO_CLOSE: 'long', BUY_TO_COVER: 'short', BUY_TO_CLOSE: 'short', BUY: 'short' };

/** every resting single-leg order that closes a position, children of trigger and OCO orders included. @param {Order[]} orders @returns {Resting[]} */
export function restingOrders(orders) {
  /** @type {Resting[]} */
  const out = [];
  /** @param {Order} o */
  const walk = o => {
    const legs = o.orderLegCollection || [];
    const closes = legs.length === 1 ? CLOSES[legs[0].instruction || ''] : undefined;
    if (RESTING.has(o.status || '') && closes) {
      const qty = Number(o.remainingQuantity) > 0 ? Number(o.remainingQuantity) : Number(legs[0].quantity) || 0;
      if (qty > 0) out.push({ orderId: o.orderId ?? null, symbol: legs[0].instrument?.symbol || '', closes, orderType: o.orderType || '',
        stop: Number(o.stopPrice) > 0 ? Number(o.stopPrice) : null, price: Number(o.price) > 0 ? Number(o.price) : null, qty });
    }
    (o.childOrderStrategies || []).forEach(walk);
  };
  (orders || []).forEach(walk);
  return out;
}

/** what orders here can trade it as: stocks, ETFs and closed-end funds as equity, options as options. @param {Instrument} i @returns {TradeAs | null} */
function tradeAs(i) {
  if (i.assetType === 'OPTION') return 'OPTION';
  return i.assetType === 'EQUITY' || (i.assetType === 'COLLECTIVE_INVESTMENT' && (i.type === 'EXCHANGE_TRADED_FUND' || i.type === 'CLOSED_END_FUND')) ? 'EQUITY' : null;
}

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
    const mine = closers.filter(o => /STOP/.test(o.orderType) && o.stop !== null).sort((a, b) => long ? Number(b.stop) - Number(a.stop) : Number(a.stop) - Number(b.stop));
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
export const INSTRUCTION_WORDS = { SELL: 'sell', BUY_TO_COVER: 'buy to cover', SELL_TO_CLOSE: 'sell to close', BUY_TO_CLOSE: 'buy to close' };

/** @param {Row} row @returns {string} why orders can't go out for this row, or '' */
function tradeError(row) {
  if (!row.tradeAs) return 'Orders from here cover stocks, ETFs and options only.';
  if (!Number.isInteger(row.qty)) return 'Fractional shares can\'t be traded from here.';
  return '';
}

/** an order Schwab listed without an id can't be cancelled or replaced from here. @param {Step[]} steps */
const unnamed = steps => steps.some(s => s.kind !== 'place' && s.orderId === null) ? 'Schwab listed an order on this position without an id. Change it in Schwab.' : '';

/**
 * One stop for the whole position at its average cost. The other stops are cancelled first (Schwab may refuse stops
 * for more than you hold), then the nearest is replaced, so the position is never without one; with none, a new stop is placed.
 * @param {Row} row @param {StopDuration} stopDuration @returns {{ error: string, stop: number, steps: Step[] }}
 */
export function breakevenPlan(row, stopDuration) {
  const fail = (/** @type {string} */ error) => ({ error, stop: row.be || 0, steps: [] });
  const blocked = tradeError(row);
  if (blocked) return fail(blocked);
  if (!(row.avg > 0) || row.be === null) return fail('Schwab shows no cost basis for this position, so it has no breakeven.');
  const long = row.qty > 0, stop = row.be, qty = Math.abs(row.qty), as = row.tradeAs || 'EQUITY';
  const px = (/** @type {number} */ p) => fmtPositionPrice(p, as);
  if (long ? !(row.price > stop) : !(row.price < stop)) {
    return fail(`The price ${px(row.price)} is at or ${long ? 'below' : 'above'} the breakeven stop ${px(stop)}. It would ${INSTRUCTION_WORDS[closingInstruction(as, long)]} right away.`);
  }
  const [nearest, ...others] = row.stopOrders;
  if (nearest && !others.length && nearest.stop === stop && nearest.qty >= qty) return fail('The stop is already at breakeven for the whole position.');
  const order = closeStopOrder({ symbol: row.symbol, assetType: as, isLong: long, qty, stop, stopDuration });
  /** @type {Step[]} */
  const steps = others.map(was => ({ kind: 'cancel', orderId: was.orderId, was }));
  steps.push(nearest ? { kind: 'replace', orderId: nearest.orderId, was: nearest, order } : { kind: 'place', order });
  return { error: unnamed(steps), stop, steps };
}

/**
 * Close the whole position at market. Every resting order that would close it (stops and limit targets) is cancelled
 * first so nothing can sell twice; the close goes only if every cancel went through.
 * @param {Row} row @returns {{ error: string, stop: number, steps: Step[] }}
 */
export function closePlan(row) {
  const blocked = tradeError(row);
  if (blocked) return { error: blocked, stop: 0, steps: [] };
  /** @type {Step[]} */
  const steps = row.closers.map(was => ({ kind: 'cancel', orderId: was.orderId, was }));
  steps.push({ kind: 'place', order: closeMarketOrder({ symbol: row.symbol, assetType: row.tradeAs || 'EQUITY', isLong: row.qty > 0, qty: Math.abs(row.qty) }) });
  return { error: unnamed(steps), stop: 0, steps };
}
