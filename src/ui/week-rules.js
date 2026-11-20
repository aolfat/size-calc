// Your rules and goals in Size (docs/calculator.md, docs/journal.md): the rules last week's review set, your standing
// rules and your goals (the notebook's lists), a small card under the risk strip (#weekRulesCard) in Stocks & futures and
// Options while you're signed in and any of them exist; Settings turns it off (week_rules_calc, this device only). Also
// reads the week and month reviews (period_reviews) into state.periodReviews and the review data (your goals and rules
// among it) into state.journalReview, at boot and when the app comes back to the front, so the card is fresh.
import { marketEscape as esc } from '../core/format.js';
import { activeItems, notebookLists, notebookToday } from '../core/journal-notebook.js';
import { weekRulesFor } from '../core/journal-week.js';
import { store } from '../lib/store.js';
import { loadPeriodReviews } from '../services/journal-review.js';
import { state } from '../state.js';
import { loadJournalReview } from './journal-review.js';

/** past this many rules the card shows the first RULES_SHOWN and a button for the rest: three rows of three on desktop */
export const RULES_MAX = 9;
export const RULES_SHOWN = 8;
/** a rule longer than this many characters spans two of the band's columns */
const LONG_RULE = 60;

/** coming back to the app reads the reviews again at most this often */
const REFRESH_MS = 5 * 60000;

/** read every period's grades, notes and rules; a failure (the table not pushed yet) keeps the numbers working and says why */
export async function loadPeriodReviewRows() {
  try {
    const { rows, overallError, rulesError } = await loadPeriodReviews();
    state.periodReviews = Object.fromEntries(rows.map(r => [`${r.unit}|${r.period_key}`, r]));
    state.periodReviewsError = '';
    state.periodOverallError = overallError;
    state.periodRulesError = rulesError || '';
  } catch(e) {
    state.periodReviewsError = String(e?.message || e);
  }
  state.weekRulesAt = Date.now();
  renderWeekRulesCard();
}

/**
 * At boot and on coming back to the app: the reviews and your goals and rules, if you're signed in and they weren't just
 * read. The Journal reads its own review data when it opens, so an open Journal isn't read under your hands.
 */
export function loadWeekRules() {
  if (!state.session || Date.now() - state.weekRulesAt < REFRESH_MS) return;
  state.weekRulesAt = Date.now();
  return Promise.all([loadPeriodReviewRows(), state.journalView ? null : loadJournalReview()]).then(renderWeekRulesCard);
}

/** the card is on in Settings (the default) */
export const weekRulesShown = () => store.get('week_rules_calc') !== '0';

/** Settings' switch: 'on' shows this week's rules in Size, 'off' hides them (this device only). @param {string} v */
export function setWeekRulesShown(v) {
  store.set('week_rules_calc', v === 'off' ? '0' : '1');
  paintWeekRulesSetting();
  renderWeekRulesCard();
}

export function paintWeekRulesSetting() {
  const on = weekRulesShown();
  for (const [id, lit] of [['weekRulesOn', on], ['weekRulesOff', !on]]) {
    const b = document.getElementById(id);
    b.classList.toggle('active', lit);
    b.setAttribute('aria-pressed', String(lit));
  }
}

/** the rules this week holds you to (a weekend shows the coming week's), or none */
export function currentWeekRules() {
  if (!state.session || !state.periodReviews || state.periodReviewsError) return [];
  return weekRulesFor(state.periodReviews, notebookToday(new Date(Date.now()).toISOString())).rules;
}

/** your standing rules and goals (the notebook's lists, not retired), or none until they've been read */
export function standingLists() {
  if (!state.session || !state.journalReview || state.journalReviewError) return { rules: [], goals: [] };
  const { rules, goals } = notebookLists(state.journalReview.library || []);
  return { rules: activeItems(rules), goals: activeItems(goals) };
}

/** the show-all button: every rule, or back to the first few */
export function toggleRulesMore() {
  state.rulesMoreOpen = !state.rulesMoreOpen;
  renderWeekRulesCard();
}

/** the card: shown in the calculator when it's on and there are rules or goals; each list shows only when it has some */
export function renderWeekRulesCard() {
  const card = document.getElementById('weekRulesCard');
  const calc = !state.positionsView && !state.utilsView && !state.marketView && !state.journalView;
  const on = calc && weekRulesShown();
  const week = on ? currentWeekRules() : [];
  const same = new Set(week.map(r => r.text.trim().toLowerCase()));
  const lists = on ? standingLists() : { rules: [], goals: [] };
  /** a standing rule this week's list already holds shows once, there */
  const rules = lists.rules.filter(r => !same.has(r.name.trim().toLowerCase()));
  // a long list stays three rows tall: the first few rules (this week's first), then a button for the rest
  const total = week.length + rules.length;
  const cut = total > RULES_MAX && !state.rulesMoreOpen;
  const weekShown = cut ? week.slice(0, RULES_SHOWN) : week;
  const rulesShown = cut ? rules.slice(0, Math.max(0, RULES_SHOWN - week.length)) : rules;
  const groups = [['weekRules', weekShown.map(r => r.text)], ['myRules', rulesShown.map(r => r.name)], ['myGoals', lists.goals.map(g => g.name)]];
  for (const [id, items] of groups) {
    document.getElementById(`${id}Group`).style.display = items.length ? '' : 'none';
    // a long rule takes two cells of the desktop band, so it reads whole instead of a tall narrow column
    document.getElementById(`${id}List`).innerHTML = items.map(t => `<li${t.length > LONG_RULE ? ' class="long"' : ''}>${esc(t)}</li>`).join('');
  }
  const more = document.getElementById('rulesMoreBtn');
  more.style.display = total > RULES_MAX ? '' : 'none';
  more.textContent = state.rulesMoreOpen ? 'Show fewer' : `+${total - RULES_SHOWN} more rules · show all`;
  more.setAttribute('aria-expanded', String(state.rulesMoreOpen));
  card.classList.toggle('has-rules', total > 0);
  card.classList.toggle('has-goals', lists.goals.length > 0);
  card.style.display = groups.some(([, items]) => items.length) ? '' : 'none';
}
