// @ts-check
// Schwab history, pure: masks account numbers, summarizes what a read returned (the spike's export), and turns raw
// orders and transactions into the rows raw capture keeps in Supabase. No network, no storage.

const ACCOUNT_KEY = /^(accountNumber|accountId|hashValue|accountHash)$/i;

/** '••6789' for an account number, '••' when it's too short to keep any digits. @param {unknown} v */
export function maskAccount(v) {
  const s = String(v ?? '');
  return s.length > 4 ? '••' + s.slice(-4) : '••';
}

/**
 * A deep copy with every account number or hash masked, wherever it sits.
 * @param {any} v
 * @returns {any}
 */
export function scrubAccounts(v) {
  if (Array.isArray(v)) return v.map(scrubAccounts);
  if (v && typeof v === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = ACCOUNT_KEY.test(k) && (typeof x === 'string' || typeof x === 'number') ? maskAccount(x) : scrubAccounts(x);
    return out;
  }
  return v;
}

/**
 * How much a read returned and the time span it covers: the answer to "how far back does Schwab go".
 * @param {any[]} rows @param {string[]} timeKeys the first key present on a row is its time
 */
export function spanOf(rows, timeKeys) {
  let first = '', last = '';
  for (const r of rows) {
    const t = timeKeys.map(k => r && r[k]).find(Boolean);
    if (!t) continue;
    if (!first || t < first) first = t;
    if (!last || t > last) last = t;
  }
  return { count: rows.length, first, last };
}

const DAY = 86400000;
/** the widest transaction range tried; Schwab may refuse it, and capture falls back to FALLBACK_DAYS */
export const MAX_DAYS = 365;
export const FALLBACK_DAYS = 59;
/** each capture re-reads this much before the last one, so a late-posting transaction isn't missed */
export const OVERLAP_DAYS = 7;

/** Schwab's '+0000' offsets made ISO, or null. Safari can't parse the colon-less form. @param {unknown} t */
export function isoTime(t) {
  if (!t) return null;
  const ms = Date.parse(String(t).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Where a transaction read starts: a week before the last capture, or as far back as Schwab may allow on the first one.
 * @param {number} now @param {number} [lastAt] ms of the last successful capture
 */
export function transactionStart(now, lastAt) {
  const widest = now - MAX_DAYS * DAY;
  return lastAt ? Math.max(widest, lastAt - OVERLAP_DAYS * DAY) : widest;
}

/**
 * Raw orders and transactions as schwab_records rows: Schwab's JSON kept whole, account numbers masked, one row per
 * order (child orders stay inside their parent) and per transaction. Records without an id are counted, not kept.
 * @param {{ orders: any[], transactions: any[], last4: string, userId: string }} input
 */
export function captureRows({ orders, transactions, last4, userId }) {
  /** @type {{ user_id: string, kind: string, record_id: string, account: string, entered_at: string | null, data: any }[]} */
  const rows = [];
  let skipped = 0;
  const add = (/** @type {string} */ kind, /** @type {any} */ r, /** @type {unknown} */ id, /** @type {unknown} */ at) => {
    if (id === undefined || id === null || id === '') { skipped++; return; }
    rows.push({ user_id: userId, kind, record_id: String(id).slice(0, 64), account: String(last4).slice(-4), entered_at: isoTime(at), data: scrubAccounts(r) });
  };
  for (const o of orders) add('order', o, o?.orderId, o?.enteredTime);
  for (const t of transactions) add('transaction', t, t?.activityId, t?.time || t?.tradeDate);
  // the same record twice in one read (Schwab repeating a row): the later copy wins, one row per id
  const byKey = new Map(rows.map(r => [r.kind + ':' + r.record_id, r]));
  return { rows: [...byKey.values()], skipped };
}

/**
 * JSON with object keys sorted, so the same record fingerprints the same however it was stored (Postgres jsonb
 * reorders keys) or sent (Schwab's key order isn't promised).
 * @param {any} v
 * @returns {string}
 */
export function stableJson(v) {
  if (Array.isArray(v)) return '[' + v.map(x => stableJson(x === undefined ? null : x)).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * What an import sends, against what's already kept (stored: 'kind:id' → fingerprint, or null when the row predates
 * fingerprints). A trade (transaction) never changes once posted: new ones are sent, kept ones skipped. An order is
 * sent when it's new or its fingerprint changed (status, fills); a kept row with no fingerprint is rewritten to fill
 * one in, counted as kept, not changed.
 * @template {{ kind: string, record_id: string, fingerprint: string }} R
 * @param {R[]} rows @param {Map<string, string | null>} stored
 */
export function planDelta(rows, stored) {
  /** @type {R[]} */
  const orders = [];
  /** @type {R[]} */
  const trades = [];
  let newOrders = 0, updatedOrders = 0, newTrades = 0, kept = 0;
  for (const r of rows) {
    const key = r.kind + ':' + r.record_id;
    const have = stored.has(key);
    const was = stored.get(key);
    if (r.kind === 'transaction') {
      if (have) { kept++; if (was === null) trades.push(r); continue; }
      newTrades++; trades.push(r);
    } else if (!have) { newOrders++; orders.push(r); }
    else if (was === null) { kept++; orders.push(r); }
    else if (was !== r.fingerprint) { updatedOrders++; orders.push(r); }
    else kept++;
  }
  return { orders, trades, newOrders, updatedOrders, newTrades, kept };
}

/** what an import did, in words: '3 new trades, 2 orders updated, 71 already kept'. @param {{ newOrders?: number, updatedOrders?: number, newTrades?: number, kept?: number }} r */
export function importWords(r) {
  const n = (/** @type {number | undefined} */ k, /** @type {string} */ one, /** @type {string} */ many) => `${k} ${k === 1 ? one : many}`;
  const parts = [];
  if (r.newTrades) parts.push(n(r.newTrades, 'new trade', 'new trades'));
  if (r.newOrders) parts.push(n(r.newOrders, 'new order', 'new orders'));
  if (r.updatedOrders) parts.push(n(r.updatedOrders, 'order updated', 'orders updated'));
  const kept = `${r.kept || 0} already kept`;
  return parts.length ? `${parts.join(', ')}, ${kept}` : `Nothing new, ${kept}`;
}
