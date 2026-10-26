// A missed trade's charts on the day's notebook page (state.missedChart; docs/journal-notebook.md): the ticker's 5 minutes
// that day and its daily chart, the day marked, drawn by Lightweight Charts like the trade page (ui/journal-trade-chart.js).
// The 5 minutes come from the kept bars when the journal has them (another trade in it that day), else straight from
// Tradier (about 40 days back), never saved; the daily from Tradier's year. A focus ticker opened on the same page uses
// them too, its day marked 'focus'. One missed trade or focus ticker is open at a time, so one set of charts: the page's redraw replaces their boxes, and drawMissedChart (after every Journal render) moves each chart
// into its new box with the view you left it on.
import { BARS_KEEP_DAYS, nyDay } from '../core/bars.js';
import { viewRange } from '../core/chart-view.js';
import { marketEscape as esc } from '../core/format.js';
import { dailyWindow, holdChartBars, unpackBars } from '../core/trade-page.js';
import { fetchTradeBars, loadTradeBars, tradierKeyHere } from '../services/bars.js';
import { dailyHistory } from '../services/tradier.js';
import { state } from '../state.js';
import { dropTradeChart, loadTradeChartLibrary, makeTradeChart, paintTradeChart } from './journal-trade-chart.js';
import { renderJournal } from './journal.js';

const BOXES = { 5: { plot: 'nbMissedPlot5', legend: 'nbMissedLegend5' }, D: { plot: 'nbMissedPlotD', legend: 'nbMissedLegendD' } };

/** the charts for a ticker on a day, the day marked with `mark` on the daily: loaded once (opening the same one again keeps them) */
export function loadMissedChart(symbol, day, mark = 'missed') {
  const now = state.missedChart;
  if (now && now.symbol === symbol && now.day === day) { now.mark = mark; return now.loaded; }
  dropMissedChart();
  const p = state.missedChart = { symbol, day, mark, five: [], daily: [], dayIndex: -1, viewD: { count: 63, offset: 0 }, loading5: true, loadingD: true, status5: '', statusD: '', charts: {}, ranges: {}, libWait: false, libError: '', loaded: null };
  const redraw = () => { if (state.missedChart === p) renderJournal(); };
  p.loaded = Promise.all([
    fiveMinute(p).then(() => { p.loading5 = false; redraw(); }),
    daily(p).then(() => { p.loadingD = false; redraw(); }),
  ]);
  return p.loaded;
}

/** the 5 minutes: the kept bars, else Tradier's; regular hours */
async function fiveMinute(p) {
  try {
    let rows = await loadTradeBars(p.symbol, [p.day]).catch(() => []);
    if (!rows.length && tradierKeyHere()) rows = await fetchTradeBars(p.symbol, [p.day]);
    p.five = holdChartBars(unpackBars(rows), []);
    const now = Date.now();
    p.status5 = p.five.length ? '' : !tradierKeyHere() ? `Add a Tradier key in Settings for ${p.symbol}'s 5-minute chart.`
      : p.day < nyDay(now - BARS_KEEP_DAYS * 864e5) ? `No 5-minute bars for ${p.symbol} that day: Tradier keeps about 40 days.`
      : `No 5-minute bars for ${p.symbol} that day yet.`;
  } catch(e) {
    p.status5 = `Couldn't load the 5-minute bars: ${String(e?.message || e)}`;
  }
}

/** the daily: Tradier's year, framed 40 sessions before the day through 10 after */
async function daily(p) {
  if (!tradierKeyHere()) { p.statusD = `Add a Tradier key in Settings for ${p.symbol}'s daily chart.`; return; }
  try {
    p.daily = (await dailyHistory(p.symbol)).map(d => ({ date: d.date, open: +d.open, high: +d.high, low: +d.low, close: +d.close, volume: +d.volume || 0 }));
    const at = `${p.day}T16:00:00Z`;
    p.viewD = dailyWindow(p.daily, { openedAt: at, closedAt: at });
    p.dayIndex = p.daily.findIndex(b => b.date === p.day);
    p.statusD = p.daily.length ? '' : `Tradier has no daily history for ${p.symbol}.`;
  } catch(e) {
    p.statusD = "Couldn't load the daily chart from Tradier.";
  }
}

/** let the charts go (another missed trade opens, or the page closes) */
export function dropMissedChart() {
  const p = state.missedChart;
  if (p) for (const which of Object.keys(p.charts)) dropTradeChart(p.charts[which]);
  state.missedChart = null;
}

/** the charts' boxes inside the open missed trade (the ids are fixed: one is open at a time) */
export function missedChartHtml(symbol, day) {
  const p = state.missedChart?.symbol === symbol && state.missedChart.day === day ? state.missedChart : null;
  const status = which => {
    if (!p) return 'Loading…';
    if (p[`loading${which}`]) return which === '5' ? 'Loading the 5-minute bars…' : 'Loading the daily chart…';
    const own = p[`status${which}`];
    return own || (p.libError ? `Couldn't load the charts: ${p.libError}` : !state.chartLib && (which === '5' ? p.five : p.daily).length ? 'Loading the charts…' : '');
  };
  const shown = which => !!p && !p[`loading${which}`] && !p[`status${which}`] && !p.libError && (which === '5' ? p.five : p.daily).length > 0;
  const box = (which, cap, plot) => `<div class="jt-chart">
      <div class="chart-cap"><span>${cap}</span></div>
      ${status(which) ? `<p class="hint" role="status">${esc(status(which))}</p>` : ''}
      <div class="pos-chart-canvas"${shown(which) ? '' : ' style="display:none;"'}>${plot}</div>
    </div>`;
  return `<div class="jt-charts nb-miss-charts">
    ${box('5', 'The day, 5 minutes', '<div class="jt-plot" id="nbMissedPlot5"></div><div class="jt-legend" id="nbMissedLegend5"></div>')}
    ${box('D', 'Daily', '<div class="jt-plot" id="nbMissedPlotD"></div><div class="jt-legend" id="nbMissedLegendD"></div>')}
    <div class="chart-hint">The day is marked on the daily. <span style="color:var(--purple);">8 EMA</span> · <span style="color:var(--teal);">VWAP</span>. Pinch or ctrl+scroll to zoom, drag to pan.</div>
  </div>`;
}

/** a few empty bars past the last one, so the day's mark never sits under the price axis (a missed trade from today) */
const roomRight = (r, n) => r.end >= n - 2 ? { start: r.start, end: r.end + 3 } : r;

/** after the page renders: each chart in its box (made again in a new one, on the view you left), or let go without one */
export function drawMissedChart() {
  const p = state.missedChart;
  if (!p) return;
  const has = which => (which === '5' ? p.five : p.daily).length > 0;
  if (!state.chartLib) {
    if ((has('5') || has('D')) && !p.libWait && !p.libError && document.getElementById(BOXES[5].plot)) {
      p.libWait = true;
      loadTradeChartLibrary().then(() => { if (state.missedChart === p) renderJournal(); },
        e => { p.libError = String(e?.message || e); if (state.missedChart === p) renderJournal(); });
    }
    return;
  }
  for (const which of /** @type {const} */ (['5', 'D'])) {
    const el = document.getElementById(BOXES[which].plot), legend = document.getElementById(BOXES[which].legend);
    let h = p.charts[which];
    if (h && h.el !== el) {
      const r = h.chart.timeScale().getVisibleLogicalRange?.();
      if (r) p.ranges[which] = { start: r.from, end: r.to + 1 };
      dropTradeChart(h);
      h = null;
      delete p.charts[which];
    }
    if (!el || !has(which) || p.libError) continue;
    h = p.charts[which] ||= makeTradeChart(state.chartLib, el, legend, { daily: which === 'D' });
    const five = which === '5', bars = five ? p.five : p.daily;
    paintTradeChart(h, bars, {
      fills: [], lines: [], iv: five ? 5 : 0, rangeKey: which, title: `${p.symbol} · ${five ? '5m' : '1D'}`,
      range: p.ranges[which] || (five ? null : roomRight(viewRange(p.viewD, bars.length), bars.length)),
      marks: !five && p.dayIndex >= 0 ? [{ index: p.dayIndex, text: p.mark }] : [],
    });
  }
}
