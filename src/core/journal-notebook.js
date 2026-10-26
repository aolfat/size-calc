// @ts-check
// Journal notebook, pure (docs/journal-notebook.md): a page per New York trading day. The premarket plan (a mental
// check-in, the market, the plan) and the post-market review (a grade, each rule kept or broken, two guided notes,
// tomorrow's focus) and the trades you missed kept on the day's journal_days row; your goals and rules as standing lists (library_items rows of
// kind goal and rule); when a day's plan is written and when it's reviewed; the trades a day touched; stepping weekdays.
import { GRADES } from './journal-labels.js';
import { exitDays, nyParts } from './journal-stats.js';

/** @typedef {{ key: string, id: string, kind: 'goal' | 'rule', name: string, hidden: boolean, order: number, since: string }} ListItem
 * @typedef {{ id: string, symbol: string, side: string | null, setup: string | null, tactic: string | null, why: string | null, note: string | null }} MissedTrade
 * @typedef {{ market: string | null, note: string | null, feelings: string[], energy: string | null, sleep_hours: number | null,
 *   place: string | null, plan: string | null, focus_list: any[], grade: string | null, rules: Record<string, string>,
 *   went_well: string | null, work_on: string | null, focus_next: string | null, focus_kept: string | null,
 *   planned_at: string | null, reviewed_at: string | null, missed: MissedTrade[] }} DayRow */

export const FEELINGS = /** @type {[string, string][]} */ ([['calm', 'Calm'], ['focused', 'Focused'], ['confident', 'Confident'], ['anxious', 'Anxious'], ['frustrated', 'Frustrated'], ['impatient', 'Impatient'], ['fomo', 'FOMO']]);
export const ENERGY = /** @type {[string, string][]} */ ([['rested', 'Rested'], ['ok', 'OK'], ['tired', 'Tired']]);
export const PLACES = /** @type {[string, string][]} */ ([['desk', 'At my desk'], ['phone', 'On my phone']]);
export const FOCUS_KEPT = /** @type {[string, string][]} */ ([['yes', 'Yes'], ['partly', 'Partly'], ['no', 'No']]);
export const RULE_ANSWERS = /** @type {[string, string][]} */ ([['kept', 'Kept'], ['broke', 'Broke']]);
/** the day grade: the trade's setup grade scale */
export const DAY_GRADES = GRADES;
export const MAX_DAY_NOTE = 5000;
export const MAX_FOCUS = 500;
/** a goal's or rule's longest text, and the most of each */
export const MAX_ITEM = 200;
export const MAX_ITEMS = 20;
/** the day's text boxes and their longest text */
export const DAY_TEXT = /** @type {Record<string, number>} */ ({ plan: MAX_DAY_NOTE, went_well: MAX_DAY_NOTE, work_on: MAX_DAY_NOTE, note: MAX_DAY_NOTE, focus_next: MAX_FOCUS });
/** the columns the notebook's migration adds (read on their own query, so a database without them keeps the rest working) */
export const DAY_COLUMNS = ['feelings', 'energy', 'sleep_hours', 'place', 'plan', 'focus_list', 'grade', 'rules', 'went_well', 'work_on', 'focus_next', 'focus_kept', 'planned_at', 'reviewed_at'];
/** how far back the last focus is looked for */
export const FOCUS_LOOKBACK_DAYS = 7;
/** the day's missed trades: the column their own migration adds (read on its own query too) */
export const MISSED_COLUMNS = ['missed'];
/** why a trade was missed */
export const MISSED_WHY = /** @type {[string, string][]} */ ([['hesitated', 'Hesitated'], ['not_seen', "Didn't see it"], ['away', 'Away'], ['late', 'Too late'], ['no_trust', "Didn't trust it"], ['at_limit', 'At my limit']]);
export const MISSED_SIDES = /** @type {[string, string][]} */ ([['long', 'Long'], ['short', 'Short']]);
/** the most missed trades a day keeps, and a note's longest text */
export const MAX_MISSED = 20;
export const MAX_MISSED_NOTE = 500;
const MISSED_SYMBOL_RE = /^[A-Z0-9][A-Z0-9./-]{0,11}$/;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** a real calendar day 'YYYY-MM-DD'. @param {unknown} s */
export const isDay = s => typeof s === 'string' && DAY_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const ms = (/** @type {string} */ day) => Date.parse(`${day}T00:00:00Z`);
const iso = (/** @type {number} */ t) => new Date(t).toISOString().slice(0, 10);
const weekday = (/** @type {string} */ day) => new Date(ms(day)).getUTCDay();
const pick = (/** @type {[string, string][]} */ list, /** @type {unknown} */ v) => list.some(([k]) => k === v) ? /** @type {string} */ (v) : null;
const text = (/** @type {unknown} */ v, /** @type {number} */ max) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

/** the weekday `by` weekdays before or after a day (weekends skipped). @param {string} day @param {number} by */
export function stepWeekday(day, by) {
  let t = ms(day), left = Math.abs(by);
  const step = by < 0 ? -864e5 : 864e5;
  while (left > 0) { t += step; const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) left--; }
  return iso(t);
}

/** the day today's line opens: today in New York, or the Monday after a weekend. @param {string} nowIso */
export function notebookToday(nowIso) {
  const { day } = nyParts(nowIso), w = weekday(day);
  return w === 6 ? iso(ms(day) + 2 * 864e5) : w === 0 ? iso(ms(day) + 864e5) : day;
}

/** the day's session is over: past its 4pm close in New York. @param {string} day @param {string} nowIso */
export function dayOver(day, nowIso) {
  const now = nyParts(nowIso);
  return now.day > day || (now.day === day && now.time >= '16:00');
}

/**
 * A journal_days row as the app keeps it: known columns only, choices from their lists, text trimmed to its limit,
 * rule answers only kept or broke. Missing columns (the migration not pushed) read as empty.
 * @param {Record<string, any> | null | undefined} raw @returns {DayRow}
 */
export function cleanDayRow(raw) {
  const r = raw || {};
  /** @type {Record<string, string>} */
  const rules = {};
  if (r.rules && typeof r.rules === 'object' && !Array.isArray(r.rules)) for (const [k, v] of Object.entries(r.rules)) if (pick(RULE_ANSWERS, v)) rules[k] = v;
  const hours = r.sleep_hours === null || r.sleep_hours === undefined || r.sleep_hours === '' ? NaN : Number(r.sleep_hours);
  return {
    market: typeof r.market === 'string' && r.market ? r.market : null,
    note: text(r.note, MAX_DAY_NOTE),
    feelings: Array.isArray(r.feelings) ? [...new Set(r.feelings.filter(f => pick(FEELINGS, f)))] : [],
    energy: pick(ENERGY, r.energy), sleep_hours: Number.isFinite(hours) && hours >= 0 && hours <= 24 ? hours : null, place: pick(PLACES, r.place),
    plan: text(r.plan, MAX_DAY_NOTE), focus_list: Array.isArray(r.focus_list) ? r.focus_list : [],
    grade: GRADES.includes(r.grade) ? r.grade : null, rules,
    went_well: text(r.went_well, MAX_DAY_NOTE), work_on: text(r.work_on, MAX_DAY_NOTE),
    focus_next: text(r.focus_next, MAX_FOCUS), focus_kept: pick(FOCUS_KEPT, r.focus_kept),
    planned_at: r.planned_at || null, reviewed_at: r.reviewed_at || null,
    missed: cleanMissed(r.missed),
  };
}

/** a missed trade's ticker, upper case; null unless it looks like one. @param {unknown} v */
export const missedSymbol = v => {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return MISSED_SYMBOL_RE.test(s) ? s : null;
};

const libKey = (/** @type {unknown} */ v) => typeof v === 'string' && v && v.length <= 100 ? v : null;

/**
 * A day's missed trades as the app keeps them: each with an id and a ticker, the side and why from their lists, a daily
 * setup and an entry tactic (library keys) and a trimmed note; duplicates by id and anything past MAX_MISSED dropped.
 * @param {unknown} raw @returns {MissedTrade[]}
 */
export function cleanMissed(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {MissedTrade[]} */
  const out = [];
  for (const m of raw) {
    const id = typeof m?.id === 'string' && m.id && m.id.length <= 64 ? m.id : '', symbol = missedSymbol(m?.symbol);
    if (!id || !symbol || out.some(x => x.id === id)) continue;
    out.push({ id, symbol, side: pick(MISSED_SIDES, m.side), setup: libKey(m.setup), tactic: libKey(m.tactic), why: pick(MISSED_WHY, m.why), note: text(m.note, MAX_MISSED_NOTE) });
    if (out.length >= MAX_MISSED) break;
  }
  return out;
}

/**
 * Your goals and rules from the library rows (kinds goal and rule), each list in your order (then oldest first);
 * retired ones (hidden) are kept, for the days that answered them.
 * @param {{ id: string, kind: string, name: string, hidden?: boolean, settings?: any }[]} rows
 * @returns {{ goals: ListItem[], rules: ListItem[] }}
 */
export function notebookLists(rows = []) {
  /** @param {'goal' | 'rule'} kind @returns {ListItem[]} */
  const list = kind => rows.filter(r => r.kind === kind && r.name).map(r => ({
    key: `mine:${r.id}`, id: r.id, kind, name: r.name, hidden: !!r.hidden,
    order: Number.isFinite(Number(r.settings?.order)) ? Number(r.settings.order) : 0,
    since: isDay(r.settings?.since) ? r.settings.since : '',
  })).sort((a, b) => a.order - b.order || a.since.localeCompare(b.since) || a.name.localeCompare(b.name));
  return { goals: list('goal'), rules: list('rule') };
}

/** the goals or rules you have now: not retired. @param {ListItem[]} items */
export const activeItems = items => items.filter(i => !i.hidden);

/**
 * The rules a day asks about: the ones you had then (made on or before it) and haven't retired, plus any answered that
 * day (retired since or not), in your order.
 * @param {ListItem[]} rules @param {string} day @param {DayRow | null | undefined} row
 */
export const rulesForDay = (rules, day, row) => rules.filter(r => row?.rules?.[r.key] || (!r.hidden && (!r.since || r.since <= day)));

/** what a plan has; written once it has a feeling, energy, where you're trading, the market and the plan. @param {DayRow | null | undefined} row */
export function planState(row) {
  const st = { feeling: !!row?.feelings?.length, energy: !!row?.energy, place: !!row?.place, market: !!row?.market, plan: !!row?.plan };
  return { ...st, written: Object.values(st).every(Boolean) };
}

/** what a plan still needs, in words: 'how you feel, the market and the plan'. @param {ReturnType<typeof planState>} st */
export const planMissingWords = st => listWords([[st.feeling, 'how you feel'], [st.energy, 'sleep and energy'], [st.place, "where you're trading"], [st.market, 'the market'], [st.plan, 'the plan']]);

/**
 * What a day's review has; reviewed once it has a grade, every rule that applies answered, and what went well or
 * what to work on. More notes, the last focus and tomorrow's focus never count.
 * @param {DayRow | null | undefined} row @param {ListItem[]} applying the rules that apply (rulesForDay)
 */
export function dayReviewState(row, applying) {
  const unanswered = applying.filter(r => !row?.rules?.[r.key]).length;
  const st = { grade: !!row?.grade, rules: !unanswered, unanswered, note: !!(row?.went_well || row?.work_on) };
  return { ...st, reviewed: st.grade && st.rules && st.note };
}

/** what a review still needs, in words. @param {ReturnType<typeof dayReviewState>} st */
export const reviewMissingWords = st => listWords([[st.grade, 'a grade'], [st.rules, st.unanswered === 1 ? '1 rule' : `${st.unanswered} rules`], [st.note, 'what went well or what to work on']]);

/** @param {[boolean, string][]} parts */
function listWords(parts) {
  const missing = parts.filter(([ok]) => !ok).map(([, w]) => w);
  return missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}` : missing[0] || '';
}

/**
 * The focus you wrote last, for a day: the nearest earlier day with one, up to a week back; null without one.
 * @param {Record<string, DayRow>} days @param {string} day
 */
export function lastFocus(days, day) {
  for (let t = ms(day) - 864e5; t >= ms(day) - FOCUS_LOOKBACK_DAYS * 864e5; t -= 864e5) {
    const d = iso(t), text = days[d]?.focus_next;
    if (text) return { day: d, text };
  }
  return null;
}

/**
 * The trades a day touched: opened that day or took P&L on it (deleted ones and trades from before the history aside),
 * oldest first by open.
 * @template {{ openedAt: string, deleted?: boolean, status: string }} T
 * @param {T[]} trades @param {string} day
 */
export const dayTrades = (trades, day) => trades
  .filter(t => !t.deleted && t.status !== 'history' && ((t.openedAt && nyParts(t.openedAt).day === day) || exitDays(/** @type {any} */ (t)).has(day)))
  .sort((a, b) => (a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : 0));
