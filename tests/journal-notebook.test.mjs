// Run with: node --test
// The journal notebook (docs/journal-notebook.md, slice 1): a page per trading day, opened from the calendar or today's
// line. Premarket (the last focus, a mental check-in, goals, rules, the market, the plan), the day's trades, and
// post-market (a grade, each rule kept or broken, the last focus kept, the notes, tomorrow's focus); goals and rules as
// standing lists; the calendar's marks; saving field by field; and the database before the migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const json = (run, code) => JSON.parse(run(`JSON.stringify(${code})`));
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

// ---------- the rules, pure ----------

test('weekdays step over weekends; today\'s page is Monday\'s on a weekend; a day is over at its 4pm close', async () => {
  const { run } = await app();
  assert.equal(run("stepWeekday('2026-10-09', 1)"), '2026-10-12', 'Friday → Monday');
  assert.equal(run("stepWeekday('2026-10-12', -1)"), '2026-10-09');
  assert.equal(run("stepWeekday('2026-10-06', 3)"), '2026-10-09');
  assert.equal(run("notebookToday('2026-10-10T15:00:00Z')"), '2026-10-12', 'Saturday');
  assert.equal(run("notebookToday('2026-10-11T15:00:00Z')"), '2026-10-12', 'Sunday');
  assert.equal(run("notebookToday('2026-10-07T03:00:00Z')"), '2026-10-06', '11pm Tuesday in New York is still Tuesday');
  assert.equal(run("dayOver('2026-10-06', '2026-10-06T19:59:00Z')"), false, '3:59pm');
  assert.equal(run("dayOver('2026-10-06', '2026-10-06T20:00:00Z')"), true, '4pm');
  assert.equal(run("dayOver('2026-10-06', '2026-10-07T13:00:00Z')"), true);
  assert.equal(run("isDay('2026-02-30')"), false);
});

test('a day row is cleaned on the way in: choices from their lists, rule answers kept or broke, text trimmed', async () => {
  const { run } = await app();
  const r = json(run, `cleanDayRow({ market: 'choppy', feelings: ['calm', 'calm', 'sleepy', 'fomo'], energy: 'meh', place: 'desk', sleep_hours: '6.5',
    plan: '  wait for 9:45  ', grade: 'A++', rules: { 'mine:a': 'kept', 'mine:b': 'maybe' }, focus_kept: 'partly', went_well: ' ', extra: 1 })`);
  assert.deepEqual([r.market, r.feelings, r.energy, r.place, r.sleep_hours, r.plan, r.grade, r.rules, r.focus_kept, r.went_well, r.extra],
    ['choppy', ['calm', 'fomo'], null, 'desk', 6.5, 'wait for 9:45', null, { 'mine:a': 'kept' }, 'partly', null, undefined]);
  assert.deepEqual(json(run, 'cleanDayRow(null).feelings'), []);
  assert.equal(run('cleanDayRow({ sleep_hours: 30 }).sleep_hours'), null);
});

test('goals and rules: in your order, retired ones kept; a day asks about the rules you had then, and any it answered', async () => {
  const { run } = await app();
  const rows = `[
    { id: 'b', kind: 'rule', name: 'Follow your stop', settings: { order: 2, since: '2026-10-01' } },
    { id: 'a', kind: 'rule', name: 'Max loss 5%', settings: { order: 1, since: '2026-10-01' } },
    { id: 'c', kind: 'rule', name: 'New one', settings: { order: 3, since: '2026-10-08' } },
    { id: 'd', kind: 'rule', name: 'Old one', hidden: true, settings: { order: 4, since: '2026-09-01' } },
    { id: 'g', kind: 'goal', name: 'Fill this out', settings: { order: 1 } },
    { id: 's', kind: 'setup', name: 'Not a rule' },
  ]`;
  const lists = json(run, `notebookLists(${rows})`);
  assert.deepEqual(lists.rules.map(r => r.key), ['mine:a', 'mine:b', 'mine:c', 'mine:d']);
  assert.deepEqual(lists.goals.map(g => g.name), ['Fill this out']);
  assert.deepEqual(json(run, `rulesForDay(notebookLists(${rows}).rules, '2026-10-06', null).map(r => r.name)`), ['Max loss 5%', 'Follow your stop'], 'not the rule made later, not the retired one');
  assert.deepEqual(json(run, `rulesForDay(notebookLists(${rows}).rules, '2026-10-06', { rules: { 'mine:d': 'broke' } }).map(r => r.name)`), ['Max loss 5%', 'Follow your stop', 'Old one'], 'a retired rule that day answered stays');
});

test('a plan is written with a feeling, energy, where, the market and the plan; a day reviewed with a grade, every rule and a note', async () => {
  const { run } = await app();
  assert.equal(run("planMissingWords(planState(null))"), "how you feel, sleep and energy, where you're trading, the market and the plan");
  assert.equal(run("planState({ feelings: ['calm'], energy: 'ok', place: 'desk', market: 'choppy', plan: 'x' }).written"), true);
  assert.equal(run("planMissingWords(planState({ feelings: ['calm'], energy: 'ok', place: 'desk', market: 'choppy' }))"), 'the plan');
  const rules = "[{ key: 'mine:a' }, { key: 'mine:b' }]";
  assert.equal(run(`reviewMissingWords(dayReviewState({ grade: 'B', rules: { 'mine:a': 'kept' } }, ${rules}))`), '1 rule and what went well or what to work on');
  assert.equal(run(`dayReviewState({ grade: 'B', rules: { 'mine:a': 'kept', 'mine:b': 'broke' }, work_on: 'sizing' }, ${rules}).reviewed`), true);
  assert.equal(run(`dayReviewState({ grade: 'B', note: 'only more notes' }, []).reviewed`), false, 'more notes never count');
  assert.equal(run(`dayReviewState({ grade: 'B', went_well: 'x' }, []).reviewed`), true, 'no rules yet: nothing to answer');
});

test('the last focus is the nearest one in the week before; the trades a day touched', async () => {
  const { run } = await app();
  assert.deepEqual(json(run, "lastFocus({ '2026-10-02': { focus_next: 'old' }, '2026-10-05': { focus_next: 'Only focus names' } }, '2026-10-07')"), { day: '2026-10-05', text: 'Only focus names' });
  assert.equal(run("lastFocus({ '2026-09-28': { focus_next: 'too old' } }, '2026-10-07')"), null);
  const trades = `[
    { key: 'a', openedAt: '2026-10-05T14:00:00Z', closedAt: '2026-10-06T15:00:00Z', status: 'win', pnl: 10 },
    { key: 'b', openedAt: '2026-10-06T14:00:00Z', closedAt: null, status: 'open', pnl: 0 },
    { key: 'c', openedAt: '2026-10-06T14:00:00Z', closedAt: '2026-10-06T15:00:00Z', status: 'win', pnl: 5, deleted: true },
    { key: 'd', openedAt: '', closedAt: '2026-10-06T15:00:00Z', status: 'history', pnl: 0 },
    { key: 'e', openedAt: '2026-10-07T14:00:00Z', closedAt: '2026-10-07T15:00:00Z', status: 'win', pnl: 5 },
  ]`;
  assert.deepEqual(json(run, `dayTrades(${trades}, '2026-10-06').map(t => t.key)`), ['a', 'b'], 'closed then, opened then; deleted and before-history ones aside');
});

// ---------- the page ----------

const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const order = (id, instruction, time, qty, price, symbol = 'AAPL') => ({ kind: 'order', record_id: String(id), account: '6789', entered_at: time.replace('+0000', 'Z'), data: {
  orderId: id, enteredTime: time, status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction, quantity: qty, instrument: { symbol, assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: id * 10, executionLegs: [{ legId: 1, quantity: qty, price, time }] }],
} });
const RECORDS = [
  order(1, 'BUY', '2026-10-05T13:35:00+0000', 100, 100), order(2, 'SELL', '2026-10-05T15:00:00+0000', 100, 103),
  order(3, 'BUY', '2026-10-06T13:40:00+0000', 50, 200, 'MSFT'), order(4, 'SELL', '2026-10-06T15:00:00+0000', 50, 198, 'MSFT'),
];
const RULES = [
  { id: 'r1', kind: 'rule', name: 'Max loss = 5%', hidden: false, settings: { order: 1, since: '2026-09-01' } },
  { id: 'r2', kind: 'rule', name: 'Follow your stop!!', hidden: false, settings: { order: 2, since: '2026-09-01' } },
];

// Tuesday Oct 6, 5pm New York: Monday's and Tuesday's sessions are over
async function journal({ records = RECORDS, library = [], days = [], reviews = [], broken = false, now = Date.parse('2026-10-06T21:00:00Z') } = {}) {
  const supabase = fakeRecords(records, reviews);
  for (const r of library) supabase.tables.library_items.set(`user-1:${r.id}`, { user_id: 'user-1', ...r });
  for (const d of days) supabase.tables.journal_days.set(`user-1:${d.day}`, { user_id: 'user-1', ...d });
  if (broken) supabase.failColumn('journal_days', 'plan');
  const a = await app({ supabase, session: SESSION, clock: true, now });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  await settle();
  const writes = table => supabase.writes.filter(w => w.table === table);
  return { ...a, supabase, writes, out: () => a.elements.get('journalSection').innerHTML };
}

test('a calendar day opens its page: premarket, the day\'s trades, post-market; ← Calendar and the tab go back', async () => {
  const { run, state, out } = await journal({ library: RULES });
  run("setJournalTab('calendar')");
  assert.match(out(), /<button class="jc-day journal-sell" data-action="openJournalDay" data-arg="2026-10-06"/);
  assert.match(out(), /<button class="jc-day jc-quiet" data-action="openJournalDay" data-arg="2026-10-07" aria-label="2026-10-07: no exits\. Open the day">/, 'a quiet day opens too');
  run("openJournalDay('2026-10-06')");
  assert.equal(state.journalTab, 'calendar');
  const page = out();
  assert.match(page, /id="journalDayPage"[\s\S]*class="jc-title">Tue, Oct 6, 2026</);
  assert.doesNotMatch(page, /class="jc-grid"/, 'in place of the calendar');
  assert.doesNotMatch(page, /id="journalSymbol"/, 'no filters: the whole day');
  assert.match(page, /aria-label="Premarket"[\s\S]*aria-label="The day"[\s\S]*aria-label="Post-market"/, 'the plan above the review');
  assert.match(page, /Mental check-in[\s\S]*How you feel[\s\S]*data-action="toggleDayFeeling" data-arg="calm">Calm<\/button>/);
  assert.match(page, /To write: how you feel, sleep and energy, where you&#39;re trading, the market and the plan/);
  assert.match(page, /<ol class="nb-list"><li>Max loss = 5%<\/li><li>Follow your stop!!<\/li><\/ol>/);
  assert.match(page, /No goals yet/);
  assert.match(page, /<dt>Net P&amp;L<\/dt><dd class="journal-sell">−\$100\.00<span class="pos-sub">1 with an exit/);
  assert.match(page, /data-action="openTradeRow" data-arg="[^"]*MSFT[^"]*"><span class="nb-trade-name"><b>MSFT<\/b> long/);
  assert.doesNotMatch(page, /<b>AAPL<\/b> long/, 'Monday\'s trade isn\'t Tuesday\'s');
  assert.match(page, /data-action="pickJournalDay" data-arg="2026-10-06">The day's trades<\/button>/);
  assert.match(page, /To review: a grade, 2 rules and what went well or what to work on/);
  assert.match(page, /<span class="nb-rule-name">Max loss = 5%<\/span><span class="chip-row jr-chips"><button class="filter-btn" aria-pressed="false" data-action="setDayRule" data-arg="mine:r1" data-arg2="kept">Kept<\/button>/);
  assert.match(page, /From the day's trades[\s\S]*<b>MSFT<\/b> <span class="nb-none">No exit note yet<\/span>/);
  assert.doesNotMatch(page, /Kept your last focus/, 'no focus written before: no question');
  run("stepJournalDay('1')");
  assert.equal(state.journalNotebookDay, '2026-10-07');
  assert.match(out(), /No trades yet\./, 'Wednesday hasn\'t happened');
  assert.match(out(), /For after the close\./);
  run('closeJournalDay()');
  assert.match(out(), /class="jc-grid"/);
  run("openJournalDay('2026-10-05'); setJournalTab('calendar')");
  assert.equal(state.journalNotebookDay, '', 'the Calendar tab goes back to the calendar');
});

test('the check-in and plan save field by field; the plan is stamped written; the market is the trades\' market too', async () => {
  const { run, out, writes, supabase, state } = await journal();
  run("openJournalDay('2026-10-06')");
  run("toggleDayFeeling('calm'); toggleDayFeeling('focused')");
  await settle();
  assert.deepEqual(writes('journal_days').map(w => [w.day, w.onConflict, w.feelings]), [['2026-10-06', 'user_id,day', ['calm']], ['2026-10-06', 'user_id,day', ['calm', 'focused']]]);
  assert.deepEqual(Object.keys(writes('journal_days')[0]).filter(k => !['table', 'onConflict', 'ignoreDuplicates', 'day'].includes(k)), ['feelings'], 'only its own column');
  run("toggleDayFeeling('calm')");
  run("setDayEnergy('ok'); setDayPlace('desk'); setDayMarket('choppy'); daySleepSave('6.4')");
  await settle();
  const saved = supabase.tables.journal_days.get('user-1:2026-10-06');
  assert.deepEqual([saved.feelings, saved.energy, saved.place, saved.market, saved.sleep_hours, saved.planned_at], [['focused'], 'ok', 'desk', 'choppy', 6.5, undefined]);
  assert.match(out(), /class="jr-row jr-missing"><label class="jr-label" for="nb-plan">Plan/, 'started: what\'s missing turns amber');
  run("dayTextInput('plan', 'No trades before 9:45')");
  run('renderJournal()');
  assert.match(out(), /id="nb-plan"[^>]*>No trades before 9:45<\/textarea>/, 'a redraw keeps the draft');
  run("dayTextSave('plan', '  No trades before 9:45 ')");
  await settle();
  assert.equal(supabase.tables.journal_days.get('user-1:2026-10-06').plan, 'No trades before 9:45');
  assert.ok(supabase.tables.journal_days.get('user-1:2026-10-06').planned_at, 'stamped with the save that finished it');
  assert.match(out(), /<span class="jr-status journal-buy" role="status">Plan written<\/span>/);
  assert.equal(state.journalReview.days['2026-10-06'].market, 'choppy', 'the day\'s market, the one each trade\'s review reads');
  run("setDayEnergy('ok')");
  await settle();
  assert.equal(supabase.tables.journal_days.get('user-1:2026-10-06').planned_at, null, 'tapping the lit one clears it, and the stamp');
});

test('goals and rules: added, reworded, moved and retired in place, each a library row', async () => {
  const { run, out, writes, supabase } = await journal();
  run("openJournalDay('2026-10-06'); editNotebookList('rule')");
  assert.match(out(), /id="nbNewItem"[^>]*data-enter="addNotebookItem" data-arg="rule"/);
  run("notebookItemInput('Follow your stop!!'); addNotebookItem('rule')");
  run("notebookItemInput('Max loss = 5%'); addNotebookItem('rule')");
  await settle();
  const rows = writes('library_items');
  assert.deepEqual(rows.map(r => [r.kind, r.name, r.hidden, r.settings.order, r.settings.since]), [['rule', 'Follow your stop!!', false, 1, '2026-10-06'], ['rule', 'Max loss = 5%', false, 2, '2026-10-06']]);
  const [stop, loss] = rows.map(r => r.id);
  run(`moveNotebookItem('${loss}', -1)`);
  await settle();
  run("editNotebookList('rule')");
  assert.match(out(), /<ol class="nb-list"><li>Max loss = 5%<\/li><li>Follow your stop!!<\/li><\/ol>/, 'moved up');
  run(`editNotebookList('rule'); renameNotebookItem('${stop}', 'Follow your stop')`);
  await settle();
  assert.equal(supabase.tables.library_items.get(`user-1:${stop}`).name, 'Follow your stop');
  run(`retireNotebookItem('${loss}')`);
  await settle();
  assert.equal(supabase.tables.library_items.get(`user-1:${loss}`).hidden, true);
  assert.match(out(), /Retired: Max loss = 5% <button class="pos-link" data-action="retireNotebookItem"[^>]*>Bring back<\/button>/);
  run("editNotebookList('goal'); notebookItemInput('Learn to abide by your rules'); addNotebookItem('goal'); editNotebookList('goal')");
  await settle();
  assert.match(out(), /Goals <button[^>]*>Edit<\/button><\/div><div><ol class="nb-list"><li>Learn to abide by your rules<\/li>/);
  assert.match(out(), /<ol class="nb-list"><li>Follow your stop<\/li><\/ol>/, 'a retired rule leaves the list');
});

test('post-market: the grade, every rule and a note make the day reviewed; the calendar marks it', async () => {
  const { run, out, supabase } = await journal({ library: RULES });
  run("setJournalTab('calendar')");
  assert.match(out(), /data-arg="2026-10-06" aria-label="[^"]*, review the day\. Open the day">[\s\S]*?<span class="jc-mk jc-mk-due">●<\/span>/, 'over, with exits, not reviewed');
  run("openJournalDay('2026-10-06'); setDayGrade('B'); setDayRule('mine:r1', 'kept'); setDayRule('mine:r2', 'broke')");
  await settle();
  assert.deepEqual(supabase.tables.journal_days.get('user-1:2026-10-06').rules, { 'mine:r1': 'kept', 'mine:r2': 'broke' });
  assert.match(out(), /To review: what went well or what to work on/);
  run("dayTextSave('work_on', 'Chased MSFT')");
  await settle();
  const row = supabase.tables.journal_days.get('user-1:2026-10-06');
  assert.equal(row.work_on, 'Chased MSFT');
  assert.ok(row.reviewed_at);
  assert.match(out(), /<span class="jr-status journal-buy" role="status">Reviewed<\/span>/);
  run("dayTextSave('note', 'Slow tape'); dayTextSave('focus_next', 'Only names on the list')");
  await settle();
  assert.equal(supabase.tables.journal_days.get('user-1:2026-10-06').note, 'Slow tape', 'more notes: the day note');
  run('closeJournalDay()');
  assert.match(out(), /data-arg="2026-10-06" aria-label="[^"]*, reviewed\. Open the day">[\s\S]*?<span class="jc-mk jc-mk-done">✓<\/span>/);
  run("setDayRule('mine:r2', 'broke')"); // no page open: nothing
  run("openJournalDay('2026-10-06'); setDayRule('mine:r2', 'broke')");
  await settle();
  assert.equal(supabase.tables.journal_days.get('user-1:2026-10-06').reviewed_at, null, 'tapping the lit answer clears it, and the mark');
  run("openJournalDay('2026-10-07')");
  assert.match(out(), /<span class="nb-focus-label">Your last focus \(Tue, Oct 6\)<\/span> Only names on the list/);
  assert.match(out(), /Kept your last focus\? <span class="jr-sub">Only names on the list<\/span>/);
  run("setDayFocusKept('yes')");
  await settle();
  assert.equal(supabase.tables.journal_days.get('user-1:2026-10-07').focus_kept, 'yes');
  assert.equal(supabase.tables.journal_days.get('user-1:2026-10-07').reviewed_at, undefined, 'the focus never counts');
});

test('today\'s line opens today\'s page: write the plan, then review the day after the close', async () => {
  const morning = await journal({ now: Date.parse('2026-10-07T12:30:00Z') });
  assert.match(morning.out(), /<p class="hint nb-today" role="status">Today, Wed, Oct 7: <button class="pos-link" data-action="openTodayNotebook">Write your plan<\/button><\/p>/);
  morning.run('openTodayNotebook()');
  assert.equal(morning.state.journalNotebookDay, '2026-10-07');
  assert.match(morning.out(), /class="jc-title">Wed, Oct 7, 2026</);
  const evening = await journal({ days: [{ day: '2026-10-06', feelings: ['calm'], energy: 'ok', place: 'desk', market: 'choppy', plan: 'x' }] });
  assert.match(evening.out(), /Today, Tue, Oct 6: <button class="pos-link" data-action="openTodayNotebook">Review the day<\/button>/);
  const weekend = await journal({ now: Date.parse('2026-10-10T15:00:00Z') });
  assert.match(weekend.out(), /Monday, Mon, Oct 12: <button[^>]*>Write your plan</);
  const signedOut = await app();
  signedOut.run("setView('journal')");
  assert.doesNotMatch(signedOut.elements.get('journalSection').innerHTML, /nb-today/);
});

test('a plan needs no trades: the page works before any import', async () => {
  const { run, out } = await journal({ records: [] });
  run("openJournalDay('2026-10-07')");
  assert.match(out(), /id="journalDayPage"/);
  assert.match(out(), /No trades yet\./);
});

test('a save Supabase refuses goes back with a toast', async () => {
  const { run, out, supabase, elements, state } = await journal();
  run("openJournalDay('2026-10-06')");
  supabase.fail();
  run("setDayGrade('A')");
  assert.match(out(), /aria-pressed="true" data-action="setDayGrade" data-arg="A"/, 'shown at once');
  await settle();
  assert.match(elements.get('errorBox').textContent, /Couldn't save the notebook: nope/);
  assert.doesNotMatch(out(), /aria-pressed="true" data-action="setDayGrade"/, 'and put back');
  assert.equal(state.journalReview.days['2026-10-06'].grade, null);
});

test('before the migration is pushed the page says so, nothing saves, and the rest of the journal works', async () => {
  const { run, out, writes, state } = await journal({ broken: true, days: [{ day: '2026-10-06', market: 'bullish' }] });
  assert.match(state.journalReview.notebookError, /npx supabase db push/);
  assert.equal(state.journalReview.days['2026-10-06'].market, 'bullish', 'the market still reads');
  run("setJournalTab('calendar')");
  assert.doesNotMatch(out(), /jc-mk/, 'no marks it can\'t keep');
  run("openJournalDay('2026-10-06')");
  assert.match(out(), /The notebook needs a database update: the database doesn&#39;t have the notebook columns yet: npx supabase db push/);
  assert.match(out(), /data-action="setDayGrade" data-arg="A" disabled>/);
  assert.match(out(), /id="nb-plan"[^>]*disabled>/);
  assert.doesNotMatch(out(), /data-action="editNotebookList"/, 'no editing goals or rules either');
  run("setDayGrade('A'); toggleDayFeeling('calm')");
  await settle();
  assert.equal(writes('journal_days').length, 0, 'nothing written');
  assert.ok(state.tradeReviews && !state.journalError && !state.journalReviewError, 'the rest of the journal loaded');
});

// ---------- missed trades ----------

test('missed trades are cleaned on the way in: an id and a ticker each, choices from their lists, R to a tenth', async () => {
  const { run } = await app();
  const m = json(run, `cleanDayRow({ missed: [
    { id: 'a', symbol: ' nvda ', side: 'long', why: 'hesitated', setup: 'ema8_bounce', r: '2.04', note: '  ran without me ' },
    { id: 'a', symbol: 'TSLA' }, { id: 'b', symbol: 'not a ticker!' }, { symbol: 'AMD' },
    { id: 'c', symbol: 'BRK.B', side: 'sideways', why: 'bored', r: 500 },
  ] }).missed`);
  assert.deepEqual(m, [
    { id: 'a', symbol: 'NVDA', side: 'long', setup: 'ema8_bounce', why: 'hesitated', r: 2, note: 'ran without me' },
    { id: 'c', symbol: 'BRK.B', side: null, setup: null, why: null, r: null, note: null },
  ]);
  assert.deepEqual(json(run, 'cleanDayRow(null).missed'), []);
  assert.equal(run(`cleanMissed(Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i, symbol: 'SPY' }))).length`), 20);
});

test('a missed trade: added by ticker, filled in, on the calendar, removed with Undo', async () => {
  const { run, out, supabase, elements } = await journal();
  run("openJournalDay('2026-10-06')");
  assert.match(out(), /aria-label="The day"[\s\S]*aria-label="Missed trades"[\s\S]*aria-label="Post-market"/, 'between the day and the review');
  assert.match(out(), /Trades you saw and didn't take/);
  run("missedInput('?!'); addMissedTrade()");
  assert.match(elements.get('errorBox').textContent, /Type the ticker you missed/);
  run("missedInput('nvda'); addMissedTrade()");
  await settle();
  const saved = () => supabase.tables.journal_days.get('user-1:2026-10-06').missed;
  assert.equal(saved().length, 1);
  const id = saved()[0].id;
  assert.equal(saved()[0].symbol, 'NVDA');
  assert.match(out(), /<div class="nb-miss-head"><b>NVDA<\/b>/, 'open to fill in');
  run(`setMissedSide('${id}', 'short'); setMissedWhy('${id}', 'hesitated'); setMissedSetup('${id}', 'ema8_bounce'); missedRSave('${id}', '2.5')`);
  run(`missedNoteInput('${id}', 'Saw the rejection')`);
  run('renderJournal()');
  assert.match(out(), /id="nbMissedNote-[^"]*"[^>]*value="Saw the rejection"/, 'a redraw keeps the draft');
  run(`missedNoteSave('${id}', ' Saw the rejection, waited ')`);
  await settle();
  assert.deepEqual(saved(), [{ id, symbol: 'NVDA', side: 'short', setup: 'ema8_bounce', why: 'hesitated', r: 2.5, note: 'Saw the rejection, waited' }]);
  assert.ok(supabase.writes.filter(w => w.table === 'journal_days').every(w => Object.keys(w).filter(k => !['table', 'onConflict', 'ignoreDuplicates', 'day'].includes(k)).join() === 'missed'), 'only its own column');
  run(`openMissedTrade('${id}')`);
  assert.match(out(), /<b>NVDA<\/b> short · 8 EMA rejection · Hesitated<span class="nb-miss-note">Saw the rejection, waited<\/span><\/span><span class="journal-buy">\+2\.5R<\/span>/, 'closed: one line, the setup in the side\'s words');
  assert.match(out(), /<span class="jr-status nb-miss-count" role="status">1 missed · \+2\.5R not taken<\/span>/);
  run(`setMissedWhy('${id}', 'hesitated')`);
  await settle();
  assert.equal(saved()[0].why, null, 'tapping the lit one clears it');
  assert.equal(supabase.tables.journal_days.get('user-1:2026-10-06').reviewed_at, undefined, 'missed trades never make the day reviewed');
  run('closeJournalDay()');
  assert.match(out(), /data-arg="2026-10-06" aria-label="[^"]*, 1 missed\. Open the day">[\s\S]*?<span class="jc-mk jc-mk-missed">⊘1<\/span>/);
  run(`openJournalDay('2026-10-06'); removeMissedTrade('${id}')`);
  await settle();
  assert.deepEqual(saved(), []);
  assert.match(elements.get('errorBox').innerHTML, /Removed NVDA\. <button[^>]*data-action="undoRemoveMissed">Undo<\/button>/);
  run('undoRemoveMissed()');
  await settle();
  assert.equal(saved()[0].symbol, 'NVDA', 'back');
});

test('before the missed trades column is pushed the section says so, and the rest of the notebook works', async () => {
  const { supabase, ...rest } = await (async () => {
    const supabase = fakeRecords(RECORDS, []);
    supabase.tables.journal_days.set('user-1:2026-10-06', { user_id: 'user-1', day: '2026-10-06', grade: 'B' });
    supabase.failColumn('journal_days', 'missed');
    const a = await app({ supabase, session: SESSION, clock: true, now: Date.parse('2026-10-06T21:00:00Z') });
    a.run("setView('journal')");
    await a.run('loadJournal()');
    await settle();
    return { supabase, ...a };
  })();
  const { run, state, elements } = rest;
  const out = () => elements.get('journalSection').innerHTML;
  assert.match(state.journalReview.missedError, /npx supabase db push/);
  assert.equal(state.journalReview.notebookError, '');
  assert.equal(state.journalReview.days['2026-10-06'].grade, 'B', 'the notebook still reads');
  run("openJournalDay('2026-10-06')");
  assert.match(out(), /Missed trades need a database update/);
  assert.match(out(), /id="nbMissedNew"[^>]*disabled/);
  assert.doesNotMatch(out(), /data-action="setDayGrade" data-arg="A" disabled/, 'the rest of the page works');
  run("missedInput('NVDA'); addMissedTrade()");
  await settle();
  assert.equal(supabase.writes.filter(w => w.table === 'journal_days').length, 0, 'nothing written');
});
