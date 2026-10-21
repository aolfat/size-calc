// Trade features in the Journal (docs/journal-features.md, part 2): the stamper, which after the Journal loads and after
// an import works out every feature missing or outdated on each trade (core/features) from the saved bars (or, for days
// older than Tradier keeps, a paid Massive plan's, one provider per trade and symbol: intradayRoutes) and the provider's
// daily bars, and saves them (trade_features); the quiet line while it runs (#journalFeaturesLine); the
// Features tab (every feature, what it reads, its version, how far it's stamped); and the trade page's Features tab.
import { marketEscape as esc } from '../core/format.js';
import { lastDoneDay, MASSIVE_PLANS, nyDay, reachFor } from '../core/bars.js';
import { unpackBars } from '../core/trade-page.js';
import { fillsFrom } from '../core/journal-records.js';
import { FEATURE_FAMILIES, FEATURES, featureCoverage, featureDataNeeds, featureDue, featureNeedsWords, featuresDue, featureValueWords, featureVersion, intradayRoutes, stampableTrade, stampTrade } from '../core/features/index.js';
import { fetchDailyBars, loadFeatureStamps, loadKeptBars, saveFeatureStamps } from '../services/features.js';
import { massiveBars, tradierKeyHere } from '../services/bars.js';
import { deviceBarsReach, massiveKeyHere, massivePaid, massivePlan } from '../services/massive.js';
import { breadthLine, loadBreadthState, massivePaced } from './journal-breadth.js';
import { state } from '../state.js';
import { journalTradeList, renderJournal } from './journal.js';

/** trades stamped per save: each chunk reads its bars, works out its features and saves, so progress shows and a failure keeps what's done */
const CHUNK = 40;
/** when only features waiting for data are left, a run tries them again at most this often */
export const FEATURES_RETRY_MS = 15 * 60000;

/** read every trade's stamps (the Journal's load); a table not pushed yet leaves the Journal working */
export async function loadFeatureRows() {
  try {
    state.featureStamps = await loadFeatureStamps();
    state.featuresOwner = state.session?.user?.id || '';
    state.featuresError = '';
  } catch(e) {
    state.featuresError = String(e?.message || e);
  }
}

/** the trade's first fill price: a stock's entry, for the features that compare it with its levels */
function firstFillPrice(trade, fillsById) {
  let first = null;
  for (const id of trade.fillIds || []) {
    const f = fillsById.get(id);
    if (f && (!first || f.time < first.time)) first = f;
  }
  return first ? first.price : null;
}

const dueSig = due => due.map(d => `${d.trade.key}:${d.features.map(f => f.key).join(',')}`).join('|');

/**
 * Stamp what's due: every feature missing or outdated on each of the Journal's trades. Runs after the Journal's records
 * are read, one run at a time; when only features waiting for their data are left from the last run, at most every
 * FEATURES_RETRY_MS. Daily bars need the Tradier key; without it those features wait.
 */
export async function maybeStampFeatures({ force = false } = {}) {
  const user = state.session?.user?.id;
  if (state.featuresBusy && force) state.featuresRerun = true; // new data landed mid-run: go again once it's done
  if (!user || state.featuresBusy || !state.journalRecords) return null;
  if (state.featureStamps === null || state.featuresOwner !== user) await loadFeatureRows();
  if (state.featuresError || !state.featureStamps) { syncFeatures(); return null; }
  const reach = deviceBarsReach(Date.now());
  const due = featuresDue(journalTradeList(), state.featureStamps, FEATURES, reach.id);
  const sig = dueSig(due);
  const last = state.featuresLast;
  if (!due.length || (!force && last && last.user === user && !last.error && last.sig === sig && Date.now() - last.at < FEATURES_RETRY_MS)) return null;
  state.featuresBusy = true;
  state.featuresProgress = { done: 0, total: due.length, features: new Set(due.flatMap(d => d.features.map(f => f.key))).size };
  syncFeatures();
  const fillsById = new Map(fillsFrom(state.journalRecords).map(f => [f.id, f]));
  const daily = new Map(); // symbol → { from, bars }, read once a run
  const now = Date.now();
  const counts = { value: 0, unknown: 0, waiting: 0 };
  const waits = {};
  const refused = new Set(); // symbols Massive wouldn't serve this run: their trades read the kept bars and wait
  let error = '';
  try {
    for (let i = 0; i < due.length; i += CHUNK) {
      const chunk = due.slice(i, i + CHUNK);
      const needs = featureDataNeeds(chunk);
      const kept = new Map();
      for (const [symbol, days] of needs.intraday) kept.set(symbol, await loadKeptBars(symbol, days));
      // per trade and symbol: the kept bars when they hold every day it reads, else all of them from Massive
      const routed = chunk.map(d => {
        const own = featureDataNeeds([d]).intraday;
        return { own, routes: intradayRoutes(own, kept, reach, now) };
      });
      const fromMassive = new Map();
      for (const { own, routes } of routed) for (const [symbol, route] of routes) {
        if (route !== 'massive') continue;
        if (!fromMassive.has(symbol)) fromMassive.set(symbol, new Set());
        for (const d of /** @type {string[]} */ (own.get(symbol))) if (d >= reachFor(reach, symbol) && d <= lastDoneDay(now)) fromMassive.get(symbol).add(d);
      }
      const massive = new Map();
      for (const [symbol, days] of fromMassive) {
        if (refused.has(symbol)) continue;
        try {
          const byDay = await massiveBars(symbol, [...days].sort(), { call: massivePaced });
          massive.set(symbol, new Map([...byDay].map(([day, bars]) => [day, unpackBars([{ day, bars }])])));
        } catch(e) { refused.add(symbol); } // these trades wait; tried again on a later run
      }
      for (const [symbol, from] of needs.daily) {
        if (daily.has(symbol) && daily.get(symbol).from <= from) continue;
        if (!tradierKeyHere()) continue; // not read: those features wait for a key
        try { daily.set(symbol, { from, bars: await fetchDailyBars(symbol, from, nyDay(now)) }); }
        catch(e) { daily.set(symbol, { from: '', bars: null }); } // not again this run; they wait
      }
      const breadth = needs.breadth ? await loadBreadthState() : null; // unread: the breadth features wait
      const dailyBars = new Map([...daily].map(([s, x]) => [s, x.bars]));
      const rows = [];
      for (const [k, { trade, features }] of chunk.entries()) {
        const { own, routes } = routed[k];
        const intraday = new Map([...own.keys()].map(s => [s, routes.get(s) === 'massive' && massive.has(s) ? massive.get(s) : kept.get(s)]));
        const data = { intraday, daily: dailyBars, breadth };
        const r = stampTrade(trade, state.featureStamps[trade.key], features, data, { now, entryPrice: firstFillPrice(trade, fillsById), reach });
        for (const [key, res] of Object.entries(r.results)) {
          counts[res.state]++;
          if (res.state === 'waiting') (waits[trade.key] ||= {})[key] = res.note;
        }
        if (r.changed) rows.push({ trade_key: trade.key, stamps: r.stamps });
      }
      await saveFeatureStamps(rows);
      for (const row of rows) state.featureStamps[row.trade_key] = row.stamps;
      state.featuresProgress.done += chunk.length;
      syncFeatures();
    }
  } catch(e) {
    error = String(e?.message || e);
  } finally {
    state.featureWaits = waits;
    state.featuresLast = { user, at: Date.now(), ...counts, error, refused: [...refused], sig: error ? '' : dueSig(featuresDue(journalTradeList(), state.featureStamps, FEATURES, reach.id)) };
    state.featuresBusy = false;
    state.featuresProgress = null;
    syncFeatures();
  }
  if (state.featuresRerun) { state.featuresRerun = false; return maybeStampFeatures({ force: true }); }
  return state.featuresLast;
}

/** the quiet line under the Journal's status while a run goes, and after one that failed */
export function featuresLine() {
  const p = state.featuresProgress;
  if (state.featuresBusy && p) return `Stamping ${p.features} feature${p.features === 1 ? '' : 's'} on ${p.total} trade${p.total === 1 ? '' : 's'}…${p.done ? ` ${p.done} of ${p.total}` : ''}`;
  const last = state.featuresLast;
  if (last?.error && last.user === state.session?.user?.id) return `Features: the last stamping failed (${last.error}). It tries again on the next load.`;
  return breadthLine();
}

/** a run moved on: the line, the Features tab, and the trade page's section, each redrawn in place */
export function syncFeatures() {
  const line = document.getElementById('journalFeaturesLine');
  if (line) { const text = featuresLine(); line.textContent = text; line.hidden = !text; }
  if (state.journalView && !state.journalTrade && state.journalTab === 'features') renderJournal();
  const page = document.getElementById('jtFeatures');
  if (page && state.journalTrade?.tab === 'features') {
    const t = journalTradeList().find(x => x.key === state.journalTrade.key);
    if (t) page.innerHTML = tradeFeaturesHtml(t);
  }
}

// ---------- the Features tab ----------

function coverageCell(f, trades) {
  const c = featureCoverage(f, trades, state.featureStamps || {}, deviceBarsReach(Date.now()).id);
  const subs = [];
  // every reason it's unknown, the commonest first: one alone is said in full
  if (c.unknown) subs.push(c.reasons.length === 1 ? `${c.unknown} unknown: ${esc(c.reasons[0][0])}` : `${c.unknown} unknown`, ...(c.reasons.length > 1 ? c.reasons.map(([why, n]) => `${n}: ${esc(why)}`) : []));
  if (c.pending) subs.push(`${c.pending} to come`);
  return `<td><b>${c.value + c.unknown} of ${c.total}</b>${subs.map(s => `<span class="pos-sub">${s}</span>`).join('')}</td>`;
}

const when = ms => new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** every feature by family: what it measures and reads, its version, how far it's stamped over your trades */
export function featuresView(trades) {
  const last = state.featuresLast && state.featuresLast.user === state.session?.user?.id ? state.featuresLast : null;
  const status = state.featuresError
    ? `<p class="hint" role="status" style="color:var(--amber)">Features can't be saved yet: ${esc(state.featuresError)}. The rest of the Journal works.</p>`
    : state.featuresBusy ? `<p class="hint" role="status">${esc(featuresLine())}</p>`
    : last && !last.error ? `<p class="hint" role="status">Last stamped ${esc(when(last.at))}: ${last.value} value${last.value === 1 ? '' : 's'}, ${last.unknown} unknown, ${last.waiting} waiting for data.${last.refused?.length ? ` Massive didn't serve ${esc(last.refused.slice(0, 5).join(', '))}${last.refused.length > 5 ? ` and ${last.refused.length - 5} more` : ''}: tried again on the next run.` : ''}</p>` : '';
  const plan = MASSIVE_PLANS[massivePlan()];
  const history = massivePaid()
    ? `<p class="hint">5-minute bars: Tradier's for the last 40 days, Massive's before that (${esc(plan.name)}: ${plan.stocks} years of stocks${plan.options ? `, ${plan.options} of options` : ', options only from Tradier'}).</p>`
    : '<p class="hint">5-minute bars reach back about 40 days (Tradier), so older trades miss the intraday features. A paid Massive plan in Settings reaches years back, and those fill in.</p>';
  const breadth = state.breadthBusy ? `<p class="hint" role="status">${esc(breadthLine())}</p>`
    : state.breadthError ? `<p class="hint" role="status" style="color:var(--amber)">Market breadth can't be read: ${esc(state.breadthError)}. The other features work.</p>`
    : !massiveKeyHere() ? '<p class="hint">Market breadth needs a Massive API key (free) in Settings: the app counts it from every US stock\'s daily close. Without one those features wait.</p>' : '';
  const counted = trades.filter(stampableTrade);
  // one table, a row heading each family, so the columns line up across them
  const groups = FEATURE_FAMILIES.map(fam => {
    const list = FEATURES.filter(f => f.family.key === fam.key);
    if (!list.length) return '';
    return `<tr class="jf-family"><th colspan="4" scope="colgroup">${esc(fam.name)}</th></tr>` + list.map(f => `<tr>
        <td><b>${esc(f.name)}</b><span class="pos-sub">${esc(f.desc)}</span><span class="pos-sub jf-key">${esc(f.key)} · at ${f.at}</span></td>
        <td class="jf-needs">${esc(featureNeedsWords(f))}</td>
        <td>${esc(featureVersion(f))}</td>
        ${coverageCell(f, counted)}
      </tr>`).join('');
  }).join('');
  const table = `<div class="positions-wrap jf-wrap"><table class="positions-table journal-table jf-table">
      <colgroup><col class="jf-c-name"><col class="jf-c-needs"><col class="jf-c-v"><col class="jf-c-done"></colgroup>
      <thead><tr><th scope="col">Feature</th><th scope="col">Reads</th><th scope="col">Version</th><th scope="col">Stamped</th></tr></thead>
      <tbody>${groups}</tbody></table></div>`;
  return `<p class="hint">What the data says about each trade at its entry (and a few at its exit), worked out by the app from the saved bars and the daily history, never typed. A new or changed feature stamps itself onto every trade. ${counted.length} trade${counted.length === 1 ? '' : 's'} get features (not deleted ones, nor closes from before your history).</p>
    ${status}${breadth}${history}${table}
    <details class="hint-details"><summary>How features are stamped</summary><p class="hint">Each feature sees the data up to its moment and nothing after: a 5-minute bar counts once it has ended, the bar your entry falls in only by its open. Unknown means the data is gone (Tradier keeps about 40 days of 5-minute bars, so without a paid Massive plan older trades miss the intraday ones) and it isn't tried again, unless a provider reaching further back is added; waiting means the data can still come (today's bars save after 8pm ET, daily bars need the Tradier key) and it's tried on the next load. Numbers are kept as numbers, not ranges, so how they're grouped can change later without restamping.</p></details>`;
}

// ---------- the trade page ----------

/** how many features have a value on the trade (the Features tab's count) */
export function tradeFeatureCount(t) {
  const stamps = state.featureStamps?.[t.key];
  const reach = deviceBarsReach(Date.now()).id;
  return stamps ? FEATURES.filter(f => !featureDue(f, stamps, reach) && stamps[f.key].value !== null).length : 0;
}

/** the trade's Features tab: every feature by family, its value, and how it was found or why not; tap one for what it measures */
export function tradeFeaturesHtml(t) {
  if (state.featuresError) return `<p class="hint">Features need the database update: npx supabase db push.</p>`;
  if (t.status === 'history') return '<p class="hint">Bought before your history, so there\'s no entry to measure.</p>';
  if (t.deleted) return '<p class="hint">Deleted trades get no features.</p>';
  if (state.featureStamps === null) return `<p class="hint">${state.session ? 'Loading…' : 'Sign in to see features.'}</p>`;
  const stamps = state.featureStamps[t.key];
  const open = !!state.journalTrade?.featuresOpen;
  const reach = deviceBarsReach(Date.now()).id;
  let value = 0, unknown = 0, pending = 0;
  const item = f => {
    const s = stamps?.[f.key];
    const current = !!s && !featureDue(f, stamps, reach);
    if (current && s.value !== null) value++; else if (current) unknown++; else pending++;
    const how = current ? (s.note || '') : state.featuresBusy ? 'stamping…' : state.featureWaits?.[t.key]?.[f.key] || (s?.v === featureVersion(f) ? 'trying again: Massive reaches further back' : s ? 'restamping: a newer version' : 'not stamped yet');
    return `<details class="jf-item${current && s.value !== null ? '' : ' jf-quiet'}"${open ? ' open' : ''}>
        <summary><span class="jf-name">${esc(f.name)}</span><span class="jf-val">${esc(current ? featureValueWords(f, s.value) : '—')}</span><span class="jf-how">${esc(how)}</span></summary>
        <div class="jf-detail"><p>${esc(f.desc)}</p><p class="jf-meta">Reads ${esc(featureNeedsWords(f))} · version ${esc(featureVersion(f))} · <span class="jf-key">${esc(f.key)}</span></p></div>
      </details>`;
  };
  const groups = FEATURE_FAMILIES.map(fam => {
    const list = FEATURES.filter(f => f.family.key === fam.key);
    return list.length ? `<div class="jf-fam">${esc(fam.name)}</div>${list.map(item).join('')}` : '';
  }).join('');
  const parts = [`${value} with a value`, unknown ? `${unknown} unknown` : '', pending ? `${pending} still to come` : ''].filter(Boolean);
  return `<div class="jf-head"><p class="hint">${FEATURES.length} features: ${parts.join(', ')}. Tap one for what it measures.</p>
      <button class="pos-link" data-action="toggleTradeFeatures">${open ? 'Collapse all' : 'Expand all'}</button></div>
    <div class="jf-list">${groups}</div>`;
}

/** Expand all / Collapse all on the trade's Features tab */
export function toggleTradeFeatures() {
  const p = state.journalTrade;
  if (!p) return;
  p.featuresOpen = !p.featuresOpen;
  syncFeatures();
}

/** for an import landing while the Journal is closed: read the records again (they changed) and stamp, once the Journal has been read here */
export async function stampAfterImport(loadRecords) {
  if (!state.journalRecords || !state.session) return null;
  try { state.journalRecords = await loadRecords(); } catch(e) { return null; }
  return maybeStampFeatures();
}

