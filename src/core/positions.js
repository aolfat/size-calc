// @ts-check
// Schwab positions as table rows (price, share of the account, stop and risk from working stop orders), the account's
// working orders, the levels a position chart draws, and the order plans for a breakeven stop, a profit target, a close, or cancelling or changing a working order.
import { closeLimitOrder, closeMarketOrder, closeStopOrder, closingInstruction, fmtTick, ocoOrder, optionPriceTick, optionStopTick, priceTick, stopTick } from './orders.js';

/**
 * @typedef {import('./orders.js').TradeAs} TradeAs
 * @typedef {import('./orders.js').StopDuration} StopDuration
 * @typedef {{ assetType?: string, type?: string, symbol?: string, underlyingSymbol?: string, optionMultiplier?: number }} Instrument
 * @typedef {{ longQuantity?: number, shortQuantity?: number, averagePrice?: number, averageLongPrice?: number, averageShortPrice?: number, marketValue?: number, currentDayProfitLoss?: number, instrument?: Instrument }} Position
 * @typedef {{ legId?: number, instruction?: string, quantity?: number, instrument?: { symbol?: string, assetType?: string } }} OrderLeg
 * @typedef {{ activityType?: string, executionType?: string, executionLegs?: { legId?: number, quantity?: number, price?: number, time?: string }[] }} OrderActivity
 * @typedef {{ orderId?: number | string, orderType?: string, orderStrategyType?: string, status?: string, stopPrice?: number, price?: number, quantity?: number, remainingQuantity?: number,
 *   filledQuantity?: number, stopPriceOffset?: number, stopPriceLinkType?: string,
 *   duration?: string, session?: string, enteredTime?: string, closeTime?: string, orderLegCollection?: OrderLeg[], orderActivityCollection?: OrderActivity[],
 *   childOrderStrategies?: Order[] }} Order
 * @typedef {{ orderId: number | string | null, symbol: string, closes: 'long' | 'short', orderType: string, stop: number | null, price: number | null, qty: number,
 *   oco: number | string | null, duration: string, session: string }} Resting
 * @typedef {{ symbol: string, label: string, under: string, option: { root: string, exp: string, type: string, strike: number } | null,
 *   tradeAs: TradeAs | null, qty: number, mult: number, avg: number, be: number | null, price: number, value: number, pctAcct: number,
 *   stop: number | null, stops: number, covered: number, risk: number | null, riskPct: number | null, stopOrders: Resting[], closers: Resting[],
 *   pnl: number | null, pnlPct: number | null, day: number | null, dayPct: number | null }} Row
 * @typedef {{ kind: 'cancel' | 'replace' | 'place', orderId?: number | string | null, was?: Resting, order?: object, pairs?: Resting }} Step
 * @typedef {{ error: string, stop: number, steps: Step[], paired: Resting[], rest: number, bare: number, price?: number, moved?: number, kept?: number, locked?: number }} Plan
 * @typedef {{ limit: Resting | undefined, legs: Resting[] }} Hold
 * @typedef {{ kind: 'avg' | 'stop' | 'target', price: number, qty: number }} Level
 * @typedef {{ orderId: number | string | null, symbol: string, label: string, under: string, assetType: string, legs: number, instruction: string,
 *   orderType: string, qty: number, filled: number, stop: number | null, price: number | null, trail: string, duration: string, session: string,
 *   status: string, entered: string, oco: number | string | null, parent: string, parentId: number | string | null }} Working
 * @typedef {{ error: string, order: Working | null, partner: Working | null, children: Working[], keep: boolean, keepError: string, steps: Step[] }} CancelPlan
 */

/** 'AAPL  260620C00245000' → { root, exp, type, strike }; null for anything else. @param {string} symbol */
export function parseSchwabOption(symbol) {
  const m = String(symbol || '').match(/^([A-Z0-9.]{1,6})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  return m ? { root: m[1], exp: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5], strike: Number(m[6]) / 1000 } : null;
}

/** Schwab's padded option symbol as Tradier takes it: 'AAPL  260620C00245000' → 'AAPL260620C00245000'. @param {string} symbol */
export const tradierSymbol = symbol => String(symbol || '').replace(/\s+/g, '');

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
 * share its oco id, and the children of an entry that hasn't filled name its instruction and id (parent, parentId). Sorted by underlying,
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
    /** @param {Order} o @param {number | string | null} oco @param {string} parent @param {number | string | null} parentId */
    const walk = (o, oco, parent, parentId) => {
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
          duration: o.duration || '', session: o.session || '', status: o.status || '', entered: o.enteredTime || '', oco, parent, parentId });
      }
      const group = o.orderStrategyType === 'OCO' ? o.orderId ?? `oco-${++pairs}` : oco;
      // a trigger's children wait on it until it fills
      const waits = o.orderStrategyType === 'TRIGGER' && legs.length && live;
      (o.childOrderStrategies || []).forEach(c => walk(c, group, waits ? legs[0].instruction || '' : parent, waits ? o.orderId ?? null : parentId));
    };
    walk(top, null, '', null);
    if (rows.length) groups.push(rows);
  }
  const by = (/** @type {Working[]} */ g) => g[0].under;
  groups.sort((a, b) => by(a) < by(b) ? -1 : by(a) > by(b) ? 1 : b[0].entered.localeCompare(a[0].entered));
  return groups.flat();
}

/** A working order's price in words: stop, limit, a stop limit's stop, a trailing stop's trail. @param {Working} w */
export function workingPrice(w) {
  const px = (/** @type {number} */ v) => fmtPositionPrice(v, w.assetType === 'OPTION' ? 'OPTION' : null);
  if (w.trail) return 'trail ' + w.trail;
  if (w.stop !== null) return px(w.stop) + (w.price !== null ? ' stop' : '');
  if (w.price !== null) return px(w.price);
  return w.orderType === 'MARKET' ? 'market' : '—';
}

/** 'sell stop $33.40', or '2-leg limit' for a multi-leg order. @param {Working} w */
export function workingWords(w) {
  const what = w.legs > 1 ? `${w.legs}-leg ${orderTypeWord(w.orderType)}` : `${INSTRUCTION_WORDS[w.instruction] || String(w.instruction).toLowerCase().replace(/_/g, ' ')} ${orderTypeWord(w.orderType)}`;
  const px = workingPrice(w);
  return px === '—' || px === 'market' ? what : `${what} ${px}`;
}

/** A working single-leg order as Schwab takes it new, for the shares still open on it; null for types rebuilt here never (trailing stops...). @param {Working} w */
export function singleOrder(w) {
  if (w.legs !== 1 || !['STOP', 'LIMIT', 'STOP_LIMIT'].includes(w.orderType)) return null;
  return { orderType: w.orderType, session: w.session || 'NORMAL', duration: w.duration || 'DAY', orderStrategyType: 'SINGLE',
    ...(w.price !== null ? { price: w.price } : {}), ...(w.stop !== null ? { stopPrice: w.stop } : {}),
    orderLegCollection: [{ instruction: w.instruction, quantity: w.qty - w.filled, instrument: { symbol: w.symbol, assetType: w.assetType || 'EQUITY' } }] };
}

/**
 * Cancel one working order. Schwab cancels a one-cancels-other pair together, so by default (keep) the other half is placed
 * again on its own right after, at its price, size and duration: cancelling a target keeps its stop (the sender places it
 * only once Schwab shows that half cancelled, never over a fill). An entry that hasn't
 * filled takes the orders waiting on it (children) with it; an order waiting on its entry can't be cancelled from here.
 * @param {Order[]} orders @param {number | string} orderId @param {{ keep?: boolean }} [opts] @returns {CancelPlan}
 */
export function cancelPlan(orders, orderId, { keep = true } = {}) {
  const list = workingOrders(orders);
  const order = list.find(o => o.orderId !== null && String(o.orderId) === String(orderId)) || null;
  const fail = (/** @type {string} */ error) => ({ error, order, partner: null, children: [], keep: false, keepError: '', steps: [] });
  if (!order) return fail('Schwab no longer shows this order as working.');
  if (order.status === 'AWAITING_PARENT_ORDER') {
    return fail(`This waits on its ${INSTRUCTION_WORDS[order.parent] || 'entry'} order. Cancel that one and this goes with it, or change it in Schwab.`);
  }
  const partner = order.oco !== null ? list.find(o => o.oco === order.oco && o !== order) || null : null;
  const children = list.filter(o => o.parentId !== null && o.parentId === order.orderId);
  const again = partner ? singleOrder(partner) : null;
  const keepError = partner && !again ? `A ${orderTypeWord(partner.orderType)} can't be placed again from here.` : '';
  const keeping = !!partner && keep && !keepError;
  /** @type {Step[]} */
  const steps = [{ kind: 'cancel', orderId: order.orderId }];
  if (keeping && again) steps.push({ kind: 'place', order: again });
  return { error: '', order, partner, children, keep: keeping, keepError, steps };
}

/** The order types an edit can rebuild: a single-leg stop, limit or stop limit. @param {Working} w */
export const editable = w => w.legs === 1 && ['STOP', 'LIMIT', 'STOP_LIMIT'].includes(w.orderType);

/**
 * Change one working order: its stop, its limit, its size or how long it lasts. A plain order is replaced (Schwab cancels it and
 * places the new one together). A half of a one-cancels-other pair can't be replaced alone, so the pair is cancelled and placed
 * again with the change (the sender places it only once Schwab shows both halves cancelled, never over a fill); both halves keep
 * the same size and duration. Prices snap to the tick: cents (four decimals under $1), options on the $0.05 / $0.10 grid.
 * error = the order can't be changed from here; editError = this change can't go (through the price, too many, nothing changed).
 * rows: the account's positions, to hold a closing order to what you hold and check it against the price.
 * @param {Order[]} orders @param {number | string} orderId @param {{ stop?: number | null, price?: number | null, qty?: number, duration?: string }} edit @param {Row[]} [rows]
 */
export function editPlan(orders, orderId, edit, rows = []) {
  const list = workingOrders(orders);
  const order = list.find(o => o.orderId !== null && String(o.orderId) === String(orderId)) || null;
  const result = { error: '', editError: '', order, partner: /** @type {Working | null} */ (null), stop: /** @type {number | null} */ (null), price: /** @type {number | null} */ (null),
    qty: 0, duration: '', fills: false, steps: /** @type {Step[]} */ ([]) };
  const fail = (/** @type {string} */ error) => ({ ...result, error });
  if (!order) return fail('Schwab no longer shows this order as working.');
  if (order.status === 'AWAITING_PARENT_ORDER') return fail(`This waits on its ${INSTRUCTION_WORDS[order.parent] || 'entry'} order. Change it in Schwab.`);
  const child = list.find(o => o.parentId !== null && o.parentId === order.orderId);
  if (child) return fail(`Its ${workingWords(child)} waits on it, and a change from here would drop it. Change it in Schwab.`);
  if (!editable(order)) return fail(order.legs > 1 ? 'A multi-leg order can\'t be changed from here. Change it in Schwab.' : `A ${orderTypeWord(order.orderType)} can't be changed from here. Change it in Schwab.`);
  const partner = order.oco !== null ? list.find(o => o.oco === order.oco && o !== order) || null : null;
  if (partner && !editable(partner)) return fail(`It's paired with a ${orderTypeWord(partner.orderType)}, which can't be placed again from here. Change it in Schwab.`);
  const option = order.assetType === 'OPTION', assetType = option ? 'OPTION' : 'EQUITY';
  const tick = option ? optionPriceTick : priceTick, px = (/** @type {number} */ p) => fmtPositionPrice(p, assetType);
  const open = order.qty - order.filled, unit = option ? 'contracts' : 'shares';
  const stop = /STOP/.test(order.orderType) ? tick(Number(edit.stop ?? order.stop)) : null;
  const price = order.orderType !== 'STOP' ? tick(Number(edit.price ?? order.price)) : null;
  const qty = edit.qty ?? open, duration = edit.duration || order.duration;
  Object.assign(result, { partner, stop, price, qty, duration });
  const bad = (/** @type {string} */ editError) => ({ ...result, editError });
  if (stop !== null && !(stop > 0)) return bad('Set a stop price.');
  if (price !== null && !(price > 0)) return bad('Set a limit price.');
  if (!Number.isInteger(qty) || qty < 1) return bad(`Pick how many ${unit}.`);
  const closes = CLOSES[order.instruction];
  const row = closes ? rows.find(r => r.symbol === order.symbol && (r.qty > 0 ? 'long' : 'short') === closes) : undefined;
  if (row) {
    const long = row.qty > 0, held = Math.abs(row.qty);
    if (stop !== null && (long ? stop >= row.price : stop <= row.price)) {
      return bad(`The stop ${px(stop)} is at or ${long ? 'above' : 'below'} the price ${px(row.price)}. It would ${INSTRUCTION_WORDS[order.instruction] || 'fill'} right away.`);
    }
    // Schwab won't take orders that close more than you hold: the others closing it count, a pair once
    const mine = [order.orderId, partner?.orderId].map(String);
    const others = row.closers.filter(o => !mine.includes(String(o.orderId)));
    /** @type {Map<number | string, number>} */
    const pairs = new Map();
    for (const o of others) if (o.oco !== null) pairs.set(o.oco, Math.max(pairs.get(o.oco) || 0, o.qty));
    const room = held - others.filter(o => o.oco === null).reduce((n, o) => n + o.qty, 0) - [...pairs.values()].reduce((n, q) => n + q, 0);
    if (qty > open && qty > room) {
      return bad(room > 0 && room < held ? `This can be for up to ${room} ${unit}: your other orders close ${held - room} of the ${held} you hold.`
        : room >= held ? `This can be for up to ${held} ${unit}: you hold ${held}.` : `Your other orders already close all ${held} ${unit} you hold.`);
    }
    result.fills = price !== null && order.orderType === 'LIMIT' && (long ? price <= row.price : price >= row.price);
  }
  if (stop === order.stop && price === order.price && qty === open && duration === order.duration) return bad('Nothing changed yet: change the price, the size or how long it lasts.');
  const next = /** @type {object} */ (singleOrder({ ...order, assetType, stop, price, qty, filled: 0, duration }));
  if (!partner) return { ...result, steps: [{ kind: 'replace', orderId: order.orderId, order: next }] };
  const other = /** @type {object} */ (singleOrder({ ...partner, assetType, qty, filled: 0, duration }));
  const first = list.indexOf(order) < list.indexOf(partner);
  return { ...result, steps: [{ kind: 'cancel', orderId: order.orderId }, { kind: 'place', order: first ? ocoOrder(next, other) : ocoOrder(other, next) }] };
}

/** Schwab's '2026-10-08T13:41:22+0000' as epoch ms (Safari won't read the offset without its colon); NaN when unreadable. @param {string} s */
export function schwabTime(s) { return Date.parse(String(s || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')); }

/** an order activity that filled: Schwab lists a cancel as an EXECUTION too (executionType CANCELED, the canceled quantity at $0). @param {OrderActivity} a */
export const isFill = a => !!a && (!a.activityType || a.activityType === 'EXECUTION') && (!a.executionType || a.executionType === 'FILL');

/** the execution legs of an order's fills, children not walked. @param {Order} o */
export const fillLegs = o => (o.orderActivityCollection || []).filter(isFill).flatMap(a => a.executionLegs || []);

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
 * The account's positions as rows sorted by underlying (stock before its options), the spreads their option legs make
 * (positionSpreads), and totals. Risk is what a stop fill loses from the average cost; negative when the stop locks a gain.
 * Totals count losses only, a spread its max loss.
 * P/L is from the average cost (null without one), as % of that cost; today's is Schwab's day P/L, as % of the value before it.
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
    const cost = avg * Math.abs(qty) * mult, pnl = avg > 0 ? mv - avg * qty * mult : null;
    const day = typeof p.currentDayProfitLoss === 'number' && Number.isFinite(p.currentDayProfitLoss) ? p.currentDayProfitLoss : null;
    const before = day === null ? 0 : Math.abs(mv - day);
    rows.push({
      symbol: instrument.symbol || '', label: positionLabel(instrument), under: instrument.underlyingSymbol || option?.root || instrument.symbol || '', option,
      tradeAs: as, qty, mult, avg, be: as && avg > 0 ? (as === 'OPTION' ? optionStopTick(avg, long) : stopTick(avg, long)) : null,
      price: mv / (qty * mult), value: mv, pctAcct: pct(Math.abs(mv)),
      stop: mine.length ? mine[0].stop : null, stops: mine.length, covered: Math.abs(qty) - left,
      risk, riskPct: risk === null ? null : pct(risk), stopOrders: mine, closers,
      pnl, pnlPct: pnl === null ? null : pnl / cost * 100, day, dayPct: day === null || !before ? null : day / before * 100,
    });
  }
  const key = (/** @type {Row} */ r) => [r.under, r.option ? 1 : 0, r.option?.exp || '', (r.option?.strike ?? 0).toFixed(3).padStart(12, '0'), r.option?.type || ''].join('|');
  rows.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  const spreads = positionSpreads(rows, orders, value);
  const inSpread = new Set(spreads.flatMap(s => s.legs.map(l => l.symbol)));
  const total = rows.reduce((s, r) => s + r.value, 0);
  // a spread counts its defined max loss, not its legs' stops
  const risk = rows.reduce((s, r) => s + (inSpread.has(r.symbol) ? 0 : Math.max(0, r.risk || 0)), 0) + spreads.reduce((s, x) => s + (x.maxLoss || 0), 0);
  const priced = rows.filter(r => r.pnl !== null), dated = rows.filter(r => r.day !== null);
  const pnl = priced.reduce((s, r) => s + Number(r.pnl), 0), cost = priced.reduce((s, r) => s + r.avg * Math.abs(r.qty) * r.mult, 0);
  const day = dated.reduce((s, r) => s + Number(r.day), 0), before = dated.reduce((s, r) => s + Math.abs(r.value - Number(r.day)), 0);
  return { value, cash, rows, spreads, total, totalPct: pct(total), risk, riskPct: pct(risk),
    pnl: priced.length ? pnl : null, pnlPct: cost > 0 ? pnl / cost * 100 : null, day: dated.length ? day : null, dayPct: before > 0 ? day / before * 100 : null };
}

/**
 * @typedef {{ key: string, label: string, under: string, legs: Row[], legWords: string, structure: string, kind: 'debit' | 'credit', by: 'order' | 'pair',
 *   qty: number, units: number, mult: number, avg: number, price: number, value: number, pctAcct: number, maxLoss: number | null, maxLossPct: number | null,
 *   riskBasis: 'debit' | 'width' | null, pnl: number | null, pnlPct: number | null, day: number | null, dayPct: number | null }} SpreadRow
 */

/** @type {Record<string, 'long' | 'short'>} */
const OPENS = { BUY_TO_OPEN: 'long', SELL_TO_OPEN: 'short' };
const dateWords = (/** @type {string} */ exp) => { const [y, mo, d] = exp.split('-'); return `${+mo}/${+d}/${y.slice(2)}`; };

/**
 * Option legs Schwab lists one by one, grouped back into the spreads they are. First the orders: a filled (or partly filled)
 * order that opened two or more contracts together (a vertical, a calendar, an iron condor...) holds the legs still open on
 * the same sides, newest order first. Then, for a spread opened before the 59 days of orders or legged in, an underlying
 * whose only ungrouped options are one bought and one sold of the same type and size (a vertical, a calendar, a diagonal).
 * Anything else stays as single legs.
 * @param {Row[]} rows sorted as the table shows them @param {Order[]} orders @param {number} acct liquidation value
 * @returns {SpreadRow[]}
 */
export function positionSpreads(rows, orders, acct) {
  const options = rows.filter(r => r.option);
  const taken = new Set();
  /** @type {{ legs: Row[], by: 'order' | 'pair' }[]} */
  const groups = [];
  /** @type {{ at: string, legs: { symbol: string, side: 'long' | 'short' }[] }[]} */
  const opened = [];
  const walk = (/** @type {Order} */ o) => {
    const filled = o.status === 'FILLED' || Number(o.filledQuantity) > 0;
    const legs = (o.orderLegCollection || []).filter(l => l.instrument?.assetType === 'OPTION' && OPENS[l.instruction || ''])
      .map(l => ({ symbol: l.instrument?.symbol || '', side: OPENS[l.instruction || ''] }));
    if (filled && new Set(legs.map(l => l.symbol)).size > 1) opened.push({ at: o.enteredTime || '', legs });
    (o.childOrderStrategies || []).forEach(walk);
  };
  (orders || []).forEach(walk);
  opened.sort((a, b) => b.at.localeCompare(a.at));
  for (const o of opened) {
    const legs = options.filter(r => !taken.has(r.symbol) && o.legs.some(l => l.symbol === r.symbol && l.side === (r.qty > 0 ? 'long' : 'short')));
    if (legs.length < 2) continue;
    legs.forEach(r => taken.add(r.symbol));
    groups.push({ legs, by: 'order' });
  }
  for (const under of new Set(options.map(r => r.under))) {
    const left = options.filter(r => r.under === under && !taken.has(r.symbol));
    if (left.length !== 2) continue;
    const [a, b] = left;
    if (a.option?.type !== b.option?.type || Math.sign(a.qty) === Math.sign(b.qty) || Math.abs(a.qty) !== Math.abs(b.qty)) continue;
    left.forEach(r => taken.add(r.symbol));
    groups.push({ legs: left, by: 'pair' });
  }
  const pct = (/** @type {number} */ v) => acct > 0 ? v * 100 / acct : 0;
  const order = new Map(rows.map((r, i) => [r.symbol, i]));
  return groups.map(({ legs, by }) => spreadRow(legs, by, pct))
    .sort((a, b) => Number(order.get(a.legs[0].symbol)) - Number(order.get(b.legs[0].symbol)));
}

/** one spread from its legs, as the table shows it. @param {Row[]} legs @param {'order' | 'pair'} by @param {(v: number) => number} pct @returns {SpreadRow} */
function spreadRow(legs, by, pct) {
  legs = [...legs].sort((a, b) => Number(a.option?.strike) - Number(b.option?.strike) || String(a.option?.exp).localeCompare(String(b.option?.exp)));
  const opts = legs.map(l => /** @type {NonNullable<Row['option']>} */ (l.option));
  const mult = legs[0].mult;
  const units = Math.min(...legs.map(l => Math.abs(l.qty))) || 1;
  // net per spread: what the bought legs cost less what the sold ones took in
  const net = legs.reduce((n, l) => n + Math.sign(l.qty) * l.avg * Math.abs(l.qty), 0) / units;
  const kind = net >= 0 ? 'debit' : 'credit', sign = kind === 'debit' ? 1 : -1;
  const value = legs.reduce((n, l) => n + l.value, 0);
  const types = new Set(opts.map(o => o.type)), exps = new Set(opts.map(o => o.exp)), strikes = new Set(opts.map(o => o.strike));
  const type = opts[0].type === 'C' ? 'call' : 'put';
  const structure = types.size > 1 ? `${kind} spread` : exps.size === 1 ? `${type} ${kind}` : strikes.size === 1 ? 'time spread' : `${type} diagonal`;
  const root = legs[0].under;
  const label = exps.size === 1
    ? `${root} ${dateWords(opts[0].exp)} ${types.size === 1 ? `${opts.map(o => o.strike).join('/')}${opts[0].type}` : opts.map(o => `${o.strike}${o.type}`).join('/')}`
    : `${root} ${structure}`;
  const legWords = legs.map((l, i) => `${l.qty > 0 ? '+' : '−'}${Math.abs(l.qty).toLocaleString('en-US')} ${exps.size > 1 ? dateWords(opts[i].exp) + ' ' : ''}${opts[i].strike}${opts[i].type}`).join(' ');
  const priced = legs.every(l => l.avg > 0);
  // defined risk, on one bought and one sold contract of a type and size: a debit with the bought leg covering the sold one
  // (calls bought at or below, puts at or above; a vertical, calendar or diagonal) risks what it paid, a credit vertical its
  // width less the credit. Ratios, mixed types and more legs have none here
  const pair = legs.length === 2 && types.size === 1 && legs[0].qty === -legs[1].qty;
  const [bought, sold] = legs[0].qty > 0 ? opts : [opts[1], opts[0]];
  const covered = pair && (type === 'call' ? bought.strike <= sold.strike : bought.strike >= sold.strike);
  let maxLoss = null, riskBasis = /** @type {SpreadRow['riskBasis']} */ (null);
  if (priced && kind === 'debit' && net > 0 && covered) { maxLoss = net * units * mult; riskBasis = 'debit'; }
  else if (priced && kind === 'credit' && pair && exps.size === 1) {
    const width = Math.abs(opts[0].strike - opts[1].strike);
    if (width + net > 0) { maxLoss = (width + net) * units * mult; riskBasis = 'width'; }
  }
  const pnl = legs.every(l => l.pnl !== null) ? legs.reduce((n, l) => n + Number(l.pnl), 0) : null;
  const cost = Math.abs(net) * units * mult;
  const day = legs.every(l => l.day !== null) ? legs.reduce((n, l) => n + Number(l.day), 0) : null;
  const before = day === null ? 0 : Math.abs(value - day);
  return {
    key: legs.map(l => l.symbol).join(','), label, under: root, legs, legWords, structure, kind, by,
    qty: sign * units, units, mult, avg: priced ? Math.abs(net) : 0, price: sign * value / (units * mult), value, pctAcct: pct(Math.abs(value)),
    maxLoss, maxLossPct: maxLoss === null ? null : pct(maxLoss), riskBasis,
    pnl, pnlPct: pnl === null || !(cost > 0) ? null : pnl / cost * 100, day, dayPct: day === null || !before ? null : day / before * 100,
  };
}

/** a spread's R: open P/L over its defined max loss. @param {SpreadRow} s */
export function spreadR(s) {
  if (s.pnl === null) return { r: null, why: 'No average cost from Schwab on every leg.' };
  if (!s.maxLoss) return { r: null, why: 'No defined max loss to count R from.' };
  return { r: s.pnl / s.maxLoss, why: '' };
}

/**
 * @typedef {{ r: number | null, withTrims: number | null, risk: number | null, source: 'journal' | 'stop' | 'premium' | null,
 *   basis: string | null, stop: number | null, why: string, journalQty: number | null }} PositionR
 */

/**
 * How many R a position is up or down: open P/L ÷ the initial risk. The risk is the Journal's open trade on it (same account,
 * contract and direction, holding the same quantity): its first stop, your own stop, or a long option's premium, so a stop
 * trailed up later doesn't shrink it. Without one (signed out, not imported yet, the Journal holding another quantity, or the
 * contract inside a spread), it's the nearest working stop's distance from your average cost, or a long option's premium
 * with no stop. withTrims adds what the trade's exits already took (before fees, like Schwab's P/L), when it had some.
 * journalQty = the Journal's open quantity when it didn't match the position's.
 * @param {Row} row @param {import('./journal.js').Trade[] | null} trades the Journal's trades, null when they aren't read
 * @param {string} last4 @returns {PositionR}
 */
export function positionR(row, trades, last4) {
  const out = /** @type {PositionR} */ ({ r: null, withTrims: null, risk: null, source: null, basis: null, stop: null, why: '', journalQty: null });
  if (row.pnl === null) return { ...out, why: 'No average cost from Schwab.' };
  const long = row.qty > 0, held = Math.abs(row.qty);
  const t = (trades || []).find(x => x.status === 'open' && !x.deleted && x.kind !== 'spread' && x.account === last4
    && x.symbol === row.symbol && x.direction === (long ? 'long' : 'short'));
  if (t && t.risk && t.risk > 0.005 && Math.abs(t.openQty - held) < 1e-6) {
    const r = row.pnl / t.risk;
    return { ...out, r, withTrims: t.exits ? r + t.grossPnl / t.risk : null, risk: t.risk, source: 'journal', basis: t.rBasis, stop: t.stop };
  }
  const journalQty = t ? t.openQty : null;
  const near = row.stopOrders[0];
  if (near) {
    const dist = long ? row.avg - Number(near.stop) : Number(near.stop) - row.avg;
    if (dist <= 0) return { ...out, stop: near.stop, journalQty, why: 'The stop is at or past breakeven: no risk left to count R from.' };
    const risk = dist * held * row.mult;
    return { ...out, r: row.pnl / risk, risk, source: 'stop', basis: 'stop', stop: near.stop, journalQty };
  }
  if (row.option && long && row.avg > 0) {
    const risk = row.avg * held * row.mult;
    return { ...out, r: row.pnl / risk, risk, source: 'premium', basis: 'premium', journalQty };
  }
  return { ...out, journalQty, why: 'No stop to count R from.' };
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

/** a stop at or past breakeven: at or above it on a long, at or below it on a short. @param {Row} row @param {Resting} s */
const pastBe = (row, s) => row.be !== null && (row.qty > 0 ? Number(s.stop) >= row.be - 1e-9 : Number(s.stop) <= row.be + 1e-9);

/** How many shares stops at or past breakeven already cover, nearest first, up to what you hold. @param {Row} row */
export function breakevenCovered(row) {
  return Math.min(Math.abs(row.qty), row.stopOrders.filter(s => pastBe(row, s)).reduce((n, s) => n + s.qty, 0));
}

/** Every share already has a stop at or past breakeven, so there is nothing to move. @param {Row} row */
export const atBreakeven = (/** @type {Row} */ row) => row.be !== null && row.stops > 0 && breakevenCovered(row) >= Math.abs(row.qty);

/**
 * A breakeven stop without selling more than you hold, which Schwab refuses, and without loosening a stop: stops already
 * at or past breakeven stay as they are and keep covering their shares; only the shares without one get the breakeven stop.
 * What happens to orders that already sell part of the position (limits) is the caller's pick:
 * - 'pair': the shares a limit holds get a stop paired with that limit (one cancels the other), the rest one plain stop.
 *   The limits being re-paired are cancelled first, then the plain stops short of breakeven make room (the nearest moved,
 *   the others cancelled), then each limit is placed again with its stop; the paired shares have no stop for a moment.
 *   A pair whose stop is at or past breakeven stays as it is.
 * - 'keep': the limits stay as they are and their shares (bare) keep no stop; the rest get one plain stop.
 * - 'cancel': every other order that would close it is cancelled, then one plain stop covers what the stops at or past
 *   breakeven don't; refused when that would cancel a paired stop already past breakeven.
 * A stop limit moved to breakeven keeps its limit as far from the stop as it was; a trailing stop short of it is cancelled, not moved.
 * @param {Row} row @param {StopDuration} stopDuration @param {{ limits?: 'pair' | 'keep' | 'cancel' }} [opts] @returns {Plan}
 */
export function breakevenPlan(row, stopDuration, { limits = 'pair' } = {}) {
  const fail = (/** @type {string} */ error) => ({ error, stop: row.be || 0, steps: [], paired: [], rest: 0, bare: 0, kept: 0, locked: 0 });
  const blocked = tradeError(row);
  if (blocked) return fail(blocked);
  if (!(row.avg > 0) || row.be === null) return fail('Schwab shows no cost basis for this position, so it has no breakeven.');
  const long = row.qty > 0, be = row.be, held = Math.abs(row.qty), as = row.tradeAs || 'EQUITY', symbol = row.symbol;
  const px = (/** @type {number} */ p) => fmtPositionPrice(p, as);
  if (long ? !(row.price > be) : !(row.price < be)) {
    return fail(`The price ${px(row.price)} is at or ${long ? 'below' : 'above'} the breakeven stop ${px(be)}. It would ${INSTRUCTION_WORDS[closingInstruction(as, long)]} right away.`);
  }
  if (atBreakeven(row)) {
    return fail(row.stopOrders.every(s => s.stop === be) ? 'The position is already at breakeven: every share has a breakeven stop.'
      : 'Every share already has a stop at or past breakeven. Moving it would loosen it.');
  }
  const good = (/** @type {Resting} */ s) => pastBe(row, s);
  const stopFor = (/** @type {number} */ qty) => closeStopOrder({ symbol, assetType: as, isLong: long, qty, stop: be, stopDuration });
  const tick = as === 'OPTION' ? optionPriceTick : priceTick;
  /** a stop short of breakeven, moved there: a stop limit keeps its limit as far from the stop as it was. @param {Resting} s @param {number} qty */
  const moved = (s, qty) => {
    const limit = s.orderType === 'STOP_LIMIT' && s.price !== null ? tick(be + s.price - Number(s.stop)) : 0;
    return limit > 0 ? { ...stopFor(qty), orderType: 'STOP_LIMIT', price: limit } : stopFor(qty);
  };
  const plain = row.stopOrders.filter(o => o.oco === null); // nearest first, so the ones at or past breakeven lead
  const goodPlain = plain.filter(good).reduce((n, s) => n + s.qty, 0);
  const short = plain.filter(s => !good(s));
  /**
   * need shares at breakeven out of the stops short of it: the nearest one that isn't trailing moves there, the others go,
   * farthest first. clear: they go even when nothing is needed, to make room for a paired stop.
   * @param {number} need @param {boolean} clear @returns {Step[]}
   */
  const cover = (need, clear) => {
    if (need <= 0) return clear ? cancels([...short].reverse()) : [];
    const mover = short.find(s => !/TRAILING/.test(s.orderType));
    /** @type {Step[]} */
    const out = cancels(short.filter(s => s !== mover).reverse());
    out.push(mover ? { kind: 'replace', orderId: mover.orderId, was: mover, order: moved(mover, need) } : { kind: 'place', order: stopFor(need) });
    return out;
  };
  // what the plan locks over your cost: the stops kept where they are, then breakeven for the rest it covers
  const gain = (/** @type {number} */ p) => (long ? p - row.avg : row.avg - p) * row.mult;
  const lockedWith = (/** @type {number} */ bare) => {
    let left = held, sum = 0;
    for (const s of row.stopOrders.filter(good)) { const q = Math.min(left, s.qty); sum += gain(Number(s.stop)) * q; left -= q; }
    return sum + gain(be) * Math.max(0, left - bare);
  };
  const kept = breakevenCovered(row);
  if (limits === 'cancel') {
    const pairedPast = row.stopOrders.find(o => o.oco !== null && good(o));
    if (pairedPast) return fail(`Your stop ${px(Number(pairedPast.stop))} paired with a limit is already past breakeven. Cancelling it would loosen it.`);
    // the limits and pairs first, then the stops short of breakeven make room for one stop on the rest
    const steps = [...cancels([...closersInTheWay(row), ...row.stopOrders.filter(o => o.oco !== null)]), ...cover(held - goodPlain, true)];
    return { error: unnamed(steps), stop: be, steps, paired: [], rest: held, bare: 0, kept, locked: lockedWith(0) };
  }
  const pair = limits === 'pair';
  const holding = limitsHolding(row);
  if (holding.error) return fail(holding.error);
  const { targets, pairs, reserved } = holding;
  const rest = held - reserved;
  if (!pair && rest === 0) return fail('Your limit holds the whole position, so no shares are left for a separate stop. Pair it with a stop instead.');
  // a pair whose stop is already at or past breakeven stays as it is; without pairing, every limit does
  const repair = pair ? [...targets, ...pairs.filter(p => !p.legs.some(l => isStop(l) && good(l)))] : [];
  if (repair.length && goodPlain > rest) {
    return fail(`Stops at or past breakeven already cover ${goodPlain}, more than the ${rest} outside your limits, so a paired stop has no room. Cancel the limits instead.`);
  }
  const bare = pair ? 0 : targets.reduce((n, p) => n + Number(p.limit?.qty), 0);
  /** @type {Step[]} */
  const steps = [];
  for (const p of repair) steps.push(...cancels([...p.legs].sort((a, b) => Number(isStop(a)) - Number(isStop(b)))).map(s => ({ ...s, pairs: p.limit })));
  steps.push(...cover(rest - goodPlain, repair.length > 0));
  for (const { limit } of repair) {
    if (!limit || limit.price === null) continue;
    const target = closeLimitOrder({ symbol, assetType: as, isLong: long, qty: limit.qty, price: limit.price, duration: stopDuration });
    steps.push({ kind: 'place', order: ocoOrder(target, stopFor(limit.qty)), pairs: limit });
  }
  if (!steps.length) return fail(pair ? 'The position is already at breakeven: every share has a breakeven stop.' : 'The stops outside your limit are already at or past breakeven.');
  return { error: unnamed(steps), stop: be, steps, paired: repair.flatMap(p => p.limit ? [p.limit] : []), rest, bare, kept, locked: lockedWith(bare) };
}

/**
 * A working stop for fewer shares, otherwise as it was: its type (a stop limit keeps its limit), price, session and how long it lasts.
 * @param {Row} row @param {Resting} s @param {number} qty @param {StopDuration} duration what it lasts when Schwab shows something else
 */
function cutStop(row, s, qty, duration) {
  const lasts = s.duration === 'DAY' || s.duration === 'GOOD_TILL_CANCEL' ? s.duration : duration;
  const order = closeStopOrder({ symbol: row.symbol, assetType: row.tradeAs || 'EQUITY', isLong: row.qty > 0, qty, stop: Number(s.stop), stopDuration: lasts });
  return { ...order, session: s.session || 'NORMAL', ...(s.orderType === 'STOP_LIMIT' && s.price !== null ? { orderType: 'STOP_LIMIT', price: s.price } : {}) };
}

/**
 * The plain stops cut to cover `left` shares, nearest first; the farthest are cancelled, the boundary one replaced with fewer.
 * moved = the shares that lose their plain stop. A trailing stop can't be rebuilt here, so cutting one down is an error.
 * @param {Row} row @param {number} left @param {StopDuration} duration @returns {{ steps: Step[], moved: number, error: string }}
 */
function cutStops(row, left, duration) {
  let moved = 0, error = '';
  /** @type {Step[]} */
  const cuts = [];
  for (const s of row.stopOrders.filter(o => o.oco === null)) {
    const keep = Math.min(left, s.qty);
    left -= keep;
    if (keep === s.qty) continue;
    moved += s.qty - keep;
    if (keep && /TRAILING/.test(s.orderType)) error = `Your ${orderTypeWord(s.orderType)} for ${s.qty} can't be cut to fewer from here. Change it in Schwab first.`;
    cuts.push(keep ? { kind: 'replace', orderId: s.orderId, was: s, order: cutStop(row, s, keep, duration) } : { kind: 'cancel', orderId: s.orderId, was: s });
  }
  return { steps: cuts.reverse(), moved, error }; // farthest first, so the nearest is the last one touched
}

/**
 * The most the position held since it was last flat, read back from today's quantity through the fills in Schwab's orders
 * (children walked; cancels aren't fills): undo each fill, newest first, until the position would be flat or the other way. History older than
 * the orders read (Schwab's 60 days) or shares an option delivered (no order) can't be seen, so it's never less than held.
 * @param {Row} row @param {Order[]} orders @returns {number}
 */
export function originalQty(row, orders) {
  const held = Math.abs(row.qty), sign = Math.sign(row.qty);
  /** @type {{ at: number, qty: number }[]} */
  const fills = [], seen = new Set();
  const walk = (/** @type {Order} */ o) => {
    if (!o || typeof o !== 'object' || (o.orderId !== undefined && seen.has(o.orderId))) return;
    seen.add(o.orderId);
    const legs = o.orderLegCollection || [];
    for (const x of fillLegs(o)) {
      const leg = legs.find(l => l.legId !== undefined && l.legId === x.legId) || legs[0];
      const qty = Number(x.quantity);
      if (!leg || leg.instrument?.symbol !== row.symbol || !(qty > 0)) continue;
      fills.push({ at: schwabTime(x.time || o.closeTime || o.enteredTime || '') || 0, qty: /^BUY/.test(leg.instruction || '') ? qty : -qty });
    }
    (o.childOrderStrategies || []).forEach(walk);
  };
  (orders || []).forEach(walk);
  fills.sort((a, b) => b.at - a.at);
  let pos = row.qty, most = held;
  for (const f of fills) {
    pos -= f.qty;
    if (Math.sign(pos) !== sign) break;
    most = Math.max(most, Math.abs(pos));
  }
  return most;
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
 * stops (moved) have no stop until the pair is in. Stocks, ETFs and options: an option's target is on the option's own
 * price, on its grid ($0.05 under $3, $0.10 from $3), and pairs with the option's stop.
 * @param {Row} row @param {{ price: number, qty: number, duration: StopDuration }} target @returns {Plan}
 */
export function targetPlan(row, { price, qty, duration }) {
  const fail = (/** @type {string} */ error) => ({ error, stop: 0, steps: [], paired: [], rest: 0, bare: 0, price: 0, moved: 0 });
  const blocked = tradeError(row);
  if (blocked) return fail(blocked);
  const long = row.qty > 0, held = Math.abs(row.qty), symbol = row.symbol, assetType = row.tradeAs || 'EQUITY';
  const unit = assetType === 'OPTION' ? 'contracts' : 'shares', px = (/** @type {number} */ p) => fmtPositionPrice(p, assetType);
  if (!(price > 0)) return fail('Set a target price: tap the chart or type one.');
  const limit = assetType === 'OPTION' ? optionPriceTick(price) : priceTick(price);
  if (long ? !(limit > row.price) : !(limit < row.price)) {
    return fail(`The target ${px(limit)} is at or ${long ? 'below' : 'above'} the price ${px(row.price)}. It would ${long ? 'sell' : 'buy back'} right away.`);
  }
  const holding = limitsHolding(row);
  if (holding.error) return fail(holding.error);
  const free = held - holding.reserved;
  if (!Number.isInteger(qty) || qty < 1) return fail(`Pick how many ${unit} the target ${long ? 'sells' : 'buys back'}.`);
  if (qty > free) {
    return fail(!holding.reserved ? `The target is for ${qty} ${unit} and you hold ${held}.`
      : free > 0 ? `Your other targets hold ${holding.reserved} of the ${held} ${unit}, so this one can take up to ${free}.`
      : `Your targets already hold all ${held} ${unit}.`);
  }
  const { steps, moved, error } = cutStops(row, free - qty, duration);
  if (error) return fail(error);
  const stop = row.stop; // the nearest stop of any kind
  const target = closeLimitOrder({ symbol, assetType, isLong: long, qty, price: limit, duration });
  steps.push({ kind: 'place', order: stop === null ? target : ocoOrder(target, closeStopOrder({ symbol, assetType, isLong: long, qty, stop, stopDuration: duration })) });
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
 * Close all or part of the position, at market or at a limit, the way a broker's close ticket does. Schwab won't take orders
 * to close more than you hold, so room is made first. All of it: every order in play that would close it is cancelled,
 * targets first and the nearest stop last, so the position keeps a stop as long as it can. Part of it: targets stay, and the
 * plain stops are cut to the shares left. A limit goes in paired with the nearest stop for the same shares (one cancels the
 * other), so its shares keep a stop while it works. The close goes only if every step before it went through.
 * @param {Row} row
 * @param {{ type?: 'MARKET' | 'LIMIT', qty?: number, price?: number, duration?: StopDuration }} [ticket] all of it at market by default
 * @returns {Plan}
 */
export function closePlan(row, { type = 'MARKET', qty, price = 0, duration = 'DAY' } = {}) {
  const fail = (/** @type {string} */ error) => ({ error, stop: 0, steps: [], paired: [], rest: 0, bare: 0, price: 0, moved: 0 });
  const blocked = tradeError(row);
  if (blocked) return fail(blocked);
  const long = row.qty > 0, held = Math.abs(row.qty), assetType = row.tradeAs || 'EQUITY', n = qty ?? held;
  const what = (/** @type {number} */ k) => `${k.toLocaleString('en-US')} ${assetType === 'OPTION' ? (k === 1 ? 'contract' : 'contracts') : (k === 1 ? 'share' : 'shares')}`;
  if (!Number.isInteger(n) || n < 1) return fail(`Pick how many ${assetType === 'OPTION' ? 'contracts' : 'shares'} to ${long ? 'sell' : 'buy back'}.`);
  if (n > held) return fail(`You hold ${what(held)}.`);
  const limit = type === 'LIMIT' ? (assetType === 'OPTION' ? optionPriceTick(price) : priceTick(price)) : 0;
  if (type === 'LIMIT' && !(limit > 0)) return fail('Set a limit price.');
  /** @type {Step[]} */
  let steps;
  let moved = 0;
  if (n === held) {
    const others = row.closers.filter(o => !row.stopOrders.includes(o));
    steps = cancels([...others, ...[...row.stopOrders].reverse()]);
  } else {
    const holding = limitsHolding(row);
    if (holding.error) return fail(holding.error);
    const free = held - holding.reserved;
    if (n > free) return fail(`Your targets hold ${holding.reserved} of the ${what(held)}, so a partial close can take up to ${free}. Close all ${held} to cancel them too.`);
    const cut = cutStops(row, free - n, duration);
    if (cut.error) return fail(cut.error);
    ({ steps, moved } = cut);
  }
  const p = { symbol: row.symbol, assetType, isLong: long, qty: n };
  const stop = type === 'LIMIT' ? row.stop : null; // the nearest stop of any kind
  const close = type === 'LIMIT' ? closeLimitOrder({ ...p, price: limit, duration }) : closeMarketOrder(p);
  if (stop !== null && n === held) moved = held; // cancelled above, back once the pair is in
  steps.push({ kind: 'place', order: stop === null ? close : ocoOrder(close, closeStopOrder({ ...p, stop, stopDuration: duration })) });
  return { error: unnamed(steps), stop: stop ?? 0, steps, paired: [], rest: held - n, bare: 0, price: limit, moved };
}

// ---------- closing a spread as one order ----------

/**
 * @typedef {{ orderId: number | string | null, orderType: string, price: number | null, qty: number, legs: { symbol: string, qty: number }[], duration: string }} SpreadCloser
 * @typedef {{ error: string, steps: Step[], price: number, qty: number, ratios: number[], closers: SpreadCloser[] }} SpreadPlan
 */

/** working multi-leg orders that close any of a spread's legs (a spread close already in), with what each holds of every leg. @param {SpreadRow} s @param {Order[]} orders @returns {SpreadCloser[]} */
export function spreadClosers(s, orders) {
  const mine = new Set(s.legs.map(l => l.symbol));
  /** @type {SpreadCloser[]} */
  const out = [];
  const walk = (/** @type {Order} */ o) => {
    const legs = o.orderLegCollection || [];
    if (legs.length > 1 && o.status && !ENDED.has(o.status) && legs.some(l => mine.has(l.instrument?.symbol || '') && CLOSES[l.instruction || ''])) {
      const total = Number(o.quantity) || 0, left = Number(o.remainingQuantity) > 0 ? Number(o.remainingQuantity) : total;
      const share = total > 0 ? left / total : 1;
      out.push({ orderId: o.orderId ?? null, orderType: o.orderType || '', price: num(o.price), qty: left, duration: o.duration || '',
        legs: legs.map(l => ({ symbol: l.instrument?.symbol || '', qty: (Number(l.quantity) || 0) * share })) });
    }
    (o.childOrderStrategies || []).forEach(walk);
  };
  (orders || []).forEach(walk);
  return out;
}

/**
 * Close a spread, all or part, as ONE multi-leg order: each bought leg sold to close and each sold leg bought to close in the
 * legs' own ratio, at market or for a net limit (a debit spread closes for a credit, NET_CREDIT; a credit spread for a debit,
 * NET_DEBIT), on the option grid. All of it cancels every order in play that closes a leg first (spread closes, then the legs'
 * targets, then their stops), so nothing closes twice; part of it leaves them and fits in what they leave free on every leg.
 * @param {SpreadRow} s @param {Order[]} orders
 * @param {{ type?: 'MARKET' | 'LIMIT', qty?: number, price?: number, duration?: StopDuration }} [opts]
 * @returns {SpreadPlan}
 */
export function spreadClosePlan(s, orders, { type = 'LIMIT', qty, price = 0, duration = 'DAY' } = {}) {
  const closers = spreadClosers(s, orders);
  const fail = (/** @type {string} */ error) => ({ error, steps: [], price: 0, qty: 0, ratios: [], closers });
  const ratios = s.legs.map(l => Math.abs(l.qty) / s.units);
  if (ratios.some(r => !Number.isInteger(r))) return fail(`The legs (${s.legWords}) aren't in a whole ratio, so they can't go out as one order. Close them one by one under Legs.`);
  const n = qty ?? s.units, spreads = (/** @type {number} */ k) => `${k.toLocaleString('en-US')} ${k === 1 ? 'spread' : 'spreads'}`;
  if (!Number.isInteger(n) || n < 1) return fail('Pick how many spreads to close.');
  if (n > s.units) return fail(`You hold ${spreads(s.units)}.`);
  const limit = type === 'LIMIT' ? optionPriceTick(price) : 0;
  if (type === 'LIMIT' && !(limit > 0)) return fail('Set a net limit price above $0.');
  /** @type {Step[]} */
  let steps = [];
  if (n === s.units) {
    const multi = closers.map(c => /** @type {Resting} */ ({ orderId: c.orderId, symbol: s.key, closes: 'long', orderType: c.orderType, stop: null, price: c.price, qty: c.qty, oco: null, duration: c.duration, session: '' }));
    const legOthers = s.legs.flatMap(l => l.closers.filter(o => !l.stopOrders.includes(o)));
    const legStops = s.legs.flatMap(l => [...l.stopOrders].reverse());
    const seen = new Set();
    steps = cancels([...multi, ...legOthers, ...legStops].filter(o => { const k = String(o.orderId); if (o.orderId !== null && seen.has(k)) return false; seen.add(k); return true; }));
  } else {
    for (const [i, l] of s.legs.entries()) {
      const held = Math.abs(l.qty);
      const taken = Math.min(held, l.closers.reduce((t, o) => t + o.qty, 0) + closers.reduce((t, c) => t + c.legs.filter(x => x.symbol === l.symbol).reduce((q, x) => q + x.qty, 0), 0));
      const room = Math.floor((held - taken) / ratios[i] + 1e-9);
      if (n > room) return fail(`Other orders already close ${taken.toLocaleString('en-US')} of the ${l.label}, so a partial close can take up to ${spreads(room)}. Close all ${s.units} to cancel them too.`);
    }
  }
  steps.push({ kind: 'place', order: {
    orderType: type === 'MARKET' ? 'MARKET' : s.kind === 'debit' ? 'NET_CREDIT' : 'NET_DEBIT',
    session: 'NORMAL', duration: type === 'MARKET' ? 'DAY' : duration, orderStrategyType: 'SINGLE', ...(limit ? { price: limit } : {}),
    orderLegCollection: s.legs.map((l, i) => ({ instruction: l.qty > 0 ? 'SELL_TO_CLOSE' : 'BUY_TO_CLOSE', quantity: n * ratios[i], instrument: { symbol: l.symbol, assetType: 'OPTION' } })),
  } });
  return { error: unnamed(steps), steps, price: limit, qty: n, ratios, closers };
}
