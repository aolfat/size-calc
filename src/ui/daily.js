import { state } from '../state.js';
import { hv20At, percentileOf } from '../core/bars.js';
import { effectivePrice } from '../core/extended-hours.js';
import { dateStr, fmtN } from '../core/format.js';
import { store } from '../lib/store.js';
import { baseUrl, headers } from '../services/tradier.js';
import { attachTouchCrosshair, drawChart, setStopFromPrice } from './chart.js';
import { updateStickyBar } from './sticky-bar.js';
import { chartStopVal, rawStop, tradeCtx } from './stops.js';

export function applyDailyHistory(list) {
  state.dailyBars = list;
  const today = dateStr(new Date());
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
  state.adrValue = 0;
  state.prevDay = null;
  state.hv20 = 0;
  state.dailyBars = [];
  try {
    const from = new Date();
    from.setDate(from.getDate() - 380); // ~1 year: daily chart uses it all, HV percentile needs the year, ADR/HV20 use the tail
    const url = `${baseUrl()}/markets/history?symbol=${ticker}&interval=daily&start=${dateStr(from)}&end=${dateStr(new Date())}`;
    const res = await fetch(url, { headers: headers() });
    const days = (await res.json())?.history?.day;
    if (ticker !== document.getElementById('ticker').value.trim().toUpperCase()) return;
    if (days) applyDailyHistory(Array.isArray(days) ? days : [days]);
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

export function drawDailyChart() {
  if (!state.dailyBars.length) return;
  const canvas = document.getElementById('dailyChart');
  const w = canvas.clientWidth, h = 260;
  if (!w) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const padL = 6, padR = 52, padT = 12, padB = 22;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  let lo = Infinity, hi = -Infinity;
  for (const b of state.dailyBars) { if (b.low < lo) lo = b.low; if (b.high > hi) hi = b.high; }
  const tc = tradeCtx();
  if (tc !== 'short') { const s = chartStopVal(true); if (s > 0) { lo = Math.min(lo, s); hi = Math.max(hi, s); } }
  if (tc !== 'long') { const s = chartStopVal(false); if (s > 0) { lo = Math.min(lo, s); hi = Math.max(hi, s); } }
  { const s = rawStop('entryPrice'); if (s > 0) { lo = Math.min(lo, s); hi = Math.max(hi, s); } }
  const pad = (hi - lo) * 0.05 || 0.5;
  lo -= pad; hi += pad;
  const y = p => padT + (hi - p) / (hi - lo) * plotH;
  const n = state.dailyBars.length;
  const slot = plotW / n;
  const bw = Math.max(1.5, Math.min(7, slot * 0.65));
  const x = i => padL + i * slot + slot / 2;

  const css = getComputedStyle(document.documentElement);
  const cGreen = css.getPropertyValue('--green').trim();
  const cRed = css.getPropertyValue('--red').trim();
  const cPurple = css.getPropertyValue('--purple').trim();
  const cText3 = css.getPropertyValue('--text3').trim();
  const cBorder = css.getPropertyValue('--border2').trim();

  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.fillStyle = cText3;
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const p = lo + (hi - lo) * i / 4;
    ctx.beginPath(); ctx.moveTo(padL, y(p)); ctx.lineTo(w - padR, y(p)); ctx.stroke();
    ctx.fillText('$' + p.toFixed(2), w - padR + 5, y(p) + 3);
  }
  const tickEvery = Math.max(1, Math.round(n / 5));
  for (let i = 0; i < n; i += tickEvery) {
    const parts = (state.dailyBars[i].date || '').split('-');
    if (parts.length === 3) ctx.fillText(+parts[1] + '/' + +parts[2], x(i) - 10, h - 8);
  }

  // stop lines follow the same context rules as the 5-min chart
  const stopLine = (price, color, label) => {
    if (!(price > 0)) return;
    ctx.save();
    ctx.strokeStyle = color; ctx.setLineDash([6, 3]); ctx.lineWidth = 1.25;
    ctx.beginPath(); ctx.moveTo(padL, y(price)); ctx.lineTo(w - padR, y(price)); ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(label + ' ' + price.toFixed(2), w - padR - 84, y(price) - 4);
    ctx.restore();
  };
  if (tc !== 'short') stopLine(chartStopVal(true), cRed, 'long stop');
  if (tc !== 'long') stopLine(chartStopVal(false), cGreen, 'short stop');
  stopLine(rawStop('entryPrice'), css.getPropertyValue('--blue').trim(), 'entry');

  // candles
  for (let i = 0; i < n; i++) {
    const b = state.dailyBars[i];
    const col = b.close >= b.open ? cGreen : cRed;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(i), y(b.high)); ctx.lineTo(x(i), y(b.low)); ctx.stroke();
    const top = y(Math.max(b.open, b.close)), bot = y(Math.min(b.open, b.close));
    ctx.fillRect(x(i) - bw / 2, top, bw, Math.max(1, bot - top));
  }

  // 8 EMA of daily closes
  const k = 2 / 9;
  let e = state.dailyBars[0].close;
  ctx.save();
  ctx.strokeStyle = cPurple; ctx.lineWidth = 1.25; ctx.globalAlpha = 0.9;
  ctx.beginPath();
  state.dailyBars.forEach((b, i) => {
    e = b.close * k + e * (1 - k);
    i ? ctx.lineTo(x(i), y(e)) : ctx.moveTo(x(i), y(e));
  });
  ctx.stroke(); ctx.restore();

  // hover crosshair shares the OHLC readout with the 5-min chart
  if (state.dailyHover >= 0 && state.dailyHover < n) {
    const b = state.dailyBars[state.dailyHover];
    ctx.save();
    ctx.strokeStyle = cBorder; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x(state.dailyHover), padT); ctx.lineTo(x(state.dailyHover), h - padB); ctx.stroke();
    if (state.dailyHoverY >= padT && state.dailyHoverY <= h - padB) {
      const hp = hi - (state.dailyHoverY - padT) / plotH * (hi - lo);
      ctx.beginPath(); ctx.moveTo(padL, state.dailyHoverY); ctx.lineTo(w - padR, state.dailyHoverY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#232a36';
      ctx.fillRect(w - padR + 2, state.dailyHoverY - 8, padR - 4, 15);
      ctx.fillStyle = '#e9ecf2';
      ctx.fillText('$' + hp.toFixed(2), w - padR + 5, state.dailyHoverY + 3);
    }
    ctx.restore();
    const chg = b.close - b.open;
    document.getElementById('chartOhlc').innerHTML =
      `1D ${b.date} &nbsp; O ${b.open.toFixed(2)} &nbsp; H ${b.high.toFixed(2)} &nbsp; L ${b.low.toFixed(2)} &nbsp; C <span style="color:${chg >= 0 ? cGreen : cRed}">${b.close.toFixed(2)}</span>`;
  }
}

export function initDailyChartEvents() {
  const canvas = document.getElementById('dailyChart');
  const geom = () => {
    const rect = canvas.getBoundingClientRect();
    return { rect, plotW: rect.width - 6 - 52 };
  };
  const toIdx = clientX => {
    const g = geom();
    const i = Math.floor((clientX - g.rect.left - 6) / (g.plotW / state.dailyBars.length));
    return i >= 0 && i < state.dailyBars.length ? i : -1;
  };
  canvas.addEventListener('mousemove', e => {
    if (!state.dailyBars.length) return;
    state.dailyHover = toIdx(e.clientX);
    state.dailyHoverY = e.clientY - canvas.getBoundingClientRect().top;
    drawDailyChart();
  });
  canvas.addEventListener('mouseleave', () => {
    state.dailyHover = -1;
    state.dailyHoverY = -1;
    drawDailyChart();
    if (state.chartBars.length) drawChart(); // restores the 5-min readout
  });
  attachTouchCrosshair(canvas, t => {
    if (!state.dailyBars.length) return;
    state.dailyHover = toIdx(t.clientX);
    state.dailyHoverY = t.clientY - canvas.getBoundingClientRect().top;
    drawDailyChart();
  }, last => {
    if (last && state.dailyBars.length) {
      const rect = canvas.getBoundingClientRect();
      if (last.clientY >= rect.top && last.clientY <= rect.bottom) setStopFromPrice(dailyPriceAtY(last.clientY));
    }
    state.dailyHover = -1; state.dailyHoverY = -1;
    if (state.dailyBars.length) { drawDailyChart(); if (state.chartBars.length) drawChart(); }
  });
  canvas.addEventListener('click', e => {
    if (!state.dailyBars.length) return;
    setStopFromPrice(dailyPriceAtY(e.clientY));
  });
}

export function dailyPriceAtY(clientY) {
  const canvas = document.getElementById('dailyChart');
  const rect = canvas.getBoundingClientRect();
  let dLo = Infinity, dHi = -Infinity;
  for (const b of state.dailyBars) { if (b.low < dLo) dLo = b.low; if (b.high > dHi) dHi = b.high; }
  const tc = tradeCtx();
  if (tc !== 'short') { const s = chartStopVal(true); if (s > 0) { dLo = Math.min(dLo, s); dHi = Math.max(dHi, s); } }
  if (tc !== 'long') { const s = chartStopVal(false); if (s > 0) { dLo = Math.min(dLo, s); dHi = Math.max(dHi, s); } }
  { const s = rawStop('entryPrice'); if (s > 0) { dLo = Math.min(dLo, s); dHi = Math.max(dHi, s); } }
  const pad = (dHi - dLo) * 0.05 || 0.5;
  dLo -= pad; dHi += pad;
  return dHi - (clientY - rect.top - 12) / (260 - 12 - 22) * (dHi - dLo);
}
