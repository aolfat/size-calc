// Journal reads and writes: the signed-in account's kept Schwab records (schwab_records, newest first) and your word on
// each trade (trade_reviews: your stop, hidden). Row-level security means only your own rows come back. Never touches the page.
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

/**
 * your stops, deletes and spreads, by trade key. Before the group_key migration is pushed, the read retries without it
 * and says so (groups: false), so stops and deletes still load.
 * @returns {Promise<{ reviews: Record<string, { stop: number | null, hidden: boolean, group_key?: string | null }>, groups: boolean }>}
 */
export async function loadTradeReviews() {
  if (!state.session) throw new Error('Sign in with Google to see your journal.');
  const client = await supabaseClient();
  let groups = true;
  let res = await client.from('trade_reviews').select('trade_key,stop,hidden,group_key').limit(JOURNAL_READ_LIMIT);
  if (res?.error && /group_key/i.test(res.error.message || '')) {
    groups = false;
    res = await client.from('trade_reviews').select('trade_key,stop,hidden').limit(JOURNAL_READ_LIMIT);
  }
  // the migration not pushed yet: PostgREST says 'Could not find the table … in the schema cache', Postgres 'does not exist'
  if (res?.error && /schema cache|does not exist/i.test(res.error.message || '')) throw new Error("the database doesn't have the trade_reviews table yet");
  refused(res, 'Supabase refused the read.');
  /** @type {Record<string, { stop: number | null, hidden: boolean, group_key?: string | null }>} */
  const out = {};
  for (const r of res.data || []) {
    out[r.trade_key] = { stop: r.stop === null || r.stop === undefined ? null : Number(r.stop), hidden: !!r.hidden };
    if (groups) out[r.trade_key].group_key = r.group_key ?? null;
  }
  return { reviews: out, groups };
}

/**
 * save review rows whole (stop and hidden, and group_key when it's known), so one field never clears another; several
 * at once for a spread's legs
 * @param {Record<string, { stop?: number | null, hidden?: boolean, group_key?: string | null }>} rows by trade key
 */
export async function saveTradeReviews(rows) {
  if (!state.session) throw new Error('Sign in with Google to save this.');
  const client = await supabaseClient();
  const list = Object.entries(rows).map(([key, r]) => ({ trade_key: key, stop: r.stop ?? null, hidden: !!r.hidden, ...(r.group_key !== undefined ? { group_key: r.group_key } : {}) }));
  refused(await client.from('trade_reviews').upsert(list, { onConflict: 'user_id,trade_key' }), 'Supabase refused the save.');
}

/** save one trade's review row. @param {string} key @param {{ stop?: number | null, hidden?: boolean, group_key?: string | null }} review */
export const saveTradeReview = (key, review) => saveTradeReviews({ [key]: review });
