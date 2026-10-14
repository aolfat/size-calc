// Raw capture: reads Schwab's orders and TRADE transactions and keeps them, untouched apart from masked account
// numbers, in the signed-in account's schwab_records, so history outlives Schwab's window. Never touches the page.
import { state } from '../state.js';
import { store } from '../lib/store.js';
import { captureRows, transactionStart, FALLBACK_DAYS } from '../core/schwab-history.js';
import { schwabAccount, schwabConnected, schwabRecentOrders, schwabTransactions } from './schwab.js';
import { supabaseClient } from './supabase.js';

const DAY = 86400000;
const BATCH = 200;
/** automatic captures run at most this often; Save now runs any time */
export const CAPTURE_EVERY = 6 * 3600000;

/** the last successful capture on this device: { at, user, account, orders, transactions, skipped }, or null */
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
  const last = lastHere();
  const start = transactionStart(now, last ? last.at : undefined);
  const orders = await schwabRecentOrders(now);
  let transactions;
  try {
    transactions = await schwabTransactions(start, now);
  } catch(e) {
    if (!e?.status || now - start <= FALLBACK_DAYS * DAY) throw e; // a network failure, or already the short range
    transactions = await schwabTransactions(now - FALLBACK_DAYS * DAY, now);
  }
  const { rows, skipped } = captureRows({ orders, transactions, last4: acct.last4, userId: state.session.user.id });
  const client = await supabaseClient();
  for (let i = 0; i < rows.length; i += BATCH) {
    const res = await client.from('schwab_records').upsert(rows.slice(i, i + BATCH));
    if (res?.error) {
      const err = new Error(res.error.message || 'Supabase refused the records.');
      err.status = res.status || 0;
      throw err;
    }
  }
  const result = { at: now, user: state.session.user.id, account: acct.last4, orders: orders.length, transactions: transactions.length, skipped };
  store.set('schwab_capture', JSON.stringify(result));
  return result;
}
