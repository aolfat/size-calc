// Journal tab (#journalSection, setView('journal'), key j): what's kept from Schwab in your account, the Import button,
// and the fills inside your saved orders, newest first. Trades, P&L and stats come in later slices (docs/journal-step-2.md).
import { fmt$, marketEscape as esc } from '../core/format.js';
import { fillsFrom, instructionWords, recordsSummary } from '../core/journal-records.js';
import { fmtPositionPrice } from '../core/positions.js';
import { lastCapture } from '../services/capture.js';
import { loadSavedRecords } from '../services/journal.js';
import { schwabConnected } from '../services/schwab.js';
import { state } from '../state.js';
import { captureNow, maybeCapture, onCaptureChange } from './schwab-capture.js';

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
  const parts = [last ? `Last import ${when(new Date(last.at).toISOString())}: ${last.orders} orders, ${last.transactions} trades` : 'Not imported yet'];
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
  const canImport = schwabConnected();
  const keptLine = kept.orders || kept.transactions
    ? `${kept.orders} orders and ${kept.transactions} trades kept · ${day(kept.first)} to ${day(kept.last)}`
    : state.journalLoading ? 'Loading…' : 'Nothing kept yet';
  el.innerHTML = `<div class="card positions-card journal-card">
    <div class="positions-head">
      <span class="section-title">Journal</span>
      <span class="positions-meta" id="journalKept">${keptLine}</span>
      <button class="btn" id="journalImportBtn" data-action="journalImport"${canImport && !state.captureBusy ? '' : ' disabled'} title="Save your latest Schwab orders and trades to your account">${state.captureBusy ? 'Importing…' : 'Import'}</button>
    </div>
    <p class="hint" id="journalStatus" role="status">${statusLine()}</p>
    ${canImport ? '' : `<p class="hint">Connect Schwab to import: <button class="pos-link" data-action="openSheet" data-arg="settings">Settings, Schwab trading</button>.</p>`}
    ${state.journalError ? `<p class="shares-error" role="status">Couldn't load your journal: ${esc(state.journalError)}</p>` : ''}
    ${fills.length ? `<div class="positions-wrap"><table class="positions-table journal-table">
      <thead><tr><th scope="col">Symbol</th><th scope="col">Action</th><th scope="col">Qty</th><th scope="col">Price</th><th scope="col">Value</th><th scope="col">Time (ET)</th></tr></thead>
      <tbody>${fills.slice(0, JOURNAL_SHOWN).map(fillRow).join('')}</tbody>
    </table></div>
    <p class="hint">${fills.length > JOURNAL_SHOWN ? `Showing the newest ${JOURNAL_SHOWN} of ${fills.length} fills. ` : `${fills.length} fill${fills.length === 1 ? '' : 's'}. `}Fills are read from your saved Schwab orders. Trades, P&amp;L and stats come next.</p>`
    : `<p class="hint">${records.length ? 'No fills in the kept orders yet.' : 'Import saves your last 60 days of Schwab orders and up to a year of trades to your account. After that, the app keeps adding to it on its own.'}</p>`}
    ${canImport ? `<p class="hint"><button class="link-btn" id="schwabHistoryBtn" data-action="downloadSchwabHistory"${state.historyBusy ? ' disabled' : ''} title="Your last 60 days of orders and up to a year of trades as a file, account number masked">${state.historyBusy ? 'Reading Schwab…' : 'Download Schwab history'}</button> · a file of your orders and trades, account number masked</p>` : ''}
  </div>`;
}

/** read the kept records again and redraw */
export async function loadJournal() {
  if (!state.session) { renderJournal(); return; }
  state.journalLoading = true;
  renderJournal();
  try {
    state.journalRecords = await loadSavedRecords();
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

// a capture started or finished: redraw, and after a save read the kept records again
onCaptureChange(saved => {
  if (!state.journalView) return;
  if (saved) loadJournal(); else renderJournal();
});
