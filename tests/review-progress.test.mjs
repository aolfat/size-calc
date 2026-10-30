// Run with: node --test
// Review progress, pure (core/review-progress.js): each day's trades and how many still wait, the day the phone card is
// about, the streak of days with nothing left, and the week's dots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { progressDay, reviewDays, reviewStreak, weekDots } from '../src/core/review-progress.js';

/** a trade opened (and closed) on the given days; exits are read the way the stats read them (closedAt, or realized) */
const trade = (open, close, extra = {}) => ({
  openedAt: `${open}T14:00:00Z`, status: close ? 'closed' : 'open',
  closedAt: close ? `${close}T15:00:00Z` : null, exits: close ? 1 : 0, pnl: 0, ...extra,
});

test('a trade counts on the day it opened and every day it had an exit; deleted and before-history ones never', () => {
  const trades = [
    trade('2026-10-26', '2026-10-27', { wait: true }), trade('2026-10-27', '2026-10-27'),
    trade('2026-10-27', null, { deleted: true }), trade('2026-10-27', '2026-10-27', { status: 'history' }),
  ];
  const days = reviewDays(trades, t => !!t.wait);
  assert.deepEqual(Object.fromEntries(days), { '2026-10-26': { total: 1, left: 1 }, '2026-10-27': { total: 2, left: 1 } });
});

test('the card is about today when it had trades, else the latest day before; none before Review from', () => {
  const days = new Map([['2026-10-23', { total: 2, left: 0 }], ['2026-10-27', { total: 1, left: 1 }]]);
  assert.equal(progressDay(days, '2026-10-27'), '2026-10-27');
  assert.equal(progressDay(days, '2026-10-29'), '2026-10-27', 'no trades today: the latest day');
  assert.equal(progressDay(days, '2026-10-24'), '2026-10-23', 'never a day after today');
  assert.equal(progressDay(days, '2026-10-29', '2026-10-28'), '', 'nothing from the Review from day on');
});

test('the streak: days in a row with nothing left, days without trades skipped, the day itself once done', () => {
  const days = new Map([
    ['2026-10-19', { total: 1, left: 1 }], ['2026-10-20', { total: 2, left: 0 }], ['2026-10-22', { total: 1, left: 0 }],
    ['2026-10-23', { total: 3, left: 2 }],
  ]);
  assert.deepEqual(reviewStreak(days, '2026-10-23'), { before: 2, done: false, streak: 2 }, 'Oct 21 had no trades: it neither counts nor breaks it');
  days.set('2026-10-23', { total: 3, left: 0 });
  assert.deepEqual(reviewStreak(days, '2026-10-23'), { before: 2, done: true, streak: 3 });
  assert.deepEqual(reviewStreak(days, '2026-10-23', '2026-10-22'), { before: 1, done: true, streak: 2 }, 'days before Review from don\'t count');
  assert.deepEqual(reviewStreak(days, '2026-10-20'), { before: 0, done: true, streak: 1 }, 'Oct 19 still waits: it breaks the run');
});

test('the week: Monday to Friday of the day, done, still due, no trades, or still to come', () => {
  const days = new Map([['2026-10-26', { total: 2, left: 0 }], ['2026-10-27', { total: 1, left: 1 }], ['2026-10-28', { total: 1, left: 1 }]]);
  assert.deepEqual(weekDots(days, '2026-10-28', '2026-10-28').map(d => `${d.label}:${d.state}`), ['M:done', 'T:due', 'W:due', 'T:future', 'F:future']);
  assert.deepEqual(weekDots(days, '2026-10-28', '2026-11-01').map(d => d.state), ['done', 'due', 'due', 'none', 'none'], 'a weekend: the week behind it');
  assert.equal(weekDots(days, '2026-11-01', '2026-11-01')[0].day, '2026-10-26', 'a Sunday belongs to the week before');
});
