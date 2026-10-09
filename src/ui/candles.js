// Daily candle canvas shared by the calculator's daily pane and the position chart: the fitted scale, the painting
// (candles, 8 EMA, level lines, crosshair) and the gestures (zoom, pan, hover, tap to pick a price).
import { panView, viewRange, zoomView } from '../core/chart-view.js';
import { SANS_FONT } from '../lib/media.js';
import { attachTouchCrosshair } from './chart.js';

export const CANDLE_H = 260;

// one scale for the candles, the hover and taps: the visible window, fitted to its bars plus the level lines
export function candleGeom(bars, view, w, levels = []) {
  const { start, end } = viewRange(view, bars.length);
  let lo = Infinity, hi = -Infinity;
  for (let i = start; i < end; i++) { const b = bars[i]; if (b.low < lo) lo = b.low; if (b.high > hi) hi = b.high; }
  for (const p of levels) if (p > 0) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
  const pad = (hi - lo) * 0.05 || 0.5;
  lo -= pad; hi += pad;
  const h = CANDLE_H, padL = 6, padR = 52, padT = 12, padB = 22;
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

/** a price picked near a candle's high or low takes that exact level; anywhere else, the price under the pointer */
export function snapToBar(g, bar, yy, px = 6) {
  if (bar) for (const p of [bar.high, bar.low]) if (Math.abs(g.y(p) - yy) <= px) return p;
  return g.price(yy);
}

/**
 * Paint the window g describes. lines: [{ price, color, label, solid?, left? }], dashed unless solid, under the candles,
 * labelled over them on the right (left = on the left edge). hover: { index, y } draws the crosshair, the price tag when y is on the plot.
 */
export function paintCandles(canvas, g, bars, { lines = [], hover = null } = {}) {
  const { w, h, padL, padR, padT, padB, plotW, plotH, start, end, slot, lo, hi, x, y } = g;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
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
    const parts = (bars[i].date || '').split('-');
    if (parts.length === 3 && x(i) - 10 >= 0 && x(i) + 14 <= w - padR) ctx.fillText(+parts[1] + '/' + +parts[2], x(i) - 10, h - 8);
  }

  const drawn = lines.filter(l => l.price > 0);
  for (const l of drawn) {
    ctx.save();
    ctx.strokeStyle = l.color; ctx.setLineDash(l.solid ? [] : [6, 3]); ctx.lineWidth = l.solid ? 1.75 : 1.25;
    ctx.beginPath(); ctx.moveTo(padL, y(l.price)); ctx.lineTo(w - padR, y(l.price)); ctx.stroke();
    ctx.restore();
  }

  for (let i = start; i < end; i++) {
    const b = bars[i];
    const col = b.close >= b.open ? cGreen : cRed;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(i), y(b.high)); ctx.lineTo(x(i), y(b.low)); ctx.stroke();
    const top = y(Math.max(b.open, b.close)), bot = y(Math.min(b.open, b.close));
    ctx.fillRect(x(i) - bw / 2, top, bw, Math.max(1, bot - top));
  }

  // 8 EMA of daily closes, warmed up on the full history and clipped to the plot (it can lag outside the window's range)
  const k = 2 / 9;
  let e = bars[0].close;
  ctx.save();
  ctx.beginPath(); ctx.rect(padL, padT, plotW, plotH); ctx.clip();
  ctx.strokeStyle = cPurple; ctx.lineWidth = 1.25; ctx.globalAlpha = 0.9;
  ctx.beginPath();
  for (let i = 0; i < end; i++) {
    e = bars[i].close * k + e * (1 - k);
    if (i > start) ctx.lineTo(x(i), y(e)); else if (i === start) ctx.moveTo(x(i), y(e));
  }
  ctx.stroke(); ctx.restore();

  // line labels on top of the candles, on a backing so a candle can't hide them
  for (const l of drawn) {
    const tw = ctx.measureText(l.label).width, lx = l.left ? padL + 4 : w - padR - 4 - tw, ly = y(l.price) - 4;
    ctx.save();
    ctx.fillStyle = 'rgba(26,30,39,0.85)'; // the canvas background, --bg3
    ctx.fillRect(lx - 3, ly - 9, tw + 6, 12);
    ctx.fillStyle = l.color;
    ctx.fillText(l.label, lx, ly);
    ctx.restore();
  }

  if (hover && hover.index >= start && hover.index < end) {
    ctx.save();
    ctx.strokeStyle = cBorder; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x(hover.index), padT); ctx.lineTo(x(hover.index), h - padB); ctx.stroke();
    if (hover.y >= padT && hover.y <= h - padB) {
      ctx.beginPath(); ctx.moveTo(padL, hover.y); ctx.lineTo(w - padR, hover.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#232a36';
      ctx.fillRect(w - padR + 2, hover.y - 8, padR - 4, 15);
      ctx.fillStyle = '#e9ecf2';
      ctx.fillText('$' + g.price(hover.y).toFixed(2), w - padR + 5, hover.y + 3);
    }
    ctx.restore();
  }
}

/** the hovered bar as the readout line shows it */
export function ohlcText(b) {
  const css = getComputedStyle(document.documentElement);
  const chg = b.close - b.open;
  return `1D ${b.date} &nbsp; O ${b.open.toFixed(2)} &nbsp; H ${b.high.toFixed(2)} &nbsp; L ${b.low.toFixed(2)} &nbsp; C <span style="color:${css.getPropertyValue(chg >= 0 ? '--green' : '--red').trim()}">${b.close.toFixed(2)}</span>`;
}

/**
 * Zoom, pan, hover and tap on a candle canvas. o: { count(), view(), setView(v), geom(), hover(clientX, clientY), leave(), pick(clientX, clientY) }.
 * A trackpad pinch (ctrl+wheel in Chrome and Firefox, gesture events in Safari) or ctrl/cmd+scroll zooms, sideways swipes,
 * shift+scroll and mouse drags pan, a plain vertical scroll is left to the page. On touch: long-press crosshair (release picks),
 * sideways swipe pans, two fingers pinch. A drag is not a click, so letting go never picks.
 */
export function attachCandleGestures(canvas, o) {
  const localX = clientX => clientX - canvas.getBoundingClientRect().left;
  // where a zoom pivots: 0 = the plot's left edge, 1 = its right (today's side)
  const anchorAt = clientX => { const g = o.geom(), a = (localX(clientX) - g.padL) / g.plotW; return Number.isFinite(a) ? a : 1; };
  const show = view => { if (o.count()) o.setView(view); };
  canvas.addEventListener('mousemove', e => { if (o.count()) o.hover(e.clientX, e.clientY); });
  canvas.addEventListener('mouseleave', () => o.leave());

  canvas.addEventListener('wheel', e => {
    const n = o.count();
    if (!n) return;
    const px = e.deltaMode === 1 ? 16 : 1; // Firefox can report lines
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const dy = Math.max(-50, Math.min(50, e.deltaY * px));
      show(zoomView(o.view(), n, Math.exp(-dy * 0.01), anchorAt(e.clientX)));
      return;
    }
    if (!e.shiftKey && Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * px;
    e.preventDefault();
    show(panView(o.view(), n, -dx / o.geom().slot));
  }, { passive: false });

  let drag = null, dragged = false;
  const endDrag = () => { dragged = drag.moved; drag = null; canvas.style.cursor = ''; };
  canvas.addEventListener('mousedown', e => {
    dragged = false;
    if (e.button === 0 && o.count()) drag = { x: e.clientX, from: o.view(), moved: false };
  });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    if (e.buttons === 0) { endDrag(); return; } // released outside the window
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 4) return;
    drag.moved = true;
    canvas.style.cursor = 'grabbing';
    show(panView(drag.from, o.count(), dx / o.geom().slot));
  });
  window.addEventListener('mouseup', () => { if (drag) endDrag(); });

  let from = null, touching = false; // the view a touch gesture started from
  attachTouchCrosshair(canvas, t => {
    if (o.count()) o.hover(t.clientX, t.clientY);
  }, last => {
    if (last && o.count()) {
      const rect = canvas.getBoundingClientRect();
      if (last.clientY >= rect.top && last.clientY <= rect.bottom) o.pick(last.clientX, last.clientY);
    }
    o.leave();
  }, {
    start: () => { from = o.view(); },
    pan: dx => show(panView(from, o.count(), dx / o.geom().slot)),
    pinch: (scale, mid0, dMid) => {
      const n = o.count(), z = zoomView(from, n, scale, anchorAt(mid0));
      const { start, end } = viewRange(z, n);
      show(panView(z, n, dMid / (o.geom().plotW / Math.max(1, end - start))));
    },
  });
  // Safari sends a trackpad pinch as gesture events instead of ctrl+wheel. On iOS the touch pinch above is
  // already zooming, so there they only stop the page from zooming too
  const fingers = e => { touching = e.touches.length > 0; };
  canvas.addEventListener('touchstart', fingers, { passive: true });
  canvas.addEventListener('touchend', fingers);
  canvas.addEventListener('touchcancel', fingers);
  canvas.addEventListener('gesturestart', e => { e.preventDefault(); if (!touching) from = o.view(); });
  canvas.addEventListener('gesturechange', e => {
    e.preventDefault();
    if (!touching && from) show(zoomView(from, o.count(), e.scale, anchorAt(e.clientX)));
  });

  canvas.addEventListener('click', e => {
    if (dragged) { dragged = false; return; }
    if (o.count()) o.pick(e.clientX, e.clientY);
  });
}
