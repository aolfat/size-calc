// Journal tab (#journalSection, setView('journal'), key j): what's kept from Schwab in your account, your trades (fills grouped
// flat to flat, with P&L, R, stop and hold time) or the raw fills, filtered by side and symbol; the trade sheet (your
// stop, delete a trade that doesn't belong, combine or split a spread); and the Import and Export sheets: Import lists the
// sources (Schwab, thinkorswim statements for futures, more files later), Export the files you can take (Schwab history now, trades later). Tick trades
// and Merge to make them one (a re-entry, a spread's legs); Separate undoes it. Both are rows in the trades table. The
// trade page and stats come later.
import { fmt$, marketEscape as esc } from '../core/format.js';
import { fillWords, fillsFrom, recordsSummary } from '../core/journal-records.js';
import { combineCandidates, fillBias, fundOf, holdWords, journalTrades, legWords, listedFund, multiplierOf, withFund, mergeProblem, ownStopError, pnlBasis, pnlPct, riskAt, tradesSummary } from '../core/journal.js';
import { importWords } from '../core/schwab-history.js';
import { activePeriods, exitDays, isRangeKey, nyParts, periodKey, periodSpan, PERIODS, rangeKey, stepPeriod, switchPeriod } from '../core/journal-stats.js';
import { fmtPositionPrice } from '../core/positions.js';
import { lastCapture } from '../services/capture.js';
import { schwabAccount } from '../services/schwab.js';
import { deleteSavedTrades, insertSavedTrades, loadSavedRecords, loadSavedTrades, loadTradeReviews, saveTradeReviews, updateSavedTrade } from '../services/journal.js';
import { schwabConnected } from '../services/schwab.js';
import { store } from '../lib/store.js';
import { growBoxes } from '../lib/grow.js';
import { DESKTOP_MQ, mq, PHONE_MQ } from '../lib/media.js';
import { keepScroll } from '../lib/keep-scroll.js';
import { inZone, zoneAbbr } from '../lib/zone.js';
import { state } from '../state.js';
import { captureNow, maybeCapture, onCaptureChange } from './schwab-capture.js';
import { calendarView, drawJournalEquity, nextJournalMonth, statsView, thisMonth } from './journal-stats.js';
import { maybeSaveBars } from './journal-bars.js';
import { featuresLine, featuresView, loadFeatureRows, maybeStampFeatures, stampAfterImport } from './journal-features.js';
import { openJournalTrade, reloadJournalCharts, renderJournalTrade, syncJournalPage } from './journal-trade.js';
import { applyOrderPlans } from './order-plan.js';
import { loadJournalReview, myFunds, reviewFrom, reviewedMark, setupMatches, setupMenu, setupsOf, toReview, tradeReviewState } from './journal-review.js';
import { loadJournalShots } from './journal-shots.js';
import { deckButtonHtml, renderDeckEnd, reviewFromHtml, syncJournalBadge } from './journal-deck.js';
import { bindUpNext, phoneTradesHtml } from './journal-cards.js';
import { benchTradesHtml, deskTradesHtml, journalLayout, layoutSwitchHtml } from './journal-bench.js';
import { loadModelBooks, renderModelBooks, selectModelSetup } from './model-books.js';
import { setupsView } from './journal-setups.js';
import { loadPeriodReviewRows, periodReviewHtml } from './journal-week.js';
import { tosSectionHtml } from './journal-tos.js';
import { dayPageHtml, todayButtonHtml, todayEconWords } from './journal-notebook.js';
import { missedTabHtml } from './journal-missed.js';
import { drawMissedChart } from './missed-chart.js';
import { closeSheet, openSheet } from './sheets.js';
import { showError, showToast } from './feedback.js';

/** fills shown at once; the rest are counted */
export const JOURNAL_SHOWN = 200;

const day = iso => iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
/** a fill's time in the Settings zone (ET or PT), whatever the device's: '10/13, 11:47 AM' */
export const clockTime = iso => iso ? inZone(iso, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const when = clockTime;

/** what's kept, in words: '577 orders and 415 trades kept, 8 futures fills · Sep 9, 2026 to Oct 26, 2026' */
function keptWords() {
  const kept = recordsSummary(state.journalRecords || []);
  return kept.orders || kept.transactions || kept.statementFills
    ? `${kept.orders} orders and ${kept.transactions} trades kept${kept.statementFills ? `, ${kept.statementFills} futures fills` : ''} · ${day(kept.first)} to ${day(kept.last)}`
    : state.journalLoading ? 'Loading…' : 'Nothing kept yet';
}

/**
 * The quiet line beside the title: how many trades and when the last import was, or that one is running or failed (Details
 * opens the Import sheet, which says it all); what's kept and the last import in full are its title
 */
function metaLine(all) {
  if (state.captureBusy) return '<span class="spinner" style="vertical-align:middle;margin-right:6px;"></span>Importing from Schwab…';
  const last = lastCapture(), n = all.filter(t => !t.deleted && t.status !== 'history').length;
  const parts = [n ? `${n} trade${n === 1 ? '' : 's'}` : esc(keptWords()), last ? `imported ${when(new Date(last.at).toISOString())}` : 'not imported yet'];
  if (state.captureError) parts.push('<span style="color:var(--amber)">import failed</span> <button class="pos-link" data-action="openJournalImport">Details</button>');
  return parts.join(' · ') + esc(todayEconWords()); // today's high-impact releases, the old today line's
}
const metaTitle = () => [keptWords(), statusText()].join(' · ');
/** the last import in plain words, for a title */
function statusText() {
  const last = lastCapture();
  const what = last && 'kept' in last ? importWords(last) : last ? `${last.orders} orders, ${last.transactions} trades` : '';
  return last ? `Last import ${when(new Date(last.at).toISOString())}: ${what}` : 'Not imported yet';
}

/** the Import sheet's line: importing, the last import, or why it can't run */
function statusLine() {
  if (state.captureBusy) return '<span class="spinner" style="vertical-align:middle;margin-right:6px;"></span>Importing from Schwab…';
  const last = lastCapture();
  // an import from before delta counts has only totals: show those rather than a made-up 'nothing new'
  const what = last && 'kept' in last ? importWords(last) : last ? `${last.orders} orders, ${last.transactions} trades` : '';
  const parts = [last ? `Last import ${when(new Date(last.at).toISOString())}: ${what}` : 'Not imported yet'];
  if (state.captureError) parts.push(`<span style="color:var(--amber)">last try failed: ${esc(state.captureError)}</span>`);
  return parts.join(' · ');
}

function fillRow(f) {
  const mult = multiplierOf(f.assetType, f.symbol);
  return `<tr>
    <td><b>${esc(f.label || f.symbol)}</b></td>
    <td class="${f.side === 'buy' ? 'journal-buy' : 'journal-sell'}">${esc(fillWords(f))}</td>
    <td>${f.qty}</td>
    <td>${fmtPositionPrice(f.price, f.assetType === 'OPTION' ? 'OPTION' : null)}</td>
    <td>${fmt$(f.qty * f.price * mult)}</td>
    <td>${esc(clockTime(f.time))}</td>
  </tr>`;
}

export const px = (p, assetType) => fmtPositionPrice(p, assetType === 'OPTION' || assetType === 'SPREAD' ? 'OPTION' : null);
export const signed$ = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt$(Math.abs(v))}`;
export const pnlClass = v => v > 0 ? 'journal-buy' : v < 0 ? 'journal-sell' : '';
/** P&L before or after Schwab's fees: your choice, synced to your account as journal_fees */
export const journalAfterFees = () => store.get('journal_fees') === 'after';
export const feeWords = () => journalAfterFees() ? 'after fees' : 'before fees';
export const signedR = r => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}R`; // the same minus sign as money

/** the stop cell: the price in use (tap to change it), and whether it's yours or Schwab's stop moved later */
function stopCell(t) {
  const key = esc(t.key);
  if (t.legs) return `<span title="A spread's risk is its defined risk">—</span>`;
  if (t.stop === null) return `<button class="pos-link" data-action="openTradeReview" data-arg="${key}" aria-label="Set a stop for ${esc(t.label)}">Set</button>${t.rBasis === 'premium' ? '<span class="pos-sub">premium</span>' : ''}`;
  const sub = t.stopSource === 'yours' ? 'yours' : t.movedTo !== null ? `moved to ${px(t.movedTo, t.assetType)}` : '';
  return `<button class="pos-link" data-action="openTradeReview" data-arg="${key}" aria-label="Change the stop for ${esc(t.label)}">${px(t.stop, t.assetType)}</button>${sub ? `<span class="pos-sub">${sub}</span>` : ''}`;
}

/** after fees, the fees taken out or that they haven't come in */
export function feeSubs(t) {
  if (!t.afterFees || (t.status === 'open' && !t.exits)) return '';
  return t.feesMissing ? '<span class="pos-sub"><span class="journal-fees-missing">fees not in yet</span></span>' : t.fees ? `<span class="pos-sub">fees ${fmt$(t.fees)}</span>` : '';
}
/** under the P&L: 'so far' on an open trade, and the fees */
const pnlSub = t => `${t.status === 'open' && t.exits ? '<span class="pos-sub">so far</span>' : ''}${feeSubs(t)}`;
export const pnlTitle = t => t.afterFees ? ` title="${esc(`Before fees ${signed$(t.grossPnl)}, fees ${fmt$(t.fees)}${t.feesMissing ? `, ${t.feesMissing} order${t.feesMissing === 1 ? '' : 's'} without fees yet` : ''}`)}"` : '';

export function rTitleOf(t) {
  if (t.rBasis === 'debit') return `The debit paid, ${fmt$(t.risk)}, is the risk`;
  if (t.rBasis === 'width') return `The width less the credit, ${fmt$(t.risk)}, is the risk`;
  if (t.legs) return 'No defined risk for this combination yet';
  if (t.rBasis === 'stop') return `${t.stopSource === 'yours' ? 'Your stop' : 'Initial stop'} ${px(t.stop, t.assetType)}, risk ${fmt$(t.risk)}`;
  if (t.rBasis === 'premium') return `No stop: the premium paid, ${fmt$(t.risk)}, is the risk`;
  return 'No stop: set one to get R';
}

export const HISTORY_TITLE = "Opened before the journal's history: Schwab's API gives 60 days of orders, so its entry and P&L aren't known. It doesn't count in the stats.";
export const EXPIRED_TITLE = "Closed at $0 at the 4pm close on expiry, assumed worthless. An assignment or exercise shows once Schwab posts it, usually the next morning.";
export const VIA_TITLE = {
  assigned: 'Assigned: the option closed at $0 that day, so its premium stays its P&L, and the shares came in or went out at the strike.',
  exercised: 'Exercised: the option closed at $0 that day, and the shares came in or went out at the strike.',
  delivered: 'Shares an option delivered at the strike. The option was opened before your history, so it isn\'t here.',
};

/** a leveraged ETF's trade on its underlying names it: long SQQQ reads 'Short QQQ' */
export const onWords = t => t.setupOn ? ` ${esc(t.setupOn)}` : '';
/** the side is the bet on the stock: a put bought is short, a call debit spread long, a time spread neutral */
const sideCell = t => `<td class="${{ long: 'journal-buy', short: 'journal-sell' }[t.bias] || ''}">${{ long: 'Long', short: 'Short', neutral: 'Neutral' }[t.bias] || ''}${onWords(t)}</td>`;

/** the tick box that picks a trade for Merge or Delete (not on deleted trades: an empty slot keeps their names in line) */
export const pickBox = t => t.deleted ? '<span class="journal-pick" aria-hidden="true"></span>'
  : `<label class="journal-pick"><input type="checkbox" data-change="toggleJournalPick" data-arg="${esc(t.key)}" aria-label="Pick ${esc(t.label)}"${state.journalPicked.includes(t.key) ? ' checked' : ''} /></label>`;

/** the symbol cell: the tick box in its own slot, then the name and its lines lined up after it */
const symCell = (t, main) => `<td><div class="journal-sym">${pickBox(t)}<div class="journal-sym-main">${main}</div></div></td>`;

/** the trade's name: it opens the trade sheet (a deleted one only offers Restore) */
export const nameOf = t => t.deleted ? `<b>${esc(t.label)}</b>`
  : `<button class="journal-name" data-action="openTradeReview" data-arg="${esc(t.key)}" aria-label="Open the ${esc(t.label)} trade"><b>${esc(t.label)}</b></button>`;
export const restoreLink = t => t.deleted ? `<span class="pos-sub journal-row-acts"><button class="pos-link" data-action="restoreTrade" data-arg="${esc(t.key)}" aria-label="Restore the ${esc(t.label)} trade">Restore</button></span>` : '';
/** a row opens its trade wherever it's tapped, except the tick box and the stop link (they have their own jobs) */
export const rowOpen = t => t.deleted ? '' : ` data-action="openTradeRow" data-arg="${esc(t.key)}"`;

/** a setup's chip in its parts, the action first and the level second ('Bounce | 8 EMA'), its name in the title; a pattern is its own name */
export const setupChip = s => {
  const lvl = s.levels.map(l => l.name).join(' + ');
  const parts = s.kind || lvl ? `${s.kind ? `<span class="journal-setup-act">${esc(s.kind.name)}</span>` : ''}${lvl ? `<span class="journal-setup-lvl">${esc(lvl)}</span>` : ''}` : esc(s.name);
  return `<span class="journal-setup" title="${esc(s.name)}">${parts}</span>`;
};
/** the trade's setups, each in its parts; a dash before any are picked */
function setupsCell(t) {
  const list = setupsOf(t);
  return list.length ? `<td class="journal-setups">${list.map(setupChip).join('')}</td>` : '<td class="journal-setups-none">—</td>';
}

// ---------- the trades table's columns: Symbol always, the rest yours to hide (journal_hidden_cols, this device only) ----------

/** the columns after Symbol, in table order: [key, header] */
export const TRADE_COLS = [
  ['pnlPct', 'P&amp;L %'], ['pnl', 'P&amp;L'], ['r', 'R'], ['stop', 'Stop'], ['setups', 'Setups'], ['side', 'Side'],
  ['qty', 'Qty'], ['entry', 'Entry'], ['exit', 'Exit'], ['hold', 'Hold'], ['opened', 'Opened'],
];
const shownTradeCols = () => TRADE_COLS.filter(([key]) => !state.journalHiddenCols.includes(key));
/** a column's header: Opened names the zone its times are in */
const colHead = (key, label) => key === 'opened' ? `${label} (${zoneAbbr()})` : label;

/** the Columns button: shows or hides the column picker */
export function toggleJournalColumnsMenu() { state.journalColsOpen = !state.journalColsOpen; renderJournal(); }

/** a column chip: hides or shows that column (one stays: a table of names alone says nothing) */
export function toggleJournalColumn(key) {
  if (!TRADE_COLS.some(([k]) => k === key)) return;
  const hidden = state.journalHiddenCols.includes(key);
  if (!hidden && shownTradeCols().length === 1) return;
  state.journalHiddenCols = TRADE_COLS.map(([k]) => k).filter(k => k === key ? !hidden : state.journalHiddenCols.includes(k));
  store.set('journal_hidden_cols', JSON.stringify(state.journalHiddenCols));
  renderJournal();
}

function columnPicker() {
  if (!state.journalColsOpen) return '';
  const last = shownTradeCols().length === 1;
  return `<div class="chip-row pos-cols journal-cols" role="group" aria-label="Columns">${TRADE_COLS.map(([key, label]) => {
    const on = !state.journalHiddenCols.includes(key);
    return `<button class="filter-btn${on ? ' active' : ''}" data-action="toggleJournalColumn" data-arg="${key}" aria-pressed="${on}"${on && last ? ' disabled title="Keep one column"' : ''}>${colHead(key, label)}</button>`;
  }).join('')}</div>`;
}

/** the row's cells in the columns shown */
const colCells = cells => shownTradeCols().map(([key]) => cells[key]).join('\n    ');

export const signedPct = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`;
/** what the percent is of: what it cost, what a short took in, a spread's risk */
export function pctTitleOf(t, basis) {
  const open = t.status === 'open';
  if (t.legs) return `Of the ${fmt$(basis)} ${t.rBasis === 'width' ? 'at risk (the width less the credit)' : t.rBasis === 'debit' ? 'debit paid' : 'credit taken in'}`;
  return t.direction === 'short' ? `Of the ${fmt$(basis)} taken in${open ? ' for the part covered' : ''}` : `Of the ${fmt$(basis)} paid${open ? ' for the part sold' : ''}`;
}
/** P&L % of what the closed part cost; a dash before anything closed */
function pctCell(t) {
  const basis = pnlBasis(t), pct = pnlPct(t);
  if (pct === null || basis === null) return `<td>—</td>`;
  return `<td class="${pnlClass(t.pnl)}" title="${esc(pctTitleOf(t, basis))}">${signedPct(pct)}${t.status === 'open' ? '<span class="pos-sub">so far</span>' : ''}</td>`;
}

/** a close whose purchase is older than the history: what's known (the exits), the rest blank */
function historyRow(t) {
  return `<tr class="journal-history${t.deleted ? ' journal-deleted' : ''}" title="${esc(HISTORY_TITLE)}"${rowOpen(t)}>
    ${symCell(t, `${nameOf(t)} <span class="journal-tag journal-tag-history">before your history</span>${t.deleted ? ' <span class="journal-tag">deleted</span>' : ''}${restoreLink(t)}`)}
    ${colCells({
      pnlPct: '<td>—</td>', pnl: '<td>—</td>', r: '<td>—</td>', stop: '<td>—</td>', setups: '<td>—</td>', side: sideCell(t),
      qty: `<td>${t.entryQty}</td>`, entry: '<td>—</td>', exit: `<td>${t.avgExit === null ? '—' : px(t.avgExit, t.assetType)}</td>`, hold: '<td>—</td>', opened: '<td>earlier</td>',
    })}
  </tr>`;
}

function tradeRow(t) {
  if (t.status === 'history') return historyRow(t);
  const open = t.status === 'open';
  const cls = [open ? 'journal-open' : '', t.deleted ? 'journal-deleted' : ''].filter(Boolean).join(' ');
  return `<tr${cls ? ` class="${cls}"` : ''}${rowOpen(t)}>
    ${symCell(t, `${nameOf(t)}${reviewedMark(t)}${t.legs ? ` <span class="journal-tag journal-tag-quiet">${esc(t.structure || `${t.spreadKind} spread`)}</span>` : ''}${open ? ' <span class="journal-tag">open</span>' : ''}${t.expired ? ` <span class="journal-tag journal-tag-quiet" title="${esc(EXPIRED_TITLE)}">expired</span>` : ''}${t.via ? ` <span class="journal-tag journal-tag-quiet" title="${esc(VIA_TITLE[t.via])}">${t.via}</span>` : ''}${t.deleted ? ' <span class="journal-tag">deleted</span>' : ''}${t.legs ? `<span class="pos-sub journal-legs">${esc(legWords(t.legs))}</span>` : t.kind === 'merged' ? `<span class="pos-sub journal-legs">${t.parts.length} trades merged</span>` : ''}${restoreLink(t)}`)}
    ${colCells({
      pnlPct: pctCell(t),
      pnl: `<td class="${open && !t.exits ? '' : pnlClass(t.pnl)}"${pnlTitle(t)}>${open && !t.exits ? '—' : signed$(t.pnl)}${pnlSub(t)}</td>`,
      r: `<td title="${esc(rTitleOf(t))}">${t.r === null ? '—' : signedR(t.r)}</td>`,
      stop: `<td>${stopCell(t)}</td>`,
      setups: setupsCell(t),
      side: sideCell(t),
      qty: `<td>${t.entryQty}${open && t.openQty !== t.entryQty ? `<span class="pos-sub">${t.openQty} open</span>` : ''}</td>`,
      entry: `<td>${px(t.avgEntry, t.assetType)}</td>`,
      exit: `<td>${t.avgExit === null ? '—' : px(t.avgExit, t.assetType)}</td>`,
      hold: `<td>${open ? 'open' : esc(holdWords(t.holdMs))}</td>`,
      opened: `<td>${esc(clockTime(t.openedAt))}</td>`,
    })}
  </tr>`;
}

/** the trades and fills the filters let through */
function filtered(list, sideOf) {
  const q = state.journalSymbol.trim().toUpperCase();
  return list.filter(x => (state.journalSide === 'all' || sideOf(x) === state.journalSide) && (!q || (x.label || x.symbol).toUpperCase().includes(q)));
}
/** the trades tab, narrowed to a day picked on the calendar (the trades with an exit that New York day) */
/** the review chips: To review (the deck's queue), Reviewed, and No setup (nothing labelled yet); All lets every trade through */
export const reviewsRead = () => !!state.journalReview && !state.journalReviewError;
export const isReviewed = t => reviewsRead() && t.status !== 'history' && tradeReviewState(t).reviewed;
export const untagged = t => reviewsRead() && t.status !== 'history' && !setupsOf(t).length;
const isOpen = t => t.status === 'open';
const REVIEW_TESTS = { open: isOpen, todo: toReview, done: isReviewed, untagged };
const onReviewFilter = list => REVIEW_TESTS[state.journalReviewFilter] ? list.filter(REVIEW_TESTS[state.journalReviewFilter]) : list;
/** the setup filter: only the trades that carry that setup, that kind (any bounce) or that level (Trades, Calendar and Stats) */
const onSetupFilter = list => state.journalSetupFilter ? list.filter(t => setupMatches(t, state.journalSetupFilter)) : list;
export function setJournalSetupFilter(v) { state.journalSetupFilter = String(v || ''); renderJournal(); }
export function setJournalReviewFilter(v) { state.journalReviewFilter = v in REVIEW_TESTS ? v : 'all'; renderJournal(); }
const onPickedDay = list => state.journalDay ? list.filter(t => exitDays(t).has(state.journalDay)) : list;
/** the Trades tab's dates (state.journalFrom / journalTo, either may be blank): a trade opened then, or with an exit then */
const onDates = list => {
  const from = state.journalFrom || '0000', to = state.journalTo || '9999', inside = d => d >= from && d <= to;
  if (!state.journalFrom && !state.journalTo) return list;
  return list.filter(t => (t.openedAt && inside(nyParts(t.openedAt).day)) || [...exitDays(t)].some(inside));
};
/** Trades from … to …: either end may be blank (From alone: that day on), a From after To swaps them */
export function setJournalDates(end, value) {
  const v = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : '';
  if (end === 'to') state.journalTo = v; else state.journalFrom = v;
  if (state.journalFrom && state.journalTo && state.journalFrom > state.journalTo) [state.journalFrom, state.journalTo] = [state.journalTo, state.journalFrom];
  renderJournal();
}
export function clearJournalDates() { state.journalFrom = ''; state.journalTo = ''; renderJournal(); }
/** the Trades tab's date boxes, All dates once either is set */
function datesHtml() {
  const today = nyParts(new Date().toISOString()).day, set = state.journalFrom || state.journalTo;
  return `<span class="journal-dates${set ? ' active' : ''}"><label class="jr-from">Trades from <input type="date" id="journalFrom" value="${state.journalFrom}" max="${today}" data-change="setJournalDates" data-arg="from" aria-label="Show trades from this day" /></label><label class="jr-from">to <input type="date" id="journalTo" value="${state.journalTo}" data-change="setJournalDates" data-arg="to" aria-label="Show trades up to this day" /></label>${set ? '<button class="pos-link" data-action="clearJournalDates">All dates</button>' : ''}</span>`;
}

function summaryLine(trades, deleted) {
  const s = tradesSummary(trades);
  const deletedNote = deleted ? ` · ${deleted} deleted <button class="pos-link" data-action="toggleDeletedTrades">${state.journalShowDeleted ? 'Hide them' : 'Show'}</button>` : '';
  if (!s.closed && !s.open && !s.history) return `No trades match.${deletedNote}`;
  const parts = [`${s.closed} closed`];
  if (s.closed) parts.push(`${s.wins} won (${s.winRate}%)`, `<span class="${pnlClass(s.pnl)}">${signed$(s.pnl)}</span> ${feeWords()}${journalAfterFees() && s.fees ? ` (fees ${fmt$(s.fees)})` : ''}`);
  if (s.closed && journalAfterFees() && s.feesMissing) parts.push(`<span class="journal-fees-missing">fees not in yet on ${s.feesMissing}</span>`);
  const avg = [s.avgPct !== null ? `<span class="${pnlClass(s.avgPct)}">${signedPct(s.avgPct)}</span>` : '', s.avgR !== null ? `${signedR(s.avgR)} over ${s.withR}` : ''].filter(Boolean);
  if (avg.length) parts.push(`average ${avg.join(', ')}`);
  if (s.open) parts.push(`${s.open} open`);
  if (s.history) parts.push(`<span class="journal-fees-missing" title="${esc(HISTORY_TITLE)}">${s.history} from before your history</span>`);
  return parts.join(' · ') + deletedNote;
}

/** the setup filter's menu: each kind (any bounce) with its setups under it, then each level; shown once there's one */
function setupFilter(all) {
  if (state.journalTab === 'fills' || state.journalTab === 'setups') return '';
  const { setups, levels } = setupMenu(all);
  if (!setups.length && !state.journalSetupFilter) return '';
  const opt = o => `<option value="${esc(o.value)}"${o.value === state.journalSetupFilter ? ' selected' : ''}>${o.depth ? '&nbsp;&nbsp;&nbsp;' : ''}${esc(o.name)} (${o.count})</option>`;
  return `<select id="journalSetupFilter" class="journal-setup-filter${state.journalSetupFilter ? ' active' : ''}" data-change="setJournalSetupFilter" aria-label="Filter by setup">
      <option value="">All setups</option>${setups.map(opt).join('')}${levels.length ? `<optgroup label="Any setup at">${levels.map(opt).join('')}</optgroup>` : ''}
    </select>`;
}

function controls(all = [], navigationOnly = false) {
  const on = (current, v) => `class="${current === v ? 'active' : ''}" aria-pressed="${current === v}"`;
  const tab = (v, label) => `<button ${on(state.journalTab, v)} data-action="setJournalTab" data-arg="${v}">${label}</button>`;
  const side = (v, label) => `<button ${on(state.journalSide, v)} data-action="setJournalSide" data-arg="${v}">${label}</button>`;
  const fees = journalAfterFees() ? 'after' : 'before';
  const fee = (v, label) => `<button ${on(fees, v)} data-action="setJournalFees" data-arg="${v}">${label}</button>`;
  const tabs = `<div class="seg journal-tabs journal-nav" aria-label="Show">${tab('trades', 'Trades')}${tab('calendar', 'Calendar')}${tab('missed', 'Missed')}${tab('stats', 'Stats')}${tab('setups', 'Setups')}${tab('books', '<span class="mb-tab-long">Model books</span><span class="mb-tab-short">Books</span>')}${tab('features', 'Features')}${tab('fills', 'Fills')}</div>`;
  if (state.journalTab === 'books' || state.journalTab === 'features' || state.journalTab === 'missed' || navigationOnly) return `<div class="journal-controls">${tabs}</div>`;
  const symbol = `<input type="search" id="journalSymbol" placeholder="Symbol" value="${esc(state.journalSymbol)}" autocomplete="off" spellcheck="false" data-input="journalSymbolChanged" aria-label="Filter by symbol" />`;
  const dayChip = state.journalTab === 'trades' && state.journalDay ? `<button class="filter-btn active jc-daychip" data-action="clearJournalDay" aria-label="Show every day">Exits ${+state.journalDay.slice(5, 7)}/${+state.journalDay.slice(8)} ×</button><button class="pos-link" data-action="openJournalStats" data-arg="day" data-arg2="${state.journalDay}">The day's stats</button>` : '';
  if (mq(PHONE_MQ)) {
    // phones: the symbol box, Filters (how many are on) and Select on one line; the rest opens under it
    const trades = state.journalTab === 'trades';
    const on = (state.journalSetupFilter && setupFilter(all) ? 1 : 0) + (state.journalSide !== 'all' ? 1 : 0) + (trades && reviewFrom() ? 1 : 0) + (trades && (state.journalFrom || state.journalTo) ? 1 : 0);
    const open = state.journalFiltersOpen;
    return `<div class="journal-controls">
    ${tabs}
    <div class="journal-phone-bar">${symbol}
      <button class="btn journal-filters-btn${on ? ' active' : ''}" data-action="toggleJournalFilters" aria-expanded="${open}">Filters${on ? ` <b>${on}</b>` : ''}</button>
      ${trades ? `<button class="btn journal-cols-btn" data-action="toggleJournalSelect" aria-pressed="${state.journalSelecting}">${state.journalSelecting ? 'Done' : 'Select'}</button>` : ''}
    </div>
    ${open ? `<div class="journal-filters">
      ${setupFilter(all)}
      <div class="seg" aria-label="Side">${side('all', 'All')}${side('long', 'Long')}${side('short', 'Short')}</div>
      ${state.journalTab !== 'fills' ? `<div class="seg" aria-label="P&amp;L">${fee('before', 'Before fees')}${fee('after', 'After fees')}</div>` : ''}
      ${trades ? datesHtml() : ''}
      ${trades ? reviewFromHtml(all) : ''}
    </div>` : ''}
    ${dayChip ? `<div class="journal-filters">${dayChip}</div>` : ''}
    ${trades ? reviewChips(all, false) : ''}
  </div>`;
  }
  return `<div class="journal-controls">
    ${tabs}
    <div class="journal-filters">
      ${symbol}
      ${setupFilter(all)}
      <div class="seg" aria-label="Side">${side('all', 'All')}${side('long', 'Long')}${side('short', 'Short')}</div>
      ${state.journalTab !== 'fills' ? `<div class="seg" aria-label="P&amp;L">${fee('before', 'Before fees')}${fee('after', 'After fees')}</div>` : ''}
      ${state.journalTab === 'trades' ? datesHtml() : ''}
      ${dayChip}
    </div>
    ${state.journalTab === 'trades' ? reviewChips(all, true, mq(DESKTOP_MQ) ? `<button class="btn journal-cols-btn" data-action="toggleJournalSelect" aria-pressed="${state.journalSelecting}">${state.journalSelecting ? 'Done' : 'Select'}</button>${layoutSwitchHtml()}` : '') : ''}
  </div>`;
}

/** All · Open (while any is) · To review · Reviewed · No setup, each with how many of the trades the other filters leave */
function reviewChips(all, withFrom = true, end = '') {
  const base = onSetupFilter(onPickedDay(onDates(filtered(all, t => t.bias)))).filter(t => !t.deleted);
  const chip = (v, label, n) => `<button class="journal-chip${state.journalReviewFilter === v ? ' active' : ''}" aria-pressed="${state.journalReviewFilter === v}" data-action="setJournalReviewFilter" data-arg="${v}">${label} <b>${n}</b></button>`;
  const more = reviewsRead() ? chip('done', 'Reviewed', base.filter(isReviewed).length) + chip('untagged', 'No setup', base.filter(untagged).length) : '';
  const open = base.filter(isOpen).length;
  return `<div class="journal-chips-row"><div class="journal-chips" aria-label="Review">${chip('all', 'All', base.length)}${open || state.journalReviewFilter === 'open' ? chip('open', 'Open', open) : ''}${chip('todo', 'To review', base.filter(toReview).length)}${more}</div>${withFrom ? reviewFromHtml(all) : ''}${end ? `<span class="journal-chips-end">${end}</span>` : ''}</div>`;
}

/** what's ticked, Delete beside the count (away from Merge), why it can't be one trade (or Merge), and Clear;
 * it follows the table and sticks to the screen's bottom */
function pickBar(all) {
  const picked = all.filter(t => state.journalPicked.includes(t.key));
  if (!picked.length) return '';
  const why = state.journalSavedError ? 'Merging needs the database update: npx supabase db push.' : picked.length > 1 ? mergeProblem(picked) : '';
  const off = why || picked.length < 2 || state.journalMerging ? ' disabled' : '';
  const note = why ? `<span class="journal-why">${esc(why)}</span>` : picked.length < 2 ? '<span>Tick another to merge.</span>' : '';
  const delOff = state.tradeReviewsError || state.tradeReviewBusy ? ' disabled' : '';
  return `<div class="journal-pickbar" role="status"><span>${picked.length} picked</span><button class="btn journal-danger" data-action="deletePicked"${delOff}>Delete</button>${note}
    <span class="journal-pickbar-acts"><button class="btn primary" data-action="mergePicked"${off}>${state.journalMerging ? 'Merging…' : 'Merge into one trade'}</button><button class="btn" data-action="clearJournalPicks">Clear</button></span></div>`;
}

// ---------- phones: a card per trade (journal-cards.js) ----------

/** a phone turned sideways (or a window resized) swaps cards and table */
let phoneWatched = false;
function watchPhone() {
  if (phoneWatched || !window.matchMedia) return;
  phoneWatched = true;
  window.matchMedia(PHONE_MQ).addEventListener?.('change', () => { if (state.journalView) renderJournal(); });
}

/** open trades first (the phone cards' order too), each part newest first */
const openFirst = list => [...list.filter(isOpen), ...list.filter(t => !isOpen(t))];
/** the Trades tab's trades: its side, symbol, dates, day, review and setup filters, open ones first, newest first */
const tradesTabList = all => openFirst(onSetupFilter(onReviewFilter(onPickedDay(onDates(filtered(all, t => t.bias))))));
/**
 * The trades a trade page's arrows step through: the Trades tab as it's filtered now (deleted ones only while shown), or
 * every trade when the page opened from somewhere the trade isn't in that list (the calendar, a setup's page)
 * @param {string} key
 */
export function journalNavKeys(key) {
  const all = currentTrades(), shown = tradesTabList(all).filter(t => state.journalShowDeleted || !t.deleted);
  return (shown.some(t => t.key === key) ? shown : all.filter(t => !t.deleted || t.key === key)).map(t => t.key);
}

function tradesView(all) {
  // deleted trades never count in the stats; shown (dimmed) only to restore one
  const counted = all.filter(t => !t.deleted);
  const deleted = all.length - counted.length;
  const trades = state.journalShowDeleted ? all : counted;
  if (!trades.length) return `<p class="hint">No trades match.${deleted ? ` ${deleted} deleted. <button class="pos-link" data-action="toggleDeletedTrades">Show</button>` : ''}</p>`;
  watchPhone();
  const shown = trades.slice(0, JOURNAL_SHOWN);
  const phone = mq(PHONE_MQ);
  const list = phone ? phoneTradesHtml(shown, counted, deleted) : `${columnPicker()}<div class="positions-wrap"><table class="positions-table journal-table">
      <thead><tr><th scope="col">Symbol</th>${shownTradeCols().map(([key, label]) => `<th scope="col">${colHead(key, label)}</th>`).join('')}</tr></thead>
      <tbody>${shown.map(tradeRow).join('')}</tbody>
    </table></div>`;
  // phones hide the tick boxes until Select (in the bar above: bulk Merge and Delete are rare), and show the summary as tiles
  const colsBtn = `<button class="btn journal-cols-btn" data-action="toggleJournalColumnsMenu" aria-expanded="${state.journalColsOpen}" title="Show or hide the table's columns">Columns</button>`;
  return `${phone ? '' : `<div class="journal-summary-row"><p class="hint journal-summary">${summaryLine(counted, deleted)}</p>${colsBtn}</div>`}
    ${list}${pickBar(trades)}
    ${trades.length > JOURNAL_SHOWN ? `<p class="hint">Showing the newest ${JOURNAL_SHOWN} of ${trades.length} trades.</p>` : ''}
    <details class="hint-details"><summary>How trades are built</summary><p class="hint">Trades run from flat back to flat, matched first in first out. Tap a trade for its page: the charts with your fills, how far it went for and against you, your review (labels, both grades, an entry note while it's live and an exit note after; To review lists the ones still waiting), and Edit for your stop, separate or delete. Tick trades to Merge two or more into one (a re-entry, a spread's legs), or to Delete ones that don't belong; imports won't bring them back. ${journalAfterFees()
      ? 'P&amp;L is after Schwab\'s fees (commission, SEC, TAF and option fees, from its trade records), split by quantity when one order covers two trades.'
      : 'P&amp;L is before fees.'} R uses your stop when you've set one, else the first Schwab stop order on the loss side of your entry (moving it later doesn't change R); a long option with no stop risks its premium.${trades.some(t => t.status === 'history') ? ' <b>Before your history</b> marks sells and covers whose purchase is older than Schwab\'s 60 days of orders: they don\'t count. Delete them, or File upload will fill them in once it lands.' : ''}${trades.some(t => t.status === 'history' && t.assetType === 'FUTURE') ? ' For futures it means older than the thinkorswim statement: import one that starts earlier.' : ''}${trades.some(t => t.expired) ? ' Options still open after expiry close at $0, assumed worthless.' : ''}${trades.some(t => t.via) ? ' An assigned or exercised option closes at $0 the day it happened, and its shares count at the strike.' : ''}</p></details>`;
}

function fillsView(fills) {
  if (!fills.length) return '<p class="hint">No fills match.</p>';
  return `<div class="positions-wrap"><table class="positions-table journal-table">
      <thead><tr><th scope="col">Symbol</th><th scope="col">Action</th><th scope="col">Qty</th><th scope="col">Price</th><th scope="col">Value</th><th scope="col">Time (${zoneAbbr()})</th></tr></thead>
      <tbody>${fills.slice(0, JOURNAL_SHOWN).map(fillRow).join('')}</tbody>
    </table></div>
    <p class="hint">${fills.length > JOURNAL_SHOWN ? `Showing the newest ${JOURNAL_SHOWN} of ${fills.length} fills. ` : `${fills.length} fill${fills.length === 1 ? '' : 's'}. `}Fills are read from your saved Schwab orders.</p>`;
}

export function setJournalFees(v) { store.set('journal_fees', v === 'after' ? 'after' : 'before'); renderJournal(); }
export function toggleDeletedTrades() { state.journalShowDeleted = !state.journalShowDeleted; renderJournal(); }
/** a day's notebook page is open, in place of the calendar (it works before any import: a plan needs no trades) */
const notebookOpen = () => state.journalTab === 'calendar' && !!state.journalNotebookDay;
export function setJournalTab(tab) {
  state.journalTab = ['fills', 'calendar', 'missed', 'stats', 'setups', 'books', 'features'].includes(tab) ? tab : 'trades';
  state.journalNotebookDay = ''; // the Calendar tab goes back to the calendar
  state.notebookBack = '';
  if (state.journalTab !== 'trades') state.journalDay = '';
  renderJournal();
  if (state.journalTab === 'books' && (!state.modelBooks.loaded || state.modelBooks.owner !== state.session?.user?.id)) loadModelBooks();
}
/** a day on the calendar: the trades with an exit then */
export function pickJournalDay(day) { state.journalDay = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ''; state.journalTab = 'trades'; state.journalNotebookDay = ''; renderJournal(); }
export function clearJournalDay() { state.journalDay = ''; renderJournal(); }
export function shiftJournalMonth(by) { state.journalMonth = nextJournalMonth(by); state.journalReviewPeriod = null; renderJournal(); }
export function journalThisMonth() { state.journalMonth = thisMonth(); state.journalReviewPeriod = null; renderJournal(); }
/** Month | Dates on the calendar: Dates start as the month shown, Month comes back to the month the dates end in */
export function setCalendarDates(mode) {
  const on = isRangeKey(state.journalCalDates);
  if ((mode === 'dates') === on) return;
  if (on) state.journalMonth = periodSpan('range', state.journalCalDates)[1].slice(0, 7);
  state.journalCalDates = on ? '' : rangeKey(...periodSpan('month', state.journalMonth || state.journalMonthShown || thisMonth()));
  state.journalReviewPeriod = null;
  renderJournal();
}
/** the calendar's dates: a new first or last day, the other kept (swapped when they cross) */
export function setCalendarRange(end, value) {
  if (!isRangeKey(state.journalCalDates)) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return renderJournal(); // a cleared box gets its day back
  const [from, to] = periodSpan('range', state.journalCalDates);
  state.journalCalDates = end === 'to' ? rangeKey(from, value) : rangeKey(value, to);
  renderJournal();
}
/** the trades the stats count from: the side, symbol and setup filters applied, as the Stats tab shows them */
const statsTrades = () => onSetupFilter(filtered(currentTrades(), t => t.bias));
/** All time / Month / Week / Day / Dates on the stats: a new unit keeps your place (the newest close in what's shown now; Dates start as the span shown) */
export function setJournalPeriod(unit) {
  const to = PERIODS.includes(unit) || unit === 'range' ? unit : 'all';
  if (to === state.journalPeriod) return;
  state.journalPeriodKey = to === 'all' ? '' : switchPeriod(statsTrades(), state.journalPeriod, state.journalPeriodShown, to);
  state.journalPeriod = to;
  renderJournal();
}
/** Dates: a new first or last day, the other kept (swapped when they cross) */
export function setStatsDates(end, value) {
  if (state.journalPeriod !== 'range') return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return renderJournal(); // a cleared box gets its day back
  const [from, to] = isRangeKey(state.journalPeriodShown) ? periodSpan('range', state.journalPeriodShown) : [value, value];
  state.journalPeriodKey = end === 'to' ? rangeKey(from, value) : rangeKey(value, to);
  renderJournal();
}
/** ‹ or ›: the nearest day, week or month with closed trades before or after the one shown */
export function stepJournalPeriod(by) {
  if (!PERIODS.includes(state.journalPeriod)) return;
  const next = stepPeriod(activePeriods(statsTrades(), state.journalPeriod), state.journalPeriodShown, Number(by) || 0);
  if (next) { state.journalPeriodKey = next; renderJournal(); }
}
/** the stats for one day, week or month, or the calendar's dates, from the calendar or a day's trades */
export function openJournalStats(unit, key) {
  const range = unit === 'range' && isRangeKey(key);
  const ok = range || (PERIODS.includes(unit) && (unit === 'month' ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/).test(key || ''));
  state.journalPeriod = ok ? unit : 'all';
  state.journalPeriodKey = range ? key : ok ? periodKey(key, unit) : '';
  state.journalTab = 'stats';
  state.journalDay = '';
  state.journalNotebookDay = '';
  renderJournal();
}
/** the Setups tab: one setup's page, and back to them all */
export function openJournalSetup(key) { state.journalSetupKey = String(key || ''); renderJournal(); }
export function closeJournalSetup() { state.journalSetupKey = ''; renderJournal(); }
/** from a setup's page: its trades, stats or calendar (the setup filter set to it), or its model book examples */
export function showSetupIn(tab) {
  const key = state.journalSetupKey;
  if (!key) return;
  if (tab === 'books') { setJournalTab('books'); return selectModelSetup(key); } // after: a first read there starts from an empty state
  state.journalSetupFilter = key;
  setJournalTab(['stats', 'calendar'].includes(tab) ? tab : 'trades');
}
export function setJournalSide(side) { state.journalSide = ['long', 'short'].includes(side) ? side : 'all'; renderJournal(); }
export function journalSymbolChanged() {
  state.journalSymbol = document.getElementById('journalSymbol').value;
  renderJournal();
  const el = document.getElementById('journalSymbol'); // the redraw replaced the box: keep typing in it
  if (el && el.focus) { el.focus(); if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length); }
}

// ---------- the desktop: the Workbench's rail, and the Trades tab beside a panel or the review queue ----------

/** the Workbench rail's tabs, one per line, the trades counted */
function railNav(all) {
  const n = all.filter(t => !t.deleted).length;
  const tab = (v, label, count = '') => `<button class="${state.journalTab === v ? 'active' : ''}" aria-pressed="${state.journalTab === v}" data-action="setJournalTab" data-arg="${v}"><span>${label}</span>${count !== '' ? `<span class="jb-nav-n">${count}</span>` : ''}</button>`;
  return `<nav class="jb-nav journal-nav" aria-label="Show">${tab('trades', 'Trades', n || '')}${tab('calendar', 'Calendar')}${tab('missed', 'Missed')}${tab('stats', 'Stats')}${tab('setups', 'Setups')}${tab('books', 'Model books')}${tab('features', 'Features')}${tab('fills', 'Fills')}</nav>`;
}

/** the rail's filters: what the tab shown takes (the same as the bar over the list on narrower screens) */
function railFilters(all) {
  if (['books', 'features', 'missed'].includes(state.journalTab)) return '';
  const on = (current, v) => `class="${current === v ? 'active' : ''}" aria-pressed="${current === v}"`;
  const side = (v, label) => `<button ${on(state.journalSide, v)} data-action="setJournalSide" data-arg="${v}">${label}</button>`;
  const fees = journalAfterFees() ? 'after' : 'before';
  const fee = (v, label) => `<button ${on(fees, v)} data-action="setJournalFees" data-arg="${v}">${label}</button>`;
  const trades = state.journalTab === 'trades';
  const dayChip = trades && state.journalDay ? `<div class="jb-daychip"><button class="filter-btn active jc-daychip" data-action="clearJournalDay" aria-label="Show every day">Exits ${+state.journalDay.slice(5, 7)}/${+state.journalDay.slice(8)} ×</button><button class="pos-link" data-action="openJournalStats" data-arg="day" data-arg2="${state.journalDay}">The day's stats</button></div>` : '';
  return `<div class="jb-filters journal-controls" role="group" aria-label="Filters">
      <div class="jb-filters-title">Filters</div>
      <input type="search" id="journalSymbol" placeholder="Symbol" value="${esc(state.journalSymbol)}" autocomplete="off" spellcheck="false" data-input="journalSymbolChanged" aria-label="Filter by symbol" />
      ${setupFilter(all)}
      <div class="seg" aria-label="Side">${side('all', 'All')}${side('long', 'Long')}${side('short', 'Short')}</div>
      ${state.journalTab !== 'fills' ? `<div class="seg" aria-label="P&amp;L">${fee('before', 'Before fees')}${fee('after', 'After fees')}</div>` : ''}
      ${trades ? datesHtml() : ''}
      ${trades ? reviewFromHtml(all) : ''}
      ${dayChip}
    </div>`;
}

/** the chips row's end on the Workbench: Select (tick boxes for Merge and Delete), Columns, the layout switch */
function benchTools() {
  return `<button class="btn journal-cols-btn" data-action="toggleJournalSelect" aria-pressed="${state.journalSelecting}">${state.journalSelecting ? 'Done' : 'Select'}</button><button class="btn journal-cols-btn" data-action="toggleJournalColumnsMenu" aria-expanded="${state.journalColsOpen}" title="Show or hide the table's columns">Columns</button>${layoutSwitchHtml()}`;
}

/** the desktop Trades tab: the list (Workbench table or Review desk cards) with the pick bar, and the column beside it */
function desktopTradesView(all) {
  const counted = all.filter(t => !t.deleted), deleted = all.length - counted.length;
  const trades = state.journalShowDeleted ? all : counted;
  if (!trades.length) return { main: `<p class="hint">No trades match.${deleted ? ` ${deleted} deleted. <button class="pos-link" data-action="toggleDeletedTrades">Show</button>` : ''}</p>`, side: '' };
  const shown = trades.slice(0, JOURNAL_SHOWN);
  const { main, side } = journalLayout() === 'desk' ? deskTradesHtml(shown, counted, deleted) : benchTradesHtml(shown, counted, deleted);
  return { side, main: `${main}${pickBar(trades)}${trades.length > JOURNAL_SHOWN ? `<p class="hint">Showing the newest ${JOURNAL_SHOWN} of ${trades.length} trades.</p>` : ''}` };
}

/** the Workbench's ↑ ↓ step through the trades as the table shows them */
export const benchKeys = () => {
  const all = tradesTabList(currentTrades()), shown = (state.journalShowDeleted ? all : all.filter(t => !t.deleted)).slice(0, JOURNAL_SHOWN);
  return [...shown.filter(isOpen), ...shown.filter(t => !isOpen(t)).sort((a, b) => closeKey(b) < closeKey(a) ? -1 : closeKey(b) > closeKey(a) ? 1 : 0)].map(t => t.key);
};
const closeKey = t => nyParts(t.closedAt || t.openedAt).day;

export function renderJournal() {
  const el = document.getElementById('journalSection');
  if (!el) return;
  syncJournalPage();
  if (state.journalTrade) renderJournalTrade(); // the page reads the same records, stops and deletes
  else if (state.journalDeck?.finished) renderDeckEnd();
  if (!state.session && state.sessionResuming) {
    el.innerHTML = `<div class="card empty-card"><p>Loading your journal…</p></div>`;
    return;
  }
  if (!state.session) {
    syncJournalBadge(null);
    el.innerHTML = `<div class="card empty-card"><div class="setup-title">Sign in to keep your journal</div><p>Your Schwab orders and trades are kept in your account, so sign in with Google first. Then connect Schwab and import.</p><button class="btn primary" data-action="openSheet" data-arg="settings">Open settings</button></div>`;
    return;
  }
  const records = state.journalRecords || [];
  const fills = fillsFrom(records);
  const canImport = schwabConnected();
  const books = state.journalTab === 'books';
  const all = fills.length ? currentTrades() : [];
  syncJournalBadge(all);
  const keys = new Set(all.map(t => t.key));
  state.journalPicked = state.journalPicked.filter(k => keys.has(k)); // a merge or a re-read can retire a key
  const scrolled = el.querySelector?.('.positions-wrap')?.scrollLeft || 0; // a tick redraws the table: keep it where it was sideways
  // the head stays one line: the title, a quiet meta line (what's kept and the last import in full in its title and the
  // Import sheet), and the buttons; a features run shows on the meta line only while it goes or after it failed
  const head = `<span class="section-title">Journal</span>
      <span class="positions-meta journal-meta" id="journalKept" role="status"${books ? '' : ` title="${esc(metaTitle())}"`}>${books ? 'Your chart study library' : `${metaLine(all)}<span class="journal-features-line" id="journalFeaturesLine"${featuresLine() ? '' : ' hidden'}>${esc(featuresLine())}</span>`}</span>`;
  const importBtns = `<button class="btn" id="journalImportBtn" data-action="openJournalImport" title="Bring in trades: Schwab now, files later">${state.captureBusy ? 'Importing…' : 'Import'}</button>
        <button class="btn" id="journalExportBtn" data-action="openJournalExport" title="Take your data with you as a file">Export</button>`;
  const errors = `${!books && state.journalError ? `<p class="shares-error" role="status">Couldn't load your journal: ${esc(state.journalError)}</p>` : ''}
    ${!books && state.tradeReviewsError ? `<p class="hint" role="status" style="color:var(--amber)">Your stops and deleted trades couldn't load (${esc(state.tradeReviewsError)}). Trades show with Schwab's stops, deleted ones included.</p>` : ''}
    ${!books && state.journalSavedError ? `<p class="hint" role="status" style="color:var(--amber)">Merges unavailable: ${esc(state.journalSavedError)}. Trades show as the app groups them.</p>` : ''}`;
  const navOnly = !fills.length || notebookOpen();
  // the desktop's Trades tab: the Workbench or the Review desk, each a list and a column beside it
  const wide = mq(DESKTOP_MQ), deskTrades = wide && !books && !notebookOpen() && fills.length && state.journalTab === 'trades';
  const split = deskTrades ? desktopTradesView(tradesTabList(all)) : null;
  const body = split ? split.main : books ? '<div id="modelBooksBody"></div>' : notebookOpen() ? dayPageHtml() : state.journalTab === 'missed' ? missedTabHtml() : fills.length ? (state.journalTab === 'fills'
      ? fillsView(filtered(fills, fillBias))
      : state.journalTab === 'calendar' ? calendarView(onSetupFilter(filtered(all, t => t.bias))) + periodReviewHtml(all)
      : state.journalTab === 'stats' ? statsView(onSetupFilter(filtered(all, t => t.bias)))
      : state.journalTab === 'setups' ? setupsView(filtered(all, t => t.bias))
      : state.journalTab === 'features' ? featuresView(all)
      : tradesView(tradesTabList(all)))
    : `<p class="hint">${records.length ? 'No fills in the kept orders yet.' : 'Import saves your last 60 days of Schwab orders and up to a year of trades to your account. After that, the app keeps adding to it on its own.'}</p>`;
  // each pane keeps its place through the redraw while it shows the same thing (a new tab or day page starts at the top)
  const view = `${state.journalTab}:${state.journalNotebookDay}:${state.journalSetupKey}`;
  keepScroll(el, () => {
    el.innerHTML = !wide ? `<div class="card positions-card journal-card">
    <div class="positions-head">
      ${head}
      ${books ? '' : `<span class="journal-actions">
        ${todayButtonHtml()}
        ${deckButtonHtml(all)}
        ${importBtns}
      </span>`}
    </div>
    ${errors}
    ${controls(all, navOnly)}
    ${body}
  </div>` : journalLayout() === 'desk' ? `<div class="card positions-card journal-card jw-desk">
    <div class="positions-head">
      ${head}
      ${books ? '' : `<span class="journal-actions">
        ${todayButtonHtml()}
        ${deckButtonHtml(all)}
        ${importBtns}
      </span>`}
    </div>
    ${errors}
    ${controls(all, navOnly)}
    ${split ? `<div class="jw-split"><div class="jw-main" data-scroll="main:${view}">${body}</div><aside class="jw-side jd-side" data-scroll="side:trades" aria-label="Review queue">${split.side}</aside></div>`
      : `<div class="jw-main jw-one" data-scroll="main:${view}">${body}</div>`}
  </div>` : `<div class="card positions-card journal-card jw-bench${split ? ' jw-has-side' : ''}">
    <aside class="jb-rail" data-scroll="rail" aria-label="Journal">
      <div class="jb-title">${head}</div>
      ${books ? '' : `<div class="jb-acts">${deckButtonHtml(all)}${todayButtonHtml()}</div>`}
      ${railNav(all)}
      ${navOnly ? '' : railFilters(all)}
      ${books ? '' : `<div class="jb-foot">${importBtns}</div>`}
    </aside>
    <div class="jw-main" data-scroll="main:${view}">
      ${errors}
      ${split ? reviewChips(all, false, benchTools()) : ''}
      ${body}
    </div>
    ${split ? `<aside class="jw-side jb-side" data-scroll="side:trades" aria-label="The trade you picked">${split.side}</aside>` : ''}
  </div>`;
  });
  if (books) renderModelBooks();
  const wrap = scrolled && el.querySelector?.('.positions-wrap');
  if (wrap) wrap.scrollLeft = scrolled;
  if (state.journalTab === 'stats' && fills.length) drawJournalEquity(onSetupFilter(filtered(all, t => t.bias)));
  drawMissedChart();
  bindUpNext();
  growBoxes(el);
}

// ---------- Import and Export sheets ----------

/** Import: every source in one list. Schwab works now; file upload is where older history and Robinhood will come in */
export function renderImportSheet() {
  const el = document.getElementById('journalImportBody');
  if (!el) return;
  const acct = schwabAccount();
  const schwab = schwabConnected()
    ? `<div class="sheet-label">Schwab <span class="sheet-status"><span style="color:var(--green)">●</span> Connected · ••${esc(acct ? acct.last4 : '')}</span></div>
      <p class="hint" id="journalImportStatus" role="status">${statusLine()}</p>
      <p class="hint">${esc(keptWords())}</p>
      <div class="row" style="align-items:center;gap:8px;"><button class="btn primary" id="journalImportNow" data-action="journalImport"${state.captureBusy ? ' disabled' : ''}>${state.captureBusy ? 'Importing…' : 'Import now'}</button></div>
      <p class="hint">Saves your last 60 days of orders and up to a year of trades to your account. The app also imports on its own every 6 hours while you're signed in and connected.</p>`
    : `<div class="sheet-label">Schwab <span class="sheet-status">○ Not connected</span></div>
      <p class="hint">Log in to Schwab to import your orders and trades.</p>
      <div class="row" style="align-items:center;gap:8px;"><button class="btn" data-action="openSheet" data-arg="settings">Connect Schwab</button></div>`;
  el.innerHTML = `<div class="sheet-section">${schwab}</div>
    <div class="sheet-section" id="journalTosSection">${tosSectionHtml()}</div>
    <div class="sheet-section journal-soon">
      <div class="sheet-label">More files <span class="sheet-status">Coming soon</span></div>
      <p class="hint">For history older than Schwab's API reaches (Schwab's website export) and for Robinhood's account activity CSV. You'll see what will be added before anything is saved.</p>
    </div>`;
}

/** Export: the files you can take. Schwab history now; trades as CSV later */
export function renderExportSheet() {
  const el = document.getElementById('journalExportBody');
  if (!el) return;
  const history = schwabConnected()
    ? `<div class="row" style="align-items:center;gap:8px;"><button class="btn" id="schwabHistoryBtn" data-action="downloadSchwabHistory"${state.historyBusy ? ' disabled' : ''}>${state.historyBusy ? 'Reading Schwab…' : 'Download Schwab history'}</button></div>
      <p class="hint">A JSON file of your positions, the last 60 days of orders, and up to a year of trades, read from Schwab now. Account numbers are masked.</p>`
    : `<p class="hint">Log in to Schwab to download your history. <button class="pos-link" data-action="openSheet" data-arg="settings">Connect Schwab</button></p>`;
  el.innerHTML = `<div class="sheet-section"><div class="sheet-label">Schwab history (JSON)</div>${history}</div>
    <div class="sheet-section journal-soon">
      <div class="sheet-label">Trades (CSV) <span class="sheet-status">Coming soon</span></div>
      <p class="hint">Every trade with P&amp;L and R, for a spreadsheet or another journal.</p>
    </div>`;
}

export function openJournalImport() { renderImportSheet(); openSheet('journalImport'); }
export function openJournalExport() { renderExportSheet(); openSheet('journalExport'); }

/** read the kept records again and redraw */
export async function loadJournal() {
  if (!state.session) { renderJournal(); return; }
  state.journalLoading = true;
  renderJournal();
  // your stops and deletes come from their own table: if it can't be read, the trades still show
  const [records, reviews, saved] = await Promise.allSettled([loadSavedRecords(), loadTradeReviews(), loadSavedTrades(), loadJournalReview(), loadJournalShots(), loadPeriodReviewRows(), loadFeatureRows(), ...(state.journalTab === 'books' ? [loadModelBooks()] : [])]);
  let bars = null;
  try {
    if (records.status === 'rejected') throw records.reason;
    state.journalRecords = records.value;
    state.journalError = '';
    bars = maybeSaveBars({ records: records.value }); // quietly, in the background: the charts' bars before Tradier drops them
  } catch(e) {
    state.journalError = String(e?.message || e);
  } finally {
    if (reviews.status === 'fulfilled') { state.tradeReviews = reviews.value; state.tradeReviewsError = ''; }
    else state.tradeReviewsError = String(reviews.reason?.message || reviews.reason);
    if (saved.status === 'fulfilled') { state.journalSaved = saved.value; state.journalSavedError = ''; }
    else state.journalSavedError = String(saved.reason?.message || saved.reason);
    state.journalLoading = false;
    if (state.journalView) renderJournal();
  }
  // then the order plans: each one's setup and tactic onto the trade its order opened, and the plan on the trade page
  if (state.journalRecords) {
    await applyOrderPlans(currentTrades);
    if (state.orderPlanMatch?.size && state.journalView) renderJournal();
  }
  // then the features, once the bars they read are saved (and with the trades' keys as the Journal has them)
  if (bars) bars.finally(() => maybeStampFeatures());
}

/** the tab opened: show what's kept, and import quietly when it's due */
export function openJournal() {
  loadJournal();
  maybeCapture();
}

/** Import: save the latest from Schwab now */
export async function journalImport() {
  renderJournal();
  await captureNow();
}

// a capture started or finished: redraw (the Import sheet too when it's open), and after a save read the records again
onCaptureChange(saved => {
  if (state.openSheetName === 'journalImport') renderImportSheet();
  if (saved && !state.journalView) maybeSaveBars({ force: true }).finally(() => stampAfterImport(loadSavedRecords)); // an import landed: its trades' bars and features, journal open or not
  if (!state.journalView) return;
  if (saved) loadJournal(); else renderJournal();
});

// ---------- the trade sheet: your stop, and hiding a trade that doesn't belong ----------

/** the trades as the Journal has them now (your stops and deletes applied) */
export const journalTradeList = () => currentTrades();
function currentTrades() {
  const records = state.journalRecords || [];
  return journalTrades(fillsFrom(records), records, state.tradeReviews || {}, { afterFees: journalAfterFees(), now: Date.now(), saved: state.journalSaved, funds: myFunds() });
}
const reviewedTrade = () => currentTrades().find(t => t.key === state.tradeReviewKey) || null;
const reviewOf = key => (state.tradeReviews || {})[key] || { stop: null, deleted: false };

/** what the typed stop would make the risk and R, or why it can't be this trade's */
function stopPreview(t, raw) {
  if (!String(raw).trim()) return { text: '', ok: false };
  const price = Number(raw);
  const err = ownStopError(t, price);
  if (err) return { text: err, ok: false };
  const risk = riskAt(t, price);
  return { text: `Risk ${fmt$(risk)}${t.status === 'open' ? ', R once it closes' : ` · ${signedR(Math.round((t.pnl / risk) * 100) / 100)}`}`, ok: true };
}

function stopNowLine(t) {
  const rv = reviewOf(t.key);
  const ignored = t.ownStopIgnored ? ` Your stop ${px(rv.stop, t.assetType)} is past the entry, so it isn't used.` : '';
  if (t.stopSource === 'yours') return `Using your stop, ${px(t.stop, t.assetType)}. Risk ${fmt$(t.risk)}.${t.schwabStop !== null ? ` Schwab's first was ${px(t.schwabStop, t.assetType)}.` : ''}`;
  if (t.stopSource === 'schwab') {
    const first = t.stopTrail.find(x => x.stopPrice === t.stop);
    return `Using Schwab's first stop, ${px(t.stop, t.assetType)}${first ? ` (${esc(clockTime(first.entered))})` : ''}. Risk ${fmt$(t.risk)}.${t.movedTo !== null ? ` Moved to ${px(t.movedTo, t.assetType)} later: R still counts from the first.` : ''}${ignored}`;
  }
  if (t.rBasis === 'premium') return `No stop: the premium paid, ${fmt$(t.risk)}, is the risk. Set the stop you had in mind.${ignored}`;
  return `No stop, so no R. Set the stop you had in mind.${ignored}`;
}

const tradeFacts = t => t.legs
  ? [`${t.spreadKind === 'debit' ? 'Paid' : 'Took in'} ${px(t.avgEntry, 'SPREAD')} × ${t.entryQty}`, `opened ${esc(clockTime(t.openedAt))} ${zoneAbbr()}`,
    t.status === 'open' ? 'open' : `${signed$(t.pnl)} ${t.afterFees ? 'after' : 'before'} fees`].join(' · ')
  : t.status === 'history'
  ? `${t.direction === 'long' ? 'Sold' : 'Covered'} ${t.entryQty} at ${t.avgExit === null ? '—' : px(t.avgExit, t.assetType)} · bought before your history, so no P&amp;L`
  : [`${t.direction === 'long' ? 'Long' : 'Short'} ${t.entryQty} at ${px(t.avgEntry, t.assetType)}`, `opened ${esc(clockTime(t.openedAt))} ${zoneAbbr()}`,
  t.status === 'open' ? 'open' : `${signed$(t.pnl)} ${t.afterFees ? `after fees${t.fees ? ` of ${fmt$(t.fees)}` : ''}` : 'before fees'}`].join(' · ');

/** the sheet's Delete: out at once, with Undo on the toast */
const deleteSection = (t, locked, what = 'trade') => `<div class="sheet-section">
      <div class="sheet-label">Delete</div>
      <p class="hint">For a ${what} that doesn't belong in your journal. Imports won't bring it back.</p>
      <div class="row" style="gap:8px;"><button class="btn journal-danger" id="tradeDeleteBtn" data-action="deleteTrade"${locked ? ' disabled' : ''}>${state.tradeReviewBusy ? 'Deleting…' : `Delete this ${what}`}</button></div>
    </div>`;

/** a close from before the history: what's known, and Delete (there's no entry to set a stop against) */
function historySheet(t, locked) {
  return `<div class="sheet-section"><p class="hint" style="margin:0">${tradeFacts(t)}</p>
      <p class="hint">${esc(HISTORY_TITLE)}</p></div>
    ${deleteSection(t, locked)}`;
}

/** the option legs this one can combine with, each a button; or why combining is off */
function combineSection(t, locked) {
  const list = combineCandidates(currentTrades(), t.key);
  const off = locked || !!state.journalSavedError || state.journalMerging;
  const buttons = list.map(c => `<button class="filter-btn" data-action="combineTrade" data-arg="${esc(c.key)}"${off ? ' disabled' : ''}>${esc(legWords([c]))}<span class="journal-chip-time">${esc(c.label)}</span></button>`).join('');
  return `<div class="sheet-section">
      <div class="sheet-label">${t.legs ? 'Add a leg' : 'Combine into a spread'}</div>
      ${state.journalSavedError ? '<p class="hint" style="color:var(--amber)">Combining needs the database update: npx supabase db push.</p>' : ''}
      ${buttons ? `<p class="hint">Other ${esc(t.legs ? t.symbol : t.label.split(' ')[0])} options open at the same time. Tap one to make them one trade.</p><div class="chip-row journal-stop-chips">${buttons}</div>`
        : `<p class="hint">No other ${esc(t.legs ? t.symbol : t.label.split(' ')[0])} options overlap this trade.</p>`}
    </div>`;
}

/** a spread: its legs, Add a leg, Split, Delete */
function spreadSheet(t, locked) {
  const strike = l => { const n = esc(l.label); return n.split(' ').slice(-1)[0]; };
  const rows = t.legs.map(l => `<tr><td><b>${strike(l)}</b></td><td class="${l.direction === 'long' ? 'journal-buy' : 'journal-sell'}">${l.direction === 'long' ? 'Bought' : 'Sold'} ${l.entryQty}</td><td>${px(l.avgEntry, 'OPTION')} → ${l.avgExit === null ? 'open' : px(l.avgExit, 'OPTION')}</td><td class="${pnlClass(l.pnl)}">${l.status === 'open' && !l.exits ? '—' : signed$(l.pnl)}</td></tr>`).join('');
  return `<div class="sheet-section"><p class="hint" style="margin:0">${tradeFacts(t)}</p>
      <p class="hint">${t.group === 'auto' ? 'Opened in one order, so its legs are one trade.' : 'You combined these legs.'} ${rTitleOf(t)}.</p>
      <div class="positions-wrap"><table class="positions-table journal-table journal-legs-table"><thead><tr><th scope="col">Leg</th><th scope="col">Side</th><th scope="col">Entry → exit</th><th scope="col">P&amp;L</th></tr></thead><tbody>${rows}</tbody></table></div></div>
    ${combineSection(t, locked)}
    <div class="sheet-section">
      <div class="sheet-label">Split</div>
      <p class="hint">Back to ${t.legs.length} separate trades.</p>
      <div class="row" style="gap:8px;"><button class="btn" data-action="splitSpread"${locked || state.journalSavedError || state.journalMerging ? ' disabled' : ''}>Split into legs</button></div>
    </div>
    ${deleteSection(t, locked, 'spread')}
    ${state.tradeReviewError ? `<p class="shares-error" role="status">Couldn't save: ${esc(state.tradeReviewError)}</p>` : ''}`;
}

export function renderTradeReview() {
  const el = document.getElementById('tradeReviewBody');
  if (!el) return;
  const t = reviewedTrade();
  const title = document.getElementById('tradeReviewTitle');
  if (!t) { el.innerHTML = '<p class="hint">This trade isn\'t in the journal any more.</p>'; if (title) title.textContent = 'Trade'; return; }
  const rv = reviewOf(t.key);
  const locked = !!state.tradeReviewsError || state.tradeReviewBusy;
  if (title) title.textContent = t.label;
  if (t.status === 'history') { el.innerHTML = historySheet(t, locked); return; }
  if (t.legs) { el.innerHTML = spreadSheet(t, locked); return; }
  const typed = rv.stop ?? '';
  const preview = stopPreview(t, typed);
  const chips = t.stopTrail.map(x => {
    const usable = !ownStopError(t, x.stopPrice);
    return `<button class="filter-btn" data-action="pickTradeStop" data-arg="${x.stopPrice}"${usable ? '' : ' disabled title="Past the entry: it protected profit, it wasn\'t the risk"'}>${px(x.stopPrice, t.assetType)}<span class="journal-chip-time">${esc(clockTime(x.entered))}</span></button>`;
  }).join('');
  const back = t.schwabStop !== null ? 'Use Schwab\'s stop instead' : t.assetType === 'OPTION' && t.direction === 'long' ? 'Go back to the premium' : 'Remove your stop';
  el.innerHTML = `<div class="sheet-section"><p class="hint" style="margin:0">${tradeFacts(t)}</p>
    ${state.tradeReviewsError ? `<p class="hint" style="color:var(--amber)">Your stops and deleted trades couldn't load, so saving is off until they do.</p>` : ''}</div>
    <div class="sheet-section">
      <div class="sheet-label">Stop</div>
      <p class="hint" id="tradeStopNow">${stopNowLine(t)}</p>
      ${chips ? `<p class="hint">Schwab's stops on this trade, oldest first. Tap one to use it.</p><div class="chip-row journal-stop-chips">${chips}</div>` : ''}
      <div class="row journal-stop-row">
        <div class="field"><label for="tradeStopInput">${t.assetType === 'OPTION' ? 'Your stop on the option' : 'Your stop'}</label>
          <div class="prefix-wrap"><span class="prefix">$</span><input type="number" id="tradeStopInput" inputmode="decimal" step="any" min="0" autocomplete="off" value="${esc(String(typed))}" data-input="tradeStopPreview" data-enter="saveTradeStop"${locked ? ' disabled' : ''} /></div></div>
        <button class="btn primary" id="tradeStopSave" data-action="saveTradeStop"${locked || !preview.ok ? ' disabled' : ''}>${state.tradeReviewBusy ? 'Saving…' : 'Save stop'}</button>
      </div>
      <p class="hint" id="tradeStopPreview" role="status"${preview.ok ? '' : ' style="color:var(--amber)"'}>${preview.text}</p>
      ${t.assetType === 'OPTION' ? '<p class="hint">For an option, the stop is a price on the option itself.</p>' : ''}
      ${rv.stop !== null && rv.stop !== undefined ? `<button class="pos-link" data-action="clearTradeStop"${locked ? ' disabled' : ''}>${back}</button>` : ''}
    </div>
    ${t.assetType === 'OPTION' && t.status !== 'history' ? combineSection(t, locked) : ''}
    ${t.kind === 'merged' ? `<div class="sheet-section">
      <div class="sheet-label">Separate</div>
      <p class="hint">You merged ${t.parts.length} trades into this one. Back to ${t.parts.length} separate trades.</p>
      <div class="row" style="gap:8px;"><button class="btn" data-action="separateTrade" data-arg="${esc(t.key)}"${locked || state.journalSavedError || state.journalMerging ? ' disabled' : ''}>Separate</button></div>
    </div>` : ''}
    ${deleteSection(t, locked)}
    ${state.tradeReviewError ? `<p class="shares-error" role="status">Couldn't save: ${esc(state.tradeReviewError)}</p>` : ''}`;
}

export function openTradeReview(key) {
  state.tradeReviewKey = key;
  state.tradeReviewError = '';
  renderTradeReview();
  openSheet('tradeReview');
}

/** typing a stop: update the preview and the Save button only, so the cursor stays put */
export function tradeStopPreview() {
  const t = reviewedTrade();
  const input = document.getElementById('tradeStopInput');
  if (!t || !input) return;
  const p = stopPreview(t, input.value);
  const out = document.getElementById('tradeStopPreview');
  out.textContent = p.text;
  out.style.color = p.ok ? '' : 'var(--amber)';
  document.getElementById('tradeStopSave').disabled = !p.ok || !!state.tradeReviewsError || state.tradeReviewBusy;
}

export function pickTradeStop(price) {
  const input = document.getElementById('tradeStopInput');
  if (!input) return;
  input.value = String(price);
  tradeStopPreview();
}

/** save the trade's review row; the journal shows it right away and goes back if Supabase refuses */
async function saveReview(next, done) {
  return saveReviews({ [state.tradeReviewKey]: next }, done);
}

/**
 * save review rows (one trade's, or a spread's legs); the journal shows them right away and goes back if Supabase
 * refuses. `then` = the trade to show in the sheet afterwards (combining keeps it open on the spread); otherwise it closes.
 * @param {Record<string, any>} rows @param {string} done @param {string} [then]
 */
async function saveReviews(rows, done, then) {
  const key = state.tradeReviewKey;
  if (!key || state.tradeReviewBusy || state.tradeReviewsError) return;
  const before = state.tradeReviews || {};
  state.tradeReviews = { ...before, ...rows };
  state.tradeReviewBusy = true;
  state.tradeReviewError = '';
  renderJournal();
  renderTradeReview();
  try {
    await saveTradeReviews(rows);
    state.tradeReviewBusy = false;
    if (then) { state.tradeReviewKey = then; renderTradeReview(); }
    else if (state.openSheetName === 'tradeReview' && state.tradeReviewKey === key) closeSheet();
    showToast(done);
  } catch(e) {
    state.tradeReviews = before;
    state.tradeReviewBusy = false;
    state.tradeReviewError = String(e?.message || e);
    renderTradeReview();
  }
  renderJournal();
}

export function saveTradeStop() {
  const t = reviewedTrade();
  const input = document.getElementById('tradeStopInput');
  if (!t || !input) return;
  const price = Number(input.value);
  if (!String(input.value).trim() || ownStopError(t, price)) { tradeStopPreview(); return; }
  return saveReview({ ...reviewOf(t.key), stop: price }, `Stop saved: R counts from ${px(price, t.assetType)}.`);
}

export function clearTradeStop() {
  const t = reviewedTrade();
  if (!t) return;
  return saveReview({ ...reviewOf(t.key), stop: null }, t.schwabStop !== null ? `Back to Schwab's stop, ${px(t.schwabStop, t.assetType)}.` : 'Your stop is removed.');
}

/** where the setting goes: synced with your account, so it's kept to the settings table's 2000 characters */
const FUNDS_MAX = 2000;

/** your funds changed: saved and synced, every trade in the ticker redrawn, the page's charts on the new symbols */
function saveFunds(funds, done) {
  const text = JSON.stringify(funds);
  if (text.length > FUNDS_MAX) { showError('Too many tickers of yours to sync. Take one off first.'); return false; }
  store.set('journal_funds', text); // '{}' too: a delete wouldn't sync
  state.fundEdit = null;
  renderJournal();
  reloadJournalCharts();
  showToast(done);
  return true;
}

/** a Setup on chip: the fund's underlying (back to what the list says, or what you set) or the ticker itself */
export function setFundOn(t, sym) {
  const funds = myFunds(), fund = fundOf(t, funds);
  if (sym === t.symbol) { if (fund) saveFunds(withFund(funds, t.symbol, ''), `Every ${t.symbol} trade reads on ${t.symbol}.`); return; }
  if (fund?.under === sym) return;
  const listed = listedFund(t.symbol);
  if (listed?.under === sym) saveFunds(withFund(funds, t.symbol, null), `Every ${t.symbol} trade reads on ${sym}.`);
}

/** Change (or Setup on another ticker): the editor, on what the ticker reads on now */
export function editFund(t) {
  const fund = fundOf(t, myFunds()) || listedFund(t.symbol);
  state.fundEdit = { symbol: t.symbol, inverse: !!fund && fund.lev < 0 };
  renderJournalTrade();
  document.getElementById('fundInput')?.focus();
}

/** Moves with it ('0') or Inverse ('1'); what's typed stays */
export function setFundInverse(t, v) {
  if (!state.fundEdit) return;
  const box = /** @type {HTMLInputElement | null} */ (document.getElementById('fundInput'));
  state.fundEdit = { ...state.fundEdit, inverse: v === '1', under: box?.value ?? state.fundEdit.under };
  renderJournalTrade();
}

export function cancelFundEdit() { state.fundEdit = null; renderJournalTrade(); }

/** Save: every trade in the ticker reads on what's typed (blank or the ticker itself: on itself) */
export function saveFund(t) {
  const ed = state.fundEdit;
  if (!ed) return;
  const box = /** @type {HTMLInputElement | null} */ (document.getElementById('fundInput'));
  const under = String(box?.value ?? ed.under ?? '').trim().toUpperCase().replace(/^\$/, '');
  if (under && !/^[A-Z][A-Z0-9.]{0,9}$/.test(under)) { showError(`${under} isn't a ticker.`); return; }
  const on = !under || under === t.symbol;
  saveFunds(withFund(myFunds(), t.symbol, on ? '' : under, ed.inverse), on ? `Every ${t.symbol} trade reads on ${t.symbol}.`
    : `Every ${t.symbol} trade reads on ${under}${ed.inverse ? ', inverse' : ''}.`);
}

/** back to the built-in list's word on the ticker */
export function resetFund(t) {
  const listed = listedFund(t.symbol);
  saveFunds(withFund(myFunds(), t.symbol, null), listed ? `Every ${t.symbol} trade reads on ${listed.under}.` : `Every ${t.symbol} trade reads on ${t.symbol}.`);
}

/** a row tapped anywhere but its tick box opens the trade (the stop link and the name are buttons of their own) */
/** a row: its trade page (Edit there opens the trade sheet) */
export function openTradeRow(key, event) {
  if (event?.target?.closest?.('.journal-pick')) return;
  openJournalTrade(key);
}

/**
 * delete trades (the sheet's, or the ticked ones): out of the list at once, the toast offers Undo; back if Supabase refuses
 * @param {string[]} keys
 */
async function deleteTrades(keys) {
  if (!keys.length || state.tradeReviewBusy || state.tradeReviewsError) return false;
  const trades = currentTrades().filter(t => keys.includes(t.key));
  const rows = Object.fromEntries(keys.map(k => [k, { ...reviewOf(k), deleted: true }]));
  const undo = Object.fromEntries(keys.map(k => [k, { ...reviewOf(k), deleted: false }]));
  const ok = await applyReviews(rows, trades.length === 1 ? `Deleted ${trades[0].label}.` : `Deleted ${keys.length} trades.`, undo);
  if (ok) { state.journalPicked = state.journalPicked.filter(k => !keys.includes(k)); renderJournal(); }
  return ok;
}

/**
 * save review rows from the table (no sheet in the way); the toast says done (with Undo when `undo` holds the rows
 * that put it back), or the error if Supabase refuses
 * @param {Record<string, any>} rows @param {string} done @param {Record<string, any>} [undo]
 */
async function applyReviews(rows, done, undo) {
  if (state.tradeReviewBusy || state.tradeReviewsError) return false;
  const before = state.tradeReviews || {};
  state.tradeReviews = { ...before, ...rows };
  state.tradeReviewBusy = true;
  state.tradeReviewError = '';
  renderJournal();
  renderTradeReview();
  try {
    await saveTradeReviews(rows);
    state.journalUndo = undo || null;
    showToast(done, undo ? '<button class="pos-link toast-act" data-action="undoDeleteTrades">Undo</button>' : undefined);
    return true;
  } catch(e) {
    state.tradeReviews = before;
    state.tradeReviewError = String(e?.message || e);
    showError(`Couldn't save: ${state.tradeReviewError}`);
    return false;
  } finally {
    state.tradeReviewBusy = false;
    renderJournal();
    renderTradeReview();
  }
}

/** Delete in the trade sheet: no question (Undo is on the toast); the sheet closes once it's saved */
export async function deleteTrade() {
  const t = reviewedTrade();
  if (!t) return;
  if (await deleteTrades([t.key]) && state.openSheetName === 'tradeReview') closeSheet();
}

/** Delete on the pick bar: every ticked trade */
export function deletePicked() { return deleteTrades([...state.journalPicked]); }

/** Undo on the toast: the last delete comes back */
export async function undoDeleteTrades() {
  const rows = state.journalUndo;
  if (!rows) return;
  state.journalUndo = null;
  const n = Object.keys(rows).length;
  await applyReviews(rows, n === 1 ? 'Trade restored.' : `${n} trades restored.`);
}

/** Restore on a deleted row: no question, it only brings it back */
export function restoreTrade(key) {
  const t = currentTrades().find(x => x.key === key);
  if (!t) return;
  return applyReviews({ [key]: { ...reviewOf(key), deleted: false } }, `${t.label} trade restored.`);
}

/** combine the open trade (a leg or a spread) with another leg: a merge, and the sheet stays open on the spread */
export function combineTrade(otherKey) {
  const t = reviewedTrade();
  const other = currentTrades().find(x => x.key === otherKey);
  if (!t || !other) return;
  return mergeTrades([t, other], { stay: true, done: legs => `Combined: ${legWords(legs)}.` });
}

/** a spread back into its legs, from its sheet */
export async function splitSpread() {
  const t = reviewedTrade();
  if (!t || !t.legs) return;
  if (await separateTrade(t.key) && state.openSheetName === 'tradeReview') closeSheet();
}

// ---------- merge and separate: rows in the trades table ----------

export function toggleJournalPick(key) {
  state.journalPicked = state.journalPicked.includes(key) ? state.journalPicked.filter(k => k !== key) : [...state.journalPicked, key];
  renderJournal();
}
export function clearJournalPicks() { state.journalPicked = []; renderJournal(); }
/** phones: Select shows the cards' tick boxes, Done hides them and clears what's ticked */
/** phones: Filters opens the setup menu, side, fees and Review from under the symbol box, and closes them */
export function toggleJournalFilters() { state.journalFiltersOpen = !state.journalFiltersOpen; renderJournal(); }
export function toggleJournalSelect() {
  state.journalSelecting = !state.journalSelecting;
  if (!state.journalSelecting) state.journalPicked = [];
  renderJournal();
}

const savedRow = id => state.journalSaved.find(r => r.id === id);
const byCreated = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''));

/**
 * Save trades as one: a new trades row claiming their fills, or, when one of them already has rows, its oldest takes the
 * rest in (so its key, and your stop and delete on it, stay put) and the others go. A new trade starts from the first
 * part's own stop, if you set one. opts.stay keeps the trade sheet open on the result.
 * @param {any[]} picked @param {{ stay?: boolean, done?: (legs: any[]) => string }} [opts]
 */
async function mergeTrades(picked, opts = {}) {
  const problem = state.journalSavedError ? 'Merging needs the database update: npx supabase db push.' : mergeProblem(picked);
  if (problem) { showError(problem); return false; }
  if (state.journalMerging) return false;
  state.journalMerging = true;
  renderJournal();
  if (opts.stay) renderTradeReview();
  const fillIds = [...new Set(picked.flatMap(t => t.fillIds))];
  const rows = [...new Set(picked.flatMap(t => t.savedIds || []))].map(savedRow).filter(Boolean).sort(byCreated);
  const legs = picked.flatMap(t => t.legs || [t]);
  let ok = false;
  try {
    let keep;
    if (rows.length) {
      keep = { ...rows[0], fill_ids: fillIds };
      await updateSavedTrade(keep.id, fillIds);
    } else {
      keep = { id: crypto.randomUUID(), account: picked[0].account, fill_ids: fillIds };
      await insertSavedTrades([keep]);
      keep.created_at = new Date().toISOString();
    }
    state.journalSaved = [...state.journalSaved.filter(r => r.id !== keep.id), keep];
    const key = `trade:${keep.id}`;
    const extra = rows.slice(1).map(r => r.id);
    // a leftover row still overlaps the kept one, so the trade shows as one either way
    try { await deleteSavedTrades(extra); state.journalSaved = state.journalSaved.filter(r => !extra.includes(r.id)); } catch(e) {}
    const first = [...picked].sort((a, b) => (a.openedAt < b.openedAt ? -1 : 1))[0];
    if (!rows.length && first.stopSource === 'yours' && !first.legs) {
      const carry = { [key]: { stop: first.stop, deleted: false } };
      try { await saveTradeReviews(carry); state.tradeReviews = { ...(state.tradeReviews || {}), ...carry }; } catch(e) {}
    }
    state.journalPicked = [];
    if (opts.stay) state.tradeReviewKey = key;
    const n = new Set(picked.flatMap(t => t.parts?.length ? t.parts : [t.key])).size;
    showToast(opts.done ? opts.done(legs) : `Merged ${n} trades into one.`);
    ok = true;
  } catch(e) {
    showError(`Couldn't merge: ${e?.message || e}`);
  } finally {
    state.journalMerging = false;
    renderJournal();
    if (opts.stay) renderTradeReview();
  }
  return ok;
}

export function mergePicked() {
  return mergeTrades(currentTrades().filter(t => state.journalPicked.includes(t.key)));
}

/**
 * A merged trade or spread back into its parts: its rows go. Legs one order opened together would join again on their
 * own, so each of those gets a row of its own first (one claiming one trade keeps it apart).
 */
export async function separateTrade(key) {
  const t = currentTrades().find(x => x.key === key);
  if (!t || (t.kind !== 'merged' && !t.legs) || state.journalMerging) return false;
  if (state.journalSavedError) { showError('Separating needs the database update: npx supabase db push.'); return false; }
  state.journalMerging = true;
  renderJournal();
  const legs = t.legs || [];
  const sharesOrder = l => legs.some(o => o !== l && o.entryOrderIds.some(id => l.entryOrderIds.includes(id)));
  const solo = legs.filter(sharesOrder).map(l => ({ id: crypto.randomUUID(), account: l.account, fill_ids: l.fillIds }));
  let ok = false;
  try {
    await insertSavedTrades(solo);
    const now = new Date().toISOString();
    state.journalSaved = [...state.journalSaved, ...solo.map(r => ({ ...r, created_at: now }))];
    await deleteSavedTrades(t.savedIds || []);
    state.journalSaved = state.journalSaved.filter(r => !(t.savedIds || []).includes(r.id));
    state.journalPicked = state.journalPicked.filter(k => k !== key);
    showToast(`Separated into ${t.parts.length} ${t.legs ? 'legs' : 'trades'}.`);
    ok = true;
  } catch(e) {
    showError(`Couldn't separate: ${e?.message || e}`);
  } finally {
    state.journalMerging = false;
    renderJournal();
  }
  return ok;
}
