// Run with: node --test
// Reviewing a trade (journal step 3, slice 1): the library over the defaults (your items, renames, hides, merges), setup
// keys, what makes a trade reviewed, and the Review section on the trade page: market for the day or the trade, the
// labels, both grades, the entry and exit notes, + New, the reviewed mark and the To review filter, the choices sheet, and failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const json = (run, code) => JSON.parse(run(`JSON.stringify(${code})`));

test('My setups: the starting ones, what each is made of, names for new ones, same-parts reuse, most used first', async () => {
  const { run } = await app();
  const mine = [{ id: 's1', kind: 'setup', name: '50 SMA/support UnR', settings: { action: 'undercut', levels: ['sma50', 'support'] } }];
  const lib = `buildLibrary(${JSON.stringify(mine)})`;
  assert.deepEqual(json(run, `${lib}.choices('setup').map(i => i.name)`).slice(0, 3), ['8 EMA bounce', '21 EMA bounce', '50 SMA bounce']);
  assert.deepEqual(json(run, `${lib}.parts('ema21_unr')`), { action: 'undercut', levels: ['ema21'] });
  assert.deepEqual(json(run, `${lib}.parts('base_breakout')`), { pattern: 'base_breakout' });
  assert.deepEqual(json(run, `${lib}.parts('mine:s1')`), { action: 'undercut', levels: ['sma50', 'support'] }, 'yours keep what they are made of');
  assert.equal(run(`${lib}.partsWords(${lib}.parts('mine:s1'))`), 'Undercut & rally at 50 SMA + Support');
  assert.equal(run(`${lib}.nameOf('setup', 'mine:s1')`), '50 SMA/support UnR');
  assert.equal(run(`setupName(${lib}, { action: 'bounce', levels: ['ema21', 'support'] })`), '21 EMA + Support bounce', 'a new setup\'s name until you type one');
  assert.equal(run(`setupName(${lib}, { pattern: 'flag_breakout' })`), 'Pennant or flag breakout');
  assert.equal(run(`setupName(${lib}, { action: 'bounce', levels: [] })`), '', 'not ready without a level');
  assert.equal(run(`sameParts({ action: 'undercut', levels: ['support', 'sma50'] }, { action: 'undercut', levels: ['sma50', 'support'] })`), true);
  const used = { a: [{ kind: 'setup', value: 'mine:s1' }], b: [{ kind: 'setup', value: 'mine:s1' }, { kind: 'setup', value: 'earnings_gap' }] };
  assert.deepEqual(json(run, `setupsByUse(${lib}, ${JSON.stringify(used)}).map(i => i.key)`).slice(0, 3), ['mine:s1', 'earnings_gap', 'ema8_bounce'], 'most used first, then the list\'s order');
});

test('the library: defaults, your own items, a renamed and a hidden default, merges followed', async () => {
  const { run } = await app();
  const rows = [
    { id: 'u1', kind: 'level', name: 'Prior day high' },
    { id: 'u2', kind: 'level', name: 'PDH', merged_into: 'mine:u1' },
    { id: 'u3', kind: 'tactic', name: '30m pivot', default_key: 'pivot30' },
    { id: 'u4', kind: 'tag', name: 'Option flow', default_key: 'option_flow', hidden: true },
    { id: 'u5', kind: 'action', name: 'reclaim' },
  ];
  const lib = `buildLibrary(${JSON.stringify(rows)})`;
  assert.equal(run(`${lib}.nameOf('tactic', 'pivot30')`), '30m pivot', 'a renamed default');
  assert.equal(run(`${lib}.nameOf('setup', 'sma50+bounce')`), '50 SMA bounce');
  assert.equal(run(`${lib}.nameOf('setup', 'mine:u2+mine:u5')`), 'Prior day high reclaim', 'a merged item names as the one it went into');
  assert.equal(run(`${lib}.nameOf('setup', 'pattern:base_breakout')`), 'Base breakout');
  assert.equal(run(`${lib}.nameOf('setup', 'ema21')`), '21 EMA', 'a level alone');
  assert.deepEqual(json(run, `${lib}.choices('tag').map(i => i.key)`), [], 'a hidden default stops being offered');
  assert.deepEqual(json(run, `${lib}.choices('level').map(i => i.key)`).slice(-1), ['mine:u1'], 'yours after the defaults; the merged one is gone');
  assert.equal(run(`${lib}.resolve('level', 'mine:u2')`), 'mine:u1');
  assert.equal(run("setupKey({ level: 'sma50', action: 'bounce' })"), 'sma50+bounce');
  assert.equal(run("setupKey({ pattern: 'earnings_gap' })"), 'pattern:earnings_gap');
  assert.deepEqual(json(run, "parseSetup('ema8+undercut')"), { pattern: '', level: 'ema8', action: 'undercut' });
});

test('reviewed means market, sector, a setup, a tactic, both grades and an exit note (the entry note is optional); the trade\'s own market wins over the day\'s', async () => {
  const { run } = await app();
  const none = json(run, 'reviewState(null, [], null)');
  assert.deepEqual(none, { market: null, marketOwn: false, missing: ['market', 'sector', 'setup', 'tactic', 'setup grade', 'plan followed', 'exit note'], reviewed: false, started: false });
  assert.equal(run(`missingWords(${JSON.stringify(none.missing)})`), 'market, sector, setup and 4 more');
  const labels = [{ kind: 'sector', value: 'strong' }, { kind: 'setup', value: 'sma50+bounce' }, { kind: 'tactic', value: 'pivot30' }];
  const done = json(run, `reviewState({ setup_grade: 'A', plan_followed: 'partly', note: 'added early' }, ${JSON.stringify(labels)}, 'bullish')`);
  assert.deepEqual([done.reviewed, done.market, done.marketOwn], [true, 'bullish', false]);
  const own = json(run, `reviewState({ market: 'choppy', setup_grade: 'A', plan_followed: 'yes', note: '  ' }, ${JSON.stringify(labels)}, 'bullish')`);
  assert.deepEqual([own.market, own.marketOwn, own.missing], ['choppy', true, ['exit note']], 'a blank note isn\'t a note');
  const entryOnly = json(run, `reviewState({ setup_grade: 'A', plan_followed: 'yes', entry_note: 'base breakout, stop under the 21' }, ${JSON.stringify(labels)}, 'bullish')`);
  assert.deepEqual(entryOnly.missing, ['exit note'], 'an entry note isn\'t the exit note');
});

// ---------- the Review section on the trade page ----------

const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const ENTRY = {
  orderId: 501, enteredTime: '2026-10-01T14:30:00+0000', status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction: 'BUY', quantity: 100, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7001, executionLegs: [{ legId: 1, quantity: 100, price: 100.02, time: '2026-10-01T14:30:01+0000' }] }],
  childOrderStrategies: [{
    orderId: 502, status: 'FILLED', orderType: 'STOP', stopPrice: 95,
    orderLegCollection: [{ legId: 1, instruction: 'SELL', quantity: 100, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7002, executionLegs: [{ legId: 1, quantity: 100, price: 94.98, time: '2026-10-02T15:00:00+0000' }] }],
  }],
};
const KEY = '6789|AAPL|long|2026-10-01T14:30:01.000Z';
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

async function page(tweak) {
  const supabase = fakeRecords([{ kind: 'order', record_id: '501', account: '6789', entered_at: '2026-10-01T14:30:00Z', data: ENTRY }]);
  if (tweak) tweak(supabase);
  const a = await app({ supabase, session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  a.run(`openJournalTrade('${KEY}')`);
  await settle();
  const t = 'journalPageTrade()';
  return { ...a, supabase, t, body: () => a.elements.get('jtBody').innerHTML, list: () => a.elements.get('journalSection').innerHTML, rows: name => [...supabase.tables[name].values()] };
}

test('a setup named for its parts follows them renamed; a name you typed stays', async () => {
  const { run } = await app();
  const rows = [
    { id: 'u1', kind: 'level', name: '9 EMA', default_key: 'ema8' },
    { id: 'u2', kind: 'setup', name: '8 EMA rejection', settings: { action: 'rejection', levels: ['ema8'] } },
    { id: 'u3', kind: 'setup', name: 'My 8 EMA', settings: { action: 'bounce', levels: ['ema8', 'ema21'] } },
    { id: 'u4', kind: 'pattern', name: 'Gap and go', default_key: 'earnings_gap' },
  ];
  const lib = `buildLibrary(${JSON.stringify(rows)})`;
  assert.equal(run(`${lib}.nameOf('setup', 'ema8_bounce')`), '9 EMA bounce', 'a starting setup follows its level');
  assert.equal(run(`${lib}.nameOf('setup', 'mine:u2', 'short')`), '9 EMA rejection', 'yours too, when its name was its parts');
  assert.equal(run(`${lib}.nameOf('setup', 'mine:u2')`), '9 EMA bounce', 'a rejection is a bounce read from a long');
  assert.equal(run(`${lib}.nameOf('setup', 'mine:u3')`), 'My 8 EMA', 'a typed name stays');
  assert.equal(run(`${lib}.nameOf('setup', 'earnings_gap')`), 'Gap and go', 'a pattern setup follows its pattern');
  assert.equal(run(`${lib}.nameOf('setup', 'flag_breakout')`), 'Pennant or flag breakout', 'the starting flag setup is named for its pattern');
  const former = rows => `buildLibrary(${JSON.stringify(rows)})`;
  assert.equal(run(`${former([{ id: 'f1', kind: 'setup', name: 'Flag breakout', default_key: 'flag_breakout', hidden: true }])}.nameOf('setup', 'flag_breakout', 'short')`), 'Pennant or flag breakdown', 'a row still under its old name follows the pattern too');
  assert.equal(run(`${former([{ id: 'f1', kind: 'setup', name: 'Flags', default_key: 'flag_breakout' }])}.nameOf('setup', 'flag_breakout')`), 'Flags', 'a typed name stays');
  const own = `buildLibrary(${JSON.stringify([{ id: 'a1', kind: 'action', name: 'Breakout' }, { id: 's1', kind: 'setup', name: 'Resistance Breakout', settings: { action: 'mine:a1', levels: ['resistance'] } }])})`;
  assert.equal(run(`${own}.nameOf('setup', 'mine:s1')`), 'Resistance breakout', 'an action of yours reads in lower case in a name, and a name in another case still follows');
  assert.equal(run(`${own}.nameOf('setup', 'mine:s1', 'short')`), 'Support breakdown', 'a breakout of yours is a breakdown on a short');
  assert.equal(run(`setupName(${own}, { action: 'mine:a1', levels: ['sma50'] })`), '50 SMA breakout');
  const edited = `buildLibrary(${JSON.stringify([...rows, { id: 'u5', kind: 'setup', name: '8 EMA bounce', default_key: 'ema21_bounce', settings: { action: 'bounce', levels: ['ema8'] } }])})`;
  assert.equal(run(`${edited}.nameOf('setup', 'ema21_bounce')`), '9 EMA bounce', 'an edited one follows its new parts');
});

test('the Review section: market for the day or this trade, sector, My setups (one tap, or + New setup), tactic, tags, grades, the exit note', async () => {
  const { run, state, t, body, rows, supabase } = await page();
  assert.match(body(), /<span class="section-title js-sub">Review<\/span>\s*<span class="jr-status "[^>]*>To review: missing market, sector, setup and 4 more<\/span>/);
  assert.ok(supabase.reads.some(r => r.table === 'trade_labels') && supabase.reads.some(r => r.table === 'journal_days') && supabase.reads.some(r => r.table === 'library_items'), 'everything a review needs is read with the journal');

  await run(`setReviewMarket(${t}, 'bullish')`);
  assert.deepEqual(rows('journal_days').map(r => [r.day, r.market]), [['2026-10-01', 'bullish']], 'the market is the day\'s: 10/1, when it opened');
  assert.match(body(), /For every trade on 10\/1/);
  run(`toggleReviewMarketOwn(${t})`);
  await run(`setReviewMarket(${t}, 'choppy')`);
  assert.equal(rows('trade_reviews')[0].market, 'choppy', 'just this trade: its own');
  assert.equal(rows('journal_days')[0].market, 'bullish', 'the day keeps its market');
  assert.match(body(), /This trade only <button class="pos-link" data-action="toggleReviewMarketOwn">use 10\/1(?:'|&#39;)s/);

  await run(`toggleReviewLabel(${t}, 'sector', 'strong')`);
  await run(`toggleReviewLabel(${t}, 'sector', 'weak')`);
  assert.deepEqual(rows('trade_labels').filter(r => r.kind === 'sector').map(r => r.value), ['weak'], 'one sector: the new one replaces the old');
  assert.match(body(), /<div class="jr-label">My setups<\/div>[\s\S]*data-action="toggleSetup" data-arg="ema8_bounce" title="Bounce at 8 EMA">8 EMA bounce/, 'the starting setups, one tap each');
  await run(`toggleSetup(${t}, 'ema21_bounce')`);
  await run(`toggleSetup(${t}, 'earnings_gap')`);
  await run(`toggleSetup(${t}, 'earnings_gap')`);
  assert.deepEqual(rows('trade_labels').filter(r => r.kind === 'setup').map(r => r.value), ['ema21_bounce'], 'tapping a lit one takes it off');
  assert.match(body(), /aria-pressed="true" data-action="toggleSetup" data-arg="ema21_bounce"/, 'lit, and first');

  run('startSetupDraft()');
  assert.match(body(), /What happened\?[\s\S]*At what\?[\s\S]*Or a pattern[\s\S]*Tap what happened and at what, or a pattern\. It goes on this trade as you tap\.<\/span><\/span><button class="btn" data-action="cancelSetupDraft">Done<\/button>/);
  assert.doesNotMatch(body(), /saveSetupDraft|setupDraftName/, 'no Save, no name box');
  await run(`setDraftAction(${t}, 'undercut')`);
  assert.match(body(), /Now at what\?/);
  await run(`toggleDraftLevel(${t}, 'sma50')`);
  const setups = () => rows('trade_labels').filter(r => r.kind === 'setup').map(r => r.value);
  assert.deepEqual(setups(), ['ema21_bounce', 'sma50_unr'], 'a tap puts on the setup you have');
  assert.equal(rows('library_items').length, 0, 'nothing new made');
  assert.match(body(), /Added <b>50 SMA undercut &amp; rally<\/b>\.<\/span><\/span><button class="btn primary" data-action="cancelSetupDraft">Done/);
  await run(`toggleDraftLevel(${t}, 'support')`);
  const mine = rows('library_items').find(r => r.kind === 'setup');
  assert.deepEqual([mine.name, mine.settings], ['50 SMA + Support undercut & rally', { action: 'undercut', levels: ['sma50', 'support'] }], 'at both: a new one in My setups, named for its parts');
  assert.deepEqual(setups(), ['ema21_bounce', `mine:${mine.id}`], 'in place of the one the builder put on');
  assert.match(body(), /Added <b>50 SMA \+ Support undercut &amp; rally<\/b> to this trade and My setups\. Rename it in Edit setups\./);
  await run(`toggleDraftLevel(${t}, 'ema21')`);
  assert.deepEqual(rows('library_items').map(r => [r.id, r.name]), [[mine.id, '50 SMA + Support + 21 EMA undercut & rally']], 'the one it made changes with the taps, not a second one');
  await run(`toggleDraftLevel(${t}, 'ema21')`);
  await run(`toggleDraftLevel(${t}, 'support')`);
  assert.equal(rows('library_items').length, 0, 'back to a setup you had: the one it made goes back out of My setups');
  assert.deepEqual(setups(), ['ema21_bounce', 'sma50_unr']);
  await run(`toggleDraftLevel(${t}, 'avwap_ath'); toggleDraftLevel(${t}, 'avwap_ath')`);
  assert.equal(rows('library_items').length, 0, 'two quick taps: made and taken back, in that order');
  assert.deepEqual(setups(), ['ema21_bounce', 'sma50_unr']);
  await run(`toggleDraftLevel(${t}, 'sma50')`);
  assert.deepEqual(setups(), ['ema21_bounce'], 'no level: the setup comes off again');
  await run(`setDraftAction(${t}, 'bounce')`);
  await run(`toggleDraftLevel(${t}, 'ema21')`);
  assert.deepEqual(setups(), ['ema21_bounce'], 'one already on the trade stays put');
  assert.match(body(), /Already on this trade: <b>21 EMA bounce<\/b>/);
  await run(`setDraftPattern(${t}, 'earnings_gap')`);
  assert.deepEqual(setups(), ['ema21_bounce', 'earnings_gap'], 'a pattern goes on in one tap');
  run('cancelSetupDraft()');
  assert.equal(state.setupDraft, null);
  assert.deepEqual(setups(), ['ema21_bounce', 'earnings_gap'], 'Done keeps it');
  await run(`toggleSetup(${t}, 'earnings_gap')`);
  await run(`toggleReviewLabel(${t}, 'tactic', 'pivot30')`);
  await run(`toggleReviewLabel(${t}, 'tactic', 'six20')`);
  assert.deepEqual(rows('trade_labels').filter(r => r.kind === 'tactic').map(r => r.value), ['pivot30', 'six20'], 'a trade can have several entry tactics');
  await run(`toggleReviewLabel(${t}, 'tactic', 'six20')`);
  assert.deepEqual(rows('trade_labels').filter(r => r.kind === 'tactic').map(r => r.value), ['pivot30'], 'tapping a lit one takes only it off');
  await run(`toggleReviewLabel(${t}, 'tag', 'option_flow')`);
  await run(`toggleReviewLabel(${t}, 'mistake', 'chased')`);
  await run(`setSetupGrade(${t}, 'A')`);
  await run(`setPlanFollowed(${t}, 'partly')`);
  assert.match(body(), /To review: missing exit note/);
  assert.equal(rows('trade_reviews')[0].reviewed_at ?? null, null);

  run(`reviewNoteInput(${t}, 'added too early')`);
  assert.equal(state.reviewNoteDraft.text, 'added too early', 'kept as a draft while typing');
  await run(`reviewNoteSave(${t}, 'added too early')`);
  const rv = rows('trade_reviews')[0];
  assert.deepEqual([rv.trade_key, rv.market, rv.setup_grade, rv.plan_followed, rv.note], [KEY, 'choppy', 'A', 'partly', 'added too early']);
  assert.ok(rv.reviewed_at, 'reviewed: stamped');
  assert.match(body(), /<span class="jr-status journal-buy"[^>]*>Reviewed<\/span>/);

  await run(`setSetupGrade(${t}, 'A')`);
  assert.equal(rows('trade_reviews')[0].setup_grade, null, 'tapping the lit grade clears it');
  assert.equal(rows('trade_reviews')[0].reviewed_at, null, 'and it\'s back to review');
  assert.equal(rows('trade_reviews')[0].note, 'added too early', 'nothing else touched');
});

test('two notes: the entry note is optional and kept apart from the exit note; drafts stay in their own box', async () => {
  const { run, state, t, body, rows } = await page();
  assert.match(body(), /<label class="jr-label" for="entryNote">Entry note <span class="jr-sub">optional<\/span><\/label>\s*<div><textarea id="entryNote"[^>]*data-arg="entry"/);
  assert.match(body(), /<label class="jr-label" for="reviewNote">Exit note<\/label>[\s\S]*data-arg="exit"/, 'a closed trade asks for the exit note');
  assert.ok(body().indexOf('id="entryNote"') < body().indexOf('id="reviewNote"'), 'the entry note above, to read while writing the exit note');
  run(`reviewNoteInput(${t}, 'base breakout, out under the 21', 'entry'); renderJournalTrade()`);
  assert.match(body(), /id="entryNote"[^>]*>base breakout, out under the 21<\/textarea>/, 'the draft survives a redraw');
  assert.match(body(), /id="reviewNote"[^>]*><\/textarea>/, 'and stays out of the exit box');
  await run(`reviewNoteSave(${t}, 'base breakout, out under the 21', 'entry')`);
  assert.deepEqual([rows('trade_reviews')[0].entry_note, rows('trade_reviews')[0].note ?? null], ['base breakout, out under the 21', null]);
  assert.equal(state.reviewNoteDraft, null);
  assert.match(body(), /To review: missing [^<]*\b(?:and \d more|exit note)/, 'an entry note alone doesn\'t review it');
  await run(`reviewNoteSave(${t}, 'stopped on the open, plan was fine', 'exit')`);
  assert.deepEqual([rows('trade_reviews')[0].entry_note, rows('trade_reviews')[0].note], ['base breakout, out under the 21', 'stopped on the open, plan was fine'], 'each in its own column');
  await run(`reviewNoteSave(${t}, '  ', 'entry')`);
  assert.equal(rows('trade_reviews')[0].entry_note, null, 'emptied: cleared');
  run(`openJournalTrade('${KEY}')`);
  assert.match(body(), /id="reviewNote"[^>]*>stopped on the open, plan was fine<\/textarea>/, 'read back with the journal');
});

test('entry notes before the migration is pushed: the box is off and says why; the rest of the review works', async () => {
  const { run, t, body, rows, elements } = await page(s => s.failColumn('trade_reviews', 'entry_note'));
  assert.match(body(), /<textarea id="entryNote"[^>]*disabled>/);
  assert.match(body(), /Entry notes need a database update: the database doesn(?:'|&#39;)t have the entry note column yet: npx supabase db push/);
  await run(`reviewNoteSave(${t}, 'thesis', 'entry')`);
  assert.match(elements.get('errorBox').textContent, /Entry notes need a database update/);
  await run(`reviewNoteSave(${t}, 'what happened', 'exit')`);
  assert.equal(rows('trade_reviews')[0].note, 'what happened', 'the exit note still saves');
});

test('the list: a reviewed mark, the To review filter; your stop and delete stay apart from the review', async () => {
  const { run, t, list, rows } = await page(s => {
    s.tables.journal_days.set('user-1:2026-10-01', { user_id: 'user-1', day: '2026-10-01', market: 'bullish' });
    for (const [kind, value] of [['sector', 'strong'], ['setup', 'sma50'], ['tactic', 'pivot15']]) s.tables.trade_labels.set(`user-1:${KEY}:${kind}:${value}`, { user_id: 'user-1', trade_key: KEY, kind, value, set_by: 'you' });
    s.reviews.set(`user-1:${KEY}`, { user_id: 'user-1', trade_key: KEY, stop: 96, deleted: false, setup_grade: 'B', plan_followed: 'yes', note: 'fine' });
  });
  run('closeJournalTrade()');
  assert.match(list(), /<b>AAPL<\/b>[^]*?<span class="journal-tag journal-tag-done">reviewed<\/span>/);
  assert.match(list(), /data-arg="all">All <b>1<\/b><\/button>[^]*?To review <b>0<\/b>[^]*?Reviewed <b>1<\/b>[^]*?No setup <b>0<\/b>/, 'the chips count what each lets through');
  run("setJournalReviewFilter('todo')");
  assert.match(list(), /No trades match/, 'nothing left to review');
  run("setJournalReviewFilter('done')");
  assert.match(list(), /<b>AAPL<\/b>/, 'Reviewed lists it');
  run("setJournalReviewFilter('untagged')");
  assert.match(list(), /No trades match/, 'it has a setup');
  run("setJournalReviewFilter('all')");
  run(`openJournalTrade('${KEY}')`);
  await run(`setSetupGrade(${t}, 'A')`);
  const rv = rows('trade_reviews')[0];
  assert.deepEqual([rv.stop, rv.deleted, rv.setup_grade], [96, false, 'A'], 'saving the grade leaves your stop where it was');
});

test('+ New adds your own choice to the library and the trade; the choices sheet renames, hides and merges', async () => {
  const { run, state, t, body, rows, elements } = await page();
  run("startReviewItem('tag')");
  assert.match(body(), /id="reviewNewName"[^>]*data-enter="saveReviewItem"/);
  await run(`saveReviewItem(${t}, 'Earnings run')`);
  const mine = rows('library_items');
  assert.deepEqual(mine.map(r => [r.kind, r.name, r.default_key ?? null]), [['tag', 'Earnings run', null]]);
  assert.deepEqual(rows('trade_labels').map(r => [r.kind, r.value]), [['tag', `mine:${mine[0].id}`]], 'and it\'s on the trade');
  assert.match(body(), /aria-pressed="true" data-action="toggleReviewLabel" data-arg="tag" data-arg2="mine:[^"]+">Earnings run</);
  run("startReviewItem('tag')");
  await run(`saveReviewItem(${t}, 'earnings RUN')`);
  assert.equal(rows('library_items').length, 1, 'the same name again is the same item');

  run('openJournalLibrary()');
  assert.equal(state.openSheetName, 'journalLibrary');
  assert.match(elements.get('journalLibraryBody').innerHTML, /My setups[\s\S]*value="21 EMA bounce"[\s\S]*Bounce at 21 EMA[\s\S]*Levels[\s\S]*value="50 SMA"/);
  await run("renameLibraryItem('tactic', 'pivot30', '30m pivot')");
  await run("toggleLibraryHidden('tag', 'option_flow')");
  await run(`mergeLibraryItem('tag', 'mine:${mine[0].id}', 'option_flow')`);
  const lib = rows('library_items');
  assert.deepEqual(lib.find(r => r.default_key === 'pivot30')?.name, '30m pivot', 'a default is renamed by a row of yours');
  assert.equal(lib.find(r => r.default_key === 'option_flow')?.hidden, true);
  assert.equal(lib.find(r => r.id === mine[0].id)?.merged_into, 'option_flow');
  assert.match(body(), /30m pivot/, 'the review shows the new name');
});

test('editing a setup in Edit choices: its parts and name change, every trade with it groups the new way, a twin merges', async () => {
  const { run, t, body, rows, elements } = await page();
  const sheet = () => elements.get('journalLibraryBody').innerHTML;
  await run(`toggleSetup(${t}, 'ema8_bounce')`);
  assert.match(body(), /data-action="openJournalLibrary">Edit setups</, 'beside + New setup');
  run('openJournalLibrary()');
  assert.match(sheet(), /value="8 EMA bounce"[\s\S]*?data-action="editSetup" data-arg="ema8_bounce" aria-expanded="false">Edit</);
  run("editSetup('ema8_bounce')");
  assert.match(sheet(), /aria-pressed="true" data-action="setEditAction" data-arg="bounce">Bounce<[\s\S]*aria-pressed="true" data-action="toggleEditLevel" data-arg="ema8">8 EMA</, 'what it is made of now');
  run("setEditAction('undercut')");
  assert.match(sheet(), /id="setupEditName"[^>]*value="8 EMA undercut &amp; rally"/, 'a name that was its parts follows them');
  await run('saveSetupEdit()');
  const row = rows('library_items').find(r => r.default_key === 'ema8_bounce');
  assert.deepEqual([row.name, row.settings], ['8 EMA undercut & rally', { action: 'undercut', levels: ['ema8'] }], 'a default is edited by a row of yours');
  assert.equal(run("journalReview.labels[journalPageTrade().key][0].value"), 'ema8_bounce', 'the trade keeps its label');
  assert.equal(run('setupsOf(journalPageTrade())[0].kind.key'), 'action:undercut', 'and groups the new way');
  assert.match(body(), />8 EMA undercut &amp; rally</);

  // a typed name stays put; one made of the same things as another offers a merge, not a twin
  run("editSetup('ema8_bounce'); setupEditNameInput('Morning 8 reclaim'); toggleEditLevel('support')");
  assert.match(sheet(), /value="Morning 8 reclaim"/);
  run("toggleEditLevel('support'); toggleEditLevel('ema8'); toggleEditLevel('ema21')");
  assert.match(sheet(), /Same as <b>21 EMA undercut &amp; rally \/ reclaim &amp; fail<\/b>\.<\/span><button class="btn" data-action="mergeEditedSetup" data-arg="ema21_unr">Merge into it/);
  assert.doesNotMatch(sheet(), /data-action="saveSetupEdit"/);
  await run('saveSetupEdit()');
  assert.equal(rows('library_items').find(r => r.default_key === 'ema8_bounce').settings.levels[0], 'ema8', 'no twin saved');
  await run("mergeEditedSetup('ema21_unr')");
  assert.equal(rows('library_items').find(r => r.default_key === 'ema8_bounce').merged_into, 'ema21_unr');
  assert.equal(run('setupsOf(journalPageTrade())[0].name'), '21 EMA undercut & rally', 'the trade counts as the one kept');
  assert.doesNotMatch(sheet(), /data-action="editSetup" data-arg="ema8_bounce"/, 'merged away: nothing to edit');

  run("editSetup('sma50_bounce'); setEditAction('bounce'); cancelSetupEdit()");
  assert.doesNotMatch(sheet(), /jl-edit/, 'Cancel closes it');
  assert.equal(rows('library_items').some(r => r.default_key === 'sma50_bounce'), false, 'and saves nothing');
});

test('a review save Supabase refuses goes back; before the migration is pushed, the trade page still works', async () => {
  const one = await page();
  one.supabase.fail({ status: 500, message: 'nope' });
  await one.run(`setSetupGrade(${one.t}, 'B')`);
  assert.doesNotMatch(one.body(), /aria-pressed="true" data-action="setSetupGrade" data-arg="B"/, 'back as it was');
  assert.match(one.elements.get('errorBox').textContent, /Couldn't save the review: nope/);

  const two = await page(s => s.failTable('trade_labels'));
  assert.match(two.body(), /Reviews couldn(?:'|&#39;)t load: the database doesn(?:'|&#39;)t have the review tables yet: npx supabase db push/);
  assert.match(two.body(), /<dt>P&amp;L<\/dt>/, 'the rest of the page is there');
  assert.match(two.list(), /<b>AAPL<\/b>/, 'and so is the list');
});

test('what fits while building a setup, and links: https only, named for the flow sites', async () => {
  const { run } = await app();
  const lib = 'buildLibrary([])';
  const fits = draft => json(run, `${lib}.choices('setup').filter(i => setupFits(${lib}, i.key, ${JSON.stringify(draft)})).map(i => i.key)`);
  assert.deepEqual(fits({ action: 'undercut', levels: [] }), ['ema21_unr', 'sma50_unr'], 'what happened narrows to that action');
  assert.deepEqual(fits({ action: 'undercut', levels: ['sma50'] }), ['sma50_unr'], 'and a level to the ones at it');
  assert.deepEqual(fits({ action: 'undercut', levels: ['sma50', 'support'] }), [], 'nothing at both yet');
  assert.deepEqual(fits({ action: '', levels: ['ema21'] }), ['ema21_bounce', 'ema21_unr'], 'a level alone: everything at it (the 21 EMA rejection is the bounce now)');
  assert.deepEqual(fits({ pattern: 'earnings_gap' }), ['earnings_gap']);
  assert.equal(run("cleanLink(' https://unusualwhales.com/flow/ticker_flows?ticker_symbol=NVDA ')"), 'https://unusualwhales.com/flow/ticker_flows?ticker_symbol=NVDA');
  assert.equal(run("cleanLink('http://bullflow.io/x')"), '', 'https only');
  assert.equal(run("cleanLink('javascript:alert(1)')"), '');
  assert.equal(run("cleanLink('not a link')"), '');
  assert.equal(run("linkLabel('https://www.unusualwhales.com/flow/x')"), 'Unusual Whales');
  assert.equal(run("linkLabel('https://app.bullflow.io/flow?s=NVDA')"), 'Bullflow');
  assert.equal(run("linkLabel('https://x.com/someone/status/1')"), 'x.com');
});

test('what a setup adds up under: its action as the kind, then each level; a pattern is its own kind; merges followed', async () => {
  const { run } = await app();
  const groups = (rows, key) => json(run, `setupGroups(buildLibrary(${JSON.stringify(rows)}), '${key}')`);
  assert.deepEqual(groups([], 'sma50_unr'), { kind: { key: 'action:undercut', name: 'Undercut & rally', action: true }, levels: [{ key: 'level:sma50', name: '50 SMA' }] });
  assert.deepEqual(groups([], 'base_breakout'), { kind: { key: 'pat:base_breakout', name: 'Base breakout', action: false }, levels: [] });
  assert.deepEqual(groups([], 'sma50+bounce'), { kind: { key: 'action:bounce', name: 'Bounce', action: true }, levels: [{ key: 'level:sma50', name: '50 SMA' }] }, 'an older value written as its parts');
  assert.deepEqual(groups([], 'sma50'), { kind: null, levels: [{ key: 'level:sma50', name: '50 SMA' }] }, 'a level alone has no kind');
  const own = [{ id: 'b1', kind: 'setup', name: 'AVWAP + 21 EMA bounce', settings: { action: 'bounce', levels: ['avwap_ath', 'ema21'] } }];
  assert.deepEqual(groups(own, 'mine:b1').kind.key, 'action:bounce', 'one of My setups at two levels: still a bounce');
  assert.deepEqual(groups(own, 'mine:b1').levels.map(l => l.name), ['AVWAP from ATH', '21 EMA']);
  const merged = [{ id: 'm1', kind: 'level', default_key: 'support', name: 'Support', merged_into: 'sma50' }];
  assert.deepEqual(groups([...merged, { id: 'b2', kind: 'setup', name: 'x', settings: { action: 'bounce', levels: ['support', 'sma50'] } }], 'mine:b2').levels, [{ key: 'level:sma50', name: '50 SMA' }], 'a merged level counts as the one kept, once');
});

test('+ New setup narrows My setups as you pick and offers the one you have; Option flow takes links', async () => {
  const { run, t, body, rows, elements } = await page();
  run('startSetupDraft()');
  await run(`setDraftAction(${t}, 'undercut')`);
  assert.match(body(), /<span class="jr-fit">My setups that fit:<\/span>/);
  assert.match(body(), /data-arg="ema21_unr"[^>]*>21 EMA undercut &amp; rally/);
  assert.doesNotMatch(body(), /data-action="toggleSetup" data-arg="ema21_bounce"/, 'bounces step aside');
  const levels = [...body().matchAll(/data-action="toggleDraftLevel" data-arg="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(levels, ['ema8', 'ema21', 'sma50', 'sma100', 'sma200', 'support', 'resistance', 'avwap_ath', 'avwap_atl', 'avwap_earnings'], 'moving averages by length first');
  run('startReviewItem("action")');
  assert.match(body(), /id="reviewNewName"[^>]*\/><input type="text" id="reviewNewShort" maxlength="80" placeholder="On a short"/, 'a new action asks for its words on a short');
  run('state.reviewNewShort = "Shakeout fail"');
  await run(`saveReviewItem(${t}, 'Shakeout')`);
  const shake = rows('library_items').find(r => r.kind === 'action');
  assert.deepEqual([shake.name, shake.settings], ['Shakeout', { short: 'Shakeout fail' }]);
  assert.equal(run('state.setupDraft.action'), `mine:${shake.id}`, 'and it is what happened in the setup being made');
  run('startReviewItem("pattern")');
  await run(`saveReviewItem(${t}, 'Cup breakout')`);
  assert.equal(run(`reviewLibrary().nameOf('pattern', 'mine:${rows('library_items').find(r => r.kind === 'pattern').id}', 'short')`), 'Cup breakdown', 'left blank: a breakout is a breakdown');
  run('cancelSetupDraft()');

  assert.doesNotMatch(body(), /id="reviewLinkInput"/, 'no link box until Option flow is on');
  await run(`toggleReviewLabel(${t}, 'tag', 'option_flow')`);
  assert.match(body(), /Option flow links<\/span>\s*<input type="url" id="reviewLinkInput"[^>]*placeholder="Paste an Unusual Whales or Bullflow link"/);
  await run(`addReviewLink(${t}, 'option_flow', 'https://unusualwhales.com/flow/ticker_flows?ticker_symbol=AAPL')`);
  await run(`addReviewLink(${t}, 'option_flow', 'https://app.bullflow.io/flow?s=AAPL')`);
  await run(`addReviewLink(${t}, 'option_flow', 'https://app.bullflow.io/flow?s=AAPL')`);
  const tag = rows('trade_labels').find(r => r.kind === 'tag');
  assert.deepEqual(tag.links, ['https://unusualwhales.com/flow/ticker_flows?ticker_symbol=AAPL', 'https://app.bullflow.io/flow?s=AAPL'], 'kept on the tag, the same one once');
  assert.match(body(), /<a href="https:\/\/unusualwhales\.com\/flow\/ticker_flows\?ticker_symbol=AAPL" target="_blank" rel="noopener noreferrer"[^>]*>Unusual Whales ↗<\/a>/);
  assert.match(body(), />Bullflow ↗<\/a>/);
  run(`addReviewLink(${t}, 'option_flow', 'javascript:alert(1)')`);
  assert.match(elements.get('errorBox').textContent, /Paste a link that starts with https:\/\//);
  // a row written around the app: its bad link is never drawn, and the good ones keep their places
  run(`journalReview.labels[${t}.key].find(l => l.kind === 'tag').links.splice(1, 0, 'javascript:alert(1)'); openJournalTrade(${t}.key)`);
  assert.doesNotMatch(body(), /javascript:/);
  assert.match(body(), /data-action="removeReviewLink" data-arg="option_flow" data-arg2="2"/, 'the Bullflow link is still the third');
  run(`journalReview.labels[${t}.key].find(l => l.kind === 'tag').links.splice(1, 1); openJournalTrade(${t}.key)`);
  await run(`removeReviewLink(${t}, 'option_flow', '0')`);
  assert.deepEqual(rows('trade_labels').find(r => r.kind === 'tag').links, ['https://app.bullflow.io/flow?s=AAPL']);
});

test('the Journal shows each trade\'s setups, and a setup filter narrows the list, calendar and stats', async () => {
  const { run, t, list, rows, body } = await page();
  await run(`toggleSetup(${t}, 'ema21_bounce')`);
  await run(`toggleSetup(${t}, 'base_breakout')`);
  run('closeJournalTrade()');
  assert.match(list(), /<td class="journal-setups"><span class="journal-setup" title="21 EMA bounce"><span class="journal-setup-act">Bounce<\/span><span class="journal-setup-lvl">21 EMA<\/span><\/span><span class="journal-setup" title="Base breakout"><span class="journal-setup-act">Base breakout<\/span><\/span><\/td>/, 'both in their parts, the action first, named in the title');
  run(`openJournalTrade('${KEY}')`);
  assert.match(body(), /<div class="jr-parts"><span>21 EMA bounce: Action <b>Bounce<\/b> · Level <b>21 EMA<\/b><\/span><span>Base breakout: Pattern <b>Base breakout<\/b><\/span><\/div>/, 'the trade page spells out the parts');
  run('closeJournalTrade()');
  assert.match(list(), /<select id="journalSetupFilter" class="journal-setup-filter" data-change="setJournalSetupFilter" aria-label="Filter by setup">\s*<option value="">All setups<\/option><option value="base_breakout">Base breakout \/ breakdown \(1\)<\/option><option value="action:bounce">Bounce \/ rejection \(1\)<\/option><option value="ema21_bounce">&nbsp;&nbsp;&nbsp;21 EMA bounce \/ rejection \(1\)<\/option><optgroup label="Any setup at"><option value="level:ema21">21 EMA \(1\)<\/option><\/optgroup>/, 'by kind, its setups under it, then by level; most used first, then by name');
  run("setJournalSetupFilter('ema21_flag')");
  assert.match(list(), /No trades match/, 'a setup no trade has: nothing');
  run("setJournalSetupFilter('ema21_bounce')");
  assert.match(list(), /<b>AAPL<\/b>/, 'the trade with that setup');
  assert.match(list(), /class="journal-setup-filter active"/);
  run("setJournalTab('stats')");
  assert.match(list(), /<dt>Net P&amp;L<\/dt><dd class="journal-sell">−\$504\.00/, 'the stats for that setup');
  run("setJournalSetupFilter(''); setJournalTab('trades')");
  assert.equal(rows('trade_labels').filter(r => r.kind === 'setup').length, 2);
});

test('setups add up by kind, the action first and the level second: every bounce together, any setup at the 21 EMA', async () => {
  const leg = (id, instruction, time, price) => ({ kind: 'order', record_id: String(id), account: '6789', entered_at: time.replace('+0000', 'Z'), user_id: 'user-1', data: {
    orderId: id, enteredTime: time, status: 'FILLED',
    orderLegCollection: [{ legId: 1, instruction, quantity: 10, instrument: { symbol: 'MSFT', assetType: 'EQUITY' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: id * 10, executionLegs: [{ legId: 1, quantity: 10, price, time }] }],
  } });
  const { run, t, list } = await page(sb => {
    for (const r of [leg(601, 'BUY', '2026-10-05T14:00:00+0000', 400), leg(602, 'SELL', '2026-10-05T15:00:00+0000', 401)]) sb.table.set(`user-1:order:${r.record_id}`, r);
  });
  await run(`toggleSetup(${t}, 'ema21_bounce')`);
  await run(`toggleSetup(${t}, 'sma50_bounce')`);
  run(`openJournalTrade('6789|MSFT|long|2026-10-05T14:00:00.000Z')`);
  await run(`toggleSetup(${t}, 'ema21_unr')`);
  run('closeJournalTrade()');
  assert.match(list(), /<option value="action:bounce">Bounce \/ rejection \(1\)<\/option><option value="ema21_bounce">&nbsp;&nbsp;&nbsp;21 EMA bounce \/ rejection \(1\)<\/option><option value="sma50_bounce">&nbsp;&nbsp;&nbsp;50 SMA bounce \/ rejection \(1\)<\/option><option value="action:undercut">Undercut &amp; rally \/ reclaim &amp; fail \(1\)<\/option><option value="ema21_unr">&nbsp;&nbsp;&nbsp;21 EMA undercut &amp; rally \/ reclaim &amp; fail \(1\)<\/option>/, 'two bounces on one trade: Bounce counts it once');
  assert.match(list(), /<optgroup label="Any setup at"><option value="level:ema21">21 EMA \(2\)<\/option><option value="level:sma50">50 SMA \(1\)<\/option><\/optgroup>/);
  run("setJournalSetupFilter('action:bounce')");
  assert.match(list(), /<b>AAPL<\/b>/);
  assert.doesNotMatch(list(), /<b>MSFT<\/b>/, 'the undercut is not a bounce');
  run("setJournalSetupFilter('level:ema21')");
  assert.match(list(), /<b>AAPL<\/b>[\s\S]*<b>MSFT<\/b>|<b>MSFT<\/b>[\s\S]*<b>AAPL<\/b>/, 'both were at the 21 EMA');
  run("setJournalSetupFilter(''); setJournalTab('setups')");
  const table = title => list().split(`<div class="section-title js-sub">${title}</div>`)[1]?.split('</table>')[0] || '';
  assert.match(table('By setup kind'), /<th scope="col">Kind<\/th>[\s\S]*<b>Undercut &amp; rally \/ reclaim &amp; fail<\/b>[\s\S]*<td>1<\/td><td class="journal-buy">\+\$10\.00<\/td>[\s\S]*<b>Bounce \/ rejection<\/b>[\s\S]*<td>1<\/td><td class="journal-sell">−\$504\.00<\/td>/, 'one trade each; ties go to the better net');
  assert.match(table('By level'), /<b>21 EMA<\/b>[\s\S]*<td>2<\/td><td class="journal-sell">−\$494\.00<\/td>[\s\S]*<b>50 SMA<\/b>/);
  assert.doesNotMatch(list(), /Not graded/, 'a trade without a grade is just not in By setup grade');
});

test('phone cards show each setup in its parts too', async () => {
  const supabase = fakeRecords([{ kind: 'order', record_id: '501', account: '6789', entered_at: '2026-10-01T14:30:00Z', data: ENTRY }]);
  const a = await app({ width: 390, supabase, session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  a.run(`openJournalTrade('${KEY}')`);
  await settle();
  await a.run("toggleSetup(journalPageTrade(), 'sma50_unr')");
  a.run('closeJournalTrade()');
  assert.match(a.elements.get('journalSection').innerHTML, /<div class="jtc-tags"><span class="journal-setup" title="50 SMA undercut &amp; rally"><span class="journal-setup-act">Undercut &amp; rally<\/span><span class="journal-setup-lvl">50 SMA<\/span><\/span><\/div>/);
});

test('a setup filter on the Stats periods: Day and ‹ › only see the trades with that setup', async () => {
  const leg = (id, instruction, time, price) => ({ kind: 'order', record_id: String(id), account: '6789', entered_at: time.replace('+0000', 'Z'), user_id: 'user-1', data: {
    orderId: id, enteredTime: time, status: 'FILLED',
    orderLegCollection: [{ legId: 1, instruction, quantity: 10, instrument: { symbol: 'MSFT', assetType: 'EQUITY' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: id * 10, executionLegs: [{ legId: 1, quantity: 10, price, time }] }],
  } });
  const { run, t, list } = await page(sb => {
    for (const r of [leg(601, 'BUY', '2026-10-05T14:00:00+0000', 400), leg(602, 'SELL', '2026-10-05T15:00:00+0000', 401)]) sb.table.set(`user-1:order:${r.record_id}`, r);
  });
  await run(`toggleSetup(${t}, 'ema21_bounce')`);
  run('closeJournalTrade()');
  run("setJournalTab('stats'); setJournalPeriod('day')");
  assert.match(list(), /class="jc-title">Mon, Oct 5, 2026</, 'no filter: the newest close, MSFT\'s');
  run("setJournalPeriod('all'); setJournalSetupFilter('ema21_bounce'); setJournalPeriod('day')");
  assert.match(list(), /class="jc-title">Fri, Oct 2, 2026</, 'the AAPL trade with the setup, not the MSFT day');
  assert.match(list(), /aria-label="Earlier day with trades" disabled>[\s\S]*aria-label="Later day with trades" disabled>/, 'nothing else carries the setup');
});

test('setups read by side: one setup is a bounce on a long and a rejection on a short, a breakout and a breakdown', async () => {
  const { run } = await app();
  const lib = 'buildLibrary([])';
  const name = (key, side) => run(`${lib}.nameOf('setup', '${key}', ${side ? `'${side}'` : 'undefined'})`);
  assert.equal(name('ema21_bounce'), '21 EMA bounce', 'no side is a long');
  assert.equal(name('ema21_bounce', 'short'), '21 EMA rejection');
  assert.equal(name('ema21_bounce', 'both'), '21 EMA bounce / rejection', 'both share their first words');
  assert.equal(name('sma50_unr', 'short'), '50 SMA reclaim & fail');
  assert.equal(name('base_breakout', 'short'), 'Base breakdown');
  assert.equal(name('flag_breakout', 'short'), 'Pennant or flag breakdown', "the starting flag setup reads its pattern's short name");
  assert.equal(name('earnings_gap', 'both'), 'Earnings gap', 'the same both ways');
  assert.equal(name('support+bounce', 'short'), 'Resistance rejection', 'a long off support is a short at resistance');
  assert.equal(name('resistance+bounce', 'short'), 'Support rejection');
  assert.equal(name('support+bounce', 'both'), 'Support bounce / Resistance rejection');
  assert.equal(run(`${lib}.partsWords({ action: 'bounce', levels: ['support', 'ema21'] }, 'short')`), 'Rejection at Resistance + 21 EMA', 'moving averages read the same');
  assert.equal(run(`setupTwin(${lib}, 'sma50_bounce')`), null);
  assert.equal(run(`${lib}.resolve('setup', 'ema21_rejection')`), 'ema21_bounce', 'the starting 21 EMA rejection is the 21 EMA bounce on a short');
  assert.equal(run(`${lib}.resolve('action', 'rejection')`), 'bounce');
  assert.equal(name('ema21+rejection', 'long'), '21 EMA bounce', 'an old value written as its parts too');
  assert.equal(run("bothWords('Pennant or flag breakout', 'Pennant or flag breakdown')"), 'Pennant or flag breakout / breakdown');
  assert.equal(run("bothWords('Wedge pop', 'Wedge pop')"), 'Wedge pop');
  assert.deepEqual(json(run, "['long', 'short', 'neutral', undefined].map(b => tradeSide({ bias: b }))"), ['long', 'short', 'both', 'long']);
  assert.deepEqual(json(run, `setupGroups(${lib}, 'ema21_bounce', 'short')`), { kind: { key: 'action:bounce', name: 'Rejection', action: true }, levels: [{ key: 'level:ema21', name: '21 EMA' }] }, 'its kind reads by side, the key stays');

  // your own: a short word in settings, a breakdown pattern merged into the flag, mirrored setups found as twins
  const rows = [
    { id: 'p1', kind: 'pattern', name: 'Wedge pop', settings: { short: 'Wedge drop' } },
    { id: 'p2', kind: 'pattern', name: 'Pennant or flag breakdown', merged_into: 'flag_breakout' },
    { id: 's1', kind: 'setup', name: 'Wedge pop', settings: { pattern: 'mine:p1' } },
    { id: 's2', kind: 'setup', name: 'Pennant or flag breakdown', settings: { pattern: 'mine:p2' } },
    { id: 's3', kind: 'setup', name: '21 EMA rejection', settings: { action: 'rejection', levels: ['ema21'] } },
    { id: 's4', kind: 'setup', name: 'HVE candle', settings: { pattern: 'mine:p1' }, },
    { id: 'u1', kind: 'action', name: 'bounce', default_key: 'bounce', settings: { short: '' } },
  ];
  const mine = `buildLibrary(${JSON.stringify(rows)})`;
  assert.equal(run(`${mine}.nameOf('setup', 'mine:s1', 'short')`), 'Wedge drop', 'a pattern of yours with its short word');
  assert.equal(run(`${mine}.nameOf('setup', 'mine:s2', 'long')`), 'Pennant or flag breakout', 'the breakdown setup reads by side once its pattern is the flag');
  assert.equal(run(`${mine}.nameOf('setup', 'mine:s4', 'short')`), 'HVE candle', 'a typed name without a short one reads the same');
  assert.equal(run(`${mine}.nameOf('setup', 'mine:s3', 'short')`), '21 EMA bounce', 'a short word cleared: the same both ways');
  assert.equal(run(`setupTwin(${mine}, 'mine:s2')?.key`), 'flag_breakout', 'the breakdown setup is the same as the flag breakout');
  assert.equal(run(`setupTwin(${mine}, 'mine:s3')?.key`), 'ema21_bounce', 'and your 21 EMA rejection the 21 EMA bounce');
  assert.equal(run(`setupTwin(${mine}, 'ema8_bounce')`), null);
});

test('the trade page, the list and the filter read setups by side; the library takes short words and merges twins', async () => {
  const leg = (id, instruction, time, price) => ({ kind: 'order', record_id: String(id), account: '6789', entered_at: time.replace('+0000', 'Z'), user_id: 'user-1', data: {
    orderId: id, enteredTime: time, status: 'FILLED',
    orderLegCollection: [{ legId: 1, instruction, quantity: 10, instrument: { symbol: 'MSFT', assetType: 'EQUITY' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: id * 10, executionLegs: [{ legId: 1, quantity: 10, price, time }] }],
  } });
  const { run, t, list, body, rows } = await page(sb => {
    for (const r of [leg(601, 'SELL_SHORT', '2026-10-05T14:00:00+0000', 400), leg(602, 'BUY_TO_COVER', '2026-10-05T15:00:00+0000', 399)]) sb.table.set(`user-1:order:${r.record_id}`, r);
  });
  run(`closeJournalTrade(); openJournalTrade('6789|MSFT|short|2026-10-05T14:00:00.000Z')`);
  assert.equal(run(`${t}.bias`), 'short');
  await run(`toggleSetup(${t}, 'ema21_bounce')`);
  assert.match(body(), /data-action="toggleSetup" data-arg="ema21_bounce" title="Rejection at 21 EMA">21 EMA rejection<\/button>/, 'a short reads its rejection');
  assert.match(body(), /Action <b>Rejection<\/b> · Level <b>21 EMA<\/b>/);
  run('startSetupDraft()');
  assert.match(body(), /data-action="setDraftAction" data-arg="bounce">Rejection<\/button>/, 'the builder speaks the short side too');
  assert.match(body(), /data-action="setDraftPattern" data-arg="base_breakout">Base breakdown<\/button>/);
  assert.match(body(), /data-action="toggleDraftLevel" data-arg="support">Resistance<\/button>/, 'levels read the short side too');
  assert.doesNotMatch(body(), /data-arg="rejection"/, 'no separate rejection to pick');
  run('cancelSetupDraft(); closeJournalTrade()');
  assert.match(list(), /<span class="journal-setup" title="21 EMA rejection"><span class="journal-setup-act">Rejection<\/span>/, "the list in the trade's words");
  assert.match(list(), /<option value="action:bounce">Bounce \/ rejection \(1\)<\/option>/, 'every side: both words');
  run("setJournalSide('short')");
  assert.match(list(), /<option value="action:bounce">Rejection \(1\)<\/option><option value="ema21_bounce">&nbsp;&nbsp;&nbsp;21 EMA rejection \(1\)<\/option>/, 'shorts only: the short words');
  run("setJournalSide('all')");

  run('openJournalLibrary()');
  const sheet = () => run("document.getElementById('journalLibraryBody').innerHTML");
  assert.match(sheet(), /value="rejection" placeholder="On a short: same" aria-label="bounce on a short" data-change="setLibraryShort" data-arg="action" data-arg2="bounce"/, 'an action takes its short word');
  assert.match(sheet(), /value="Pennant or flag breakdown" placeholder="On a short: same" aria-label="Pennant or flag breakout on a short" data-change="setLibraryShort" data-arg="pattern" data-arg2="flag_breakout"/);
  assert.match(sheet(), /value="Resistance" placeholder="On a short: same" aria-label="Support on a short" data-change="setLibraryShort" data-arg="level" data-arg2="support"/, 'a level takes its short word');
  assert.match(sheet(), /value="" placeholder="On a short: same" aria-label="50 SMA on a short"/);
  assert.doesNotMatch(sheet(), /data-arg="level" data-arg2="resistance" data-into/, 'support and resistance are mirrors, not a twin to merge');
  assert.doesNotMatch(sheet(), /data-arg2="rejection"|data-arg2="ema21_rejection"/, 'the built-in rejection merge is not listed');
  await run("setLibraryShort('pattern', 'base_breakout', 'Base failure')");
  assert.equal(rows('library_items').find(r => r.default_key === 'base_breakout').settings.short, 'Base failure');
  assert.equal(run("reviewLibrary().nameOf('setup', 'base_breakout', 'short')"), 'Base failure', 'the setup follows its pattern');
  await run("saveReviewItem(journalPageTrade(), '')");
  run(`journalReview.library.push({ id: 's9', kind: 'setup', name: '50 SMA rejection', settings: { action: 'rejection', levels: ['sma50'] } }); renderJournalLibrary()`);
  assert.match(sheet(), /Same setup as <b>50 SMA bounce \/ rejection<\/b> <button class="pos-link" data-action="mergeTwin" data-arg="setup" data-arg2="mine:s9" data-into="sma50_bounce">Merge into it<\/button>/, 'a mirrored pair offers the merge');
  run(`journalReview.library.push({ id: 'p9', kind: 'pattern', name: 'Pennant or flag breakdown' }); renderJournalLibrary()`);
  assert.match(sheet(), /The short side of <b>Pennant or flag breakout \/ breakdown<\/b> <button class="pos-link" data-action="mergeTwin" data-arg="pattern" data-arg2="mine:p9" data-into="flag_breakout">/, 'a pattern named for the short side of another');
  await run("mergeTwin('setup', 'mine:s9', 'sma50_bounce')");
  assert.equal(rows('library_items').find(r => r.id === 's9').merged_into, 'sma50_bounce');
  assert.doesNotMatch(sheet(), /data-arg2="mine:s9" data-into/, 'merged: no more twin');
});

test('a trade labelled with a setup merged away shows the kept one once', async () => {
  const { run, t, body } = await page();
  run("journalReview.library.push({ id: 's9', kind: 'setup', name: '9 EMA rejection', settings: { action: 'rejection', levels: ['ema8'] }, merged_into: 'ema8_bounce' })");
  await run(`toggleSetup(${t}, 'mine:s9')`);
  assert.equal((body().match(/>8 EMA bounce<\/button>/g) || []).length, 1, 'lit once, not offered again');
  assert.match(body(), /class="filter-btn active" aria-pressed="true" data-action="toggleSetup" data-arg="mine:s9"/, 'tapping it takes the label it has off');
});
