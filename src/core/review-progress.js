// @ts-check
// Review progress, pure (docs/journal.md, the phone Trades tab's progress card): each New York day's trades and how many
// still wait for a pass, the day the card is about (today, else the latest day with trades), the streak of days with
// nothing left, and the week's dots (Mon to Fri).
import { exitDays, nyParts } from './journal-stats.js';

/**
 * Each day's trades: a trade belongs to the day it opened and to every day it had an exit; `left` counts the ones still
 * needing a pass. Deleted and before-history trades never count.
 * @template {import('./journal-stats.js').StatTrade} T
 * @param {T[]} trades @param {(t: T) => boolean} waiting
 * @returns {Map<string, { total: number, left: number }>}
 */
export function reviewDays(trades, waiting) {
  /** @type {Map<string, { total: number, left: number }>} */
  const days = new Map();
  for (const t of trades) {
    if (t.deleted || t.status === 'history' || !t.openedAt) continue;
    const left = waiting(t);
    for (const day of new Set([nyParts(t.openedAt).day, ...exitDays(t)])) {
      const d = days.get(day) || { total: 0, left: 0 };
      d.total++;
      if (left) d.left++;
      days.set(day, d);
    }
  }
  return days;
}

/**
 * The day the card is about: today when it had trades, else the latest day before it that did; none before `from`
 * @param {Map<string, unknown>} days @param {string} today @param {string} [from]
 */
export function progressDay(days, today, from = '') {
  return [...days.keys()].filter(d => d <= today && d >= from).sort().pop() || '';
}

/**
 * Days in a row with nothing left, back from the day before `day` (days without trades neither count nor break it; none
 * before `from`), and whether `day` itself is done: done, the streak includes it
 * @param {Map<string, { total: number, left: number }>} days @param {string} day @param {string} [from]
 */
export function reviewStreak(days, day, from = '') {
  let before = 0;
  for (const d of [...days.keys()].filter(d => d < day && d >= from).sort().reverse()) {
    if (days.get(d)?.left) break;
    before++;
  }
  const done = !!days.get(day) && !days.get(day)?.left;
  return { before, done, streak: before + (done ? 1 : 0) };
}

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F'];
/** 'YYYY-MM-DD' moved by n days. @param {string} day @param {number} n */
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/**
 * Monday to Friday of `day`'s week: 'done' (trades, none left), 'due' (trades still waiting, up to today), 'future' (after
 * today), or 'none' (no trades)
 * @param {Map<string, { total: number, left: number }>} days @param {string} day @param {string} today
 * @returns {{ day: string, label: string, state: 'done' | 'due' | 'future' | 'none' }[]}
 */
export function weekDots(days, day, today) {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 Sunday
  const monday = addDays(day, dow === 0 ? -6 : 1 - dow);
  return WEEKDAYS.map((label, i) => {
    const d = addDays(monday, i), on = days.get(d);
    return { day: d, label, state: d > today ? 'future' : on?.total ? (on.left ? 'due' : 'done') : 'none' };
  });
}
