// Risk strip: max loss input, % and $ chips (both editable, synced presets), the step ladder, and recalculation.
import { state } from '../state.js';
import { store } from '../lib/store.js';
import { updateSizingControls } from './allocation.js';
import { renderPinnedCards } from './cards.js';
import { renderChain } from './chain.js';
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
  const levels = [...getPctPresets().map(p => +(acct * p / 100).toFixed(2)), ...getUsdPresets()];
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

// the preset chips: your standard bets, as % of the account and as fixed dollars, each editable via its pencil chip
// (in place: every chip a box, a blank one deletes, the trailing + box adds), up to 6, always smallest first, and synced
// with your account (risk_pct_presets, risk_usd_presets)

const PRESETS = {
  pct: { key: 'risk_pct_presets', fallback: [0.125, 0.25, 0.5, 1, 2, 3], max: 100, el: 'riskPctPresets', btn: 'pctEditBtn', editing: 'editingPct', toggle: 'togglePctEdit', what: 'percent' },
  usd: { key: 'risk_usd_presets', fallback: [100, 250, 500, 1000], max: Infinity, el: 'riskUsdPresets', btn: 'usdEditBtn', editing: 'editingUsd', toggle: 'toggleUsdEdit', what: 'dollar' },
};
const byValue = (a, b) => a - b;

/** a kind's saved presets, smallest first (a list saved before sorting, or synced, too); the defaults when none */
function presets(kind) {
  const p = PRESETS[kind];
  try {
    const a = JSON.parse(store.get(p.key) || '[]');
    if (Array.isArray(a) && a.length && a.every(v => typeof v === 'number' && v > 0 && v < p.max)) return [...a].sort(byValue);
  } catch(e) {}
  return [...p.fallback];
}
export const getPctPresets = () => presets('pct');
export const getUsdPresets = () => presets('usd');

/** a % chip's words: .125%, .25%, .50%, 1%, 2.5% */
export const pctLabel = v => (v < 1 ? (Number.isInteger(v * 10) ? v.toFixed(2) : String(v)).replace(/^0/, '') : String(v)) + '%';

function renderPresets(kind) {
  const p = PRESETS[kind], el = document.getElementById(p.el), vals = presets(kind), editing = state[p.editing];
  if (editing) {
    // a % box is text so it reads like its chip (.125, not a cut-off 0.1); the keypad is a number pad either way
    const type = kind === 'pct' ? 'type="text"' : 'type="number" min="0" step="any"';
    const shown = v => kind === 'pct' ? pctLabel(v).slice(0, -1) : v;
    el.innerHTML = vals
      .map(v => `<input ${type} class="usd-edit-box" value="${shown(v)}" inputmode="decimal" aria-label="${p.what} preset" data-enter="${p.toggle}" />`)
      .join('')
      + `<input ${type} class="usd-edit-box" placeholder="+" inputmode="decimal" aria-label="New ${p.what} preset" data-enter="${p.toggle}" />`;
  } else {
    el.innerHTML = kind === 'pct'
      ? vals.map(v => `<button class="filter-btn" data-pct="${v}" data-action="setRiskPct" data-arg="${v}">${pctLabel(v)}</button>`).join('')
      : vals.map(v => `<button class="filter-btn" data-usd="${v}" data-action="setRiskUsd" data-arg="${v}">$${v.toLocaleString()}</button>`).join('');
  }
  const btn = document.getElementById(p.btn);
  btn.textContent = editing ? '✓' : '✎';
  btn.title = editing ? `Save the ${p.what} presets` : `Edit the ${p.what} presets`;
  btn.classList.toggle('active', editing);
  updateRiskPresets();
}
export function renderPctPresets() { renderPresets('pct'); }
export function renderUsdPresets() { renderPresets('usd'); }
/** both chip rows (boot, and after a sync brings new presets) */
export function renderRiskPresets() { renderPresets('pct'); renderPresets('usd'); }

function toggleEdit(kind) {
  const p = PRESETS[kind];
  if (state[p.editing]) { // ✓ pressed: collect the boxes, the first 6 typed, smallest first
    const vals = [...new Set([...document.querySelectorAll(`#${p.el} .usd-edit-box`)]
      .map(b => parseFloat(b.value)).filter(v => v > 0 && v < p.max))].slice(0, 6).sort(byValue);
    if (vals.length) store.set(p.key, JSON.stringify(vals));
  }
  state[p.editing] = !state[p.editing];
  renderPresets(kind);
  if (state[p.editing]) { const first = document.querySelector(`#${p.el} .usd-edit-box`); if (first) first.select(); }
}
export function togglePctEdit() { toggleEdit('pct'); }
export function toggleUsdEdit() { toggleEdit('usd'); }

export function setRiskUsd(v) {
  document.getElementById('riskDollar').value = v;
  syncFromDollar();
}

export function syncFromDollar() {
  const acct = parseFloat(document.getElementById('accountSize').value) || 0;
  const d = parseFloat(document.getElementById('riskDollar').value) || 0;
  if (acct > 0) {
    // Keep cents when a small position (one micro contract) is converted to % and back.
    document.getElementById('riskPct').value = +(d / acct * 100).toFixed(10);
  }
  store.set('calc_account', acct);
  store.set('calc_risk', document.getElementById('riskPct').value);
  updateRiskPresets();
  updateRiskStatus();
  state.flashNext = true;
  if (state.quoteData) { renderShares(); renderChain(); }
  renderPinnedCards();
  state.flashNext = false;
  updateStickyBar();
}

export function recalcAll() {
  updateSizingControls();
  syncRiskDollar();
  state.flashNext = true;
  if (state.quoteData) {
    renderShares();
    renderChain();
  }
  renderPinnedCards();
  state.flashNext = false;
  updateStickyBar();
}

/** a $ chip is lit and no % chip is: an account size change keeps those dollars instead of the risk % */
export function riskFollowsDollars() {
  const usd = riskDollars();
  const pct = parseFloat(document.getElementById('riskPct').value);
  return getUsdPresets().some(v => Math.abs(v - usd) < 0.5) && !getPctPresets().includes(pct);
}

export function riskDollars() {
  return parseFloat(document.getElementById('riskDollar').value) || 0;
}

/** the max loss per trade a stop is checked against; 0 in allocation sizing, which has none */
export function maxLossPerTrade() {
  return state.sizingMode === 'allocation' ? 0 : riskDollars();
}
