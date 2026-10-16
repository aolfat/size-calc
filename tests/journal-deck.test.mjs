// Run with: node --test
// The review deck (journal step 3, slice 2): the pass each trade needs (opening while it's open, the grade and note once
// it closes), the queue (newest first, from the review-from day, no other filters), Review N trades, the Journal's line and tab count, the deck bar
// (Back, Next, Save for the weekly review, Done), P&L hidden until you grade, the end screen, the keys, and failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const json = (run, code) => JSON.parse(run(`JSON.stringify(${code})`));
const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

/** a filled buy, with a filled sell later when `out` is given */
function order(id, symbol, at, price, out) {
  const leg = instruction => [{ legId: 1, instruction, quantity: 100, instrument: { symbol, assetType: 'EQUITY' } }];
  const fill = (aid, p, time) => [{ activityType: 'EXECUTION', activityId: aid, executionLegs: [{ legId: 1, quantity: 100, price: p, time }] }];
  return {
    orderId: id, enteredTime: at.replace('Z', '+0000'), status: 'FILLED', orderLegCollection: leg('BUY'), orderActivityCollection: fill(id * 10, price, at.replace('Z', '+0000')),
    childOrderStrategies: out ? [{ orderId: id + 1, status: 'FILLED', orderType: 'LIMIT', orderLegCollection: leg('SELL'), orderActivityCollection: fill(id * 10 + 1, out.price, out.at.replace('Z', '+0000')) }] : [],
  };
}
const ORDERS = [
  order(500, 'AAPL', '2026-10-01T14:30:01Z', 100, { at: '2026-10-02T15:00:00Z', price: 104 }),
  order(600, 'MSFT', '2026-10-05T14:00:01Z', 400, { at: '2026-10-05T15:00:00Z', price: 396 }),
  order(700, 'NVDA', '2026-10-08T14:00:01Z', 180), // still open
];
const A = '6789|AAPL|long|2026-10-01T14:30:01.000Z', B = '6789|MSFT|long|2026-10-05T14:00:01.000Z', C = '6789|NVDA|long|2026-10-08T14:00:01.000Z';

async function journal(tweak) {
  const supabase = fakeRecords(ORDERS.map(o => ({ kind: 'order', record_id: String(o.orderId), account: '6789', entered_at: o.enteredTime.replace('+0000', 'Z'), data: o })));
  if (tweak) tweak(supabase);
  const a = await app({ supabase, session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  await settle();
  return {
    ...a, supabase, t: 'journalPageTrade()',
    head: () => a.elements.get('jtHead').innerHTML, body: () => a.elements.get('jtBody').innerHTML, list: () => a.elements.get('journalSection').innerHTML,
    badge: () => a.elements.get('journalCount').textContent, rows: name => [...supabase.tables[name].values()],
    at: () => a.run('journalPageTrade()?.key || null'),
  };
}
/** a trade reviewed in full on another device: the day's market, the labels, both grades and a note */
const reviewedElsewhere = (s, key, day) => {
  s.tables.journal_days.set(`user-1:${day}`, { user_id: 'user-1', day, market: 'bullish' });
  for (const [kind, value] of [['sector', 'strong'], ['setup', 'sma50'], ['tactic', 'pivot15']]) s.tables.trade_labels.set(`user-1:${key}:${kind}:${value}`, { user_id: 'user-1', trade_key: key, kind, value, set_by: 'you' });
  s.reviews.set(`user-1:${key}`, { user_id: 'user-1', trade_key: key, setup_grade: 'B', plan_followed: 'yes', note: 'fine' });
};
/** the opening pass: market, sector, a setup, the tactic, followed the plan */
async function openingPass(run, t) {
  await run(`setReviewMarket(${t}, 'bullish')`);
  await run(`toggleReviewLabel(${t}, 'sector', 'strong')`);
  await run(`toggleSetup(${t}, 'ema21_bounce')`);
  await run(`toggleReviewLabel(${t}, 'tactic', 'pivot30')`);
  await run(`setPlanFollowed(${t}, 'yes')`);
}

test('the pass a trade needs: opening while open, the grade and note once closed; the queue is newest first, from the review-from day', async () => {
  const { run } = await app();
  const st = missing => JSON.stringify({ missing, reviewed: !missing.length });
  const all = ['market', 'sector', 'setup', 'tactic', 'setup grade', 'plan followed', 'note'];
  assert.equal(run(`reviewPass({ status: 'open' }, ${st(all)})`), 'opening');
  assert.equal(run(`reviewPass({ status: 'open' }, ${st(['setup grade', 'note'])})`), null, 'open with the labels and plan in: done for now');
  assert.equal(run(`reviewPass({ status: 'win' }, ${st(['setup grade', 'note'])})`), 'closing', 'closed: back for the grade and note');
  assert.equal(run(`reviewPass({ status: 'loss' }, ${st(['sector', 'note'])})`), 'full');
  assert.equal(run(`reviewPass({ status: 'win' }, ${st([])})`), null);
  assert.equal(run(`reviewPass({ status: 'history' }, ${st(all)})`), null, 'before your history: nothing to review');
  assert.equal(run(`reviewPass({ status: 'win', deleted: true }, ${st(all)})`), null);
  const trades = [{ key: 'a', openedAt: '2026-10-01T14:00:00Z', status: 'loss' }, { key: 'b', openedAt: '2026-10-05T14:00:00Z', status: 'win' }, { key: 'c', openedAt: '2026-10-03T14:00:00Z', status: 'win' }, { key: 'd', openedAt: '2026-10-02T03:00:00Z', status: 'win' }];
  const queue = from => json(run, `deckQueue(${JSON.stringify(trades)}, t => t.key === 'c' ? ${st([])} : ${st(all)}, '${from}').map(t => t.key)`);
  assert.deepEqual(queue(''), ['b', 'd', 'a'], 'newest first; c is done');
  assert.deepEqual(queue('2026-10-02'), ['b'], 'from Oct 2: d opened Oct 1 in New York (11pm), so it waits with a');
  assert.deepEqual(queue('2026-10-01'), ['b', 'd', 'a'], 'the day itself counts');
  assert.equal(run("reviewFromDay('2026-10-01')"), '2026-10-01');
  for (const bad of ["''", "'10/01/2026'", "'2026-13-45'", 'null']) assert.equal(run(`reviewFromDay(${bad})`), '', bad);
});

test('Review N trades, the Journal\'s line and the tab count are the whole queue: filters don\'t touch it', async () => {
  const { run, list, badge } = await journal();
  assert.match(list(), /<button class="btn primary" id="journalDeckBtn" data-action="startReviewDeck">Review 3 trades<\/button>/);
  assert.match(list(), /<p class="hint jr-queue" role="status">3 trades to review · <button class="pos-link" data-action="startReviewDeck">Start<\/button>\s*· <label class="jr-from">Review from <input type="date" id="journalReviewFrom" value="" /);
  assert.doesNotMatch(list(), /clearReviewFrom|older left out/, 'no day chosen: nothing to take back');
  assert.equal(badge(), '3');
  run("setJournalSide('short'); setJournalReviewFilter('todo')");
  assert.match(list(), /Review 3 trades/, 'the side filter doesn\'t narrow the deck');
  run('startReviewDeck()');
  assert.equal(run('journalDeck.keys.length'), 3);
});

test('a card: the trade page with the deck bar; Next moves on finished or not, Back returns, the end tallies and offers the skipped', async () => {
  const { run, t, head, body, badge, at, elements } = await journal();
  run('startReviewDeck()');
  assert.equal(at(), C, 'newest first');
  assert.equal(elements.get('journalTradeSection').style.display, '');
  assert.match(head(), /<div class="jt-deck" id="jtDeckBar" role="toolbar" aria-label="Review deck">\s*<span class="jt-deck-count">1 of 3<\/span>\s*<span class="jt-deck-pass">Opening pass<\/span>/, 'an open trade: the opening pass');
  assert.match(head(), /data-action="deckBack" disabled/, 'nothing before the first');
  assert.match(body(), /<span class="jr-status "[^>]*>To review: missing/, 'the same Review section');

  run('deckNext()');
  assert.equal(at(), B, 'Next on an unfinished trade moves on anyway');
  run('deckBack()');
  assert.equal(at(), C);
  await openingPass(run, t);
  assert.match(head(), /<span class="jt-deck-pass journal-buy">Opening pass done<\/span>/);
  assert.equal(badge(), '2', 'done for now: out of the count until it closes');
  run('deckNext()');
  assert.equal(at(), B);
  await run(`setSetupGrade(${t}, 'B')`); // started, not finished
  run('deckNext()');
  assert.equal(at(), A);
  assert.match(head(), /3 of 3<\/span>/);

  run('deckNext()');
  assert.equal(run('journalTrade'), null);
  assert.equal(elements.get('journalTradeSection').style.display, '', 'the end shows where the card was');
  assert.match(body(), /End of the deck: 1 done, 2 skipped\./);
  assert.match(body(), /data-action="reviewSkipped">Go through the 2 skipped<\/button>/);
  run('deckBack()');
  assert.equal(at(), A, 'Back from the end: the last card');
  run('deckNext(); reviewSkipped()');
  assert.deepEqual(json(run, 'journalDeck.keys'), [B, A], 'the skipped, newest first');
  assert.equal(at(), B);
  run('endReviewDeck()');
  assert.equal(run('journalDeck'), null);
  assert.equal(elements.get('journalTradeSection').style.display, 'none', 'back on the list');
});

test('P&L, R and exit efficiency wait for the grade; Show reveals them; Always show is a synced choice', async () => {
  const { run, t, body, storage } = await journal();
  run('startReviewDeck(); deckNext()');
  assert.match(body(), /<dt>P&amp;L<\/dt><dd class=""><span class="jt-wait">Grade first<\/span><span class="pos-sub"><button class="pos-link" data-action="revealDeckPnl">Show<\/button>/);
  assert.doesNotMatch(body(), /−\$400/, 'the result isn\'t anywhere on the card');
  assert.match(body(), /P&amp;L hidden until you grade · <button class="pos-link" data-action="setDeckPnl" data-arg="always">Always show<\/button>/);
  await run(`setSetupGrade(${t}, 'A')`);
  assert.match(body(), /<dt>P&amp;L<\/dt><dd class="journal-sell">−\$400/, 'graded: the result is back');

  run('deckNext()');
  assert.match(body(), /Grade first/);
  run('revealDeckPnl()');
  assert.match(body(), /<dt>P&amp;L<\/dt><dd class="journal-buy">\+\$400/, 'Show: this card only');
  run('deckBack(); deckBack()');
  run("setDeckPnl('always')");
  assert.equal(storage.get('journal_deck_pnl'), 'always');
  assert.ok(run("CLOUD_KEYS.includes('journal_deck_pnl')"), 'the choice goes with your account');
  assert.doesNotMatch(body(), /Grade first/);
  assert.match(body(), /P&amp;L shown up front in the deck · <button class="pos-link" data-action="setDeckPnl" data-arg="graded">Hide until I grade<\/button>/);

  run('endReviewDeck()');
  run("setDeckPnl('graded')");
  run(`openJournalTrade('${'6789|MSFT|long|2026-10-05T14:00:01.000Z'}')`);
  assert.match(body(), /−\$400/, 'the trade page outside the deck always shows it');
  assert.doesNotMatch(body(), /jt-deck-pnl/);
});

test('Save for the weekly review: weekly_at stamped and cleared, a tag on the list; refused goes back; before the push it says so', async () => {
  const one = await journal();
  one.run('startReviewDeck()');
  await one.run('toggleDeckWeekly()');
  const [rv] = one.rows('trade_reviews');
  assert.equal(rv.trade_key, C);
  assert.match(rv.weekly_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(one.head(), /aria-pressed="true"[^>]*>Saved for weekly ✓<\/button>/);
  one.run('endReviewDeck()');
  assert.match(one.list(), /<b>NVDA<\/b>[^]*?<span class="journal-tag journal-tag-quiet">for weekly<\/span>/);
  one.run('startReviewDeck()');
  await one.run('toggleDeckWeekly()');
  assert.equal(one.rows('trade_reviews')[0].weekly_at, null, 'tapped again: cleared');
  one.supabase.failColumn('trade_reviews', 'weekly_at');
  await one.run('toggleDeckWeekly()');
  assert.match(one.elements.get('errorBox').textContent, /Couldn't save the review/);
  assert.match(one.head(), />Save for weekly<\/button>/, 'back as it was');

  const two = await journal(s => s.failColumn('trade_reviews', 'weekly_at'));
  assert.match(two.list(), /Review 3 trades/, 'the rest of the review works before the push');
  two.run('startReviewDeck()');
  await two.run('toggleDeckWeekly()');
  assert.match(two.elements.get('errorBox').textContent, /Saving for the weekly review needs a database update: the database doesn(?:'|’)t have the weekly review column yet: npx supabase db push/);
  assert.equal(two.rows('trade_reviews').length, 0);
});

test('a closed trade with its labels in comes back for the grade and note; one reviewed elsewhere is passed over', async () => {
  const label = (s, key, kind, value) => s.tables.trade_labels.set(`user-1:${key}:${kind}:${value}`, { user_id: 'user-1', trade_key: key, kind, value, set_by: 'you' });
  const { run, head, at, supabase, list } = await journal(s => {
    s.tables.journal_days.set('user-1:2026-10-05', { user_id: 'user-1', day: '2026-10-05', market: 'bullish' });
    for (const [kind, value] of [['sector', 'strong'], ['setup', 'sma50'], ['tactic', 'pivot15']]) label(s, B, kind, value);
    s.reviews.set(`user-1:${B}`, { user_id: 'user-1', trade_key: B, plan_followed: 'yes' });
  });
  run('startReviewDeck()');
  run('deckNext()');
  assert.equal(at(), B);
  assert.match(head(), /<span class="jt-deck-pass">Closing pass: the grade and note<\/span>/);
  // the open trade gets its opening pass and the oldest its full review on another device; this one hears on a reload
  supabase.tables.journal_days.set('user-1:2026-10-08', { user_id: 'user-1', day: '2026-10-08', market: 'bullish' });
  for (const [kind, value] of [['sector', 'strong'], ['setup', 'sma50'], ['tactic', 'pivot15']]) label(supabase, C, kind, value);
  supabase.reviews.set(`user-1:${C}`, { user_id: 'user-1', trade_key: C, plan_followed: 'yes' });
  reviewedElsewhere(supabase, A, '2026-10-01');
  await run('loadJournal()');
  run('deckNext()');
  assert.equal(run('journalDeck.finished'), true, 'the oldest, reviewed elsewhere and not shown yet, is passed over');
  run('endReviewDeck()');
  run("setJournalReviewFilter('todo')");
  assert.doesNotMatch(list(), /<b>NVDA<\/b>/, 'To review matches the deck: an open trade with its opening pass done waits for its close');
});

test('← and → move through the deck, Esc leaves; never while typing', async () => {
  const { run, at, dispatch } = await journal();
  run('initShortcuts(); startReviewDeck()');
  const key = (k, tagName = 'BODY') => dispatch('keydown', { key: k, target: { tagName, blur() {} }, preventDefault() {} });
  key('ArrowRight');
  assert.equal(at(), B);
  key('ArrowRight', 'TEXTAREA');
  assert.equal(at(), B, 'typing a note: the arrow moves the cursor');
  key('ArrowLeft');
  assert.equal(at(), C);
  key('Escape');
  assert.equal(run('journalDeck'), null);
  assert.equal(run('journalTrade'), null, 'back on the list');
});

test('nothing to review: no button, the line says so, the count is blank; the review tables missing hide the deck', async () => {
  const one = await journal(s => { reviewedElsewhere(s, A, '2026-10-01'); reviewedElsewhere(s, B, '2026-10-05'); reviewedElsewhere(s, C, '2026-10-08'); });
  assert.doesNotMatch(one.list(), /journalDeckBtn/);
  assert.match(one.list(), /<p class="hint jr-queue" role="status">All reviewed<\/p>/);
  assert.equal(one.badge(), '');
  one.run('startReviewDeck()');
  assert.match(one.elements.get('errorBox').textContent, /Nothing to review\./);
  assert.equal(one.run('journalDeck'), null);

  const two = await journal(s => s.failTable('trade_labels'));
  assert.doesNotMatch(two.list(), /journalDeckBtn|jr-queue/);
  assert.equal(two.badge(), '');
});

test('Review from a day: older trades leave the deck, the count and To review; All days brings them back; synced', async () => {
  const { run, list, badge, storage, elements } = await journal();
  run("setReviewFrom('2026-10-05')");
  assert.equal(storage.get('journal_review_from'), '2026-10-05');
  assert.ok(run("CLOUD_KEYS.includes('journal_review_from')"), 'the day goes with your account');
  assert.match(list(), /Review 2 trades/);
  assert.match(list(), /2 trades to review · [^]*?<input type="date" id="journalReviewFrom" value="2026-10-05"[^>]*\/><\/label> <button class="pos-link" data-action="clearReviewFrom">All days<\/button> · 1 older left out<\/p>/);
  assert.equal(badge(), '2');
  run("setJournalReviewFilter('todo')");
  assert.doesNotMatch(list(), /<b>AAPL<\/b>/, 'To review matches the deck');
  assert.match(list(), /<b>MSFT<\/b>/);
  run('startReviewDeck()');
  assert.deepEqual(json(run, 'journalDeck.keys'), [C, B]);
  run('endReviewDeck()');

  run("setReviewFrom('2026-10-09')");
  assert.doesNotMatch(list(), /journalDeckBtn/);
  assert.match(list(), /All reviewed\s*· <label class="jr-from">[^]*?All days<\/button> · 3 older left out/, 'nothing since: the day stays so it can be taken back');
  assert.equal(badge(), '');
  run("setReviewFrom('not a day')");
  assert.equal(storage.get('journal_review_from'), '', 'anything but a day is every day');
  assert.match(list(), /Review 3 trades/);
  run("setReviewFrom('2026-10-05'); setReviewFrom('')");
  assert.match(list(), /Review 3 trades/, 'All days');
  assert.ok(elements.has('journalReviewFrom'));
});
