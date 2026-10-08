// Daily history: ADR14, HV20, prior-day levels, IV percentile, and the daily chart pane (range chips, zoom and pan).
import { state } from '../state.js';
import { hv20At, percentileOf } from '../core/bars.js';
import { clampView, panView, viewRange, zoomView } from '../core/chart-view.js';
import { effectivePrice } from '../core/extended-hours.js';
import { dateStr, fmtN } from '../core/format.js';
import { SANS_FONT } from '../lib/media.js';
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
  // a new symbol opens on the chosen range; reloading the same one keeps the zoom
  if (ticker !== state.dailySymbol) { state.dailySymbol = ticker; state.dailyView = { count: state.dailyRange, offset: 0 }; }
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
  const { start, end } = viewRange(state.dailyView, state.dailyBars.length);
  let lo = Infinity, hi = -Infinity;
  for (let i = start; i < end; i++) { const b = state.dailyBars[i]; if (b.low < lo) lo = b.low; if (b.high > hi) hi = b.high; }
  const tc = tradeCtx();
  if (tc !== 'short') { const s = chartStopVal(true); if (s > 0) { lo = Math.min(lo, s); hi = Math.max(hi, s); } }
  if (tc !== 'long') { const s = chartStopVal(false); if (s > 0) { lo = Math.min(lo, s); hi = Math.max(hi, s); } }
  { const s = rawStop('entryPrice'); if (s > 0) { lo = Math.min(lo, s); hi = Math.max(hi, s); } }
  const pad = (hi - lo) * 0.05 || 0.5;
  lo -= pad; hi += pad;
  const h = 260, padL = 6, padR = 52, padT = 12, padB = 22;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const slot = plotW / Math.max(1, end - start);
  return {
    w, h, padL, padR, padT, padB, plotW, plotH, start, end, slot, lo, hi,
    x: i => padL + (i - start) * slot + slot / 2,
    y: p => padT + (hi - p) / (hi - lo) * plotH,
    price: yy => hi - (yy - padT) / plotH * (hi - lo),
    index: xx => { const i = start + Math.floor((xx - padL) / slot); return i >= start && i < end ? i : -1; },
  };
}

export function drawDailyChart() {
  updateDailyControls();
  if (!state.dailyBars.length) return;
  const canvas = document.getElementById('dailyChart');
  const w = canvas.clientWidth;
  if (!w) return;
  const { h, padL, padR, padT, padB, plotW, plotH, start, end, slot, lo, hi, x, y } = dailyGeom(w);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const tc = tradeCtx();
  const bw = Math.max(1.5, Math.min(14, slot * 0.65));

  const css = getComputedStyle(document.documentElement);
  const cGreen = css.getPropertyValue('--green').trim();
  const cRed = css.getPropertyValue('--red').trim();
  const cPurple = css.getPropertyValue('--purple').trim();
  const cText3 = css.getPropertyValue('--text3').trim();
  const cBorder = css.getPropertyValue('--border2').trim();

  ctx.font = `10px ${SANS_FONT}`;
  ctx.fillStyle = cText3;
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const p = lo + (hi - lo) * i / 4;
    ctx.beginPath(); ctx.moveTo(padL, y(p)); ctx.lineTo(w - padR, y(p)); ctx.stroke();
    ctx.fillText('$' + p.toFixed(2), w - padR + 5, y(p) + 3);
  }
  // date ticks sit on fixed bars so they ride along with a pan instead of reshuffling
  const tickEvery = Math.max(1, Math.round((end - start) / 5));
  for (let i = Math.ceil(start / tickEvery) * tickEvery; i < end; i += tickEvery) {
    const parts = (state.dailyBars[i].date || '').split('-');
    if (parts.length === 3 && x(i) - 10 >= 0 && x(i) + 14 <= w - padR) ctx.fillText(+parts[1] + '/' + +parts[2], x(i) - 10, h - 8);
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
  for (let i = start; i < end; i++) {
    const b = state.dailyBars[i];
    const col = b.close >= b.open ? cGreen : cRed;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(i), y(b.high)); ctx.lineTo(x(i), y(b.low)); ctx.stroke();
    const top = y(Math.max(b.open, b.close)), bot = y(Math.min(b.open, b.close));
    ctx.fillRect(x(i) - bw / 2, top, bw, Math.max(1, bot - top));
  }

  // 8 EMA of daily closes, warmed up on the full history and clipped to the plot (it can lag outside the window's range)
  const k = 2 / 9;
  let e = state.dailyBars[0].close;
  ctx.save();
  ctx.beginPath(); ctx.rect(padL, padT, plotW, plotH); ctx.clip();
  ctx.strokeStyle = cPurple; ctx.lineWidth = 1.25; ctx.globalAlpha = 0.9;
  ctx.beginPath();
  for (let i = 0; i < end; i++) {
    e = state.dailyBars[i].close * k + e * (1 - k);
    if (i > start) ctx.lineTo(x(i), y(e)); else if (i === start) ctx.moveTo(x(i), y(e));
  }
  ctx.stroke(); ctx.restore();

  // hover crosshair shares the OHLC readout with the 5-min chart
  if (state.dailyHover >= start && state.dailyHover < end) {
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
  const n = () => state.dailyBars.length;
  const geom = () => dailyGeom(canvas.getBoundingClientRect().width);
  const localX = clientX => clientX - canvas.getBoundingClientRect().left;
  // where a zoom pivots: 0 = the plot's left edge, 1 = its right (today's side)
  const anchorAt = clientX => { const g = geom(), a = (localX(clientX) - g.padL) / g.plotW; return Number.isFinite(a) ? a : 1; };
  const show = view => { if (!n()) return; state.dailyView = view; drawDailyChart(); };
  const hoverAt = (clientX, clientY) => {
    state.dailyHover = geom().index(localX(clientX));
    state.dailyHoverY = clientY - canvas.getBoundingClientRect().top;
    drawDailyChart();
  };
  canvas.addEventListener('mousemove', e => { if (n()) hoverAt(e.clientX, e.clientY); });
  canvas.addEventListener('mouseleave', () => {
    state.dailyHover = -1;
    state.dailyHoverY = -1;
    drawDailyChart();
    if (state.chartBars.length) drawChart(); // restores the 5-min readout
  });

  // zoom: a trackpad pinch (Chrome and Firefox send it as ctrl+wheel) or ctrl/cmd+scroll; sideways swipes and
  // shift+scroll pan. A plain vertical scroll is left alone so the page or pane still scrolls past the chart
  canvas.addEventListener('wheel', e => {
    if (!n()) return;
    const px = e.deltaMode === 1 ? 16 : 1; // Firefox can report lines
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const dy = Math.max(-50, Math.min(50, e.deltaY * px));
      show(zoomView(state.dailyView, n(), Math.exp(-dy * 0.01), anchorAt(e.clientX)));
      return;
    }
    if (!e.shiftKey && Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * px;
    e.preventDefault();
    show(panView(state.dailyView, n(), -dx / geom().slot));
  }, { passive: false });

  // mouse drag pans; a drag is not a click, so letting go never sets a stop
  let drag = null, dragged = false;
  const endDrag = () => { dragged = drag.moved; drag = null; canvas.style.cursor = ''; };
  canvas.addEventListener('mousedown', e => {
    dragged = false;
    if (e.button === 0 && n()) drag = { x: e.clientX, from: state.dailyView, moved: false };
  });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    if (e.buttons === 0) { endDrag(); return; } // released outside the window
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 4) return;
    drag.moved = true;
    canvas.style.cursor = 'grabbing';
    show(panView(drag.from, n(), dx / geom().slot));
  });
  window.addEventListener('mouseup', () => { if (drag) endDrag(); });

  // touch: long-press crosshair as on the 5-min, plus sideways swipe to pan and two-finger pinch to zoom
  let from = state.dailyView, touching = false;
  attachTouchCrosshair(canvas, t => {
    if (n()) hoverAt(t.clientX, t.clientY);
  }, last => {
    if (last && n()) {
      const rect = canvas.getBoundingClientRect();
      if (last.clientY >= rect.top && last.clientY <= rect.bottom) setStopFromPrice(dailyPriceAtY(last.clientY));
    }
    state.dailyHover = -1; state.dailyHoverY = -1;
    if (n()) { drawDailyChart(); if (state.chartBars.length) drawChart(); }
  }, {
    start: () => { from = state.dailyView; },
    pan: dx => show(panView(from, n(), dx / geom().slot)),
    pinch: (scale, mid0, dMid) => {
      const z = zoomView(from, n(), scale, anchorAt(mid0));
      const { start, end } = viewRange(z, n());
      show(panView(z, n(), dMid / (geom().plotW / Math.max(1, end - start))));
    },
  });
  // Safari sends a trackpad pinch as gesture events instead of ctrl+wheel. On iOS the touch pinch above is
  // already zooming, so there they only stop the page from zooming too
  const fingers = e => { touching = e.touches.length > 0; };
  canvas.addEventListener('touchstart', fingers, { passive: true });
  canvas.addEventListener('touchend', fingers);
  canvas.addEventListener('touchcancel', fingers);
  canvas.addEventListener('gesturestart', e => { e.preventDefault(); if (!touching) from = state.dailyView; });
  canvas.addEventListener('gesturechange', e => {
    e.preventDefault();
    if (!touching) show(zoomView(from, n(), e.scale, anchorAt(e.clientX)));
  });

  canvas.addEventListener('click', e => {
    if (dragged) { dragged = false; return; }
    if (!n()) return;
    setStopFromPrice(dailyPriceAtY(e.clientY));
  });
}

export function dailyPriceAtY(clientY) {
  const rect = document.getElementById('dailyChart').getBoundingClientRect();
  return dailyGeom(rect.width).price(clientY - rect.top);
}
