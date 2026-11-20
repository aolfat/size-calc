// The simulator sheet: what a contract or spread is worth with the stock at your target price on a day and time you pick.
// One chart: your daily candles and moving averages on the left, the future on the right, the target a dot you move
// (up and down for price, sideways for time, each alone), the contract's price at the top.
import { state, SIM_RANGES } from '../state.js';
import { inZone, displayZone, zoneAbbr } from '../lib/zone.js';
import { RISK_FREE, impliedVolatility } from '../core/black-scholes.js';
import { fmt$, nyWallMs, wallClock } from '../core/format.js';
import { expiryCloseMs, isBull, spreadWidth, strikesLabel, typeLabel } from '../core/options.js';
import { simReturnBase } from '../core/sizing.js';
import { SESSION_MINUTES, breakevenNear, contractValue, gainPerShare, minuteOf, momentAt, sessionsThrough, simLevels } from '../core/simulate.js';
import { SANS_FONT, mq } from '../lib/media.js';
import { store } from '../lib/store.js';
import { dailyHistory } from '../services/tradier.js';
import { quantityForCard } from './allocation.js';
import { DAILY_IND, chartAverages, indOn, toggleDailyInd } from './chart-ind.js';
import { DAILY_FETCH_DAYS } from './daily.js';
import { showError } from './feedback.js';
import { effects } from './effects.js';
import { closeSheet, onSheetChange, openSheet } from './sheets.js';

const YEAR = 365 * 24 * 3600 * 1000, MIN = 60000;
const RANGE_NAMES = { 21: '1M', 63: '3M', 126: '6M' };
/** how far ahead the future side shows, in sessions after today's: the smallest that fits the target */
const WINDOWS = [3, 5, 10, Infinity];
const CHART_H = { phone: 300, wide: 330 };

/**
 * Open the simulator on a contract or spread. o: what openSim always took (isCall, K, expStr, iv, legs, mark, entry, qty,
 * spot, stop, credit, width, label, parsedTicker, em, asOf); a quoted mark refits IV to it, each leg its own.
 */
export function openSim(o) {
  if (!o) return;
  if (!(o.entry > 0)) { showError('No entry price to measure returns from.'); return; }
  if (o.sizing === 'allocation' && o.qty < 1) { showError('No contracts fit this allocation.'); return; }
  if (o.mark != null) {
    const asOf = o.asOf ?? Date.now(), spot = +Number(o.spot).toFixed(2);
    const years = (/** @type {string} */ exp) => (expiryCloseMs(exp) - asOf) / YEAR;
    const T = years(o.expStr);
    // Fit each leg to its own quote, type and expiry. Work on copies so the card keeps its supplied IV and prices.
    const legs = o.legs?.map(L => ({ ...L, iv: impliedVolatility(L.isCall ?? o.isCall, L.mid, spot, L.K, L.expStr ? years(L.expStr) : T, RISK_FREE) }));
    const iv = legs ? legs[0]?.iv : impliedVolatility(o.isCall, o.mark, spot, o.K, T, RISK_FREE);
    if (!(iv > 0) || legs?.some(L => !(L.iv > 0))) {
      showError(`Cannot fit a simulation to the ${o.markSource || 'Schwab'} price for ${o.label}. Refresh the quote and try again.`);
      return;
    }
    o = { ...o, spot, iv, legs, asOf };
  }
  if (!(o.iv > 0)) { showError('No IV on this contract, so it can\'t be simulated.'); return; }
  const asOf = o.asOf ?? Date.now();
  const sessions = sessionsThrough(asOf, o.expStr);
  if (!sessions.length) { showError(`${o.label} has expired. Nothing to simulate.`); return; }
  o = { ...o, asOf };
  state.simState = o;
  const uNow = minuteOf(sessions, asOf);
  const kept = state.simTargets[o.label];
  const levels = simLevels(o);
  const aim = levels.find(l => l.id === '1R') || levels.find(l => l.id === (isBull(o) ? '+1s' : '-1s'));
  // the next session at 3:00 PM New York, or today's close when expiry is today
  const t0 = sessions[1] ? sessions[1].open + 330 * MIN : sessions[0].close;
  const t = kept && kept.t >= asOf && kept.t <= sessions.at(-1).close ? kept.t : t0;
  state.simView = { S: kept ? kept.S : aim ? aim.price : o.spot, t, sessions, uNow, u1: 0, ahead: 3, split: 0.5,
    axis: null, dragging: false, touched: false, edge: false, lo: 0, hi: 0 };
  state.simView.ahead = fitWindow(); state.simView.u1 = windowEnd(state.simView.ahead);
  state.simBars = state.simRange;
  document.getElementById('simTitle').textContent = o.label;
  const markTime = typeof o.markAsOf === 'number' ? inZone(o.markAsOf) : o.markAsOf;
  const mark = o.mark != null ? `${o.markSource || 'Schwab'} ${fmt$(o.mark)}/ct${markTime ? ` as of ${markTime}` : ''} · ` : '';
  document.getElementById('simMeta').textContent = `${mark}${o.entryWord || (o.credit ? 'credit' : 'entry')} ${fmt$(o.entry)}/${o.sizing === 'allocation' ? 'share' : 'ct'} · ${o.qty} ct · IV ${(o.iv * 100).toFixed(1)}% ${o.mark != null ? 'fitted, ' : ''}held${o.shortPut ? ' · return on assignment notional' : ''} · times ${zoneAbbr()}`;
  watchSheet();
  openSheet('sim');
  loadDaily(o.parsedTicker);
  drawSim();
}

export function closeSim() {
  if (state.simState && state.simView) state.simTargets[state.simState.label] = { S: state.simView.S, t: state.simView.t };
  if (state.openSheetName === 'sim') closeSheet();
  state.simState = null;
  state.simView = null;
}

// any way the sheet closes (×, the backdrop, a pull down, Esc, another sheet) closes the simulator, keeping where you left the target;
// registered on first open, not at load (sheets.js and this module import each other through effects.js)
let watching = false;
function watchSheet() {
  if (watching) return;
  watching = true;
  onSheetChange(name => {
    if (name === 'sim' || !state.simState) return;
    if (state.simView) state.simTargets[state.simState.label] = { S: state.simView.S, t: state.simView.t };
    state.simState = null;
    state.simView = null;
  });
}

/** the daily bars behind the chart: the Size tab's when it's the same symbol, else fetched once per symbol */
async function loadDaily(symbol) {
  if (!symbol || (symbol === state.dailySymbol && state.dailyBars.length)) return;
  const had = state.simDaily[symbol];
  if (had && (had.loading || !had.error)) return; // in hand or on its way; a failed read tries again on the next open
  const entry = state.simDaily[symbol] = { bars: [], warm: [], loading: true, error: '' };
  try {
    entry.bars = await dailyHistory(symbol, DAILY_FETCH_DAYS);
    if (!entry.bars.length) entry.error = `No daily history for ${symbol}.`;
  } catch (e) {
    entry.error = 'Could not load the daily chart.';
  }
  entry.loading = false;
  if (state.simState?.parsedTicker === symbol) drawSim();
}

/** { bars, warm, note }: the history the chart draws for the open contract */
function history() {
  const sym = state.simState.parsedTicker;
  if (sym && sym === state.dailySymbol && state.dailyBars.length) return { bars: state.dailyBars, warm: state.dailyWarm, note: '' };
  const d = state.simDaily[sym];
  if (!d) return { bars: [], warm: [], note: '' };
  return { bars: d.bars, warm: d.warm, note: d.loading ? 'Loading the daily chart' : d.error };
}

/** the contract's value per share at the stock price and moment; at the quote's own moment and price, the quoted mark */
function valueAt(S, t) {
  const o = state.simState;
  return o.mark != null && S === o.spot && t <= o.asOf ? o.mark : contractValue(o, S, t);
}

/** dollars made or lost on the whole position */
const pnlAt = (S, t) => gainPerShare(state.simState, valueAt(S, t)) * 100 * state.simState.qty;

/** 1R: what the stop costs right now, the loss the trade was sized for; null with no stop */
function oneR() {
  const o = state.simState;
  if (!(o.stop > 0)) return null;
  const loss = -pnlAt(o.stop, o.asOf);
  return loss > 0.005 ? loss : null;
}

/** the most the position can make and lose, for a vertical spread (null for others) */
function spreadBounds() {
  const o = state.simState;
  if (!(o.width > 0) || o.noFloor) return null;
  const n = 100 * o.qty;
  return o.credit ? { gain: o.entry * n, loss: (o.width - o.entry) * n } : { gain: (o.width - o.entry) * n, loss: o.entry * n };
}

function windowEnd(ahead) {
  const v = state.simView;
  return Math.min(v.sessions.length * SESSION_MINUTES, (1 + ahead) * SESSION_MINUTES);
}

/** the smallest window that keeps the target inside its first three quarters */
function fitWindow() {
  const v = state.simView, ahead = minuteOf(v.sessions, v.t) / SESSION_MINUTES;
  return WINDOWS.find(w => ahead <= (1 + w) * 0.75 + 0.01) ?? Infinity;
}

let anim = 0;
/** the future side eases to its new window */
function refit(edge = false) {
  const v = state.simView;
  if (!v) return;
  v.ahead = edge ? (WINDOWS.find(w => w > v.ahead) ?? Infinity) : fitWindow();
  const to = windowEnd(v.ahead), from = v.u1;
  if (typeof requestAnimationFrame !== 'function' || mq('(prefers-reduced-motion: reduce)') || from === to) { v.u1 = to; drawSim(); return; }
  cancelAnimationFrame(anim);
  const t0 = performance.now();
  const step = now => {
    if (state.simView !== v) return;
    const f = Math.min(1, (now - t0) / 260), e = 1 - Math.pow(1 - f, 3);
    v.u1 = from + (to - from) * e; drawSim();
    if (f < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

const signed = (v, f) => (+v.toFixed(2) >= 0 ? '+' : '−') + f(Math.abs(v));
const dollars = v => '$' + Math.round(v).toLocaleString('en-US');
const tone = v => +v.toFixed(2) >= 0 ? 'pos' : 'neg';
/** the session's date, 'Fri Nov 20', never Today or Tomorrow (owner request) */
const dayWords = t => inZone(t, { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
const clockWords = t => inZone(t, { hour: 'numeric', minute: '2-digit' });

export function drawSim() {
  const o = state.simState, v = state.simView;
  if (!o || !v) return;
  const value = valueAt(v.S, v.t), gain = gainPerShare(o, value), pnl = gain * 100 * o.qty, R = oneR(), bounds = spreadBounds();
  document.getElementById('simValue').innerHTML = `${fmt$(value)}<small>${o.credit ? 'to close' : o.legs ? 'per spread' : 'per contract'}</small>`;
  document.getElementById('simResult').innerHTML = `<span class="${tone(pnl)}">${signed(pnl, dollars)}</span>`
    + (R ? `<span class="${tone(pnl)}">${signed(pnl / R, x => x.toFixed(1) + 'R')}</span>` : '')
    + `<span class="${tone(pnl)}">${signed(gain / simReturnBase(o) * 100, x => x.toFixed(0) + '%')}</span>`
    + (bounds && pnl > 0 ? `<span class="dim">${Math.round(pnl / bounds.gain * 100)}% of max</span>` : '')
    + `<span class="dim">on ${o.qty} ct</span>`;
  const lv = simLevels(o).find(l => Math.abs(l.price - v.S) < 0.005);
  document.getElementById('simPxLabel').textContent = `${o.parsedTicker || 'Stock'} at`;
  document.getElementById('simPxText').textContent = fmt$(v.S) + (lv ? ` · ${lv.label}` : '');
  document.getElementById('simDayText').textContent = dayWords(v.t);
  document.getElementById('simTimeText').textContent = clockWords(v.t);
  syncInputs();
  const be = breakevenNear(S => gainPerShare(o, contractValue(o, S, v.t)), o.spot);
  const stopV = o.stop > 0 ? pnlAt(o.stop, v.t) : null;
  document.getElementById('simFacts').innerHTML =
    `<div><span>Breakeven then <b>${be === null ? 'none near' : fmt$(be)}</b></span>`
    + (stopV !== null ? `<span>Stop hit then <b class="${tone(stopV)}">${signed(stopV, dollars)}</b>${R ? ` (${signed(stopV / R, x => x.toFixed(1) + 'R')})` : ''}</span>` : '') + '</div>'
    + (bounds ? `<div><span>Max gain <b class="pos">+${dollars(bounds.gain)}</b>${R ? ` (+${(bounds.gain / R).toFixed(1)}R)` : ''}</span><span>Max loss <b class="neg">−${dollars(bounds.loss)}</b>${R ? ` (−${(bounds.loss / R).toFixed(1)}R)` : ''}</span></div>` : '');
  renderLegend();
  paint(gain >= 0);
}

/** the inputs behind the three values hold the target, so a tap opens the keyboard or wheel on it */
function syncInputs() {
  const v = state.simView, zone = displayZone(), at = wallClock(v.t, zone);
  const px = document.getElementById('simPxInput'), day = document.getElementById('simDayInput'), tm = document.getElementById('simTimeInput');
  if (document.activeElement !== px) px.value = v.S.toFixed(2);
  const first = v.sessions[0].day, last = v.sessions.at(-1).day;
  if (document.activeElement !== day) { day.min = first; day.max = last; day.value = wallClock(v.t, 'America/New_York').day; }
  if (document.activeElement !== tm) {
    const s = v.sessions.find(x => v.t <= x.close) || v.sessions.at(-1);
    tm.min = wallClock(s.open, zone).time; tm.max = wallClock(s.close, zone).time; tm.value = at.time;
  }
}

function renderLegend() {
  const n = state.simBars, chips = SIM_RANGES.map(r => `<button data-action="simRange" data-arg="${r}" class="${r === n ? 'on' : ''}" aria-pressed="${r === n}">${RANGE_NAMES[r]}</button>`).join('');
  const mas = DAILY_IND.map(i => {
    const on = indOn('daily', i.id);
    return `<button data-action="simToggleInd" data-arg="${i.id}" class="${on ? '' : 'off'}" style="color:var(${i.color})" aria-pressed="${on}" title="${on ? 'Hide' : 'Show'} the ${i.label}">${i.n}</button>`;
  }).join('');
  const html = `<span class="sim-range" role="group" aria-label="Daily history">${chips}</span>${mas}`;
  const el = document.getElementById('simLegend');
  if (el.innerHTML !== html) el.innerHTML = html;
}

/** a history chip: 1M, 3M or 6M, kept on this device */
export function simRange(n) {
  if (!SIM_RANGES.includes(n)) return;
  state.simRange = n; state.simBars = n;
  store.set('sim_range', String(n));
  if (state.simView) { state.simView.lo = 0; drawSim(); }
}

/** a moving average in the legend: the same on/off as the daily chart's */
export function simToggleInd(id) { toggleDailyInd(id); drawSim(); }

/** the chart's own setter for the history: pinches land between the chips */
function setBars(n) {
  const b = Math.max(10, Math.min(SIM_RANGES.at(-1), Math.round(n)));
  if (b === state.simBars) return;
  state.simBars = b; state.simView.lo = 0; drawSim();
}

const clampT = t => { const v = state.simView; return Math.max(state.simState.asOf, Math.min(v.sessions.at(-1).close, t)); };

/** a typed target price */
export function simTargetPrice(el) {
  const p = parseFloat(el.value), v = state.simView;
  if (!v) return;
  if (p > 0) { v.S = Math.round(p * 100) / 100; v.touched = true; if (v.S < v.lo || v.S > v.hi) v.lo = 0; }
  el.blur(); drawSim();
}

/** a picked day: the same time of day on it; a weekend or holiday rolls to the next session */
export function simTargetDay(el) {
  const v = state.simView;
  if (!v || !el.value) return;
  const s = v.sessions.find(x => x.day >= el.value) || v.sessions.at(-1);
  const cur = v.sessions.find(x => v.t <= x.close) || v.sessions[0];
  v.t = clampT(s.open + (v.t - cur.open)); v.touched = true;
  refit();
}

/** a picked time, in the zone times show in, on the target's day; held inside the session */
export function simTargetTime(el) {
  const v = state.simView;
  if (!v || !/^\d{2}:\d{2}/.test(el.value)) return;
  const s = v.sessions.find(x => v.t <= x.close) || v.sessions[0], zone = displayZone();
  let ms = nyWallMs(s.day, el.value.slice(0, 5));
  const shown = wallClock(ms, zone).time, typed = el.value.slice(0, 5);
  ms += ((+typed.slice(0, 2) * 60 + +typed.slice(3)) - (+shown.slice(0, 2) * 60 + +shown.slice(3))) * MIN; // the shown zone's wall clock, not New York's
  const mins = Math.round(Math.max(0, Math.min(SESSION_MINUTES, (ms - s.open) / MIN)) / 5) * 5;
  v.t = clampT(s.open + mins * MIN); v.touched = true;
  refit();
}

/** where things sit on the chart, from the last paint: the pointer handlers read it */
let geo = null;

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function paint(good) {
  const o = state.simState, v = state.simView, canvas = document.getElementById('simChart');
  const w = canvas.clientWidth;
  if (!(w > 0)) return; // hidden: a later draw paints it
  const h = mq('(min-width: 601px)') ? CHART_H.wide : CHART_H.phone, dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const C = { text: css('--text'), text2: css('--text2'), text3: css('--text3'), green: css('--green'), red: css('--red'),
    purple: css('--purple'), bg2: css('--bg2'), bg4: css('--bg4'), border2: css('--border2') };
  const padL = 2, padR = 56, padT = 30, padB = 26, x1 = w - padR, yBot = h - padB;
  const xs = padL + v.split * (x1 - padL); // now: the past to its left, the future to its right
  const { bars, warm, note } = history();
  const shown = bars.slice(-state.simBars), off = bars.length - shown.length, bw = (xs - padL) / Math.max(1, state.simBars);
  const XP = i => xs - (shown.length - i - 0.5) * bw; // a candle's center, the latest beside now
  const u0 = v.uNow, u1 = v.u1, XF = u => xs + (u - u0) / Math.max(1, u1 - u0) * (x1 - xs);
  const levels = simLevels(o), strikes = o.legs ? o.legs.map(L => ({ K: L.K, side: L.side })) : [{ K: o.K, side: o.credit ? -1 : 1 }];
  // the price scale holds still while you drag, so the dot stays under your finger
  if (!v.lo || (!v.dragging && (v.S < v.lo || v.S > v.hi))) {
    const ps = [...shown.flatMap(b => [+b.high, +b.low]), o.spot, v.S, ...levels.map(l => l.price), ...strikes.map(s => s.K)].filter(p => p > 0);
    const lo = Math.min(...ps), hi = Math.max(...ps), pad = (hi - lo) * 0.06 || o.spot * 0.02;
    v.lo = lo - pad; v.hi = hi + pad;
  }
  const { lo, hi } = v, Y = p => padT + (hi - p) / (hi - lo) * (yBot - padT);
  geo = { padL, x1, xs, padT, yBot, h, u0, u1, lo, hi };
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  // the future, faintly lit
  const fade = ctx.createLinearGradient(xs, 0, x1, 0);
  fade.addColorStop(0, 'rgba(91,157,255,0.08)'); fade.addColorStop(1, 'rgba(91,157,255,0)');
  ctx.fillStyle = fade; ctx.fillRect(xs, 6, x1 - xs, yBot - 6);

  // levels and strikes across both sides, named on the right axis
  const tags = [];
  for (const l of levels) {
    ctx.strokeStyle = l.tone === 'stop' ? 'rgba(255,93,93,0.6)' : l.tone === 'target' ? 'rgba(47,214,123,0.25)' : 'rgba(151,160,179,0.3)';
    ctx.setLineDash(l.tone === 'stop' ? [4, 4] : [2, 5]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, Y(l.price)); ctx.lineTo(x1, Y(l.price)); ctx.stroke(); ctx.setLineDash([]);
    tags.push({ y: Y(l.price), text: l.label, color: l.tone === 'stop' ? C.red : l.tone === 'target' ? C.green : C.text2 });
  }
  for (const s of strikes) {
    ctx.strokeStyle = 'rgba(180,122,255,0.35)'; ctx.setLineDash([1, 4]);
    ctx.beginPath(); ctx.moveTo(padL, Y(s.K)); ctx.lineTo(x1, Y(s.K)); ctx.stroke(); ctx.setLineDash([]);
    tags.push({ y: Y(s.K), text: `${s.K}${strikes.length > 1 ? (s.side > 0 ? ' L' : ' S') : ''}`, color: C.purple });
  }
  tags.push({ y: Y(o.spot), text: o.spot.toFixed(2), color: C.text3 });

  // the past: candles in the app's green and red, the daily chart's moving averages over them
  const cw = Math.max(1, Math.min(9, bw * 0.62));
  shown.forEach((b, i) => {
    const up = +b.close >= +b.open, x = XP(i);
    ctx.strokeStyle = ctx.fillStyle = up ? C.green : C.red; ctx.globalAlpha = 0.85; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, Y(+b.high)); ctx.lineTo(x, Y(+b.low)); ctx.stroke();
    ctx.fillRect(x - cw / 2, Y(Math.max(+b.open, +b.close)), cw, Math.max(1, Math.abs(Y(+b.open) - Y(+b.close))));
  });
  ctx.globalAlpha = 1;
  if (shown.length) {
    for (const m of chartAverages('daily', warm, bars.map(b => +b.close), name => css(name))) {
      ctx.strokeStyle = m.color; ctx.lineWidth = 1.3; ctx.globalAlpha = 0.9; ctx.beginPath();
      let on = false;
      shown.forEach((_, i) => {
        const val = m.values[off + i];
        if (val == null || Y(val) < padT - 4 || Y(val) > yBot + 4) { on = false; return; }
        on ? ctx.lineTo(XP(i), Y(val)) : ctx.moveTo(XP(i), Y(val)); on = true;
      });
      ctx.stroke(); ctx.globalAlpha = 1;
    }
  }
  if (note) { ctx.fillStyle = C.text3; ctx.font = `11px ${SANS_FONT}`; ctx.textAlign = 'center'; ctx.fillText(note, (padL + xs) / 2, padT + (yBot - padT) / 2); }

  // the now line
  ctx.strokeStyle = C.border2; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xs, 6); ctx.lineTo(xs, yBot); ctx.stroke();

  // the target's time tag, placed first so no day label runs into it
  const tx = XF(minuteOf(v.sessions, v.t)), ty = Y(v.S);
  const short = inZone(v.t, { month: 'short', day: 'numeric' });
  const tl = `${short} ${clockWords(v.t).replace(' ', '')}`;
  ctx.font = `600 10.5px ${SANS_FONT}`;
  const tw = ctx.measureText(tl).width + 12, tlx = Math.max(xs + 28, Math.min(x1 - tw, tx - tw / 2));
  // the axis: dates under the past, the ‹ Now › handle, days under the future
  ctx.font = `10.5px ${SANS_FONT}`; ctx.textAlign = 'center'; ctx.fillStyle = C.text3;
  const every = Math.max(1, Math.ceil(46 / bw));
  for (let i = shown.length - 1 - every; i >= 0; i -= every) {
    const x = XP(i);
    if (x < padL + 18) break;
    if (x > xs - 50) continue;
    ctx.fillText(new Date(shown[i].date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }), x, h - 8);
  }
  ctx.font = `600 10.5px ${SANS_FONT}`;
  ctx.fillStyle = v.axis === 'split' ? C.text2 : C.bg4; rrect(ctx, xs - 24, h - 21, 48, 18, 9); ctx.fill();
  ctx.fillStyle = v.axis === 'split' ? C.bg2 : C.text2; ctx.fillText('‹ Now ›', xs, h - 8.5);
  ctx.font = `10.5px ${SANS_FONT}`; ctx.fillStyle = C.text3;
  const per = (x1 - xs) / Math.max(1e-9, (u1 - u0) / SESSION_MINUTES), dayEvery = Math.max(1, Math.ceil(46 / per));
  for (let i = 1; i * SESSION_MINUTES < u1; i++) {
    const cx = XF((i + 0.5) * SESSION_MINUTES);
    if (cx > x1 - 10) break;
    if (cx < xs + 50 || i % dayEvery || !(cx + 24 < tlx - 4 || cx - 24 > tlx + tw + 4)) continue;
    ctx.fillText(inZone(v.sessions[i].open, { weekday: 'short', day: 'numeric' }).replace(/(\d+) (\w+)/, '$2 $1'), cx, h - 8);
  }

  // right-axis names: the first named wins a crowded spot, and the target's own tag always does
  const drawn = [ty];
  ctx.font = `600 10.5px ${SANS_FONT}`; ctx.textAlign = 'left';
  for (const t of tags) if (drawn.every(y => Math.abs(t.y - y) > 12)) { drawn.push(t.y); ctx.fillStyle = t.color; ctx.fillText(t.text, x1 + 8, t.y + 3.5); }

  // now to your target
  const col = good ? C.green : C.red;
  ctx.strokeStyle = col; ctx.globalAlpha = 0.6; ctx.setLineDash([4, 5]); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(xs, Y(o.spot)); ctx.lineTo(tx, ty); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  ctx.fillStyle = C.text; ctx.beginPath(); ctx.arc(xs, Y(o.spot), 3, 0, 7); ctx.fill();
  // guides to both axes; the one a drag holds reads solid
  const guide = (held, path) => { ctx.strokeStyle = held ? 'rgba(233,236,242,0.45)' : 'rgba(233,236,242,0.18)'; ctx.lineWidth = 1; ctx.setLineDash(held ? [] : [2, 3]); ctx.beginPath(); path(); ctx.stroke(); ctx.setLineDash([]); };
  guide(v.axis === 'time', () => { ctx.moveTo(padL, ty); ctx.lineTo(x1, ty); });
  guide(v.axis === 'price', () => { ctx.moveTo(tx, padT - 4); ctx.lineTo(tx, yBot); });
  // the price tag on the right, the day and time below
  ctx.fillStyle = col; rrect(ctx, x1 + 3, ty - 9.5, padR - 4, 19, 5); ctx.fill();
  if (v.axis === 'price') { ctx.strokeStyle = C.text; ctx.lineWidth = 1.5; rrect(ctx, x1 + 1.5, ty - 11, padR - 1, 22, 6); ctx.stroke(); }
  ctx.fillStyle = '#0b0d12'; ctx.textAlign = 'center'; ctx.font = `700 10.5px ${SANS_FONT}`;
  ctx.fillText(v.S.toFixed(2), x1 + 3 + (padR - 4) / 2, ty + 3.6);
  ctx.font = `600 10.5px ${SANS_FONT}`; ctx.fillStyle = C.bg4; rrect(ctx, tlx, h - 21, tw, 18, 5); ctx.fill();
  if (v.axis === 'time') { ctx.strokeStyle = C.text; ctx.lineWidth = 1.5; rrect(ctx, tlx - 1.5, h - 22.5, tw + 3, 21, 6); ctx.stroke(); }
  ctx.fillStyle = C.text; ctx.fillText(tl, tlx + tw / 2, h - 8.5);
  // the dot, haloed while held, with chevrons for the way this drag moves it
  if (v.dragging && (v.axis === 'time' || v.axis === 'price' || v.axis == null)) {
    ctx.fillStyle = good ? 'rgba(47,214,123,0.16)' : 'rgba(255,93,93,0.16)'; ctx.beginPath(); ctx.arc(tx, ty, 22, 0, 7); ctx.fill();
  }
  ctx.fillStyle = C.bg2; ctx.beginPath(); ctx.arc(tx, ty, 10, 0, 7); ctx.fill();
  ctx.fillStyle = col; ctx.beginPath(); ctx.arc(tx, ty, 7.5, 0, 7); ctx.fill();
  ctx.fillStyle = C.bg2; ctx.beginPath(); ctx.arc(tx, ty, 2.8, 0, 7); ctx.fill();
  if (v.axis === 'time' || v.axis === 'price') {
    ctx.fillStyle = C.text;
    const chev = (cx, cy, dx, dy) => { ctx.beginPath(); ctx.moveTo(cx + dx * 5, cy + dy * 5); ctx.lineTo(cx - dy * 4.5 - dx, cy + dx * 4.5 - dy); ctx.lineTo(cx + dy * 4.5 - dx, cy - dx * 4.5 - dy); ctx.closePath(); ctx.fill(); };
    if (v.axis === 'time') { chev(tx - 30, ty, -1, 0); chev(tx + 30, ty, 1, 0); } else { chev(tx, ty - 30, 0, -1); chev(tx, ty + 30, 0, 1); }
  }
  // the pinch readout
  if (v.axis === 'pinch') {
    const name = RANGE_NAMES[state.simBars], lab = name ? `${name} · ${state.simBars} days` : `${state.simBars} days`;
    ctx.font = `700 15px ${SANS_FONT}`;
    const lw = ctx.measureText(lab).width + 24, cx = (padL + xs) / 2, cy = padT + (yBot - padT) / 2;
    ctx.fillStyle = 'rgba(11,13,18,0.82)'; rrect(ctx, cx - lw / 2, cy - 17, lw, 34, 10); ctx.fill();
    ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.fillText(lab, cx, cy + 5);
  }
  if (!v.touched) { ctx.fillStyle = C.text3; ctx.font = `11px ${SANS_FONT}`; ctx.textAlign = 'right'; ctx.fillText('↕ price   ↔ time', x1 - 6, padT + 12); }
}

/**
 * The chart's gestures. A drag locks to the direction it starts in: up and down moves only the price, sideways only the
 * time, from wherever it starts and by however far it slides. The right edge is a price ruler, the bottom edge under the
 * future a time ruler, the ‹ Now › handle moves the split, two fingers (or ctrl + wheel, a trackpad's pinch) zoom the past.
 * Arrow keys nudge the target: ← → five minutes, ↑ ↓ five cents.
 */
export function initSimEvents() {
  const canvas = document.getElementById('simChart');
  if (!canvas || !canvas.addEventListener) return;
  let g = null;
  const pts = new Map();
  const pos = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const spread = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  const priceAt = y => geo.hi - (Math.max(geo.padT, Math.min(geo.yBot, y)) - geo.padT) / (geo.yBot - geo.padT) * (geo.hi - geo.lo);
  const uAt = x => geo.u0 + Math.max(0, Math.min(1, (x - geo.xs) / (geo.x1 - geo.xs))) * (geo.u1 - geo.u0);
  const setPrice = p => {
    const o = state.simState, snaps = [...simLevels(o).map(l => l.price), o.spot, ...(o.legs ? o.legs.map(L => L.K) : [o.K])];
    const near = snaps.find(s => Math.abs(s - p) < (geo.hi - geo.lo) * 0.012);
    const S = Math.max(0.05, near ?? Math.round(p * 20) / 20);
    if (near != null && S !== state.simView.S) effects.haptic();
    state.simView.S = S;
  };
  const setU = u => {
    const v = state.simView, end = v.sessions.length * SESSION_MINUTES;
    u = Math.max(v.uNow, Math.min(end, u));
    const i = Math.floor(u / SESSION_MINUTES);
    u = Math.min(end, i * SESSION_MINUTES + Math.round((u - i * SESSION_MINUTES) / 5) * 5);
    v.t = clampT(momentAt(v.sessions, u));
    v.edge = (u - geo.u0) / (geo.u1 - geo.u0) > 0.94;
  };
  canvas.addEventListener('pointerdown', e => {
    const v = state.simView;
    if (!v || !geo) return;
    canvas.setPointerCapture?.(e.pointerId); pts.set(e.pointerId, pos(e));
    if (pts.size === 2) { // a second finger: a pinch on the past, whatever the first was doing
      if (g && g.axis !== 'pinch') { v.S = g.S; v.t = g.t; }
      g = { axis: 'pinch', d0: spread(), bars0: state.simBars }; v.axis = 'pinch'; v.dragging = true; drawSim(); return;
    }
    v.dragging = true; v.touched = true; v.edge = false;
    const { x, y } = pos(e);
    const zone = Math.abs(x - geo.xs) < 28 && y > geo.yBot ? 'split' : x > geo.x1 ? 'price' : y > geo.yBot && x > geo.xs ? 'time' : null;
    g = { x, y, S: v.S, t: v.t, u: minuteOf(v.sessions, v.t), axis: zone, ruler: zone === 'price' || zone === 'time', split: v.split };
    v.axis = zone;
    if (zone === 'price') setPrice(priceAt(y));
    if (zone === 'time') setU(uAt(x));
    drawSim();
  });
  canvas.addEventListener('pointermove', e => {
    const v = state.simView;
    if (!v || !g || !pts.has(e.pointerId)) return;
    pts.set(e.pointerId, pos(e));
    if (g.axis === 'pinch') { if (pts.size === 2) setBars(g.bars0 * g.d0 / spread()); drawSim(); return; }
    const { x, y } = pos(e), dx = x - g.x, dy = y - g.y;
    if (g.axis === 'split') { v.split = Math.max(0.25, Math.min(0.72, g.split + dx / (geo.x1 - geo.padL))); drawSim(); return; }
    if (!g.axis) { if (Math.hypot(dx, dy) < 6) return; g.axis = Math.abs(dx) > Math.abs(dy) ? 'time' : 'price'; v.axis = g.axis; }
    if (g.ruler) { if (g.axis === 'price') setPrice(priceAt(y)); else setU(uAt(x)); }
    else if (g.axis === 'price') setPrice(g.S - dy / (geo.yBot - geo.padT) * (geo.hi - geo.lo));
    else setU(g.u + dx / (geo.x1 - geo.xs) * (geo.u1 - geo.u0));
    drawSim();
  });
  const end = e => {
    pts.delete(e.pointerId);
    const v = state.simView;
    if (!v || !v.dragging || (v.axis === 'pinch' && pts.size)) return;
    const was = v.axis;
    v.dragging = false; v.axis = null; g = null; pts.clear();
    if (was === 'split' || was === 'pinch') drawSim(); else refit(v.edge);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  // a resize or a phone turning sideways repaints at the new width
  window.addEventListener?.('resize', () => { if (state.simState) drawSim(); });
  canvas.addEventListener('wheel', e => { if (!e.ctrlKey || !state.simView) return; e.preventDefault(); setBars(state.simBars * Math.exp(e.deltaY * 0.01)); }, { passive: false });
  canvas.addEventListener('keydown', e => {
    const v = state.simView;
    const step = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, 0.05], ArrowDown: [0, -0.05] }[e.key];
    if (!v || !step) return;
    e.preventDefault(); v.touched = true;
    if (step[0]) v.t = clampT(momentAt(v.sessions, Math.max(v.uNow, minuteOf(v.sessions, v.t) + step[0])));
    if (step[1]) v.S = Math.max(0.05, Math.round((v.S + step[1]) * 100) / 100);
    refit();
  });
}

/**
 * The contract's value with the stock at S from the quote's moment to expiry (81 points, the nearest expiry for a
 * calendar), at the quoted mark where the quote stands: the model the sheet prices with, for checks and tests.
 */
export function simCurve(S) {
  const o = state.simState;
  const exp = expiryCloseMs(o.expStr), now = o.asOf ?? Date.now(), total = Math.max(exp - now, 3600 * 1000);
  const pts = [];
  for (let i = 0; i <= 80; i++) {
    const t = now + total * i / 80;
    pts.push({ t, v: i === 0 && S === o.spot && o.mark != null ? o.mark : contractValue(o, S, t) });
  }
  return pts;
}

export function simParamsFromCard(d, entry, qty) {
  return {
    isCall: d.isCall, K: d.parsed.strike, expStr: d.parsed.expStr, iv: d.iv, legs: d.legs,
    mark: d.mid, markSource: 'Tradier mid', markAsOf: d.asOf,
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
