// @ts-check
// Journal records, pure: the fills inside saved Schwab orders (each order's execution legs, child orders included) and a
// summary of what's been kept. The grouping into trades comes later (docs/journal-step-2.md); this only reads. Shares an
// option delivered (an assignment or exercise) have no order: they come from Schwab's transactions (assignmentFills).
// Futures aren't in Schwab's API: their fills come from a thinkorswim statement, kept as kind 'statement_fill' rows whose
// data is the fill itself (core/tos-statement.js).
import { expiryCloseMs, nyDate } from './options.js';
import { parseSchwabOption, positionLabel, schwabTime } from './positions.js';

/** @typedef {{ kind: string, record_id: string, account?: string, entered_at?: string | null, data: any }} SavedRecord */
/**
 * @typedef {{ id: string, orderId: string, account?: string, time: string, symbol: string, label: string, assetType: string,
 *   instruction: string, side: 'buy' | 'sell', qty: number, price: number, via?: Via }} Fill
 * @typedef {'assigned' | 'exercised' | 'delivered'} Via how shares came from an option: an assignment, an exercise, or one
 *   whose option is older than the history (delivered); the option's own closing fill says assigned or exercised too
 */

const BUYS = /^BUY/;
/** 'BUY_TO_COVER' → 'Buy to cover'. @param {string} instruction */
export const instructionWords = instruction => {
  const s = String(instruction || '').toLowerCase().replace(/_/g, ' ');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
};

/**
 * Every execution in an order and its children, one fill per execution leg, matched to its order leg by legId
 * (the first leg when Schwab sends no id). An execution without a positive quantity or price isn't a fill.
 * @param {any} order
 * @returns {Fill[]}
 */
export function orderFills(order) {
  /** @type {Fill[]} */
  const out = [];
  const walk = (/** @type {any} */ o) => {
    if (!o || typeof o !== 'object') return;
    const legs = Array.isArray(o.orderLegCollection) ? o.orderLegCollection : [];
    (o.orderActivityCollection || []).forEach((/** @type {any} */ a, /** @type {number} */ ai) => {
      if (a?.activityType && a.activityType !== 'EXECUTION') return;
      (a?.executionLegs || []).forEach((/** @type {any} */ x, /** @type {number} */ xi) => {
        const qty = Number(x?.quantity), price = Number(x?.price);
        if (!(qty > 0) || !(price > 0)) return;
        const leg = legs.find((/** @type {any} */ l) => l?.legId !== undefined && l.legId === x.legId) || legs[0] || {};
        const instrument = leg.instrument || {};
        const ms = schwabTime(x.time || o.closeTime || o.enteredTime);
        out.push({
          id: `${o.orderId}:${a.activityId ?? ai}:${x.legId ?? 0}:${xi}`,
          orderId: String(o.orderId ?? ''),
          time: Number.isFinite(ms) ? new Date(ms).toISOString() : '',
          symbol: instrument.symbol || '',
          label: positionLabel(instrument),
          assetType: instrument.assetType || '',
          instruction: leg.instruction || '',
          side: BUYS.test(leg.instruction || '') ? 'buy' : 'sell',
          qty, price,
        });
      });
    });
    (o.childOrderStrategies || []).forEach(walk);
  };
  walk(order);
  return out;
}

/** 'Buy to close', or 'Buy to close (assigned)' for a fill an option delivered. @param {Fill} f */
export const fillWords = f => `${instructionWords(f.instruction)}${f.via ? ` (${f.via})` : ''}`;

/** a statement fill as kept: the fill, if it has what one needs. @param {any} d @returns {Fill | null} */
const statementFill = d => d && typeof d.id === 'string' && d.symbol && d.time && d.qty > 0 && d.price > 0 && (d.side === 'buy' || d.side === 'sell')
  ? { id: d.id, orderId: String(d.orderId || d.id), time: d.time, symbol: d.symbol, label: d.label || d.symbol, assetType: d.assetType || 'FUTURE',
    instruction: d.instruction || '', side: d.side, qty: Number(d.qty), price: Number(d.price) }
  : null;

/** all fills in the saved orders, the assignments in its transactions and the statement fills, newest first, each once. @param {SavedRecord[]} records */
export function fillsFrom(records) {
  const seen = new Set();
  /** @type {Fill[]} */
  const fills = [];
  for (const r of records) {
    if (r.kind !== 'order') continue;
    for (const f of orderFills(r.data)) if (!seen.has(f.id)) { seen.add(f.id); fills.push({ ...f, account: r.account || '' }); }
  }
  fills.push(...assignmentFills(records, fills));
  for (const r of records) {
    const f = r.kind === 'statement_fill' ? statementFill(r.data) : null;
    if (f && !seen.has(f.id)) { seen.add(f.id); fills.push({ ...f, account: r.account || '' }); }
  }
  return fills.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
}

/** an assignment's stock leg: what the shares did. @param {number} amount @param {string} effect */
const deliveryInstruction = (amount, effect) => effect === 'CLOSING' ? (amount < 0 ? 'SELL' : 'BUY_TO_COVER') : amount > 0 ? 'BUY' : 'SELL_SHORT';

/**
 * Shares an option delivered. Schwab posts an assignment or exercise as a TRADE transaction with no orderId: its stock
 * leg is priced at the strike, positionEffect OPENING when shares come in and CLOSING when they go out, and
 * settlementDate is the day it happened (the posting comes overnight, tradeDate the next session). The option leg isn't
 * in it, so it's found among the fills: an open contract in that account on that underlying at that strike, expiring
 * that day or later, short (assigned) before long (exercised), nearest expiry first; shares in = a put sold or a call
 * bought, shares out = a call sold or a put bought. Each becomes fills at that day's 4pm New York close: the shares at the
 * strike, and the contracts closed at $0, so the premium stays the option's P&L and the shares cost the strike. With no
 * open contract (sold before the history) the shares come alone, via 'delivered'.
 * @param {SavedRecord[]} records @param {Fill[]} fills the order fills, to find the options in
 * @returns {Fill[]}
 */
export function assignmentFills(records, fills) {
  const txs = records
    .filter(r => r.kind === 'transaction' && r.data?.type === 'TRADE' && (r.data.orderId === undefined || r.data.orderId === null))
    .map(r => {
      const ms = schwabTime(r.data.settlementDate || r.data.time);
      return { r, at: Number.isFinite(ms) ? expiryCloseMs(nyDate(ms)) : NaN };
    })
    .filter(x => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at);
  /** @type {Fill[]} */
  const out = [];
  for (const { r, at } of txs) {
    const tx = r.data, account = r.account || '', id = String(tx.activityId ?? r.record_id), time = new Date(at).toISOString(), day = nyDate(at);
    (Array.isArray(tx.transferItems) ? tx.transferItems : []).forEach((/** @type {any} */ item, /** @type {number} */ i) => {
      const inst = item?.instrument || {}, amount = Number(item?.amount), price = Number(item?.price);
      if (item?.feeType || inst.assetType === 'CURRENCY' || inst.assetType === 'OPTION' || !inst.symbol || !amount || !(price > 0)) return;
      const sharesIn = amount > 0;
      // open contracts at the strike, from every fill up to then (an earlier assignment's included)
      /** @type {Map<string, number>} */
      const open = new Map();
      for (const f of [...fills, ...out]) {
        if (f.assetType !== 'OPTION' || (f.account || '') !== account || f.time > time) continue;
        open.set(f.symbol, (open.get(f.symbol) || 0) + (f.side === 'buy' ? f.qty : -f.qty));
      }
      const picks = [...open].flatMap(([symbol, pos]) => {
        const o = parseSchwabOption(symbol);
        if (!o || o.root !== inst.symbol || Math.abs(o.strike - price) > 1e-6 || o.exp < day || Math.abs(pos) < 1e-9) return [];
        const assigned = pos < 0 && o.type === (sharesIn ? 'P' : 'C'), exercised = pos > 0 && o.type === (sharesIn ? 'C' : 'P');
        return assigned || exercised ? [{ symbol, pos, exp: o.exp, via: /** @type {Via} */ (assigned ? 'assigned' : 'exercised') }] : [];
      }).sort((a, b) => (a.via === b.via ? (a.exp < b.exp ? -1 : a.exp > b.exp ? 1 : 0) : a.via === 'assigned' ? -1 : 1));
      let need = Math.abs(amount) / 100;
      /** @type {Via} */
      let via = 'delivered';
      picks.forEach((p, j) => {
        const qty = Math.min(need, Math.abs(p.pos));
        if (!(qty > 1e-9)) return;
        need -= qty;
        if (via === 'delivered') via = p.via;
        out.push({
          id: `tx:${id}:${i}:option:${j}`, orderId: `tx:${id}:option`, account, time, symbol: p.symbol,
          label: positionLabel({ assetType: 'OPTION', symbol: p.symbol }), assetType: 'OPTION',
          instruction: p.pos < 0 ? 'BUY_TO_CLOSE' : 'SELL_TO_CLOSE', side: p.pos < 0 ? 'buy' : 'sell', qty, price: 0, via: p.via,
        });
      });
      const instruction = deliveryInstruction(amount, item.positionEffect);
      out.push({
        id: `tx:${id}:${i}`, orderId: `tx:${id}`, account, time, symbol: inst.symbol, label: inst.symbol, assetType: inst.assetType || 'EQUITY',
        instruction, side: BUYS.test(instruction) ? 'buy' : 'sell', qty: Math.abs(amount), price, via,
      });
    });
  }
  return out;
}

/** what's kept: order, transaction and statement fill counts and the span of their times. @param {SavedRecord[]} records */
export function recordsSummary(records) {
  let orders = 0, transactions = 0, statementFills = 0, first = '', last = '';
  for (const r of records) {
    if (r.kind === 'order') orders++; else if (r.kind === 'transaction') transactions++; else if (r.kind === 'statement_fill') statementFills++;
    const t = r.entered_at || '';
    if (!t) continue;
    if (!first || t < first) first = t;
    if (!last || t > last) last = t;
  }
  return { orders, transactions, statementFills, first, last };
}
