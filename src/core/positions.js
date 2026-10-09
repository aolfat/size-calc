// @ts-check
// Schwab positions as table rows (price, share of the account, stop and risk from working stop orders), the account's
// working orders, the levels a position chart draws, and the order plans for a breakeven stop, a profit target or a market close.
import { closeLimitOrder, closeMarketOrder, closeStopOrder, closingInstruction, fmtTick, ocoOrder, optionStopTick, priceTick, stopTick } from './orders.js';

/**
 * @typedef {import('./orders.js').TradeAs} TradeAs
 * @typedef {import('./orders.js').StopDuration} StopDuration
 * @typedef {{ assetType?: string, type?: string, symbol?: string, underlyingSymbol?: string, optionMultiplier?: number }} Instrument
 * @typedef {{ longQuantity?: number, shortQuantity?: number, averagePrice?: number, averageLongPrice?: number, averageShortPrice?: number, marketValue?: number, instrument?: Instrument }} Position
 * @typedef {{ instruction?: string, quantity?: number, instrument?: { symbol?: string, assetType?: string } }} OrderLeg
 * @typedef {{ orderId?: number | string, orderType?: string, orderStrategyType?: string, status?: string, stopPrice?: number, price?: number, quantity?: number, remainingQuantity?: number,
 *   filledQuantity?: number, stopPriceOffset?: number, stopPriceLinkType?: string,
 *   duration?: string, session?: string, enteredTime?: string, orderLegCollection?: OrderLeg[], childOrderStrategies?: Order[] }} Order
 * @typedef {{ orderId: number | string | null, symbol: string, closes: 'long' | 'short', orderType: string, stop: number | null, price: number | null, qty: number,
 *   oco: number | string | null, duration: string, session: string }} Resting
 * @typedef {{ symbol: string, label: string, under: string, option: { root: string, exp: string, type: string, strike: number } | null,
 *   tradeAs: TradeAs | null, qty: number, mult: number, avg: number, be: number | null, price: number, value: number, pctAcct: number,
 *   stop: number | null, stops: number, covered: number, risk: number | null, riskPct: number | null, stopOrders: Resting[], closers: Resting[] }} Row
 * @typedef {{ kind: 'cancel' | 'replace' | 'place', orderId?: number | string | null, was?: Resting, order?: object, pairs?: Resting }} Step
 * @typedef {{ error: string, stop: number, steps: Step[], paired: Resting[], rest: number, bare: number, price?: number, moved?: number }} Plan
 * @typedef {{ limit: Resting | undefined, legs: Resting[] }} Hold
 * @typedef {{ kind: 'avg' | 'stop' | 'target', price: number, qty: number }} Level
 * @typedef {{ orderId: number | string | null, symbol: string, label: string, under: string, assetType: string, legs: number, instruction: string,
 *   orderType: string, qty: number, filled: number, stop: number | null, price: number | null, trail: string, duration: string, session: string,
 *   status: string, entered: string, oco: number | string | null, parent: string }} Working
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

// done for good; anything else is still working, or waiting to (a stop whose entry hasn't filled: AWAITING_PARENT_ORDER)
const DONE = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'REPLACED']);

/**
 * Every order still working in the account, entries included, one row per order with legs: the legs of a one-cancels-other
 * share its oco id, and the children of an entry that hasn't filled name its instruction (parent). Sorted by underlying,
 * newest first within one, an order's children right after it.
 * @param {Order[]} orders @returns {Working[]}
 */
export function workingOrders(orders) {
  /** @type {Working[][]} */
  const groups = [];
  let pairs = 0;
  for (const top of orders || []) {
    /** @type {Working[]} */
    const rows = [];
    /** @param {Order} o @param {number | string | null} oco @param {string} parent */
    const walk = (o, oco, parent) => {
      const legs = o.orderLegCollection || [];
      const live = !!o.status && !DONE.has(o.status);
      if (legs.length && live) {
        const labels = legs.map(l => positionLabel({ assetType: l.instrument?.assetType, symbol: l.instrument?.symbol }));
        const first = legs[0], symbol = first.instrument?.symbol || '', option = parseSchwabOption(symbol);
        const offset = Number(o.stopPriceOffset) || 0;
        rows.push({ orderId: o.orderId ?? null, symbol, label: labels.join(' / '), under: option ? option.root : symbol, assetType: first.instrument?.assetType || '',
          legs: legs.length, instruction: first.instruction || '', orderType: o.orderType || '', qty: Number(o.quantity) || Number(first.quantity) || 0,
          filled: Number(o.filledQuantity) || 0, stop: num(o.stopPrice), price: num(o.price),
          trail: offset > 0 ? (o.stopPriceLinkType === 'PERCENT' ? offset + '%' : '$' + offset.toFixed(2)) : '',
          duration: o.duration || '', session: o.session || '', status: o.status || '', entered: o.enteredTime || '', oco, parent });
      }
      const group = o.orderStrategyType === 'OCO' ? o.orderId ?? `oco-${++pairs}` : oco;
      // a trigger's children wait on it until it fills
      const waits = o.orderStrategyType === 'TRIGGER' && legs.length && live ? legs[0].instruction || '' : parent;
      (o.childOrderStrategies || []).forEach(c => walk(c, group, waits));
    };
    walk(top, null, '');
    if (rows.length) groups.push(rows);
  }
  const by = (/** @type {Working[]} */ g) => g[0].under;
  groups.sort((a, b) => by(a) < by(b) ? -1 : by(a) > by(b) ? 1 : b[0].entered.localeCompare(a[0].entered));
  return groups.flat();
}

/** Schwab's '2026-10-08T13:41:22+0000' as epoch ms (Safari won't read the offset without its colon); NaN when unreadable. @param {string} s */
export function schwabTime(s) { return Date.parse(String(s || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')); }

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

/** the orders other than stops that would close a position: limit targets, legs of a target-and-stop pair, anything else waiting. @param {Row} row */
export const closersInTheWay = row => row.closers.filter(o => !isStop(o));

/**
 * What limits already hold of a position: plain targets and target-and-stop pairs (one cancels the other), and how many
 * shares that is. An error for what the plans here can't work around: a market or other order waiting to close part of it,
 * a pair with no limit in it, or limits adding up to more than you hold.
 * @param {Row} row @returns {{ error: string, targets: Hold[], pairs: Hold[], reserved: number }}
 */
function limitsHolding(row) {
  const fail = (/** @type {string} */ error) => ({ error, targets: [], pairs: [], reserved: 0 });
  const long = row.qty > 0, held = Math.abs(row.qty);
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
  return { error: '', targets, pairs, reserved };
}

/**
 * A breakeven stop without selling more than you hold, which Schwab refuses. What happens to orders that already sell
 * part of the position (limits) is the caller's pick:
 * - 'pair': the shares a limit holds get a stop paired with that limit (one cancels the other), the rest one plain stop.
 *   The limits being re-paired are cancelled first, then the plain stops are cut down to the rest (others cancelled,
 *   the nearest replaced), then each limit is placed again with its stop; the paired shares have no stop for a moment.
 * - 'keep': the limits stay as they are and their shares (bare) keep no stop; the rest get one plain stop.
 * - 'cancel': every other order that would close it is cancelled, then one plain stop covers the whole position.
 * @param {Row} row @param {StopDuration} stopDuration @param {{ limits?: 'pair' | 'keep' | 'cancel' }} [opts] @returns {Plan}
 */
export function breakevenPlan(row, stopDuration, { limits = 'pair' } = {}) {
  const fail = (/** @type {string} */ error) => ({ error, stop: row.be || 0, steps: [], paired: [], rest: 0, bare: 0 });
  const blocked = tradeError(row);
  if (blocked) return fail(blocked);
  if (!(row.avg > 0) || row.be === null) return fail('Schwab shows no cost basis for this position, so it has no breakeven.');
  const long = row.qty > 0, be = row.be, held = Math.abs(row.qty), as = row.tradeAs || 'EQUITY', symbol = row.symbol;
  const px = (/** @type {number} */ p) => fmtPositionPrice(p, as);
  if (long ? !(row.price > be) : !(row.price < be)) {
    return fail(`The price ${px(row.price)} is at or ${long ? 'below' : 'above'} the breakeven stop ${px(be)}. It would ${INSTRUCTION_WORDS[closingInstruction(as, long)]} right away.`);
  }
  const stopFor = (/** @type {number} */ qty) => closeStopOrder({ symbol, assetType: as, isLong: long, qty, stop: be, stopDuration });
  if (limits === 'cancel') return cancelThenStop(row, be, held, stopFor);
  const pair = limits === 'pair';
  const holding = limitsHolding(row);
  if (holding.error) return fail(holding.error);
  const { targets, pairs, reserved } = holding;
  const rest = held - reserved;
  if (!pair && rest === 0) return fail('Your limit holds the whole position, so no shares are left for a separate stop. Pair it with a stop instead.');
  // a pair whose stop is already at breakeven stays as it is; without pairing, every limit does
  const repair = pair ? [...targets, ...pairs.filter(p => !p.legs.some(l => isStop(l) && l.stop === be))] : [];
  const bare = pair ? 0 : targets.reduce((n, p) => n + Number(p.limit?.qty), 0);
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
 * Every other order that would close it goes (limits and pairs first, then the extra stops, farthest first),
 * then the nearest plain stop is replaced to cover everything, or a new one is placed.
 * @param {Row} row @param {number} be @param {number} held @param {(qty: number) => object} stopFor @returns {Plan}
 */
function cancelThenStop(row, be, held, stopFor) {
  const plain = row.stopOrders.filter(o => o.oco === null); // nearest first
  const keep = plain[0];
  /** @type {Step[]} */
  const steps = cancels([...closersInTheWay(row), ...row.stopOrders.filter(o => o.oco !== null), ...plain.slice(1).reverse()]);
  if (!keep) steps.push({ kind: 'place', order: stopFor(held) });
  else if (!(keep.stop === be && keep.qty === held)) steps.push({ kind: 'replace', orderId: keep.orderId, was: keep, order: stopFor(held) });
  if (!steps.length) return { error: 'The position is already at breakeven: every share has a breakeven stop.', stop: be, steps: [], paired: [], rest: 0, bare: 0 };
  return { error: unnamed(steps), stop: be, steps, paired: [], rest: held, bare: 0 };
}

/** How many shares a new target can take: what limits already hold is spoken for. @param {Row} row */
export function targetRoom(row) {
  const held = Math.abs(row.qty), { error, reserved } = limitsHolding(row);
  return { error, held, reserved, free: error ? 0 : held - reserved };
}

/**
 * A profit target: a limit that closes qty shares at price. Schwab won't take orders that close more than you hold, so
 * when the position has a stop, the target goes in paired with a stop for the same shares at the nearest stop's price
 * (one cancels the other), and the plain stops are cut to the shares left outside every limit: the farthest go first,
 * the nearest stays longest, and a stop that is cut keeps its price and how long it lasts. The shares cut out of plain
 * stops (moved) have no stop until the pair is in. Stocks and ETFs only.
 * @param {Row} row @param {{ price: number, qty: number, duration: StopDuration }} target @returns {Plan}
 */
export function targetPlan(row, { price, qty, duration }) {
  const fail = (/** @type {string} */ error) => ({ error, stop: 0, steps: [], paired: [], rest: 0, bare: 0, price: 0, moved: 0 });
  if (row.tradeAs === 'OPTION') return fail('Targets from here are for stocks and ETFs.');
  const blocked = tradeError(row);
  if (blocked) return fail(blocked);
  const long = row.qty > 0, held = Math.abs(row.qty), symbol = row.symbol;
  if (!(price > 0)) return fail('Set a target price: tap the chart or type one.');
  const limit = priceTick(price);
  if (long ? !(limit > row.price) : !(limit < row.price)) {
    return fail(`The target ${fmtTick(limit)} is at or ${long ? 'below' : 'above'} the price ${fmtTick(row.price)}. It would ${long ? 'sell' : 'buy back'} right away.`);
  }
  const holding = limitsHolding(row);
  if (holding.error) return fail(holding.error);
  const free = held - holding.reserved;
  if (!Number.isInteger(qty) || qty < 1) return fail(`Pick how many shares the target ${long ? 'sells' : 'buys back'}.`);
  if (qty > free) {
    return fail(!holding.reserved ? `The target is for ${qty} shares and you hold ${held}.`
      : free > 0 ? `Your other targets hold ${holding.reserved} of the ${held} shares, so this one can take up to ${free}.`
      : `Your targets already hold all ${held} shares.`);
  }
  // the plain stops keep what fits outside every limit, nearest first; the rest are cut
  const plain = row.stopOrders.filter(o => o.oco === null);
  let left = free - qty, moved = 0;
  /** @type {Step[]} */
  const cuts = [];
  for (const s of plain) {
    const keep = Math.min(left, s.qty);
    left -= keep;
    if (keep === s.qty) continue;
    moved += s.qty - keep;
    const lasts = s.duration === 'DAY' || s.duration === 'GOOD_TILL_CANCEL' ? s.duration : duration;
    cuts.push(keep ? { kind: 'replace', orderId: s.orderId, was: s, order: closeStopOrder({ symbol, assetType: 'EQUITY', isLong: long, qty: keep, stop: Number(s.stop), stopDuration: lasts }) }
      : { kind: 'cancel', orderId: s.orderId, was: s });
  }
  const steps = cuts.reverse(); // farthest first, so the nearest is the last one touched
  const stop = row.stop; // the nearest stop of any kind
  const target = closeLimitOrder({ symbol, assetType: 'EQUITY', isLong: long, qty, price: limit, duration });
  steps.push({ kind: 'place', order: stop === null ? target : ocoOrder(target, closeStopOrder({ symbol, assetType: 'EQUITY', isLong: long, qty, stop, stopDuration: duration })) });
  return { error: unnamed(steps), stop: stop ?? 0, steps, paired: [], rest: free - qty, bare: stop === null ? qty : 0, price: limit, moved };
}

/** What a target makes over your cost, and in R (cost to the nearest stop) while that stop is a loss. @param {Row} row @param {number} price @param {number} qty */
export function targetGain(row, price, qty) {
  const long = row.qty > 0, per = long ? price - row.avg : row.avg - price;
  const risk = row.stop === null ? 0 : long ? row.avg - row.stop : row.stop - row.avg;
  if (!(row.avg > 0)) return { gain: null, pct: null, r: null };
  return { gain: per * qty * row.mult, pct: per / row.avg * 100, r: risk > 0 ? per / risk : null };
}

/** The lines a position's chart draws: average cost, then its stops and limit targets, one line per price with the sizes added up. @param {Row} row */
export function positionLevels(row) {
  /** @type {Level[]} */
  const out = row.avg > 0 ? [{ kind: 'avg', price: row.avg, qty: Math.abs(row.qty) }] : [];
  /** @param {'stop' | 'target'} kind @param {number} price @param {number} qty */
  const add = (kind, price, qty) => {
    const same = out.find(l => l.kind === kind && l.price === price);
    if (same) same.qty += qty; else out.push({ kind, price, qty });
  };
  for (const o of row.stopOrders) add('stop', Number(o.stop), o.qty);
  for (const o of row.closers) if (!isStop(o) && o.price !== null) add('target', o.price, o.qty);
  return out;
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
