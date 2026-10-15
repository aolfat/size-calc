// Run with: node --test
// Reviewing a trade (journal step 3, slice 1): the library over the defaults (your items, renames, hides, merges), setup
// keys, what makes a trade reviewed, and the Review section on the trade page: market for the day or the trade, the
// labels, both grades, the note, + New, the reviewed mark and the To review filter, the choices sheet, and failures.
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

test('the Review section: market for the day or this trade, sector, My setups (one tap, or + New setup), tactic, tags, grades, the note', async () => {
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
  assert.match(body(), /What happened\?[\s\S]*At what\?[\s\S]*Or a pattern[\s\S]*data-action="saveSetupDraft" disabled/, 'not ready until it has an action and a level');
  run("setDraftAction('undercut'); toggleDraftLevel('sma50'); toggleDraftLevel('support')");
  assert.match(body(), /placeholder="50 SMA \+ Support undercut &amp; rally"/, 'named for you');
  run("setupDraftNameInput('50 SMA/support UnR')");
  await run(`saveSetupDraft(${t})`);
  const mine = rows('library_items').find(r => r.kind === 'setup');
  assert.deepEqual([mine.name, mine.settings], ['50 SMA/support UnR', { action: 'undercut', levels: ['sma50', 'support'] }], 'saved to My setups with what it is made of');
  assert.deepEqual(rows('trade_labels').filter(r => r.kind === 'setup').map(r => r.value), ['ema21_bounce', `mine:${mine.id}`], 'and on the trade');
  assert.equal(state.setupDraft, null);
  run("startSetupDraft(); setDraftAction('undercut'); toggleDraftLevel('support'); toggleDraftLevel('sma50')");
  await run(`saveSetupDraft(${t})`);
  assert.equal(rows('library_items').filter(r => r.kind === 'setup').length, 1, 'made of the same things: the same setup, not a second one');
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
  assert.deepEqual(fits({ action: '', levels: ['ema21'] }), ['ema21_bounce', 'ema21_unr', 'ema21_rejection'], 'a level alone: everything at it');
  assert.deepEqual(fits({ pattern: 'earnings_gap' }), ['earnings_gap']);
  assert.equal(run("cleanLink(' https://unusualwhales.com/flow/ticker_flows?ticker_symbol=NVDA ')"), 'https://unusualwhales.com/flow/ticker_flows?ticker_symbol=NVDA');
  assert.equal(run("cleanLink('http://bullflow.io/x')"), '', 'https only');
  assert.equal(run("cleanLink('javascript:alert(1)')"), '');
  assert.equal(run("cleanLink('not a link')"), '');
  assert.equal(run("linkLabel('https://www.unusualwhales.com/flow/x')"), 'Unusual Whales');
  assert.equal(run("linkLabel('https://app.bullflow.io/flow?s=NVDA')"), 'Bullflow');
  assert.equal(run("linkLabel('https://x.com/someone/status/1')"), 'x.com');
});

test('+ New setup narrows My setups as you pick and offers the one you have; Option flow takes links', async () => {
  const { run, t, body, rows, elements } = await page();
  run('startSetupDraft()');
  run("setDraftAction('undercut')");
  assert.match(body(), /<span class="jr-fit">My setups that fit:<\/span>/);
  assert.match(body(), /data-arg="ema21_unr"[^>]*>21 EMA undercut &amp; rally/);
  assert.doesNotMatch(body(), /data-action="toggleSetup" data-arg="ema21_bounce"/, 'bounces step aside');
  run("toggleDraftLevel('sma50')");
  assert.match(body(), /Already in My setups: <button class="filter-btn" aria-pressed="false" data-action="useSetupDraftMatch" data-arg="sma50_unr">50 SMA undercut &amp; rally<\/button> tap it to add/);
  assert.doesNotMatch(body(), /data-action="saveSetupDraft"/, 'no Save: you have it');
  await run(`useSetupDraftMatch(${t}, 'sma50_unr')`);
  assert.deepEqual(rows('trade_labels').map(r => [r.kind, r.value]), [['setup', 'sma50_unr']]);
  assert.equal(rows('library_items').length, 0, 'nothing new made');
  run("startSetupDraft(); setDraftAction('undercut'); toggleDraftLevel('sma50')");
  assert.match(body(), /Already on this trade: <b>50 SMA undercut &amp; rally<\/b>/);
  run("toggleDraftLevel('support')");
  assert.match(body(), /None of My setups fit yet\.[\s\S]*data-action="saveSetupDraft">Save to my setups and add/, 'nothing at both: Save makes it');
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
  await run(`removeReviewLink(${t}, 'option_flow', '0')`);
  assert.deepEqual(rows('trade_labels').find(r => r.kind === 'tag').links, ['https://app.bullflow.io/flow?s=AAPL']);
});

test('the Journal shows each trade\'s setups, and a setup filter narrows the list, calendar and stats', async () => {
  const { run, t, list, rows } = await page();
  await run(`toggleSetup(${t}, 'ema21_bounce')`);
  await run(`toggleSetup(${t}, 'base_breakout')`);
  run('closeJournalTrade()');
  assert.match(list(), /<td class="journal-setups"><span class="journal-setup">21 EMA bounce<\/span><span class="journal-setup">Base breakout<\/span><\/td>/, 'both, by name');
  assert.match(list(), /<select id="journalSetupFilter" class="journal-setup-filter" data-change="setJournalSetupFilter" aria-label="Filter by setup">\s*<option value="">All setups<\/option><option value="ema21_bounce">21 EMA bounce \(1\)<\/option><option value="base_breakout">Base breakout \(1\)<\/option>/, 'most used first, then by name');
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
