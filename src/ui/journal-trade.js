// Journal trade page (#journalTradeSection, state.journalTrade; journal step 2, slice 3): one trade full width, opened from
// its row. The 5-minute chart from the saved bars (services/bars.js: the stock's, or an option contract's own; a spread
// shows its underlying; the two weeks before it, and today until it's saved, straight from Tradier) and the daily chart from Tradier, drawn by
// Lightweight Charts (ui/journal-trade-chart.js), both with the fills marked, entry, exit and stop on the trade's own chart,
// each with its toolbar (intervals 5m to 65m, kept on this device as journal_chart_iv; daily ranges; log scale). While the
// library is on trial, a TradingView | Ours switch (journal_chart_kind, device-local) puts our canvas charts (ui/candles.js)
// in the same place, on the same bars and framing; ours never loads the library; the
// excursions (core/trade-page.js: MFE, MAE, exit efficiency); then two tabs: Review (your review, the fills, and the stop
// orders over time) and Features (every stamped feature, ui/journal-features.js). Edit opens the
// trade sheet (your stop, separate, delete).
import { fmt$, marketEscape as esc } from '../core/format.js';
import { fillWords, fillsFrom } from '../core/journal-records.js';
import { holdWords, pnlPct } from '../core/journal.js';
import { BARS_KEEP_DAYS, lastDoneDay, nyDay, weekdaysBetween } from '../core/bars.js';
import { contextDays, dailyWindow, excursions, exitLineLabel, exitParts, fillMarks, holdChartBars, holdView, rollUp, sessionVwap, unpackBars } from '../core/trade-page.js';
import { fmtPositionPrice, parseSchwabOption } from '../core/positions.js';
import { viewRange } from '../core/chart-view.js';
import { fetchTradeBars, loadTradeBars, saveTradeBars, tradierKeyHere } from '../services/bars.js';
import { store } from '../lib/store.js';
import { dailyHistory } from '../services/tradier.js';
import { state } from '../state.js';
import { attachCandleGestures, candleGeom, ohlcText, paintCandles } from './candles.js';
import { dropTradeChart, loadTradeChartLibrary, makeTradeChart, paintTradeChart } from './journal-trade-chart.js';
import { journalTradeList, marketTime, openTradeReview, renderJournal } from './journal.js';
import { onReviewChange, reviewSectionHtml } from './journal-review.js';
import { initTradeShotEvents, onShotsChange, renderShotViewer } from './journal-shots.js';
import { deckBarHtml, deckHidesPnl, deckPnlNote, renderDeckEnd, syncJournalBadge } from './journal-deck.js';
import { tradeFeatureCount, tradeFeaturesHtml } from './journal-features.js';

const px = (p, assetType) => fmtPositionPrice(p, assetType === 'OPTION' || assetType === 'SPREAD' ? 'OPTION' : null);
const signed$ = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt$(Math.abs(v))}`;
const signedPct = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`;
const signedR = r => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}R`;
const pnlClass = v => v > 0 ? 'journal-buy' : v < 0 ? 'journal-sell' : '';
const INTERVALS = [5, 15, 30, 65];
const RANGES = [['trade', 'Trade'], ['63', '3M'], ['126', '6M'], ['252', '1Y']];
const savedInterval = () => { const iv = Number(store.get('journal_chart_iv')); return INTERVALS.includes(iv) ? iv : 5; };
const savedKind = () => store.get('journal_chart_kind') === 'ours' ? 'ours' : 'tv';

/** the trade on the page, as the Journal has it now (your stops, merges and deletes applied) */
const pageTrade = () => state.journalTrade ? journalTradeList().find(t => t.key === state.journalTrade.key) || null : null;
/** the trade on the page, for the Review section's actions */
export const journalPageTrade = () => pageTrade();

/** the trade's fills, oldest first */
function tradeFills(t) {
  const ids = new Set(t.fillIds);
  return fillsFrom(state.journalRecords || []).filter(f => ids.has(f.id)).sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

/** what each chart shows: an option's own 5-minute bars and its underlying's daily; a spread's underlying for both */
function chartSymbols(t) {
  const opt = t.assetType === 'OPTION' ? parseSchwabOption(t.symbol) : null;
  if (opt) return { five: t.symbol.replace(/\s+/g, ''), daily: opt.root, fiveIsTrade: true };
  return { five: t.symbol, daily: t.symbol, fiveIsTrade: t.assetType !== 'SPREAD' };
}

/** the New York days the trade was open: the 5-minute chart's days */
function holdDays(t) {
  if (t.status === 'history' || !t.openedAt) return [];
  const to = t.closedAt ? nyDay(t.closedAt) : nyDay(Date.now());
  return weekdaysBetween(nyDay(t.openedAt), to);
}

export function openJournalTrade(key) {
  // a fresh review: no half-picked setup, new-item box or note draft carried over from another trade
  Object.assign(state, { shotView: null, shotDeleteArmed: false, setupDraft: null, reviewLinkDraft: '', reviewNewKind: '', reviewNewName: '', reviewNoteDraft: null, reviewMarketOwn: false });
  dropCharts(state.journalTrade);
  state.journalTrade = {
    key, five: [], daily: [], viewD: { count: 63, offset: 0 }, loading5: false, loadingD: false, status5: '', statusD: '',
    tab: 'review', featuresOpen: false, // the tab under the stats (review | features), and every feature expanded
    iv: savedInterval(), rangeD: 'trade', log: { 5: false, D: false }, rolled: null, charts: {}, libWait: false, libError: '',
    kind: savedKind(), classic: { 5: null, D: null }, // ours: per chart { bars, key, view, levels, hover: { index, y } }
  };
  syncJournalPage();
  renderJournalTrade();
  window.scrollTo?.({ top: 0 });
  loadCharts(state.journalTrade);
}

/** back to the list, redrawn: what you just reviewed (setups, the reviewed mark) shows there; it ends the review deck too */
export function closeJournalTrade() {
  dropCharts(state.journalTrade);
  state.journalTrade = null;
  state.journalDeck = null;
  renderJournal();
}

export function editJournalTrade() {
  if (state.journalTrade) openTradeReview(state.journalTrade.key);
}

/** the list or the page (a trade, or the review deck's end): one shows at a time inside the Journal */
export function syncJournalPage() {
  const page = (!!state.journalTrade || !!state.journalDeck?.finished) && state.journalView;
  document.getElementById('journalSection').style.display = state.journalView && !page ? '' : 'none';
  document.getElementById('journalTradeSection').style.display = page ? '' : 'none';
}

async function loadCharts(p) {
  const t = pageTrade();
  if (!t) return;
  const sym = chartSymbols(t), days = holdDays(t);
  p.five = []; p.daily = [];
  if (t.assetType === 'FUTURE') {
    p.status5 = p.statusD = "No chart for futures: Tradier, where the charts' bars come from, has no futures.";
    renderJournalTrade();
    return;
  }
  // 5-minute: the saved bars; any the journal hasn't saved yet (and Tradier still has) are saved first
  if (days.length) {
    p.loading5 = true;
    renderJournalTrade();
    try {
      // the sessions before the open, for context: straight from Tradier while it keeps them, never saved
      const now = Date.now(), before = tradierKeyHere() ? contextDays(t, now) : [];
      const context = before.length ? fetchTradeBars(sym.five, before).catch(() => []) : Promise.resolve([]);
      let rows = await loadTradeBars(sym.five, days);
      const recent = days.filter(d => d >= nyDay(now - BARS_KEEP_DAYS * 864e5) && d <= lastDoneDay(now));
      if (rows.length < recent.length && tradierKeyHere()) {
        await saveTradeBars(t.legs || [t], now);
        rows = await loadTradeBars(sym.five, days);
      }
      // today until it's saved (after 20:00 ET): straight from Tradier, never saved, so a half day can't be kept
      const today = days.filter(d => d === nyDay(now) && !rows.some(x => x.day === d));
      if (today.length && tradierKeyHere()) rows = [...rows, ...await fetchTradeBars(sym.five, today).catch(() => [])];
      const held = (await context).filter(r => !rows.some(x => x.day === r.day));
      p.five = holdChartBars(unpackBars([...held, ...rows]), tradeFills(t));
      p.status5 = holdChartBars(unpackBars(rows), tradeFills(t)).length ? '' : !tradierKeyHere() && !rows.length ? "Add a Tradier key in Settings to load this trade's 5-minute bars."
        : days[days.length - 1] < nyDay(now - BARS_KEEP_DAYS * 864e5) ? 'No 5-minute bars were saved for this trade: Tradier keeps about 40 days, and the journal saves them as you go.'
        : 'No 5-minute bars for this trade yet: Tradier has none for it so far.';
    } catch(e) {
      p.status5 = `Couldn't load the 5-minute bars: ${String(e?.message || e)}`;
    }
    p.loading5 = false;
  } else p.status5 = t.status === 'history' ? 'Bought before your history, so there\'s no hold to chart.' : '';
  if (state.journalTrade !== p) return;
  renderJournalTrade();
  // daily: from Tradier, about a year
  if (!tradierKeyHere()) { p.statusD = 'Add a Tradier key in Settings for the daily chart.'; renderJournalTrade(); return; }
  p.loadingD = true;
  renderJournalTrade();
  try {
    p.daily = (await dailyHistory(sym.daily)).map(d => ({ date: d.date, open: +d.open, high: +d.high, low: +d.low, close: +d.close, volume: +d.volume || 0 }));
    p.viewD = dailyWindow(p.daily, t);
    p.statusD = p.daily.length ? '' : `Tradier has no daily history for ${sym.daily}.`;
  } catch(e) {
    p.statusD = 'Couldn\'t load the daily chart from Tradier.';
  }
  p.loadingD = false;
  if (state.journalTrade === p) renderJournalTrade();
}

function statsHtml(t, ex) {
  const cell = (label, value, sub = '', cls = '') => `<div><dt>${label}</dt><dd class="${cls}">${value}${sub ? `<span class="pos-sub">${sub}</span>` : ''}</dd></div>`;
  const open = t.status === 'open';
  // in the review deck, the result waits for the grade (the chart, fills and exit price stay: they judge the execution)
  const hide = deckHidesPnl(t), wait = label => cell(label, '<span class="jt-wait">Grade first</span>', '<button class="pos-link" data-action="revealDeckPnl">Show</button>');
  if (hide) return `<dl class="jt-stats">${[wait('P&amp;L'), wait('R'),
    cell('MFE', '—', 'after grading'), cell('MAE', '—', 'after grading'), wait('Exit efficiency'),
    cell('Hold', open ? 'open' : esc(holdWords(t.holdMs)), `opened ${esc(marketTime(t.openedAt))}`)].join('')}</dl>`;
  const pct = pnlPct(t);
  const cells = [
    cell('P&amp;L', open && !t.exits ? '—' : signed$(t.pnl), [pct === null ? '' : signedPct(pct), open ? 'open' : t.afterFees ? 'after fees' : 'before fees'].filter(Boolean).join(' · '), open && !t.exits ? '' : pnlClass(t.pnl)),
    cell('R', t.r === null ? '—' : signedR(t.r), t.risk ? `risk ${fmt$(t.risk)}` : ''),
    cell('MFE', ex ? signed$(ex.mfe) : '—', ex ? [ex.mfeR !== null ? signedR(ex.mfeR) : '', `best ${px(ex.mfePrice, t.assetType)}`].filter(Boolean).join(' · ') : '', ex && ex.mfe > 0 ? 'journal-buy' : ''),
    cell('MAE', ex ? signed$(ex.mae) : '—', ex ? [ex.maeR !== null ? signedR(ex.maeR) : '', `worst ${px(ex.maePrice, t.assetType)}`].filter(Boolean).join(' · ') : '', ex && ex.mae < 0 ? 'journal-sell' : ''),
    cell('Exit efficiency', ex && ex.efficiency !== null ? `${Math.round(ex.efficiency * 100)}%` : '—', ex && ex.efficiency !== null ? 'of the best move kept' : t.status === 'win' ? '' : 'winners only'),
    cell('Hold', open ? 'open' : t.status === 'history' ? '—' : esc(holdWords(t.holdMs)), `opened ${esc(marketTime(t.openedAt))}`),
  ];
  return `<dl class="jt-stats">${cells.join('')}</dl>`;
}

function fillsHtml(t, fills) {
  if (!fills.length) return '';
  const rows = fills.map(f => `<tr><td>${esc(marketTime(f.time))}</td><td class="${f.side === 'buy' ? 'journal-buy' : 'journal-sell'}">${esc(fillWords(f))}</td><td>${t.legs ? esc(f.label) : ''}${t.legs ? ' ' : ''}${f.qty}</td><td>${px(f.price, f.assetType === 'OPTION' ? 'OPTION' : null)}</td></tr>`).join('');
  return `<div class="section-title jt-sub">Fills</div>
    <div class="positions-wrap"><table class="positions-table journal-table jt-table"><thead><tr><th scope="col">Time (ET)</th><th scope="col">Action</th><th scope="col">Qty</th><th scope="col">Price</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function stopsHtml(t) {
  if (!t.stopTrail || !t.stopTrail.length) return '';
  const rows = t.stopTrail.map(s => `<tr><td>${esc(marketTime(s.entered))}</td><td>${px(s.stopPrice, t.assetType)}${s.stopPrice === t.schwabStop ? ' <span class="journal-tag journal-tag-quiet">first</span>' : ''}</td><td>${esc(String(s.status || '').toLowerCase().replace(/_/g, ' '))}</td></tr>`).join('');
  return `<div class="section-title jt-sub">Stop orders</div>
    <div class="positions-wrap"><table class="positions-table journal-table jt-table"><thead><tr><th scope="col">Entered (ET)</th><th scope="col">Stop</th><th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function renderJournalTrade() {
  const p = state.journalTrade;
  const head = document.getElementById('jtHead'), body = document.getElementById('jtBody');
  if (!p) { if (state.journalDeck?.finished) renderDeckEnd(); return; }
  if (!head) return;
  const list = journalTradeList();
  syncJournalBadge(list);
  const t = list.find(x => x.key === p.key) || null;
  document.getElementById('journalTradeSection').classList.toggle('jt-decking', !!state.journalDeck);
  if (!t) {
    dropCharts(p);
    head.innerHTML = `<div class="jt-head"><button class="pos-link" data-action="closeJournalTrade">← Trades</button></div>${state.journalDeck ? '<div class="jt-deck" id="jtDeckBar"><span class="jt-deck-acts"><button class="btn primary" data-action="deckNext">Next ›</button><button class="btn" data-action="endReviewDeck">Done</button></span></div>' : ''}`;
    body.innerHTML = '<p class="hint">This trade isn\'t in the journal any more.</p>';
    document.getElementById('jtCharts').style.display = 'none';
    return;
  }
  const side = t.bias === 'neutral' ? 'Neutral' : (t.bias || t.direction) === 'long' ? 'Long' : 'Short';
  const x = exitParts(t);
  const exit = !x ? '' : t.status === 'open' ? ` · ${x.closed} ${x.verb} at ${px(t.avgExit, t.assetType)}${x.avg ? ' avg' : ''}`
    : ` → ${px(t.avgExit, t.assetType)}${x.avg ? ' avg' : ''}`;
  head.innerHTML = `<div class="jt-head">
      <button class="pos-link" data-action="closeJournalTrade">← Trades</button>
      <span class="section-title" id="jtTitle">${esc(t.label)}</span>
      <span class="positions-meta">${side} ${t.entryQty} at ${t.status === 'history' ? '—' : px(t.avgEntry, t.assetType)}${exit}${t.status === 'open' ? ` · ${x ? `${t.openQty} ` : ''}open` : ''}${t.expired ? ' · expired' : ''}${t.via ? ` · ${t.via}` : ''}</span>
      <span class="journal-actions"><button class="btn" data-action="editJournalTrade">Edit</button></span>
    </div>${deckBarHtml(t)}`;
  const fills = tradeFills(t);
  const ex = excursions(t, p.five);
  const sym = chartSymbols(t);
  document.getElementById('jtCharts').style.display = '';
  renderTools(p);
  const tv = p.kind === 'tv', libError = tv && p.libError ? `Couldn't load the charts: ${p.libError}` : '';
  document.getElementById('jtStatus5').textContent = p.loading5 ? 'Loading the 5-minute bars…' : p.status5 || (p.five.length ? libError : '');
  document.getElementById('jtStatusD').textContent = p.loadingD ? 'Loading the daily chart…' : p.statusD || (p.daily.length ? libError : '');
  document.getElementById('jtCanvas5').style.display = p.five.length && !libError ? '' : 'none';
  document.getElementById('jtCanvasD').style.display = p.daily.length && !libError ? '' : 'none';
  for (const which of ['5', 'D']) {
    for (const id of [`jtChart${which}`, `jtLegend${which}`]) document.getElementById(id).style.display = tv ? '' : 'none';
    document.getElementById(`jtClassic${which}`).style.display = tv ? 'none' : '';
    document.getElementById(`jtOhlc${which}`).style.display = tv ? 'none' : '';
  }
  body.innerHTML = `${statsHtml(t, ex)}
    ${deckPnlNote()}
    ${t.legs ? '<p class="hint">Excursions for spreads come later: the legs\' bars don\'t add up into a spread\'s high and low.</p>'
      : ex ? `<p class="hint">From ${ex.bars} five-minute bars while it was open, against the ${px(t.avgEntry, t.assetType)} average entry on all ${t.entryQty}.</p>` : ''}
    ${tradeTabsHtml(p, t)}
    ${p.tab === 'features' ? `<div id="jtFeatures">${tradeFeaturesHtml(t)}</div>` : `${reviewSectionHtml(t)}
    ${fillsHtml(t, fills)}
    ${stopsHtml(t)}`}`;
  drawJournalTrade();
}

/** Review (your labels, grades and notes, then the fills and stops) or Features (what the data says at the entry) */
function tradeTabsHtml(p, t) {
  const tab = (v, label) => `<button class="${p.tab === v ? 'active' : ''}" aria-pressed="${p.tab === v}" data-action="setJournalTradeTab" data-arg="${v}">${label}</button>`;
  const n = tradeFeatureCount(t);
  return `<div class="seg journal-tabs jt-tabs" aria-label="Show">${tab('review', 'Review')}${tab('features', `Features${n ? ` <span class="jt-tab-n">${n}</span>` : ''}`)}</div>`;
}

export function setJournalTradeTab(tab) {
  const p = state.journalTrade;
  if (!p || !['review', 'features'].includes(tab) || p.tab === tab) return;
  p.tab = tab;
  renderJournalTrade();
}

/**
 * The lines on the trade's own chart: entry, exit (the average of several, how much of it while open), stop. title is
 * TradingView's (its axis tag carries the price); label is ours, price included (left: drawn on the left edge).
 */
function tradeLines(t) {
  const css = getComputedStyle(document.documentElement), color = n => css.getPropertyValue(n).trim();
  const x = exitParts(t), stop = t.stopSource === 'yours' ? 'your stop' : 'stop';
  return [
    { price: t.avgEntry, color: color('--blue'), title: 'entry', label: `entry ${t.avgEntry?.toFixed(2)}`, left: true },
    { price: t.avgExit, color: color('--amber'), title: x ? `${x.avg ? 'avg exit' : 'exit'}${t.status === 'open' ? ` · ${x.closed} of ${t.entryQty}` : ''}` : 'exit', label: exitLineLabel(t) },
    { price: t.stop, color: color('--red'), title: stop, label: `${stop} ${t.stop?.toFixed(2)}` },
  ].filter(l => l.price > 0);
}

/** the charts' toolbars: intervals and log for the intraday one, ranges and log for the daily */
function renderTools(p) {
  const on = b => ` class="filter-btn${b ? ' active' : ''}" aria-pressed="${b}"`, tv = p.kind === 'tv';
  const kind = b => ` class="${b ? 'active' : ''}" aria-pressed="${b}"`;
  document.getElementById('jtKindSwitch').innerHTML = `<button data-action="setJournalChartKind" data-arg="tv"${kind(tv)}>TradingView</button><button data-action="setJournalChartKind" data-arg="ours"${kind(!tv)}>Ours</button>`;
  document.getElementById('jtTools5').innerHTML = INTERVALS.map(iv => `<button data-action="setJournalInterval" data-arg="${iv}"${on(p.iv === iv)}>${iv}m</button>`).join('')
    + (tv ? `<span class="jt-log"><button data-action="toggleJournalLog" data-arg="5"${on(p.log[5])}>log</button></span>` : '');
  document.getElementById('jtToolsD').innerHTML = RANGES.map(([arg, label]) => `<button data-action="setJournalRange" data-arg="${arg}"${on(p.rangeD === arg)}>${label}</button>`).join('')
    + (tv ? `<span class="jt-log"><button data-action="toggleJournalLog" data-arg="D"${on(p.log.D)}>log</button></span>` : '');
}

/** TradingView's charts or ours, in the same place; kept on this device */
export function setJournalChartKind(kind) {
  if (kind !== 'tv' && kind !== 'ours') return;
  store.set('journal_chart_kind', kind);
  const p = state.journalTrade;
  if (!p) return;
  p.kind = kind;
  renderJournalTrade();
}

export function setJournalInterval(iv) {
  const p = state.journalTrade;
  if (!p || !INTERVALS.includes(iv)) return;
  p.iv = iv;
  store.set('journal_chart_iv', String(iv));
  renderTools(p);
  drawJournalTrade();
}

/** the daily chart's window: 'trade' (40 sessions before through 10 after), or a session count ending at the same place */
export function setJournalRange(arg) {
  const p = state.journalTrade;
  if (!p || !RANGES.some(([a]) => a === arg)) return;
  p.rangeD = arg;
  renderTools(p);
  drawJournalTrade();
}

export function toggleJournalLog(which) {
  const p = state.journalTrade;
  if (!p || !(which in p.log)) return;
  p.log[which] = !p.log[which];
  renderTools(p);
  drawJournalTrade();
}

/** the intraday bars at the chosen interval, rolled up once per interval and set of bars (a new array resets the view) */
function shownFive(p) {
  if (!p.rolled || p.rolled.iv !== p.iv || p.rolled.from !== p.five) p.rolled = { iv: p.iv, from: p.five, bars: rollUp(p.five, p.iv) };
  return p.rolled.bars;
}

/** let the page's charts go (closing it, or another trade opening) */
function dropCharts(p) {
  if (!p?.charts) return;
  for (const which of Object.keys(p.charts)) dropTradeChart(p.charts[which]);
  p.charts = {};
}

/** what each chart shows: its bars, the fills' interval, the view to open on, and the trade's lines */
function chartPlan(p, t, which) {
  const five = which === '5', bars = five ? shownFive(p) : p.daily, sym = chartSymbols(t);
  return {
    bars, five, iv: five ? p.iv : 0,
    title: five ? `${sym.five} · ${p.iv}m` : `${sym.daily} · 1D`,
    lines: five && sym.fiveIsTrade ? tradeLines(t) : [],
    range: five ? holdView(bars, t) : viewRange(p.rangeD === 'trade' ? p.viewD : { count: Number(p.rangeD), offset: p.viewD.offset }, bars.length),
    rangeKey: five ? `iv${p.iv}` : p.rangeD,
  };
}

/** draw both charts, TradingView's or ours */
export function drawJournalTrade() {
  const p = state.journalTrade, t = pageTrade();
  if (!p || !t) return;
  if (p.kind === 'ours') { for (const which of ['5', 'D']) drawClassic(p, t, which); return; }
  drawTradingView(p, t);
}

/** our canvas chart: the same bars and opening view as TradingView's, our own pan, zoom and crosshair (candles.js) */
function drawClassic(p, t, which) {
  const plan = chartPlan(p, t, which), { bars } = plan;
  const canvas = document.getElementById(`jtClassic${which}`), readout = document.getElementById(`jtOhlc${which}`);
  if (!bars.length || !canvas) { p.classic[which] = null; return; }
  let c = p.classic[which];
  if (!c || c.bars !== bars || c.key !== plan.rangeKey) {
    c = p.classic[which] = { bars, key: plan.rangeKey, view: { count: plan.range.end - plan.range.start, offset: bars.length - plan.range.end }, hover: { index: -1, y: -1 } };
    c.vwap = plan.five ? sessionVwap(bars) : null;
  }
  c.lines = plan.lines;
  c.iv = plan.iv || 5;
  const w = canvas.clientWidth;
  if (!w) return; // hidden: painting now would wipe the canvas to zero width
  const g = candleGeom(bars, c.view, w, c.lines.map(l => l.price));
  paintCandles(canvas, g, bars, { lines: c.lines, hover: c.hover, marks: fillMarks(bars, tradeFills(t), c.iv), vwap: c.vwap });
  const b = bars[c.hover.index], vw = c.vwap?.[c.hover.index];
  readout.innerHTML = b && c.hover.index >= g.start && c.hover.index < g.end
    ? ohlcText(b) + (vw !== undefined ? ` &nbsp; VWAP <span style="color:${getComputedStyle(document.documentElement).getPropertyValue('--teal').trim()}">${vw.toFixed(2)}</span>` : '') : '';
}

/** TradingView's charts: the library loads the first time (the page redraws when it's here, or says it couldn't) */
function drawTradingView(p, t) {
  if (!state.chartLib) {
    if ((p.five.length || p.daily.length) && !p.libWait) {
      p.libWait = true;
      loadTradeChartLibrary().then(() => { if (state.journalTrade === p) renderJournalTrade(); },
        e => { p.libError = String(e?.message || e); if (state.journalTrade === p) renderJournalTrade(); });
    }
    // until it's here (the next render puts the bars' own status back)
    if (!p.libError) for (const which of ['5', 'D']) if ((which === '5' ? p.five : p.daily).length) document.getElementById(`jtStatus${which}`).textContent = 'Loading the charts…';
    return;
  }
  const fills = tradeFills(t);
  for (const which of ['5', 'D']) {
    const plan = chartPlan(p, t, which);
    if (!plan.bars.length) { dropTradeChart(p.charts[which]); delete p.charts[which]; continue; }
    p.charts[which] ||= makeTradeChart(state.chartLib, document.getElementById(`jtChart${which}`), document.getElementById(`jtLegend${which}`), { daily: !plan.five });
    paintTradeChart(p.charts[which], plan.bars, { ...plan, fills, log: p.log[which] });
  }
}

/** the page's listeners: pasting and dropping screenshots, and our canvas charts' zoom, pan and crosshair (the library brings its own) */
export function initJournalTradeEvents() {
  initTradeShotEvents(() => pageTrade());
  for (const which of ['5', 'D']) {
    const canvas = document.getElementById(`jtClassic${which}`);
    if (!canvas) continue;
    const c = () => state.journalTrade?.classic[which] || null;
    const g = () => candleGeom(c().bars, c().view, canvas.getBoundingClientRect().width, c().lines.map(l => l.price));
    attachCandleGestures(canvas, {
      count: () => c()?.bars.length || 0,
      view: () => c().view,
      setView: v => { c().view = v; drawJournalTrade(); },
      geom: g,
      hover: (clientX, clientY) => {
        const rect = canvas.getBoundingClientRect();
        c().hover = { index: g().index(clientX - rect.left), y: clientY - rect.top };
        drawJournalTrade();
      },
      leave: () => { if (c()) { c().hover = { index: -1, y: -1 }; drawJournalTrade(); } },
      pick: () => {}, // nothing to pick here: the chart is for looking
    });
  }
  window.addEventListener('resize', () => { if (state.journalTrade?.kind === 'ours') drawJournalTrade(); });
}

/** our chart's visible bars, [start, end), for tests */
export const journalTradeRange = which => {
  const c = state.journalTrade?.classic[which];
  return c ? viewRange(c.view, c.bars.length) : null;
};

// a review change redraws the page (the section, and the status line with it)
// a review change redraws the trade page, or the list under the choices sheet (a merge or a short word changes its names)
onReviewChange(() => { if (state.journalTrade) renderJournalTrade(); else if (state.journalView) renderJournal(); });
onShotsChange(() => { if (state.journalTrade) renderJournalTrade(); renderShotViewer(); });
