// Run with: node --test
// The Journal's Setups tab: every one of My setups with its numbers, the review's other labels as cuts (grade, tactic,
// plan, market, sector, mistakes, tags), a setup's own page, and the setup grade running A to F (an old A++ reads as A).
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const json = (run, code) => JSON.parse(run(`JSON.stringify(${code})`));

test('stats per label: a trade counts in each of its groups, the ones with none are counted apart, known groups first', async () => {
  const { run } = await app();
  const t = (key, pnl, groups) => ({ key, pnl, r: pnl / 100, closedAt: '2026-10-02T15:00:00Z', openedAt: '2026-10-01T14:30:00Z', status: 'closed', groups });
  const trades = [t('a', 200, ['x', 'y']), t('b', -100, ['y']), t('c', 50, []), { ...t('d', 999, ['x']), deleted: true }, { ...t('e', 5, ['x']), status: 'open' }];
  const out = json(run, `statsByLabel(${JSON.stringify(trades)}, t => t.groups, ['x'])`);
  assert.deepEqual(out.rows.map(r => [r.group, r.stats.trades, r.stats.net]), [['x', 1, 200], ['y', 2, 100]], 'x first by the order given; deleted and open trades never count');
  assert.equal(out.none, 1, 'the closed trade with no group');
  assert.deepEqual(json(run, "['A++', 'A', 'C', 'Z', null].map(gradeOf)"), ['A', 'A', 'C', null, null], 'grades run A to F; an old A++ is an A');
  assert.deepEqual(json(run, 'GRADES'), ['A', 'B', 'C', 'D', 'F']);
});

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

async function journal(tweak) {
  const supabase = fakeRecords([{ kind: 'order', record_id: '501', account: '6789', entered_at: '2026-10-01T14:30:00Z', data: ENTRY }]);
  if (tweak) tweak(supabase);
  const a = await app({ supabase, session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  return { ...a, list: () => a.elements.get('journalSection').innerHTML, body: () => a.elements.get('jtBody').innerHTML };
}

test('the Setups tab: every setup with its numbers, unused ones too, then the review\'s labels as cuts', async () => {
  const { run, state, list, body } = await journal();
  run(`openJournalTrade('${KEY}')`);
  await settle();
  const t = 'journalPageTrade()';
  assert.doesNotMatch(body(), /data-arg="A\+\+"/, 'no A++ grade to pick');
  assert.match(body(), /data-action="setSetupGrade" data-arg="A">A<\/button>/);
  await run(`toggleSetup(${t}, 'ema21_bounce')`);
  await run(`toggleSetup(${t}, 'base_breakout')`);
  await run(`toggleReviewLabel(${t}, 'tactic', 'pivot30')`);
  await run(`toggleReviewLabel(${t}, 'mistake', 'chased')`);
  await run(`setSetupGrade(${t}, 'B')`);
  run('closeJournalTrade()');

  run("setJournalTab('setups')");
  const html = list();
  assert.match(html, /data-action="setJournalTab" data-arg="setups">Setups<\/button>/);
  assert.match(html, /\d+ setups · 1 of 1 closed trade has a setup/);
  assert.match(html, /<div class="section-title js-sub">My setups<\/div>/);
  assert.match(html, /data-action="openJournalSetup" data-arg="ema21_bounce"[^>]*><b>21 EMA bounce \/ rejection<\/b><\/button> <span class="journal-tag journal-tag-quiet"[^>]*>thin<\/span><span class="pos-sub">Bounce \/ rejection at 21 EMA · long only<\/span>[\s\S]*?<td>1<\/td><td class="journal-sell">−\$504\.00<\/td>/, 'a used setup: its parts, one trade, its net');
  assert.match(html, /<b>8 EMA bounce \/ rejection<\/b><\/button><span class="pos-sub">Bounce \/ rejection at 8 EMA · not used yet<\/span>/, 'the ones not used yet are listed too');
  assert.ok(html.indexOf('<b>21 EMA bounce / rejection</b>') < html.indexOf('<b>8 EMA bounce / rejection</b>'), 'used ones first');
  assert.match(html, /By setup grade[\s\S]*<b>B<\/b>[\s\S]*<td>−1\.00R<\/td>/, 'the grade ladder, with average R');
  assert.match(html, /By entry tactic[\s\S]*<b>30-minute pivot<\/b>/);
  assert.match(html, /By mistake[\s\S]*<b>Chased the entry<\/b>/);
  assert.doesNotMatch(html, /id="journalSetupFilter"/, 'no setup filter on the setups themselves');

  run("openJournalSetup('ema21_bounce')");
  const page = list();
  assert.match(page, /data-action="closeJournalSetup">← All setups<\/button>\s*<span class="jc-title">21 EMA bounce \/ rejection<\/span>/);
  assert.match(page, /<dt>Net P&amp;L<\/dt><dd class="journal-sell">−\$504\.00/, 'its headline numbers');
  assert.match(page, /Together with[\s\S]*<b>Base breakout \/ breakdown<\/b>/, 'the other setups on its trades');
  assert.match(page, /data-action="openTradeRow" data-arg="[^"]*AAPL[^"]*"[\s\S]*<td>B<\/td>/, 'its trades, with their grades');

  run("showSetupIn('trades')");
  assert.equal(state.journalTab, 'trades');
  assert.equal(state.journalSetupFilter, 'ema21_bounce', 'its trades: the list narrowed to it');
  run("setJournalTab('setups')");
  assert.match(list(), /<span class="jc-title">21 EMA bounce \/ rejection<\/span>/, 'back on the tab, the setup is still open');
  run("showSetupIn('books')");
  assert.deepEqual([state.journalTab, state.modelBooks.mode, state.modelBooks.setupKey], ['books', 'setups', 'ema21_bounce'], 'its model book examples');
});

test('a grade saved as A++ before the cut reads as A', async () => {
  const { state } = await journal(s => s.reviews.set(`user-1:${KEY}`, { user_id: 'user-1', trade_key: KEY, setup_grade: 'A++', plan_followed: 'yes', note: 'fine' }));
  assert.equal(state.journalReview.reviews[KEY].setup_grade, 'A');
});

test('a setup traded both ways: one row, its long and short rows under it, the side filter picks one', async () => {
  const leg = (id, instruction, time, price) => ({ kind: 'order', record_id: String(id), account: '6789', entered_at: time.replace('+0000', 'Z'), user_id: 'user-1', data: {
    orderId: id, enteredTime: time, status: 'FILLED',
    orderLegCollection: [{ legId: 1, instruction, quantity: 10, instrument: { symbol: 'MSFT', assetType: 'EQUITY' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: id * 10, executionLegs: [{ legId: 1, quantity: 10, price, time }] }],
  } });
  const { run, list } = await journal(sb => {
    for (const r of [leg(601, 'SELL_SHORT', '2026-10-05T14:00:00+0000', 400), leg(602, 'BUY_TO_COVER', '2026-10-05T15:00:00+0000', 399)]) sb.table.set(`user-1:order:${r.record_id}`, r);
  });
  for (const key of [KEY, '6789|MSFT|short|2026-10-05T14:00:00.000Z']) {
    run(`openJournalTrade('${key}')`);
    await settle();
    await run("toggleSetup(journalPageTrade(), 'base_breakout')");
    run('closeJournalTrade()');
  }
  run("setJournalTab('setups')");
  const html = list();
  assert.match(html, /<b>Base breakout \/ breakdown<\/b><\/button>[\s\S]*?<td>2<\/td>/, 'one setup, both trades');
  assert.match(html, /<tr class="journal-thin js-side-row"><td>Long · Base breakout[\s\S]*?<td>1<\/td><td class="journal-sell">−\$504\.00<\/td>/, 'its long row');
  assert.match(html, /<tr class="journal-thin js-side-row"><td>Short · Base breakdown[\s\S]*?<td>1<\/td><td class="journal-buy">\+\$10\.00<\/td>/, 'its short row');
  run("setJournalSide('short')");
  assert.match(list(), /<b>Base breakdown<\/b><\/button>[\s\S]*?<td>1<\/td>/, 'shorts only: the short name, the short trade');
  assert.doesNotMatch(list(), /js-side-row/, 'one side shown: no side rows');
  run("openJournalSetup('base_breakout')");
  assert.match(list(), /<span class="jc-title">Base breakdown<\/span>/);
});

test('a setup closed long with a short still open is not "long only"', async () => {
  const leg = (id, instruction, time, price) => ({ kind: 'order', record_id: String(id), account: '6789', entered_at: time.replace('+0000', 'Z'), user_id: 'user-1', data: {
    orderId: id, enteredTime: time, status: 'FILLED',
    orderLegCollection: [{ legId: 1, instruction, quantity: 10, instrument: { symbol: 'MSFT', assetType: 'EQUITY' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: id * 10, executionLegs: [{ legId: 1, quantity: 10, price, time }] }],
  } });
  const { run, list } = await journal(sb => { const r = leg(601, 'SELL_SHORT', '2026-10-05T14:00:00+0000', 400); sb.table.set(`user-1:order:${r.record_id}`, r); });
  for (const key of [KEY, '6789|MSFT|short|2026-10-05T14:00:00.000Z']) {
    run(`openJournalTrade('${key}')`);
    await settle();
    await run("toggleSetup(journalPageTrade(), 'flag_breakout')");
    run('closeJournalTrade()');
  }
  run("setJournalTab('setups')");
  assert.match(list(), /<b>Flag breakout \/ breakdown<\/b><\/button>[^]*?<span class="pos-sub">Pennant or flag breakout \/ breakdown · 1 open<\/span>/, 'both words, no "long only"');
});
