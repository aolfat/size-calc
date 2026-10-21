// Saving 5-minute bars: for the journal's trades (and the market basket), reads which (symbol, day) bars are already kept
// in Supabase's bars_5m, fetches the missing ones from the bar provider (services/bar-source.js: one request per symbol,
// the whole span), and keeps them one row per day, named with the provider. And Massive's older days (massiveBars),
// cached on this device (lib/idb.js), not in bars_5m: a paid plan serves them again any time, so the account keeps only
// what would otherwise be lost, and a trade's held days for its chart (saveMassiveDays). Never touches the page.
import { state } from '../state.js';
import { barsNeeded, BARS_KEEP_DAYS, daySpans, nyDay } from '../core/bars.js';
import { idbClear, idbDelete, idbGet, idbSet } from '../lib/idb.js';
import { barSource, massiveSource } from './bar-source.js';
import { supabaseClient } from './supabase.js';

const DAY_MS = 86400000;
const BATCH = 50;

/** a Tradier key is in the settings box */
export const tradierKeyHere = () => !!document.getElementById('apiKey')?.value.trim();

/** what's kept since `since`: 'SYMBOL|YYYY-MM-DD' */
async function keptDays(client, since) {
  const res = await client.from('bars_5m').select('symbol,day').gte('day', since).limit(20000);
  if (res?.error) {
    const err = new Error(/schema cache|does not exist/i.test(res.error.message || '') ? "the database doesn't have the bars_5m table yet" : res.error.message || 'Supabase refused the read.');
    err.status = res.status || 0;
    throw err;
  }
  return new Set((res.data || []).map(r => `${r.symbol}|${String(r.day).slice(0, 10)}`));
}

/** a write naming bars_5m.source before its migration (20261029000000_bars_source.sql) is pushed */
const noSourceColumn = res => /source/.test(res?.error?.message || '') && /column|schema cache/i.test(res?.error?.message || '');

/**
 * Save the bars these trades need and don't have yet, and with `market` (MARKET_BASKET) those symbols every weekday too.
 * A symbol the provider refuses is skipped (and named) and the rest go on; nothing is saved for it, so the next run asks
 * again. Before the source column is pushed, rows go without it (it defaults to 'tradier', the only provider so far).
 * @param {any[]} trades @param {number} [now] @param {{ market?: string[], lookback?: number }} [opts] barsNeeded's
 * @returns {Promise<{ saved: number, symbols: number, through: string, failed: string[], needed: number }>}
 */
export async function saveTradeBars(trades, now = Date.now(), opts = {}) {
  if (!state.session) throw new Error('Sign in with Google to save bars.');
  const need = barsNeeded(trades, now, opts);
  const client = await supabaseClient();
  const kept = await keptDays(client, nyDay(now - BARS_KEEP_DAYS * DAY_MS));
  let saved = 0, symbols = 0, needed = 0, through = '';
  const failed = [];
  for (const [symbol, days] of need) {
    const missing = days.filter(d => !kept.has(`${symbol}|${d}`));
    needed += days.length;
    for (const d of days) if (kept.has(`${symbol}|${d}`) && d > through) through = d;
    if (!missing.length) continue;
    let byDay;
    try { byDay = await barSource.intraday(symbol, missing[0], missing[missing.length - 1]); }
    catch(e) { failed.push(symbol); continue; }
    const rows = missing.map(day => ({ symbol, day, bars: byDay.get(day) || [], source: barSource.name }));
    for (let i = 0; i < rows.length; i += BATCH) {
      const upsert = batch => client.from('bars_5m').upsert(batch, { onConflict: 'user_id,symbol,day', ignoreDuplicates: true });
      let res = await upsert(rows.slice(i, i + BATCH));
      if (noSourceColumn(res)) res = await upsert(rows.slice(i, i + BATCH).map(({ source, ...r }) => r));
      if (res?.error) { const err = new Error(res.error.message || 'Supabase refused the save.'); err.status = res.status || 0; throw err; }
    }
    saved += rows.length;
    symbols++;
    if (missing[missing.length - 1] > through) through = missing[missing.length - 1];
  }
  return { saved, symbols, through, failed, needed };
}

/** one symbol's 5-minute bars on these days straight from the provider, not saved (the trade page's context): [{ day, bars }] */
export async function fetchTradeBars(symbol, days) {
  if (!days.length) return [];
  const byDay = await barSource.intraday(symbol, days[0], days[days.length - 1]);
  return days.filter(d => byDay.has(d)).map(day => ({ day, bars: byDay.get(day) }));
}

/** the kept bars_5m rows for one symbol on these days: [{ day, bars }] */
export async function loadTradeBars(symbol, days) {
  if (!state.session || !days.length) return [];
  const client = await supabaseClient();
  const res = await client.from('bars_5m').select('day,bars').eq('symbol', symbol).in('day', days).limit(400);
  if (res?.error) {
    const err = new Error(/schema cache|does not exist/i.test(res.error.message || '') ? "the database doesn't have the bars_5m table yet" : res.error.message || 'Supabase refused the read.');
    err.status = res.status || 0;
    throw err;
  }
  return res.data || [];
}

// ---------- Massive's older days, cached on this device ----------

const CACHE = 'bars5m_massive:', CACHE_INDEX = 'bars5m_massive_index';
/** cached days kept on the device, the least recently read dropped past it: about 10 KB a day, so some 60 MB */
export const MASSIVE_CACHE_DAYS = 6000;

/**
 * One symbol's 5-minute bars on these finished days from Massive: day → packed rows ([] = none that day, a holiday or
 * no trades), the device's cache first, then one request per span of what's missing (each kept in the cache). `call`
 * wraps every request (the pacer: none on a paid plan, a minute's wait on a 429).
 * @param {string} symbol @param {string[]} days sorted
 * @param {{ call?: <T>(fn: () => Promise<T>) => Promise<T> }} [opts]
 * @returns {Promise<Map<string, (string | number)[][]>>}
 */
export async function massiveBars(symbol, days, { call = fn => fn() } = {}) {
  const out = new Map(), missing = [];
  for (const d of days) {
    const hit = await idbGet(CACHE + symbol + '|' + d);
    if (hit && Array.isArray(hit.bars)) out.set(d, hit.bars); else missing.push(d);
  }
  const at = Date.now();
  for (const [from, to] of daySpans(missing)) {
    const byDay = await call(() => massiveSource.intraday(symbol, from, to));
    for (const d of missing) {
      if (d < from || d > to) continue;
      const bars = byDay.get(d) || [];
      out.set(d, bars);
      await idbSet(CACHE + symbol + '|' + d, { bars });
    }
  }
  await touchCache(days.map(d => symbol + '|' + d), at);
  return out;
}

/** the days just read count as recently used; past MASSIVE_CACHE_DAYS the oldest go @param {string[]} keys @param {number} at */
async function touchCache(keys, at) {
  if (!keys.length) return;
  const index = (await idbGet(CACHE_INDEX)) || {};
  for (const k of keys) index[k] = at;
  const all = Object.keys(index);
  if (all.length > MASSIVE_CACHE_DAYS) {
    const drop = all.sort((a, b) => index[a] - index[b]).slice(0, all.length - MASSIVE_CACHE_DAYS);
    for (const k of drop) { delete index[k]; await idbDelete(CACHE + k); }
  }
  await idbSet(CACHE_INDEX, index);
}

/** sign out: the cached bars name the symbols you traded, so they go with the account */
export const clearMassiveBars = () => idbClear('bars5m_massive');

/**
 * Keep a trade's held days from Massive in bars_5m for its chart (source 'massive'), the days not kept already;
 * the stamper reads only Tradier's rows (services/features.js loadKeptBars), so these never mix into its comparisons.
 * @param {string} symbol @param {Map<string, (string | number)[][]>} byDay
 */
export async function saveMassiveDays(symbol, byDay) {
  if (!state.session || !byDay.size) return 0;
  const client = await supabaseClient();
  const rows = [...byDay].map(([day, bars]) => ({ symbol, day, bars, source: massiveSource.name }));
  const res = await client.from('bars_5m').upsert(rows, { onConflict: 'user_id,symbol,day', ignoreDuplicates: true });
  if (res?.error) { const err = new Error(res.error.message || 'Supabase refused the save.'); err.status = res.status || 0; throw err; }
  return rows.length;
}
