// Market breadth's reads and writes (docs/journal-features.md): one market_breadth row per (user, universe, New York day),
// counts = { '20': [above, counted], ... } or { closed: true }. Row-level security returns only your rows. Never touches
// the page.
import { BREADTH_UNIVERSE } from '../core/breadth.js';
import { state } from '../state.js';
import { supabaseClient } from './supabase.js';

function refused(res, what) {
  if (!res?.error) return;
  const gone = /schema cache|does not exist/i.test(res.error.message || '');
  const err = new Error(gone ? "the database doesn't have the market_breadth table yet: npx supabase db push" : res.error.message || what);
  err.status = res.status || 0;
  throw err;
}

/** every day's counts: day → counts */
export async function loadBreadthRows() {
  if (!state.session) throw new Error('Sign in with Google for market breadth.');
  const c = await supabaseClient();
  const res = await c.from('market_breadth').select('day,counts').eq('universe', BREADTH_UNIVERSE).limit(5000);
  refused(res, 'Supabase refused the read.');
  const out = new Map();
  for (const r of res.data || []) if (r.counts && typeof r.counts === 'object') out.set(String(r.day).slice(0, 10), r.counts);
  return out;
}

/** write days' counts: [{ day, counts }], each replacing what was there */
export async function saveBreadthRows(rows) {
  if (!rows.length) return;
  const c = await supabaseClient();
  for (let i = 0; i < rows.length; i += 200) {
    const res = await c.from('market_breadth').upsert(rows.slice(i, i + 200).map(r => ({ universe: BREADTH_UNIVERSE, source: 'massive', ...r })), { onConflict: 'user_id,universe,day' });
    refused(res, 'Supabase refused the save.');
  }
}
