// The trade page's charts (#jtChart5, #jtChartD), drawn by Lightweight Charts (vendor/lightweight-charts.js, loaded the first
// time one is drawn, through effects.loadChartLibrary; state.chartLib): candles, 8 EMA, the session VWAP on the intraday
// chart (teal: blue is the entry line and the buys), volume, each fill as an arrow (buys blue under the bar, sells amber
// over it) and price lines. The library pans (drag, sideways swipe) and pinches on touch; a
// plain vertical scroll or swipe is left to the page, and ctrl/cmd+scroll or a trackpad pinch zooms around the cursor here.
// The legend over the top-left (like TradeZella's) shows the hovered bar, else the latest: OHLC and the change from the bar
// before, volume, the 8 EMA and VWAP.
import { marketEscape as esc } from '../core/format.js';
import { chartSeries, compactVolume } from '../core/trade-page.js';
import { SANS_FONT } from '../lib/media.js';
import { state } from '../state.js';
import { effects } from './effects.js';

/** the library, loaded once; a failed load is tried again on the next call */
export function loadTradeChartLibrary() {
  if (state.chartLib) return Promise.resolve(state.chartLib);
  if (!state.chartLibLoading) {
    state.chartLibLoading = Promise.resolve().then(() => effects.loadChartLibrary())
      .then(lib => { state.chartLib = lib; return lib; })
      .catch(e => { state.chartLibLoading = null; throw e; });
  }
  return state.chartLibLoading;
}

// canvases can't read CSS variables: the colors come from the stylesheet when a chart is made
const cssColor = (/** @type {string} */ n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fade = (/** @type {string} */ hex, /** @type {number} */ a) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/** zoom the time scale by f (> 1 = out) around the bar under clientX, keeping at least 10 bars */
function zoomAt(h, clientX, f) {
  const ts = h.chart.timeScale(), r = ts.getVisibleLogicalRange();
  if (!r || !(f > 0) || ((r.to - r.from) * f < 10 && f < 1)) return;
  const at = ts.coordinateToLogical(clientX - h.el.getBoundingClientRect().left) ?? (r.from + r.to) / 2;
  ts.setVisibleLogicalRange({ from: at - (at - r.from) * f, to: at + (r.to - at) * f });
}

/** the legend for bar i: the hovered one, else the latest */
function legendHtml(h, i) {
  const b = h.bars?.[i];
  if (!b) return '';
  const { green, red, purple, teal } = h.colors;
  const dp = h.digits, f = (/** @type {number} */ v) => v.toFixed(dp);
  const prev = i > 0 ? h.bars[i - 1].close : b.open, chg = b.close - prev, pct = prev ? (chg / prev) * 100 : 0;
  const sign = chg > 0 ? '+' : chg < 0 ? '−' : '', bar = b.close >= b.open ? green : red;
  const v = (/** @type {number} */ x) => `<b style="color:${bar}">${f(x)}</b>`;
  // non-breaking inside each pair, so a narrow chart wraps between them, never between a label and its value
  return `<div><span class="jt-legend-title">${esc(h.title)}</span> O&nbsp;${v(b.open)} H&nbsp;${v(b.high)} L&nbsp;${v(b.low)} C&nbsp;${v(b.close)} <span style="color:${chg >= 0 ? green : red}">${sign}${f(Math.abs(chg))}&nbsp;(${sign}${Math.abs(pct).toFixed(2)}%)</span></div>`
    + `<div>Vol <b>${compactVolume(b.volume || 0)}</b></div>`
    + (h.emaValues[i] !== undefined ? `<div>EMA 8 <b style="color:${purple}">${f(h.emaValues[i])}</b>`
      + (h.vwapValues[i] !== undefined ? ` VWAP <b style="color:${teal}">${f(h.vwapValues[i])}</b>` : '') + '</div>' : '');
}

/**
 * A chart in el (static markup, so its listeners go with the chart: drop removes both). daily: the day axis, no clock times.
 * @param {any} lib @param {HTMLElement} el @param {HTMLElement} legend @param {{ daily: boolean }} o
 */
export function makeTradeChart(lib, el, legend, { daily }) {
  const c = { text: cssColor('--text3'), border: cssColor('--border2'), green: cssColor('--green'), red: cssColor('--red'), purple: cssColor('--purple'), teal: cssColor('--teal') };
  const grid = 'rgba(255,255,255,0.045)';
  const chart = lib.createChart(el, {
    autoSize: true,
    layout: { background: { type: lib.ColorType.Solid, color: 'transparent' }, textColor: c.text, fontFamily: SANS_FONT, fontSize: 10 },
    grid: { vertLines: { color: grid }, horzLines: { color: grid } },
    rightPriceScale: { borderColor: c.border, scaleMargins: { top: 0.16, bottom: 0.22 } }, // the top leaves room for the legend
    timeScale: { borderColor: c.border, timeVisible: !daily, secondsVisible: false },
    crosshair: { mode: lib.CrosshairMode.Normal },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
  });
  const candles = chart.addSeries(lib.CandlestickSeries, { upColor: c.green, downColor: c.red, wickUpColor: c.green, wickDownColor: c.red, borderVisible: false, priceLineVisible: false });
  const ema = chart.addSeries(lib.LineSeries, { color: c.purple, lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
  const volume = chart.addSeries(lib.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
  volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  // VWAP starts over each day: a line segment takes its first point's color, so a day's last bar goes transparent (paintTradeChart)
  const vwap = daily ? null : chart.addSeries(lib.LineSeries, { color: c.teal, lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
  const h = {
    lib, el, chart, candles, ema, vwap, volume, colors: c, markers: lib.createSeriesMarkers(candles, []), lines: [], off: new AbortController(),
    bars: null, emaValues: [], vwapValues: [], rangeKey: null, title: '', digits: 2, legend, showLegend: (/** @type {number} */ i) => { legend.innerHTML = legendHtml(h, i); },
  };

  chart.subscribeCrosshairMove(param => {
    const last = (h.bars?.length || 0) - 1, i = param.time === undefined ? last : Math.round(param.logical);
    h.showLegend(i >= 0 && i <= last ? i : last);
  });
  const signal = h.off.signal;
  el.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return; // a plain scroll moves the page
    e.preventDefault();
    zoomAt(h, e.clientX, Math.exp(e.deltaY * 0.01));
  }, { passive: false, signal });
  // Safari's trackpad pinch comes as gesture events (a touch pinch is the library's own, so those are left alone)
  let touching = false, scale = 1;
  el.addEventListener('touchstart', () => { touching = true; }, { passive: true, signal });
  el.addEventListener('touchend', e => { touching = e.touches.length > 0; }, { passive: true, signal });
  el.addEventListener('gesturestart', e => { if (touching) return; e.preventDefault(); scale = 1; }, { signal });
  el.addEventListener('gesturechange', e => {
    if (touching) return;
    e.preventDefault();
    zoomAt(h, e.clientX, scale / e.scale);
    scale = e.scale;
  }, { signal });
  return h;
}

/**
 * Draw bars on a chart. New bars, or a new rangeKey, set the view (range: { start, end } bar indexes, else the whole set);
 * the markers and lines are replaced every time, so a redraw never stacks them. iv: the intraday interval the fills are
 * placed by (0 = daily); title: the legend's name; log: a logarithmic price scale.
 * @param {any} h @param {any[]} bars
 * @param {{ fills: any[], lines: { price: number, color: string, title: string }[], range?: { start: number, end: number } | null,
 *   rangeKey?: string, iv?: number, title?: string, log?: boolean }} o
 */
export function paintTradeChart(h, bars, { fills, lines, range = null, rangeKey = '', iv = 5, title = '', log = false }) {
  const s = chartSeries(bars, fills, iv || 5), { lib, colors } = h;
  const fresh = h.bars !== bars;
  if (fresh) {
    const last = bars[bars.length - 1]?.close || 0;
    h.digits = last && last < 1 ? 4 : 2;
    h.candles.applyOptions({ priceFormat: { type: 'price', precision: h.digits, minMove: h.digits === 4 ? 0.0001 : 0.01 } });
    h.candles.setData(s.candles);
    h.ema.setData(s.ema);
    h.vwap?.setData(s.vwap.map(v => v.end ? { time: v.time, value: v.value, color: 'transparent' } : { time: v.time, value: v.value }));
    h.volume.setData(s.volume.map(v => ({ time: v.time, value: v.value, color: fade(v.up ? colors.green : colors.red, 0.35) })));
    h.bars = bars;
  }
  if (fresh || rangeKey !== h.rangeKey) {
    if (range) h.chart.timeScale().setVisibleLogicalRange({ from: range.start, to: range.end - 1 });
    else h.chart.timeScale().fitContent();
    h.rangeKey = rangeKey;
  }
  h.emaValues = s.ema.map(e => e.value);
  h.vwapValues = h.vwap ? s.vwap.map(v => v.value) : [];
  h.chart.priceScale('right').applyOptions({ mode: log ? 1 : 0 }); // 1 = PriceScaleMode.Logarithmic
  h.title = title;
  h.showLegend(bars.length - 1);
  const blue = cssColor('--blue'), amber = cssColor('--amber');
  h.markers.setMarkers(s.markers.map(m => m.side === 'buy'
    ? { time: m.time, position: 'belowBar', shape: 'arrowUp', color: blue, text: String(m.qty) }
    : { time: m.time, position: 'aboveBar', shape: 'arrowDown', color: amber, text: String(m.qty) }));
  for (const l of h.lines) h.candles.removePriceLine(l);
  h.lines = lines.filter(l => l.price > 0).map(l => h.candles.createPriceLine({
    price: l.price, color: l.color, title: l.title, lineWidth: 1, lineStyle: lib.LineStyle.Dashed, axisLabelVisible: true,
  }));
}

/** let a chart go, with its listeners */
export function dropTradeChart(h) {
  if (!h) return;
  h.off.abort();
  h.chart.remove();
}
