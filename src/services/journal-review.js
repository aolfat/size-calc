// Journal review reads and writes (docs/journal-step-3.md): each trade's grades and note (its trade_reviews row, saved
// apart from your stop and delete so neither overwrites the other), its labels (trade_labels), the market per day
// (journal_days, which also holds each day's notebook page), your library (library_items, your goals and rules too), and
// the week and month reviews (period_reviews). Row-level security
// returns only your rows. Never touches the page.
import { cleanPeriodRow, PERIOD_COLUMNS } from '../core/journal-week.js';
import { gradeOf } from '../core/journal-labels.js';
import { cleanDayRow, DAY_COLUMNS } from '../core/journal-notebook.js';
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
 * Everything a review reads, in one go: { reviews: key → { setup_grade, plan_followed, note (the exit note), entry_note,
 * market, reviewed_at }, labels: key → [{ kind, value, set_by, links }], days: 'YYYY-MM-DD' → its notebook row (cleanDayRow:
 * market, note, the plan and the review), library: rows, weekly: key → when, weeklyError, entryNoteError, notebookError }.
 */
export async function loadReviewData() {
  const c = await client();
  const [rv, lb, dy, li] = await Promise.all([
    c.from('trade_reviews').select('trade_key,setup_grade,plan_followed,note,market,reviewed_at').limit(JOURNAL_READ_LIMIT),
    c.from('trade_labels').select('trade_key,kind,value,set_by,links').limit(20000),
    c.from('journal_days').select('day,market,note').limit(5000),
    c.from('library_items').select('id,kind,name,default_key,hidden,merged_into,settings').limit(2000),
  ]);
  for (const r of [rv, lb, dy, li]) refused(r, 'Supabase refused the read.');
  /** @type {Record<string, any>} */
  const reviews = {};
  for (const r of rv.data || []) if (r.setup_grade || r.plan_followed || r.note || r.market) reviews[r.trade_key] = { setup_grade: gradeOf(r.setup_grade), plan_followed: r.plan_followed, note: r.note, market: r.market, reviewed_at: r.reviewed_at };
  /** @type {Record<string, any[]>} */
  const labels = {};
  for (const r of lb.data || []) (labels[r.trade_key] ||= []).push({ kind: r.kind, value: r.value, set_by: r.set_by, links: Array.isArray(r.links) ? r.links : [] });
  /** @type {Record<string, any>} */
  const days = {};
  for (const r of dy.data || []) days[String(r.day).slice(0, 10)] = cleanDayRow(r);
  const [weekly, entry, notebook] = await Promise.all([loadWeekly(c), loadEntryNotes(c), loadNotebook(c)]);
  for (const [key, text] of Object.entries(entry.entryNotes)) reviews[key] = { ...(reviews[key] || {}), entry_note: text };
  for (const r of notebook.rows) { const day = String(r.day).slice(0, 10); days[day] = cleanDayRow({ ...days[day], ...r }); }
  return { reviews, labels, days, library: li.data || [], ...weekly, entryNoteError: entry.entryNoteError, notebookError: notebook.notebookError };
}

/**
 * Each day's notebook page (journal_days' plan and review columns, the notebook's migration): read on their own like the
 * entry notes, so a database without them keeps the rest of the review working (notebookError says why).
 */
async function loadNotebook(c) {
  const res = await c.from('journal_days').select(['day', ...DAY_COLUMNS].join(',')).limit(5000);
  if (res?.error) return { rows: [], notebookError: notPushed(res) ? "the database doesn't have the notebook columns yet: npx supabase db push" : res.error.message || 'Supabase refused the read.' };
  return { rows: res.data || [], notebookError: '' };
}

/**
 * The entry notes (trade_reviews.entry_note, its own migration): { entryNotes: key → text }, read on their own like the
 * weekly marks, so a database without the column keeps the rest of the review working (entryNoteError says why).
 */
async function loadEntryNotes(c) {
  const res = await c.from('trade_reviews').select('trade_key,entry_note').limit(JOURNAL_READ_LIMIT);
  if (res?.error) return { entryNotes: {}, entryNoteError: notPushed(res) ? "the database doesn't have the entry note column yet: npx supabase db push" : res.error.message || 'Supabase refused the read.' };
  /** @type {Record<string, string>} */
  const entryNotes = {};
  for (const r of res.data || []) if (r.entry_note) entryNotes[r.trade_key] = r.entry_note;
  return { entryNotes, entryNoteError: '' };
}

/**
 * The trades saved for the weekly review (trade_reviews.weekly_at, the review deck's migration): { weekly: key → when },
 * read on its own so a database without the column yet keeps every other part of the review working (weeklyError says why).
 */
async function loadWeekly(c) {
  const res = await c.from('trade_reviews').select('trade_key,weekly_at').limit(JOURNAL_READ_LIMIT);
  if (res?.error) return { weekly: {}, weeklyError: notPushed(res) ? "the database doesn't have the weekly review column yet: npx supabase db push" : res.error.message || 'Supabase refused the read.' };
  /** @type {Record<string, string>} */
  const weekly = {};
  for (const r of res.data || []) if (r.weekly_at) weekly[r.trade_key] = r.weekly_at;
  return { weekly, weeklyError: '' };
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

/** one of your library rows, gone: a setup + New setup made and then moved off before anything else used it */
export async function deleteLibraryItem(id) {
  const c = await client();
  refused(await c.from('library_items').delete().eq('id', id), 'Supabase refused the delete.');
}

/** a label's links, whole (the Option flow tag's Unusual Whales / Bullflow pages) */
export async function saveLabelLinks(key, kind, value, links) {
  const c = await client();
  refused(await c.from('trade_labels').upsert([{ trade_key: key, kind, value, links }], { onConflict: 'user_id,trade_key,kind,value' }), 'Supabase refused the save.');
}

/** the week and month reviews' grades and notes (period_reviews, slice 6 part 2's migration): rows, newest first */
export async function loadPeriodReviews() {
  const c = await client();
  const res = await c.from('period_reviews').select(['unit', 'period_key', ...PERIOD_COLUMNS].join(',')).limit(2000);
  if (res?.error) {
    const err = new Error(notPushed(res) ? "the database doesn't have the period_reviews table yet: npx supabase db push" : res.error.message || 'Supabase refused the read.');
    err.status = res.status || 0;
    throw err;
  }
  return (res.data || []).map(cleanPeriodRow).filter(Boolean);
}

/** a week's or month's review fields (only these columns: the other parts' grades and notes stay as they are) */
export async function savePeriodFields(unit, key, fields) {
  const c = await client();
  refused(await c.from('period_reviews').upsert([{ unit, period_key: key, ...fields }], { onConflict: 'user_id,unit,period_key' }), 'Supabase refused the save.');
}
