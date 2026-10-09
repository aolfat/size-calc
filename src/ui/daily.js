// Daily history: ADR14, HV20, prior-day levels, IV percentile, and the daily chart pane (range chips, zoom and pan).
import { state } from '../state.js';
import { hv20At, percentileOf } from '../core/bars.js';
import { clampView, viewRange } from '../core/chart-view.js';
import { effectivePrice } from '../core/extended-hours.js';
import { fmtN, nyDateStr } from '../core/format.js';
import { store } from '../lib/store.js';
import { dailyHistory } from '../services/tradier.js';
import { attachCandleGestures, candleGeom, ohlcText, paintCandles } from './candles.js';
import { drawChart, setStopFromPrice } from './chart.js';
import { updateStickyBar } from './sticky-bar.js';
import { chartStopVal, rawStop, tradeCtx } from './stops.js';

export function applyDailyHistory(list) {
  state.dailyBars = list;
  const today = nyDateStr(new Date()); // the bars carry New York dates
  const done = list.filter(x => x.date !== today); // today's range is still forming
  const last14 = done.slice(-14);
  if (last14.length) state.adrValue = last14.reduce((s, x) => s + (x.high - x.low), 0) / last14.length;
  const last = done[done.length - 1];
  state.prevDay = last ? { h: last.high, l: last.low, c: last.close } : null;
  const closes = done.map(x => x.close);
  state.hvDist = [];
  for (let end = 20; end < closes.length; end++) state.hvDist.push(hv20At(closes, end));
  if (closes.length >= 21) state.hv20 = hv20At(closes, closes.length - 1);
}

export function ivRankInfo(symbol, iv) {
  const p = percentileOf(iv, state.hvDist);
  return p === null ? null : { pct: p, basis: '1y realized vol' };
}

export async function fetchAdr(ticker) {
  // a new symbol opens on the chosen range; reloading the same one keeps the zoom
  if (ticker !== state.dailySymbol) { state.dailySymbol = ticker; state.dailyView = { count: state.dailyRange, offset: 0 }; }
  state.adrValue = 0;
  state.prevDay = null;
  state.hv20 = 0;
  state.hvDist = []; // or IV percentile ranks this symbol against the last one's vol
  state.dailyBars = [];
  try {
    const days = await dailyHistory(ticker);
    if (ticker !== state.dailySymbol) return; // a newer symbol was requested meanwhile
    if (days.length) applyDailyHistory(days);
  } catch(e) {}
  renderAdr();
  updateChartVisibility();
  if (state.chartBars.length) drawChart(); // prior-day lines
  if (state.dailyBars.length) drawDailyChart();
}

export function toggleDaily() {
  state.showDaily = !state.showDaily;
  store.set('show_daily', state.showDaily ? '1' : '0');
  updateChartVisibility();
  if (state.showDaily && state.dailyBars.length) drawDailyChart(); // canvas needs a paint after re-display
}

export function setDailyRange(count) {
  state.dailyRange = count;
  store.set('daily_range', String(count));
  state.dailyView = { count, offset: 0 }; // tapping the lit chip again is the reset
  drawDailyChart();
}

export function dailyToday() {
  state.dailyView = { count: state.dailyView.count, offset: 0 };
  drawDailyChart();
}

// the lit range chip: the chosen one while the view still shows that many sessions, none after a zoom
export function activeDailyRange() {
  const n = state.dailyBars.length;
  return Math.round(clampView(state.dailyView, n).count) === Math.min(state.dailyRange, n) ? state.dailyRange : 0;
}

function updateDailyControls() {
  const active = activeDailyRange();
  document.querySelectorAll('#chartColD [data-action="setDailyRange"]').forEach(b => b.classList.toggle('active', +b.dataset.arg === active));
  const n = state.dailyBars.length;
  document.getElementById('dailyToday').style.display = viewRange(state.dailyView, n).end < n ? '' : 'none';
}

export function updateChartVisibility() {
  const has5 = state.chartBars.length > 0, hasD = state.dailyBars.length > 0 && state.showDaily;
  document.getElementById('chartWrap').style.display = !state.positionsView && !state.utilsView && !state.marketView && state.currentMode !== 'futures' && (has5 || hasD) ? 'block' : 'none';
  document.getElementById('chartCol5').style.display = has5 ? 'block' : 'none';
  document.getElementById('chartColD').style.display = hasD ? 'block' : 'none';
  document.getElementById('dailyToggle').classList.toggle('active', state.showDaily);
}

export function adrUsage() {
  if (!(state.adrValue > 0) || !state.quoteData) return null;
  const price = effectivePrice(state.quoteData);
  const lod = state.quoteData.low || 0;
  const hod = state.quoteData.high || 0;
  // % of the ADR already consumed from the reference level; long trades
  // measure off LOD, shorts off HOD — follow the active context
  const used = ref => Math.max(0, (ref === 'lod' ? price - lod : hod - price) / state.adrValue * 100);
  return { adrPct: price > 0 ? (state.adrValue / price * 100) : 0, ctx: tradeCtx(), usedLod: used('lod'), usedHod: used('hod') };
}

export function renderAdr() {
  const el = document.getElementById('adrInfo');
  const u = adrUsage();
  if (!u) { el.textContent = ''; return; }
  const tag = (label, v) => `${label} <span style="color:${v >= 90 ? 'var(--amber)' : 'var(--text)'};font-weight:600;">${v.toFixed(0)}%</span>`;
  const usage = u.ctx === 'long' ? tag('used off LOD', u.usedLod)
    : u.ctx === 'short' ? tag('used off HOD', u.usedHod)
    : `${tag('LOD', u.usedLod)} · ${tag('HOD', u.usedHod)}`;
  el.innerHTML = `ADR14 ${fmtN(state.adrValue, 2)} (${u.adrPct.toFixed(1)}%) · ${usage}`;
  updateStickyBar();
}

// one scale for the candles, the hover and click-to-stop: the visible window, fitted to its bars plus the stop and entry lines
export function dailyGeom(w) {
  const tc = tradeCtx();
  const levels = [tc !== 'short' ? chartStopVal(true) : 0, tc !== 'long' ? chartStopVal(false) : 0, rawStop('entryPrice')];
  return candleGeom(state.dailyBars, state.dailyView, w, levels);
}

export function drawDailyChart() {
  updateDailyControls();
  if (!state.dailyBars.length) return;
  const canvas = document.getElementById('dailyChart');
  const w = canvas.clientWidth;
  if (!w) return;
  const css = getComputedStyle(document.documentElement);
  const color = name => css.getPropertyValue(name).trim();
  // stop lines follow the same context rules as the 5-min chart
  const tc = tradeCtx();
  const line = (price, c, label) => ({ price, color: color(c), label: label + ' ' + Number(price).toFixed(2) });
  const lines = [];
  if (tc !== 'short') lines.push(line(chartStopVal(true), '--red', 'long stop'));
  if (tc !== 'long') lines.push(line(chartStopVal(false), '--green', 'short stop'));
  lines.push(line(rawStop('entryPrice'), '--blue', 'entry'));
  paintCandles(canvas, dailyGeom(w), state.dailyBars, { lines, hover: { index: state.dailyHover, y: state.dailyHoverY } });
  // hover crosshair shares the OHLC readout with the 5-min chart
  const b = state.dailyBars[state.dailyHover];
  const { start, end } = viewRange(state.dailyView, state.dailyBars.length);
  if (b && state.dailyHover >= start && state.dailyHover < end) document.getElementById('chartOhlc').innerHTML = ohlcText(b);
}

export function initDailyChartEvents() {
  const canvas = document.getElementById('dailyChart');
  const geom = () => dailyGeom(canvas.getBoundingClientRect().width);
  attachCandleGestures(canvas, {
    count: () => state.dailyBars.length,
    view: () => state.dailyView,
    setView: view => { state.dailyView = view; drawDailyChart(); },
    geom,
    hover: (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      state.dailyHover = geom().index(clientX - rect.left);
      state.dailyHoverY = clientY - rect.top;
      drawDailyChart();
    },
    leave: () => {
      state.dailyHover = -1;
      state.dailyHoverY = -1;
      drawDailyChart();
      if (state.chartBars.length) drawChart(); // restores the 5-min readout
    },
    pick: (clientX, clientY) => setStopFromPrice(dailyPriceAtY(clientY)),
  });
}

export function dailyPriceAtY(clientY) {
  const rect = document.getElementById('dailyChart').getBoundingClientRect();
  return dailyGeom(rect.width).price(clientY - rect.top);
}
