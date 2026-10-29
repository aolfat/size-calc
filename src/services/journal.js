// Journal reads and writes: the signed-in account's kept Schwab records (schwab_records, newest first), your word on
// each trade (trade_reviews: your stop, deleted, setup on), and the trades you shaped (trades: merged trades and spreads, each row
// the fill ids it claims). Row-level security means only your own rows come back. Never touches the page. Futures fills from a
// thinkorswim statement are kept in schwab_records too, as kind 'statement_fill' (saveStatementFills).
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

/**
 * Futures fills read from a thinkorswim statement, into schwab_records (kind 'statement_fill'). A fill already kept is
 * left as it is (on conflict do nothing), so the same file, or an overlapping one, can be imported again.
 * @param {{ kind: string, record_id: string, account: string, entered_at: string, data: any }[]} rows
 */
export async function saveStatementFills(rows) {
  if (!rows.length) return;
  if (!state.session) throw new Error('Sign in with Google to save this.');
  const client = await supabaseClient();
  for (let i = 0; i < rows.length; i += 200) {
    const res = await client.from('schwab_records').upsert(rows.slice(i, i + 200), { onConflict: 'user_id,kind,record_id', ignoreDuplicates: true });
    if (res?.error && /check constraint|statement_fill/i.test(res.error.message || '')) throw new Error("the database doesn't take futures fills yet: run npx supabase db push");
    refused(res, 'Supabase refused the save.');
  }
}

const refused = (res, what) => {
  if (!res?.error) return;
  const err = new Error(res.error.message || what);
  err.status = res.status || 0;
  throw err;
};

/** the migration not pushed yet: PostgREST says 'Could not find the table … in the schema cache', Postgres 'does not exist' */
const missingTable = (/** @type {any} */ res) => res?.error && /schema cache|does not exist/i.test(res.error.message || '');

/**
 * your stops and deletes, by trade key, and a leveraged ETF's trade you keep on the fund (setupOn, trade_reviews.setup_on,
 * its own migration: read on its own, so a database without the column yet still has every trade, each on its underlying).
 * @returns {Promise<Record<string, { stop: number | null, deleted: boolean, setupOn?: string }>>}
 */
export async function loadTradeReviews() {
  if (!state.session) throw new Error('Sign in with Google to see your journal.');
  const client = await supabaseClient();
  const [res, on] = await Promise.all([
    client.from('trade_reviews').select('trade_key,stop,deleted').limit(JOURNAL_READ_LIMIT),
    client.from('trade_reviews').select('trade_key,setup_on').limit(JOURNAL_READ_LIMIT),
  ]);
  if (missingTable(res)) throw new Error("the database doesn't have the trade_reviews table yet");
  refused(res, 'Supabase refused the read.');
  /** @type {Record<string, { stop: number | null, deleted: boolean, setupOn?: string }>} */
  const out = {};
  for (const r of res.data || []) out[r.trade_key] = { stop: r.stop === null || r.stop === undefined ? null : Number(r.stop), deleted: !!r.deleted };
  if (!on?.error) for (const r of on?.data || []) if (r.setup_on && out[r.trade_key]) out[r.trade_key].setupOn = r.setup_on;
  return out;
}

/** where a leveraged ETF's trade reads its setup: its own symbol keeps it on the fund, null puts it on the underlying. @param {string} key @param {string | null} on */
export async function saveSetupOn(key, on) {
  if (!state.session) throw new Error('Sign in with Google to save this.');
  const client = await supabaseClient();
  const res = await client.from('trade_reviews').upsert([{ trade_key: key, setup_on: on }], { onConflict: 'user_id,trade_key' });
  if (missingTable(res)) throw new Error("the database doesn't have the setup on column yet: npx supabase db push");
  refused(res, 'Supabase refused the save.');
}

/** save review rows whole (stop and deleted), so one field never clears the other. @param {Record<string, { stop?: number | null, deleted?: boolean }>} rows by trade key */
export async function saveTradeReviews(rows) {
  if (!state.session) throw new Error('Sign in with Google to save this.');
  const client = await supabaseClient();
  const list = Object.entries(rows).map(([key, r]) => ({ trade_key: key, stop: r.stop ?? null, deleted: !!r.deleted }));
  refused(await client.from('trade_reviews').upsert(list, { onConflict: 'user_id,trade_key' }), 'Supabase refused the save.');
}

/** save one trade's review row. @param {string} key @param {{ stop?: number | null, deleted?: boolean }} review */
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
