// The desktop Journal's Trades tab (DESKTOP_MQ, docs/journal.md): two layouts, one click apart (journal_layout, this device
// only). Workbench: the stats band, the trades a day at a time in a table (Open first), and the trade you pick in a panel on
// the right with where its review stands (Open full review opens its page). Review desk: the phone cards two-up, the review
// progress, Up next and By setup pinned in a column on the right. journal.js puts the rail and the chips around them.
import { fmt$, marketEscape as esc } from '../core/format.js';
import { holdWords, pnlBasis, pnlPct, tradesSummary } from '../core/journal.js';
import { store } from '../lib/store.js';
import { zoneAbbr } from '../lib/zone.js';
import { state } from '../state.js';
import { reviewChecklist, reviewQueue, setupGradeOf, setupsOf, toReview, tradePass } from './journal-review.js';
import {
  closeDay, closedDays, counts, dayWords, nowrap, openCard, progress, progressHtml, setupTags, sideTags, statsLine, stopNow,
  sum, unitWord, upNextHtml, upNextOf,
} from './journal-cards.js';
import {
  HISTORY_TITLE, clockTime, isReviewed, journalAfterFees, journalTradeList, pctTitleOf, pickBox, pnlClass, pnlTitle, px, renderJournal,
  restoreLink, reviewsRead, rTitleOf, setupChip, signed$, signedPct, signedR,
} from './journal.js';
import { nyParts } from '../core/journal-stats.js';
import { openJournalTrade } from './journal-trade.js';

/** Workbench (the table and the trade panel) or Review desk (the cards two-up) */
export const journalLayout = () => store.get('journal_layout') === 'desk' ? 'desk' : 'bench';
export function setJournalLayout(v) {
  store.set('journal_layout', v === 'desk' ? 'desk' : 'bench');
  renderJournal();
}
/** the switch, on the Trades tab's chips row in both layouts */
export function layoutSwitchHtml() {
  const b = (v, label, title) => `<button class="${journalLayout() === v ? 'active' : ''}" aria-pressed="${journalLayout() === v}" data-action="setJournalLayout" data-arg="${v}" title="${title}">${label}</button>`;
  return `<div class="seg jb-layout" aria-label="Layout">${b('bench', 'Workbench', 'The table, with the trade you pick in a panel')}${b('desk', 'Review desk', 'Cards two-up, with the review queue beside them')}</div>`;
}

const today = () => nyParts(new Date().toISOString()).day;
const dayLine = day => day === today() ? `Today · ${dayWords(day)}` : dayWords(day, true);

// ---------- the stats band ----------

/** Net P&L, win rate, average return and average R over the closed trades the filters let through */
function statsBand(trades, deleted) {
  const s = tradesSummary(trades);
  const cell = (label, value, sub, cls = '', title = '') => `<div${title ? ` title="${esc(title)}"` : ''}><dt>${label}</dt><dd class="${cls}">${value}</dd><span class="jb-band-sub">${sub}</span></div>`;
  const deletedNote = deleted ? `${deleted} deleted <button class="pos-link" data-action="toggleDeletedTrades">${state.journalShowDeleted ? 'Hide them' : 'Show'}</button>` : '';
  if (!s.closed && !s.open && !s.history) return `<p class="hint journal-summary">No trades match.${deletedNote ? ` ${deletedNote}` : ''}</p>`;
  const fees = journalAfterFees() ? `after fees${s.fees ? ` · fees ${fmt$(s.fees)}` : ''}` : 'before fees';
  const band = s.closed ? `<dl class="jb-band">
      ${cell('Net P&amp;L', signed$(s.pnl), fees, pnlClass(s.pnl))}
      ${cell('Win rate', `${s.winRate}%`, `${s.wins} of ${s.closed} closed`)}
      ${cell('Avg return', s.avgPct === null ? '—' : signedPct(s.avgPct), 'per closed trade', s.avgPct === null ? '' : pnlClass(s.avgPct))}
      ${cell('Avg R', s.avgR === null ? '—' : signedR(s.avgR), s.avgR === null ? 'no stops yet' : `over ${s.withR} with a stop`, s.avgR === null ? '' : pnlClass(s.avgR))}
    </dl>` : '';
  const notes = [
    s.closed ? `<span class="jb-note-quiet">${journalAfterFees() ? 'After fees' : 'Before fees'}</span>` : '',
    s.closed && journalAfterFees() && s.feesMissing ? `<span class="journal-fees-missing">fees not in yet on ${s.feesMissing}</span>` : '',
    s.history ? `<span class="journal-fees-missing" title="${esc(HISTORY_TITLE)}">${s.history} trade${s.history === 1 ? '' : 's'} from before your history ${s.history === 1 ? 'is' : 'are'} left out</span>` : '',
    s.open ? `<span class="jb-note-quiet">${s.open} open</span>` : '',
    deletedNote,
  ].filter(Boolean);
  return `${band}${notes.length ? `<p class="hint jb-notes">${notes.join(' · ')}</p>` : ''}`;
}

// ---------- the Workbench table ----------

/** the table's columns after Symbol: [key, header]; the first four show until you change them (journal_bench_cols, this device) */
export const BENCH_COLS = [['setups', 'Setup'], ['pnl', 'P&amp;L'], ['r', 'R'], ['stop', 'Stop'], ['qty', 'Qty'], ['entry', 'Entry'], ['exit', 'Exit'], ['hold', 'Hold'], ['opened', 'Opened']];
const BENCH_DEFAULT = ['setups', 'pnl', 'r', 'stop'];
function benchShown() {
  let list = null;
  try { list = JSON.parse(store.get('journal_bench_cols') || 'null'); } catch(e) {}
  const keys = BENCH_COLS.map(([k]) => k);
  const shown = Array.isArray(list) ? list.filter(k => keys.includes(k)) : BENCH_DEFAULT;
  return BENCH_COLS.filter(([k]) => shown.includes(k));
}
/** a column chip in the Columns picker: shows or hides it (one stays) */
export function toggleBenchColumn(key) {
  if (!BENCH_COLS.some(([k]) => k === key)) return;
  const shown = benchShown().map(([k]) => k), on = shown.includes(key);
  if (on && shown.length === 1) return;
  store.set('journal_bench_cols', JSON.stringify(BENCH_COLS.map(([k]) => k).filter(k => k === key ? !on : shown.includes(k))));
  renderJournal();
}
export function benchColumnPicker() {
  if (!state.journalColsOpen) return '';
  const shown = benchShown().map(([k]) => k), last = shown.length === 1;
  return `<div class="chip-row pos-cols journal-cols" role="group" aria-label="Columns">${BENCH_COLS.map(([key, label]) => {
    const on = shown.includes(key);
    return `<button class="filter-btn${on ? ' active' : ''}" data-action="toggleBenchColumn" data-arg="${key}" aria-pressed="${on}"${on && last ? ' disabled title="Keep one column"' : ''}>${key === 'opened' ? `${label} (${zoneAbbr()})` : label}</button>`;
  }).join('')}</div>`;
}

/** '416 shr · Oct 28 → Oct 30 · 1d 20h': the size, the days, how long (an open one: what's still open) */
function rowSub(t) {
  const nyDay = iso => dayWords(nyParts(iso).day);
  if (t.status === 'history') return nowrap([`${t.entryQty} ${unitWord(t)}`, `closed ${nyDay(t.closedAt || t.openedAt)}`, 'bought earlier']);
  if (t.status === 'open') return nowrap([t.openQty !== t.entryQty ? `${t.openQty}/${t.entryQty} ${unitWord(t)} open` : `${t.entryQty} ${unitWord(t)}`, holdWords(Date.now() - Date.parse(t.openedAt))]);
  const a = nyDay(t.openedAt), b = nyDay(t.closedAt || t.openedAt);
  return nowrap([`${t.entryQty} ${unitWord(t)}`, a === b ? a : `${a} → ${b}`, holdWords(t.holdMs)]);
}

/** under R: the grade once reviewed, To review while it waits, the opening pass while it's open and waiting */
function reviewWord(t) {
  if (t.deleted || t.status === 'history' || !reviewsRead()) return '';
  if (isReviewed(t)) { const g = setupGradeOf(t); return g ? `<span class="jb-grade jtc-grade-${g.toLowerCase()}">Grade ${g}</span>` : '<span class="jb-grade jtc-grade-a">Reviewed</span>'; }
  if (toReview(t)) return `<span class="jb-todo">${tradePass(t) === 'opening' ? 'Opening pass' : 'To review'}</span>`;
  return '';
}

/** the stop now: where it moved to (from the first), yours, or Set */
function stopCell(t) {
  if (t.legs) return '<span title="A spread\'s risk is its defined risk">—</span>';
  if (t.status === 'history') return '—';
  const key = esc(t.key);
  if (t.stop === null) return `<button class="pos-link" data-action="openTradeReview" data-arg="${key}" aria-label="Set a stop for ${esc(t.label)}">Set</button>${t.rBasis === 'premium' ? '<span class="pos-sub">premium</span>' : ''}`;
  const now = stopNow(t), moved = t.movedTo !== null && t.stopSource !== 'yours';
  return `<span class="jb-stop">${now.text}</span>${moved ? `<span class="pos-sub">moved from ${px(t.stop, t.assetType)}</span>` : t.stopSource === 'yours' ? '<span class="pos-sub">yours</span>' : ''}`;
}

function pnlCell(t) {
  const none = t.status === 'history' || (t.status === 'open' && !t.exits);
  if (none) return '<td class="jb-num">—</td>';
  const basis = pnlBasis(t), pct = pnlPct(t);
  const sub = pct === null || basis === null ? '' : `<span class="pos-sub" title="${esc(pctTitleOf(t, basis))}">${signedPct(pct)}${t.status === 'open' ? ' so far' : ''}</span>`;
  return `<td class="jb-num ${pnlClass(t.pnl)}"${pnlTitle(t)}>${signed$(t.pnl)}${sub}</td>`;
}

function benchRow(t, cols) {
  const sel = state.journalSelected === t.key, history = t.status === 'history';
  const list = setupsOf(t);
  const cells = {
    setups: `<td class="journal-setups">${list.length ? list.map(setupChip).join('') : '<span class="journal-setups-none">—</span>'}</td>`,
    pnl: pnlCell(t),
    r: `<td class="jb-num" title="${esc(rTitleOf(t))}">${history || t.r === null ? '—' : `<span class="${pnlClass(t.r)}">${signedR(t.r)}</span>`}${reviewWord(t)}</td>`,
    stop: `<td class="jb-num">${stopCell(t)}</td>`,
    qty: `<td class="jb-num">${t.entryQty}</td>`,
    entry: `<td class="jb-num">${history ? '—' : px(t.avgEntry, t.assetType)}</td>`,
    exit: `<td class="jb-num">${t.avgExit === null ? '—' : px(t.avgExit, t.assetType)}</td>`,
    hold: `<td class="jb-num">${t.status === 'open' ? 'open' : history ? '—' : esc(holdWords(t.holdMs))}</td>`,
    opened: `<td class="jb-num">${history ? 'earlier' : esc(clockTime(t.openedAt))}</td>`,
  };
  const live = t.status === 'open' && !t.deleted ? ' <span class="jb-live">Live</span>' : '';
  const pick = state.journalSelecting || state.journalPicked.length ? pickBox(t) : '';
  return `<tr class="jb-row${sel ? ' jb-sel' : ''}${t.deleted ? ' journal-deleted' : ''}" data-action="selectJournalTrade" data-arg="${esc(t.key)}" aria-selected="${sel}"${history ? ` title="${esc(HISTORY_TITLE)}"` : ''}>
    <td><div class="journal-sym">${pick}<div class="journal-sym-main"><div class="jb-name"><b>${esc(t.label)}</b>${sideTags(t)}${live}</div><div class="jb-sub">${rowSub(t)}</div>${restoreLink(t)}</div></div></td>
    ${cols.map(([k]) => cells[k]).join('')}
  </tr>`;
}

/** the trades a group at a time: Open, then each day they closed, newest first, with what waits and the day's P&L */
function benchGroups(list, cols) {
  const n = cols.length + 1;
  const head = (left, right) => `<tr class="jb-day"><td colspan="${n}"><div><span>${left}</span>${right}</div></td></tr>`;
  const open = list.filter(t => t.status === 'open'), closed = list.filter(t => t.status !== 'open');
  /** @type {Map<string, any[]>} */
  const byDay = new Map();
  for (const t of closed) byDay.set(closeDay(t), [...(byDay.get(closeDay(t)) || []), t]);
  const rows = [];
  if (open.length) rows.push(head(`Open <span class="jb-day-n">${open.length}</span>`, open.some(counts) ? `<span class="jb-day-total">Taken so far <b class="${pnlClass(sum(open))}">${signed$(sum(open))}</b></span>` : ''), ...open.map(t => benchRow(t, cols)));
  for (const [day, trades] of [...byDay.entries()].sort((a, b) => a[0] < b[0] ? 1 : -1)) {
    const live = trades.filter(t => !t.deleted && t.status !== 'history');
    const waiting = reviewsRead() ? live.filter(toReview).length : 0;
    const status = waiting ? `<span class="jtc-day-todo">${waiting} to review</span>` : reviewsRead() && live.length && live.every(isReviewed) ? '<span class="jtc-day-done">All reviewed</span>' : '';
    rows.push(head(`${dayLine(day)} <span class="jb-day-n">${trades.length} trade${trades.length === 1 ? '' : 's'}</span>${status}`, trades.some(counts) ? `<b class="jb-day-total ${pnlClass(sum(trades))}">${signed$(sum(trades))}</b>` : ''), ...trades.map(t => benchRow(t, cols)));
  }
  return rows.join('');
}

// ---------- the trade panel ----------

/** the trade the panel shows: yours while it's in the list, else the newest still to review, else the first */
export function selectedOf(list) {
  return list.find(t => t.key === state.journalSelected) || list.find(t => !t.deleted && reviewsRead() && toReview(t)) || list[0] || null;
}

/** a row clicked: it shows in the panel; clicked again (it's already there), its page opens */
export function selectJournalTrade(key, event) {
  if (event?.target?.closest?.('.journal-pick')) return;
  if (state.journalSelected === key) { openJournalTrade(key); return; }
  state.journalSelected = String(key || '');
  renderJournal();
}
/** ↑ ↓: the trade above or below in the list as shown */
export function stepJournalSelection(by, shownKeys) {
  const keys = shownKeys(), at = keys.indexOf(state.journalSelected);
  const next = keys[at < 0 ? 0 : Math.max(0, Math.min(keys.length - 1, at + (by < 0 ? -1 : 1)))];
  if (!next || next === state.journalSelected) return;
  state.journalSelected = next;
  renderJournal();
  document.querySelector?.('.jb-row.jb-sel')?.scrollIntoView?.({ block: 'nearest' });
}

/** the panel's Skip: the next trade still to review after this one, round to the first */
export function skipPanelTrade() {
  const queue = reviewQueue(journalTradeList());
  if (!queue.length) return;
  const at = queue.findIndex(t => t.key === state.journalSelected);
  state.journalSelected = queue[(at + 1) % queue.length].key;
  renderJournal();
}

/** the figures under the name: entry, average exit, the stop (and where it went), R */
function panelFigs(t) {
  const fig = (label, value, cls = '', title = '') => `<div${title ? ` title="${esc(title)}"` : ''}><dt>${label}</dt><dd class="${cls}">${value}</dd></div>`;
  const history = t.status === 'history', now = stopNow(t), moved = t.movedTo !== null && t.stopSource !== 'yours' && !t.legs;
  return `<dl class="jb-figs">
    ${fig('Entry', history ? '—' : px(t.avgEntry, t.assetType))}
    ${fig(t.exits > 1 ? 'Avg exit' : 'Exit', t.avgExit === null ? '—' : px(t.avgExit, t.assetType))}
    ${fig('Stop', t.stop === null || t.legs || history ? '—' : moved ? `${px(t.stop, t.assetType)} → ${now.text}` : px(t.stop, t.assetType))}
    ${fig('R', t.r === null ? '—' : signedR(t.r), t.r === null ? '' : pnlClass(t.r), rTitleOf(t))}
  </dl>`;
}

/** where the review stands: what's done and what's missing, and the button to its page */
function reviewCard(t, queue) {
  const key = esc(t.key);
  if (!reviewsRead() || t.deleted) return `<button class="btn jb-open" data-action="openTradeRow" data-arg="${key}">Open trade ›</button>`;
  const items = reviewChecklist(t), required = items.filter(i => !i.optional);
  const done = required.filter(i => i.done).length, waiting = toReview(t), reviewed = isReviewed(t);
  const at = queue.findIndex(x => x.key === t.key);
  const eyebrow = waiting ? `To review${at >= 0 ? ` · ${at + 1} of ${queue.length}` : ''}` : reviewed ? '✓ Reviewed' : t.status === 'open' ? 'Opening pass done' : 'Review';
  const mark = i => i.done ? '<span class="jb-ck jb-ck-done" aria-hidden="true">✓</span>' : i.later ? '<span class="jb-ck" aria-hidden="true">·</span>' : '<span class="jb-ck jb-ck-miss" aria-hidden="true">●</span>';
  const value = i => i.optional ? (i.value ? esc(i.value) : 'optional') : i.done ? esc(i.value) : i.later ? 'after the close' : 'missing';
  const rows = items.map(i => `<li class="${i.done ? 'jb-li-done' : i.later || i.optional ? 'jb-li-quiet' : 'jb-li-miss'}">${mark(i)}<span class="jb-li-label">${i.label}</span><span class="jb-li-value">${value(i)}</span></li>`).join('');
  const bar = required.map((_, i) => `<span class="${i < done ? 'on' : ''}"></span>`).join(''); // fills from the left
  return `<section class="jb-review${waiting ? ' jb-review-todo' : reviewed ? ' jb-review-done' : ''}" aria-label="Review">
      <div class="jb-review-top"><span class="jb-eyebrow">${eyebrow}</span>${waiting && queue.length > 1 ? '<button class="jun-skip" data-action="skipPanelTrade">Skip ›</button>' : ''}</div>
      <div class="jb-review-row"><span>Review progress</span><span class="jb-review-n">${done} of ${required.length} done</span></div>
      <div class="jb-segs" role="progressbar" aria-valuemin="0" aria-valuemax="${required.length}" aria-valuenow="${done}" aria-label="${done} of ${required.length} done">${bar}</div>
      <ul class="jb-list">${rows}</ul>
      <button class="${waiting ? 'jtc-go jb-go' : 'btn jb-open'}" data-action="openTradeRow" data-arg="${key}">${waiting ? 'Open full review ›' : 'Open trade ›'}</button>
    </section>`;
}

function panelHtml(t) {
  if (!t) return '<p class="hint">Pick a trade to see it here.</p>';
  const all = journalTradeList(), queue = reviewQueue(all);
  const history = t.status === 'history', none = history || (t.status === 'open' && !t.exits);
  const basis = pnlBasis(t), pct = pnlPct(t);
  const day = t.status === 'open' ? 'Open' : dayLine(closeDay(t));
  const fees = t.afterFees && t.fees ? `<span class="jb-p-fees">fees ${fmt$(t.fees)}</span>` : '';
  return `<div class="jb-panel" aria-label="${esc(t.label)}">
    <div class="jb-p-top"><span>${day}</span><span class="jb-keys" title="The trade above or below (↑ ↓), its page (Enter)"><kbd>↑</kbd><kbd>↓</kbd></span></div>
    <div class="jb-p-name"><b>${esc(t.label)}</b>${sideTags(t)}</div>
    <div class="jb-p-sub">${rowSub(t)}</div>
    <div class="jb-p-pnl"><span class="jb-p-big ${none ? '' : pnlClass(t.pnl)}"${none ? '' : pnlTitle(t)}>${none ? '—' : signed$(t.pnl)}</span>${!none && pct !== null && basis !== null ? `<span class="${pnlClass(t.pnl)}">${signedPct(pct)}</span>` : ''}${t.status === 'open' && t.exits ? '<span class="jb-p-fees">so far</span>' : ''}${fees}</div>
    ${setupTags(t)}
    ${panelFigs(t)}
    ${history ? `<p class="hint">${esc(HISTORY_TITLE)}</p>` : reviewCard(t, queue)}
    <div class="jb-p-links"><button class="pos-link" data-action="openTradeReview" data-arg="${esc(t.key)}">Stop, merge or delete</button></div>
  </div>`;
}

/** Workbench: the band, the table a day at a time, the panel */
export function benchTradesHtml(trades, counted, deleted) {
  const cols = benchShown();
  const t = selectedOf(trades);
  if (reviewsRead()) state.journalSelected = t ? t.key : ''; // the default waits for the reviews: it's the newest still to review
  const main = `${statsBand(counted, deleted)}${benchColumnPicker()}
    <div class="positions-wrap jb-wrap"><table class="positions-table journal-table jb-table">
      <thead><tr><th scope="col">Symbol</th>${cols.map(([k, label]) => `<th scope="col"${k === 'setups' ? '' : ' class="jb-num"'}>${k === 'opened' ? `${label} (${zoneAbbr()})` : label}</th>`).join('')}</tr></thead>
      <tbody>${benchGroups(trades, cols)}</tbody>
    </table></div>`;
  return { main, side: panelHtml(t) };
}

// ---------- Review desk ----------

/** By setup: each setup's closed trades, their P&L and how many won, most used first (No setup last) */
function bySetupHtml(trades) {
  if (!reviewsRead()) return '';
  const closed = trades.filter(t => t.status !== 'open' && counts(t));
  /** @type {Map<string, { name: string, n: number, pnl: number, wins: number }>} */
  const by = new Map();
  const add = (key, name, t) => { const g = by.get(key) || { name, n: 0, pnl: 0, wins: 0 }; g.n++; g.pnl += t.pnl; if (t.pnl > 0) g.wins++; by.set(key, g); };
  for (const t of closed) {
    const list = setupsOf(t);
    if (!list.length) add('', 'No setup', t);
    for (const s of list) add(s.key, s.name, t);
  }
  if (!by.size) return '';
  const rows = [...by.entries()].sort((a, b) => (a[0] === '') - (b[0] === '') || b[1].n - a[1].n).slice(0, 6).map(([key, g]) => {
    const rate = Math.round(g.wins / g.n * 100);
    return `<li${key ? '' : ' class="jds-none"'}><div class="jds-row"><span class="jds-name">${esc(g.name)} <span class="jds-n">${g.n}</span></span><b class="${pnlClass(g.pnl)}">${signed$(g.pnl)}</b></div>
      <div class="jds-row"><span class="jds-bar"><span style="width:${rate}%"></span></span><span class="jds-rate">${rate}%</span></div></li>`;
  }).join('');
  return `<section class="jds" aria-label="By setup"><div class="jds-head"><h3>By setup</h3><button class="pos-link" data-action="setJournalTab" data-arg="setups">Setups ›</button></div><ul>${rows}</ul></section>`;
}

/** Review desk: the cards two-up (the trade Up next shows is left out, as on phones), the queue and By setup beside them */
export function deskTradesHtml(trades, counted, deleted) {
  const all = journalTradeList();
  const deck = ['all', 'todo'].includes(state.journalReviewFilter) && !state.journalSelecting && !state.journalPicked.length;
  const queue = deck ? reviewQueue(all) : [];
  const p = deck ? progress(all) : null;
  const next = upNextOf(queue);
  const shown = next ? trades.filter(t => t.key !== next.key) : trades;
  const open = shown.filter(t => t.status === 'open'), closed = shown.filter(t => t.status !== 'open');
  const head = (title, n, word, list) => `<div class="jtc-group-head"><h3>${title} <span>${n}</span></h3>${list.some(counts) ? `<span class="jtc-total">${word} <b class="${pnlClass(sum(list))}">${signed$(sum(list))}</b></span>` : ''}</div>`;
  const main = `${statsLine(counted, deleted)}
    <div class="jtc-list jds-cards">
      ${open.length ? `<section class="jtc-group">${head('Open', open.length, 'Taken so far', open)}${open.map(openCard).join('')}</section>` : ''}
      ${closed.length ? `<section class="jtc-group">${head('Closed', closed.length, 'Realized', closed)}${closedDays(closed)}</section>` : ''}
    </div>`;
  const side = `${progressHtml(p)}${upNextHtml(queue, p)}${bySetupHtml(counted)}`;
  state.journalJustReviewed = '';
  return { main, side: side || '<p class="hint">Nothing waits for a review.</p>' };
}
