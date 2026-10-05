import { state } from '../state.js';
import { store } from '../lib/store.js';
import { updateSizingControls } from './allocation.js';
import { renderPinnedCards } from './cards.js';
import { renderChain } from './chain.js';
import { renderFutures } from './futures.js';
import { renderSavedCards } from './positions.js';
import { renderShares } from './shares.js';
import { updateStickyBar } from './sticky-bar.js';

export function syncRiskDollar() {
  const acct = parseFloat(document.getElementById('accountSize').value) || 0;
  const pct = parseFloat(document.getElementById('riskPct').value) || 0;
  document.getElementById('riskDollar').value = +(acct * pct / 100).toFixed(2);
  store.set('calc_account', acct);
  store.set('calc_risk', pct);
  updateRiskPresets();
  updateRiskStatus();
}

export function updateRiskStatus() {
  const alloc = state.sizingMode === 'allocation';
  const acct = parseFloat(document.getElementById('accountSize').value) || 0;
  const pct = alloc ? document.getElementById('allocationPct').value : +(parseFloat(document.getElementById('riskPct').value) || 0).toFixed(4);
  document.getElementById('riskStripTitle').textContent = alloc ? 'Allocation' : 'Max loss per trade';
  document.getElementById('riskStrip').classList.toggle('alloc', alloc);
  document.getElementById('riskStatus').textContent = `${pct}% of $${Math.round(acct).toLocaleString('en-US')}`;
}

// - and = walk one ladder of every preset you have: the % chips at this account size plus your $ chips

export function riskLadder() {
  const acct = parseFloat(document.getElementById('accountSize').value) || 0;
  const pcts = [...document.querySelectorAll('#riskPresets .filter-btn[data-pct]')].map(b => +b.dataset.pct);
  const levels = [...(pcts.length ? pcts : [0.125, 0.25, 0.5, 1, 2, 3]).map(p => +(acct * p / 100).toFixed(2)), ...getUsdPresets()];
  return [...new Set(levels.filter(v => v > 0))].sort((a, b) => a - b);
}

export function stepRisk(dir) {
  if (state.sizingMode === 'allocation') return;
  const cur = riskDollars();
  const ladder = riskLadder();
  const next = dir > 0 ? ladder.find(v => v > cur + 0.005) : [...ladder].reverse().find(v => v < cur - 0.005);
  if (next !== undefined) setRiskUsd(next);
}

export function setRiskPct(pct) {
  document.getElementById('riskPct').value = pct;
  recalcAll();
}

export function updateRiskPresets() {
  const pct = parseFloat(document.getElementById('riskPct').value);
  document.querySelectorAll('#riskPresets .filter-btn[data-pct]').forEach(b => {
    b.classList.toggle('active', parseFloat(b.dataset.pct) === pct);
  });
  const usd = riskDollars();
  document.querySelectorAll('#riskUsdPresets .filter-btn[data-usd]').forEach(b => {
    b.classList.toggle('active', Math.abs(parseFloat(b.dataset.usd) - usd) < 0.5);
  });
}

// fixed dollar presets: your standard bets, editable via the pencil chip

export function getUsdPresets() {
  try {
    const a = JSON.parse(store.get('risk_usd_presets') || '[]');
    if (Array.isArray(a) && a.length && a.every(v => v > 0)) return a;
  } catch(e) {}
  return [100, 250, 500, 1000];
}

export function renderUsdPresets() {
  const el = document.getElementById('riskUsdPresets');
  if (state.editingUsd) {
    // the chips themselves become editable; a blank box deletes that preset, the trailing box adds one
    el.innerHTML = getUsdPresets()
      .map(v => `<input type="number" class="usd-edit-box" value="${v}" min="0" inputmode="decimal" onkeydown="if(event.key==='Enter')toggleUsdEdit()" />`)
      .join('')
      + `<input type="number" class="usd-edit-box" placeholder="+" min="0" inputmode="decimal" onkeydown="if(event.key==='Enter')toggleUsdEdit()" />`;
  } else {
    el.innerHTML = getUsdPresets()
      .map(v => `<button class="filter-btn" data-usd="${v}" onclick="setRiskUsd(${v})">$${v.toLocaleString()}</button>`)
      .join('');
  }
  const btn = document.getElementById('usdEditBtn');
  btn.textContent = state.editingUsd ? '✓' : '✎';
  btn.title = state.editingUsd ? 'Save the dollar presets' : 'Edit the dollar presets';
  btn.classList.toggle('active', state.editingUsd);
  updateRiskPresets();
}

export function setRiskUsd(v) {
  document.getElementById('riskDollar').value = v;
  syncFromDollar();
}

export function toggleUsdEdit() {
  if (state.editingUsd) { // ✓ pressed: collect the boxes
    const vals = [...new Set([...document.querySelectorAll('.usd-edit-box')]
      .map(b => parseFloat(b.value)).filter(v => v > 0))].slice(0, 6);
    if (vals.length) store.set('risk_usd_presets', JSON.stringify(vals));
  }
  state.editingUsd = !state.editingUsd;
  renderUsdPresets();
  if (state.editingUsd) { const first = document.querySelector('.usd-edit-box'); if (first) first.select(); }
}

export function syncFromDollar() {
  const acct = parseFloat(document.getElementById('accountSize').value) || 0;
  const d = parseFloat(document.getElementById('riskDollar').value) || 0;
  if (acct > 0) {
    // Keep cents when a small futures position is converted to % and back.
    document.getElementById('riskPct').value = +(d / acct * 100).toFixed(10);
  }
  store.set('calc_account', acct);
  store.set('calc_risk', document.getElementById('riskPct').value);
  updateRiskPresets();
  updateRiskStatus();
  state.flashNext = true;
  renderFutures();
  if (state.quoteData) { renderShares(); renderChain(); }
  renderPinnedCards();
  renderSavedCards();
  state.flashNext = false;
  updateStickyBar();
}

export function recalcAll() {
  updateSizingControls();
  syncRiskDollar();
  state.flashNext = true;
  renderFutures();
  if (state.quoteData) {
    renderShares();
    renderChain();
  }
  renderPinnedCards();
  renderSavedCards();
  state.flashNext = false;
  updateStickyBar();
}

export function riskDollars() {
  return parseFloat(document.getElementById('riskDollar').value) || 0;
}
