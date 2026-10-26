// Opening-range breakout chips on the shares ticket: 5m / 15m / 30m read today's first 5-minute bars from Tradier and set the
// entry a tick past the range and the stop at its other side; Trade at Schwab then sends it as a stop entry.
import { state } from '../state.js';
import { ORB_MINUTES, openingRange, orbLevels } from '../core/bars.js';
import { fmt$ } from '../core/format.js';
import { fetchFiveMinuteBars } from './chart.js';
import { requireKey } from './settings.js';
import { rawStop, stopsChanged } from './stops.js';

const inputText = p => p.toFixed(p >= 1 ? 2 : 4);

/** the range the chips last set, while the ticket still holds what it set: same symbol and direction, entry and stop untouched */
export function orbActive() {
  const o = state.orb, q = state.quoteData;
  if (!o || !q || o.symbol !== q.symbol || o.isLong !== (state.direction === 'long') || state.currentMode !== 'shares') return null;
  return Math.abs(rawStop('entryPrice') - o.entry) < 1e-9 && Math.abs(rawStop(o.isLong ? 'stopLong' : 'stopShort') - o.stop) < 1e-9 ? o : null;
}

/** '15m range high' for the entry, '15m range low' for a long's stop; '' when the chips didn't set it */
export function orbEntryName() { const o = orbActive(); return o ? `${o.minutes}m range ${o.isLong ? 'high' : 'low'}` : ''; }
export function orbStopName(isLong) { const o = orbActive(); return o && o.isLong === isLong ? `${o.minutes}m range ${isLong ? 'low' : 'high'}` : ''; }

/** a chip: today's first `minutes` of bars, read fresh (the range may have closed since the chart loaded) */
export async function setOrb(minutes) {
  const q = state.quoteData;
  if (!q || state.orbBusy || !ORB_MINUTES.includes(minutes) || state.currentMode !== 'shares' || state.sizingMode !== 'risk') return;
  if (!requireKey()) return;
  const symbol = q.symbol;
  state.orbBusy = minutes;
  state.orbNote = '';
  renderOrb();
  let bars = null;
  try { bars = await fetchFiveMinuteBars(symbol); } catch(e) {}
  state.orbBusy = 0;
  if (state.quoteData?.symbol !== symbol) { renderOrb(); return; } // the ticker changed meanwhile
  const range = bars ? openingRange(bars, minutes, Date.now()) : null;
  if (!range || range.error) {
    state.orbNote = range ? range.error : `Tradier would not send ${symbol}'s 5-minute bars. They need a brokerage-linked key.`;
    renderOrb();
    return;
  }
  const isLong = state.direction === 'long', { entry, stop } = orbLevels(range, isLong);
  document.getElementById('entryPrice').value = inputText(entry);
  document.getElementById(isLong ? 'stopLong' : 'stopShort').value = inputText(stop);
  state.orb = { symbol, minutes, isLong, high: range.high, low: range.low, end: range.end, entry, stop };
  stopsChanged();
}

/** the chips and the line under them: shares sized on risk only, since Trade at Schwab is */
export function renderOrb() {
  const row = document.getElementById('orbRow');
  const show = !!state.quoteData && state.currentMode === 'shares' && state.sizingMode === 'risk';
  row.style.display = show ? '' : 'none';
  if (!show) return;
  const o = orbActive(), busy = state.orbBusy;
  document.getElementById('orbChips').innerHTML = ORB_MINUTES.map(m => {
    const on = !!o && o.minutes === m;
    return `<button class="filter-btn${on ? ' active' : ''}" aria-pressed="${on}" data-action="setOrb" data-arg="${m}" title="Entry a tick past the first ${m} minutes' range, stop at its other side"${busy ? ' disabled' : ''}>${m}m</button>`;
  }).join('');
  const hint = document.getElementById('orbHint');
  hint.className = 'orb-hint' + (state.orbNote && !busy ? ' warn' : '');
  hint.textContent = busy ? 'Reading today\'s 5-minute bars…'
    : state.orbNote ? state.orbNote
    : o ? `${o.minutes}m range ${fmt$(o.low)} to ${fmt$(o.high)}, 9:30 to ${o.end.replace(/^0/, '')} ET. Entry a tick ${o.isLong ? 'over the high' : 'under the low'}, stop at the ${o.isLong ? 'low' : 'high'}.`
    : 'Breakout entry: a tick past the range, stop at its other side.';
}
