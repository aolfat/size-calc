// @ts-check
// Journal records, pure: the fills inside saved Schwab orders (each order's execution legs, child orders included) and a
// summary of what's been kept. The grouping into trades comes later (docs/journal-step-2.md); this only reads.
import { positionLabel, schwabTime } from './positions.js';

/** @typedef {{ kind: string, record_id: string, account?: string, entered_at?: string | null, data: any }} SavedRecord */
/**
 * @typedef {{ id: string, orderId: string, account?: string, time: string, symbol: string, label: string, assetType: string,
 *   instruction: string, side: 'buy' | 'sell', qty: number, price: number }} Fill
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

/** all fills in the saved orders, newest first, each once. @param {SavedRecord[]} records */
export function fillsFrom(records) {
  const seen = new Set();
  /** @type {Fill[]} */
  const fills = [];
  for (const r of records) {
    if (r.kind !== 'order') continue;
    for (const f of orderFills(r.data)) if (!seen.has(f.id)) { seen.add(f.id); fills.push({ ...f, account: r.account || '' }); }
  }
  return fills.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
}

/** what's kept: order and transaction counts and the span of their times. @param {SavedRecord[]} records */
export function recordsSummary(records) {
  let orders = 0, transactions = 0, first = '', last = '';
  for (const r of records) {
    if (r.kind === 'order') orders++; else if (r.kind === 'transaction') transactions++;
    const t = r.entered_at || '';
    if (!t) continue;
    if (!first || t < first) first = t;
    if (!last || t > last) last = t;
  }
  return { orders, transactions, first, last };
}
