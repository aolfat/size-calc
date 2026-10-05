// Returns simulator modal: Black-Scholes return % from now to expiry at a chosen underlying price.
import { state } from '../state.js';
import { RISK_FREE, bsPrice } from '../core/black-scholes.js';
import { effectivePrice } from '../core/extended-hours.js';
import { fmt$ } from '../core/format.js';
import { spreadWidth, strikesLabel, typeLabel } from '../core/options.js';
import { simReturnBase } from '../core/sizing.js';
import { quantityForCard } from './allocation.js';
import { attachTouchCrosshair } from './chart.js';
import { showError } from './feedback.js';
import { effects } from './effects.js';

export function openSim(o) {
  if (!o) return;
  if (!(o.iv > 0)) { showError('No IV on this contract — cannot simulate.'); return; }
  if (!(o.entry > 0)) { showError('No entry price to measure returns from.'); return; }
  if (o.sizing === 'allocation' && o.qty < 1) { showError('No contracts fit this allocation.'); return; }
  document.querySelectorAll('#simOverlay button').forEach(b => { if (['stop', '1R', '2R'].includes(b.textContent.trim())) b.style.display = o.sizing === 'allocation' ? 'none' : ''; });
  state.simState = o;
  state.simHover = -1;
  document.getElementById('simTitle').textContent = o.label;
  document.getElementById('simMeta').textContent = `${o.credit ? 'credit' : 'entry'} ${fmt$(o.entry)}/${o.sizing === 'allocation' ? 'share' : 'ct'} · ${o.qty} ct · IV ${(o.iv * 100).toFixed(1)}% held constant${o.shortPut ? ' · return on assignment notional' : ''}`;
  const sl = document.getElementById('simPrice');
  const span = Math.max(o.spot * 0.12, (state.adrValue || 0) * 2.5);
  sl.min = Math.max(0.01, o.spot - span).toFixed(2);
  sl.max = (o.spot + span).toFixed(2);
  sl.step = '0.01'; // penny steps so the stop/1R/2R chips land exactly
  sl.value = o.spot;
  document.getElementById('simOverlay').style.display = 'block';
  drawSim();
}

export function closeSim() {
  document.getElementById('simOverlay').style.display = 'none';
  state.simState = null;
}

export function simSetPrice(mult) { // chips: stop / current / 1R / 2R
  const o = state.simState;
  if (!o) return;
  // freshest price we have: the live quote when it matches this ticker, else the open-time snapshot
  const cur = (state.quoteData && state.quoteData.symbol === o.parsedTicker && effectivePrice(state.quoteData)) || o.spot;
  const bull = o.credit ? !o.isCall : o.isCall;
  const rDist = bull ? o.spot - o.stop : o.stop - o.spot;
  const target = mult === 'stop' ? o.stop
    : mult === 'current' ? cur
    : o.spot + (bull ? 1 : -1) * rDist * mult;
  const sl = document.getElementById('simPrice');
  if (target > +sl.max) sl.max = target.toFixed(2);
  if (target < +sl.min) sl.min = Math.max(0.01, target).toFixed(2);
  sl.value = target.toFixed(2);
  drawSim();
}

export function simPriceTyped(el) {
  const v = parseFloat(el.value);
  if (!state.simState || isNaN(v) || v <= 0) { drawSim(); return; }
  const sl = document.getElementById('simPrice');
  // typed prices outside the slider's range widen the range
  if (v < +sl.min) sl.min = Math.max(0.01, v).toFixed(2);
  if (v > +sl.max) sl.max = v.toFixed(2);
  sl.value = v;
  drawSim();
}

export function simCurve(S) {
  const exp = new Date(state.simState.expStr + 'T16:00:00');
  const now = Date.now();
  const total = Math.max(exp - now, 3600 * 1000);
  const N = 80;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = now + total * i / N;
    const T = (exp - t) / (365 * 24 * 3600 * 1000);
    pts.push({ t, v: state.simState.legs
      ? state.simState.legs.reduce((a, L) => a + L.side * bsPrice(state.simState.isCall, S, L.K, Math.max(0, T), L.iv || state.simState.iv, RISK_FREE), 0)
      : bsPrice(state.simState.isCall, S, state.simState.K, T, state.simState.iv, RISK_FREE) });
  }
  return pts;
}

export function drawSim() {
  const o = state.simState;
  if (!o) return;
  const S = parseFloat(document.getElementById('simPrice').value);
  const priceInput = document.getElementById('simPriceInput');
  if (document.activeElement !== priceInput) priceInput.value = S.toFixed(2); // don't clobber mid-typing
  const pts = simCurve(S);
  // credit spreads: pts.v is the cost to close; P&L = credit − close, % measured against the max loss (width − credit)
  const retBase = simReturnBase(o);
  const ret = pts.map(p => (o.credit ? o.entry - p.v : p.v - o.entry) / retBase * 100);

  const canvas = document.getElementById('simChart');
  const w = canvas.clientWidth, h = 240;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const padL = 8, padR = 58, padT = 14, padB = 24;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  let lo = Math.min(-100, ...ret), hi = Math.max(10, ...ret);
  const pad = (hi - lo) * 0.07;
  lo -= pad; hi += pad;
  const y = v => padT + (hi - v) / (hi - lo) * plotH;
  const x = i => padL + i / (pts.length - 1) * plotW;

  const css = getComputedStyle(document.documentElement);
  const cGreen = css.getPropertyValue('--green').trim();
  const cRed = css.getPropertyValue('--red').trim();
  const cText3 = css.getPropertyValue('--text3').trim();
  const cBorder = css.getPropertyValue('--border2').trim();

  ctx.font = '10px ui-monospace, Menlo, monospace';
  // gridlines at sensible % steps
  const step = (hi - lo) > 400 ? 100 : (hi - lo) > 150 ? 50 : 25;
  ctx.lineWidth = 1;
  for (let g = Math.ceil(lo / step) * step; g <= hi; g += step) {
    ctx.strokeStyle = g === 0 ? cBorder : 'rgba(255,255,255,0.05)';
    ctx.beginPath(); ctx.moveTo(padL, y(g)); ctx.lineTo(w - padR, y(g)); ctx.stroke();
    ctx.fillStyle = cText3;
    ctx.fillText((g > 0 ? '+' : '') + g + '%', w - padR + 6, y(g) + 3);
  }
  // max loss floor
  ctx.save();
  ctx.strokeStyle = cRed; ctx.setLineDash([4, 4]); ctx.globalAlpha = 0.6;
  ctx.beginPath(); ctx.moveTo(padL, y(-100)); ctx.lineTo(w - padR, y(-100)); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = cRed; ctx.fillText('max loss', w - padR - 52, y(-100) - 4);

  // date ticks
  ctx.fillStyle = cText3;
  for (let k = 0; k <= 4; k++) {
    const i = Math.round(k / 4 * (pts.length - 1));
    const d = new Date(pts[i].t);
    const lab = k === 4 ? 'EXP' : (d.getMonth() + 1) + '/' + d.getDate();
    ctx.fillText(lab, Math.min(x(i) - 8, w - padR - 24), h - 8);
  }

  // the curve, green above 0 and red below via clipping
  const path = () => {
    ctx.beginPath();
    ret.forEach((v, i) => { i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)); });
  };
  ctx.lineWidth = 2;
  ctx.save(); ctx.beginPath(); ctx.rect(padL, padT - 8, plotW, y(0) - padT + 8); ctx.clip();
  path(); ctx.strokeStyle = cGreen; ctx.stroke(); ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.rect(padL, y(0), plotW, h - padB - y(0)); ctx.clip();
  path(); ctx.strokeStyle = cRed; ctx.stroke(); ctx.restore();

  // start dot
  ctx.fillStyle = ret[0] >= 0 ? cGreen : cRed;
  ctx.beginPath(); ctx.arc(x(0), y(ret[0]), 3, 0, Math.PI * 2); ctx.fill();

  // hover crosshair; no hover = today's estimate, not expiry
  const idx = state.simHover >= 0 && state.simHover < pts.length ? state.simHover : 0;
  if (state.simHover >= 0) {
    ctx.save();
    ctx.strokeStyle = cBorder; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x(idx), padT); ctx.lineTo(x(idx), h - padB); ctx.stroke();
    if (state.simHoverY >= padT && state.simHoverY <= h - padB) {
      const hv = hi - (state.simHoverY - padT) / plotH * (hi - lo);
      ctx.beginPath(); ctx.moveTo(padL, state.simHoverY); ctx.lineTo(w - padR, state.simHoverY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#232a36';
      ctx.fillRect(w - padR + 2, state.simHoverY - 8, padR - 4, 15);
      ctx.fillStyle = '#e9ecf2';
      ctx.fillText((hv > 0 ? '+' : '') + hv.toFixed(0) + '%', w - padR + 5, state.simHoverY + 3);
    }
    ctx.restore();
  }
  // readout
  const d = new Date(pts[idx].t);
  const v = pts[idx].v;
  const pct = ret[idx];
  const pnl = (o.credit ? o.entry - v : v - o.entry) * 100 * o.qty;
  const when = idx === 0 ? 'now' : (idx === pts.length - 1 ? 'at exp' : `${(d.getMonth() + 1)}/${d.getDate()}`);
  document.getElementById('simReadout').innerHTML =
    `<b>${when}</b> with ${o.parsedTicker || ''} at ${fmt$(S)}: ` +
    `est <b>${fmt$(v)}</b>/ct · <span style="color:${pct >= 0 ? 'var(--green)' : 'var(--red)'};font-weight:600;">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span> · ` +
    `<span style="color:${pnl >= 0 ? 'var(--green)' : 'var(--red)'};">${pnl >= 0 ? '+' : '−'}${fmt$(Math.abs(pnl))}</span> for ${o.qty} ct`;
}

export function simParamsFromCard(d, entry, qty) {
  return {
    isCall: d.isCall, K: d.parsed.strike, expStr: d.parsed.expStr, iv: d.iv, legs: d.legs,
    credit: !!d.credit, shortPut: !!d.shortPut, sizing: d.sizing, width: spreadWidth(d),
    entry, qty: d.sizing === 'allocation' ? qty : Math.max(1, qty), spot: d.underlyingPrice, stop: d.stopLevel,
    parsedTicker: d.parsed.ticker,
    label: `${d.parsed.ticker} ${strikesLabel(d)} ${typeLabel(d)} ${d.parsed.expStr}`
  };
}

export function simFromPinned(cardId) {
  const d = state.pinnedData[cardId];
  if (d && (d.sizing !== 'allocation' || quantityForCard(d) > 0)) effects.openSim(simParamsFromCard(d, d.mid, quantityForCard(d)));
}

export function simFromSaved(id) {
  const d = state.savedData[id];
  if (d) effects.openSim(simParamsFromCard(d, d.entry, d.qty)); // returns measured from YOUR fill
}

export function initSimEvents() {
  const canvas = document.getElementById('simChart');
  const toIdx = clientX => {
    const rect = canvas.getBoundingClientRect();
    const frac = (clientX - rect.left - 8) / (rect.width - 8 - 58);
    return Math.max(0, Math.min(80, Math.round(frac * 80)));
  };
  canvas.addEventListener('mousemove', e => { state.simHover = toIdx(e.clientX); state.simHoverY = e.clientY - canvas.getBoundingClientRect().top; drawSim(); });
  canvas.addEventListener('mouseleave', () => { state.simHover = -1; state.simHoverY = -1; drawSim(); });
  attachTouchCrosshair(canvas, t => {
    state.simHover = toIdx(t.clientX);
    state.simHoverY = t.clientY - canvas.getBoundingClientRect().top;
    drawSim();
  }, () => {}); // sim keeps the last readout on release
}
