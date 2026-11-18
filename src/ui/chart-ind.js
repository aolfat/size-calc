// The Size tab charts' indicator chips: which lines each pane draws (5 min: 8 and 21 EMA, VWAP; daily: 8 and 21 EMA,
// 50, 100 and 200 SMA), a chip over each plot to turn one on or off, and what's off kept on this device.
import { state } from '../state.js';
import { movingAverage } from '../core/indicators.js';
import { store } from '../lib/store.js';
import { drawChart } from './chart.js';
import { drawDailyChart } from './daily.js';

/** @typedef {{ id: string, label: string, color: string, kind?: 'ema' | 'sma', n?: number }} Indicator */

/** @type {Indicator[]} the intraday pane's, in chip order; VWAP resets each session */
export const INTRADAY_IND = [
  { id: 'ema8', label: '8 EMA', color: '--purple', kind: 'ema', n: 8 },
  { id: 'ema21', label: '21 EMA', color: '--amber', kind: 'ema', n: 21 },
  { id: 'vwap', label: 'VWAP', color: '--blue' },
];

/** @type {Indicator[]} the daily pane's, in chip order (the colors the position chart uses where they overlap) */
export const DAILY_IND = [
  { id: 'ema8', label: '8 EMA', color: '--purple', kind: 'ema', n: 8 },
  { id: 'ema21', label: '21 EMA', color: '--amber', kind: 'ema', n: 21 },
  { id: 'sma50', label: '50 SMA', color: '--pink', kind: 'sma', n: 50 },
  { id: 'sma100', label: '100 SMA', color: '--teal', kind: 'sma', n: 100 },
  { id: 'sma200', label: '200 SMA', color: '--text', kind: 'sma', n: 200 },
];

const PANES = {
  intraday: { list: INTRADAY_IND, field: 'chartIndOff', key: 'chart_ind_off', el: 'chartInd', draw: () => drawChart() },
  daily: { list: DAILY_IND, field: 'dailyIndOff', key: 'daily_ind_off', el: 'dailyInd', draw: () => drawDailyChart() },
};

/** @param {'intraday' | 'daily'} pane @param {string} id */
export const indOn = (pane, id) => !state[PANES[pane].field].includes(id);

/** @param {'intraday' | 'daily'} pane @param {string} id */
function toggle(pane, id) {
  const p = PANES[pane];
  if (!p.list.some(i => i.id === id)) return;
  state[p.field] = indOn(pane, id) ? [...state[p.field], id] : state[p.field].filter(x => x !== id);
  store.set(p.key, JSON.stringify(state[p.field]));
  renderChartInd();
  p.draw();
}

/** an intraday chip: shows or hides that line; what's hidden stays hidden on this device */
export function toggleChartInd(id) { toggle('intraday', id); }

/** a daily chip: shows or hides that line; what's hidden stays hidden on this device */
export function toggleDailyInd(id) { toggle('daily', id); }

/** both panes' chips, lit for the lines drawn */
export function renderChartInd() {
  for (const pane of /** @type {const} */ (['intraday', 'daily'])) {
    const p = PANES[pane];
    const html = p.list.map(i => {
      const on = indOn(pane, i.id);
      const attrs = `class="ind-chip${on ? ' active' : ''}" aria-pressed="${on}" data-arg="${i.id}" title="${on ? 'Hide' : 'Show'} the ${i.label}"`;
      const face = `<i style="background:var(${i.color})"></i>${i.label}`;
      return pane === 'daily' ? `<button data-action="toggleDailyInd" ${attrs}>${face}</button>` : `<button data-action="toggleChartInd" ${attrs}>${face}</button>`;
    }).join('');
    const el = document.getElementById(p.el);
    if (el && el.innerHTML !== html) el.innerHTML = html;
  }
}

/**
 * The moving averages a pane draws now: [{ values, color }], each a value (or null) per bar shown, warmed up on the
 * closes before them so a 21 EMA or 200 SMA doesn't start from the first bar on screen.
 * @param {'intraday' | 'daily'} pane @param {number[]} warm @param {number[]} closes @param {(name: string) => string} color
 */
export function chartAverages(pane, warm, closes, color) {
  return PANES[pane].list.filter(i => i.n && i.kind && indOn(pane, i.id))
    .map(i => ({ id: i.id, values: movingAverage(warm, closes, /** @type {'ema' | 'sma'} */ (i.kind), /** @type {number} */ (i.n)), color: color(i.color) }));
}
