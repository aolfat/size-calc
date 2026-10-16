// Journal trade page (#journalTradeSection, state.journalTrade; journal step 2, slice 3): one trade full width, opened from
// its row. The 5-minute chart from the saved bars (services/bars.js: the stock's, or an option contract's own; a spread
// shows its underlying; the two weeks before it straight from Tradier for context) and the daily chart from Tradier, drawn by
// Lightweight Charts (ui/journal-trade-chart.js), both with the fills marked, entry, exit and stop on the trade's own chart,
// each with its toolbar (intervals 5m to 65m, kept on this device as journal_chart_iv; daily ranges; log scale); the
// excursions (core/trade-page.js: MFE, MAE, exit efficiency); the fills; and the stop orders over time. Edit opens the
// trade sheet (your stop, separate, delete).
import { fmt$, marketEscape as esc } from '../core/format.js';
import { instructionWords, fillsFrom } from '../core/journal-records.js';
import { holdWords } from '../core/journal.js';
import { BARS_KEEP_DAYS, nyDay, weekdaysBetween } from '../core/bars.js';
import { contextDays, dailyWindow, excursions, exitParts, holdChartBars, holdView, rollUp, unpackBars } from '../core/trade-page.js';
import { fmtPositionPrice, parseSchwabOption } from '../core/positions.js';
import { viewRange } from '../core/chart-view.js';
import { fetchTradeBars, loadTradeBars, saveTradeBars, tradierKeyHere } from '../services/bars.js';
import { store } from '../lib/store.js';
import { dailyHistory } from '../services/tradier.js';
import { state } from '../state.js';
import { dropTradeChart, loadTradeChartLibrary, makeTradeChart, paintTradeChart } from './journal-trade-chart.js';
import { journalTradeList, marketTime, openTradeReview, renderJournal } from './journal.js';
import { onReviewChange, reviewSectionHtml } from './journal-review.js';
import { initTradeShotEvents, onShotsChange, renderShotViewer } from './journal-shots.js';
import { deckBarHtml, deckHidesPnl, deckPnlNote, renderDeckEnd, syncJournalBadge } from './journal-deck.js';

const px = (p, assetType) => fmtPositionPrice(p, assetType === 'OPTION' || assetType === 'SPREAD' ? 'OPTION' : null);
const signed$ = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt$(Math.abs(v))}`;
const signedR = r => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}R`;
const pnlClass = v => v > 0 ? 'journal-buy' : v < 0 ? 'journal-sell' : '';
const INTERVALS = [5, 15, 30, 65];
const RANGES = [['trade', 'Trade'], ['63', '3M'], ['126', '6M'], ['252', '1Y']];
const savedInterval = () => { const iv = Number(store.get('journal_chart_iv')); return INTERVALS.includes(iv) ? iv : 5; };

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
    iv: savedInterval(), rangeD: 'trade', log: { 5: false, D: false }, rolled: null, charts: {}, libWait: false, libError: '',
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
  // 5-minute: the saved bars; any the journal hasn't saved yet (and Tradier still has) are saved first
  if (days.length) {
    p.loading5 = true;
    renderJournalTrade();
    try {
      // the sessions before the open, for context: straight from Tradier while it keeps them, never saved
      const before = tradierKeyHere() ? contextDays(t, Date.now()) : [];
      const context = before.length ? fetchTradeBars(sym.five, before).catch(() => []) : Promise.resolve([]);
      let rows = await loadTradeBars(sym.five, days);
      const recent = days.filter(d => d >= nyDay(Date.now() - BARS_KEEP_DAYS * 864e5) && d < nyDay(Date.now()));
      if (rows.length < recent.length && tradierKeyHere()) {
        await saveTradeBars(t.legs || [t]);
        rows = await loadTradeBars(sym.five, days);
      }
      const held = (await context).filter(r => !rows.some(x => x.day === r.day));
      p.five = holdChartBars(unpackBars([...held, ...rows]), tradeFills(t));
      p.status5 = holdChartBars(unpackBars(rows), tradeFills(t)).length ? '' : !tradierKeyHere() && !rows.length ? "Add a Tradier key in Settings to load this trade's 5-minute bars."
        : days[days.length - 1] < nyDay(Date.now() - BARS_KEEP_DAYS * 864e5) ? 'No 5-minute bars were saved for this trade: Tradier keeps about 40 days, and the journal saves them as you go.'
        : 'No 5-minute bars for this trade yet. Today\'s session is saved once it ends.';
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
  const cells = [
    cell('P&amp;L', open && !t.exits ? '—' : signed$(t.pnl), open ? 'open' : t.afterFees ? 'after fees' : 'before fees', open && !t.exits ? '' : pnlClass(t.pnl)),
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
  const rows = fills.map(f => `<tr><td>${esc(marketTime(f.time))}</td><td class="${f.side === 'buy' ? 'journal-buy' : 'journal-sell'}">${esc(instructionWords(f.instruction))}</td><td>${t.legs ? esc(f.label) : ''}${t.legs ? ' ' : ''}${f.qty}</td><td>${px(f.price, f.assetType === 'OPTION' ? 'OPTION' : null)}</td></tr>`).join('');
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
      <span class="positions-meta">${side} ${t.entryQty} at ${t.status === 'history' ? '—' : px(t.avgEntry, t.assetType)}${exit}${t.status === 'open' ? ` · ${x ? `${t.openQty} ` : ''}open` : ''}${t.expired ? ' · expired' : ''}</span>
      <span class="journal-actions"><button class="btn" data-action="editJournalTrade">Edit</button></span>
    </div>${deckBarHtml(t)}`;
  const fills = tradeFills(t);
  const ex = excursions(t, p.five);
  const sym = chartSymbols(t);
  document.getElementById('jtCharts').style.display = '';
  renderTools(p);
  const libError = p.libError ? `Couldn't load the charts: ${p.libError}` : '';
  document.getElementById('jtStatus5').textContent = p.loading5 ? 'Loading the 5-minute bars…' : p.status5 || (p.five.length ? libError : '');
  document.getElementById('jtStatusD').textContent = p.loadingD ? 'Loading the daily chart…' : p.statusD || (p.daily.length ? libError : '');
  document.getElementById('jtCanvas5').style.display = p.five.length && !p.libError ? '' : 'none';
  document.getElementById('jtCanvasD').style.display = p.daily.length && !p.libError ? '' : 'none';
  body.innerHTML = `${statsHtml(t, ex)}
    ${deckPnlNote()}
    ${t.legs ? '<p class="hint">Excursions for spreads come later: the legs\' bars don\'t add up into a spread\'s high and low.</p>'
      : ex ? `<p class="hint">From ${ex.bars} five-minute bars while it was open, against the ${px(t.avgEntry, t.assetType)} average entry on all ${t.entryQty}.</p>` : ''}
    ${reviewSectionHtml(t)}
    ${fillsHtml(t, fills)}
    ${stopsHtml(t)}`;
  drawJournalTrade();
}

/** the lines on the trade's own chart: entry, exit (the average of several, how much of it while open), stop; the axis tag carries each price */
function tradeLines(t) {
  const css = getComputedStyle(document.documentElement), color = n => css.getPropertyValue(n).trim();
  const x = exitParts(t);
  return [
    { price: t.avgEntry, color: color('--blue'), title: 'entry' },
    { price: t.avgExit, color: color('--amber'), title: x ? `${x.avg ? 'avg exit' : 'exit'}${t.status === 'open' ? ` · ${x.closed} of ${t.entryQty}` : ''}` : 'exit' },
    { price: t.stop, color: color('--red'), title: t.stopSource === 'yours' ? 'your stop' : 'stop' },
  ].filter(l => l.price > 0);
}

/** the charts' toolbars: intervals and log for the intraday one, ranges and log for the daily */
function renderTools(p) {
  const on = b => ` class="filter-btn${b ? ' active' : ''}" aria-pressed="${b}"`;
  document.getElementById('jtTools5').innerHTML = INTERVALS.map(iv => `<button data-action="setJournalInterval" data-arg="${iv}"${on(p.iv === iv)}>${iv}m</button>`).join('')
    + `<span class="jt-log"><button data-action="toggleJournalLog" data-arg="5"${on(p.log[5])}>log</button></span>`;
  document.getElementById('jtToolsD').innerHTML = RANGES.map(([arg, label]) => `<button data-action="setJournalRange" data-arg="${arg}"${on(p.rangeD === arg)}>${label}</button>`).join('')
    + `<span class="jt-log"><button data-action="toggleJournalLog" data-arg="D"${on(p.log.D)}>log</button></span>`;
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

/** draw both charts: the library loads the first time (the page redraws when it's here, or says it couldn't) */
export function drawJournalTrade() {
  const p = state.journalTrade, t = pageTrade();
  if (!p || !t) return;
  if (!state.chartLib) {
    if ((p.five.length || p.daily.length) && !p.libWait) {
      p.libWait = true;
      loadTradeChartLibrary().then(() => { if (state.journalTrade === p) drawJournalTrade(); },
        e => { p.libError = String(e?.message || e); if (state.journalTrade === p) renderJournalTrade(); });
    }
    return;
  }
  const fills = tradeFills(t), sym = chartSymbols(t);
  for (const which of ['5', 'D']) {
    const five = which === '5', bars = five ? shownFive(p) : p.daily;
    if (!bars.length) { dropTradeChart(p.charts[which]); delete p.charts[which]; continue; }
    p.charts[which] ||= makeTradeChart(state.chartLib, document.getElementById(`jtChart${which}`), document.getElementById(`jtLegend${which}`), { daily: !five });
    paintTradeChart(p.charts[which], bars, {
      fills,
      iv: five ? p.iv : 0,
      title: five ? `${sym.five} · ${p.iv}m` : `${sym.daily} · 1D`,
      lines: five && sym.fiveIsTrade ? tradeLines(t) : [],
      range: five ? holdView(bars, t) : viewRange(p.rangeD === 'trade' ? p.viewD : { count: Number(p.rangeD), offset: p.viewD.offset }, bars.length),
      rangeKey: five ? `iv${p.iv}` : p.rangeD,
      log: p.log[which],
    });
  }
}

/** the page's listeners: pasting and dropping screenshots (the charts' own come with the library) */
export function initJournalTradeEvents() {
  initTradeShotEvents(() => pageTrade());
}

// a review change redraws the page (the section, and the status line with it)
onReviewChange(() => { if (state.journalTrade) renderJournalTrade(); });
onShotsChange(() => { if (state.journalTrade) renderJournalTrade(); renderShotViewer(); });
