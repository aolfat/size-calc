// Risk strip: max loss input, one row of preset chips ($ over %, editable, synced), the step ladder, and recalculation.
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
  renderRiskPresets(); // a % chip's dollars follow the account size
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
  const usd = riskDollars();
  document.querySelectorAll('#riskPresets .risk-chip').forEach(b => {
    const v = parseFloat(b.dataset.value);
    // a % chip by its percent, or by its dollars when the max loss got there another way (a $ chip, - / =, typing)
    b.classList.toggle('active', b.dataset.kind === 'pct' ? v === pct || Math.abs(parseFloat(b.dataset.usd) - usd) < 0.005 : Math.abs(v - usd) < 0.5);
  });
}

// the preset chips: your standard bets, one row of chips each showing its dollars over its percent of the account
// (owner request), smallest first. Each keeps the unit it was added in: a % chip follows the account size, a $ chip
// stays put. Edit puts a × on every chip and an add box that takes either. Two synced lists underneath, up to 6 each
// (risk_pct_presets, risk_usd_presets).

const PRESETS = {
  pct: { key: 'risk_pct_presets', fallback: [0.125, 0.25, 0.5, 1, 2, 3], max: 100, what: 'percent' },
  usd: { key: 'risk_usd_presets', fallback: [100, 250, 500, 1000], max: Infinity, what: 'dollar' },
};
const MAX_PRESETS = 6;
const byValue = (a, b) => a - b;

/** a kind's saved presets, smallest first (a list saved before sorting, or synced, too); the defaults until one is saved */
function presets(kind) {
  const p = PRESETS[kind], raw = store.get(p.key);
  if (raw == null) return [...p.fallback];
  try {
    const a = JSON.parse(raw);
    if (Array.isArray(a) && a.every(v => typeof v === 'number' && v > 0 && v < p.max)) return [...a].sort(byValue);
  } catch(e) {}
  return [...p.fallback];
}
export const getPctPresets = () => presets('pct');
export const getUsdPresets = () => presets('usd');

/** a % chip's words: .125%, .25%, .50%, 1%, 2.5% */
export const pctLabel = v => (v < 1 ? (Number.isInteger(v * 10) ? v.toFixed(2) : String(v)).replace(/^0/, '') : String(v)) + '%';

const accountSize = () => parseFloat(document.getElementById('accountSize').value) || 0;
const cents = v => Math.round(v * 100) / 100;

/** a chip's dollars: whole dollars from $100 up, cents below when there are any */
export const usdChipLabel = v => '$' + (v >= 100 || Number.isInteger(v) ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));

/** what a $ chip is of the account: .069%, .35%, 1.38% (three figures at most) */
export function pctOfAccountLabel(usd, acct = accountSize()) {
  if (!(acct > 0)) return '';
  const p = usd / acct * 100;
  const s = p >= 1 ? +p.toFixed(2) : +p.toPrecision(p >= 0.1 ? 3 : 2);
  return String(s).replace(/^0(?=\.)/, '') + '%';
}

/** every chip in one list, smallest first: { kind, v, usd }; a $ preset that lands on a % chip's dollars shows once, as the % chip */
export function riskChips(acct = accountSize()) {
  const chips = getPctPresets().map(v => ({ kind: 'pct', v, usd: cents(acct * v / 100) }));
  for (const v of getUsdPresets()) if (!chips.some(c => Math.abs(c.usd - v) < 0.005)) chips.push({ kind: 'usd', v, usd: v });
  return chips.sort((a, b) => a.usd - b.usd || (a.kind === 'pct' ? -1 : 1));
}

export function renderRiskPresets() {
  const el = document.getElementById('riskPresets'), acct = accountSize(), editing = state.editingRisk;
  const chips = riskChips(acct);
  const cols = chips.length <= 6 ? chips.length : Math.ceil(chips.length / 2);
  el.style.gridTemplateColumns = `repeat(${Math.max(cols, 1)}, minmax(0, 1fr))`;
  el.innerHTML = chips.map(c => {
    const isUsd = c.kind === 'usd';
    const usd = usdChipLabel(c.usd), pct = !isUsd ? pctLabel(c.v) : pctOfAccountLabel(c.usd, acct);
    const words = `${usd}${pct ? `, ${pct} of the account` : ''}`;
    const chip = `<button class="filter-btn risk-chip" data-kind="${c.kind}" data-value="${c.v}" data-usd="${c.usd}" data-action="${isUsd ? 'setRiskUsd' : 'setRiskPct'}" data-arg="${c.v}" aria-label="${words}"><span class="rc-usd">${usd}</span><span class="rc-pct">${pct || '&nbsp;'}</span></button>`;
    return editing
      ? `<span class="risk-chip-wrap">${chip}<button class="risk-chip-x" data-action="removeRiskPreset" data-arg="${c.kind}" data-arg2="${c.v}" aria-label="Remove ${words}" title="Remove">×</button></span>`
      : chip;
  }).join('');
  const btn = document.getElementById('riskEditBtn');
  btn.textContent = editing ? 'Done' : 'Edit';
  btn.title = editing ? 'Done editing the presets' : 'Add or remove presets, in dollars or percent';
  btn.setAttribute('aria-pressed', String(!!editing));
  document.getElementById('riskAddRow').style.display = editing ? '' : 'none';
  for (const u of ['usd', 'pct']) {
    const b = document.getElementById(u === 'usd' ? 'riskAddUsd' : 'riskAddPct');
    b.classList.toggle('active', state.riskAddUnit === u);
    b.setAttribute('aria-pressed', String(state.riskAddUnit === u));
  }
  document.getElementById('riskAddNote').textContent = editing ? state.riskAddNote : '';
  updateRiskPresets();
}

export function toggleRiskEdit() {
  state.editingRisk = !state.editingRisk;
  state.riskAddNote = '';
  if (!state.editingRisk) document.getElementById('riskAddInput').value = '';
  renderRiskPresets();
  if (state.editingRisk) document.getElementById('riskAddInput').focus();
}

export function setRiskAddUnit(unit) {
  state.riskAddUnit = unit === 'pct' ? 'pct' : 'usd';
  renderRiskPresets();
}

/** a typed preset: '75', '$1,500', '0.1%' or '.1' with % picked; null when it isn't one */
export function parseRiskPreset(text, unit = 'usd') {
  const t = String(text || '').trim().replace(/[\s,$]/g, '');
  const m = t.match(/^(\d*\.?\d+)(%?)$/);
  if (!m) return null;
  const v = parseFloat(m[1]), kind = m[2] ? 'pct' : unit === 'pct' ? 'pct' : 'usd';
  if (!(v > 0) || v >= PRESETS[kind].max) return null;
  return { kind, v: kind === 'usd' ? cents(v) : +v.toFixed(4) };
}

function savePresets(kind, vals) {
  store.set(PRESETS[kind].key, JSON.stringify([...vals].sort(byValue)));
}

export function addRiskPreset() {
  const input = document.getElementById('riskAddInput');
  const p = parseRiskPreset(input.value, state.riskAddUnit);
  if (!p) {
    state.riskAddNote = state.riskAddUnit === 'pct' ? 'Type a percent under 100, like 0.1.' : 'Type a dollar amount, like 75. Or a percent, like 0.1%.';
  } else {
    const list = presets(p.kind), acct = accountSize();
    const usd = p.kind === 'pct' ? cents(acct * p.v / 100) : p.v;
    const label = p.kind === 'pct' ? pctLabel(p.v) : usdChipLabel(p.v);
    if (list.includes(p.v) || riskChips(acct).some(c => Math.abs(c.usd - usd) < 0.005)) state.riskAddNote = `${label} is already there.`;
    else if (list.length >= MAX_PRESETS) state.riskAddNote = `Six ${PRESETS[p.kind].what} presets at most. Remove one first.`;
    else {
      savePresets(p.kind, [...list, p.v]);
      state.riskAddNote = `Added ${label}.`;
      input.value = '';
    }
  }
  renderRiskPresets();
}

export function removeRiskPreset(kind, v) {
  if (!PRESETS[kind]) return;
  savePresets(kind, presets(kind).filter(x => x !== v));
  state.riskAddNote = '';
  renderRiskPresets();
}

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
  renderRiskPresets();
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
