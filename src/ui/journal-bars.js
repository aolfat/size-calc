// Journal bars: saves the 5-minute bars your trades need, and the market basket's, before Tradier's ~40 days run out
// (services/bars.js), after an import lands and when the Journal opens, at most hourly per user; and the line in the Import sheet that says how it's going.
import { store } from '../lib/store.js';
import { MARKET_BASKET } from '../core/bars.js';
import { buildTrades } from '../core/journal.js';
import { fillsFrom } from '../core/journal-records.js';
import { saveTradeBars, tradierKeyHere } from '../services/bars.js';
import { loadSavedRecords } from '../services/journal.js';
import { state } from '../state.js';

/** automatic runs at most this often: each one costs a read even when nothing's missing */
export const BARS_EVERY = 3600000;

/** the last run on this device: { user, at, saved, symbols, through, failed, error } */
export function lastBars() {
  try { return JSON.parse(store.get('journal_bars') || 'null'); } catch(e) { return null; }
}

const listeners = [];
/** tell me when a run ends (the Import sheet redraws) */
export function onBarsChange(fn) { listeners.push(fn); }

/**
 * Save the bars when it's due: signed in, a Tradier key in place, not run for this user within BARS_EVERY. The kept
 * records come from the Journal when it has them, else they're read.
 * @param {{ records?: any[], force?: boolean }} [opts]
 */
export async function maybeSaveBars({ records, force = false } = {}) {
  const user = state.session?.user?.id;
  if (!user || !tradierKeyHere() || state.barsBusy) return null;
  const last = lastBars();
  if (!force && last && last.user === user && Date.now() - last.at < BARS_EVERY) return null;
  state.barsBusy = true;
  let result = null;
  try {
    const kept = records || state.journalRecords || await loadSavedRecords();
    const r = await saveTradeBars(buildTrades(fillsFrom(kept), { now: Date.now() }), Date.now(), { market: MARKET_BASKET });
    result = { user, at: Date.now(), ...r, error: '' };
  } catch(e) {
    result = { ...(last && last.user === user ? last : { saved: 0, symbols: 0, through: '', failed: [] }), user, at: Date.now(), error: String(e?.message || e) };
  } finally {
    state.barsBusy = false;
  }
  store.set('journal_bars', JSON.stringify(result));
  listeners.forEach(fn => fn(result));
  return result;
}

/** the Import sheet's line about bars */
export function barsLine() {
  if (!tradierKeyHere()) return "Add a Tradier key in Settings and the journal saves 5-minute bars for your trades and the market (SPY, QQQ, the sector ETFs). Tradier only keeps about 40 days of them.";
  if (state.barsBusy) return 'Saving 5-minute bars…';
  const last = lastBars();
  if (!last || last.user !== state.session?.user?.id) return '5-minute bars for your trades and the market save after the next import. Tradier only keeps about 40 days of them.';
  const [y, m, d] = (last.through || '').split('-');
  const parts = [last.through ? `5-minute bars saved through ${+m}/${+d}/${y.slice(2)}` : 'No 5-minute bars needed yet'];
  if (last.saved) parts.push(`${last.saved} new day${last.saved === 1 ? '' : 's'} last time`);
  if (last.failed?.length) parts.push(`Tradier had none for ${last.failed.join(', ')}`);
  if (last.error) parts.push(`last try failed: ${last.error}`);
  return parts.join(' · ') + '.';
}
