import { state } from '../state.js';
import { effectivePrice } from '../core/extended-hours.js';
import { fmt$ } from '../core/format.js';
import { normalizeAtrMultiplier, normalizeStopStrategy, parseStopPercent } from '../core/stops.js';
import { store } from '../lib/store.js';
import { setSizingMode } from './allocation.js';
import { renderChain } from './chain.js';
import { drawChart } from './chart.js';
import { drawDailyChart, renderAdr } from './daily.js';
import { renderShares } from './shares.js';

export function setDirection(dir) {
  state.direction = dir;
  if (dir === 'short' && state.sizingMode === 'allocation') setSizingMode('risk');
  const l = document.getElementById('dirLong');
  const s = document.getElementById('dirShort');
  l.className = dir === 'long' ? 'active long' : '';
  s.className = dir === 'short' ? 'active short' : '';
  updateStopVisibility();
  renderAdr();
  renderShares();
  if (state.chartBars.length) drawChart();
}

// ---------- global stop pair: one long stop (calls), one short stop (puts) ----------

export function rawStop(id) { // 0 = input blank, fall back to LOD/HOD
  const v = parseFloat(document.getElementById(id).value);
  return (!isNaN(v) && v > 0) ? v : 0;
}

export function currentAtr5() { return state.atr5 && state.atr5.symbol === state.quoteData?.symbol ? state.atr5 : null; }

export function adjustedStop(level, isLong, atr) {
  if (!(level > 0) || !Number.isFinite(level)) return NaN;
  if (state.stopStrategy === 'none') return level;
  let buffer;
  if (state.stopStrategy === 'percent') {
    if (!Number.isFinite(state.stopPercent)) return NaN;
    buffer = level * state.stopPercent / 100;
  } else {
    if (!atr || !Number.isFinite(atr.value) || atr.value < 0) return NaN;
    buffer = state.atrMultiplier * atr.value;
  }
  if (!buffer) return level;
  const price = level + (isLong ? -1 : 1) * buffer;
  // Round outward so the displayed, orderable stop matches the sizing calculation.
  const rounded = (isLong ? Math.floor(price * 100 + 1e-8) : Math.ceil(price * 100 - 1e-8)) / 100;
  return rounded > 0 ? rounded : NaN;
}

export function stopLongVal() { return rawStop('stopLong') || adjustedStop(state.quoteData?.low, true, currentAtr5()); }

export function stopShortVal() { return rawStop('stopShort') || adjustedStop(state.quoteData?.high, false, currentAtr5()); }

export function autoStopName(isLong) {
  const level = isLong ? 'LOD' : 'HOD';
  if (state.stopStrategy === 'none') return level;
  const amount = state.stopStrategy === 'atr' ? `${state.atrMultiplier}× ATR(5m)` : `${Number.isFinite(state.stopPercent) ? state.stopPercent : '?'}%`;
  return `${level} ${isLong ? '−' : '+'} ${amount}`;
}

export function stopSourceName(isLong, full = false) {
  if (rawStop(isLong ? 'stopLong' : 'stopShort')) return 'Custom stop';
  return state.stopStrategy === 'none' && full ? (isLong ? 'Low of day (LOD)' : 'High of day (HOD)') : autoStopName(isLong);
}

export function chartStopVal(isLong) {
  if (state.sizingMode === 'allocation') return 0;
  return rawStop(isLong ? 'stopLong' : 'stopShort') || (state.stopStrategy !== 'none' ? (isLong ? stopLongVal() : stopShortVal()) : 0);
}

export function saveStopAdjustment() {
  store.set('stop_strategy', state.stopStrategy);
  store.set('atr_multiplier', state.atrMultiplier);
  if (Number.isFinite(state.stopPercent)) store.set('stop_percent', state.stopPercent);
}

export function setStopStrategy(value) {
  state.stopStrategy = normalizeStopStrategy(value);
  if (state.stopStrategy === 'atr' && !state.atrMultiplier) state.atrMultiplier = 0.5;
  saveStopAdjustment();
  stopsChanged();
}

export function setAtrMultiplier(value) {
  state.atrMultiplier = normalizeAtrMultiplier(value);
  state.stopStrategy = state.atrMultiplier ? 'atr' : 'none';
  saveStopAdjustment();
  stopsChanged();
}

export function setStopPercent(value, fromInput = false) {
  state.stopPercent = parseStopPercent(value);
  state.stopStrategy = 'percent';
  if (!fromInput) document.getElementById('stopPercent').value = String(value);
  saveStopAdjustment();
  stopsChanged();
}

export function updateStopAdjustment() {
  document.getElementById('stopStrategy').value = state.stopStrategy;
  document.getElementById('atrPresets').style.display = state.stopStrategy === 'atr' ? 'flex' : 'none';
  document.getElementById('percentControls').style.display = state.stopStrategy === 'percent' ? 'flex' : 'none';
  document.getElementById('stopPercent').setAttribute('aria-invalid', String(!Number.isFinite(state.stopPercent)));
  document.querySelectorAll('#atrPresets button').forEach(b => {
    const active = Number(b.dataset.atr) === state.atrMultiplier;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('#percentPresets button').forEach(b => {
    const active = Number(b.dataset.percent) === state.stopPercent;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  const tc = tradeCtx();
  const info = document.getElementById('stopBufferInfo');
  if (state.stopStrategy === 'none') { info.textContent = ''; return; }
  if (state.stopStrategy === 'percent') {
    if (!Number.isFinite(state.stopPercent)) { info.textContent = 'Enter a percentage from 0% to less than 100%.'; return; }
    const preview = isLong => {
      const level = isLong ? state.quoteData?.low : state.quoteData?.high;
      const stop = adjustedStop(level, isLong, null);
      return Number.isFinite(stop) ? `${isLong ? 'LOD' : 'HOD'} ${fmt$(level)} → ${fmt$(stop)}` : '';
    };
    const prices = [tc !== 'short' && preview(true), tc !== 'long' && preview(false)].filter(Boolean).join(' · ');
    info.textContent = `${state.stopPercent}% of the LOD / HOD price${prices ? ` · ${prices}` : ' · load a ticker to see the adjusted stop'} · rounded outward to cents`;
    return;
  }
  const atr = currentAtr5();
  if (!atr) { info.textContent = '5m ATR(14) unavailable · load or refresh intraday data, enter a manual stop, or choose None.'; return; }
  const asOf = new Date((atr.asOf + 300) * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  info.textContent = `5m ATR(14) ${fmt$(atr.value)} × ${state.atrMultiplier} = ${fmt$(atr.value * state.atrMultiplier)} buffer · bar closed ${asOf}`;
}

export function entryVal() { return rawStop('entryPrice') || effectivePrice(state.quoteData); } // blank = current (incl. pre/after-hours) price

// the active trade direction: shares follow the Long/Short toggle,
// options follow chain side (calls = long, puts = short, Both = both)

export function tradeCtx() {
  return state.currentMode === 'shares'
    ? (state.direction === 'long' ? 'long' : 'short')
    : (state.chainSide === 'put' ? 'short' : state.chainSide === 'call' ? 'long' : 'both');
}

// only show the stop that matches the trade you're taking

export function updateStopVisibility() {
  document.getElementById('stopAdjustment').style.display = state.sizingMode === 'allocation' ? 'none' : '';
  document.getElementById('entryStopsTitle').textContent = state.sizingMode === 'allocation' ? 'Entry' : 'Entry & stops';
  document.getElementById('entryStopsRow').style.display = state.sizingMode === 'allocation' && state.currentMode === 'options' ? 'none' : '';
  document.getElementById('entryStopsTitle').style.display = state.sizingMode === 'allocation' && state.currentMode === 'options' ? 'none' : '';
  if (state.sizingMode === 'allocation') {
    for (const id of ['dirField', 'stopLongField', 'stopShortField']) document.getElementById(id).style.display = 'none';
    document.getElementById('stopsHint').textContent = 'Sized by capital allocation';
    document.getElementById('chartClickHint').textContent = 'Allocation sizing does not use stops';
    return;
  }
  const tc = tradeCtx();
  updateStopAdjustment();
  // the Long/Short toggle is the shares-mode direction; chain side plays that role in options
  document.getElementById('dirField').style.display = state.currentMode === 'shares' ? 'flex' : 'none';
  document.getElementById('stopLongField').style.display = tc !== 'short' ? 'flex' : 'none';
  document.getElementById('stopShortField').style.display = tc !== 'long' ? 'flex' : 'none';
  document.getElementById('stopsHint').textContent =
    tc === 'long' ? `Blank uses the ${autoStopName(true)}. Click the chart to set it.`
    : tc === 'short' ? `Blank uses the ${autoStopName(false)}. Click the chart to set it.`
    : `Blank uses the ${state.stopStrategy !== 'none' ? 'buffered LOD / HOD' : 'LOD / HOD'}. On the chart, below price sets the long stop and above sets the short.`;
  document.getElementById('chartClickHint').textContent =
    tc === 'long' ? 'tap, or hold-aim-release, to set your long stop'
    : tc === 'short' ? 'tap, or hold-aim-release, to set your short stop'
    : 'tap or hold-aim-release to set a stop: below price = long, above = short';
}

export function stopsChanged() {
  updateStopVisibility();
  state.flashNext = true;
  if (state.quoteData) { renderShares(); renderChain(); }
  state.flashNext = false;
  if (state.chartBars.length) drawChart();
  else if (state.dailyBars.length) drawDailyChart();
}
