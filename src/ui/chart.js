// Intraday chart: 5-minute timesales, aggregated intervals, canvas candles, VWAP and EMA, stop lines, touch crosshair.
import { state } from '../state.js';
import { aggregateBars } from '../core/bars.js';
import { effectivePrice } from '../core/extended-hours.js';
import { dateStr } from '../core/format.js';
import { calculateAtr5 } from '../core/stops.js';
import { DESKTOP_MQ, MONO_FONT } from '../lib/media.js';
import { store } from '../lib/store.js';
import { baseUrl, headers } from '../services/tradier.js';
import { renderChain } from './chain.js';
import { drawDailyChart, updateChartVisibility } from './daily.js';
import { chartStopVal, rawStop, stopsChanged, tradeCtx } from './stops.js';

export const CHART_SESSIONS = { 5: 1, 15: 2, 30: 3, 65: 5 };

export function setChartInterval(iv) {
  state.chartInterval = iv;
  store.set('chart_interval', String(iv));
  updateIntervalChips();
  const ticker = document.getElementById('ticker').value.trim().toUpperCase();
  if (ticker && state.quoteData) fetchChart(ticker);
}

export function updateIntervalChips() {
  document.querySelectorAll('#ivChips .filter-btn').forEach(b =>
    b.classList.toggle('active', +b.dataset.iv === state.chartInterval));
}

export async function fetchFiveMinuteBars(ticker) {
  const from = new Date();
  // Fixed history keeps the ATR seed independent of the visible chart interval.
  from.setDate(from.getDate() - 14);
  const url = `${baseUrl()}/markets/timesales?symbol=${encodeURIComponent(ticker)}&interval=5min&start=${encodeURIComponent(dateStr(from) + ' 09:30')}&end=${encodeURIComponent(dateStr(new Date()) + ' 16:00')}&session_filter=open`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error('Intraday data unavailable');
  const data = (await res.json())?.series?.data;
  return data ? (Array.isArray(data) ? data : [data]).map(b => ({ t: b.time, ts: b.timestamp, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })) : [];
}

export async function fetchChart(ticker) {
  const requestId = ++state.chartRequestId;
  let raw = [];
  try { raw = await fetchFiveMinuteBars(ticker); } catch(e) {}
  if (requestId !== state.chartRequestId || ticker !== document.getElementById('ticker').value.trim().toUpperCase()) return;
  const sessions = CHART_SESSIONS[state.chartInterval] || 1;
  const days = [...new Set(raw.map(b => (b.t || '').slice(0, 10)))].sort();
  const keep = new Set(days.slice(-sessions));
  state.chartBars = aggregateBars(raw.filter(b => keep.has((b.t || '').slice(0, 10))), state.chartInterval);
  const result = calculateAtr5(raw);
  state.atr5 = result ? { symbol: ticker, ...result } : null;
  updateChartVisibility();
  stopsChanged();
}

export function chartGeom(canvas) {
  const padL = 8, padR = 62, padT = 12, padB = 24;
  const w = canvas.clientWidth, h = 260;
  return { padL, padR, padT, padB, w, h, plotW: w - padL - padR, plotH: h - padT - padB };
}

export function chartRange() {
  let lo = Infinity, hi = -Infinity;
  for (const b of state.chartBars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  // Include manual and buffered stop lines in range (only the active direction).
  const tc = tradeCtx();
  const inRange = [rawStop('entryPrice')];
  if (tc !== 'short') inRange.push(chartStopVal(true));
  if (tc !== 'long') inRange.push(chartStopVal(false));
  for (const s of inRange) {
    if (s > 0) { if (s < lo) lo = s; if (s > hi) hi = s; }
  }
  const pad = (hi - lo) * 0.06 || 0.5;
  return { lo: lo - pad, hi: hi + pad };
}

export function drawChart() {
  if (!state.chartBars.length) return;
  const canvas = document.getElementById('chart');
  if (!canvas.clientWidth) return; // hidden: painting now would wipe the canvas to zero width
  const g = chartGeom(canvas);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = g.w * dpr;
  canvas.height = g.h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, g.w, g.h);

  const { lo, hi } = chartRange();
  const y = p => g.padT + (hi - p) / (hi - lo) * g.plotH;
  const n = state.chartBars.length;
  const slot = g.plotW / n;
  const bw = Math.max(2, Math.min(9, slot * 0.65));
  const x = i => g.padL + i * slot + slot / 2;

  const css = getComputedStyle(document.documentElement);
  const cGreen = css.getPropertyValue('--green').trim();
  const cRed = css.getPropertyValue('--red').trim();
  const cAmber = css.getPropertyValue('--amber').trim();
  const cBlue = css.getPropertyValue('--blue').trim();
  const cPurple = css.getPropertyValue('--purple').trim();
  const cText3 = css.getPropertyValue('--text3').trim();
  const cBorder = css.getPropertyValue('--border2').trim();

  // horizontal gridlines + price axis
  ctx.font = `10px ${MONO_FONT}`;
  ctx.fillStyle = cText3;
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.lineWidth = 1;
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const p = lo + (hi - lo) * i / steps;
    const yy = y(p);
    ctx.beginPath(); ctx.moveTo(g.padL, yy); ctx.lineTo(g.w - g.padR, yy); ctx.stroke();
    ctx.fillText('$' + p.toFixed(2), g.w - g.padR + 6, yy + 3);
  }

  // time labels (~6 across) + faint separators where a new session starts
  ctx.fillStyle = cText3;
  const labelStep = Math.max(1, Math.floor(n / 6));
  for (let i = 0; i < n; i += labelStep) {
    const tm = (state.chartBars[i].t || '').slice(11, 16);
    if (tm) ctx.fillText(tm, x(i) - 12, g.h - 8);
  }
  for (let i = 1; i < n; i++) {
    if ((state.chartBars[i].t || '').slice(0, 10) !== (state.chartBars[i - 1].t || '').slice(0, 10)) {
      ctx.save();
      ctx.strokeStyle = cBorder; ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.moveTo(x(i) - slot / 2, g.padT); ctx.lineTo(x(i) - slot / 2, g.h - g.padB); ctx.stroke();
      ctx.restore();
    }
  }

  // LOD / HOD dashed lines from the LAST session's bars (today's levels)
  const lastDay = (state.chartBars[n - 1].t || '').slice(0, 10);
  let lod = Infinity, hod = -Infinity;
  for (const b of state.chartBars) {
    if ((b.t || '').slice(0, 10) !== lastDay) continue;
    if (b.l < lod) lod = b.l;
    if (b.h > hod) hod = b.h;
  }
  const dash = (price, color) => {
    ctx.save();
    ctx.strokeStyle = color; ctx.globalAlpha = 0.55; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(g.padL, y(price)); ctx.lineTo(g.w - g.padR, y(price)); ctx.stroke();
    ctx.restore();
  };
  dash(hod, cGreen);
  dash(lod, cRed);

  // prior-day levels, drawn only when they fall inside the visible range
  if (state.prevDay) {
    const pdLine = (price, label) => {
      if (!(price > 0) || price < lo || price > hi) return;
      ctx.save();
      ctx.strokeStyle = cText3; ctx.globalAlpha = 0.6; ctx.setLineDash([2, 5]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(g.padL, y(price)); ctx.lineTo(g.w - g.padR, y(price)); ctx.stroke();
      ctx.fillStyle = cText3;
      ctx.fillText(label, g.padL + 3, y(price) - 3);
      ctx.restore();
    };
    pdLine(state.prevDay.h, 'PDH');
    pdLine(state.prevDay.l, 'PDL');
    pdLine(state.prevDay.c, 'PDC');
  }

  // Stop overlays include manual stops and buffered stops; unbuffered LOD/HOD have their own lines.
  const stopLine = (price, color, label) => {
    if (!(price > 0)) return;
    ctx.save();
    ctx.strokeStyle = color; ctx.setLineDash([6, 3]); ctx.lineWidth = 1.25;
    ctx.beginPath(); ctx.moveTo(g.padL, y(price)); ctx.lineTo(g.w - g.padR, y(price)); ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(label + ' ' + price.toFixed(2), g.w - g.padR - 90, y(price) - 4);
    ctx.restore();
  };
  const tc = tradeCtx();
  if (tc !== 'short') stopLine(chartStopVal(true), cRed, 'long stop');
  if (tc !== 'long') stopLine(chartStopVal(false), cGreen, 'short stop');
  stopLine(rawStop('entryPrice'), cBlue, 'entry');

  // candles
  for (let i = 0; i < n; i++) {
    const b = state.chartBars[i];
    const up = b.c >= b.o;
    const col = up ? cGreen : cRed;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    // wick
    ctx.beginPath(); ctx.moveTo(x(i), y(b.h)); ctx.lineTo(x(i), y(b.l)); ctx.stroke();
    // body
    const top = y(Math.max(b.o, b.c)), bot = y(Math.min(b.o, b.c));
    ctx.fillRect(x(i) - bw / 2, top, bw, Math.max(1, bot - top));
  }

  // VWAP (blue, resets each session) + 8 EMA (purple) overlays
  let pvSum = 0, vSum = 0, vwDay = null;
  const vwap = state.chartBars.map(b => {
    const bd = (b.t || '').slice(0, 10);
    if (bd !== vwDay) { vwDay = bd; pvSum = 0; vSum = 0; }
    const tp = (b.h + b.l + b.c) / 3;
    pvSum += tp * (b.v || 0); vSum += (b.v || 0);
    return vSum > 0 ? pvSum / vSum : tp;
  });
  const k = 2 / 9;
  let e = state.chartBars[0].c;
  const ema8 = state.chartBars.map(b => (e = b.c * k + e * (1 - k)));
  const overlay = (arr, color) => {
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 1.25; ctx.globalAlpha = 0.85;
    ctx.beginPath();
    arr.forEach((p, i) => { i ? ctx.lineTo(x(i), y(p)) : ctx.moveTo(x(i), y(p)); });
    ctx.stroke();
    ctx.restore();
  };
  overlay(vwap, cBlue);
  overlay(ema8, cPurple);

  // hover crosshair: vertical on the bar, horizontal at the cursor with a price tag
  if (state.chartHoverY >= g.padT && state.chartHoverY <= g.h - g.padB) {
    const price = hi - (state.chartHoverY - g.padT) / g.plotH * (hi - lo);
    ctx.save();
    ctx.strokeStyle = cBorder; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(g.padL, state.chartHoverY); ctx.lineTo(g.w - g.padR, state.chartHoverY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = css.getPropertyValue('--bg4').trim();
    ctx.fillRect(g.w - g.padR + 2, state.chartHoverY - 8, g.padR - 4, 15);
    ctx.fillStyle = css.getPropertyValue('--text').trim();
    ctx.fillText('$' + price.toFixed(2), g.w - g.padR + 6, state.chartHoverY + 3);
    ctx.restore();
  }
  if (state.chartHover >= 0 && state.chartHover < n) {
    const b = state.chartBars[state.chartHover];
    ctx.save();
    ctx.strokeStyle = cBorder; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x(state.chartHover), g.padT); ctx.lineTo(x(state.chartHover), g.h - g.padB); ctx.stroke();
    ctx.restore();
    const tm = (b.t || '').slice(11, 16);
    const chg = b.c - b.o;
    document.getElementById('chartOhlc').innerHTML =
      `${tm} &nbsp; O ${b.o.toFixed(2)} &nbsp; H ${b.h.toFixed(2)} &nbsp; L ${b.l.toFixed(2)} &nbsp; C <span style="color:${chg >= 0 ? cGreen : cRed}">${b.c.toFixed(2)}</span> &nbsp; V ${Number(b.v || 0).toLocaleString()}`;
  } else {
    const sess = (state.chartBars[0].t || '').slice(0, 10);
    document.getElementById('chartOhlc').textContent = sess + ' · ' + n + ' bars';
  }
  if (state.dailyBars.length) drawDailyChart(); // keep the two panes in sync
}

export function chartPriceAtY(clientY) {
  const canvas = document.getElementById('chart');
  const rect = canvas.getBoundingClientRect();
  const g = chartGeom(canvas);
  const { lo, hi } = chartRange();
  const yy = clientY - rect.top;
  return hi - (yy - g.padT) / g.plotH * (hi - lo);
}

// clicks on either chart set the active context's stop; in Both view, below price = long, above = short

export function setStopFromPrice(price) {
  if (state.sizingMode === 'allocation') return;
  if (!(price > 0)) return;
  const tc = tradeCtx();
  const spot = effectivePrice(state.quoteData);
  const id = tc === 'long' ? 'stopLong'
    : tc === 'short' ? 'stopShort'
    : (spot > 0 && price >= spot) ? 'stopShort' : 'stopLong';
  document.getElementById(id).value = price.toFixed(2);
  stopsChanged();
}

// gestures (optional): { start(), pan(dx), pinch(scale, mid0X, dMidX) } — a quick horizontal swipe pans
// and two fingers pinch, both measured from where the gesture began; vertical swipes still scroll the page
export function attachTouchCrosshair(canvas, onMove, onEnd, gestures = null) {
  let armed = false, suppressClick = false, timer = null, sx = 0, sy = 0, last = null;
  let moved = false, mode = null, d0 = 0, m0 = 0;
  canvas.style.touchAction = 'pan-y';
  const pair = ts => ({ d: Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY), m: (ts[0].clientX + ts[1].clientX) / 2 });
  canvas.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) {
      clearTimeout(timer); // a second finger is never a long-press
      if (armed) { armed = false; onEnd(null); } // drop the crosshair without setting a stop
      if (gestures && e.touches.length === 2) {
        ({ d: d0, m: m0 } = pair(e.touches));
        mode = 'pinch';
        gestures.start();
      }
      return;
    }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    armed = false; moved = false; mode = null;
    clearTimeout(timer);
    timer = setTimeout(() => { armed = true; last = { clientX: sx, clientY: sy }; onMove(last); }, 220);
  }, { passive: true });
  canvas.addEventListener('touchmove', e => {
    if (mode === 'pinch') {
      e.preventDefault();
      if (e.touches.length === 2) { const p = pair(e.touches); gestures.pinch(p.d / d0, m0, p.m - m0); }
      return;
    }
    const t = e.touches[0];
    if (mode === 'pan') { e.preventDefault(); gestures.pan(t.clientX - sx); return; }
    if (!armed) {
      // moved before the hold completed → the user is scrolling (or, sideways with gestures, panning), not aiming
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (!moved && (Math.abs(dy) > 8 || Math.abs(dx) > 8)) {
        moved = true;
        clearTimeout(timer);
        if (gestures && Math.abs(dx) > Math.abs(dy)) {
          mode = 'pan';
          e.preventDefault();
          gestures.start();
          gestures.pan(dx);
        }
      }
      return;
    }
    e.preventDefault(); // crosshair engaged: the chart owns the gesture, the page holds still
    last = { clientX: t.clientX, clientY: t.clientY };
    onMove(last);
  }, { passive: false });
  const end = e => {
    clearTimeout(timer);
    if (mode) {
      if (!e.touches.length) mode = null; // a pinch holds until every finger lifts
      return;
    }
    if (armed) {
      armed = false;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 350);
      onEnd(last);
    }
  };
  canvas.addEventListener('touchend', end);
  canvas.addEventListener('touchcancel', end);
  // the release IS the action (onEnd sets the stop) — the trailing click must not fire too
  canvas.addEventListener('click', e => {
    if (suppressClick) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
}

export function initChartEvents() {
  const canvas = document.getElementById('chart');
  canvas.addEventListener('mousemove', e => {
    if (!state.chartBars.length) return;
    const rect = canvas.getBoundingClientRect();
    const g = chartGeom(canvas);
    const xx = e.clientX - rect.left;
    const slot = g.plotW / state.chartBars.length;
    state.chartHover = Math.floor((xx - g.padL) / slot);
    if (state.chartHover < 0 || state.chartHover >= state.chartBars.length) state.chartHover = -1;
    state.chartHoverY = e.clientY - rect.top;
    drawChart();
  });
  canvas.addEventListener('mouseleave', () => { state.chartHover = -1; state.chartHoverY = -1; drawChart(); });
  // touch: long-press engages the crosshair (page holds still); quick swipes scroll; tap sets a stop
  attachTouchCrosshair(canvas, t => {
    if (!state.chartBars.length) return;
    const rect = canvas.getBoundingClientRect();
    const g = chartGeom(canvas);
    const slot = g.plotW / state.chartBars.length;
    state.chartHover = Math.floor((t.clientX - rect.left - g.padL) / slot);
    if (state.chartHover < 0 || state.chartHover >= state.chartBars.length) state.chartHover = -1;
    state.chartHoverY = t.clientY - rect.top;
    drawChart();
  }, last => {
    if (last && state.chartBars.length) {
      const rect = canvas.getBoundingClientRect();
      if (last.clientY >= rect.top && last.clientY <= rect.bottom) setStopFromPrice(chartPriceAtY(last.clientY));
    }
    state.chartHover = -1; state.chartHoverY = -1;
    if (state.chartBars.length) drawChart();
  });
  canvas.addEventListener('click', e => {
    if (!state.chartBars.length) return;
    setStopFromPrice(chartPriceAtY(e.clientY));
  });
  window.addEventListener('resize', () => {
    if (state.chartBars.length) drawChart();
    else if (state.dailyBars.length) drawDailyChart();
  });
  // re-render chain colspans when crossing the mobile breakpoint (rotation etc.)
  window.matchMedia('(max-width: 500px)').addEventListener('change', () => {
    if (state.quoteData && state.chainData.length) renderChain();
  });
  // crossing a desktop tier changes columns, number formats and where chain details render
  for (const query of [DESKTOP_MQ, '(min-width: 1440px)', '(min-width: 1800px)']) {
    window.matchMedia(query).addEventListener('change', () => {
      if (state.quoteData && state.chainData.length) renderChain();
      if (state.chartBars.length) drawChart(); else if (state.dailyBars.length) drawDailyChart();
    });
  }
}
