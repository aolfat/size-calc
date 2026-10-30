// The Journal's More filters (docs/journal.md, More filters; core/journal-filters.js): + Add filter puts a field under the
// filters (the setup grade, the outcome, R, the instrument, time and day opened, hold, exits, and what the review says),
// is or is not, its values as chips with how many trades each lets through, × takes it off. Trades, Calendar and Stats.
import { FILTER_FIELDS, applyFilters, filterChoices, filterField, filtersOn } from '../core/journal-filters.js';
import { marketEscape as esc } from '../core/format.js';
import { state } from '../state.js';
import { reviewLibrary, setupGradeOf, shownSide, tradeReviewState } from './journal-review.js';
import { renderJournal, reviewsRead } from './journal.js';

/** the tabs the filters narrow: the same ones the setup filter does */
export const moreFiltersTab = () => ['trades', 'calendar', 'stats'].includes(state.journalTab);

/** what the review says about a trade, read once per pass (the library is built once, not per trade) */
function context() {
  const d = state.journalReview, lib = reviewLibrary(), side = shownSide();
  return {
    grade: t => setupGradeOf(t),
    plan: t => d?.reviews[t.key]?.plan_followed || '',
    market: t => d ? tradeReviewState(t).market || '' : '',
    labels: (t, kind) => d ? [...new Set((d.labels[t.key] || []).filter(l => l.kind === kind).map(l => lib.resolve(kind, l.value)))] : [],
    nameOf: (kind, key) => lib.nameOf(kind, key, side),
  };
}

/** the filters in force: a review field only once the reviews are read (else every trade would read as not graded) */
const active = () => state.journalFilters.filter(f => filterField(f.field) && (!filterField(f.field)?.review || reviewsRead()));
/** the trades that fit every filter */
export const onMoreFilters = list => filtersOn(active()) ? applyFilters(list, active(), context()) : list;
/** how many narrow the list, for the phones' Filters count */
export const moreFiltersOn = () => filtersOn(active());

/**
 * The filters under the others: each one's name, is / is not, its values as chips (counted over base, the trades the other
 * filters leave), ×; then + Add filter (the fields not used yet) and Remove all
 * @param {any[]} base the trades before these filters
 */
export function moreFiltersHtml(base) {
  if (!moreFiltersTab()) return '';
  const ctx = context(), list = active(), used = new Set(list.map(f => f.field));
  const fields = FILTER_FIELDS.filter(f => !used.has(f.key) && (!f.review || reviewsRead()));
  const block = f => {
    const field = filterField(f.field), choices = filterChoices(base, list, f.field, ctx);
    const is = (v, label) => `<button class="${!!f.not === (v === 'not') ? 'active' : ''}" aria-pressed="${!!f.not === (v === 'not')}" data-action="setJournalFilterNot" data-arg="${f.field}" data-arg2="${v}">${label}</button>`;
    const chip = c => `<button class="journal-chip${c.on ? ' active' : ''}" aria-pressed="${c.on}" data-action="toggleJournalFilterValue" data-arg="${f.field}" data-arg2="${esc(c.value)}">${esc(c.name)} <b>${c.count}</b></button>`;
    return `<div class="jf-filter${f.values.length ? ' active' : ''}">
      <div class="jf-head"><span class="jf-name">${esc(field.label)}</span><div class="seg jf-is" aria-label="${esc(field.label)}: is or is not">${is('is', 'is')}${is('not', 'is not')}</div><button class="jf-x" data-action="removeJournalFilter" data-arg="${f.field}" aria-label="Remove the ${esc(field.label)} filter" title="Remove">×</button></div>
      <div class="jf-vals">${choices.length ? choices.map(chip).join('') : '<span class="jf-none">None in these trades.</span>'}</div>
    </div>`;
  };
  const add = fields.length ? `<select class="jf-add" data-change="addJournalFilter" aria-label="Add a filter"><option value="">+ Add filter</option>${fields.map(f => `<option value="${f.key}">${esc(f.label)}</option>`).join('')}</select>` : '';
  const clear = list.length ? '<button class="pos-link" data-action="clearJournalFilters">Remove all</button>' : '';
  return `<div class="jf" role="group" aria-label="More filters">${list.map(block).join('')}<div class="jf-foot">${add}${clear}</div></div>`;
}

/** + Add filter: the field goes on with nothing picked yet (it narrows nothing until a value is) */
export function addJournalFilter(key) {
  if (!filterField(key) || state.journalFilters.some(f => f.field === key)) return renderJournal();
  state.journalFilters = [...state.journalFilters, { field: key, values: [], not: false }];
  renderJournal();
}
/** a value's chip: on or off */
export function toggleJournalFilterValue(key, value) {
  state.journalFilters = state.journalFilters.map(f => f.field !== key ? f
    : { ...f, values: f.values.includes(value) ? f.values.filter(v => v !== value) : [...f.values, value] });
  renderJournal();
}
/** is or is not */
export function setJournalFilterNot(key, mode) {
  state.journalFilters = state.journalFilters.map(f => f.field === key ? { ...f, not: mode === 'not' } : f);
  renderJournal();
}
export function removeJournalFilter(key) { state.journalFilters = state.journalFilters.filter(f => f.field !== key); renderJournal(); }
export function clearJournalFilters() { state.journalFilters = []; renderJournal(); }
