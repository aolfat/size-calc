// Position chart: one Schwab position's chart with its average cost, stops and targets drawn on it: a stock or ETF's daily
// (Tradier history), an option's own 5-minute bars (Tradier timesales). And the profit-target form: tap the chart (or type)
// for the price, pick a portion, review it in the position sheet.
import { store } from '../lib/store.js';
import { state } from '../state.js';
import { clampView, viewRange } from '../core/chart-view.js';
import { fmt$, marketEscape as esc } from '../core/format.js';
import { optionPriceTick, priceTick } from '../core/orders.js';
import { fmtPositionPrice, positionLevels, targetGain, targetPlan, targetRoom, tradierSymbol } from '../core/positions.js';
import { schwabStopDuration } from '../services/schwab.js';
import { dailyHistory } from '../services/tradier.js';
import { attachCandleGestures, candleGeom, ohlcText, paintCandles, snapToBar } from './candles.js';
import { fetchFiveMinuteBars } from './chart.js';
import { renderPositions } from './positions.js';

export const PORTIONS = [[0.25, '¼'], [1 / 3, '⅓'], [0.5, '½'], [1, 'All']];
// range chips: sessions of daily bars for a stock, sessions of 5-minute bars for an option
const DAILY_CHIPS = [[21, '1M'], [63, '3M'], [126, '6M'], [252, '1Y']];
const OPTION_CHIPS = [[1, '1D'], [2, '2D'], [5, '5D'], [10, '10D']];
const units = (option, n) => `${n.toLocaleString('en-US')} ${option ? (n === 1 ? 'contract' : 'contracts') : (n === 1 ? 'share' : 'shares')}`;

/** the bars in the last n sessions: a thin contract trades fewer than 78 a day */
function sessionBars(bars, n) {
  const days = [...new Set(bars.map(b => b.date))].slice(-n);
  return bars.filter(b => days.includes(b.date)).length;
}

// what a range chip shows: n sessions back from now
const rangeView = c => ({ count: c.option ? Math.max(1, sessionBars(c.bars, c.range)) : c.range, offset: 0 });

/** the open chart's position in the last Schwab read, or null */
function chartRow() {
  const c = state.posChart, p = state.positions;
  return c && p ? p.rows.find(r => r.symbol === c.symbol) || null : null;
}

/** the Chart button on a row: opens that position's chart, or closes it when it's the one showing */
export function togglePositionChart(symbol) {
  if (state.posChart && state.posChart.symbol === symbol) { closePositionChart(); return; }
  const row = state.positions && state.positions.rows.find(r => r.symbol === symbol);
  const option = !!(row && row.tradeAs === 'OPTION');
  const range = option ? 2 : state.dailyRange;
  const c = { symbol, option, label: row ? row.label : symbol, bars: [], view: { count: range, offset: 0 }, range, loading: false, error: '', hover: -1, hoverY: -1, price: null, qty: null };
  state.posChart = c;
  setTargetInputs();
  renderPositions(); // the button lights, and the chart renders with the table
  document.getElementById('posChartSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  loadBars(c);
}

export function closePositionChart() {
  state.posChart = null;
  renderPositions();
}

async function loadBars(c) {
  if (!document.getElementById('apiKey').value.trim()) { c.error = 'The chart needs a Tradier key: add one in Settings. You can still type a target below.'; renderPositionChart(); return; }
  c.loading = true;
  renderPositionChart();
  try {
    c.bars = c.option
      ? (await fetchFiveMinuteBars(tradierSymbol(c.symbol))).map(b => ({ date: (b.t || '').slice(0, 10), time: (b.t || '').slice(11, 16), open: b.o, high: b.h, low: b.l, close: b.c }))
      : await dailyHistory(c.symbol);
    c.error = c.bars.length ? '' : c.option ? `Tradier shows no trades in ${c.label} in the last two weeks.` : `Tradier has no daily history for ${c.symbol}.`;
  } catch(e) {
    c.error = c.option ? 'Tradier would not send this contract\'s 5-minute bars. They need a brokerage-linked key.' : 'Could not load the daily chart from Tradier.';
  }
  c.view = rangeView(c);
  c.loading = false;
  if (state.posChart === c) renderPositionChart();
}

function setTargetInputs() {
  const c = state.posChart;
  document.getElementById('posTargetPrice').value = c && c.price > 0 ? c.price.toFixed(c.price >= 1 || c.option ? 2 : 4) : '';
  document.getElementById('posTargetQty').value = c && c.qty >= 1 ? String(c.qty) : '';
}

/** typing in the price or share count; the inputs keep what was typed */
export function posTargetChanged() {
  const c = state.posChart;
  if (!c) return;
  const price = parseFloat(document.getElementById('posTargetPrice').value);
  const qty = Number(document.getElementById('posTargetQty').value);
  c.price = price > 0 ? price : null;
  c.qty = qty > 0 ? qty : null;
  renderPositionChart();
}

/** a portion chip: that share of the position, at least one share, never more than the targets already leave */
export function setPosTargetPortion(fraction) {
  const c = state.posChart, row = chartRow();
  if (!c || !row) return;
  const room = targetRoom(row);
  if (!(room.free > 0)) return;
  c.qty = portionQty(room, fraction);
  setTargetInputs();
  renderPositionChart();
}

const portionQty = (room, fraction) => fraction >= 1 ? room.free : Math.min(room.free, Math.max(1, Math.floor(room.held * fraction)));

/** a target price picked on the chart */
function pickTarget(price) {
  const c = state.posChart;
  if (!c || !(price > 0)) return;
  c.price = c.option ? optionPriceTick(price) : priceTick(price);
  setTargetInputs();
  renderPositionChart();
}

/** after Schwab shows the target: the form clears, and the chart draws it from Schwab's orders */
export function positionTargetPlaced(symbol) {
  const c = state.posChart;
  if (!c || c.symbol !== symbol) return;
  c.price = null;
  c.qty = null;
  setTargetInputs();
  renderPositionChart();
}

/** Avg: shows or hides your average cost, and the scale fits without it while hidden */
export function togglePosChartAvg() {
  state.posChartAvg = !state.posChartAvg;
  store.set('pos_chart_avg', state.posChartAvg ? '1' : '0');
  drawPositionChart();
}

export function setPosChartRange(count) {
  const c = state.posChart;
  if (!c) return;
  c.range = count;
  c.view = rangeView(c); // tapping the lit chip again is the reset
  drawPositionChart();
}

export function posChartToday() {
  const c = state.posChart;
  if (!c) return;
  c.view = { count: c.view.count, offset: 0 };
  drawPositionChart();
}

/** what the form says under the inputs, and whether the target can go to review */
function targetStatus(c, row) {
  const p = state.positions;
  if (!p) return { text: state.positionsBusy ? 'Reading Schwab…' : 'Positions are not loaded.', ok: false };
  if (!row) return { text: `Schwab no longer shows a ${c.symbol} position.`, ok: false, warn: true };
  if (p.stopsMissing) return { text: 'Stops unavailable: Schwab did not return this account\'s orders. Try again in a moment.', ok: false, warn: true };
  const verb = row.qty > 0 ? 'sell' : 'buy back', px = p => fmtPositionPrice(p, row.tradeAs);
  if (!(c.price > 0) && !(c.qty > 0)) return { text: `Tap the chart for a target price, then pick how much to ${verb}.`, ok: false };
  if (!(c.price > 0)) return { text: 'Tap the chart or type a target price.', ok: false };
  if (!(c.qty > 0)) return { text: `Pick how much to ${verb}: a portion or a share count.`, ok: false };
  const plan = targetPlan(row, { price: c.price, qty: c.qty, duration: schwabStopDuration() });
  if (plan.error) return { text: plan.error, ok: false, warn: true };
  const held = Math.abs(row.qty), g = targetGain(row, plan.price, c.qty);
  const gain = g.gain === null ? '' : ` · <span class="${g.gain >= 0 ? 'pos-locked' : 'pos-loss'}">${g.gain >= 0 ? '+' : '−'}${fmt$(Math.abs(g.gain))}</span> (${g.pct >= 0 ? '+' : '−'}${Math.abs(g.pct).toFixed(1)}%) over cost${g.r === null ? '' : ` · ${g.r.toFixed(1)}R`}`;
  const stop = plan.stop > 0 ? `Paired with a stop at ${px(plan.stop)} for the same ${c.option ? 'contracts' : 'shares'}: one cancels the other.` : 'This position has no stop, so the target goes alone.';
  return { text: `<strong>${row.qty > 0 ? 'Sells' : 'Buys back'} ${c.qty.toLocaleString('en-US')} of ${units(c.option, held)} at ${px(plan.price)}</strong>${gain}<span class="shares-detail">${esc(stop)}</span>`, ok: true, html: true };
}

export function renderPositionChart() {
  const c = state.posChart, open = !!c && state.positionsView;
  document.getElementById('posChartSection').style.display = open ? '' : 'none';
  document.getElementById('positionsSplit').classList.toggle('open', open);
  if (!c) return;
  const row = chartRow();
  document.getElementById('posChartTitle').textContent = c.label;
  document.getElementById('posChartMeta').textContent = row
    ? `${row.qty > 0 ? 'Long' : 'Short'} ${units(c.option, Math.abs(row.qty))} · avg ${row.avg > 0 ? fmt$(row.avg) : '—'} · now ${fmt$(row.price)}`
    : '';
  document.getElementById('posChartStatus').textContent = c.loading ? `Loading the ${c.label} ${c.option ? '5-minute' : 'daily'} chart…` : c.error;
  document.getElementById('posChartPlot').style.display = c.bars.length ? '' : 'none';
  document.getElementById('posTargetQtyLabel').textContent = `${c.option ? 'Contracts' : 'Shares'} to ${row && row.qty < 0 ? 'buy back' : 'sell'}`;

  const room = row ? targetRoom(row) : null;
  document.getElementById('posTargetPortions').innerHTML = PORTIONS.map(([f, label]) => {
    const qty = room && room.free > 0 ? portionQty(room, f) : 0;
    const on = qty > 0 && c.qty === qty;
    return `<button class="filter-btn${on ? ' active' : ''}" aria-pressed="${on}" data-action="setPosTargetPortion" data-arg="${f}"${qty ? ` title="${units(c.option, qty)}"` : ' disabled'}>${label}</button>`;
  }).join('');

  const status = targetStatus(c, row);
  const sum = document.getElementById('posTargetSummary');
  sum.className = 'pos-target-sum' + (status.warn ? ' warn' : '');
  sum.innerHTML = status.html ? status.text : esc(status.text);
  const review = document.getElementById('posTargetReview');
  review.dataset.arg = c.symbol;
  review.disabled = !status.ok || state.posTradeBusy;
  drawPositionChart();
}

// the levels drawn: your average cost only while Avg is on
const levels = row => row ? positionLevels(row).filter(l => l.kind !== 'avg' || state.posChartAvg) : [];

function chartGeom(w) {
  const c = state.posChart, row = chartRow();
  return candleGeom(c.bars, c.view, w, [...levels(row).map(l => l.price), c.price || 0]);
}

function chartLines(c, row) {
  const css = getComputedStyle(document.documentElement);
  const color = name => css.getPropertyValue(name).trim();
  const size = q => ' ×' + q.toLocaleString('en-US');
  const lines = levels(row).map(l => l.kind === 'avg'
    ? { price: l.price, color: color('--blue'), label: 'avg ' + l.price.toFixed(2), left: true }
    : { price: l.price, color: color(l.kind === 'stop' ? '--red' : '--green'), label: `${l.kind} ${l.price.toFixed(2)}${size(l.qty)}` });
  if (c.price > 0) lines.push({ price: c.price, color: color('--green'), label: `new target ${c.price.toFixed(2)}${c.qty > 0 ? size(c.qty) : ''}`, solid: true });
  return lines;
}

export function drawPositionChart() {
  const c = state.posChart;
  if (!c) return;
  const n = c.bars.length;
  // a chip lights while the view shows exactly its range
  const active = n && Math.round(clampView(c.view, n).count) === Math.round(clampView(rangeView(c), n).count) ? c.range : 0;
  document.getElementById('posChartKind').textContent = c.option ? '5 min' : 'Daily';
  const avg = document.getElementById('posChartAvgBtn');
  avg.classList.toggle('active', state.posChartAvg);
  avg.setAttribute('aria-pressed', String(state.posChartAvg));
  const chips = (c.option ? OPTION_CHIPS : DAILY_CHIPS).map(([count, label]) =>
    `<button class="filter-btn${count === active ? ' active' : ''}" data-action="setPosChartRange" data-arg="${count}">${label}</button>`).join('');
  const ranges = document.getElementById('posChartRanges');
  if (ranges.innerHTML !== chips) ranges.innerHTML = chips; // hover redraws often; the chips rarely change
  document.getElementById('posChartToday').style.display = n && viewRange(c.view, n).end < n ? '' : 'none';
  if (!n) return;
  const canvas = document.getElementById('posChart');
  const w = canvas.clientWidth;
  if (!w) return; // hidden: painting now would wipe the canvas to zero width
  const row = chartRow(), g = chartGeom(w);
  paintCandles(canvas, g, c.bars, { lines: chartLines(c, row), hover: { index: c.hover, y: c.hoverY } });
  const readout = document.getElementById('posChartOhlc');
  const b = c.bars[c.hover];
  if (!b || c.hover < g.start || c.hover >= g.end) { readout.textContent = ''; return; }
  const onPlot = c.hoverY >= g.padT && c.hoverY <= g.h - g.padB;
  const at = g.price(c.hoverY), now = row ? row.price : 0;
  readout.innerHTML = (onPlot && now > 0 ? `$${at.toFixed(2)} (${at >= now ? '+' : '−'}${Math.abs(at / now * 100 - 100).toFixed(1)}% from now) &nbsp; ` : '') + ohlcText(b);
}

export function initPositionChartEvents() {
  const canvas = document.getElementById('posChart');
  const geom = () => chartGeom(canvas.getBoundingClientRect().width);
  // the price under the pointer, or a candle's high or low when it's within a few pixels of one; null off the plot
  const priceAt = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect(), g = geom(), yy = clientY - rect.top;
    if (yy < g.padT || yy > g.h - g.padB) return { index: g.index(clientX - rect.left), price: null, yy };
    const index = g.index(clientX - rect.left);
    return { index, price: snapToBar(g, state.posChart.bars[index], yy), yy };
  };
  attachCandleGestures(canvas, {
    count: () => state.posChart ? state.posChart.bars.length : 0,
    view: () => state.posChart ? state.posChart.view : { count: state.dailyRange, offset: 0 },
    setView: view => { state.posChart.view = view; drawPositionChart(); },
    geom,
    hover: (clientX, clientY) => {
      const c = state.posChart, at = priceAt(clientX, clientY);
      c.hover = at.index;
      c.hoverY = at.price === null ? at.yy : geom().y(at.price);
      drawPositionChart();
    },
    leave: () => {
      if (!state.posChart) return;
      state.posChart.hover = -1;
      state.posChart.hoverY = -1;
      drawPositionChart();
    },
    pick: (clientX, clientY) => pickTarget(priceAt(clientX, clientY).price),
  });
  window.addEventListener('resize', () => { if (state.positionsView) drawPositionChart(); });
}
