// Journal tab (#journalSection, setView('journal'), key j): what's kept from Schwab in your account, your trades (fills grouped
// flat to flat, with P&L, R and hold time) or the raw fills, filtered by side and symbol, and the Import and Export sheets: Import lists the sources (Schwab now, file upload later),
// Export the files you can take (Schwab history now, trades later). Tick trades and Merge to make them one trade (a re-entry, a
// spread's legs), kept in your account's trades table; Separate undoes it. Legs that went in as one order are suggested.
import { fmt$, marketEscape as esc } from '../core/format.js';
import { fillsFrom, instructionWords, recordsSummary } from '../core/journal-records.js';
import { holdWords, journalTrades, mergeProblem, spreadSuggestions, tradesSummary } from '../core/journal.js';
import { importWords } from '../core/schwab-history.js';
import { fmtPositionPrice } from '../core/positions.js';
import { lastCapture } from '../services/capture.js';
import { schwabAccount } from '../services/schwab.js';
import { deleteSavedTrades, insertSavedTrade, loadSavedRecords, loadSavedTrades, updateSavedTrade } from '../services/journal.js';
import { store } from '../lib/store.js';
import { schwabConnected } from '../services/schwab.js';
import { state } from '../state.js';
import { showError, showToast } from './feedback.js';
import { captureNow, maybeCapture, onCaptureChange } from './schwab-capture.js';
import { openSheet } from './sheets.js';

/** fills shown at once; the rest are counted */
export const JOURNAL_SHOWN = 200;

const day = iso => iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
const when = iso => iso ? new Date(iso).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
/** a fill's time in market time (New York), whatever the device's zone: '10/13, 11:47 AM' */
export const marketTime = iso => iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

/** the line under the title: importing, the last import, or why it can't run */
function statusLine() {
  if (state.captureBusy) return '<span class="spinner" style="vertical-align:middle;margin-right:6px;"></span>Importing from Schwab…';
  const last = lastCapture();
  // an import from before delta counts has only totals: show those rather than a made-up 'nothing new'
  const what = last && 'kept' in last ? importWords(last) : last ? `${last.orders} orders, ${last.transactions} trades` : '';
  const parts = [last ? `Last import ${when(new Date(last.at).toISOString())}: ${what}` : 'Not imported yet'];
  if (state.captureError) parts.push(`<span style="color:var(--amber)">last try failed: ${esc(state.captureError)}</span>`);
  return parts.join(' · ');
}

function fillRow(f) {
  const mult = f.assetType === 'OPTION' ? 100 : 1;
  return `<tr>
    <td><b>${esc(f.label || f.symbol)}</b></td>
    <td class="${f.side === 'buy' ? 'journal-buy' : 'journal-sell'}">${esc(instructionWords(f.instruction))}</td>
    <td>${f.qty}</td>
    <td>${fmtPositionPrice(f.price, f.assetType === 'OPTION' ? 'OPTION' : null)}</td>
    <td>${fmt$(f.qty * f.price * mult)}</td>
    <td>${esc(marketTime(f.time))}</td>
  </tr>`;
}

const px = (p, assetType) => fmtPositionPrice(p, assetType === 'OPTION' ? 'OPTION' : null);
const signed$ = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt$(Math.abs(v))}`;
const pnlClass = v => v > 0 ? 'journal-buy' : v < 0 ? 'journal-sell' : '';
const signedR = r => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}R`; // the same minus sign as money

/** why this R: the stop it came from, the premium, or the spread's defined risk */
function rTitle(t) {
  if (t.rBasis === 'stop') return `Initial stop ${px(t.stop, t.assetType)}, risk ${fmt$(t.risk)}`;
  if (t.rBasis === 'premium') return `No stop order: the premium paid, ${fmt$(t.risk)}, is the risk`;
  if (t.rBasis === 'spread') return t.net === 'debit' ? `Defined risk: the debit, ${fmt$(t.risk)}` : `Defined risk: the width less the credit, ${fmt$(t.risk)}`;
  return t.kind === 'spread' ? 'No defined risk for this mix of legs' : 'No stop order found';
}

/** under a merged trade or spread: what it's made of, and Separate */
function partsLine(t) {
  if (t.kind === 'single') return '';
  const legs = new Set(t.parts.map(k => k.split('|')[1])).size;
  const what = t.kind === 'spread' ? `${legs} legs` : `${t.parts.length} trades merged`;
  return `<span class="pos-sub">${what} · <button class="pos-link" data-action="separateTrade" data-arg="${esc(t.id)}">Separate</button></span>`;
}

function tradeRow(t) {
  const open = t.status === 'open';
  const picked = state.journalPicked.includes(t.key);
  // the side is the bet on the stock (a put bought is short); a spread says what it is under it
  const side = { long: 'Long', short: 'Short', neutral: 'Neutral' }[t.bias];
  const sideClass = { long: 'journal-buy', short: 'journal-sell', neutral: '' }[t.bias];
  return `<tr${open ? ' class="journal-open"' : ''}>
    <td><label class="journal-pick"><input type="checkbox" data-change="toggleJournalPick" data-arg="${esc(t.key)}" aria-label="Pick ${esc(t.label)}"${picked ? ' checked' : ''} /></label><b>${esc(t.label)}</b>${open ? ' <span class="journal-tag">open</span>' : ''}${partsLine(t)}</td>
    <td class="${pnlClass(t.pnl)}">${open && !t.exits ? '—' : signed$(t.pnl)}${open && t.exits ? '<span class="pos-sub">so far</span>' : ''}</td>
    <td title="${esc(rTitle(t))}">${t.r === null ? '—' : signedR(t.r)}</td>
    <td class="${sideClass}">${side}${t.structure ? `<span class="pos-sub">${esc(t.structure)}</span>` : ''}</td>
    <td>${t.entryQty}${open && t.openQty !== t.entryQty ? `<span class="pos-sub">${t.openQty} open</span>` : ''}</td>
    <td>${px(t.avgEntry, t.assetType)}</td>
    <td>${t.avgExit === null ? '—' : px(t.avgExit, t.assetType)}</td>
    <td>${open ? 'open' : esc(holdWords(t.holdMs))}</td>
    <td>${esc(marketTime(t.openedAt))}</td>
  </tr>`;
}

/** the trades and fills the filters let through */
function filtered(list, sideOf) {
  const q = state.journalSymbol.trim().toUpperCase();
  return list.filter(x => (state.journalSide === 'all' || sideOf(x) === state.journalSide) && (!q || (x.label || x.symbol).toUpperCase().includes(q)));
}

function summaryLine(trades) {
  const s = tradesSummary(trades);
  if (!s.closed && !s.open) return 'No trades match.';
  const parts = [`${s.closed} closed`];
  if (s.closed) parts.push(`${s.wins} won (${s.winRate}%)`, `<span class="${pnlClass(s.pnl)}">${signed$(s.pnl)}</span> before fees`);
  if (s.avgR !== null) parts.push(`average ${signedR(s.avgR)} over ${s.withR}`);
  if (s.open) parts.push(`${s.open} open`);
  return parts.join(' · ');
}

function controls() {
  const on = (current, v) => `class="${current === v ? 'active' : ''}" aria-pressed="${current === v}"`;
  const tab = (v, label) => `<button ${on(state.journalTab, v)} data-action="setJournalTab" data-arg="${v}">${label}</button>`;
  const side = (v, label) => `<button ${on(state.journalSide, v)} data-action="setJournalSide" data-arg="${v}">${label}</button>`;
  return `<div class="journal-controls">
    <div class="seg" aria-label="Show">${tab('trades', 'Trades')}${tab('fills', 'Fills')}</div>
    <div class="seg" aria-label="Side">${side('all', 'All')}${side('long', 'Long')}${side('short', 'Short')}</div>
    <input type="search" id="journalSymbol" placeholder="Symbol" value="${esc(state.journalSymbol)}" autocomplete="off" spellcheck="false" data-input="journalSymbolChanged" aria-label="Filter by symbol" />
  </div>`;
}

/** what's ticked, why it can't be one trade (or Merge), and Clear */
function pickBar(all) {
  const picked = all.filter(t => state.journalPicked.includes(t.key));
  if (!picked.length) return '';
  const why = picked.length > 1 ? mergeProblem(picked) : '';
  const off = why || picked.length < 2 || state.journalMerging ? ' disabled' : '';
  const note = why ? ` · <span class="journal-why">${esc(why)}</span>` : picked.length < 2 ? ' · tick another to merge' : '';
  return `<div class="journal-pickbar" role="status">${picked.length} picked${note}
    <span class="journal-pickbar-acts"><button class="btn primary" data-action="mergePicked"${off}>${state.journalMerging ? 'Merging…' : 'Merge into one trade'}</button><button class="btn" data-action="clearJournalPicks">Clear</button></span></div>`;
}

const skipped = () => { try { return JSON.parse(store.get('journal_spread_skip') || '[]'); } catch(e) { return []; } };

/** legs that went in as one order, not yet one trade: Merge, or Keep apart (remembered on this device) */
function suggestions(all) {
  const skip = new Set(skipped());
  const list = spreadSuggestions(all).filter(s => !skip.has(s.keys.join(',')));
  return list.map(s => `<div class="journal-suggest"><span><b>${esc(s.label)}</b> went in as one order. One trade?</span>
    <span class="journal-pickbar-acts"><button class="btn primary" data-action="mergeSuggested" data-arg="${esc(s.keys.join(','))}"${state.journalMerging ? ' disabled' : ''}>Merge as one trade</button><button class="btn" data-action="skipSuggestion" data-arg="${esc(s.keys.join(','))}">Keep apart</button></span></div>`).join('');
}

function tradesView(trades, all) {
  const merges = state.journalSavedError ? `<p class="hint" style="color:var(--amber)">Merges unavailable: ${esc(state.journalSavedError)}</p>` : '';
  if (!trades.length) return `${merges}${suggestions(all)}${pickBar(all)}<p class="hint">No trades match.</p>`;
  // the pick bar follows the table and sticks to the bottom of the screen, so it stays in reach while you tick down the list
  return `<p class="hint journal-summary">${summaryLine(trades)}</p>${merges}${suggestions(all)}
    <div class="positions-wrap"><table class="positions-table journal-table">
      <thead><tr><th scope="col">Symbol</th><th scope="col">P&amp;L</th><th scope="col">R</th><th scope="col">Side</th><th scope="col">Qty</th><th scope="col">Entry</th><th scope="col">Exit</th><th scope="col">Hold</th><th scope="col">Opened (ET)</th></tr></thead>
      <tbody>${trades.slice(0, JOURNAL_SHOWN).map(tradeRow).join('')}</tbody>
    </table></div>${pickBar(all)}
    <p class="hint">${trades.length > JOURNAL_SHOWN ? `Showing the newest ${JOURNAL_SHOWN} of ${trades.length} trades. ` : ''}Trades run from flat back to flat, matched first in first out; tick two or more and Merge to make them one (a re-entry, a spread's legs). P&amp;L is before fees. R uses the first Schwab stop order on the loss side of your entry; a long option with no stop risks its premium.</p>`;
}

function fillsView(fills) {
  if (!fills.length) return '<p class="hint">No fills match.</p>';
  return `<div class="positions-wrap"><table class="positions-table journal-table">
      <thead><tr><th scope="col">Symbol</th><th scope="col">Action</th><th scope="col">Qty</th><th scope="col">Price</th><th scope="col">Value</th><th scope="col">Time (ET)</th></tr></thead>
      <tbody>${fills.slice(0, JOURNAL_SHOWN).map(fillRow).join('')}</tbody>
    </table></div>
    <p class="hint">${fills.length > JOURNAL_SHOWN ? `Showing the newest ${JOURNAL_SHOWN} of ${fills.length} fills. ` : `${fills.length} fill${fills.length === 1 ? '' : 's'}. `}Fills are read from your saved Schwab orders.</p>`;
}

/** the trades as the table shows them, before the filters: your merges applied */
const currentTrades = () => journalTrades(fillsFrom(state.journalRecords || []), state.journalRecords || [], state.journalSaved);

export function toggleJournalPick(key) {
  state.journalPicked = state.journalPicked.includes(key) ? state.journalPicked.filter(k => k !== key) : [...state.journalPicked, key];
  renderJournal();
}
export function clearJournalPicks() { state.journalPicked = []; renderJournal(); }

/**
 * Save trades as one: a new row claiming their fills, or, when one of them is already a merge, its oldest row takes the
 * rest in (so what's attached to it stays put) and the other rows go.
 */
async function mergeTrades(picked) {
  const problem = mergeProblem(picked);
  if (problem) { showError(problem); return; }
  if (state.journalMerging) return;
  state.journalMerging = true;
  renderJournal();
  const fillIds = [...new Set(picked.flatMap(t => t.fillIds))];
  const savedIds = picked.flatMap(t => t.savedIds);
  const rows = state.journalSaved.filter(r => savedIds.includes(r.id)).sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  try {
    let keep;
    if (rows.length) {
      keep = { ...rows[0], fill_ids: fillIds };
      await updateSavedTrade(keep.id, fillIds);
    } else {
      keep = { id: crypto.randomUUID(), account: picked[0].account, fill_ids: fillIds };
      await insertSavedTrade(keep);
      keep.created_at = new Date().toISOString();
    }
    state.journalSaved = [...state.journalSaved.filter(r => r.id !== keep.id), keep];
    const extra = rows.slice(1).map(r => r.id);
    // a leftover row still overlaps the kept one, so the trade shows as one either way
    try { await deleteSavedTrades(extra); state.journalSaved = state.journalSaved.filter(r => !extra.includes(r.id)); } catch(e) {}
    state.journalPicked = [];
    const n = new Set(picked.flatMap(t => t.kind === 'single' ? [t.key] : t.parts)).size;
    showToast(`Merged ${n} trades into one.`);
  } catch(e) {
    showError(`Couldn't merge: ${e?.message || e}`);
  } finally {
    state.journalMerging = false;
    renderJournal();
  }
}

export async function mergePicked() {
  await mergeTrades(currentTrades().filter(t => state.journalPicked.includes(t.key)));
}

export async function mergeSuggested(keys) {
  const list = String(keys).split(',');
  await mergeTrades(currentTrades().filter(t => list.includes(t.key)));
}

export function skipSuggestion(keys) {
  store.set('journal_spread_skip', JSON.stringify([...new Set([...skipped(), String(keys)])]));
  renderJournal();
}

/** a merged trade or spread back into its parts: its saved rows deleted */
export async function separateTrade(id) {
  const t = currentTrades().find(x => x.id === id);
  if (!t || state.journalMerging) return;
  state.journalMerging = true;
  try {
    await deleteSavedTrades(t.savedIds);
    state.journalSaved = state.journalSaved.filter(r => !t.savedIds.includes(r.id));
    showToast(`Separated into ${t.parts.length} trades.`);
  } catch(e) {
    showError(`Couldn't separate: ${e?.message || e}`);
  } finally {
    state.journalMerging = false;
    renderJournal();
  }
}

export function setJournalTab(tab) { state.journalTab = tab === 'fills' ? 'fills' : 'trades'; renderJournal(); }
export function setJournalSide(side) { state.journalSide = ['long', 'short'].includes(side) ? side : 'all'; renderJournal(); }
export function journalSymbolChanged() {
  state.journalSymbol = document.getElementById('journalSymbol').value;
  renderJournal();
  const el = document.getElementById('journalSymbol'); // the redraw replaced the box: keep typing in it
  if (el && el.focus) { el.focus(); if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length); }
}

export function renderJournal() {
  const el = document.getElementById('journalSection');
  if (!el) return;
  if (!state.session) {
    el.innerHTML = `<div class="card empty-card"><div class="setup-title">Sign in to keep your journal</div><p>Your Schwab orders and trades are kept in your account, so sign in with Google first. Then connect Schwab and import.</p><button class="btn primary" data-action="openSheet" data-arg="settings">Open settings</button></div>`;
    return;
  }
  const records = state.journalRecords || [];
  const kept = recordsSummary(records);
  const fills = fillsFrom(records);
  const all = journalTrades(fills, records, state.journalSaved);
  const keys = new Set(all.map(t => t.key));
  state.journalPicked = state.journalPicked.filter(k => keys.has(k)); // a merge or re-read can retire a key
  const canImport = schwabConnected();
  const keptLine = kept.orders || kept.transactions
    ? `${kept.orders} orders and ${kept.transactions} trades kept · ${day(kept.first)} to ${day(kept.last)}`
    : state.journalLoading ? 'Loading…' : 'Nothing kept yet';
  const scrolled = el.querySelector?.('.positions-wrap')?.scrollLeft || 0; // a tick redraws the table: keep it where it was sideways
  el.innerHTML = `<div class="card positions-card journal-card">
    <div class="positions-head">
      <span class="section-title">Journal</span>
      <span class="positions-meta" id="journalKept">${keptLine}</span>
      <span class="journal-actions">
        <button class="btn" id="journalImportBtn" data-action="openJournalImport" title="Bring in trades: Schwab now, files later">${state.captureBusy ? 'Importing…' : 'Import'}</button>
        <button class="btn" id="journalExportBtn" data-action="openJournalExport" title="Take your data with you as a file">Export</button>
      </span>
    </div>
    <p class="hint" id="journalStatus" role="status">${statusLine()}</p>
    ${state.journalError ? `<p class="shares-error" role="status">Couldn't load your journal: ${esc(state.journalError)}</p>` : ''}
    ${fills.length ? controls() + (state.journalTab === 'fills'
      ? fillsView(filtered(fills, f => f.side === 'buy' ? (/TO_COVER|TO_CLOSE/.test(f.instruction) ? 'short' : 'long') : (/SHORT/.test(f.instruction) ? 'short' : 'long')))
      : tradesView(filtered(all, t => t.bias), all))
    : `<p class="hint">${records.length ? 'No fills in the kept orders yet.' : 'Import saves your last 60 days of Schwab orders and up to a year of trades to your account. After that, the app keeps adding to it on its own.'}</p>`}
  </div>`;  const wrap = scrolled && el.querySelector?.('.positions-wrap');
  if (wrap) wrap.scrollLeft = scrolled;
}

// ---------- Import and Export sheets ----------

/** Import: every source in one list. Schwab works now; file upload is where older history and Robinhood will come in */
export function renderImportSheet() {
  const el = document.getElementById('journalImportBody');
  if (!el) return;
  const acct = schwabAccount();
  const schwab = schwabConnected()
    ? `<div class="sheet-label">Schwab <span class="sheet-status"><span style="color:var(--green)">●</span> Connected · ••${esc(acct ? acct.last4 : '')}</span></div>
      <p class="hint" id="journalImportStatus" role="status">${statusLine()}</p>
      <div class="row" style="align-items:center;gap:8px;"><button class="btn primary" id="journalImportNow" data-action="journalImport"${state.captureBusy ? ' disabled' : ''}>${state.captureBusy ? 'Importing…' : 'Import now'}</button></div>
      <p class="hint">Saves your last 60 days of orders and up to a year of trades to your account. The app also imports on its own every 6 hours while you're signed in and connected.</p>`
    : `<div class="sheet-label">Schwab <span class="sheet-status">○ Not connected</span></div>
      <p class="hint">Log in to Schwab to import your orders and trades.</p>
      <div class="row" style="align-items:center;gap:8px;"><button class="btn" data-action="openSheet" data-arg="settings">Connect Schwab</button></div>`;
  el.innerHTML = `<div class="sheet-section">${schwab}</div>
    <div class="sheet-section journal-soon">
      <div class="sheet-label">File upload <span class="sheet-status">Coming soon</span></div>
      <p class="hint">For history older than Schwab's API reaches (Schwab's website export) and for Robinhood's account activity CSV. You'll see what will be added before anything is saved.</p>
    </div>`;
}

/** Export: the files you can take. Schwab history now; trades as CSV once trades exist */
export function renderExportSheet() {
  const el = document.getElementById('journalExportBody');
  if (!el) return;
  const history = schwabConnected()
    ? `<div class="row" style="align-items:center;gap:8px;"><button class="btn" id="schwabHistoryBtn" data-action="downloadSchwabHistory"${state.historyBusy ? ' disabled' : ''}>${state.historyBusy ? 'Reading Schwab…' : 'Download Schwab history'}</button></div>
      <p class="hint">A JSON file of your positions, the last 60 days of orders, and up to a year of trades, read from Schwab now. Account numbers are masked.</p>`
    : `<p class="hint">Log in to Schwab to download your history. <button class="pos-link" data-action="openSheet" data-arg="settings">Connect Schwab</button></p>`;
  el.innerHTML = `<div class="sheet-section"><div class="sheet-label">Schwab history (JSON)</div>${history}</div>
    <div class="sheet-section journal-soon">
      <div class="sheet-label">Trades (CSV) <span class="sheet-status">Coming soon</span></div>
      <p class="hint">Every trade with P&amp;L and R, for a spreadsheet or another journal, once trades are built from your fills.</p>
    </div>`;
}

export function openJournalImport() { renderImportSheet(); openSheet('journalImport'); }
export function openJournalExport() { renderExportSheet(); openSheet('journalExport'); }

/** read the kept records again and redraw */
export async function loadJournal() {
  if (!state.session) { renderJournal(); return; }
  state.journalLoading = true;
  renderJournal();
  try {
    // merges are read alongside; without them (no trades table yet) the trades still show, unmerged
    const [records, saved] = await Promise.all([
      loadSavedRecords(),
      loadSavedTrades().then(rows => { state.journalSavedError = ''; return rows; }, e => { state.journalSavedError = String(e?.message || e); return state.journalSaved; }),
    ]);
    state.journalRecords = records;
    state.journalSaved = saved;
    state.journalError = '';
  } catch(e) {
    state.journalError = String(e?.message || e);
  } finally {
    state.journalLoading = false;
    if (state.journalView) renderJournal();
  }
}

/** the tab opened: show what's kept, and import quietly when it's due */
export function openJournal() {
  loadJournal();
  maybeCapture();
}

/** Import: save the latest from Schwab now */
export async function journalImport() {
  renderJournal();
  await captureNow();
}

// a capture started or finished: redraw (the Import sheet too when it's open), and after a save read the records again
onCaptureChange(saved => {
  if (state.openSheetName === 'journalImport') renderImportSheet();
  if (!state.journalView) return;
  if (saved) loadJournal(); else renderJournal();
});
