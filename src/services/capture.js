// Raw capture: reads Schwab's orders and TRADE transactions and keeps them, untouched apart from masked account
// numbers, in the signed-in account's schwab_records, so history outlives Schwab's window. Each import is a delta: it
// fingerprints every record, reads what's kept for those ids, and sends only what's new or changed. Never touches the page.
import { state } from '../state.js';
import { store } from '../lib/store.js';
import { captureRows, planDelta, stableJson, transactionStart, FALLBACK_DAYS } from '../core/schwab-history.js';
import { schwabAccount, schwabConnected, schwabRecentOrders, schwabSession, schwabTransactions } from './schwab.js';
import { supabaseClient } from './supabase.js';

const DAY = 86400000;
const BATCH = 200;
/** automatic captures run at most this often; Save now runs any time */
export const CAPTURE_EVERY = 6 * 3600000;

/** SHA-256 hex of text, the browser's own hashing @param {string} text */
async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** a failed Supabase answer as an Error that carries its HTTP status */
function refused(res, fallback) {
  const err = new Error(res.error.message || fallback);
  err.status = res.status || 0;
  return err;
}

/** what's kept for these rows: 'kind:id' → fingerprint (null for rows saved before fingerprints) */
async function keptFingerprints(client, rows, ensureCurrent) {
  /** @type {Map<string, string | null>} */
  const stored = new Map();
  for (const kind of ['order', 'transaction']) {
    const ids = rows.filter(r => r.kind === kind).map(r => r.record_id);
    for (let i = 0; i < ids.length; i += BATCH) {
      ensureCurrent();
      const res = await client.from('schwab_records').select('record_id,fingerprint').eq('kind', kind).in('record_id', ids.slice(i, i + BATCH));
      ensureCurrent();
      if (res?.error) throw refused(res, 'Supabase refused the read.');
      for (const r of res.data || []) stored.set(kind + ':' + r.record_id, r.fingerprint ?? null);
    }
  }
  return stored;
}

/** the last successful capture on this device: { at, user, account, orders, transactions, skipped, newOrders, updatedOrders, newTrades, kept }, or null */
export function lastCapture() {
  try { return JSON.parse(store.get('schwab_capture') || 'null'); } catch(e) { return null; }
}

/** both logins are in place: a Google session to save into, and a Schwab account to read */
export function captureReady() { return !!state.session && schwabConnected(); }

/** the last capture, when it was for this Google user and Schwab account */
function lastHere() {
  const last = lastCapture();
  return last && last.user === state.session?.user?.id && last.account === schwabAccount()?.last4 ? last : null;
}

/** an automatic capture is due: never ran for this user and account, or the last one is older than CAPTURE_EVERY */
export function captureDue(now = Date.now()) {
  const last = lastHere();
  return !last || now - last.at >= CAPTURE_EVERY;
}

/**
 * Read and keep. Orders: the last 59 days (Schwab's window is 60). Transactions: from a week before the last capture,
 * or a year back the first time; if Schwab refuses a range that wide, the last 59 days instead.
 * @param {number} [now]
 */
export async function captureSchwab(now = Date.now()) {
  if (!state.session) throw new Error('Sign in with Google to keep your Schwab history.');
  if (!schwabConnected()) throw new Error('Log in to Schwab first.');
  const acct = schwabAccount();
  const userId = state.session.user.id;
  const connectionId = schwabSession().connectionId;
  const ensureCurrent = () => {
    if (state.session?.user?.id !== userId || schwabSession()?.connectionId !== connectionId || schwabAccount()?.hash !== acct.hash) {
      throw new Error('Your Google or Schwab account changed. Import canceled.');
    }
  };
  const last = lastHere();
  const start = transactionStart(now, last ? last.at : undefined);
  const orders = await schwabRecentOrders(now, acct.hash);
  ensureCurrent();
  let transactions;
  try {
    transactions = await schwabTransactions(start, now, acct.hash);
  } catch(e) {
    ensureCurrent();
    if (!e?.status || now - start <= FALLBACK_DAYS * DAY) throw e; // a network failure, or already the short range
    transactions = await schwabTransactions(now - FALLBACK_DAYS * DAY, now, acct.hash);
  }
  ensureCurrent();
  const { rows: read, skipped } = captureRows({ orders, transactions, last4: acct.last4, userId });
  const rows = await Promise.all(read.map(async r => ({ ...r, fingerprint: await sha256(stableJson(r.data)) })));
  const client = await supabaseClient();
  ensureCurrent();
  const delta = planDelta(rows, await keptFingerprints(client, rows, ensureCurrent));
  // an order's newer copy replaces the kept one; a trade never changes, so a kept one is never overwritten (do nothing on conflict)
  for (const [list, opts] of [[delta.orders, undefined], [delta.trades, { onConflict: 'user_id,kind,record_id', ignoreDuplicates: true }]]) {
    for (let i = 0; i < list.length; i += BATCH) {
      ensureCurrent();
      const res = await client.from('schwab_records').upsert(list.slice(i, i + BATCH), opts);
      ensureCurrent();
      if (res?.error) throw refused(res, 'Supabase refused the records.');
    }
  }
  const result = {
    at: now, user: userId, account: acct.last4, orders: orders.length, transactions: transactions.length, skipped,
    newOrders: delta.newOrders, updatedOrders: delta.updatedOrders, newTrades: delta.newTrades, kept: delta.kept,
  };
  ensureCurrent();
  store.set('schwab_capture', JSON.stringify(result));
  return result;
}
