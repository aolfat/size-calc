// This week's rules in Size (docs/calculator.md, docs/journal.md): the rules last week's review set, a small card under
// the risk strip (#weekRulesCard) in Stocks & futures and Options while you're signed in and the week has rules; Settings
// turns it off (week_rules_calc, this device only). Also reads the week and month reviews (period_reviews) into
// state.periodReviews for the Journal, at boot and when the app comes back to the front, so the card is fresh.
import { marketEscape as esc } from '../core/format.js';
import { notebookToday } from '../core/journal-notebook.js';
import { weekRulesFor } from '../core/journal-week.js';
import { store } from '../lib/store.js';
import { loadPeriodReviews } from '../services/journal-review.js';
import { state } from '../state.js';

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

/** at boot and on coming back to the app: the reviews, if you're signed in and they weren't just read */
export function loadWeekRules() {
  if (!state.session || Date.now() - state.weekRulesAt < REFRESH_MS) return;
  return loadPeriodReviewRows();
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

/** the card: shown in the calculator when it's on and the week has rules */
export function renderWeekRulesCard() {
  const card = document.getElementById('weekRulesCard');
  const calc = !state.positionsView && !state.utilsView && !state.marketView && !state.journalView;
  const rules = calc && weekRulesShown() ? currentWeekRules() : [];
  card.style.display = rules.length ? '' : 'none';
  document.getElementById('weekRulesList').innerHTML = rules.map(r => `<li>${esc(r.text)}</li>`).join('');
}
