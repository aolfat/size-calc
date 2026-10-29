// Position chart: one Schwab position's charts with its average cost, stops and targets drawn on them: today's 5-minute bars
// (Tradier timesales, with VWAP and the prior day's high, low and close) beside its daily (Tradier history); an option's are the
// contract's own. And the profit-target form: tap either chart (or type it, or
// set it in R) for the price, pick a portion, review it in the position sheet. Or Stop: tap (or type) the stop, see what it covers and risks,
// review it in the position sheet. Or Move breakeven: tap where you want the stop, and it says how many to add so your average
// cost lands there (a calculator; nothing goes to Schwab).
import { store } from '../lib/store.js';
import { state } from '../state.js';
import { clampView, viewRange } from '../core/chart-view.js';
import { fmt$, marketEscape as esc, nyDateStr } from '../core/format.js';
import { optionPriceTick, priceTick } from '../core/orders.js';
import { breakevenAdd, closersInTheWay, fmtPositionPrice, positionLevels, rTargetPrice, stopLocked, stopPlan, targetGain, targetPlan, targetRoom, tradierSymbol } from '../core/positions.js';
import { sessionVwap } from '../core/trade-page.js';
import { schwabStopDuration } from '../services/schwab.js';
import { dailyHistory } from '../services/tradier.js';
import { attachCandleGestures, candleGeom, ohlcText, paintCandles, snapToBar } from './candles.js';
import { fetchFiveMinuteBars } from './chart.js';
import { positionRUnit, renderPositions, rUnitWords } from './positions.js';
import { maxLossPerTrade } from './risk.js';

export const PORTIONS = [[0.1, '10%'], [0.25, '¼'], [1 / 3, '⅓'], [0.5, '½'], [1, 'All']];
// target chips in R: that many times the risk per share above your cost (below on a short); ✎ makes them your own (r_presets)
const R_DEFAULT = [1, 2, 3, 5];
const R_MAX = 5;
// range chips on the daily, in sessions (the 5-minute pane is the latest session only)
const DAILY_CHIPS = [[21, '1M'], [63, '3M'], [126, '6M'], [252, '1Y']];
const units = (option, n) => `${n.toLocaleString('en-US')} ${option ? (n === 1 ? 'contract' : 'contracts') : (n === 1 ? 'share' : 'shares')}`;

/** your R chips, smallest first: the chart's target and the close ticket share them */
export function rPresets() {
  try {
    const a = JSON.parse(store.get('r_presets') || '[]');
    if (Array.isArray(a) && a.length && a.every(v => v > 0)) return a;
  } catch (e) {}
  return R_DEFAULT;
}

/** an R chip row: chip(r) for each preset, or while ✎ is on a box each (blank deletes it) and a '+' box; the ✎ / ✓ chip last */
export function rChipRow(chip) {
  const draft = state.rEdit;
  const body = draft
    ? draft.map((v, i) => `<input type="number" class="usd-edit-box r-edit-box" value="${esc(v)}"${i === draft.length - 1 ? ' placeholder="+"' : ''} min="0" step="0.1" inputmode="decimal" aria-label="R preset" data-input="setRPreset" data-arg="${i}" data-enter="toggleREdit" />`).join('')
    : rPresets().map(chip).join('');
  return body + `<button class="filter-btn${draft ? ' active' : ''}" aria-pressed="${!!draft}" data-action="toggleREdit" title="${draft ? 'Save the R presets' : 'Edit the R presets'}">${draft ? '✓' : '✎'}</button>`;
}

/** typing in an R preset box; the box keeps what was typed, the ✓ saves it */
export function setRPreset(i, value) {
  const draft = state.rEdit;
  if (!draft || !(i >= 0 && i < draft.length)) return;
  draft[i] = value;
}

/** ✎ turns the R chips into boxes; ✓ keeps the positive ones (deduped, smallest first, at most R_MAX) and leaves the old ones if none */
export function rEditToggled() {
  if (state.rEdit) {
    const vals = [...new Set(state.rEdit.map(v => Math.round(parseFloat(v) * 100) / 100).filter(v => v > 0))].sort((a, b) => a - b).slice(0, R_MAX);
    if (vals.length) store.set('r_presets', JSON.stringify(vals));
    state.rEdit = null;
  } else state.rEdit = [...rPresets().map(String), ''];
}

/** the latest session's bars: today's once the market has traded, else the last day the symbol traded */
export function latestSession(bars) {
  const day = bars.length ? bars[bars.length - 1].date : '';
  return bars.filter(b => b.date === day);
}

/** what the 5-minute pane's caption calls its session: 'today', or the day it is from ('Fri 10/24') */
export function sessionWords(date, today = nyDateStr(new Date())) {
  if (!date || date === today) return 'today';
  const d = new Date(date + 'T12:00:00Z');
  return `${d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

// the two panes, 5-minute first (left when they sit side by side, on top when stacked), and their elements' id suffixes
const PANES = ['five', 'daily'];
const SUFFIX = { five: '5', daily: 'D' };

// a pane: one timeframe's bars, VWAP (5-minute only), view, range chip (daily only), hover and load state
function newPane(kind) {
  const range = kind === 'five' ? 0 : state.dailyRange; // the daily starts at the daily_range preference
  return { kind, bars: [], vwap: [], view: { count: range, offset: 0 }, range, loading: false, error: '', hover: -1, hoverY: -1 };
}

// the pane's whole view: the whole session on the 5-minute, the range chip's sessions back from now on the daily
const rangeView = p => ({ count: p.kind === 'five' ? Math.max(1, p.bars.length) : p.range, offset: 0 });

/** the open chart's position in the last Schwab read, or null */
function chartRow() {
  const c = state.posChart, p = state.positions;
  return c && p ? p.rows.find(r => r.symbol === c.symbol) || null : null;
}

/** the Chart button on a row: opens that position's chart, or closes it when it's the one showing */
export function togglePositionChart(symbol) {
  if (state.posChart && state.posChart.symbol === symbol) { closePositionChart(); return; }
  const row = state.positions && state.positions.rows.find(r => r.symbol === symbol);
  const c = { symbol, option: !!(row && row.tradeAs === 'OPTION'), label: row ? row.label : symbol, five: newPane('five'), daily: newPane('daily'), error: '', price: null, r: null, qty: null, stop: null, addStop: null, addPrice: null };
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

function loadBars(c) {
  if (!document.getElementById('apiKey').value.trim()) { c.error = 'The chart needs a Tradier key: add one in Settings. You can still type a target below.'; renderPositionChart(); return; }
  for (const kind of PANES) c[kind].loading = true;
  renderPositionChart();
  for (const kind of PANES) loadPane(c, kind); // both at once, each drawn when it lands
}

async function loadPane(c, kind) {
  const five = kind === 'five', sym = tradierSymbol(c.symbol);
  let bars = [], error = '';
  try {
    bars = five
      ? latestSession((await fetchFiveMinuteBars(sym)).map(b => ({ date: (b.t || '').slice(0, 10), time: (b.t || '').slice(11, 16), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0 })))
      : await dailyHistory(sym);
    error = bars.length ? '' : c.option ? (five ? `Tradier shows no trades in ${c.label} in the last two weeks.` : `Tradier has no daily history for ${c.label}.`)
      : five ? `Tradier shows no 5-minute bars for ${c.symbol} in the last two weeks.` : `Tradier has no daily history for ${c.symbol}.`;
  } catch(e) {
    error = five ? `Tradier would not send ${c.option ? 'this contract' : c.symbol}'s 5-minute bars. They need a brokerage-linked key.` : 'Could not load the daily chart from Tradier.';
  }
  if (state.posChart !== c) return; // closed while it loaded
  const p = c[kind];
  Object.assign(p, { bars, error, loading: false, vwap: five ? sessionVwap(bars) : [] });
  p.view = rangeView(p);
  renderPositionChart();
}

const priceText = (c, p) => c && p > 0 ? p.toFixed(p >= 1 || c.option ? 2 : 4) : '';

/** 1R in the position's own price, or null with why */
const unitFor = row => row ? positionRUnit(row) : { per: null, why: '' };

/** the target's R: what was typed or picked, else the target price counted in R */
function rText(c) {
  if (!c) return '';
  if (c.r > 0) return String(c.r);
  const row = chartRow(), per = row && c.price > 0 ? unitFor(row).per : null;
  const g = per ? targetGain(row, c.price, 1, per) : null;
  return g && g.r !== null && g.r > 0 ? g.r.toFixed(1) : '';
}

function setTargetInputs() {
  const c = state.posChart;
  document.getElementById('posTargetPrice').value = priceText(c, c && c.price);
  document.getElementById('posTargetR').value = rText(c);
  document.getElementById('posTargetQty').value = c && c.qty >= 1 ? String(c.qty) : '';
  document.getElementById('posAddStop').value = priceText(c, c && c.addStop);
  document.getElementById('posAddPrice').value = priceText(c, c && c.addPrice);
  document.getElementById('posChartStopPrice').value = priceText(c, c && c.stop);
}

/** typing in the stop price; the input keeps what was typed */
export function posChartStopChanged() {
  const c = state.posChart;
  if (!c) return;
  const stop = parseFloat(document.getElementById('posChartStopPrice').value);
  c.stop = stop > 0 ? stop : null;
  renderPositionChart();
}

/** typing in the price or share count; the inputs keep what was typed */
export function posTargetChanged() {
  const c = state.posChart;
  if (!c) return;
  const price = parseFloat(document.getElementById('posTargetPrice').value);
  const qty = Number(document.getElementById('posTargetQty').value);
  c.price = price > 0 ? price : null;
  c.qty = qty > 0 ? qty : null;
  c.r = null; // a typed price is a price; the R box follows it
  document.getElementById('posTargetR').value = rText(c);
  renderPositionChart();
}

/** typing the target in R: the price follows, on the order grid; the input keeps what was typed */
export function posTargetRChanged() {
  const c = state.posChart, row = chartRow();
  if (!c) return;
  const r = parseFloat(document.getElementById('posTargetR').value);
  c.r = r > 0 ? r : null;
  const per = row ? unitFor(row).per : null;
  if (c.r && per) c.price = rTargetPrice(row, c.r, per) || null;
  document.getElementById('posTargetPrice').value = priceText(c, c.price);
  renderPositionChart();
}

/** an R chip: the target at that many R from your cost */
export function setPosTargetR(r) {
  const c = state.posChart, row = chartRow(), per = row ? unitFor(row).per : null;
  if (!c || !per || !(r > 0)) return;
  c.r = r;
  c.price = rTargetPrice(row, r, per) || null;
  setTargetInputs();
  renderPositionChart();
}

/** Profit target | Stop | Move breakeven: which form shows, and what a tap on the chart sets */
export function setPosChartTool(tool) {
  state.posChartTool = tool === 'add' || tool === 'stop' ? tool : 'target';
  renderPositionChart();
}

/** typing the stop or the add price; blank add price = the mark */
export function posAddChanged() {
  const c = state.posChart;
  if (!c) return;
  const stop = parseFloat(document.getElementById('posAddStop').value), price = parseFloat(document.getElementById('posAddPrice').value);
  c.addStop = stop > 0 ? stop : null;
  c.addPrice = price > 0 ? price : null;
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

/** a price picked on the chart: the target, the stop, or Move breakeven's stop */
function pickTarget(price) {
  const c = state.posChart;
  if (!c || !(price > 0)) return;
  const ticked = c.option ? optionPriceTick(price) : priceTick(price);
  if (state.posChartTool === 'add') c.addStop = ticked; else if (state.posChartTool === 'stop') c.stop = ticked; else { c.price = ticked; c.r = null; }
  setTargetInputs();
  renderPositionChart();
}

/** after Schwab shows the target: the form clears, and the chart draws it from Schwab's orders */
export function positionTargetPlaced(symbol) {
  const c = state.posChart;
  if (!c || c.symbol !== symbol) return;
  c.price = null;
  c.r = null;
  c.qty = null;
  setTargetInputs();
  renderPositionChart();
}

/** after Schwab shows the stop: the stop form clears, and the chart draws it from Schwab's orders */
export function positionStopPlaced(symbol) {
  const c = state.posChart;
  if (!c || c.symbol !== symbol) return;
  c.stop = null;
  setTargetInputs();
  renderPositionChart();
}

/** Avg: shows or hides your average cost, and the scale fits without it while hidden */
export function togglePosChartAvg() {
  state.posChartAvg = !state.posChartAvg;
  store.set('pos_chart_avg', state.posChartAvg ? '1' : '0');
  drawPositionChart();
}

/** a range chip on the daily */
export function setPosChartRange(count) {
  const p = state.posChart && state.posChart.daily;
  if (!p) return;
  p.range = count;
  p.view = rangeView(p); // tapping the lit chip again is the reset
  drawPositionChart();
}

export function posChartToday(kind) {
  const p = state.posChart && state.posChart[kind === 'daily' ? 'daily' : 'five'];
  if (!p) return;
  p.view = { count: p.view.count, offset: 0 };
  drawPositionChart();
}

/** what the form says under the inputs, and whether the target can go to review */
function targetStatus(c, row) {
  const p = state.positions;
  if (!p) return { text: state.positionsBusy ? 'Reading Schwab…' : 'Positions are not loaded.', ok: false };
  if (!row) return { text: `Schwab no longer shows a ${c.symbol} position.`, ok: false, warn: true };
  if (p.stopsMissing) return { text: 'Stops unavailable: Schwab did not return this account\'s orders. Try again in a moment.', ok: false, warn: true };
  const verb = row.qty > 0 ? 'sell' : 'buy back', px = p => fmtPositionPrice(p, row.tradeAs);
  if (c.r > 0 && !unitFor(row).per) return { text: `No target in R: ${unitFor(row).why || 'no risk to count R from.'}`, ok: false, warn: true };
  if (!(c.price > 0) && !(c.qty > 0)) return { text: `Tap the chart for a target price, then pick how much to ${verb}.`, ok: false };
  if (!(c.price > 0)) return { text: 'Tap the chart or type a target price.', ok: false };
  if (!(c.qty > 0)) return { text: `Pick how much to ${verb}: a portion or a share count.`, ok: false };
  const plan = targetPlan(row, { price: c.price, qty: c.qty, duration: schwabStopDuration() });
  if (plan.error) return { text: plan.error, ok: false, warn: true };
  const held = Math.abs(row.qty), unit = unitFor(row), g = targetGain(row, plan.price, c.qty, unit.per);
  const gain = g.gain === null ? '' : ` · <span class="${g.gain >= 0 ? 'pos-locked' : 'pos-loss'}">${g.gain >= 0 ? '+' : '−'}${fmt$(Math.abs(g.gain))}</span> (${g.pct >= 0 ? '+' : '−'}${Math.abs(g.pct).toFixed(1)}%) over cost${g.r === null ? '' : ` · ${g.r.toFixed(1)}R`}`;
  const stop = plan.stop > 0 ? `Paired with a stop at ${px(plan.stop)} for the same ${c.option ? 'contracts' : 'shares'}: one cancels the other.` : 'This position has no stop, so the target goes alone.';
  const per = unit.per ? ` 1R is ${fmt$(unit.per)} a ${c.option ? 'contract' : 'share'}, from ${rUnitWords(unit, row)}.` : '';
  return { text: `<strong>${row.qty > 0 ? 'Sells' : 'Buys back'} ${c.qty.toLocaleString('en-US')} of ${units(c.option, held)} at ${px(plan.price)}</strong>${gain}<span class="shares-detail">${esc(stop + per)}</span>`, ok: true, html: true };
}

/** what the stop form says under its input, and whether the stop can go to review: what it covers and risks, checked like the review */
function stopStatus(c, row) {
  const p = state.positions;
  if (!p) return { text: state.positionsBusy ? 'Reading Schwab…' : 'Positions are not loaded.', ok: false };
  if (!row) return { text: `Schwab no longer shows a ${c.symbol} position.`, ok: false, warn: true };
  if (p.stopsMissing) return { text: 'Stops unavailable: Schwab did not return this account\'s orders. Try again in a moment.', ok: false, warn: true };
  if (!(c.stop > 0)) return { text: `Tap the chart ${row.qty > 0 ? 'below' : 'above'} the price, or type a stop.`, ok: false };
  const plans = ['pair', 'keep', 'cancel'].map(limits => stopPlan(row, { stop: c.stop, duration: schwabStopDuration(), limits }));
  const plan = plans.find(x => !x.error);
  if (!plan) return { text: plans[0].error, ok: false, warn: true };
  const px = v => fmtPositionPrice(v, row.tradeAs), held = Math.abs(row.qty);
  const locked = row.avg > 0 ? stopLocked(row, plan.stop) : null, max = maxLossPerTrade();
  const risk = locked === null ? '' : locked < -0.005
    ? ` · <span class="pos-loss">−${fmt$(-locked)}</span>${p.value > 0 ? ` (${(-locked * 100 / p.value).toFixed(2)}% of acct)` : ''} from cost`
    : ` · <span class="pos-locked">+${fmt$(locked)} locked</span>`;
  const notes = [locked !== null && max > 0 && -locked > max + 0.005 ? `More than your max loss per trade, ${fmt$(max)}.` : '',
    closersInTheWay(row).length ? 'Your limit already closes part of it: the review asks what the stop covers.' : ''].filter(Boolean).join(' ');
  return { text: `<strong>Stop at ${px(plan.stop)} for ${units(c.option, held)}</strong>${risk}${notes ? `<span class="shares-detail">${esc(notes)}</span>` : ''}`, ok: true, html: true };
}

/** what Move breakeven says: how many to add, at what, and what the position looks like after */
function addStatus(c, row) {
  const p = state.positions;
  if (!p) return { text: state.positionsBusy ? 'Reading Schwab…' : 'Positions are not loaded.', warn: false };
  if (!row) return { text: `Schwab no longer shows a ${c.symbol} position.`, warn: true };
  const long = row.qty > 0, px = v => fmtPositionPrice(v, row.tradeAs);
  if (!(c.addStop > 0)) return { text: `Tap the chart where you want your stop, between your cost${row.avg > 0 ? ' ' + px(row.avg) : ''} and the price. It works out how many to add so your breakeven lands there.`, warn: false };
  const a = breakevenAdd(row, { stop: c.addStop, price: c.addPrice });
  if (a.error) return { text: a.error, warn: true };
  const u = units(c.option, a.qty), all = units(c.option, a.newQty), acct = p.value > 0 ? ` (${(a.value / p.value * 100).toFixed(1)}% of account)` : '';
  const locked = a.locked >= 0.005 ? ` (locks <span class="pos-locked">+${fmt$(a.locked)}</span>)` : '';
  const now = row.risk === null ? '' : ` Your stops risk ${row.risk > 0 ? '−' + fmt$(row.risk) : 'nothing'} now.`;
  return { html: true, text: `<strong>${long ? 'Buy' : (c.option ? 'Sell' : 'Short')} ${u} at ${px(a.price)}${c.addPrice > 0 ? '' : ' (now)'}</strong> · ${fmt$(a.cost)}`
    + ` → ${all}, avg ${fmt$(a.avg)}. A stop at ${px(a.stop)} for all ${a.newQty.toLocaleString('en-US')} then risks nothing${locked}.`
    + `<span class="shares-detail">${esc(`Position ${fmt$(a.value)}${acct} at that price.${now} Once it fills, move your stop to ${px(a.stop)} for every ${c.option ? 'contract' : 'share'}. Fees not counted.`)}</span>` };
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
  // a pane without bars hides, and says why here: still loading, or what Tradier answered
  const notes = c.error ? [c.error] : PANES.filter(k => !c[k].bars.length).map(k => c[k].loading ? `Loading the ${c.label} ${k === 'five' ? '5-minute' : 'daily'} chart…` : c[k].error);
  document.getElementById('posChartStatus').textContent = notes.filter(Boolean).join(' ');
  for (const k of PANES) document.getElementById('posCol' + SUFFIX[k]).style.display = c[k].bars.length ? '' : 'none';
  document.getElementById('posChartPlot').style.display = c.five.bars.length || c.daily.bars.length ? '' : 'none';
  document.getElementById('posTargetQtyLabel').textContent = `${c.option ? 'Contracts' : 'Shares'} to ${row && row.qty < 0 ? 'buy back' : 'sell'}`;

  const room = row ? targetRoom(row) : null;
  document.getElementById('posTargetPortions').innerHTML = PORTIONS.map(([f, label]) => {
    const qty = room && room.free > 0 ? portionQty(room, f) : 0;
    const on = qty > 0 && c.qty === qty;
    return `<button class="filter-btn${on ? ' active' : ''}" aria-pressed="${on}" data-action="setPosTargetPortion" data-arg="${f}"${qty ? ` title="${units(c.option, qty)}"` : ' disabled'}>${label}</button>`;
  }).join('');
  const unit = unitFor(row);
  document.getElementById('posTargetRChips').innerHTML = rChipRow(r => {
    const at = row && unit.per ? rTargetPrice(row, r, unit.per) : 0, on = at > 0 && c.r === r;
    const title = at > 0 ? fmtPositionPrice(at, row.tradeAs) : unit.why || 'No risk to count R from.';
    return `<button class="filter-btn${on ? ' active' : ''}" aria-pressed="${on}" data-action="setPosTargetR" data-arg="${r}" title="${esc(title)}"${at > 0 ? '' : ' disabled'}>${r}R</button>`;
  });

  const tool = state.posChartTool, adding = tool === 'add';
  for (const [id, on] of [['posToolTarget', tool === 'target'], ['posToolStop', tool === 'stop'], ['posToolAdd', adding]]) {
    const b = document.getElementById(id);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  document.getElementById('posTargetForm').style.display = tool === 'target' ? '' : 'none';
  document.getElementById('posStopForm').style.display = tool === 'stop' ? '' : 'none';
  document.getElementById('posAddForm').style.display = adding ? '' : 'none';
  document.getElementById('posChartTapHint').textContent = adding ? 'Tap the chart where you want your stop' : tool === 'stop' ? 'Tap the chart to set the stop' : 'Tap the chart to set the target';
  document.getElementById('posAddPrice').placeholder = row && row.price > 0 ? `now ${row.price.toFixed(2)}` : 'now';
  const add = addStatus(c, row), addSum = document.getElementById('posAddSummary');
  addSum.className = 'pos-target-sum' + (add.warn ? ' warn' : '');
  addSum.innerHTML = add.html ? add.text : esc(add.text);

  const status = targetStatus(c, row);
  const sum = document.getElementById('posTargetSummary');
  sum.className = 'pos-target-sum' + (status.warn ? ' warn' : '');
  sum.innerHTML = status.html ? status.text : esc(status.text);
  const review = document.getElementById('posTargetReview');
  review.dataset.arg = c.symbol;
  review.disabled = !status.ok || state.posTradeBusy;
  const stop = stopStatus(c, row);
  const stopSum = document.getElementById('posStopSummary');
  stopSum.className = 'pos-target-sum' + (stop.warn ? ' warn' : '');
  stopSum.innerHTML = stop.html ? stop.text : esc(stop.text);
  const stopReview = document.getElementById('posStopReview');
  stopReview.dataset.arg = c.symbol;
  stopReview.disabled = !stop.ok || state.posTradeBusy;
  drawPositionChart();
}

// the levels drawn: your average cost only while Avg is on
const levels = row => row ? positionLevels(row).filter(l => l.kind !== 'avg' || state.posChartAvg) : [];

function chartGeom(p, w) {
  const c = state.posChart, row = chartRow();
  const tool = state.posChartTool, add = tool === 'add';
  return candleGeom(p.bars, p.view, w, [...levels(row).map(l => l.price), (add ? c.addStop : tool === 'stop' ? c.stop : c.price) || 0, (add && c.addPrice) || 0]);
}

/** the session before the 5-minute chart's latest, from the daily bars: its high, low and close, or null */
export function priorDay(fiveBars, dailyBars) {
  const last = fiveBars.length ? fiveBars[fiveBars.length - 1].date : '';
  const prev = last ? dailyBars.filter(d => d.date < last).pop() : null;
  return prev ? { h: prev.high, l: prev.low, c: prev.close } : null;
}

function chartLines(c, row) {
  const css = getComputedStyle(document.documentElement);
  const color = name => css.getPropertyValue(name).trim();
  const size = q => ' ×' + q.toLocaleString('en-US');
  const lines = levels(row).map(l => l.kind === 'avg'
    ? { price: l.price, color: color('--blue'), label: 'avg ' + l.price.toFixed(2), left: true }
    : { price: l.price, color: color(l.kind === 'stop' ? '--red' : '--green'), label: `${l.kind} ${l.price.toFixed(2)}${size(l.qty)}` });
  if (state.posChartTool === 'add') {
    const a = row && c.addStop > 0 ? breakevenAdd(row, { stop: c.addStop, price: c.addPrice }) : null;
    if (c.addStop > 0) lines.push({ price: c.addStop, color: color('--red'), label: `BE stop ${c.addStop.toFixed(2)}${a && !a.error ? size(a.newQty) : ''}`, solid: true });
    if (c.addPrice > 0) lines.push({ price: c.addPrice, color: color('--blue'), label: `add ${c.addPrice.toFixed(2)}${a && !a.error ? size(a.qty) : ''}`, solid: true });
  } else if (state.posChartTool === 'stop') {
    if (c.stop > 0) lines.push({ price: c.stop, color: color('--red'), label: `new stop ${c.stop.toFixed(2)}`, solid: true });
  } else if (c.price > 0) lines.push({ price: c.price, color: color('--green'), label: `new target ${c.price.toFixed(2)}${c.qty > 0 ? size(c.qty) : ''}${c.r > 0 ? ` · ${c.r}R` : ''}`, solid: true });
  return lines;
}

// the prior day's levels on the 5-minute chart, faint and drawn only when they fall inside its range
function priorDayLines(c) {
  const pd = priorDay(c.five.bars, c.daily.bars);
  if (!pd) return [];
  const color = getComputedStyle(document.documentElement).getPropertyValue('--text3').trim();
  return [[pd.h, 'PDH'], [pd.l, 'PDL'], [pd.c, 'PDC']].map(([price, label]) => ({ price, color, label, left: true, faint: true }));
}

/** one pane's chips, Today and candles; returns its geometry, or null when it isn't drawn */
function drawPane(c, p, row) {
  const n = p.bars.length, sfx = SUFFIX[p.kind];
  if (p.kind === 'five') document.getElementById('posChartDay5').textContent = n ? sessionWords(p.bars[0].date) : '';
  else {
    // a chip lights while the view shows exactly its range
    const active = n && Math.round(clampView(p.view, n).count) === Math.round(clampView(rangeView(p), n).count) ? p.range : 0;
    const chips = DAILY_CHIPS.map(([count, label]) =>
      `<button class="filter-btn${count === active ? ' active' : ''}" data-action="setPosChartRange" data-arg="${count}">${label}</button>`).join('');
    const ranges = document.getElementById('posChartRangesD');
    if (ranges.innerHTML !== chips) ranges.innerHTML = chips; // hover redraws often; the chips rarely change
  }
  document.getElementById('posChartToday' + sfx).style.display = n && viewRange(p.view, n).end < n ? '' : 'none';
  if (!n) return null;
  const canvas = document.getElementById('posChart' + sfx);
  const w = canvas.clientWidth;
  if (!w) return null; // hidden: painting now would wipe the canvas to zero width
  const g = chartGeom(p, w), five = p.kind === 'five';
  const lines = [...(five ? priorDayLines(c) : []), ...chartLines(c, row)];
  paintCandles(canvas, g, p.bars, { lines, hover: { index: p.hover, y: p.hoverY }, vwap: five ? p.vwap : null });
  return g;
}

export function drawPositionChart() {
  const c = state.posChart;
  if (!c) return;
  const avg = document.getElementById('posChartAvgBtn');
  avg.classList.toggle('active', state.posChartAvg);
  avg.setAttribute('aria-pressed', String(state.posChartAvg));
  const row = chartRow(), geoms = { five: drawPane(c, c.five, row), daily: drawPane(c, c.daily, row) };
  // one readout for both: the hovered pane's bar
  const readout = document.getElementById('posChartOhlc');
  const p = PANES.map(k => c[k]).find(x => x.hover >= 0), g = p && geoms[p.kind];
  const b = p && p.bars[p.hover];
  if (!b || !g || p.hover < g.start || p.hover >= g.end) { readout.textContent = ''; return; }
  const onPlot = p.hoverY >= g.padT && p.hoverY <= g.h - g.padB;
  const at = g.price(p.hoverY), now = row ? row.price : 0;
  // Move breakeven: how many to add for a stop right here
  const add = onPlot && row && state.posChartTool === 'add' ? breakevenAdd(row, { stop: at, price: c.addPrice }) : null;
  const adds = add && !add.error ? ` · add ${add.qty.toLocaleString('en-US')}` : '';
  // Profit target: the price counted in R
  const per = onPlot && row && state.posChartTool === 'target' ? unitFor(row).per : null, gain = per ? targetGain(row, at, 1, per) : null;
  const rs = gain && gain.r !== null ? ` · ${gain.r >= 0 ? '' : '−'}${Math.abs(gain.r).toFixed(1)}R` : '';
  const vw = p.vwap[p.hover] > 0 ? ` &nbsp; VWAP ${p.vwap[p.hover].toFixed(2)}` : '';
  readout.innerHTML = (onPlot && now > 0 ? `$${at.toFixed(2)} (${at >= now ? '+' : '−'}${Math.abs(at / now * 100 - 100).toFixed(1)}% from now)${adds}${rs} &nbsp; ` : '') + ohlcText(b) + vw;
}

export function initPositionChartEvents() {
  for (const kind of PANES) {
    const canvas = document.getElementById('posChart' + SUFFIX[kind]);
    const pane = () => state.posChart ? state.posChart[kind] : null;
    const geom = () => chartGeom(pane(), canvas.getBoundingClientRect().width);
    // the price under the pointer, or a candle's high or low when it's within a few pixels of one; null off the plot
    const priceAt = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect(), g = geom(), yy = clientY - rect.top;
      const index = g.index(clientX - rect.left);
      if (yy < g.padT || yy > g.h - g.padB) return { index, price: null, yy };
      return { index, price: snapToBar(g, pane().bars[index], yy), yy };
    };
    attachCandleGestures(canvas, {
      count: () => pane() ? pane().bars.length : 0,
      view: () => pane() ? pane().view : { count: state.dailyRange, offset: 0 },
      setView: view => { pane().view = view; drawPositionChart(); },
      geom,
      hover: (clientX, clientY) => {
        const p = pane(), at = priceAt(clientX, clientY);
        p.hover = at.index;
        p.hoverY = at.price === null ? at.yy : geom().y(at.price);
        drawPositionChart();
      },
      leave: () => {
        const p = pane();
        if (!p) return;
        p.hover = -1;
        p.hoverY = -1;
        drawPositionChart();
      },
      pick: (clientX, clientY) => pickTarget(priceAt(clientX, clientY).price),
    });
  }
  window.addEventListener('resize', () => { if (state.positionsView) drawPositionChart(); });
}
