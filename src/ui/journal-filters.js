// The Journal's More filters (docs/journal.md, More filters; core/journal-filters.js): + Add filter puts a field under the
// filters (the setup grade, the outcome, R, the ticker type, the instrument, time and day opened, hold, exits, and what the
// review says), is or is not, its values as chips with how many trades each lets through, × takes it off. Trades, Calendar and Stats.
// Every trade feature is in the menu too, by family, once the stamps are read: a condition on its value (at least, at most
// or between, in its own unit), with how many trades fit and how many have no value (docs/journal-features.md, part 3).
import { CONDITION_OPS, conditionCounts, conditionSet, FEATURE_FIELD, FILTER_FIELDS, applyFilters, filterChoices, filterField, filtersOn, isCondition } from '../core/journal-filters.js';
import { FEATURE_FAMILIES, FEATURES, featureVersion } from '../core/features/index.js';
import { marketEscape as esc } from '../core/format.js';
import { state } from '../state.js';
import { myFunds, reviewLibrary, setupGradeOf, shownSide, tradeReviewState } from './journal-review.js';
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
    funds: myFunds(),
    featureValue: (t, f) => { const s = state.featureStamps?.[t.key]?.[f.key]; return s && s.v === featureVersion(f) && s.value !== undefined ? s.value : null; },
  };
}

/** the stamps are read, so a feature's condition can be judged (before then, every trade would read as without a value) */
const featuresReady = () => !!state.featureStamps && !state.featuresError;
/** a unit after a condition's number */
const UNIT_WORDS = { atr: 'ATR', adr: 'ADR', '%': '%', x: '×', $: '$' };
const OP_WORDS = { atleast: 'at least', atmost: 'at most', between: 'between' };

/** the filters in force: a review field only once the reviews are read (else every trade would read as not graded) */
const active = () => state.journalFilters.filter(f => { const field = filterField(f.field); return !!field && (!field.review || reviewsRead()) && (!field.feature || featuresReady()); });
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
  const groups = featuresReady() ? FEATURE_FAMILIES.map(fam => {
    const list = FEATURES.filter(f => f.family.key === fam.key && !used.has(FEATURE_FIELD + f.key));
    return list.length ? `<optgroup label="Features: ${esc(fam.name)}">${list.map(f => `<option value="${FEATURE_FIELD}${f.key}">${esc(f.name)}</option>`).join('')}</optgroup>` : '';
  }).join('') : '';
  const add = fields.length || groups ? `<select class="jf-add" data-change="addJournalFilter" aria-label="Add a filter"><option value="">+ Add filter</option>${fields.map(f => `<option value="${f.key}">${esc(f.label)}</option>`).join('')}${groups}</select>` : '';
  const clear = list.length ? '<button class="pos-link" data-action="clearJournalFilters">Remove all</button>' : '';
  /** a feature's condition: at least / at most / between, its number boxes in the feature's unit, and what it lets through */
  const condition = f => {
    const field = filterField(f.field), unit = UNIT_WORDS[field.feature.unit] || '', op = f.op || 'atleast';
    const c = conditionCounts(base, list, f.field, ctx), set = conditionSet(f);
    const opBtn = v => `<button class="${op === v ? 'active' : ''}" aria-pressed="${op === v}" data-action="setJournalFilterOp" data-arg="${f.field}" data-arg2="${v}">${OP_WORDS[v]}</button>`;
    const box = (end, value) => `<input class="jf-num" type="number" step="any" value="${Number.isFinite(value) ? value : ''}" data-change="setJournalFilterBound" data-arg="${f.field}" data-arg2="${end}" aria-label="${esc(field.label)}: ${end === 'min' ? (op === 'between' ? 'from' : 'at least') : (op === 'between' ? 'to' : 'at most')}" />`;
    const boxes = op === 'between' ? `${box('min', f.min)}<span class="jf-and">and</span>${box('max', f.max)}` : box(op === 'atmost' ? 'max' : 'min', op === 'atmost' ? f.max : f.min);
    const count = set ? `${c.fit} of ${c.total} trade${c.total === 1 ? '' : 's'} fit${c.noValue ? ` · ${c.noValue} without a value left out` : ''}` : `${c.total - c.noValue} of ${c.total} trade${c.total === 1 ? '' : 's'} have a value`;
    return `<div class="jf-filter jf-condition${set ? ' active' : ''}">
      <div class="jf-head"><span class="jf-name">${esc(field.label)}</span><div class="seg jf-is" aria-label="${esc(field.label)}: the condition">${CONDITION_OPS.map(opBtn).join('')}</div><button class="jf-x" data-action="removeJournalFilter" data-arg="${f.field}" aria-label="Remove the ${esc(field.label)} filter" title="Remove">×</button></div>
      <div class="jf-vals jf-cond">${boxes}${unit ? `<span class="jf-unit">${esc(unit)}</span>` : ''}<span class="jf-count">${count}</span></div>
    </div>`;
  };
  return `<div class="jf" role="group" aria-label="More filters">${list.map(f => isCondition(filterField(f.field)) ? condition(f) : block(f)).join('')}<div class="jf-foot">${add}${clear}</div></div>`;
}

/** + Add filter: the field goes on with nothing picked yet (it narrows nothing until a value is) */
export function addJournalFilter(key) {
  if (!filterField(key) || state.journalFilters.some(f => f.field === key)) return renderJournal();
  state.journalFilters = [...state.journalFilters, isCondition(filterField(key)) ? { field: key, values: [], op: 'atleast', min: null, max: null } : { field: key, values: [], not: false }];
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
/** a feature's condition: at least, at most or between (the numbers typed stay, so switching back keeps them) */
export function setJournalFilterOp(key, op) {
  if (!CONDITION_OPS.includes(op)) return;
  state.journalFilters = state.journalFilters.map(f => f.field === key ? { ...f, op } : f);
  renderJournal();
}
/** a condition's number: min or max; empty (or not a number) clears it */
export function setJournalFilterBound(key, end, text) {
  if (end !== 'min' && end !== 'max') return;
  const n = String(text).trim() === '' ? null : Number(text);
  state.journalFilters = state.journalFilters.map(f => f.field === key ? { ...f, [end]: Number.isFinite(n) ? n : null } : f);
  renderJournal();
}
export function removeJournalFilter(key) { state.journalFilters = state.journalFilters.filter(f => f.field !== key); renderJournal(); }
export function clearJournalFilters() { state.journalFilters = []; renderJournal(); }
