// Journal review reads and writes (docs/journal-step-3.md): each trade's grades and note (its trade_reviews row, saved
// apart from your stop and delete so neither overwrites the other), its labels (trade_labels), the market per day
// (journal_days), and your library (library_items). Row-level security returns only your rows. Never touches the page.
import { state } from '../state.js';
import { JOURNAL_READ_LIMIT } from './journal.js';
import { supabaseClient } from './supabase.js';

/** the review migration not pushed yet: a missing table or column */
const notPushed = (/** @type {any} */ res) => res?.error && /schema cache|does not exist|column/i.test(res.error.message || '');

function refused(res, what) {
  if (!res?.error) return;
  const err = new Error(notPushed(res) ? "the database doesn't have the review tables yet: npx supabase db push" : res.error.message || what);
  err.status = res.status || 0;
  throw err;
}

async function client() {
  if (!state.session) throw new Error('Sign in with Google to review trades.');
  return supabaseClient();
}

/**
 * Everything a review reads, in one go: { reviews: key → { setup_grade, plan_followed, note, market, reviewed_at },
 * labels: key → [{ kind, value, set_by }], days: 'YYYY-MM-DD' → { market, note }, library: rows }.
 */
export async function loadReviewData() {
  const c = await client();
  const [rv, lb, dy, li] = await Promise.all([
    c.from('trade_reviews').select('trade_key,setup_grade,plan_followed,note,market,reviewed_at').limit(JOURNAL_READ_LIMIT),
    c.from('trade_labels').select('trade_key,kind,value,set_by').limit(20000),
    c.from('journal_days').select('day,market,note').limit(5000),
    c.from('library_items').select('id,kind,name,default_key,hidden,merged_into').limit(2000),
  ]);
  for (const r of [rv, lb, dy, li]) refused(r, 'Supabase refused the read.');
  /** @type {Record<string, any>} */
  const reviews = {};
  for (const r of rv.data || []) if (r.setup_grade || r.plan_followed || r.note || r.market) reviews[r.trade_key] = { setup_grade: r.setup_grade, plan_followed: r.plan_followed, note: r.note, market: r.market, reviewed_at: r.reviewed_at };
  /** @type {Record<string, any[]>} */
  const labels = {};
  for (const r of lb.data || []) (labels[r.trade_key] ||= []).push({ kind: r.kind, value: r.value, set_by: r.set_by });
  /** @type {Record<string, any>} */
  const days = {};
  for (const r of dy.data || []) days[String(r.day).slice(0, 10)] = { market: r.market, note: r.note };
  return { reviews, labels, days, library: li.data || [] };
}

/** a trade's review fields (only these columns: your stop and delete on the same row stay as they are) */
export async function saveReviewFields(key, fields) {
  const c = await client();
  refused(await c.from('trade_reviews').upsert([{ trade_key: key, ...fields }], { onConflict: 'user_id,trade_key' }), 'Supabase refused the save.');
}

export async function addTradeLabel(key, kind, value) {
  const c = await client();
  refused(await c.from('trade_labels').upsert([{ trade_key: key, kind, value, set_by: 'you' }], { onConflict: 'user_id,trade_key,kind,value', ignoreDuplicates: true }), 'Supabase refused the save.');
}

export async function removeTradeLabel(key, kind, value) {
  const c = await client();
  refused(await c.from('trade_labels').delete().eq('trade_key', key).eq('kind', kind).eq('value', value), 'Supabase refused the delete.');
}

export async function saveJournalDay(day, fields) {
  const c = await client();
  refused(await c.from('journal_days').upsert([{ day, ...fields }], { onConflict: 'user_id,day' }), 'Supabase refused the save.');
}

/** one library row, whole (a new item of yours, or a change to an item or a default) */
export async function saveLibraryItem(row) {
  const c = await client();
  refused(await c.from('library_items').upsert([row], { onConflict: 'user_id,id' }), 'Supabase refused the save.');
}
