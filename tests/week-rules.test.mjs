// Run with: node --test
// This week's rules in Size: the rules last week's review set, a card under the risk strip while you're signed in, in
// Stocks & futures and Options; Settings turns it off on this device.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const RULES = [{ id: 'w1', text: 'No trades before 9:45' }, { id: 'w2', text: 'Size down <after> a loss' }];
const shown = el => el.style.display !== 'none';

async function size({ periods = [{ unit: 'week', period_key: '2026-09-28', rules_next: RULES }], session = SESSION, now = Date.parse('2026-10-06T15:00:00Z'), storage } = {}) {
  const supabase = fakeRecords([]);
  for (const r of periods) supabase.tables.period_reviews.set(`user-1:${r.unit}:${r.period_key}`, { user_id: 'user-1', ...r });
  const a = await app({ supabase, session, clock: true, now, storage });
  // what main.js does at boot, once the Google session is back
  a.run('paintWeekRulesSetting()');
  await a.run('loadWeekRules()');
  await settle();
  return { ...a, supabase, card: () => a.elements.get('weekRulesCard'), list: () => a.elements.get('weekRulesList').innerHTML };
}

test("signed in, Size shows this week's rules under the risk strip; other views hide them", async () => {
  const a = await size();
  assert.ok(a.state.periodReviews, 'read at boot');
  assert.equal(a.run('loadWeekRules()'), undefined, 'not again right away');
  assert.ok(shown(a.card()));
  assert.equal(a.list(), '<li>No trades before 9:45</li><li>Size down &lt;after&gt; a loss</li>');
  a.run("setMode('options')");
  assert.ok(shown(a.card()), 'Options too');
  a.run("setView('positions')");
  assert.ok(!shown(a.card()));
  a.run("setView('journal')");
  assert.ok(!shown(a.card()));
  a.run("setView('size')");
  assert.ok(shown(a.card()));
});

test("Settings hides the card on this device, and shows it again", async () => {
  const a = await size();
  assert.equal(a.elements.get('weekRulesOn').getAttribute('aria-pressed'), 'true');
  a.run("setWeekRulesShown('off')");
  assert.ok(!shown(a.card()));
  assert.equal(a.run("store.get('week_rules_calc')"), '0');
  assert.equal(a.elements.get('weekRulesOff').getAttribute('aria-pressed'), 'true');
  a.run("setWeekRulesShown('on')");
  assert.ok(shown(a.card()));
});

test('a weekend shows the coming week\'s rules; a week without rules, or signed out, shows no card', async () => {
  const sat = await size({ periods: [{ unit: 'week', period_key: '2026-10-05', rules_next: [{ id: 'n', text: 'Next week' }] }], now: Date.parse('2026-10-10T15:00:00Z') });
  assert.equal(sat.list(), '<li>Next week</li>', 'Saturday: the rules the week just over set');
  const none = await size({ periods: [] });
  assert.ok(!shown(none.card()));
  const out = await size({ session: null });
  assert.ok(!shown(out.card()));
  assert.equal(out.state.periodReviews, null, 'nothing read signed out');
});

test("setting next week's rules in the week's review updates the card at once", async () => {
  const a = await size({ periods: [], now: Date.parse('2026-10-10T15:00:00Z') });
  assert.ok(!shown(a.card()));
  a.run("setView('journal')");
  await a.run('loadJournal()');
  await settle();
  a.run("setJournalTab('calendar')");
  a.run("openPeriodReview('week', '2026-10-05')");
  a.run("periodRuleDraftInput('Wait for the pivot'); addPeriodRule()");
  await settle();
  a.run("setView('size')");
  assert.ok(shown(a.card()));
  assert.equal(a.list(), '<li>Wait for the pivot</li>');
});
