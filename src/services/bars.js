// Saving 5-minute bars: for the journal's trades, reads which (symbol, day) bars are already kept in Supabase's bars_5m,
// fetches the missing ones from Tradier's timesales (one request per symbol, the whole span), and keeps them one row per
// day. Never touches the page.
import { state } from '../state.js';
import { barsByDay, barsNeeded, BARS_KEEP_DAYS, nyDay } from '../core/bars.js';
import { baseUrl, headers } from './tradier.js';
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

/** one symbol's 5-minute bars from one New York day through another, extended hours included */
async function timesales(symbol, from, to) {
  const url = `${baseUrl()}/markets/timesales?symbol=${encodeURIComponent(symbol)}&interval=5min&start=${encodeURIComponent(from + ' 04:00')}&end=${encodeURIComponent(to + ' 20:00')}&session_filter=all`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) { const err = new Error(`Tradier answered ${res.status}`); err.status = res.status; throw err; }
  const data = (await res.json())?.series?.data;
  return data ? (Array.isArray(data) ? data : [data]) : [];
}

/**
 * Save the bars these trades need and don't have yet. A symbol Tradier refuses is skipped (and named) and the rest go
 * on; nothing is saved for it, so the next run asks again.
 * @param {any[]} trades @param {number} [now]
 * @returns {Promise<{ saved: number, symbols: number, through: string, failed: string[], needed: number }>}
 */
export async function saveTradeBars(trades, now = Date.now()) {
  if (!state.session) throw new Error('Sign in with Google to save bars.');
  const need = barsNeeded(trades, now);
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
    try { byDay = barsByDay(await timesales(symbol, missing[0], missing[missing.length - 1])); }
    catch(e) { failed.push(symbol); continue; }
    const rows = missing.map(day => ({ symbol, day, bars: byDay.get(day) || [] }));
    for (let i = 0; i < rows.length; i += BATCH) {
      const res = await client.from('bars_5m').upsert(rows.slice(i, i + BATCH), { onConflict: 'user_id,symbol,day', ignoreDuplicates: true });
      if (res?.error) { const err = new Error(res.error.message || 'Supabase refused the save.'); err.status = res.status || 0; throw err; }
    }
    saved += rows.length;
    symbols++;
    if (missing[missing.length - 1] > through) through = missing[missing.length - 1];
  }
  return { saved, symbols, through, failed, needed };
}

/** one symbol's 5-minute bars on these days straight from Tradier, not saved (the trade page's context): [{ day, bars }] */
export async function fetchTradeBars(symbol, days) {
  if (!days.length) return [];
  const byDay = barsByDay(await timesales(symbol, days[0], days[days.length - 1]));
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
