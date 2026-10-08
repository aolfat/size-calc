// Saved positions: persisted cards with your fill, quantity and stop, P&L, and refresh.
import { state } from '../state.js';
import { fmt$ } from '../core/format.js';
import { isBull, spreadWidth, strikesLabel } from '../core/options.js';
import { optionDte } from '../core/sizing.js';
import { store } from '../lib/store.js';
import { mergeTombstones } from '../services/backup.js';
import { quantityForCard, renderAllocationCard } from './allocation.js';
import { recalcPinnedStop, refreshCardData } from './cards.js';
import { showError, withFlash } from './feedback.js';
import { requireKey } from './settings.js';

export function persistSaved() {
  store.set('saved_positions', JSON.stringify(state.savedData));
}

export function saveCard(cardId) {
  const d = state.pinnedData[cardId];
  if (!d) return;
  const id = 'saved_' + Date.now();
  if (d.sizing === 'allocation' && quantityForCard(d) < 1) return;
  // entry defaults to the current mid; qty to the risk-sized count — edit both to your real fill
  state.savedData[id] = Object.assign({}, d, { ...(d.sizing === 'allocation' ? { entryDte: optionDte(d.parsed.expStr) } : {}), entry: d.mid, qty: d.sizing === 'allocation' ? quantityForCard(d) : Math.max(1, quantityForCard(d)) });
  addSavedDiv(id);
  renderSavedCard(id);
  persistSaved();
  updateSavedBar();
}

export function addSavedDiv(id) {
  const div = document.createElement('div');
  div.className = 'pinned-card saved-card';
  div.id = id;
  document.getElementById('savedSection').prepend(div);
}

export function removeSaved(id) {
  delete state.savedData[id];
  const el = document.getElementById(id);
  if (el) el.remove();
  mergeTombstones({ [id]: Date.now() }); // so the delete propagates through sync/import merges
  persistSaved();
  updateSavedBar();
}

export function savedEntryChanged(id, el) {
  const d = state.savedData[id];
  const v = parseFloat(el.value);
  if (d && Number.isFinite(v) && v > 0 && (!d.shortPut || v < d.parsed.strike)) { d.entry = v; persistSaved(); }
  state.flashNext = true; renderSavedCard(id); state.flashNext = false;
}

export function savedQtyChanged(id, el) {
  const d = state.savedData[id];
  const v = Math.floor(parseFloat(el.value) || 0);
  if (d && Number.isSafeInteger(v) && v >= 0) { d.qty = v; persistSaved(); }
  state.flashNext = true; renderSavedCard(id); state.flashNext = false;
}

export function savedStopChanged(id, el) {
  const d = state.savedData[id];
  if (!d) return;
  const v = parseFloat(el.value);
  if (!isNaN(v) && v > 0) {
    d.stopLevel = v;
    d.stopName = 'stop';
    recalcPinnedStop(d);
    persistSaved();
  }
  state.flashNext = true; renderSavedCard(id); state.flashNext = false;
}

export async function refreshSaved(id) {
  const d = state.savedData[id];
  if (!d) return;
  if (!requireKey()) return;
  try {
    await refreshCardData(d);
    persistSaved();
    renderSavedCard(id);
  } catch(e) {
    showError('Position refresh failed — check key/network.');
  }
}

export function refreshAllSaved() {
  Object.keys(state.savedData).forEach(refreshSaved);
}

export function updateSavedBar() {
  const n = Object.keys(state.savedData).length;
  document.getElementById('posCount').textContent = n ? String(n) : '';
  document.getElementById('savedBar').innerHTML = n
    ? `<div class="section-title" style="margin:4px 0 10px;">Saved positions (${n})<button class="btn" style="font-size:11px;padding:3px 10px;margin-left:10px;" data-action="refreshAllSaved">↻ Refresh all</button></div>`
    : '<div class="card empty-card"><div class="setup-title">No saved positions yet</div><p>Pin a contract from the chain or quick lookup, then press <b>save</b> on its card to track it here.</p></div>';
}

export function renderSavedCard(id) {
  const d = state.savedData[id];
  const el = document.getElementById(id);
  if (!d || !el) return;
  if (d.sizing === 'allocation') { renderAllocationCard(id, d, true); return; }
  const acct = parseFloat(document.getElementById('accountSize').value) || 1;
  const qty = d.qty || 0;
  const sgn = d.credit ? -1 : 1; // credit spreads profit when the spread gets cheaper to buy back
  const pnl = sgn * (d.mid - d.entry) * 100 * qty;
  const pnlPct = d.entry > 0 ? (sgn * (d.mid - d.entry) / d.entry * 100) : 0;
  // what the stop-out is worth measured from YOUR entry, not from mid
  const lossAtStop = sgn * (d.entry - d.atLod) * 100 * qty;
  const lossAtStopON = sgn * (d.entry - d.atLodON) * 100 * qty;
  const cost = d.entry * 100 * qty;
  el.innerHTML = `
    <div class="pinned-header">
      <span class="tag ${isBull(d) ? 'call' : 'put'}">${d.isCall ? 'Call' : 'Put'}</span>
      <span class="pinned-symbol">${d.parsed.ticker} ${strikesLabel(d)} ${d.parsed.expStr}</span>
      <span class="pinned-badge" style="font-size:10px;padding:2px 7px;border-radius:3px;background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-bd);font-weight:600;letter-spacing:0.04em;">${d.kind === 'spread' ? (d.credit ? 'CREDIT SPREAD POSITION' : 'SPREAD POSITION') : 'POSITION'}</span>
      <span class="pinned-meta" style="font-size:12px;color:var(--text2);margin-left:4px;font-family:var(--num);">underlying ${fmt$(d.underlyingPrice)} &nbsp;·&nbsp; <span style="color:var(--red);">${d.stopName} $<input type="number" class="s-val-input" value="${d.stopLevel.toFixed(2)}" step="0.01" min="0" title="Edit the stop, position recalculates" data-change="savedStopChanged" data-arg="${id}" style="width:64px;font-size:12px;color:var(--red);" /> (${d.lodPct}%)</span> &nbsp;·&nbsp; ${d.asOf || ''}</span>
      <button class="card-act" data-action="copySaved" data-arg="${id}" title="Copy as text for the live chat" style="margin-left:auto;background:none;border:none;color:var(--text2);cursor:pointer;font-size:12px;line-height:1;font-weight:600;">copy</button>
      <button class="card-act" data-action="shareSaved" data-arg="${id}" title="Copy this position as an image" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:12px;line-height:1;font-weight:600;">share</button>
      <button class="card-act" data-action="simFromSaved" data-arg="${id}" title="Simulate returns over time from your entry (Black-Scholes)" style="background:none;border:none;color:var(--teal);cursor:pointer;font-size:12px;line-height:1;font-weight:600;">sim</button>
      <button class="card-act" data-action="refreshSaved" data-arg="${id}" title="Refresh quote" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:14px;line-height:1;">↻</button>
      <button class="card-act" data-action="removeSaved" data-arg="${id}" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:16px;line-height:1;">×</button>
    </div>
    <div class="stat-grid">
      <div class="stat highlight"><div class="s-label">${d.kind === 'spread' ? (d.credit ? 'Credit / spread' : 'Debit / spread') : 'Entry / ct'}</div><div class="s-val"><input type="number" class="s-val-input" value="${d.entry.toFixed(2)}" step="0.01" min="0" title="Your fill price" data-change="savedEntryChanged" data-arg="${id}" /></div><div class="s-sub">edit to your fill${d.credit && spreadWidth(d) > 0 ? ` · ${(d.entry / spreadWidth(d) * 100).toFixed(0)}% of width` : ''}</div></div>
      <div class="stat"><div class="s-label">Contracts</div><div class="s-val"><input type="number" class="s-val-input" value="${qty}" step="1" min="0" title="Contracts you hold (does not change risk $)" data-change="savedQtyChanged" data-arg="${id}" /></div><div class="s-sub">${fmt$(cost)} ${d.credit ? 'credit received' : 'at entry'}</div></div>
      <div class="stat ${pnl >= 0 ? 'good' : 'danger'}"><div class="s-label">P&amp;L now</div><div class="s-val">${pnl >= 0 ? '+' : '−'}${fmt$(Math.abs(pnl))}</div><div class="s-sub">mid ${fmt$(d.mid)} · ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</div></div>
      <div class="stat ${lossAtStop > 0 ? 'danger' : 'good'}"><div class="s-label">${lossAtStop > 0 ? 'Loss @ stop' : 'Locked @ stop'}</div><div class="s-val">${lossAtStop > 0 ? '−' : '+'}${fmt$(Math.abs(lossAtStop))}</div><div class="s-sub">${(Math.abs(lossAtStop) / acct * 100).toFixed(2)}% of acct · from your entry${qty > 0 && lossAtStopON > lossAtStop + 0.005 ? `<br>held overnight: −${fmt$(lossAtStopON)}` : ''}</div></div>
      <div class="stat teal"><div class="s-label">${d.kind === 'spread' ? (d.credit ? 'Close @ stop' : 'Value @ stop') : 'Premium @ stop'}</div><div class="s-val">${fmt$(d.atLod)}</div><div class="s-sub">${d.kind === 'spread' ? 'BS both legs' : 'Δ × move'} to ${d.stopName}</div></div>
    </div>
  `;
  withFlash(el);
}

export function renderSavedCards() {
  Object.keys(state.savedData).forEach(renderSavedCard);
}

export function loadSaved() {
  try {
    const raw = store.get('saved_positions');
    if (!raw) return;
    Object.assign(state.savedData, JSON.parse(raw));
    Object.keys(state.savedData).sort().forEach(id => { addSavedDiv(id); renderSavedCard(id); });
    updateSavedBar();
  } catch(e) {}
}
