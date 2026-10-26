// Journal tab (#journalSection, setView('journal'), key j): what's kept from Schwab in your account, your trades (fills grouped
// flat to flat, with P&L, R, stop and hold time) or the raw fills, filtered by side and symbol; the trade sheet (your
// stop, delete a trade that doesn't belong, combine or split a spread); and the Import and Export sheets: Import lists the
// sources (Schwab, thinkorswim statements for futures, more files later), Export the files you can take (Schwab history now, trades later). Tick trades
// and Merge to make them one (a re-entry, a spread's legs); Separate undoes it. Both are rows in the trades table. The
// trade page and stats come later.
import { fmt$, marketEscape as esc } from '../core/format.js';
import { fillWords, fillsFrom, recordsSummary } from '../core/journal-records.js';
import { combineCandidates, holdWords, journalTrades, legWords, mergeProblem, ownStopError, pnlBasis, pnlPct, riskAt, tradesSummary } from '../core/journal.js';
import { importWords } from '../core/schwab-history.js';
import { activePeriods, exitDays, periodKey, PERIODS, stepPeriod, switchPeriod } from '../core/journal-stats.js';
import { fmtPositionPrice } from '../core/positions.js';
import { lastCapture } from '../services/capture.js';
import { schwabAccount } from '../services/schwab.js';
import { deleteSavedTrades, insertSavedTrades, loadSavedRecords, loadSavedTrades, loadTradeReviews, saveTradeReviews, updateSavedTrade } from '../services/journal.js';
import { schwabConnected } from '../services/schwab.js';
import { store } from '../lib/store.js';
import { growBoxes } from '../lib/grow.js';
import { mq, PHONE_MQ } from '../lib/media.js';
import { inZone, zoneAbbr } from '../lib/zone.js';
import { state } from '../state.js';
import { captureNow, maybeCapture, onCaptureChange } from './schwab-capture.js';
import { calendarView, drawJournalEquity, nextJournalMonth, statsView, thisMonth } from './journal-stats.js';
import { maybeSaveBars } from './journal-bars.js';
import { featuresLine, featuresView, loadFeatureRows, maybeStampFeatures, stampAfterImport } from './journal-features.js';
import { openJournalTrade, renderJournalTrade, syncJournalPage } from './journal-trade.js';
import { loadJournalReview, reviewedMark, savedForWeekly, setupMatches, setupMenu, setupsOf, toReview, tradeReviewState } from './journal-review.js';
import { loadJournalShots } from './journal-shots.js';
import { deckButtonHtml, deckLineHtml, renderDeckEnd, syncJournalBadge } from './journal-deck.js';
import { loadModelBooks, renderModelBooks, selectModelSetup } from './model-books.js';
import { setupsView } from './journal-setups.js';
import { loadPeriodReviewRows, periodReviewHtml } from './journal-week.js';
import { tosSectionHtml } from './journal-tos.js';
import { dayPageHtml, todayLineHtml } from './journal-notebook.js';
import { drawMissedChart } from './missed-chart.js';
import { closeSheet, openSheet } from './sheets.js';
import { showError, showToast } from './feedback.js';

/** fills shown at once; the rest are counted */
export const JOURNAL_SHOWN = 200;

const day = iso => iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
/** a fill's time in the Settings zone (ET or PT), whatever the device's: '10/13, 11:47 AM' */
export const clockTime = iso => iso ? inZone(iso, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const when = clockTime;

/** the line under the title: importing, the last import, or why it can't run */
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
  const mult = f.assetType === 'OPTION' ? 100 : 1;
  return `<tr>
    <td><b>${esc(f.label || f.symbol)}</b></td>
    <td class="${f.side === 'buy' ? 'journal-buy' : 'journal-sell'}">${esc(fillWords(f))}</td>
    <td>${f.qty}</td>
    <td>${fmtPositionPrice(f.price, f.assetType === 'OPTION' ? 'OPTION' : null)}</td>
    <td>${fmt$(f.qty * f.price * mult)}</td>
    <td>${esc(clockTime(f.time))}</td>
  </tr>`;
}

const px = (p, assetType) => fmtPositionPrice(p, assetType === 'OPTION' || assetType === 'SPREAD' ? 'OPTION' : null);
const signed$ = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt$(Math.abs(v))}`;
const pnlClass = v => v > 0 ? 'journal-buy' : v < 0 ? 'journal-sell' : '';
/** P&L before or after Schwab's fees: your choice, synced to your account as journal_fees */
export const journalAfterFees = () => store.get('journal_fees') === 'after';
const feeWords = () => journalAfterFees() ? 'after fees' : 'before fees';
const signedR = r => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}R`; // the same minus sign as money

/** the stop cell: the price in use (tap to change it), and whether it's yours or Schwab's stop moved later */
function stopCell(t) {
  const key = esc(t.key);
  if (t.legs) return `<span title="A spread's risk is its defined risk">—</span>`;
  if (t.stop === null) return `<button class="pos-link" data-action="openTradeReview" data-arg="${key}" aria-label="Set a stop for ${esc(t.label)}">Set</button>${t.rBasis === 'premium' ? '<span class="pos-sub">premium</span>' : ''}`;
  const sub = t.stopSource === 'yours' ? 'yours' : t.movedTo !== null ? `moved to ${px(t.movedTo, t.assetType)}` : '';
  return `<button class="pos-link" data-action="openTradeReview" data-arg="${key}" aria-label="Change the stop for ${esc(t.label)}">${px(t.stop, t.assetType)}</button>${sub ? `<span class="pos-sub">${sub}</span>` : ''}`;
}

/** under the P&L: 'so far' on an open trade, and after fees, the fees taken out or that they haven't come in */
function pnlSub(t) {
  const open = t.status === 'open';
  const lines = [];
  if (open && t.exits) lines.push('so far');
  if (t.afterFees && (!open || t.exits)) {
    if (t.feesMissing) lines.push('<span class="journal-fees-missing">fees not in yet</span>');
    else if (t.fees) lines.push(`fees ${fmt$(t.fees)}`);
  }
  return lines.map(l => `<span class="pos-sub">${l}</span>`).join('');
}
const pnlTitle = t => t.afterFees ? ` title="${esc(`Before fees ${signed$(t.grossPnl)}, fees ${fmt$(t.fees)}${t.feesMissing ? `, ${t.feesMissing} order${t.feesMissing === 1 ? '' : 's'} without fees yet` : ''}`)}"` : '';

function rTitleOf(t) {
  if (t.rBasis === 'debit') return `The debit paid, ${fmt$(t.risk)}, is the risk`;
  if (t.rBasis === 'width') return `The width less the credit, ${fmt$(t.risk)}, is the risk`;
  if (t.legs) return 'No defined risk for this combination yet';
  if (t.rBasis === 'stop') return `${t.stopSource === 'yours' ? 'Your stop' : 'Initial stop'} ${px(t.stop, t.assetType)}, risk ${fmt$(t.risk)}`;
  if (t.rBasis === 'premium') return `No stop: the premium paid, ${fmt$(t.risk)}, is the risk`;
  return 'No stop: set one to get R';
}

const HISTORY_TITLE = "Opened before the journal's history: Schwab's API gives 60 days of orders, so its entry and P&L aren't known. It doesn't count in the stats.";
const EXPIRED_TITLE = "Closed at $0 at the 4pm close on expiry, assumed worthless. An assignment or exercise shows once Schwab posts it, usually the next morning.";
const VIA_TITLE = {
  assigned: 'Assigned: the option closed at $0 that day, so its premium stays its P&L, and the shares came in or went out at the strike.',
  exercised: 'Exercised: the option closed at $0 that day, and the shares came in or went out at the strike.',
  delivered: 'Shares an option delivered at the strike. The option was opened before your history, so it isn\'t here.',
};

/** the side is the bet on the stock: a put bought is short, a call debit spread long, a time spread neutral */
const sideCell = t => `<td class="${{ long: 'journal-buy', short: 'journal-sell' }[t.bias] || ''}">${{ long: 'Long', short: 'Short', neutral: 'Neutral' }[t.bias] || ''}</td>`;

/** the tick box that picks a trade for Merge or Delete (not on deleted trades: an empty slot keeps their names in line) */
const pickBox = t => t.deleted ? '<span class="journal-pick" aria-hidden="true"></span>'
  : `<label class="journal-pick"><input type="checkbox" data-change="toggleJournalPick" data-arg="${esc(t.key)}" aria-label="Pick ${esc(t.label)}"${state.journalPicked.includes(t.key) ? ' checked' : ''} /></label>`;

/** the symbol cell: the tick box in its own slot, then the name and its lines lined up after it */
const symCell = (t, main) => `<td><div class="journal-sym">${pickBox(t)}<div class="journal-sym-main">${main}</div></div></td>`;

/** the trade's name: it opens the trade sheet (a deleted one only offers Restore) */
const nameOf = t => t.deleted ? `<b>${esc(t.label)}</b>`
  : `<button class="journal-name" data-action="openTradeReview" data-arg="${esc(t.key)}" aria-label="Open the ${esc(t.label)} trade"><b>${esc(t.label)}</b></button>`;
const restoreLink = t => t.deleted ? `<span class="pos-sub journal-row-acts"><button class="pos-link" data-action="restoreTrade" data-arg="${esc(t.key)}" aria-label="Restore the ${esc(t.label)} trade">Restore</button></span>` : '';
/** a row opens its trade wherever it's tapped, except the tick box and the stop link (they have their own jobs) */
const rowOpen = t => t.deleted ? '' : ` data-action="openTradeRow" data-arg="${esc(t.key)}"`;

/** a setup's chip in its parts, the action first and the level second ('Bounce | 8 EMA'), its name in the title; a pattern is its own name */
const setupChip = s => {
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

const signedPct = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`;
/** what the percent is of: what it cost, what a short took in, a spread's risk */
function pctTitleOf(t, basis) {
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
const reviewsRead = () => !!state.journalReview && !state.journalReviewError;
const isReviewed = t => reviewsRead() && t.status !== 'history' && tradeReviewState(t).reviewed;
const untagged = t => reviewsRead() && t.status !== 'history' && !setupsOf(t).length;
const REVIEW_TESTS = { todo: toReview, done: isReviewed, untagged };
const onReviewFilter = list => REVIEW_TESTS[state.journalReviewFilter] ? list.filter(REVIEW_TESTS[state.journalReviewFilter]) : list;
/** the setup filter: only the trades that carry that setup, that kind (any bounce) or that level (Trades, Calendar and Stats) */
const onSetupFilter = list => state.journalSetupFilter ? list.filter(t => setupMatches(t, state.journalSetupFilter)) : list;
export function setJournalSetupFilter(v) { state.journalSetupFilter = String(v || ''); renderJournal(); }
export function setJournalReviewFilter(v) { state.journalReviewFilter = v in REVIEW_TESTS ? v : 'all'; renderJournal(); }
const onPickedDay = list => state.journalDay ? list.filter(t => exitDays(t).has(state.journalDay)) : list;

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
  const tabs = `<div class="seg journal-tabs" aria-label="Show">${tab('trades', 'Trades')}${tab('calendar', 'Calendar')}${tab('stats', 'Stats')}${tab('setups', 'Setups')}${tab('books', '<span class="mb-tab-long">Model books</span><span class="mb-tab-short">Books</span>')}${tab('features', 'Features')}${tab('fills', 'Fills')}</div>`;
  if (state.journalTab === 'books' || state.journalTab === 'features' || navigationOnly) return `<div class="journal-controls">${tabs}</div>`;
  return `<div class="journal-controls">
    ${tabs}
    <div class="seg" aria-label="Side">${side('all', 'All')}${side('long', 'Long')}${side('short', 'Short')}</div>
    ${state.journalTab !== 'fills' ? `<div class="seg" aria-label="P&amp;L">${fee('before', 'Before fees')}${fee('after', 'After fees')}</div>` : ''}
    ${setupFilter(all)}
    <input type="search" id="journalSymbol" placeholder="Symbol" value="${esc(state.journalSymbol)}" autocomplete="off" spellcheck="false" data-input="journalSymbolChanged" aria-label="Filter by symbol" />
    ${state.journalTab === 'trades' && state.journalDay ? `<button class="filter-btn active jc-daychip" data-action="clearJournalDay" aria-label="Show every day">Exits ${+state.journalDay.slice(5, 7)}/${+state.journalDay.slice(8)} ×</button><button class="pos-link" data-action="openJournalStats" data-arg="day" data-arg2="${state.journalDay}">The day's stats</button>` : ''}
    ${state.journalTab === 'trades' ? reviewChips(all) : ''}
  </div>`;
}

/** All · To review · Reviewed · No setup, each with how many of the trades the other filters leave */
function reviewChips(all) {
  const base = onSetupFilter(onPickedDay(filtered(all, t => t.bias))).filter(t => !t.deleted);
  const chip = (v, label, n) => `<button class="journal-chip${state.journalReviewFilter === v ? ' active' : ''}" aria-pressed="${state.journalReviewFilter === v}" data-action="setJournalReviewFilter" data-arg="${v}">${label} <b>${n}</b></button>`;
  const more = reviewsRead() ? chip('done', 'Reviewed', base.filter(isReviewed).length) + chip('untagged', 'No setup', base.filter(untagged).length) : '';
  return `<div class="journal-chips" aria-label="Review">${chip('all', 'All', base.length)}${chip('todo', 'To review', base.filter(toReview).length)}${more}</div>`;
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

// ---------- phones: a card per trade, open ones first, like the trade journals on a phone ----------

const nyDay = iso => new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
const unitWord = t => t.legs ? (t.entryQty === 1 ? 'spread' : 'spreads') : t.assetType === 'OPTION' || t.assetType === 'FUTURE' ? (t.entryQty === 1 ? 'ct' : 'cts') : 'shr';
const pill = (cls, text, title = '') => `<span class="jtc-pill${cls ? ` ${cls}` : ''}"${title ? ` title="${esc(title)}"` : ''}>${text}</span>`;

/** '20 shr · Oct 9 → Oct 13 · 4d 1h', or '100 shr · Opened Oct 15 · 2d 3h' while it's open */
function cardSub(t) {
  const qty = `${t.entryQty} ${unitWord(t)}`;
  if (t.status === 'history') return `${qty} · closed ${nyDay(t.closedAt || t.openedAt)} · bought earlier`;
  const parts = t.status === 'open'
    ? [`${qty}${t.openQty !== t.entryQty ? `, ${t.openQty} open` : ''}`, `Opened ${nyDay(t.openedAt)}`, holdWords(Date.now() - Date.parse(t.openedAt))]
    : [qty, nyDay(t.openedAt) === nyDay(t.closedAt) ? nyDay(t.openedAt) : `${nyDay(t.openedAt)} → ${nyDay(t.closedAt)}`, holdWords(t.holdMs)];
  return parts.filter(Boolean).map(p => `<span class="jtc-nowrap">${p}</span>`).join(' · '); // breaks between the parts, never inside one
}

/** what the trade is and where its review stands, as pills */
function cardPills(t) {
  const open = t.status === 'open';
  const out = [t.status === 'history' ? pill('jtc-warn', 'Before your history', HISTORY_TITLE) : open ? pill('jtc-open', 'Open') : pill('', 'Closed')];
  const side = { long: pill('jtc-long', 'Long'), short: pill('jtc-short', 'Short'), neutral: pill('', 'Neutral') }[t.bias];
  if (side) out.push(side);
  if (t.legs) out.push(pill('', esc(t.structure || `${t.spreadKind} spread`)));
  if (t.expired) out.push(pill('', 'expired', EXPIRED_TITLE));
  if (t.via) out.push(pill('', t.via, VIA_TITLE[t.via]));
  if (t.deleted) out.push(pill('jtc-warn', 'deleted'));
  return out.join('');
}

/** top right: To review, or Reviewed once it is (nothing while the reviews haven't been read) */
function cardReview(t) {
  if (t.deleted || t.status === 'history' || !reviewsRead()) return '';
  if (toReview(t)) return '<span class="jtc-review">To review</span>';
  return isReviewed(t) ? '<span class="jtc-review jtc-done">Reviewed</span>' : '';
}

/** the card's P&L %, under the dollars */
function cardPct(t) {
  const basis = pnlBasis(t), pct = pnlPct(t);
  return pct === null || basis === null ? '' : `<span class="jtc-pct" title="${esc(pctTitleOf(t, basis))}">${signedPct(pct)}</span>`;
}

function tradeCard(t) {
  const open = t.status === 'open', history = t.status === 'history', noPnl = history || (open && !t.exits);
  const setups = setupsOf(t);
  const tags = setups.length ? setups.map(setupChip).join('') : untagged(t) ? pill('jtc-warn', 'No setup') : '';
  const weekly = reviewsRead() && savedForWeekly(t) ? pill('', 'for weekly') : '';
  const sub = t.legs ? esc(legWords(t.legs)) : t.kind === 'merged' ? `${t.parts.length} trades merged` : '';
  // the stop as a fact, not a control: changing it is on the trade page (Edit)
  const stop = t.legs || history || t.stop === null ? '' : `<span class="jtc-stop">Stop <b>${px(t.stop, t.assetType)}</b>${t.stopSource === 'yours' ? ' <span class="pos-sub">yours</span>' : t.movedTo !== null ? ` <span class="pos-sub">moved to ${px(t.movedTo, t.assetType)}</span>` : ''}</span>`;
  const go = t.deleted ? '' : `<button class="btn primary jtc-go" data-action="openTradeRow" data-arg="${esc(t.key)}" aria-label="Review ${esc(t.label)}">Review</button>`;
  return `<article class="jtc${open ? ' jtc-is-open' : ''}${t.deleted ? ' journal-deleted' : ''}"${rowOpen(t)}${history ? ` title="${esc(HISTORY_TITLE)}"` : ''}>
    <div class="jtc-head">${pickBox(t)}<div class="jtc-id">
      <div class="jtc-name">${nameOf(t)}${cardPills(t)}</div>
      <div class="jtc-sub">${cardSub(t)}</div>${sub ? `<div class="jtc-sub">${sub}</div>` : ''}
    </div>${cardReview(t)}</div>
    ${tags || weekly ? `<div class="jtc-tags">${tags}${weekly}</div>` : ''}
    <dl class="jtc-stats${[t.avgEntry, t.avgExit].some(v => v !== null && px(v, t.assetType).length > 8) ? ' jtc-stats-wide' : ''}">
      <div><dt>Entry</dt><dd>${history ? '—' : px(t.avgEntry, t.assetType)}</dd></div>
      <div><dt>${t.exits > 1 ? 'Avg exit' : 'Exit'}</dt><dd>${t.avgExit === null ? '—' : px(t.avgExit, t.assetType)}</dd></div>
      <div title="${esc(rTitleOf(t))}"><dt>R</dt><dd class="${t.r === null ? '' : pnlClass(t.r)}">${t.r === null ? '—' : signedR(t.r)}</dd></div>
      <div${noPnl ? '' : pnlTitle(t)}><dt>P&amp;L</dt><dd class="${noPnl ? '' : pnlClass(t.pnl)}">${noPnl ? '—' : signed$(t.pnl)}${noPnl ? '' : cardPct(t) + pnlSub(t)}</dd></div>
    </dl>
    <div class="jtc-foot">${stop}${restoreLink(t)}${go}</div>
  </article>`;
}

/** Open trades, then Closed trades, each with a count and what it took */
function tradeCards(trades) {
  const taken = list => list.filter(t => !t.deleted && t.status !== 'history' && (t.status !== 'open' || t.exits)).reduce((sum, t) => sum + t.pnl, 0);
  const group = (title, list, word) => {
    if (!list.length) return '';
    const counted = list.filter(t => !t.deleted && t.status !== 'history' && (t.status !== 'open' || t.exits));
    const total = counted.length ? `<span class="jtc-total">${word} <b class="${pnlClass(taken(list))}">${signed$(taken(list))}</b></span>` : '';
    return `<section class="jtc-group"><div class="jtc-group-head"><h3>${title} <span>${list.length}</span></h3>${total}</div>${list.map(tradeCard).join('')}</section>`;
  };
  return `<div class="jtc-list">${group('Open trades', trades.filter(t => t.status === 'open'), 'Taken so far')}${group('Closed trades', trades.filter(t => t.status !== 'open'), 'Realized')}</div>`;
}

/** a phone turned sideways (or a window resized) swaps cards and table */
let phoneWatched = false;
function watchPhone() {
  if (phoneWatched || !window.matchMedia) return;
  phoneWatched = true;
  window.matchMedia(PHONE_MQ).addEventListener?.('change', () => { if (state.journalView) renderJournal(); });
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
  const list = phone ? tradeCards(shown) : `${columnPicker()}<div class="positions-wrap"><table class="positions-table journal-table">
      <thead><tr><th scope="col">Symbol</th>${shownTradeCols().map(([key, label]) => `<th scope="col">${colHead(key, label)}</th>`).join('')}</tr></thead>
      <tbody>${shown.map(tradeRow).join('')}</tbody>
    </table></div>`;
  const colsBtn = phone ? '' : `<button class="btn journal-cols-btn" data-action="toggleJournalColumnsMenu" aria-expanded="${state.journalColsOpen}" title="Show or hide the table's columns">Columns</button>`;
  return `<div class="journal-summary-row"><p class="hint journal-summary">${summaryLine(counted, deleted)}</p>${colsBtn}</div>
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
  state.journalTab = ['fills', 'calendar', 'stats', 'setups', 'books', 'features'].includes(tab) ? tab : 'trades';
  state.journalNotebookDay = ''; // the Calendar tab goes back to the calendar
  if (state.journalTab !== 'trades') state.journalDay = '';
  renderJournal();
  if (state.journalTab === 'books' && (!state.modelBooks.loaded || state.modelBooks.owner !== state.session?.user?.id)) loadModelBooks();
}
/** a day on the calendar: the trades with an exit then */
export function pickJournalDay(day) { state.journalDay = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ''; state.journalTab = 'trades'; state.journalNotebookDay = ''; renderJournal(); }
export function clearJournalDay() { state.journalDay = ''; renderJournal(); }
export function shiftJournalMonth(by) { state.journalMonth = nextJournalMonth(by); state.journalReviewPeriod = null; renderJournal(); }
export function journalThisMonth() { state.journalMonth = thisMonth(); state.journalReviewPeriod = null; renderJournal(); }
/** the trades the stats count from: the side, symbol and setup filters applied, as the Stats tab shows them */
const statsTrades = () => onSetupFilter(filtered(currentTrades(), t => t.bias));
/** All time / Month / Week / Day on the stats: a new unit keeps your place (the newest close in what's shown now) */
export function setJournalPeriod(unit) {
  const to = PERIODS.includes(unit) ? unit : 'all';
  if (to === state.journalPeriod) return;
  state.journalPeriodKey = to === 'all' ? '' : switchPeriod(statsTrades(), state.journalPeriod, state.journalPeriodShown, to);
  state.journalPeriod = to;
  renderJournal();
}
/** ‹ or ›: the nearest day, week or month with closed trades before or after the one shown */
export function stepJournalPeriod(by) {
  if (!PERIODS.includes(state.journalPeriod)) return;
  const next = stepPeriod(activePeriods(statsTrades(), state.journalPeriod), state.journalPeriodShown, Number(by) || 0);
  if (next) { state.journalPeriodKey = next; renderJournal(); }
}
/** the stats for one day, week or month, from the calendar or a day's trades */
export function openJournalStats(unit, key) {
  const ok = PERIODS.includes(unit) && (unit === 'month' ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/).test(key || '');
  state.journalPeriod = ok ? unit : 'all';
  state.journalPeriodKey = ok ? periodKey(key, unit) : '';
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
  const kept = recordsSummary(records);
  const fills = fillsFrom(records);
  const canImport = schwabConnected();
  const books = state.journalTab === 'books';
  const all = fills.length ? currentTrades() : [];
  syncJournalBadge(all);
  const keys = new Set(all.map(t => t.key));
  state.journalPicked = state.journalPicked.filter(k => keys.has(k)); // a merge or a re-read can retire a key
  const scrolled = el.querySelector?.('.positions-wrap')?.scrollLeft || 0; // a tick redraws the table: keep it where it was sideways
  const keptLine = kept.orders || kept.transactions || kept.statementFills
    ? `${kept.orders} orders and ${kept.transactions} trades kept${kept.statementFills ? `, ${kept.statementFills} futures fills` : ''} · ${day(kept.first)} to ${day(kept.last)}`
    : state.journalLoading ? 'Loading…' : 'Nothing kept yet';
  el.innerHTML = `<div class="card positions-card journal-card">
    <div class="positions-head">
      <span class="section-title">Journal</span>
      <span class="positions-meta" id="journalKept">${books ? 'Your chart study library' : keptLine}</span>
      ${books ? '' : `<span class="journal-actions">
        ${deckButtonHtml(all)}
        <button class="btn" id="journalImportBtn" data-action="openJournalImport" title="Bring in trades: Schwab now, files later">${state.captureBusy ? 'Importing…' : 'Import'}</button>
        <button class="btn" id="journalExportBtn" data-action="openJournalExport" title="Take your data with you as a file">Export</button>
      </span>`}
    </div>
    ${!books ? `<p class="hint" id="journalStatus" role="status">${statusLine()}</p>` : ''}
    ${!books ? `<p class="hint" id="journalFeaturesLine" role="status"${featuresLine() ? '' : ' hidden'}>${esc(featuresLine())}</p>` : ''}
    ${!books ? deckLineHtml(all) + todayLineHtml() : ''}
    ${!books && state.journalError ? `<p class="shares-error" role="status">Couldn't load your journal: ${esc(state.journalError)}</p>` : ''}
    ${!books && state.tradeReviewsError ? `<p class="hint" role="status" style="color:var(--amber)">Your stops and deleted trades couldn't load (${esc(state.tradeReviewsError)}). Trades show with Schwab's stops, deleted ones included.</p>` : ''}
    ${!books && state.journalSavedError ? `<p class="hint" role="status" style="color:var(--amber)">Merges unavailable: ${esc(state.journalSavedError)}. Trades show as the app groups them.</p>` : ''}
    ${controls(all, !fills.length || notebookOpen())}
    ${books ? '<div id="modelBooksBody"></div>' : notebookOpen() ? dayPageHtml() : fills.length ? (state.journalTab === 'fills'
      ? fillsView(filtered(fills, f => f.side === 'buy' ? (/TO_COVER|TO_CLOSE/.test(f.instruction) ? 'short' : 'long') : (/SHORT/.test(f.instruction) ? 'short' : 'long')))
      : state.journalTab === 'calendar' ? calendarView(onSetupFilter(filtered(all, t => t.bias))) + periodReviewHtml(all)
      : state.journalTab === 'stats' ? statsView(onSetupFilter(filtered(all, t => t.bias)))
      : state.journalTab === 'setups' ? setupsView(filtered(all, t => t.bias))
      : state.journalTab === 'features' ? featuresView(all)
      : tradesView(onSetupFilter(onReviewFilter(onPickedDay(filtered(all, t => t.bias))))))
    : `<p class="hint">${records.length ? 'No fills in the kept orders yet.' : 'Import saves your last 60 days of Schwab orders and up to a year of trades to your account. After that, the app keeps adding to it on its own.'}</p>`}
  </div>`;
  if (books) renderModelBooks();
  const wrap = scrolled && el.querySelector?.('.positions-wrap');
  if (wrap) wrap.scrollLeft = scrolled;
  if (state.journalTab === 'stats' && fills.length) drawJournalEquity(onSetupFilter(filtered(all, t => t.bias)));
  drawMissedChart();
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

/** Export: the files you can take. Schwab history now; trades as CSV once trades exist */
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
      <p class="hint">Every trade with P&amp;L and R, for a spreadsheet or another journal, once trades are built from your fills.</p>
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
  return journalTrades(fillsFrom(records), records, state.tradeReviews || {}, { afterFees: journalAfterFees(), now: Date.now(), saved: state.journalSaved });
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
