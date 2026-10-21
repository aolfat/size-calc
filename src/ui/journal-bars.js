// Journal bars: saves the 5-minute bars your trades need, and the market basket's, before Tradier's ~40 days run out
// (services/bars.js), after an import lands and when the Journal opens, at most hourly per user, quietly (nothing in the Import sheet: by request).
// What's saved follows the trade features' needs (core/features: featureBarNeeds): a feature naming a symbol, or more
// lookback days, makes it saved from then on, on top of the market basket. With a paid Massive plan the features read
// the lookback days and the basket from Massive (which serves them again any time), so only the days your trades were
// open are saved, for their charts: bars_5m stays small (docs/journal-features.md, Storage).
import { store } from '../lib/store.js';
import { LOOKBACK_DAYS, MARKET_BASKET } from '../core/bars.js';
import { featureBarNeeds } from '../core/features/index.js';
import { buildTrades } from '../core/journal.js';
import { fillsFrom } from '../core/journal-records.js';
import { saveTradeBars, tradierKeyHere } from '../services/bars.js';
import { loadSavedRecords } from '../services/journal.js';
import { massivePaid } from '../services/massive.js';
import { state } from '../state.js';

/** automatic runs at most this often: each one costs a read even when nothing's missing */
export const BARS_EVERY = 3600000;

/** the last run on this device: { user, at, saved, symbols, through, failed, error } */
export function lastBars() {
  try { return JSON.parse(store.get('journal_bars') || 'null'); } catch(e) { return null; }
}

/** the market basket and every symbol a feature names, and the most lookback days any of them compares; with a paid Massive plan, neither */
export function barsToKeep() {
  if (massivePaid()) return { market: [], lookback: 0 };
  const needs = featureBarNeeds();
  return { market: [...new Set([...MARKET_BASKET, ...needs.market])], lookback: Math.max(LOOKBACK_DAYS, needs.lookback) };
}

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
    const r = await saveTradeBars(buildTrades(fillsFrom(kept), { now: Date.now() }), Date.now(), barsToKeep());
    result = { user, at: Date.now(), ...r, error: '' };
  } catch(e) {
    result = { ...(last && last.user === user ? last : { saved: 0, symbols: 0, through: '', failed: [] }), user, at: Date.now(), error: String(e?.message || e) };
  } finally {
    state.barsBusy = false;
  }
  store.set('journal_bars', JSON.stringify(result));
  return result;
}
