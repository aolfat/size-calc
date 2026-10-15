// Journal reads and writes: the signed-in account's kept Schwab records, newest first, from Supabase's schwab_records,
// and the trades you shaped (merged trades and spreads: each row's fill ids) in its trades table. Row-level security
// means only your own rows come back. Never touches the page.
import { state } from '../state.js';
import { supabaseClient } from './supabase.js';

/** how many records one read brings back; plenty for months of trading, raised once slices 2 to 4 need everything */
export const JOURNAL_READ_LIMIT = 5000;

/** Supabase's answer, or its refusal as an error. @param {any} res @param {string} fallback */
function checked(res, fallback) {
  if (!res?.error) return res;
  const err = new Error(res.error.message || fallback);
  err.status = res.status || 0;
  throw err;
}

async function client() {
  if (!state.session) throw new Error('Sign in with Google to see your journal.');
  return supabaseClient();
}

/** @returns {Promise<{ kind: string, record_id: string, account: string, entered_at: string | null, data: any }[]>} */
export async function loadSavedRecords() {
  const c = await client();
  const res = checked(await c.from('schwab_records').select('kind,record_id,account,entered_at,data')
    .order('entered_at', { ascending: false }).limit(JOURNAL_READ_LIMIT), 'Supabase refused the read.');
  return res.data || [];
}

/** @returns {Promise<{ id: string, account: string, fill_ids: string[], created_at: string }[]>} */
export async function loadSavedTrades() {
  const c = await client();
  const res = checked(await c.from('trades').select('id,account,fill_ids,created_at')
    .order('created_at', { ascending: true }).limit(JOURNAL_READ_LIMIT), 'Supabase refused the read.');
  return res.data || [];
}

/** a new merged trade. @param {{ id: string, account: string, fill_ids: string[] }} row */
export async function insertSavedTrade(row) {
  const c = await client();
  checked(await c.from('trades').insert([row]), 'Supabase refused the save.');
}

/** a merged trade takes in more fills. @param {string} id @param {string[]} fillIds */
export async function updateSavedTrade(id, fillIds) {
  const c = await client();
  checked(await c.from('trades').update({ fill_ids: fillIds }).eq('id', id), 'Supabase refused the save.');
}

/** @param {string[]} ids */
export async function deleteSavedTrades(ids) {
  if (!ids.length) return;
  const c = await client();
  checked(await c.from('trades').delete().in('id', ids), 'Supabase refused the delete.');
}
