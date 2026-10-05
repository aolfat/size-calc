import { state } from '../state.js';
import { fmt$, fmtFuturesPrice } from '../core/format.js';
import { FUTURES_CONTRACTS, calcFutures } from '../core/futures.js';
import { riskForQty } from '../core/sizing.js';
import { store } from '../lib/store.js';
import { copyPlainText } from './copy-text.js';
import { withFlash } from './feedback.js';
import { syncFromDollar } from './risk.js';
import { effects } from './effects.js';

export function initFutures() {
  const select = document.getElementById('futuresContract');
  select.innerHTML = Object.entries(FUTURES_CONTRACTS)
    .map(([symbol, d]) => `<option value="${symbol}">${symbol} · ${d.name}</option>`).join('')
    + '<option value="custom">Custom contract</option>';
  const saved = store.get('futures_contract');
  select.value = Object.hasOwn(FUTURES_CONTRACTS, saved) || saved === 'custom' ? saved : 'MES';
  applyFuturesContract();
}

export function applyFuturesContract() {
  const symbol = document.getElementById('futuresContract').value;
  const preset = Object.hasOwn(FUTURES_CONTRACTS, symbol) ? FUTURES_CONTRACTS[symbol] : null;
  const size = document.getElementById('futuresTickSize');
  const value = document.getElementById('futuresTickValue');
  size.readOnly = value.readOnly = !!preset;
  size.value = preset ? preset.tickSize : (store.get('futures_custom_tick_size') || '');
  value.value = preset ? preset.tickValue : (store.get('futures_custom_tick_value') || '');
  renderFutures();
}

export function futuresContractChanged() {
  store.set('futures_contract', document.getElementById('futuresContract').value);
  // Prices and commissions belong to the selected instrument, never the next one.
  ['futuresEntry', 'futuresStop', 'futuresFees'].forEach(id => document.getElementById(id).value = '');
  applyFuturesContract();
}

export function futuresSpecsChanged() {
  if (document.getElementById('futuresContract').value === 'custom') {
    store.set('futures_custom_tick_size', document.getElementById('futuresTickSize').value);
    store.set('futures_custom_tick_value', document.getElementById('futuresTickValue').value);
  }
  renderFutures();
}

export function setFuturesDirection(dir) {
  state.futuresDirection = dir;
  document.getElementById('futuresLong').className = dir === 'long' ? 'active long' : '';
  document.getElementById('futuresShort').className = dir === 'short' ? 'active short' : '';
  document.getElementById('futuresStop').placeholder = dir === 'long' ? 'Below entry' : 'Above entry';
  renderFutures();
}

export function futuresInputs() {
  const number = id => parseFloat(document.getElementById(id).value);
  return {
    risk: number('riskDollar'), entry: number('futuresEntry'), stop: number('futuresStop'),
    direction: state.futuresDirection, tickSize: number('futuresTickSize'), tickValue: number('futuresTickValue'),
    fees: document.getElementById('futuresFees').value === '' ? 0 : number('futuresFees')
  };
}

export function renderFutures() {
  const input = futuresInputs();
  const result = calcFutures(input);
  const validSpec = Number.isFinite(input.tickSize) && input.tickSize > 0 && Number.isFinite(input.tickValue) && input.tickValue > 0;
  document.getElementById('futuresSpecInfo').textContent = validSpec
    ? `${fmt$(input.tickValue / input.tickSize)} per point per contract`
    : 'Custom contract: enter its tick size and dollar value per tick.';
  ['futuresEntry', 'futuresStop'].forEach(id => document.getElementById(id).step = validSpec ? input.tickSize : 'any');
  const el = document.getElementById('futuresStats');
  document.getElementById('futuresCopy').disabled = !!result.error || result.contracts < 1;
  if (result.error) {
    el.innerHTML = '';
    document.getElementById('futuresMessage').textContent = result.error;
    return;
  }
  document.getElementById('futuresMessage').textContent = result.contracts === 0
    ? `Budget is below one contract's ${fmt$(result.riskPerContract)} risk.` : '';
  const acct = parseFloat(document.getElementById('accountSize').value);
  const acctPct = acct > 0 ? `${(result.totalRisk / acct * 100).toFixed(2)}% of acct` : 'set account size for %';
  el.innerHTML = `
    <div class="stat highlight"><div class="s-label">Contracts</div><div class="s-val"><input type="number" class="s-val-input" aria-label="Futures contracts" value="${result.contracts}" min="0" step="1" title="Type a contract count, risk $ follows" onchange="futuresQtyChanged(this)" /></div><div class="s-sub">to ${input.direction === 'long' ? 'buy' : 'short'} · edit to set risk</div></div>
    <div class="stat danger"><div class="s-label">Risk @ stop</div><div class="s-val">${fmt$(result.totalRisk)}</div><div class="s-sub">${acctPct}</div></div>
    <div class="stat teal"><div class="s-label">Risk / contract</div><div class="s-val">${fmt$(result.riskPerContract)}</div><div class="s-sub">${result.ticks} ticks × ${fmt$(input.tickValue)}${input.fees > 0 ? ' + ' + fmt$(input.fees) + ' fees' : ''}</div></div>
    <div class="stat"><div class="s-label">Stop distance</div><div class="s-val">${fmtFuturesPrice(result.points)} pts</div><div class="s-sub">${fmtFuturesPrice(input.entry)} → ${fmtFuturesPrice(input.stop)}</div></div>
  `;
  withFlash(el);
}

export function futuresQtyChanged(el) {
  const qty = Math.floor(parseFloat(el.value));
  const result = calcFutures(futuresInputs());
  if (result.error || !Number.isSafeInteger(qty) || qty < 0) { renderFutures(); return; }
  document.getElementById('riskDollar').value = riskForQty(qty, result.riskPerContract);
  syncFromDollar();
}

export function copyFutures() {
  const input = futuresInputs();
  const result = calcFutures(input);
  if (result.error || result.contracts < 1) return;
  const symbol = document.getElementById('futuresContract').value;
  const label = symbol === 'custom' ? 'custom futures' : symbol;
  effects.copyPlainText(`${input.direction === 'long' ? 'Long' : 'Short'} ${result.contracts} ${label} contract${result.contracts === 1 ? '' : 's'} @ ${fmtFuturesPrice(input.entry)} · stop ${fmtFuturesPrice(input.stop)} · ${result.ticks} ticks × ${fmt$(input.tickValue)}/tick · risk @ stop ${fmt$(result.totalRisk)}${input.fees > 0 ? ` incl. ${fmt$(input.fees)}/ct round-trip fees` : ' before fees'} · excludes slippage`);
}
