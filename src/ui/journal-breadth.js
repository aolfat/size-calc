// Market breadth for the trade features (docs/journal-features.md): reads every US stock's daily close from Massive
// (one call a day, the free plan's 5 a minute), keeps the closes on this device (lib/idb.js), counts the % over their
// 5 / 20 / 50 / 100 / 200-day averages (core/breadth.js), and saves the counts to the account (market_breadth), where the
// breadth features read them on every device. Runs quietly after the Journal loads, at most hourly, with a Massive key in
// Settings; the newest days first, so recent trades fill in first. A first fill over a year of trades is a few hundred
// calls, about an hour and a half at the free plan's pace, and carries on wherever it stopped. Listeners hear when a run
// moves on (onBreadthChange), with saved = true when counts were written.
import { breadthCounts, breadthDaysToRead, groupedToDay } from '../core/breadth.js';
import { lastDoneDay, nyDay } from '../core/bars.js';
import { stampableTrade } from '../core/features/index.js';
import { idbClear, idbEntries, idbGet, idbSet } from '../lib/idb.js';
import { store } from '../lib/store.js';
import { loadBreadthRows, saveBreadthRows } from '../services/breadth.js';
import { massiveCommonStocks, massiveGrouped, massiveKeyHere } from '../services/massive.js';
import { state } from '../state.js';
import { effects } from './effects.js';

/** automatic runs at most this often (one that stopped part way carries on at the next) */
export const BREADTH_EVERY = 3600000;
/** Massive's free plan: 5 calls a minute */
export const MASSIVE_PACE_MS = 12500;
/** counts are worked out and saved after this many days read, so a long fill shows as it goes */
const SAVE_EVERY = 10;
/** the stock list is read again after this long */
const UNIVERSE_DAYS = 30;
const DAY_KEY = 'breadth_day:', UNIVERSE_KEY = 'breadth_universe';

const listeners = new Set();
/** @param {(saved: boolean) => void} fn */
export function onBreadthChange(fn) { listeners.add(fn); }
const tell = saved => { for (const fn of listeners) fn(saved); };

/** the last run on this device: { user, at, read, saved, error } */
export function lastBreadth() {
  try { return JSON.parse(store.get('journal_breadth') || 'null'); } catch(e) { return null; }
}

/** the account's counts, for the stamper: day → counts; a table not pushed yet leaves them unread (the features wait) */
export async function loadBreadthState() {
  const user = state.session?.user?.id || '';
  if (state.breadthRows && state.breadthOwner === user) return state.breadthRows;
  try {
    state.breadthRows = await loadBreadthRows();
    state.breadthOwner = user;
    state.breadthError = '';
  } catch(e) {
    state.breadthRows = null;
    state.breadthError = String(e?.message || e);
  }
  return state.breadthRows;
}

let lastCall = 0;
/** wait out Massive's pace since the last call */
async function pace() {
  const gap = lastCall + MASSIVE_PACE_MS - Date.now();
  if (gap > 0) await effects.wait(gap);
  lastCall = Date.now();
}

/** one call, with up to three waits of a minute when Massive says too many */
async function paced(fn) {
  for (let i = 0; ; i++) {
    await pace();
    try { return await fn(); }
    catch(e) {
      if (e?.status !== 429 || i >= 3) throw e;
      await effects.wait(60000);
    }
  }
}

/** every US common stock's ticker, kept a month on this device */
async function universe() {
  const kept = await idbGet(UNIVERSE_KEY);
  if (kept && Array.isArray(kept.tickers) && kept.tickers.length && Date.now() - kept.at < UNIVERSE_DAYS * 86400000) return new Set(kept.tickers);
  const tickers = await massiveCommonStocks(pace);
  if (tickers.length < 1000) throw new Error(`Massive listed only ${tickers.length} common stocks`);
  await idbSet(UNIVERSE_KEY, { at: Date.now(), tickers });
  return new Set(tickers);
}

/** the progress line under the Journal's status while a run reads */
export function breadthLine() {
  const p = state.breadthProgress;
  if (!state.breadthBusy || !p || !p.total) return '';
  const left = Math.ceil((p.total - p.done) * MASSIVE_PACE_MS / 60000);
  return `Market breadth: reading Massive's daily closes, ${p.done} of ${p.total} days${left > 1 ? ` (about ${left} min left while the app is open)` : ''}.`;
}

/** sign out: this device's closes go with the account */
export function clearBreadthDevice() {
  state.breadthRows = null;
  state.breadthOwner = '';
  return idbClear('breadth_');
}

/**
 * Read what the trades' breadth still needs and save the counts, when it's due: signed in, a Massive key here, not run
 * for this user within BREADTH_EVERY (unless `force`), one run at a time. `trades` are the Journal's.
 * @param {{ trades: any[], force?: boolean }} opts
 */
export async function maybeFillBreadth({ trades, force = false }) {
  const user = state.session?.user?.id;
  if (!user || !massiveKeyHere() || state.breadthBusy) return null;
  const last = lastBreadth();
  if (!force && last && last.user === user && !last.error && Date.now() - last.at < BREADTH_EVERY) return null;
  state.breadthBusy = true;
  const result = { user, at: 0, read: 0, saved: 0, error: '' };
  try {
    state.breadthRows = null; // read the account's again: another device may have counted
    const rows = await loadBreadthState();
    if (!rows) throw new Error(state.breadthError);
    const now = Date.now();
    const moments = trades.filter(stampableTrade).flatMap(t => [nyDay(t.openedAt), ...(t.closedAt ? [nyDay(t.closedAt)] : [])]);
    const cache = new Map((await idbEntries(DAY_KEY)).map(([k, v]) => [k.slice(DAY_KEY.length), v]));
    const save = async () => {
      const counts = breadthCounts([...cache.values()]);
      const changed = [...counts].filter(([d, c]) => JSON.stringify(rows.get(d)) !== JSON.stringify(c)).map(([day, c]) => ({ day, counts: c }));
      await saveBreadthRows(changed);
      for (const r of changed) rows.set(r.day, r.counts);
      result.saved += changed.length;
      if (changed.length) tell(true);
    };
    const toRead = breadthDaysToRead({ moments, rows, read: new Set(cache.keys()), now, through: lastDoneDay(now) });
    if (toRead.length) {
      state.breadthProgress = { done: 0, total: toRead.length };
      tell(false);
      const stocks = await universe();
      let since = 0;
      for (const day of toRead) {
        if (state.session?.user?.id !== user || !massiveKeyHere()) break; // signed out or key removed: stop
        let body = null;
        try { body = await paced(() => massiveGrouped(day)); }
        catch(e) { if (e?.status !== 403) throw e; } // past what the plan reaches: leave it
        const d = body ? groupedToDay(day, body, stocks, now) : null;
        if (d) { cache.set(day, d); await idbSet(DAY_KEY + day, d); result.read++; }
        state.breadthProgress.done++;
        tell(false);
        if (++since >= SAVE_EVERY) { since = 0; await save(); }
      }
    }
    await save();
  } catch(e) {
    result.error = String(e?.message || e);
  } finally {
    result.at = Date.now();
    store.set('journal_breadth', JSON.stringify(result));
    state.breadthBusy = false;
    state.breadthProgress = null;
    tell(false);
  }
  return result;
}
