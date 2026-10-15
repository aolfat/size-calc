// Run with: node --test
// Reviewing a trade (journal step 3, slice 1): the library over the defaults (your items, renames, hides, merges), setup
// keys, what makes a trade reviewed, and the Review section on the trade page: market for the day or the trade, the
// labels, both grades, the note, + New, the reviewed mark and the To review filter, the choices sheet, and failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const json = (run, code) => JSON.parse(run(`JSON.stringify(${code})`));

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

test('reviewed means market, sector, a setup, a tactic, both grades and a note; the trade\'s own market wins over the day\'s', async () => {
  const { run } = await app();
  const none = json(run, 'reviewState(null, [], null)');
  assert.deepEqual(none, { market: null, marketOwn: false, missing: ['market', 'sector', 'setup', 'tactic', 'setup grade', 'plan followed', 'note'], reviewed: false, started: false });
  assert.equal(run(`missingWords(${JSON.stringify(none.missing)})`), 'market, sector, setup and 4 more');
  const labels = [{ kind: 'sector', value: 'strong' }, { kind: 'setup', value: 'sma50+bounce' }, { kind: 'tactic', value: 'pivot30' }];
  const done = json(run, `reviewState({ setup_grade: 'A', plan_followed: 'partly', note: 'added early' }, ${JSON.stringify(labels)}, 'bullish')`);
  assert.deepEqual([done.reviewed, done.market, done.marketOwn], [true, 'bullish', false]);
  const own = json(run, `reviewState({ market: 'choppy', setup_grade: 'A', plan_followed: 'yes', note: '  ' }, ${JSON.stringify(labels)}, 'bullish')`);
  assert.deepEqual([own.market, own.marketOwn, own.missing], ['choppy', true, ['note']], 'a blank note isn\'t a note');
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

test('the Review section: market for the day or this trade, sector, a setup built from a level and an action, tactic, tags, grades, the note', async () => {
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
  run("pickSetupLevel('sma50')");
  assert.match(body(), /<span class="jr-step">50 SMA \+<\/span>/, 'the level waits for its action');
  await run(`addSetup(${t}, { level: state.reviewLevel, action: 'bounce' })`.replace('state.reviewLevel', "'sma50'"));
  await run(`addSetup(${t}, { pattern: 'earnings_gap' })`);
  assert.deepEqual(rows('trade_labels').filter(r => r.kind === 'setup').map(r => r.value), ['sma50+bounce', 'pattern:earnings_gap']);
  assert.match(body(), /<span class="jr-setup">50 SMA bounce<button class="pos-link" data-action="removeSetup" data-arg="sma50\+bounce"/);
  await run(`removeSetup(${t}, 'pattern:earnings_gap')`);
  assert.deepEqual(rows('trade_labels').filter(r => r.kind === 'setup').map(r => r.value), ['sma50+bounce'], 'removed');
  await run(`toggleReviewLabel(${t}, 'tactic', 'pivot30')`);
  await run(`toggleReviewLabel(${t}, 'tag', 'option_flow')`);
  await run(`toggleReviewLabel(${t}, 'mistake', 'chased')`);
  await run(`setSetupGrade(${t}, 'A')`);
  await run(`setPlanFollowed(${t}, 'partly')`);
  assert.match(body(), /To review: missing note/);
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

test('the list: a reviewed mark, the To review filter; your stop and delete stay apart from the review', async () => {
  const { run, t, list, rows } = await page(s => {
    s.tables.journal_days.set('user-1:2026-10-01', { user_id: 'user-1', day: '2026-10-01', market: 'bullish' });
    for (const [kind, value] of [['sector', 'strong'], ['setup', 'sma50'], ['tactic', 'pivot15']]) s.tables.trade_labels.set(`user-1:${KEY}:${kind}:${value}`, { user_id: 'user-1', trade_key: KEY, kind, value, set_by: 'you' });
    s.reviews.set(`user-1:${KEY}`, { user_id: 'user-1', trade_key: KEY, stop: 96, deleted: false, setup_grade: 'B', plan_followed: 'yes', note: 'fine' });
  });
  run('closeJournalTrade()');
  assert.match(list(), /<b>AAPL<\/b>[^]*?<span class="journal-tag journal-tag-done">reviewed<\/span>/);
  run("setJournalReviewFilter('todo')");
  assert.match(list(), /No trades match/, 'nothing left to review');
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
  assert.match(elements.get('journalLibraryBody').innerHTML, /Setup levels[\s\S]*value="50 SMA"/);
  await run("renameLibraryItem('tactic', 'pivot30', '30m pivot')");
  await run("toggleLibraryHidden('tag', 'option_flow')");
  await run(`mergeLibraryItem('tag', 'mine:${mine[0].id}', 'option_flow')`);
  const lib = rows('library_items');
  assert.deepEqual(lib.find(r => r.default_key === 'pivot30')?.name, '30m pivot', 'a default is renamed by a row of yours');
  assert.equal(lib.find(r => r.default_key === 'option_flow')?.hidden, true);
  assert.equal(lib.find(r => r.id === mine[0].id)?.merged_into, 'option_flow');
  assert.match(body(), /30m pivot/, 'the review shows the new name');
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
