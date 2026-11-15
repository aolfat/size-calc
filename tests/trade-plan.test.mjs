// Run with: node --test
// Order plans from the Trade at Schwab sheet (docs/schwab.md): the setup and entry tactic picks (today's focus list and the
// opening range fill them in), the plan saved once the order goes (risk against the Schwab account's value, how the stop
// was set), picks changed after Place, Positions' Edit giving the plan the new order id, and the journal putting the
// plan's labels on its trade and showing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const QUOTE = { symbol: 'TEST', type: 'stock', last: 100, bid: 99.98, ask: 100.02, low: 98, high: 102 };
const json = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

const connected = (extra = [], userId = 'user-1') => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ userId, proxy: PROXY, connectionId: 'test-connection', access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }])],
  ['schwab_account', 'HASH1'],
  ...extra,
]);

// Schwab: the order goes in as 1001 (or as the handler says), the account is worth $100,000
function schwab({ place = () => json(null, 201, { Location: `${PROXY}/trader/v1/accounts/HASH1/orders/1001` }), value = 100000 } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (url.includes('/markets/quotes')) return json({ quotes: { quote: QUOTE } });
    if (!url.startsWith(PROXY)) return json({});
    const path = url.slice(PROXY.length);
    if (path === '/trader/v1/accounts/HASH1/orders' && init.method === 'POST') return place();
    if (path === '/trader/v1/accounts/HASH1') return value === null ? json({}, 500) : json({ securitiesAccount: { currentBalances: { liquidationValue: value } } });
    return json({}, 404);
  };
  return { calls, fetch };
}

async function sheet({ signedIn = true, net = schwab(), tweak, storage = connected([], signedIn ? 'user-1' : null), focus } = {}) {
  const supabase = fakeRecords();
  if (tweak) tweak(supabase);
  const a = await app({ fetch: net.fetch, storage, ...(signedIn ? { supabase, session: SESSION } : {}) });
  if (focus) supabase.tables.journal_days.set('user-1:' + a.run('nyDateStr(new Date())'), { user_id: 'user-1', day: a.run('nyDateStr(new Date())'), focus_list: focus });
  a.run(`quoteData = ${JSON.stringify(QUOTE)};
    document.getElementById('ticker').value = 'TEST';
    document.getElementById('apiKey').value = 'tradier-test';
    document.getElementById('accountSize').value = '100000';
    document.getElementById('riskDollar').value = '500';
    syncFromDollar();`);
  const plans = () => [...supabase.tables.order_plans.values()];
  return { ...a, net, supabase, plans, body: () => a.elements.get('tradeBody').innerHTML, picks: () => a.run('tradePlanHtml(state.tradeTicket)') };
}

test('the picks come first on the sheet; today\'s focus list and the opening range fill them in', async () => {
  const s = await sheet({ focus: [{ id: 'f1', symbol: 'TEST', side: 'long', setups: ['ema21_bounce'] }] });
  s.run("state.orb = { symbol: 'TEST', minutes: 15, isLong: true, high: 100.5, low: 98, end: '09:45', entry: 100.51, stop: 98 }; document.getElementById('entryPrice').value = '100.51'; document.getElementById('stopLong').value = '98'; renderShares()");
  await s.run('openTrade()');
  await settle();
  const t = s.state.tradeTicket;
  assert.deepEqual([t.setups, t.tactics], [['ema21_bounce'], ['pivot15']]);
  // above the entry order, so the setup, tactic and grade are the first thing you see
  assert.ok(s.body().indexOf('id="tradePlan"') < s.body().indexOf('Entry order'));
  // the plan line reads them back, each a tap to take off, and says what's still missing
  assert.match(s.picks(), /<div class="tp-line" id="tradePlanLine"><button class="tp-picked" data-action="toggleTradeSetup" data-arg="ema21_bounce" title="Take this setup off">21 EMA bounce<span aria-hidden="true">×<\/span><\/button><button class="tp-picked" data-action="toggleTradeTactic" data-arg="pivot15"[^>]*>15m pivot<span/);
  assert.match(s.picks(), /<span class="tp-need">No grade yet<\/span>/);
  // the move is the picked setup's, its levels grouped, the picked one lit
  assert.match(s.picks(), /<button class="active" aria-pressed="true" data-action="setTradeMove" data-arg="bounce">Bounce<\/button><button class="" aria-pressed="false" data-action="setTradeMove" data-arg="undercut">Undercut &amp; rally<\/button><button class="" aria-pressed="false" data-action="setTradeMove" data-arg="pattern">Pattern<\/button>/);
  assert.match(s.picks(), /<span class="jr-group-name">Daily<\/span><span class="jr-group-chips">[^]*?class="filter-btn active" aria-pressed="true" data-action="pickTradeLevel" data-arg="ema21" title="21 EMA bounce">21 EMA</);
  assert.match(s.picks(), /<span class="jr-group-name">Weekly<\/span>[^]*?data-arg="ema9w"/);
  assert.match(s.picks(), /<span class="jr-group-name">AVWAP<\/span>[^]*?data-arg="avwap_ath"/);
  assert.match(s.picks(), /<span class="jr-group-name">Other<\/span><span class="jr-group-chips"><button class="filter-btn tp-new"[^>]*data-arg="support"/);
  // tactics under their timeframe, the timeframe dropped from the chip; the rest under Other, then + New
  assert.match(s.picks(), /<span class="jr-group-name">15m<\/span><span class="jr-group-chips"><button class="filter-btn active" aria-pressed="true" data-action="toggleTradeTactic" data-arg="pivot15" title="15m pivot">Pivot</);
  assert.match(s.picks(), /<span class="jr-group-name">Other<\/span><span class="jr-group-chips"><button[^>]*data-arg="six20" title="6\/20 \(Gil Morales\)">6\/20/);
  assert.match(s.picks(), /data-action="startTradeTactic"/);
  assert.match(s.picks(), /<div class="tp-title">Grade<\/div>\s*<div class="tp-grades"/);
});

test('your setups are read as soon as the trade button shows, once, so the sheet opens with them in place', async () => {
  const s = await sheet();
  s.run('renderShares(); renderShares()');
  await settle();
  assert.equal(s.supabase.reads.filter(r => r.table === 'library_items').length, 1, 'read once, before any review');
  await s.run('openTrade()');
  assert.doesNotMatch(s.body(), /Loading your setups/, 'nothing arrives after the sheet is up to push the buttons down');
  assert.match(s.body(), /data-action="pickTradeLevel"/);
  assert.match(s.picks(), /<span class="tp-need">No setup, tactic or grade yet<\/span>/);
});

const libraryRows = s => [...s.supabase.tables.library_items.values()];

test('a move and a level make the setup: one of yours is used, a new pair goes into My setups, a tap again takes it off', async () => {
  const s = await sheet();
  await s.run('openTrade()');
  await settle();
  s.run("setTradeMove('undercut'); pickTradeLevel('ema21')");
  assert.deepEqual(s.state.tradeTicket.setups, ['ema21_unr'], 'the one you have');
  assert.match(s.picks(), /class="filter-btn active" aria-pressed="true" data-action="pickTradeLevel" data-arg="ema21" title="21 EMA undercut &amp; rally">21 EMA</);
  // a pair you never made is dashed, and a tap makes it, named for its parts
  assert.match(s.picks(), /class="filter-btn tp-new" aria-pressed="false" data-action="pickTradeLevel" data-arg="sma200" title="200 SMA undercut &amp; rally: a tap adds it to My setups">200 SMA</);
  await s.run("pickTradeLevel('sma200')");
  const [row] = libraryRows(s);
  assert.deepEqual([row.kind, row.name, row.settings], ['setup', '200 SMA undercut & rally', { action: 'undercut', levels: ['sma200'] }]);
  assert.deepEqual(s.state.tradeTicket.setups, ['ema21_unr', `mine:${row.id}`], 'several setups at once');
  assert.match(s.picks(), /class="filter-btn tp-new active" aria-pressed="true" data-action="pickTradeLevel" data-arg="sma200"|class="filter-btn active" aria-pressed="true" data-action="pickTradeLevel" data-arg="sma200"/);
  await s.run("pickTradeLevel('sma200')");
  assert.deepEqual(s.state.tradeTicket.setups, ['ema21_unr'], 'tapped again, it comes off');
  await s.run("pickTradeLevel('sma200')");
  assert.equal(libraryRows(s).length, 1, 'and on again it is the one already made, not a second');
  // a pattern
  s.run("setTradeMove('pattern'); pickTradePattern('earnings_gap')");
  assert.ok(s.state.tradeTicket.setups.includes('earnings_gap'));
  // the plan line's × takes one off
  s.run("toggleTradeSetup('ema21_unr')");
  assert.deepEqual(s.state.tradeTicket.setups, [`mine:${row.id}`, 'earnings_gap']);
  // on a short, the words are a short's
  s.run("state.tradeTicket.isLong = false; setTradeMove('bounce')");
  assert.match(s.picks(), /data-arg="bounce">Rejection<\/button>/);
});

test('a setup that can\'t be added to My setups comes back off the ticket and says why', async () => {
  const s = await sheet();
  await s.run('openTrade()');
  await settle();
  s.supabase.failTable('library_items'); // read fine, then the save is refused
  await s.run("setTradeMove('undercut'); pickTradeLevel('sma200')");
  assert.deepEqual(s.state.tradeTicket.setups, []);
  assert.match(s.elements.get('errorBox').textContent, /Couldn't add 200 SMA undercut & rally to My setups/);
});

test('+ New under the tactics: a name you have picks it, a new one goes into your library and on the ticket', async () => {
  const s = await sheet();
  await s.run('openTrade()');
  await settle();
  s.run('startTradeTactic()');
  assert.match(s.picks(), /<input type="text" id="tradeNewTactic"[^>]*data-enter="addTradeTactic"/);
  await s.run("addTradeTactic('15-minute pivot')");
  assert.deepEqual(s.state.tradeTicket.tactics, ['pivot15'], 'one you have, by an old name too');
  assert.equal(libraryRows(s).length, 0);
  s.run('startTradeTactic()');
  await s.run("addTradeTactic('5m flag break')");
  const [row] = libraryRows(s);
  assert.deepEqual([row.kind, row.name], ['tactic', '5m flag break']);
  assert.deepEqual(s.state.tradeTicket.tactics, ['pivot15', `mine:${row.id}`]);
  assert.match(s.picks(), /<span class="jr-group-name">5m<\/span><span class="jr-group-chips"><button class="filter-btn active"[^>]*>Flag break</);
  assert.doesNotMatch(s.picks(), /id="tradeNewTactic"/, 'the box closes');
});

test('what you marked Review only stays off the sheet, and stays in a review', async () => {
  const s = await sheet({ tweak: db => {
    db.tables.library_items.set('user-1:p-acc', { user_id: 'user-1', id: 'p-acc', kind: 'pattern', name: 'Accident', settings: { review_only: true } });
    db.tables.library_items.set('user-1:t-na', { user_id: 'user-1', id: 't-na', kind: 'tactic', name: 'N/A', settings: { review_only: true } });
    db.tables.library_items.set('user-1:p-wedge', { user_id: 'user-1', id: 'p-wedge', kind: 'pattern', name: 'Wedge pop', settings: {} });
  } });
  await s.run('openTrade()');
  await settle();
  assert.doesNotMatch(s.picks(), /N\/A/);
  s.run("setTradeMove('pattern')");
  assert.match(s.picks(), /Wedge pop/);
  assert.doesNotMatch(s.picks(), /Accident/);
  s.run("tradeQuickInput('accident')");
  assert.match(s.elements.get('tradeQuickPreview').innerHTML, /no match: accident/, 'the typed line skips it too');
  // the library sheet marks and unmarks it
  const { buildLibrary, onOrderSheet } = await import('../src/core/journal-labels.js');
  const lib = () => buildLibrary(s.state.journalReview.library);
  await s.run("toggleLibraryReviewOnly('pattern', 'mine:p-wedge')");
  assert.equal(onOrderSheet(lib().item('pattern', 'mine:p-wedge')), false);
  assert.deepEqual(s.supabase.tables.library_items.get('user-1:p-wedge').settings, { review_only: true });
  await s.run("toggleLibraryReviewOnly('tactic', 'pivot15')");
  assert.equal(onOrderSheet(lib().item('tactic', 'pivot15')), false, 'a default too, through its own row');
  await s.run("toggleLibraryReviewOnly('pattern', 'mine:p-wedge')");
  assert.deepEqual(s.supabase.tables.library_items.get('user-1:p-wedge').settings, {});
  s.run('renderJournalLibrary()');
  assert.match(s.elements.get('journalLibraryBody').innerHTML, /data-action="toggleLibraryReviewOnly" data-arg="pattern" data-arg2="mine:p-acc"[^>]*>Show on order sheet</);
});

test('once the order goes, the plan is saved: the picks, the order id, risk against the Schwab account, the stop', async () => {
  const s = await sheet();
  await s.run('openTrade()');
  await settle();
  s.run("toggleTradeSetup('base_breakout'); toggleTradeTactic('six20')");
  assert.equal(s.plans().length, 0, 'nothing before Place');
  await s.run('placeTrade()');
  const [p] = s.plans();
  assert.deepEqual([p.account, p.symbol, p.side, p.order_ids, p.setups, p.tactics], ['6789', 'TEST', 'long', ['1001'], ['base_breakout'], ['six20']]);
  assert.ok(Date.parse(p.sent_at) > Date.now() - 60000);
  assert.deepEqual({ ...p.plan, schwab_value_at: !!p.plan.schwab_value_at }, {
    qty: 250, entry_type: 'MARKET', entry: 100, stop: 98, stop_planned: 98, planned_risk: 500, fill_risk: 505,
    max_loss: 500, account_size: 100000, account_source: 'schwab', risk_pct: 0.5, schwab_value: 100000, schwab_value_at: true,
    stop_source: 'auto', stop_strategy: 'none', stop_amount: null, stop_level: 98, stop_level_name: 'LOD', ext_hours: false, atr5: null, orb_minutes: null,
  });
  // a pick changed after Place goes to the same plan, and only the picks change
  s.run("toggleTradeTactic('pivot30')");
  await settle();
  assert.equal(s.plans().length, 1);
  assert.deepEqual(s.plans()[0].tactics, ['six20', 'pivot30']);
  assert.equal(s.plans()[0].plan.qty, 250);
});

test('how the stop was set: an ATR adjustment with the ATR, a custom stop with the level it sat off', async () => {
  const s = await sheet();
  s.run("state.stopStrategy = 'atr'; state.atrMultiplier = 0.5; state.atr5 = { symbol: 'TEST', value: 0.4 }; renderShares()");
  await s.run('openTrade()');
  await s.run('placeTrade()');
  const atr = s.plans()[0].plan;
  assert.deepEqual([atr.stop_source, atr.stop_strategy, atr.stop_amount, atr.atr5, atr.stop_level, atr.stop, atr.stop_planned], ['auto', 'atr', 0.5, 0.4, 98, 97.8, 97.8]);

  const c = await sheet();
  c.run("state.stopStrategy = 'atr'; state.atrMultiplier = 0.5; state.atr5 = { symbol: 'TEST', value: 0.4 }; document.getElementById('stopLong').value = '97.333'; renderShares()");
  await c.run('openTrade()');
  await c.run('placeTrade()');
  const custom = c.plans()[0].plan;
  assert.deepEqual([custom.stop_source, custom.stop_strategy, custom.stop_amount, custom.atr5, custom.stop_level, custom.stop_planned], ['custom', null, null, 0.4, 98, 97.333], 'the adjustment did not apply, so it is not recorded');
  assert.equal(custom.stop, 97.34, 'the stop sent, on Schwab\'s tick toward the entry');
});

test('a typed account size is kept beside the Schwab value; without a Schwab read the plan still saves', async () => {
  const s = await sheet({ net: schwab({ value: null }), storage: connected([['schwab_acct_source', 'manual']]) });
  s.run("document.getElementById('accountSize').value = '60000'; syncRiskDollar()");
  await s.run('openTrade()');
  await s.run('placeTrade()');
  const p = s.plans()[0].plan;
  assert.deepEqual([p.account_size, p.account_source, p.schwab_value, p.schwab_value_at], [60000, 'typed', null, null]);
});

test('a lost answer keeps the plan without an id; a rejected order or one never sent keeps none', async () => {
  const lost = await sheet({ net: schwab({ place: () => { throw new TypeError('Failed to fetch'); } }) });
  await lost.run('openTrade()');
  await lost.run('placeTrade()');
  assert.deepEqual(lost.plans().map(p => p.order_ids), [[]]);

  const rejected = await sheet({ net: schwab({ place: () => json({ message: 'no buying power' }, 400) }) });
  await rejected.run('openTrade()');
  await rejected.run('placeTrade()');
  assert.equal(rejected.plans().length, 0);
  assert.match(rejected.body(), /data-action="pickTradeLevel"[^>]* disabled/, 'nothing to save the picks with');
});

test('signed out, the sheet says where the picks would go and saves nothing', async () => {
  const s = await sheet({ signedIn: false });
  await s.run('openTrade()');
  await s.run('placeTrade()');
  assert.match(s.body(), /Sign in with Google to keep the setup, tactic and plan with the order\./);
  assert.doesNotMatch(s.body(), /pickTradeLevel/);
});

test('a plan that can\'t be saved says so; the order stands', async () => {
  const s = await sheet({ tweak: db => db.failTable('order_plans') });
  await s.run('openTrade()');
  await s.run('placeTrade()');
  assert.match(s.elements.get('errorBox').textContent, /Order sent\. Its plan wasn't saved for the journal: the database doesn't have the order_plans table yet/);
  assert.equal(s.state.tradeTicket.orderId, '1001');
});

test('a database error that names a column is shown as it is, not as a missing table', async () => {
  const s = await sheet({ tweak: db => db.fail({ status: 400, message: 'null value in column "sent_at" of relation "order_plans" violates not-null constraint' }) });
  await s.run('openTrade()');
  await s.run('placeTrade()');
  assert.match(s.elements.get('errorBox').textContent, /Its plan wasn't saved for the journal: null value in column "sent_at"/);
  assert.doesNotMatch(s.elements.get('errorBox').textContent, /db push/);
});

// ---------- the journal ----------

const ENTRY = {
  orderId: 501, enteredTime: '2026-10-01T14:30:00+0000', status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction: 'BUY', quantity: 100, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7001, executionLegs: [{ legId: 1, quantity: 100, price: 100.02, time: '2026-10-01T14:30:01+0000' }] }],
  childOrderStrategies: [{
    orderId: 502, status: 'FILLED', orderType: 'STOP', stopPrice: 97.5,
    orderLegCollection: [{ legId: 1, instruction: 'SELL', quantity: 100, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7002, executionLegs: [{ legId: 1, quantity: 100, price: 97.48, time: '2026-10-02T15:00:00+0000' }] }],
  }],
};
const KEY = '6789|AAPL|long|2026-10-01T14:30:01.000Z';
const PLAN = {
  user_id: 'user-1', id: 'p1', account: '6789', symbol: 'AAPL', side: 'long', order_ids: ['501'], sent_at: '2026-10-01T14:30:00.000Z',
  setups: ['ema21_bounce'], tactics: ['pivot15'], trade_key: null,
  plan: { qty: 100, entry_type: 'MARKET', entry: 100, stop: 97.5, planned_risk: 250, schwab_value: 52100, schwab_value_at: '2026-10-01T14:30:01.000Z',
    stop_source: 'auto', stop_strategy: 'atr', stop_amount: 0.5, stop_level: 97.71, stop_level_name: 'LOD', atr5: 0.42 },
};

async function journal(tweak) {
  const supabase = fakeRecords([{ kind: 'order', record_id: '501', account: '6789', entered_at: '2026-10-01T14:30:00Z', data: ENTRY }]);
  supabase.tables.order_plans.set('user-1:p1', structuredClone(PLAN));
  if (tweak) tweak(supabase);
  const a = await app({ supabase, session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  const labels = () => [...supabase.tables.trade_labels.values()].filter(l => l.trade_key === KEY).map(l => [l.kind, l.value, l.set_by]);
  return { ...a, supabase, labels, plan: () => supabase.tables.order_plans.get('user-1:p1') };
}

test('the setup gets a grade, A to F: saved with the plan, and a change after Place updates it', async () => {
  const s = await sheet();
  await s.run('openTrade()');
  await settle();
  assert.deepEqual([...s.body().matchAll(/data-action="setTradeGrade" data-arg="([A-F])"/g)].map(m => m[1]), ['A', 'B', 'C', 'D', 'F']);
  s.run("setTradeGrade('B')");
  assert.match(s.picks(), /class="tp-grade-btn g-B active" aria-pressed="true" data-action="setTradeGrade" data-arg="B"/);
  assert.match(s.picks(), /<button class="tp-picked tp-picked-grade g-B" data-action="setTradeGrade" data-arg="B"/, 'on the plan line too');
  s.run("setTradeGrade('B')");
  assert.equal(s.state.tradeTicket.setupGrade, '', 'tapping the lit one clears it');
  s.run("setTradeGrade('A++'); setTradeGrade('A')");
  assert.equal(s.state.tradeTicket.setupGrade, 'A', 'only A to F');
  await s.run('placeTrade()');
  assert.equal(s.plans()[0].setup_grade, 'A');
  s.run("setTradeGrade('C')");
  await settle();
  assert.equal(s.plans()[0].setup_grade, 'C');
  s.run("setTradeGrade('C')");
  await settle();
  assert.equal(s.plans()[0].setup_grade, null);
});

test('no grade picked saves none; before the grade column is pushed the plan still saves and says the grade wasn\'t kept', async () => {
  const s = await sheet();
  await s.run('openTrade()');
  await s.run('placeTrade()');
  assert.equal(s.plans()[0].setup_grade, null);
  const t = await sheet({ tweak: db => db.failColumn('order_plans', 'setup_grade') });
  await t.run('openTrade()');
  await settle();
  t.run("setTradeGrade('B'); toggleTradeSetup('base_breakout')");
  await t.run('placeTrade()');
  await settle();
  assert.deepEqual(t.plans()[0].setups, ['base_breakout']);
  assert.equal('setup_grade' in t.plans()[0], false);
  assert.match(t.elements.get('errorBox').textContent, /Order sent and its plan saved, but not the setup grade: .*setup_grade/);
});

test('desktop: the plan typed on one line, Enter picks it and clears the line', async () => {
  const s = await sheet();
  await s.run('openTrade()');
  await settle();
  assert.match(s.picks(), /<div class="tp-quick"><input type="text" id="tradeQuick"[^>]*data-input="tradeQuickInput" data-enter="applyTradeQuick"/);
  s.run("tradeQuickInput('21 ur, 15 piv, a')");
  assert.equal(s.elements.get('tradeQuickPreview').innerHTML, '21 EMA undercut &amp; rally · 15m pivot · A');
  s.run('applyTradeQuick()');
  const t = s.state.tradeTicket;
  assert.deepEqual([t.setups, t.tactics, t.setupGrade, s.state.tradeQuickText], [['ema21_unr'], ['pivot15'], 'A', '']);
  s.run("tradeQuickInput('21 ur, earn, 6/20, zzz')");
  assert.match(s.elements.get('tradeQuickPreview').innerHTML, /Earnings gap · 6\/20 \(Gil Morales\) · <span class="tp-need">no match: zzz<\/span>/);
  s.run('applyTradeQuick()');
  assert.deepEqual([t.setups, t.tactics, t.setupGrade], [['ema21_unr', 'earnings_gap'], ['pivot15', 'six20'], 'A'], 'nothing already on comes off');
});

test('the typed line\'s parts: a grade, a tactic when it starts with a timeframe, else a setup first', async () => {
  const { parseQuickPick, levelPickGroups } = await import('../src/core/journal-labels.js');
  // names as setupSearchNames gives them: the setup's, and what it adds up under ('Undercut & rally' is found by 'ur')
  const setups = [{ key: 'u21', names: ['21 EMA undercut & rally', 'Undercut & rally'] }, { key: 'b50', names: ['50 SMA bounce', 'Bounce'] }, { key: 'b9', names: ['9 EMA bounce', 'Bounce'] }];
  const tactics = [{ key: 'orb5', names: ['5m ORB'] }, { key: 'e9', names: ['5m 9 EMA bounce'] }, { key: 'rdr', names: ['RDR'] }];
  assert.deepEqual(parseQuickPick('21 ur, 5 9, b', setups, tactics), { setups: ['u21'], tactics: ['e9'], grade: 'B', unmatched: [] });
  assert.deepEqual(parseQuickPick('9 b; rdr · f', setups, tactics), { setups: ['b9'], tactics: ['rdr'], grade: 'F', unmatched: [] });
  assert.deepEqual(parseQuickPick('50 b, nope', setups, tactics), { setups: ['b50'], tactics: [], grade: '', unmatched: ['nope'] });
  assert.deepEqual(levelPickGroups(['4 EMA', '9 WK EMA', 'AVWAP from ATH', 'Support', '200 SMA'].map(name => ({ key: name, name }))).map(g => [g.name, g.items.map(i => i.label)]),
    [['Daily', ['4 EMA', '200 SMA']], ['Weekly', ['9 WK EMA']], ['AVWAP', ['AVWAP from ATH']], ['Other', ['Support']]]);
});

test('the journal puts a plan\'s setup and tactic on the trade its order opened, once, as the app\'s', async () => {
  const j = await journal();
  assert.deepEqual(j.labels(), [['setup', 'ema21_bounce', 'app'], ['tactic', 'pivot15', 'app']]);
  assert.equal([...j.supabase.tables.trade_labels.values()][0].reason, 'Picked when the order was placed');
  assert.equal(j.plan().trade_key, KEY);
  // you take the tactic off: the next load leaves it off
  j.supabase.tables.trade_labels.delete(`user-1:${KEY}:tactic:pivot15`);
  await j.run('loadJournal()');
  assert.deepEqual(j.labels(), [['setup', 'ema21_bounce', 'app']]);
});

test('the plan\'s setup grade goes on the trade\'s review once; a grade you gave stays, and so does one you change', async () => {
  const graded = db => db.tables.order_plans.get('user-1:p1').setup_grade = 'B';
  const j = await journal(graded);
  const review = () => j.supabase.tables.trade_reviews.get(`user-1:${KEY}`);
  assert.equal(review().setup_grade, 'B');
  assert.equal(j.state.journalReview.reviews[KEY].setup_grade, 'B');
  review().setup_grade = 'D';
  await j.run('loadJournal()');
  assert.equal(review().setup_grade, 'D', 'met once: your change stays');
  const mine = await journal(db => { graded(db); db.tables.trade_reviews.set(`user-1:${KEY}`, { user_id: 'user-1', trade_key: KEY, setup_grade: 'A' }); });
  assert.equal(mine.supabase.tables.trade_reviews.get(`user-1:${KEY}`).setup_grade, 'A');
});

test('a kind you already labeled stays yours', async () => {
  const j = await journal(db => db.tables.trade_labels.set(`user-1:${KEY}:setup:base_breakout`, { user_id: 'user-1', trade_key: KEY, kind: 'setup', value: 'base_breakout', set_by: 'you' }));
  assert.deepEqual(j.labels(), [['setup', 'base_breakout', 'you'], ['tactic', 'pivot15', 'app']]);
});

test('the trade page shows the order plan: risk against the Schwab account, planned and actual, and the stop', async () => {
  const j = await journal();
  j.run(`openJournalTrade('${KEY}')`);
  await settle();
  const page = j.elements.get('jtBody').innerHTML;
  assert.match(page, /<div class="jr-label">Order plan<\/div>/);
  assert.match(page, /0\.48% of Schwab ••6789 \(\$250\.00 of \$52,100\) · 100 sh · stop LOD − 0\.5× ATR\(5m\) at \$97\.50 \(LOD \$97\.71, ATR\(5m\) \$0\.42\)/);
  assert.match(page, /Actual risk 0\.48% \(\$252\.00\)/, 'from the fill and the stop');
});

test('order plans not pushed yet: the journal works as before', async () => {
  const j = await journal(db => db.failTable('order_plans'));
  assert.deepEqual(j.labels(), []);
  assert.match(j.elements.get('journalSection').innerHTML, /AAPL/);
});

test('entry tactics group by the timeframe their names start with, however it is written; old default names still find theirs', async () => {
  const { tacticPickGroups, tacticTimeframe, goesBy, buildLibrary } = await import('../src/core/journal-labels.js');
  const names = ['6/20 (Gil Morales)', '15m pivot', '30m pivot', 'N/A', 'VWAP bounce', '5m 9 EMA bounce', '5m 21 EMA bounce', '30m ORB', 'PDH/L break', '5m flag break', '15-minute ORB', 'RDR', '5m ORB'];
  const groups = tacticPickGroups(names.map((name, i) => ({ key: 'k' + i, name })));
  assert.deepEqual(groups.map(g => [g.name, g.items.map(i => i.label)]), [
    ['5m', ['9 EMA bounce', '21 EMA bounce', 'Flag break', 'ORB']],
    ['15m', ['Pivot', 'ORB']],
    ['30m', ['Pivot', 'ORB']],
    ['Other', ['6/20 (Gil Morales)', 'N/A', 'VWAP bounce', 'PDH/L break', 'RDR']],
  ]);
  assert.equal(groups[1].items[1].name, '15-minute ORB', 'the chip\'s title keeps the whole name');
  assert.deepEqual(tacticTimeframe('30 min ORB'), { minutes: 30, rest: 'ORB' });
  assert.deepEqual(tacticPickGroups([{ key: 'a', name: '5m' }]).map(g => g.name), ['Other'], 'a bare timeframe is a name, not a group');
  const pivot = buildLibrary([]).item('tactic', 'pivot15');
  assert.equal(pivot.name, '15m pivot');
  assert.equal(goesBy('tactic', pivot, '15-MINUTE pivot'), true);
  assert.equal(goesBy('tactic', { ...pivot, own: true }, '15-minute pivot'), false, 'only a default keeps its old names');
});
