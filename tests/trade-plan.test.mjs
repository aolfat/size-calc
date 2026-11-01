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
  return { ...a, net, supabase, plans, body: () => a.elements.get('tradeBody').innerHTML, picks: () => a.elements.get('tradePlan').innerHTML };
}

test('the sheet offers your setups and entry tactics; today\'s focus list and the opening range fill them in', async () => {
  const s = await sheet({ focus: [{ id: 'f1', symbol: 'TEST', side: 'long', setups: ['ema21_bounce'] }] });
  s.run("state.orb = { symbol: 'TEST', minutes: 15, isLong: true, high: 100.5, low: 98, end: '09:45', entry: 100.51, stop: 98 }; document.getElementById('entryPrice').value = '100.51'; document.getElementById('stopLong').value = '98'; renderShares()");
  await s.run('openTrade()');
  await settle();
  const t = s.state.tradeTicket;
  assert.deepEqual([t.setups, t.tactics], [['ema21_bounce'], ['pivot15']]);
  // read before the sheet opened (the trade button starts it), so the picks are drawn with the sheet
  assert.match(s.body(), /<dt>Setup<\/dt>/);
  assert.match(s.body(), /class="filter-btn active" aria-pressed="true" data-action="toggleTradeSetup" data-arg="ema21_bounce">21 EMA bounce</);
  assert.match(s.body(), /class="filter-btn active" aria-pressed="true" data-action="toggleTradeTactic" data-arg="pivot15">15-minute pivot</);
  assert.match(s.body(), /data-action="toggleTradeTactic" data-arg="six20">6\/20/);
  s.run("toggleTradeSetup('ema21_bounce'); toggleTradeSetup('base_breakout'); toggleTradeTactic('pivot15'); toggleTradeTactic('six20')");
  assert.deepEqual([s.state.tradeTicket.setups, s.state.tradeTicket.tactics], [['base_breakout'], ['six20']]);
  s.run("tradeSetupSearch('earn')");
  assert.match(s.elements.get('tradeSetupPick').innerHTML, /Earnings gap/);
  assert.doesNotMatch(s.elements.get('tradeSetupPick').innerHTML, /8 EMA bounce/, 'the search narrows them');
  assert.match(s.elements.get('tradeSetupPick').innerHTML, /Base breakout/, 'one that is on stays');
});

const setupOrder = html => [...html.matchAll(/data-action="toggleTradeSetup" data-arg="([^"]+)"/g)].map(m => m[1]);

test('your setups are read as soon as the trade button shows, once, so the sheet opens with them in place', async () => {
  const s = await sheet();
  s.run('renderShares(); renderShares()');
  await settle();
  assert.equal(s.supabase.reads.filter(r => r.table === 'library_items').length, 1, 'read once, before any review');
  await s.run('openTrade()');
  assert.doesNotMatch(s.body(), /Loading your setups/, 'nothing arrives after the sheet is up to push the buttons down');
  assert.match(s.body(), /data-action="toggleTradeSetup"/);
});

test('tapping a setup lights it where it is: the chips never move under your finger', async () => {
  const s = await sheet({ focus: [{ id: 'f1', symbol: 'TEST', side: 'long', setups: ['ema21_bounce'] }] });
  await settle();
  await s.run('openTrade()');
  const before = setupOrder(s.body());
  assert.equal(before[0], 'ema21_bounce', 'the focus list\'s setup leads');
  s.run(`toggleTradeSetup('${before[3]}')`);
  assert.deepEqual(setupOrder(s.picks()), before);
  assert.match(s.picks(), new RegExp(`class="filter-btn active" aria-pressed="true" data-action="toggleTradeSetup" data-arg="${before[3]}"`));
  s.run("toggleTradeSetup('ema21_bounce')");
  assert.deepEqual(setupOrder(s.picks()), before, 'off again, it stays put too');
  s.run("tradeSetupSearch('earn'); tradeSetupSearch('')");
  assert.deepEqual(setupOrder(s.elements.get('tradeSetupPick').innerHTML), before, 'a search cleared gives back the same order');
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
  assert.match(rejected.body(), /data-action="toggleTradeSetup"[^>]* disabled/, 'nothing to save the picks with');
});

test('signed out, the sheet says where the picks would go and saves nothing', async () => {
  const s = await sheet({ signedIn: false });
  await s.run('openTrade()');
  await s.run('placeTrade()');
  assert.match(s.body(), /Sign in with Google to keep the setup, tactic and plan with the order\./);
  assert.doesNotMatch(s.body(), /toggleTradeSetup/);
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
