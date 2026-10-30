// @ts-check
// The Journal's More filters, pure (docs/journal.md, More filters): each one a field (the setup grade, the outcome, R, the
// instrument, what the review says...), is or is not, and any of its values; a trade passes when it fits every one. The
// buckets are the Stats tab's own (time of day, hold, weekday), so a filter and a breakdown row agree.
import { HOLD_ORDER, TIME_BUCKETS, WEEKDAYS, holdBucket, instrumentOf, nyParts, timeBucket } from './journal-stats.js';

/** @typedef {import('./journal-stats.js').StatTrade} StatTrade
 * @typedef {{ field: string, values: string[], not?: boolean }} TradeFilter
 * @typedef {{ grade: (t: StatTrade) => string, plan: (t: StatTrade) => string, market: (t: StatTrade) => string,
 *   labels: (t: StatTrade, kind: string) => string[], nameOf: (kind: string, key: string) => string }} FilterContext
 *   what the review says about a trade, and an item's name (the UI's review data)
 * @typedef {{ key: string, label: string, review?: boolean, kind?: string, order?: [string, string][],
 *   of: (t: StatTrade, ctx: FilterContext) => string[] }} FilterField */

/** what a trade with nothing set has, for a review field: 'none' (No mistakes, Not graded) */
export const NONE = 'none';

/** @param {number | null | undefined} r */
const rBucket = r => r === null || r === undefined ? NONE : r < -1 ? 'lt-1' : r < 0 ? '-1-0' : r < 1 ? '0-1' : r < 2 ? '1-2' : 'ge2';
/** @param {StatTrade} t */
const outcomeOf = t => t.status === 'history' ? [] : t.status === 'open' ? ['open'] : [t.pnl > 0 ? 'win' : t.pnl < 0 ? 'loss' : 'even'];
/** a label kind's keys, or 'none' when the trade has none; nothing on a trade from before your history */
const labelField = (/** @type {string} */ kind) => (/** @type {StatTrade} */ t, /** @type {FilterContext} */ ctx) => {
  if (t.status === 'history') return [];
  const keys = ctx.labels(t, kind);
  return keys.length ? keys : [NONE];
};
/** a single review answer, or 'none' */
const answer = (/** @type {(t: StatTrade, ctx: FilterContext) => string} */ get) => (/** @type {StatTrade} */ t, /** @type {FilterContext} */ ctx) => t.status === 'history' ? [] : [get(t, ctx) || NONE];
const same = (/** @type {string[]} */ list) => list.map(v => /** @type {[string, string]} */ ([v, v]));

/** @type {FilterField[]} every field the menu offers, in its order; review ones once the reviews are read */
export const FILTER_FIELDS = [
  { key: 'grade', label: 'Setup grade', review: true, order: [['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D'], ['F', 'F'], [NONE, 'Not graded']], of: answer((t, ctx) => ctx.grade(t)) },
  { key: 'outcome', label: 'Outcome', order: [['win', 'Win'], ['loss', 'Loss'], ['even', 'Breakeven'], ['open', 'Open']], of: outcomeOf },
  { key: 'r', label: 'R', order: [['ge2', '2R and up'], ['1-2', '1 to 2R'], ['0-1', '0 to 1R'], ['-1-0', '−1 to 0R'], ['lt-1', 'Worse than −1R'], [NONE, 'No stop']], of: t => t.status === 'history' ? [] : [rBucket(t.r)] },
  { key: 'instrument', label: 'Instrument', order: same(['Stocks', 'Options', 'Spreads', 'Futures']), of: t => [instrumentOf(t)] },
  { key: 'time', label: 'Time opened', order: same([...TIME_BUCKETS.map(b => b[2]), 'Extended hours']), of: t => t.openedAt ? [timeBucket(nyParts(t.openedAt).time)] : [] },
  { key: 'weekday', label: 'Day opened', order: same(WEEKDAYS), of: t => t.openedAt ? [nyParts(t.openedAt).weekday] : [] },
  { key: 'hold', label: 'Hold', order: same(HOLD_ORDER.filter(h => h !== 'Unknown')), of: t => t.status === 'open' || t.holdMs === null ? [] : [holdBucket(t.holdMs)] },
  { key: 'exits', label: 'Exits', order: [['scaled', 'Scaled out'], ['once', 'All at once']], of: t => t.status === 'open' || t.status === 'history' ? [] : [t.exits > 1 ? 'scaled' : 'once'] },
  { key: 'tactic', label: 'Entry tactic', review: true, kind: 'tactic', of: labelField('tactic') },
  { key: 'mistake', label: 'Mistakes', review: true, kind: 'mistake', of: labelField('mistake') },
  { key: 'plan', label: 'Followed the plan', review: true, order: [['yes', 'Yes'], ['partly', 'Partly'], ['no', 'No'], [NONE, 'Not answered']], of: answer((t, ctx) => ctx.plan(t)) },
  { key: 'market', label: 'Market', review: true, kind: 'market', of: answer((t, ctx) => ctx.market(t)) },
  { key: 'sector', label: 'Sector', review: true, kind: 'sector', of: labelField('sector') },
  { key: 'tag', label: 'Tags', review: true, kind: 'tag', of: labelField('tag') },
];
/** @param {string} key */
export const filterField = key => FILTER_FIELDS.find(f => f.key === key) || null;

/** what each label field's 'none' reads as */
const NONE_WORDS = /** @type {Record<string, string>} */ ({ tactic: 'No tactic', mistake: 'No mistakes', market: 'Not set', sector: 'Not set', tag: 'No tags' });

/**
 * whether a trade fits one filter: any of its values (none picked: every trade), or none of them with is not
 * @param {StatTrade} t @param {TradeFilter} f @param {FilterContext} ctx
 */
export function fitsFilter(t, f, ctx) {
  const field = filterField(f.field);
  if (!field || !f.values.length) return true;
  const hit = field.of(t, ctx).some(v => f.values.includes(v));
  return f.not ? !hit : hit;
}

/** the trades that fit every filter. @param {StatTrade[]} trades @param {TradeFilter[]} filters @param {FilterContext} ctx */
export const applyFilters = (trades, filters, ctx) => filters.some(f => f.values.length) ? trades.filter(t => filters.every(f => fitsFilter(t, f, ctx))) : trades;

/** how many filters narrow the list (one with no values picked doesn't). @param {TradeFilter[]} filters */
export const filtersOn = filters => filters.filter(f => f.values.length && filterField(f.field)).length;

/**
 * A field's choices with how many trades each would let through, given the other filters (not this one, so the counts say
 * what picking it does): the field's own order, or a label kind's values most used first and 'none' last. Only the ones
 * some trade has, and the ones picked. [{ value, name, count, on }]
 * @param {StatTrade[]} trades @param {TradeFilter[]} filters @param {string} key @param {FilterContext} ctx
 */
export function filterChoices(trades, filters, key, ctx) {
  const field = filterField(key);
  if (!field) return [];
  const mine = filters.find(f => f.field === key), picked = mine?.values || [];
  const rest = applyFilters(trades, filters.filter(f => f.field !== key), ctx);
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const t of rest) for (const v of new Set(field.of(t, ctx))) counts.set(v, (counts.get(v) || 0) + 1);
  /** @type {[string, string][]} */
  const order = field.order || [...counts.keys(), ...picked.filter(v => !counts.has(v))].filter(v => v !== NONE)
    .sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || ctx.nameOf(/** @type {string} */ (field.kind), a).localeCompare(ctx.nameOf(/** @type {string} */ (field.kind), b)))
    .map(v => /** @type {[string, string]} */ ([v, ctx.nameOf(/** @type {string} */ (field.kind), v)]))
    .concat(counts.has(NONE) || picked.includes(NONE) ? [[NONE, NONE_WORDS[key] || 'None']] : []);
  return order.filter(([v]) => counts.has(v) || picked.includes(v)).map(([value, name]) => ({ value, name, count: counts.get(value) || 0, on: picked.includes(value) }));
}

