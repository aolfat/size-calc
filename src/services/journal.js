// Journal reads and writes: the signed-in account's kept Schwab records (schwab_records, newest first), your word on
// each trade (trade_reviews: your stop, hidden), and the trades you shaped (trades: merged trades and spreads, each row
// the fill ids it claims). Row-level security means only your own rows come back. Never touches the page.
import { state } from '../state.js';
import { supabaseClient } from './supabase.js';

/** how many records one read brings back; plenty for months of trading, raised once slices 2 to 4 need everything */
export const JOURNAL_READ_LIMIT = 5000;

/** @returns {Promise<{ kind: string, record_id: string, account: string, entered_at: string | null, data: any }[]>} */
export async function loadSavedRecords() {
  if (!state.session) throw new Error('Sign in with Google to see your journal.');
  const client = await supabaseClient();
  const res = await client.from('schwab_records').select('kind,record_id,account,entered_at,data')
    .order('entered_at', { ascending: false }).limit(JOURNAL_READ_LIMIT);
  if (res?.error) {
    const err = new Error(res.error.message || 'Supabase refused the read.');
    err.status = res.status || 0;
    throw err;
  }
  return res.data || [];
}

const refused = (res, what) => {
  if (!res?.error) return;
  const err = new Error(res.error.message || what);
  err.status = res.status || 0;
  throw err;
};

/** the migration not pushed yet: PostgREST says 'Could not find the table … in the schema cache', Postgres 'does not exist' */
const missingTable = (/** @type {any} */ res) => res?.error && /schema cache|does not exist/i.test(res.error.message || '');

/** your stops and deletes, by trade key. @returns {Promise<Record<string, { stop: number | null, hidden: boolean }>>} */
export async function loadTradeReviews() {
  if (!state.session) throw new Error('Sign in with Google to see your journal.');
  const client = await supabaseClient();
  const res = await client.from('trade_reviews').select('trade_key,stop,hidden').limit(JOURNAL_READ_LIMIT);
  if (missingTable(res)) throw new Error("the database doesn't have the trade_reviews table yet");
  refused(res, 'Supabase refused the read.');
  /** @type {Record<string, { stop: number | null, hidden: boolean }>} */
  const out = {};
  for (const r of res.data || []) out[r.trade_key] = { stop: r.stop === null || r.stop === undefined ? null : Number(r.stop), hidden: !!r.hidden };
  return out;
}

/** save review rows whole (stop and hidden), so one field never clears the other. @param {Record<string, { stop?: number | null, hidden?: boolean }>} rows by trade key */
export async function saveTradeReviews(rows) {
  if (!state.session) throw new Error('Sign in with Google to save this.');
  const client = await supabaseClient();
  const list = Object.entries(rows).map(([key, r]) => ({ trade_key: key, stop: r.stop ?? null, hidden: !!r.hidden }));
  refused(await client.from('trade_reviews').upsert(list, { onConflict: 'user_id,trade_key' }), 'Supabase refused the save.');
}

/** save one trade's review row. @param {string} key @param {{ stop?: number | null, hidden?: boolean }} review */
export const saveTradeReview = (key, review) => saveTradeReviews({ [key]: review });

/** the trades you shaped, oldest first. @returns {Promise<{ id: string, account: string, fill_ids: string[], created_at: string }[]>} */
export async function loadSavedTrades() {
  if (!state.session) throw new Error('Sign in with Google to see your journal.');
  const client = await supabaseClient();
  const res = await client.from('trades').select('id,account,fill_ids,created_at').order('created_at', { ascending: true }).limit(JOURNAL_READ_LIMIT);
  if (missingTable(res)) throw new Error("the database doesn't have the trades table yet");
  refused(res, 'Supabase refused the read.');
  return res.data || [];
}

/** new trades rows (a merge, or legs kept on their own). @param {{ id: string, account: string, fill_ids: string[] }[]} rows */
export async function insertSavedTrades(rows) {
  if (!rows.length) return;
  if (!state.session) throw new Error('Sign in with Google to save this.');
  const client = await supabaseClient();
  refused(await client.from('trades').insert(rows), 'Supabase refused the save.');
}

/** a shaped trade takes in more fills. @param {string} id @param {string[]} fillIds */
export async function updateSavedTrade(id, fillIds) {
  if (!state.session) throw new Error('Sign in with Google to save this.');
  const client = await supabaseClient();
  refused(await client.from('trades').update({ fill_ids: fillIds }).eq('id', id), 'Supabase refused the save.');
}

/** @param {string[]} ids */
export async function deleteSavedTrades(ids) {
  if (!ids.length) return;
  if (!state.session) throw new Error('Sign in with Google to save this.');
  const client = await supabaseClient();
  refused(await client.from('trades').delete().in('id', ids), 'Supabase refused the delete.');
}
