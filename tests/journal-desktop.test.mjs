// Run with: node --test
// The desktop Journal (≥1100px, docs/journal.md): the Workbench (rail, the trades a day at a time, the picked trade's panel
// with where its review stands) and the Review desk one click away, the full review page (chart and fills on the left, the
// review on the right, the footer with what's still missing), the calendar's days and modes, and panes that keep their place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
let n = 0;
const order = (instruction, time, qty, price, symbol) => { const id = ++n; return { kind: 'order', record_id: String(id), account: '6789', entered_at: time, data: {
  orderId: id, enteredTime: time, status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction, quantity: qty, instrument: { symbol, assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 9000 + id, executionLegs: [{ legId: 1, quantity: qty, price, time }] }] } }; };
// three closed trades on two days: AAPL and MSFT on 10/1, NVDA on 10/2
const ROWS = [
  order('BUY', '2026-10-01T14:30:00Z', 100, 100, 'AAPL'), order('SELL', '2026-10-01T18:00:00Z', 100, 102, 'AAPL'),
  order('BUY', '2026-10-01T15:00:00Z', 10, 400, 'MSFT'), order('SELL', '2026-10-01T19:00:00Z', 10, 396, 'MSFT'),
  order('BUY', '2026-10-02T14:00:00Z', 50, 180, 'NVDA'), order('SELL', '2026-10-02T17:00:00Z', 50, 183, 'NVDA'),
];
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

async function desktop() {
  const supabase = fakeRecords(ROWS);
  const a = await app({ width: 1500, supabase, session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  const key = sym => a.run(`journalTradeList().find(t => t.symbol === '${sym}').key`);
  return { ...a, supabase, key, list: () => a.elements.get('journalSection').innerHTML };
}

test('Workbench: the rail, the trades a day at a time, the newest to review in the panel; a click picks, a second opens', async () => {
  const a = await desktop();
  const html = a.list();
  assert.match(html, /class="card positions-card journal-card jw-bench jw-has-side"/);
  assert.match(html, /<aside class="jb-rail"[^>]*>[^]*?<nav class="jb-nav journal-nav"[^]*?<span>Trades<\/span><span class="jb-nav-n">3<\/span>/, 'the tabs in the rail, the trades counted');
  assert.match(html, /<div class="jb-filters journal-controls"[^]*?id="journalSymbol"/, 'the filters in the rail');
  assert.match(html, /<div class="jb-acts">[^]*?<div class="jb-io"><button class="btn" id="journalImportBtn"[^]*?id="journalExportBtn"[^]*?<\/div><\/div>\s*<nav class="jb-nav/, 'Import and Export at the top of the rail, above the tabs');
  assert.ok(html.indexOf('Fri · Oct 2') < html.indexOf('Thu · Oct 1'), 'newest day first');
  assert.match(html, /<dl class="jb-band">[^]*?Net P&amp;L/);
  // nothing reviewed: the newest waiting trade is in the panel, with its checklist
  assert.match(html, /<aside class="jw-side jb-side"[^]*?<b>NVDA<\/b>[^]*?To review · 1 of 3[^]*?0 of 7 done[^]*?Open full review ›/);
  a.run(`selectJournalTrade('${a.key('MSFT')}')`);
  assert.match(a.list(), /<aside class="jw-side jb-side"[^]*?<b>MSFT<\/b>/, 'a click shows it in the panel');
  assert.equal(a.run('state.journalTrade'), null);
  a.run(`selectJournalTrade('${a.key('MSFT')}')`);
  assert.equal(a.run('state.journalTrade.key'), a.key('MSFT'), 'clicked again: its page');
});

test('Workbench: ↓ and ↑ step the panel through the table as it shows; Skip moves to the next to review', async () => {
  const a = await desktop();
  const keys = a.run('benchKeys()');
  assert.equal(keys.map(k => k.split('|')[1]).join(','), 'NVDA,MSFT,AAPL', 'as the table shows them: the newest day first');
  a.run(`state.journalSelected = '${keys[0]}'`);
  a.run('stepJournalSelection(1, benchKeys)');
  assert.equal(a.run('state.journalSelected'), keys[1]);
  a.run('stepJournalSelection(-1, benchKeys)');
  a.run('stepJournalSelection(-1, benchKeys)');
  assert.equal(a.run('state.journalSelected'), keys[0], 'stops at the top');
  a.run('skipPanelTrade()');
  assert.notEqual(a.run('state.journalSelected'), keys[0]);
});

test('Review desk: one click away, the cards two-up with the progress, Up next and By setup beside them; kept on this device', async () => {
  const a = await desktop();
  assert.match(a.list(), /data-action="setJournalLayout" data-arg="desk"/);
  a.run("setJournalLayout('desk')");
  const html = a.list();
  assert.match(html, /class="card positions-card journal-card jw-desk"/);
  assert.match(html, /<div class="jtc-list jds-cards">/);
  assert.match(html, /<aside class="jw-side jd-side"[^]*?id="jUpNext"/, 'Up next beside the cards');
  const next = html.match(/id="jUpNext" data-key="([^"]+)"/)[1];
  assert.ok(html.split('jds-cards')[1].split('jd-side')[0].includes(`data-arg="${next}"`), 'and still among the cards');
  assert.match(html, /<section class="jds" aria-label="By setup">[^]*?No setup <span class="jds-n">3<\/span>/);
  assert.equal(a.storage.get('journal_layout'), 'desk', 'this device only');
  a.run("setJournalLayout('bench')");
  assert.match(a.list(), /jw-bench/);
});

test('the full review: the stats and Fills | Stop orders | Features on the left, the review on the right, what to finish under it', async () => {
  const a = await desktop();
  a.run(`openJournalTrade('${a.key('NVDA')}')`);
  await settle();
  const aside = a.elements.get('jtAside').innerHTML, body = a.elements.get('jtBody').innerHTML, foot = a.elements.get('jtFoot').innerHTML;
  assert.match(aside, /<dl class="jt-stats">/);
  assert.match(aside, /data-action="setJournalTradeLeft" data-arg="fills">Fills <span class="jt-tab-n">2<\/span>/);
  assert.match(body, /id="journalReview"[^]*?1 · Context[^]*?2 · Setup[^]*?3 · Execution[^]*?4 · Keep/, 'the form in numbered parts');
  assert.doesNotMatch(body, /jt-stats/, 'the numbers stay with the chart');
  assert.match(foot, /<b>7 to finish<\/b><span>Market · Sector · Setup · Entry tactic · Setup grade · Followed the plan · Exit note<\/span>/);
  assert.match(foot, /data-action="openNextToReview">Next to review ›/);
  a.run('openNextToReview()');
  assert.notEqual(a.run('state.journalTrade.key'), a.key('NVDA'), 'on to the next still to review');
  a.run("setJournalTradeLeft('features')");
  assert.match(a.elements.get('jtAside').innerHTML, /id="jtFeatures"/);
});

test('narrower screens keep one column: the stats, Review | Features, the review, the fills', async () => {
  const supabase = fakeRecords(ROWS);
  const a = await app({ width: 1000, supabase, session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  a.run(`openJournalTrade(journalTradeList()[0].key)`);
  await settle();
  assert.equal(a.elements.get('jtAside').innerHTML, '');
  assert.equal(a.elements.get('jtFoot').innerHTML, '');
  assert.match(a.elements.get('jtBody').innerHTML, /<dl class="jt-stats">[^]*?data-action="setJournalTradeTab"[^]*?id="journalReview"[^]*?Fills/);
  assert.doesNotMatch(a.elements.get('journalSection').innerHTML, /jw-bench|jb-rail/, 'no Workbench under 1100px');
});

test('the desktop calendar: a day clicked opens its notebook page; R and Grade change what the days say', async () => {
  const a = await desktop();
  a.run("setJournalTab('calendar'); state.journalMonth = '2026-10'; renderJournal()");
  const html = a.list();
  assert.match(html, /<div class="jc-wrap">/);
  assert.doesNotMatch(html, /jc-side|Open notebook page/, 'no side panel');
  assert.match(html, /class="jc-day jc-desk journal-buy" style="--jc-shade:\d+%" data-action="openJournalDay" data-arg="2026-10-01"/);
  assert.match(html, /class="jc-cum"/, 'the cumulative line');
  a.run("setCalendarMode('r')");
  assert.match(a.list(), /data-arg="r" aria-pressed="true"|aria-pressed="true" data-action="setCalendarMode" data-arg="r"/);
  a.run("openJournalDay('2026-10-01')");
  assert.equal(a.run('state.journalNotebookDay'), '2026-10-01', 'the day opens its notebook page');
});

test('keepScroll: a pane keeps its place through a redraw while its key matches', async () => {
  const { run } = await app({});
  const out = run(`(() => {
    const pane = (key, top) => ({ dataset: { scroll: key }, scrollTop: top });
    let panes = [pane('main:trades', 240), pane('side', 30)];
    const root = { querySelectorAll: () => panes };
    keepScroll(root, () => { panes = [pane('main:trades', 0), pane('main:calendar', 0)]; });
    return panes.map(p => p.scrollTop).join(',');
  })()`);
  assert.equal(out, '240,0');
});
