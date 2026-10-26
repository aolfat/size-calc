// Week and month reviews (docs/journal-step-3.md, slice 6, parts 1 and 2): a week's total on the calendar, or Review the
// month, opens the period's review under the grid (state.journalReviewPeriod): the headline against the period before, the
// best and worst trade, the trades saved for the weekly review, every trade in a list you sort (by P&L, P&L %, R or when
// it opened), and each part of a self-assessment with its numbers
// (core/journal-week.js), its grade and its note; last week's rule with Kept it? on top, the week overall (what went well,
// what to work on, more notes) and the rule for next week at the bottom. The whole period, no filters. Exit efficiency and heat come from the trades' saved 5-minute bars, read once per
// trade (state.journalExcursions). Grades and notes are period_reviews rows (state.periodReviews), shown at once and put
// back with a toast if Supabase refuses; a note is a draft while you type and saves when the box loses focus.
import { fmt$, marketEscape as esc } from '../core/format.js';
import { buildLibrary } from '../core/journal-labels.js';
import { MISSED_WHY, periodMissed } from '../core/journal-notebook.js';
import { activePeriods, stepPeriod, underlyingOf } from '../core/journal-stats.js';
import { gradeColumn, MAX_PERIOD_NOTE, MAX_RULE, noteColumn, PERIOD_CATEGORIES, PERIOD_GRADES, PERIOD_OVERALL, PERIOD_OVERALL_COLUMNS, PERIOD_TRADE_SORTS, periodMissingWords, periodOver, periodReview, periodReviewState, periodTradeRows, previousPeriod, reviewTrades, RULE_KEPT, sortPeriodTrades } from '../core/journal-week.js';
import { excursions, unpackBars } from '../core/trade-page.js';
import { nyDay, weekdaysBetween } from '../core/bars.js';
import { parseSchwabOption } from '../core/positions.js';
import { loadTradeBars } from '../services/bars.js';
import { loadPeriodReviews, savePeriodFields } from '../services/journal-review.js';
import { state } from '../state.js';
import { showError } from './feedback.js';
import { periodReviewContext, reviewedMark } from './journal-review.js';
import { missedWords } from './journal-notebook.js';
import { periodName } from './journal-stats.js';
import { journalTradeList, renderJournal } from './journal.js';

const signed$ = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt$(Math.abs(v))}`;
const signedR = r => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}R`;
const pnlClass = v => v > 0 ? 'journal-buy' : v < 0 ? 'journal-sell' : '';
const validKey = (unit, key) => unit === 'month' ? /^\d{4}-\d{2}$/.test(key) : /^\d{4}-\d{2}-\d{2}$/.test(key);

/** what a trade's excursions were read from: a change (a late fill, a re-close) reads them again */
const signature = t => `${t.closedAt}|${t.entryQty}|${t.avgEntry}`;
/** the 5-minute bars a trade's excursions come from: an option contract's own, a stock's; spreads have none */
const barsSymbol = t => t.legs ? '' : t.assetType === 'OPTION' && parseSchwabOption(t.symbol) ? t.symbol.replace(/\s+/g, '') : t.symbol;

/** a trade's excursions: undefined until read, null when there are no bars for it */
function excursionOf(t) {
  const c = state.journalExcursions[t.key];
  return c && c.sig === signature(t) ? c.ex : undefined;
}

/** read the saved bars for the period's closed trades that haven't been read yet, one query per symbol */
async function loadExcursions(unit, key) {
  const { closedHere } = reviewTrades(journalTradeList(), unit, key);
  const todo = closedHere.filter(t => barsSymbol(t) && excursionOf(t) === undefined);
  for (const t of closedHere) if (!barsSymbol(t)) state.journalExcursions[t.key] = { sig: signature(t), ex: null };
  if (!todo.length) return;
  state.periodBarsBusy = true;
  renderJournal();
  const bySymbol = new Map();
  for (const t of todo) {
    const days = weekdaysBetween(nyDay(t.openedAt), nyDay(t.closedAt));
    const s = bySymbol.get(barsSymbol(t)) || { days: new Set(), trades: [] };
    days.forEach(d => s.days.add(d));
    s.trades.push(t);
    bySymbol.set(barsSymbol(t), s);
  }
  await Promise.all([...bySymbol].map(async ([symbol, { days, trades }]) => {
    let bars = [];
    try { bars = unpackBars(await loadTradeBars(symbol, [...days].sort())); } catch(e) { bars = []; }
    for (const t of trades) state.journalExcursions[t.key] = { sig: signature(t), ex: bars.length ? excursions(t, bars) : null };
  }));
  state.periodBarsBusy = false;
  if (state.journalReviewPeriod?.unit === unit && state.journalReviewPeriod?.key === key) renderJournal();
}

/** a week's total or Review the month: its review under the calendar (tapping the one open closes it) */
export function openPeriodReview(unit, key) {
  if (!['week', 'month'].includes(unit) || !validKey(unit, key)) return;
  const p = state.journalReviewPeriod;
  state.journalReviewPeriod = p && p.unit === unit && p.key === key ? null : { unit, key };
  renderJournal();
  if (state.journalReviewPeriod) {
    document.getElementById('journalPeriodReview')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    loadExcursions(unit, key);
  }
}
export function closePeriodReview() { state.journalReviewPeriod = null; renderJournal(); }
/** ‹ or ›: the nearest week or month with exits before or after */
export function stepPeriodReview(by) {
  const p = state.journalReviewPeriod;
  if (!p) return;
  const next = stepPeriod(activePeriods(journalTradeList(), p.unit), p.key, Number(by) || 0);
  if (!next) return;
  state.journalReviewPeriod = { unit: p.unit, key: next };
  // the calendar follows: a month to itself, a week to its Friday's month unless the month shown already holds it
  const fri = p.unit === 'week' ? new Date(Date.parse(`${next}T00:00:00Z`) + 4 * 864e5).toISOString().slice(0, 7) : next;
  const shown = state.journalMonth || state.journalMonthShown;
  if (p.unit === 'month' || (next.slice(0, 7) !== shown && fri !== shown)) state.journalMonth = fri;
  renderJournal();
  loadExcursions(p.unit, next);
}

// ---------- the period's trades, sorted ----------

const SORT_WORDS = { pnl: 'P&L', pct: 'P&L %', r: 'R', opened: 'Opened' };
/** a column header: sort by it (biggest first, or oldest first for Opened); again flips it */
export function setPeriodTradeSort(by) {
  if (!PERIOD_TRADE_SORTS.includes(by)) return;
  const now = state.periodTradeSort;
  state.periodTradeSort = now.by === by ? { by, dir: -now.dir } : { by, dir: by === 'opened' ? 1 : -1 };
  renderJournal();
}

const signedPct = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`;
const SIDE_WORDS = { long: 'Long', short: 'Short', neutral: 'Neutral' };
const openedDay = iso => iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' }) : '';

function sortHead(by, cls = '') {
  const { by: on, dir } = state.periodTradeSort, lit = on === by;
  const sort = lit ? ` aria-sort="${dir < 0 ? 'descending' : 'ascending'}"` : '';
  return `<th scope="col" class="jw-sort${cls}"${sort}><button data-action="setPeriodTradeSort" data-arg="${by}" title="Sort by ${esc(SORT_WORDS[by])}; again to reverse">${esc(SORT_WORDS[by])}${lit ? dir < 0 ? ' ↓' : ' ↑' : ''}</button></th>`;
}

function tradeRow(x, word) {
  const t = x.trade, none = x.pnl === null;
  const what = x.open ? `<span class="journal-tag">open</span>` : x.partial ? `<span class="journal-tag journal-tag-quiet" title="Part of it closed this ${word}: the P&amp;L, % and R are that part's">part</span>` : '';
  return `<tr data-action="openTradeRow" data-arg="${esc(t.key)}">
    <td><button class="journal-name" data-action="openTradeRow" data-arg="${esc(t.key)}" aria-label="Open the ${esc(t.label || underlyingOf(t))} trade"><b>${esc(t.label || underlyingOf(t))}</b></button> ${what}${reviewedMark(t)}<span class="pos-sub"><span class="${{ long: 'journal-buy', short: 'journal-sell' }[t.bias] || ''}">${esc(SIDE_WORDS[t.bias] || '')}</span><span class="jw-sub-day"> · ${esc(openedDay(t.openedAt))}</span></span></td>
    <td class="jw-col-opened">${esc(openedDay(t.openedAt))}</td>
    <td class="${none ? '' : pnlClass(x.pnl)}">${none ? '—' : signed$(x.pnl)}</td>
    <td class="${x.pct === null ? '' : pnlClass(x.pnl)}">${x.pct === null ? '—' : signedPct(x.pct)}</td>
    <td>${x.r === null ? '—' : signedR(x.r)}</td>
  </tr>`;
}

/** every trade the review covers, in the order you picked: tap a header to sort, a row to open the trade */
function tradeList(trades, p) {
  const word = unitWord(p.unit);
  const rows = sortPeriodTrades(periodTradeRows(trades, p.unit, p.key), state.periodTradeSort.by, state.periodTradeSort.dir);
  if (!rows.length) return '';
  return `<div class="section-title js-sub">Trades <span class="jw-optional">${rows.length}</span></div>
    <div class="positions-wrap jw-trades"><table class="positions-table journal-table jw-trades-table" aria-label="The ${word}'s trades">
      <thead><tr><th scope="col">Trade</th>${sortHead('opened', ' jw-col-opened')}${sortHead('pnl')}${sortHead('pct')}${sortHead('r')}</tr></thead>
      <tbody>${rows.map(x => tradeRow(x, word)).join('')}</tbody>
    </table></div>`;
}

// ---------- the trades you missed (journal_days.missed) ----------

const missedDay = day => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });

/** every trade you logged as missed in the period, a line each (tap: its day, open), and how many for each reason */
function missedList(p) {
  const d = state.journalReview;
  if (!d || d.notebookError || d.missedError) return '';
  const list = periodMissed(d.days, p.unit, p.key);
  if (!list.length) return '';
  const lib = buildLibrary(d.library || []);
  const whys = MISSED_WHY.map(([k, w]) => [w, list.filter(m => m.why === k).length]).filter(([, n]) => n);
  const lines = list.map(m => {
    const what = missedWords(lib, m);
    return `<li><button class="nb-trade nb-miss" data-action="openMissedOnDay" data-arg="${esc(m.day)}" data-arg2="${esc(m.id)}" aria-label="${esc(`${m.symbol} missed on ${missedDay(m.day)}. Open the day`)}"><span class="nb-trade-name"><b>${esc(m.symbol)}</b>${what ? ` ${esc(what)}` : ''}${m.note ? `<span class="nb-miss-note">${esc(m.note)}</span>` : ''}</span><span class="jw-miss-day">${esc(missedDay(m.day))}</span></button></li>`;
  }).join('');
  return `<div class="section-title js-sub">Missed trades <span class="jw-optional">${list.length}</span></div>
    ${whys.length ? `<p class="hint jw-lines">${whys.map(([w, n]) => `${esc(w)} ${n}`).join(' · ')}</p>` : ''}
    <ul class="nb-trades jw-missed" aria-label="The ${unitWord(p.unit)}'s missed trades">${lines}</ul>`;
}

// ---------- grades and notes (period_reviews) ----------

const CATEGORY_KEYS = new Set(PERIOD_CATEGORIES.map(([k]) => k));
const rowId = (unit, key) => `${unit}|${key}`;
const rowOf = (unit, key) => state.periodReviews?.[rowId(unit, key)] || null;
const unitWord = unit => unit === 'month' ? 'month' : 'week';

/** read every period's grades and notes; a failure (the table not pushed yet) keeps the numbers working and says why */
export async function loadPeriodReviewRows() {
  try {
    const { rows, overallError } = await loadPeriodReviews();
    state.periodReviews = Object.fromEntries(rows.map(r => [rowId(r.unit, r.period_key), r]));
    state.periodReviewsError = '';
    state.periodOverallError = overallError;
  } catch(e) {
    state.periodReviewsError = String(e?.message || e);
  }
}

/** where a week's or month's review stands, or null before the rows are read (or when they can't be) */
export function periodStatus(unit, key) {
  if (!state.periodReviews || state.periodReviewsError) return null;
  return periodReviewState(rowOf(unit, key));
}

/** the calendar's mark on a week or month: reviewed, or (once it's over) still to review */
export function periodMark(unit, key) {
  const st = periodStatus(unit, key);
  if (!st) return '';
  if (st.reviewed) return '<span class="jc-rev jc-rev-done">✓ reviewed</span>';
  return periodOver(unit, key, new Date(Date.now()).toISOString()) ? `<span class="jc-rev jc-rev-due">review ${unitWord(unit)}</span>` : '';
}

/** the redraw replaces the panel: keep the box you're in */
function redraw() {
  const id = document.activeElement?.id;
  renderJournal();
  const el = id ? document.getElementById(id) : null;
  if (el && el.focus && el !== document.activeElement) el.focus();
}

/** shown at once; if Supabase refuses, the fields this save sent go back (unless changed since) and a toast says why */
async function savePeriod(fields) {
  const p = state.journalReviewPeriod;
  if (!p || !state.periodReviews || state.periodReviewsError) return;
  const id = rowId(p.unit, p.key), before = rowOf(p.unit, p.key);
  const next = { unit: p.unit, period_key: p.key, ...(before || {}), ...fields };
  const reviewed = periodReviewState(next).reviewed;
  if (reviewed !== !!next.reviewed_at) fields = { ...fields, reviewed_at: next.reviewed_at = reviewed ? new Date(Date.now()).toISOString() : null };
  state.periodReviews[id] = next;
  redraw();
  try { await savePeriodFields(p.unit, p.key, fields); }
  catch(e) {
    const now = state.periodReviews?.[id];
    if (now) for (const [f, v] of Object.entries(fields)) if (now[f] === v) now[f] = before?.[f] ?? null;
    showError(`Couldn't save the review: ${String(e?.message || e)}`);
    redraw();
  }
}

/** a part's grade (the blank choice clears it) */
export function setPeriodGrade(cat, grade) {
  if (!CATEGORY_KEYS.has(cat)) return;
  return savePeriod({ [gradeColumn(cat)]: PERIOD_GRADES.includes(grade) ? grade : null });
}
/** Kept it? on the period before's rule (tapping the lit one clears it) */
export function setRuleKept(value) {
  const p = state.journalReviewPeriod;
  if (!p) return;
  const now = rowOf(p.unit, p.key)?.rule_kept || null;
  return savePeriod({ rule_kept: RULE_KEPT.some(([v]) => v === value) && value !== now ? value : null });
}

const OVERALL_KEYS = new Set(PERIOD_OVERALL_COLUMNS);
/** a part's note ('selection' … 'consistency'), an overall note ('went_well', 'work_on', 'note') or the rule for next week ('rule'): its column and longest text */
const textField = field => field === 'rule' ? { col: 'rule_next', max: MAX_RULE } : CATEGORY_KEYS.has(field) ? { col: noteColumn(field), max: MAX_PERIOD_NOTE }
  : OVERALL_KEYS.has(field) && !state.periodOverallError ? { col: field, max: MAX_PERIOD_NOTE } : null;
/** typing: a draft (a redraw never loses it) */
export function periodTextInput(field, text) {
  const p = state.journalReviewPeriod;
  if (p && textField(field)) state.periodNoteDraft = { unit: p.unit, key: p.key, field, text };
}
/** the box lost focus: saved, unless nothing changed */
export function periodTextSave(field, text) {
  const p = state.journalReviewPeriod, f = textField(field);
  state.periodNoteDraft = null;
  if (!p || !f) return;
  const value = String(text || '').trim().slice(0, f.max);
  if (value === (rowOf(p.unit, p.key)?.[f.col] || '').trim()) return;
  return savePeriod({ [f.col]: value || null });
}
/** what a box shows: the draft being typed, else what's saved */
function textOf(unit, key, field) {
  const d = state.periodNoteDraft, f = textField(field);
  if (d && d.unit === unit && d.key === key && d.field === field) return d.text;
  return f ? rowOf(unit, key)?.[f.col] || '' : '';
}

const gradeTone = g => !g ? '' : g.startsWith('A') ? ' jw-grade-good' : g.startsWith('D') || g === 'F' ? ' jw-grade-bad' : '';

/** a part's grade picker and note box; disabled while the rows can't be read or saved */
function gradeAndNote(c, p, off) {
  const row = rowOf(p.unit, p.key), g = row?.[gradeColumn(c.key)] || '';
  const options = ['', ...PERIOD_GRADES].map(v => `<option value="${v}"${v === g ? ' selected' : ''}>${v || 'Grade'}</option>`).join('');
  return {
    grade: `<select class="jw-grade${gradeTone(g)}${g ? '' : ' jw-grade-empty'}" id="jwGrade-${c.key}" data-change="setPeriodGrade" data-arg="${c.key}" aria-label="${esc(c.name)} grade"${off}>${options}</select>`,
    note: `<textarea class="jw-note" id="jwNote-${c.key}" rows="2" maxlength="${MAX_PERIOD_NOTE}" placeholder="Notes" aria-label="${esc(c.name)} notes" data-input="periodTextInput" data-change="periodTextSave" data-arg="${c.key}"${off}>${esc(textOf(p.unit, p.key, c.key))}</textarea>`,
  };
}

const cell = (label, value, sub = '', cls = '') => `<div><dt>${label}</dt><dd class="${cls}">${value}${sub ? `<span class="pos-sub">${sub}</span>` : ''}</dd></div>`;

function headline(r, word) {
  const s = r.stats, p = r.prev, before = `the ${word} before`;
  const vs = (now, then, f) => then === null || then === undefined ? '' : `${f(then)} ${before}`;
  return `<dl class="js-stats jw-stats">
    ${cell('Net P&amp;L', s.trades ? signed$(s.net) : '—', p.trades ? `${signed$(p.net)} ${before}` : `${s.trades} closed`, pnlClass(s.net))}
    ${cell('Win rate', s.winRate === null ? '—' : `${s.winRate}%`, vs(s.winRate, p.winRate, x => `${x}%`))}
    ${cell('Profit factor', s.profitFactor === null ? '—' : s.profitFactor.toFixed(2), s.profitFactor === null && s.trades ? 'no losses' : vs(s.profitFactor, p.profitFactor, x => x.toFixed(2)))}
    ${cell('Average R', s.avgR === null ? '—' : signedR(s.avgR), vs(s.avgR, p.avgR, signedR))}
  </dl>`;
}

const tradeLink = (t, extra = '') => `<button class="pos-link" data-action="openTradeRow" data-arg="${esc(t.key)}">${esc(underlyingOf(t))}</button>${extra}`;

function category(c, p, off) {
  const facts = c.facts.length ? c.facts.map(f => `<li class="${f.tone === 'good' ? 'jw-good' : f.tone === 'bad' ? 'jw-bad' : ''}">${esc(f.text)}</li>`).join('')
    : '<li class="jw-none">Nothing to go on yet.</li>';
  const g = gradeAndNote(c, p, off);
  const missing = !off && !rowOf(p.unit, p.key)?.[gradeColumn(c.key)];
  return `<section class="jw-cat${missing ? ' jw-cat-open' : ''}"><div class="jw-cat-top"><div class="jw-cat-name">${esc(c.name)}</div>${g.grade}</div><ul class="jw-facts">${facts}</ul>${g.note}</section>`;
}

const chip = (label, on, attrs) => `<button class="filter-btn${on ? ' active' : ''}" aria-pressed="${on}" ${attrs}>${esc(label)}</button>`;

/** over the parts: where the review stands (or why it can't be saved), and the period before's rule with Kept it? */
function reviewTop(p, off) {
  const word = unitWord(p.unit);
  if (state.periodReviewsError) return `<p class="hint jw-db">Grades and notes need a database update: ${esc(state.periodReviewsError)}. The numbers still work.</p>`;
  if (!state.periodReviews) return '<p class="hint jw-status">Loading your grades and notes…</p>';
  const st = periodReviewState(rowOf(p.unit, p.key));
  const status = st.reviewed ? `<p class="jw-status"><span class="journal-tag journal-tag-done">reviewed</span> Every part graded and the rule for next ${word} set.</p>`
    : `<p class="jw-status jw-status-open">To finish: ${esc(periodMissingWords(st, p.unit))}.</p>`;
  const before = rowOf(p.unit, previousPeriod(p.unit, p.key)), kept = rowOf(p.unit, p.key)?.rule_kept || '';
  const rule = before?.rule_next ? `<div class="jw-rule jw-rule-last"><div class="jw-rule-label">Last ${word}'s rule</div><p class="jw-rule-text">${esc(before.rule_next)}</p>
      <div class="jw-kept" role="group" aria-label="Kept last ${word}'s rule?"><span class="jw-kept-q">Kept it?</span>${RULE_KEPT.map(([v, w]) => chip(w, kept === v, `data-action="setRuleKept" data-arg="${v}"${off}`)).join('')}</div></div>` : '';
  return status + rule;
}

const OVERALL_HINTS = { went_well: 'What you did right, what worked', work_on: "What to fix, what you'd do differently", note: 'Anything else about the week' };

/** under the parts: notes on the week (or month) as a whole, none of them needed to finish it */
function overall(p, off) {
  const word = unitWord(p.unit), dbOff = off || (state.periodOverallError ? ' disabled' : '');
  const box = ([col, label]) => `<div class="jw-overall-field"><label class="jw-overall-label" for="jwOverall-${col}">${esc(label)}</label>
      <textarea class="jw-note" id="jwOverall-${col}" rows="3" maxlength="${MAX_PERIOD_NOTE}" placeholder="${esc(OVERALL_HINTS[col].replace('week', word))}" data-input="periodTextInput" data-change="periodTextSave" data-arg="${col}"${dbOff}>${esc(textOf(p.unit, p.key, col))}</textarea></div>`;
  const why = state.periodOverallError && !off ? `<p class="hint jw-db">Overall notes need a database update: ${esc(state.periodOverallError)}. Grades and the rest still save.</p>` : '';
  return `<section class="jw-overall" aria-label="The ${word} overall"><div class="jw-cat-name">The ${word} overall <span class="jw-optional">optional</span></div>${why}
    <div class="jw-overall-grid">${PERIOD_OVERALL.map(box).join('')}</div></section>`;
}

/** under the parts: the one rule for next week (or month) */
function ruleNext(p, off) {
  const word = unitWord(p.unit), missing = !off && !periodReviewState(rowOf(p.unit, p.key)).rule;
  return `<div class="jw-rule${missing ? ' jw-cat-open' : ''}"><label class="jw-rule-label" for="jwRuleNext">Rule for next ${word}</label>
    <input type="text" class="jw-rule-input" id="jwRuleNext" maxlength="${MAX_RULE}" autocomplete="off" placeholder="One rule to hold yourself to" data-input="periodTextInput" data-change="periodTextSave" data-arg="rule" value="${esc(textOf(p.unit, p.key, 'rule'))}"${off} /></div>`;
}

/** the review open under the calendar, or nothing */
export function periodReviewHtml(trades) {
  const p = state.journalReviewPeriod;
  if (!p) return '';
  const r = periodReview(trades, p.unit, p.key, { ...periodReviewContext(), excursion: excursionOf, barsPending: state.periodBarsBusy });
  const word = p.unit === 'month' ? 'month' : 'week';
  const lock = state.periodReviews && !state.periodReviewsError ? '' : ' disabled';
  const active = activePeriods(trades, p.unit);
  const off = by => stepPeriod(active, p.key, by) ? '' : ' disabled';
  const title = p.unit === 'month' ? periodName('month', p.key) : `Week of ${periodName('week', p.key)}`;
  const best = r.best ? tradeLink(r.best, ` <span class="journal-buy">${signed$(r.best.pnl)}</span>`) : '';
  const worst = r.worst ? tradeLink(r.worst, ` <span class="journal-sell">${signed$(r.worst.pnl)}</span>`) : '';
  const lines = [
    best || worst ? `${best ? `Best: ${best}` : ''}${best && worst ? ' · ' : ''}${worst ? `Worst: ${worst}` : ''}` : '',
    r.saved.length ? `Saved for the weekly review: ${r.saved.map(t => tradeLink(t)).join(', ')}` : '',
    r.openCount ? `${r.openCount} opened this ${word} still open` : '',
  ].filter(Boolean);
  return `<div class="jw-panel" id="journalPeriodReview" role="region" aria-label="${esc(title)} review">
    <div class="jc-head jw-head">
      <button class="btn jc-nav" data-action="stepPeriodReview" data-arg="-1" aria-label="Earlier ${word} with trades"${off(-1)}>‹</button>
      <span class="jc-title">${esc(title)}</span>
      <button class="btn jc-nav" data-action="stepPeriodReview" data-arg="1" aria-label="Later ${word} with trades"${off(1)}>›</button>
      <button class="pos-link" data-action="openJournalStats" data-arg="${p.unit}" data-arg2="${p.key}">All of the ${word}'s stats</button>
      <button class="btn jw-close" data-action="closePeriodReview" aria-label="Close the review">×</button>
    </div>
    ${r.trades ? `${headline(r, word)}
      ${lines.length ? `<p class="hint jw-lines">${lines.join('<br>')}</p>` : ''}
      ${tradeList(trades, p)}
      ${missedList(p)}
      ${reviewTop(p, lock)}
      <div class="jw-cats">${r.categories.map(c => category(c, p, lock)).join('')}</div>
      ${overall(p, lock)}
      ${ruleNext(p, lock)}
      <p class="hint">The whole ${word}: the side, symbol and setup filters don't apply. Results count the exits taken this ${word}, like the calendar (a trade partly closed shows that part's P&amp;L, % and R); entries, notes and trades per day count the trades opened in it. The best move and heat come from each trade's saved 5-minute bars. Green reads well, amber is worth a look. A ${word} is reviewed once every part has a grade and the rule for next ${word} is set; notes, the ${word} overall too, save when you leave the box.</p>`
    : `<p class="hint">No trades this ${word}.</p>${missedList(p)}`}
  </div>`;
}
