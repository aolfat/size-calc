// The original stop a position's R counts from, set by hand: kept as the Journal trade's Your stop (trade_reviews, synced),
// so every device and the Journal count 1R the same, and a stop moved to breakeven or trailed never changes it.
// Drawn in the close ticket under Limit in R, the chart's Target in R and the phone's actions sheet (one editor open at a time).
import { state } from '../state.js';
import { fmt$, marketEscape as esc } from '../core/format.js';
import { ownStopError } from '../core/journal.js';
import { fmtPositionPrice } from '../core/positions.js';
import { saveTradeReviews } from '../services/journal.js';
import { showToast } from './feedback.js';
import { positionTrade, readPositionJournalForClose, renderPositions } from './positions.js';
import { renderPositionChart } from './position-chart.js';
import { renderPositionTradeSheet } from './position-trade.js';

const rowOf = symbol => state.positions?.rows.find(r => r.symbol === symbol) || null;
const editing = (row, host) => !!state.posOrig && state.posOrig.symbol === row.symbol && state.posOrig.host === host;

/** whether the editor is open in a host, so a 30s read doesn't redraw it out from under your typing */
export const originalEditingIn = host => !!state.posOrig && state.posOrig.host === host;

/** what the typed price would make 1R, or why it can't be this trade's original stop */
function preview(t, row, text) {
  if (!String(text || '').trim()) return { text: 'Type the stop you had when you opened it.', ok: false };
  const price = Number(text);
  const err = ownStopError(t, price);
  if (err) return { text: err, ok: false };
  const per = Math.abs(t.avgEntry - price);
  return { text: `1R would be ${fmt$(per)} a ${row.tradeAs === 'OPTION' ? 'contract' : 'share'} (${fmt$(per * t.entryQty * t.multiplier)} on the entry).`, ok: true };
}

/** where R's stop comes from now, in a few words */
function sourceWords(t, row) {
  const px = v => fmtPositionPrice(v, row.tradeAs);
  if (t.stopSource === 'yours') return `Your original stop is ${px(t.stop)}.${t.schwabStop !== null ? ` Schwab's first was ${px(t.schwabStop)}.` : ''}`;
  if (t.stopSource === 'schwab') return `Schwab's first stop on this trade was ${px(t.stop)}.`;
  return 'Schwab shows no stop under your cost for this trade.';
}

/**
 * The original stop line for a host ('close', 'chart', 'actions'): a Set or Change link, or the editor while it's open there.
 * Nothing for a position without a cost basis or outside the trades offered here.
 */
export function originalStopBlock(row, host) {
  if (!row || !(row.avg > 0) || !row.tradeAs) return '';
  const t = state.session ? positionTrade(row) : null;
  const own = !!t && t.stopSource === 'yours';
  if (!editing(row, host)) {
    return `<button class="pos-link pos-orig-link" data-action="openOriginalStop" data-arg="${esc(row.symbol)}" data-arg2="${host}" title="The stop R counts from, kept with the Journal trade on every device">${own ? 'Change original stop' : 'Set original stop'}</button>`;
  }
  const cancel = '<button class="btn" data-action="cancelOriginalStop">Cancel</button>';
  if (!state.session) return `<div class="pos-orig"><p class="hint">Sign in to set your original stop: it's kept with the Journal trade, so every device counts R from it.</p>${cancel}</div>`;
  if (state.posJournalBusy && !state.journalRecords) return `<div class="pos-orig"><p class="hint">Reading the Journal…</p>${cancel}</div>`;
  if (state.tradeReviewsError || state.posJournalError) return `<div class="pos-orig"><p class="shares-error">The Journal didn't load, so the original stop can't be saved: ${esc(state.tradeReviewsError || state.posJournalError)}</p>${cancel}</div>`;
  if (!t) return `<div class="pos-orig"><p class="hint">No Journal trade matches this position (opened before your history, or the fills don't add up to what Schwab holds), so there's nowhere to keep an original stop. Import your history in the Journal.</p>${cancel}</div>`;
  const o = state.posOrig, p = preview(t, row, o.text), busy = !!o.busy;
  return `<div class="pos-orig">
    <span class="shares-detail">${esc(sourceWords(t, row))}</span>
    <div class="pos-orig-edit">
      <label for="posOrigInput">Original stop</label>
      <div class="prefix-wrap"><span class="prefix">$</span><input type="number" id="posOrigInput" step="0.01" min="0" inputmode="decimal" autocomplete="off" value="${esc(o.text)}" data-input="setOriginalStopText" data-enter="saveOriginalStop"${busy ? ' disabled' : ''} /></div>
      <button class="btn primary" id="posOrigSave" data-action="saveOriginalStop"${p.ok && !busy ? '' : ' disabled'}>${busy ? 'Saving…' : 'Save'}</button>
      ${own ? `<button class="btn" data-action="clearOriginalStop"${busy ? ' disabled' : ''}>Use Schwab's</button>` : ''}
      ${cancel}
    </div>
    <span class="shares-detail" id="posOrigNote" role="status">${esc(o.error || p.text)}</span>
  </div>`;
}

/** every place R shows follows a change: the table and cards, the actions sheet, the chart, the close ticket */
function redraw() {
  renderPositions();
  renderPositionChart();
  const t = state.posTicket;
  if (t && t.kind === 'close' && state.openSheetName === 'posTrade') renderPositionTradeSheet();
}

export async function openOriginalStop(symbol, host) {
  const row = rowOf(symbol);
  if (!row) return;
  const t = state.session ? positionTrade(row) : null;
  state.posOrig = { symbol, host: host || 'actions', text: t && t.stopSource === 'yours' ? String(t.stop) : '', busy: false, error: '' };
  redraw();
  if (state.session && !state.journalRecords) { await readPositionJournalForClose(); redraw(); }
  const input = document.getElementById('posOrigInput');
  if (input && typeof input.focus === 'function') input.focus();
}

/** typing: only the note and Save follow, so the input keeps its focus */
export function setOriginalStopText(value) {
  const o = state.posOrig, row = o && rowOf(o.symbol), t = row && positionTrade(row);
  if (!o || !t) return;
  o.text = String(value ?? '');
  o.error = '';
  const p = preview(t, row, o.text);
  const note = document.getElementById('posOrigNote'), save = document.getElementById('posOrigSave');
  if (note) note.textContent = p.text;
  if (save) save.disabled = !p.ok || !!o.busy;
}

export function cancelOriginalStop() {
  state.posOrig = null;
  redraw();
}

async function saveStop(stop) {
  const o = state.posOrig, row = o && rowOf(o.symbol), t = row && positionTrade(row);
  if (!o || !t || o.busy) return;
  if (stop !== null && !preview(t, row, String(stop)).ok) return;
  const before = state.tradeReviews || {}, was = before[t.key] || { stop: null, deleted: false };
  const rows = { [t.key]: { stop, deleted: !!was.deleted } };
  o.busy = true;
  redraw();
  try {
    await saveTradeReviews(rows);
    state.tradeReviews = { ...(state.tradeReviews || {}), ...rows };
    state.posOrig = null;
    showToast(stop === null ? "R counts from Schwab's first stop again." : `R counts from your original stop, ${fmtPositionPrice(stop, row.tradeAs)}.`);
  } catch(e) {
    o.busy = false;
    o.error = `Couldn't save: ${e?.message || e}`;
  }
  redraw();
}

export function saveOriginalStop() {
  const o = state.posOrig;
  if (o) return saveStop(Number(o.text));
}

export function clearOriginalStop() { return saveStop(null); }
