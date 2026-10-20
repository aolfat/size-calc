// Trade features' reads and writes (docs/journal-features.md, part 2): the stamps (trade_features, one row per trade key,
// every feature in one JSON object), the saved 5-minute bars a stamping run reads (bars_5m), and daily bars from the bar
// provider (services/bar-source.js; not saved, every provider keeps them for years). Row-level security returns only
// your rows. Never touches the page.
import { unpackBars } from '../core/trade-page.js';
import { state } from '../state.js';
import { barSource } from './bar-source.js';
import { JOURNAL_READ_LIMIT } from './journal.js';
import { supabaseClient } from './supabase.js';

/** the migration not pushed yet */
const notPushed = (/** @type {any} */ res) => res?.error && /schema cache|does not exist/i.test(res.error.message || '');

function refused(res, what, table) {
  if (!res?.error) return;
  const err = new Error(notPushed(res) ? `the database doesn't have the ${table} table yet: npx supabase db push` : res.error.message || what);
  err.status = res.status || 0;
  throw err;
}

async function client() {
  if (!state.session) throw new Error('Sign in with Google to stamp features.');
  return supabaseClient();
}

/** every trade's stamps: trade key → { feature key → { v, value, note } } */
export async function loadFeatureStamps() {
  const c = await client();
  const res = await c.from('trade_features').select('trade_key,stamps').limit(JOURNAL_READ_LIMIT);
  refused(res, 'Supabase refused the read.', 'trade_features');
  /** @type {Record<string, any>} */
  const out = {};
  for (const r of res.data || []) out[r.trade_key] = r.stamps && typeof r.stamps === 'object' ? r.stamps : {};
  return out;
}

/** write whole rows: [{ trade_key, stamps }], each replacing what was there (the caller merged the old stamps in) */
export async function saveFeatureStamps(rows) {
  if (!rows.length) return;
  const c = await client();
  for (let i = 0; i < rows.length; i += 100) {
    const res = await c.from('trade_features').upsert(rows.slice(i, i + 100), { onConflict: 'user_id,trade_key' });
    refused(res, 'Supabase refused the save.', 'trade_features');
  }
}

/**
 * The kept 5-minute bars for a symbol on these days: day → candles ([] for a day kept empty); a day not kept isn't in it.
 * @param {string} symbol @param {string[]} days @returns {Promise<Map<string, any[]>>}
 */
export async function loadKeptBars(symbol, days) {
  const c = await client();
  const out = new Map();
  for (let i = 0; i < days.length; i += 60) {
    const res = await c.from('bars_5m').select('day,bars').eq('symbol', symbol).in('day', days.slice(i, i + 60)).limit(400);
    refused(res, 'Supabase refused the read.', 'bars_5m');
    for (const r of res.data || []) {
      const day = String(r.day).slice(0, 10);
      out.set(day, unpackBars([{ day, bars: r.bars }]));
    }
  }
  return out;
}

/** a symbol's daily bars from the provider, oldest first */
export const fetchDailyBars = (symbol, from, to) => barSource.daily(symbol, from, to);
