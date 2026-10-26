// Run with: node --test
// Schwab trading: the order payload, login through the worker, the review sheet's one-send rule, and the worker itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import worker from '../worker/schwab/worker.js';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const json = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

// a device that already logged in: live tokens and one account picked
const connected = (extra = []) => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }])],
  ['schwab_account', 'HASH1'],
  ...extra,
]);

const QUOTE = { symbol: 'TEST', type: 'stock', last: 100, bid: 99.98, ask: 100.02, low: 98, high: 102 };

// a fake network: Tradier quotes answer with QUOTE, Schwab calls go to the handler, every call is logged
function network(schwab) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    if (url.startsWith(PROXY)) return schwab(url.slice(PROXY.length), init);
    if (url.includes('/markets/quotes')) return json({ quotes: { quote: QUOTE } });
    return json({});
  };
  // schwabCalls leaves out the /callback lookup: it only reads the worker's setting, never touches a login
  return { calls, fetch, schwabCalls: () => calls.filter(c => c.url.startsWith(PROXY) && !c.url.endsWith('/callback')) };
}

// the status line under the review's buttons (rendered into the sheet body)
const result = elements => elements.get('tradeBody').innerHTML.match(/id="tradeResult" role="status">([^<]*)</)[1];

async function sharesCard(opts) {
  const h = await app(opts);
  h.run(`quoteData = ${JSON.stringify(QUOTE)};
    document.getElementById('ticker').value = 'TEST';
    document.getElementById('apiKey').value = 'tradier-test';
    document.getElementById('riskDollar').value = '500';
    renderShares();`);
  return h;
}

// ---------- the order ----------

test('a long is a market buy that triggers a sell stop for the same shares', async () => {
  const { run } = await app();
  const order = run("sharesStopOrder({ symbol: 'TEST', qty: 250, isLong: true, stop: 98, stopDuration: 'GOOD_TILL_CANCEL' })");
  assert.deepEqual(JSON.parse(JSON.stringify(order)), {
    orderType: 'MARKET', session: 'NORMAL', duration: 'DAY', orderStrategyType: 'TRIGGER',
    orderLegCollection: [{ instruction: 'BUY', quantity: 250, instrument: { symbol: 'TEST', assetType: 'EQUITY' } }],
    childOrderStrategies: [{
      orderType: 'STOP', session: 'NORMAL', duration: 'GOOD_TILL_CANCEL', orderStrategyType: 'SINGLE', stopPrice: 98,
      orderLegCollection: [{ instruction: 'SELL', quantity: 250, instrument: { symbol: 'TEST', assetType: 'EQUITY' } }],
    }],
  });
  const short = run("sharesStopOrder({ symbol: 'TEST', qty: 10, isLong: false, stop: 102, stopDuration: 'DAY' })");
  assert.equal(short.orderLegCollection[0].instruction, 'SELL_SHORT');
  assert.equal(short.childOrderStrategies[0].orderLegCollection[0].instruction, 'BUY_TO_COVER');
  assert.equal(short.childOrderStrategies[0].duration, 'DAY');
});

test('a limit entry is the same trigger with a price: buy at the limit or better, then the stop', async () => {
  const { run } = await app();
  const order = JSON.parse(JSON.stringify(run("sharesStopOrder({ symbol: 'TEST', qty: 250, isLong: true, stop: 98, stopDuration: 'GOOD_TILL_CANCEL', entryType: 'LIMIT', entryLimit: 99.5 })")));
  assert.deepEqual([order.orderType, order.price, order.duration, order.orderStrategyType, order.stopPrice], ['LIMIT', 99.5, 'DAY', 'TRIGGER', undefined]);
  assert.deepEqual([order.childOrderStrategies[0].orderType, order.childOrderStrategies[0].stopPrice], ['STOP', 98]);
  assert.equal(run("limitEntryError({ isLong: true, stop: 98, limit: 99.5 })"), '');
  assert.match(run("limitEntryError({ isLong: true, stop: 98, limit: 98 })"), /The limit \$98\.00 is at or below the stop \$98\.00/);
  assert.match(run("limitEntryError({ isLong: false, stop: 102, limit: 102.5 })"), /The limit \$102\.50 is at or above the stop \$102\.00/);
  assert.equal(run("limitEntryError({ isLong: true, stop: 98, limit: 0 })"), 'Set a limit price.');
});

test('the stop snaps to the tick toward the entry, never looser than the plan', async () => {
  const { run } = await app();
  assert.equal(run('stopTick(45.973, true)'), 45.98);
  assert.equal(run('stopTick(45.973, false)'), 45.97);
  assert.equal(run('stopTick(0.12345, true)'), 0.1235);
  assert.equal(run('stopTick(0.12345, false)'), 0.1234);
  assert.equal(run('stopTick(10.1, true)'), 10.1, 'a price already on the tick stays put');
  assert.equal(run('stopTick(10.1, false)'), 10.1);
});

test('a ticket is refused when the stop is already through the market or the size is empty', async () => {
  const { run } = await app();
  const err = t => run(`sharesTicketError(${JSON.stringify({ symbol: 'TEST', type: 'stock', qty: 10, bid: 99.98, ask: 100.02, last: 100, ...t })})`);
  assert.equal(err({ isLong: true, stop: 98 }), '');
  assert.match(err({ isLong: true, stop: 99.98 }), /at or above the bid/);
  assert.equal(err({ isLong: false, stop: 102 }), '');
  assert.match(err({ isLong: false, stop: 100.02 }), /at or below the ask/);
  assert.match(err({ isLong: true, stop: 98, qty: 0 }), /under one share/);
  assert.match(err({ isLong: true, stop: 98, type: 'index', symbol: 'SPX' }), /not a stock or ETF/);
});

test('regular hours are weekdays 9:30 to 16:00 in New York', async () => {
  const { run } = await app();
  // Monday 2026-10-05, New York on daylight time (UTC-4)
  assert.equal(run('inRegularHours(Date.UTC(2026, 9, 5, 14, 0))'), true);
  assert.equal(run('inRegularHours(Date.UTC(2026, 9, 5, 13, 29))'), false);
  assert.equal(run('inRegularHours(Date.UTC(2026, 9, 5, 20, 0))'), false);
  assert.equal(run('inRegularHours(Date.UTC(2026, 9, 10, 14, 0))'), false, 'Saturday');
});

// ---------- login ----------

test('the callback address gives up its code whole or as a bare query', async () => {
  const { run } = await app();
  assert.deepEqual({ ...run("parseSchwabRedirect('https://127.0.0.1/?code=C0.abc%40def&session=s1&state=xyz')") }, { code: 'C0.abc@def', state: 'xyz' });
  assert.deepEqual({ ...run("parseSchwabRedirect('?code=abc')") }, { code: 'abc', state: '' });
  assert.equal(run("parseSchwabRedirect('https://127.0.0.1/')"), null);
});

test('logging in swaps the pasted code through the worker and keeps only the account hash and last four', async () => {
  const net = network(async (path, init) => {
    if (path === '/token') return json({ access_token: 'acc-1', refresh_token: 'ref-1', expires_in: 1800 });
    if (path === '/trader/v1/accounts/accountNumbers') return json([{ accountNumber: '12346789', hashValue: 'HASH1' }]);
    return json({}, 404);
  });
  const storage = new Map([['schwab_proxy', PROXY]]);
  const { run, elements } = await app({ fetch: net.fetch, storage });
  run('var opened = []; window.open = url => { opened.push(url); }; connectSchwab()');
  const oauthState = storage.get('schwab_oauth_state');
  assert.match(oauthState, /^[0-9a-f]{32}$/);
  assert.deepEqual([...run('opened')], [`${PROXY}/login?state=${oauthState}`]);

  elements.get('schwabRedirect').value = `https://127.0.0.1/?code=C0.abc%40def&session=s1&state=${oauthState}`;
  assert.equal(await run('finishSchwab()'), true);
  const [token, accounts] = net.schwabCalls();
  assert.equal(token.url, PROXY + '/token');
  assert.deepEqual(JSON.parse(token.body), { code: 'C0.abc@def' });
  assert.equal(accounts.headers.Authorization, 'Bearer acc-1');
  assert.deepEqual(JSON.parse(storage.get('schwab_accounts')), [{ hash: 'HASH1', last4: '6789' }], 'the full account number is not kept');
  assert.equal(storage.get('schwab_account'), 'HASH1');
  assert.equal(storage.has('schwab_oauth_state'), false, 'a used login attempt is cleared');
  assert.equal(elements.get('schwabRedirect').value, '', 'the code leaves the field');
  assert.match(elements.get('schwabStatus').innerHTML, /Connected · ••6789 · 7d left on login/);
  assert.equal(elements.get('schwabLogin').style.display, 'none');
});

test('signed in to Google, the callback page finishes the Schwab login it started', async () => {
  const net = network(async path => {
    if (path === '/token') return json({ access_token: 'acc-1', refresh_token: 'ref-1', expires_in: 1800 });
    if (path === '/trader/v1/accounts/accountNumbers') return json([{ accountNumber: '12346789', hashValue: 'HASH1' }]);
    return json({}, 404);
  });
  const user = { id: 'u1', email: 'me@example.com' };
  const session = { user, access_token: 'jwt' };
  const answer = data => Promise.resolve({ data, error: null, status: 200 });
  const supabase = {
    auth: { getSession: async () => ({ data: { session } }), onAuthStateChange: () => ({ data: { subscription: {} } }) },
    from: () => ({ select: () => ({ gt() { return this; }, then: (ok, bad) => answer([]).then(ok, bad) }), upsert: () => answer(null) }),
    rpc: () => answer(''),
  };
  // an expired login from last week, the attempt this device just started, and a Google session to resume
  const storage = new Map([['schwab_proxy', PROXY], ['schwab_oauth_state', 'mine'], ['cloud_user', 'u1'],
    ['sb-dhohfavttsxwutanvcuj-auth-token', 'stored'],
    ['schwab_tokens', JSON.stringify({ userId: 'u1', proxy: PROXY, connectionId: 'old', access: 'a', accessExp: 0, refresh: 'r', refreshExp: Date.now() - DAY })]]);
  const { run, elements } = await app({ fetch: net.fetch, storage, supabase });
  const href = 'https://size-calc.example.workers.dev/size-calc/?code=C1&session=s1&state=mine';
  await run(`initCloud('${href}')`); // main.js restores the Google session first, then finishes the Schwab login
  assert.equal(storage.get('schwab_oauth_state'), 'mine', 'the attempt outlives clearing the expired login');
  assert.equal(storage.has('schwab_tokens'), false, 'the expired login is gone');
  assert.equal(await run(`initSchwab('${href}')`), undefined);
  assert.equal(elements.get('errorBox').textContent, 'Schwab connected. Account ••6789.', 'connected, not "another attempt"');
  assert.equal(net.schwabCalls()[0]?.url, PROXY + '/token');
  assert.equal(JSON.parse(storage.get('schwab_tokens')).userId, 'u1', 'the new login belongs to this Google user');
  assert.equal(storage.has('schwab_oauth_state'), false, 'and the attempt is spent');
});

test('a callback page with someone else\'s state is ignored', async () => {
  const net = network(async () => json({}, 500));
  const storage = new Map([['schwab_proxy', PROXY], ['schwab_oauth_state', 'mine']]);
  const { run, elements } = await app({ fetch: net.fetch, storage });
  await run("initSchwab('https://size-calc.example.workers.dev/size-calc/?code=attacker&state=theirs')");
  await run("initSchwab('https://size-calc.example.workers.dev/size-calc/?code=attacker')");
  assert.equal(net.schwabCalls().length, 0);
  assert.match(elements.get('errorBox').textContent, /another attempt/);
});

test('a login attempt is used once: a wrong state or a refused code means logging in again', async () => {
  const wrong = new Map([['schwab_proxy', PROXY], ['schwab_oauth_state', 'mine']]);
  const a = await app({ fetch: network(async () => json({}, 500)).fetch, storage: wrong });
  await a.run("initSchwab('https://size-calc.example.workers.dev/size-calc/?code=attacker&state=theirs')");
  assert.equal(wrong.has('schwab_oauth_state'), false);

  const refused = new Map([['schwab_proxy', PROXY], ['schwab_oauth_state', 'mine']]);
  const b = await app({ fetch: network(async () => json({ error: 'invalid_grant' }, 400)).fetch, storage: refused });
  b.elements.get('schwabRedirect').value = 'https://127.0.0.1/?code=old&state=mine';
  assert.equal(await b.run('finishSchwab()'), false);
  assert.equal(refused.has('schwab_oauth_state'), false);
});

test("the Schwab code leaves the address bar at boot; Google's return is left for the sign-in", async () => {
  const { run } = await app();
  run('var replaced = []; history = { replaceState: (s, t, u) => replaced.push(u) }');
  run("stripSchwabCallback('https://app.example/size-calc/?code=c1&state=s1#positions')");
  run("stripSchwabCallback('https://app.example/size-calc/?login=google&code=g1')");
  run("stripSchwabCallback('https://app.example/size-calc/#journal')");
  assert.deepEqual([...run('replaced')], ['/size-calc/#positions']);
});

test('a brokerage connection is usable only by the Google user and worker it was created for', async () => {
  const storage = connected();
  const tokens = JSON.parse(storage.get('schwab_tokens'));
  Object.assign(tokens, { userId: 'alice', proxy: PROXY, connectionId: 'connection-1' });
  storage.set('schwab_tokens', JSON.stringify(tokens));
  const { run, state } = await app({ storage, session: { user: { id: 'alice' } } });
  assert.equal(run('schwabConnected()'), true);
  state.session = { user: { id: 'bob' } };
  assert.equal(run('schwabConnected()'), false);
  await assert.rejects(run("schwabApi('/accounts/accountNumbers')"), /Log in/);
  state.session = { user: { id: 'alice' } };
  storage.set('schwab_proxy', 'https://another-worker.example');
  assert.equal(run('schwabConnected()'), false);
});

test('a legacy connection without an owner and worker binding requires a new broker login', async () => {
  const storage = connected();
  const tokens = JSON.parse(storage.get('schwab_tokens'));
  delete tokens.userId;
  delete tokens.proxy;
  delete tokens.connectionId;
  storage.set('schwab_tokens', JSON.stringify(tokens));
  const { run } = await app({ storage });
  assert.equal(run('schwabConnected()'), false);
});

test('a code exchange finishing after the Google user changes cannot restore the old connection', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const net = network(async () => { await gate; return json({ access_token: 'dummy', refresh_token: 'dummy', expires_in: 1800 }); });
  const storage = new Map([['schwab_proxy', PROXY]]);
  const { run, state } = await app({ fetch: net.fetch, storage, session: { user: { id: 'alice' } } });
  const exchange = run("schwabExchangeCode('dummy-code')");
  state.session = { user: { id: 'bob' } };
  release();
  await assert.rejects(exchange, /changed/);
  assert.equal(storage.has('schwab_tokens'), false);
});

test('an accounts response body finishing after disconnect cannot restore account details', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const net = network(async () => ({ ok: true, status: 200, async text() { await gate; return JSON.stringify([{ accountNumber: '11111111', hashValue: 'OLD' }]); } }));
  const storage = connected();
  const { run } = await app({ fetch: net.fetch, storage });
  const accounts = run('schwabFetchAccounts()');
  await settle();
  run('schwabDisconnect()');
  release();
  await assert.rejects(accounts, /changed/);
  assert.equal(storage.has('schwab_accounts'), false);
  assert.equal(storage.has('schwab_account'), false);
});

test('Schwab logins never travel in the account; only the worker URL syncs', async () => {
  const storage = connected([]);
  const { run } = await app({ storage, session: { user: { id: 'u1' } } });
  assert.deepEqual(run('CLOUD_KEYS.filter(k => k.startsWith("schwab"))'), ['schwab_proxy']);
  run("store.set('schwab_tokens', 'changed'); store.set('schwab_account', 'HASH2'); store.set('schwab_stop_duration', 'DAY')");
  assert.equal(storage.get('cloud_pending'), undefined);
  run("store.set('schwab_proxy', 'https://other.example')");
  assert.deepEqual(JSON.parse(storage.get('cloud_pending')), ['schwab_proxy']);
});

test('Google\'s return carries a code too, and the Schwab callback leaves it alone', async () => {
  const storage = new Map([['schwab_proxy', PROXY], ['schwab_oauth_state', 'mine']]);
  const net = network(async () => json({}, 500));
  const { run, elements } = await app({ fetch: net.fetch, storage });
  await run("initSchwab('https://size-calc.example.workers.dev/size-calc/?login=google&code=from-google')");
  assert.equal(net.schwabCalls().length, 0);
  assert.equal(elements.get('errorBox').textContent, '', 'no Schwab error for a Google sign-in');
});

test('an expired access token refreshes once before the call; a refused refresh ends the login', async () => {
  const stale = connected([['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'old', accessExp: Date.now() - 1000, refresh: 'ref-1', refreshExp: Date.now() + DAY })]]);
  const net = network(async path => path === '/refresh' ? json({ access_token: 'fresh', expires_in: 1800 }) : json([]));
  const { run } = await app({ fetch: net.fetch, storage: stale });
  await run("Promise.all([schwabApi('/accounts/accountNumbers'), schwabApi('/accounts/accountNumbers')])");
  const calls = net.schwabCalls();
  assert.equal(calls.filter(c => c.url.endsWith('/refresh')).length, 1, 'concurrent calls share one refresh');
  assert.deepEqual(JSON.parse(calls[0].body), { refresh_token: 'ref-1' });
  assert.ok(calls.slice(1).every(c => c.headers.Authorization === 'Bearer fresh'));
  assert.equal(JSON.parse(stale.get('schwab_tokens')).refresh, 'ref-1', 'the refresh token carries over when Schwab sends none');

  const over = connected([['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'old', accessExp: 0, refresh: 'dead', refreshExp: Date.now() + DAY })]]);
  const refused = network(async () => json({ error: 'invalid_grant' }, 400));
  const second = await app({ fetch: refused.fetch, storage: over });
  await assert.rejects(second.run("schwabApi('/accounts/accountNumbers')"), /login expired/);
  assert.equal(over.has('schwab_tokens'), false);
});

test('the paste box hides when the worker says Schwab sends you back to this app', async () => {
  const APP = 'https://size-calc.example.workers.dev/size-calc/';
  const setup = async callback => {
    const net = network(async path => path === '/callback'
      ? (callback === undefined ? json({ message: 'not found' }, 404) : json({ callback }))
      : json({}, 500));
    const h = await app({ fetch: net.fetch, storage: new Map([['schwab_proxy', PROXY]]) });
    h.run(`location = { href: '${APP}' }; window.open = () => null`);
    await h.run('refreshSchwabCallback()');
    return h;
  };

  const own = await setup('https://size-calc.example.workers.dev/size-calc/');
  assert.equal(own.elements.get('schwabPaste').style.display, 'none');
  own.run('connectSchwab()');
  assert.match(own.elements.get('schwabNote').textContent, /connects by itself/);

  const noSlash = await setup('https://size-calc.example.workers.dev/size-calc');
  assert.equal(noSlash.elements.get('schwabPaste').style.display, 'none', 'a trailing slash is the same page');

  const dead = await setup('https://127.0.0.1');
  assert.equal(dead.elements.get('schwabPaste').style.display, '', 'a 127.0.0.1 callback still needs the paste');
  dead.run('connectSchwab()');
  assert.match(dead.elements.get('schwabNote').textContent, /paste it here/);

  const old = await setup(undefined);
  assert.equal(old.elements.get('schwabPaste').style.display, '', "a worker that can't say keeps the box");
});

test('the worker URL folds to one line once it works, and Change opens it again', async () => {
  const cached = JSON.stringify({ proxy: PROXY, callback: 'https://size-calc.example.workers.dev/size-calc/' });
  const shown = (els, id) => els.get(id).style.display !== 'none';

  const fresh = await app({ storage: new Map() });
  fresh.run('updateSchwabUi()');
  assert.ok(shown(fresh.elements, 'schwabProxyField'), 'no worker yet: the box is where setup starts');
  assert.ok(!shown(fresh.elements, 'schwabProxyLine'));

  const unanswered = await app({ storage: new Map([['schwab_proxy', PROXY]]) });
  unanswered.run('updateSchwabUi()');
  assert.ok(shown(unanswered.elements, 'schwabProxyField'), "a worker that hasn't answered keeps the box");

  const known = await app({ storage: new Map([['schwab_proxy', PROXY], ['schwab_callback', cached]]) });
  known.run('updateSchwabUi()');
  assert.ok(!shown(known.elements, 'schwabProxyField'));
  assert.ok(shown(known.elements, 'schwabProxyLine'));
  assert.equal(known.elements.get('schwabProxyHost').textContent, 'size-calc-schwab.test.workers.dev');

  known.run('editSchwabProxy()');
  assert.ok(shown(known.elements, 'schwabProxyField'), 'Change brings the box back');
  known.run('schwabProxyDone()');
  assert.ok(!shown(known.elements, 'schwabProxyField'), 'leaving it folds it again');

  const loggedIn = await app({ storage: connected() });
  loggedIn.run('updateSchwabUi()');
  assert.ok(!shown(loggedIn.elements, 'schwabProxyField'), 'a working login proves the worker too');

  const typing = await app({ storage: new Map([['schwab_proxy', PROXY], ['schwab_callback', cached]]) });
  typing.run("document.activeElement = document.getElementById('schwabProxy'); updateSchwabUi()");
  assert.ok(shown(typing.elements, 'schwabProxyField'), 'never folds away while you type');
});

test('the callback answer is kept per worker URL and survives a logout', async () => {
  const storage = connected([['schwab_callback', JSON.stringify({ proxy: PROXY, callback: 'https://size-calc.example.workers.dev/size-calc/' })]]);
  const { run } = await app({ storage });
  run("location = { href: 'https://size-calc.example.workers.dev/size-calc/' }");
  assert.equal(run('schwabReturnsHere()'), true);
  run("store.set('schwab_proxy', 'https://other.workers.dev')");
  assert.equal(run('schwabReturnsHere()'), false, 'a different worker is asked again');
  run(`store.set('schwab_proxy', '${PROXY}'); schwabDisconnect()`);
  assert.equal(run('schwabReturnsHere()'), true);
  assert.equal(run("callbackIsHere('https://size-calc.example.workers.dev/size-calc/', 'http://localhost:8765/')"), false);
  assert.equal(run("callbackIsHere('https://size-calc.example.workers.dev/size-calc/', 'https://size-calc.example.workers.dev/size-calc/index.html?x=1#market')"), true);
  assert.equal(run("callbackIsHere('not a url', 'https://size-calc.example.workers.dev/')"), false);
});

// ---------- the banner under the header ----------

const banner = async (storage, opts = {}) => {
  const h = await app({ fetch: network(async () => json({}, 404)).fetch, storage, ...opts });
  await h.run("initSchwab('https://app.example/size-calc/')");
  return { ...h, shown: () => h.elements.get('schwabBanner').style.display !== 'none', text: () => h.elements.get('schwabBannerText').textContent };
};

test('the banner says Schwab is not connected once a worker URL is set, and stays away without one', async () => {
  const off = await banner(new Map([['schwab_proxy', PROXY]]));
  assert.equal(off.shown(), true);
  assert.match(off.text(), /isn't connected on this device/);
  assert.equal(off.elements.get('schwabBannerLogin').textContent, 'Log in to Schwab');

  const never = await banner(new Map());
  assert.equal(never.shown(), false, 'no worker URL: Schwab was never set up here');

  const fine = await banner(connected());
  assert.equal(fine.shown(), false, 'connected with days left');
});

test('the banner says a login ended, and warns in its last day', async () => {
  const ended = connected();
  const t = JSON.parse(ended.get('schwab_tokens'));
  ended.set('schwab_tokens', JSON.stringify({ ...t, refreshExp: Date.now() - 1000 }));
  const a = await banner(ended);
  assert.equal(a.shown(), true);
  assert.match(a.text(), /login ended/);

  const ending = connected();
  ending.set('schwab_tokens', JSON.stringify({ ...t, refreshExp: Date.now() + 4.5 * 3600000 }));
  const b = await banner(ending);
  assert.equal(b.shown(), true);
  assert.match(b.text(), /ends in 5h/);
  assert.equal(b.elements.get('schwabBanner').classList.contains('ending'), true);
});

test("the banner waits for boot, keeps quiet while a login waits for its Google session, and × hides it", async () => {
  const h = await app({ storage: new Map([['schwab_proxy', PROXY]]) });
  h.run('updateSchwabUi()');
  assert.equal(h.elements.get('schwabBanner').style.display, 'none', 'not before initSchwab: the Google session may still be loading');

  const waiting = connected();
  const t = JSON.parse(waiting.get('schwab_tokens'));
  waiting.set('schwab_tokens', JSON.stringify({ ...t, userId: 'u1' })); // bound to a Google user this page hasn't restored yet
  const w = await banner(waiting);
  assert.equal(w.shown(), false);

  const off = await banner(new Map([['schwab_proxy', PROXY]]));
  off.run('hideSchwabBanner()');
  assert.equal(off.shown(), false);
  off.run('updateSchwabUi()');
  assert.equal(off.shown(), false, 'hidden until the app is opened again');
});

// ---------- the trade button and review sheet ----------

test('the trade button shows only for a connected risk-sized shares trade', async () => {
  const off = await sharesCard();
  assert.equal(off.elements.get('sharesTrade').style.display, 'none', 'not connected');

  const { run, elements } = await sharesCard({ storage: connected() });
  const btn = elements.get('sharesTrade');
  assert.equal(btn.style.display, '');
  assert.equal(btn.disabled, false);
  run("document.getElementById('stopLong').value = '101'; renderShares()");
  assert.equal(btn.disabled, true, 'an invalid stop disables it');
  run("document.getElementById('stopLong').value = ''; setSizingMode('allocation')");
  assert.equal(btn.style.display, 'none', 'allocation has no stop to send');
});

test('review freezes the card\'s order, and Place sends exactly that once', async () => {
  const net = network(async (path, init) => {
    if (path === '/trader/v1/accounts/HASH1/orders' && init.method === 'POST') return json(null, 201, { Location: `${PROXY}/trader/v1/accounts/HASH1/orders/1001` });
    if (path === '/trader/v1/accounts/HASH1/orders/1001') return json({
      status: 'FILLED', orderActivityCollection: [{ executionLegs: [{ quantity: 250, price: 100.03 }] }],
      childOrderStrategies: [{ status: 'WORKING' }],
    });
    return json({}, 404);
  });
  const { run, elements, state } = await sharesCard({ fetch: net.fetch, storage: connected() });
  await run('openTrade()');
  assert.notEqual(elements.get('tradeSheet').style.display, 'none');
  const ticket = state.tradeTicket;
  assert.equal(ticket.qty, 250);
  assert.equal(ticket.stop, 98);
  assert.equal(ticket.order.childOrderStrategies[0].duration, 'GOOD_TILL_CANCEL', 'the stop outlasts the day by default');
  assert.match(elements.get('tradeBody').innerHTML, /Buy 250 TEST<\/strong><span class="shares-detail">Market order, today/);
  assert.match(elements.get('tradeBody').innerHTML, /Sell 250 at \$98\.00<\/strong><span class="shares-detail">Stop order, placed once the buy fills/);

  run("document.getElementById('riskDollar').value = '1000'; renderShares()");
  assert.equal(state.tradeTicket.qty, 250, 'later card changes do not touch an open review');

  await run('Promise.all([placeTrade(), placeTrade()])');
  await run('placeTrade()');
  const posts = net.schwabCalls().filter(c => c.method === 'POST');
  assert.equal(posts.length, 1, 'one review, one order');
  assert.deepEqual(JSON.parse(posts[0].body), JSON.parse(JSON.stringify(ticket.order)));
  assert.equal(posts[0].headers.Authorization, 'Bearer acc-1');
  assert.match(result(elements), /Order 1001: filled 250 at \$100\.03\. Stop \$98\.00: working\./);
  assert.doesNotMatch(elements.get('tradeBody').innerHTML, /id="tradePlace"/, 'no Place button once sent');
});

test('the stop duration choice is remembered and rebuilds the order before sending', async () => {
  const net = network(async () => json({}, 404));
  const storage = connected();
  const { run, state } = await sharesCard({ fetch: net.fetch, storage });
  await run('openTrade()');
  run("setTradeStopDuration('DAY')");
  assert.equal(state.tradeTicket.order.childOrderStrategies[0].duration, 'DAY');
  assert.equal(state.tradeTicket.order.duration, 'DAY', 'the entry is a day order either way');
  assert.equal(storage.get('schwab_stop_duration'), 'DAY');
});

test('a limit entry starts at the planned entry, moves as you type and caps the risk; a review never opens on it', async () => {
  const net = network(async (path, init) => {
    if (path === '/trader/v1/accounts/HASH1/orders' && init.method === 'POST') return json(null, 201, { Location: `${PROXY}/trader/v1/accounts/HASH1/orders/1001` });
    if (path === '/trader/v1/accounts/HASH1/orders/1001') return json({ status: 'WORKING', childOrderStrategies: [{ status: 'AWAITING_PARENT_ORDER' }] });
    return json({}, 404);
  });
  const storage = connected();
  const { run, elements, state } = await sharesCard({ fetch: net.fetch, storage });
  await run('openTrade()');
  const body = () => elements.get('tradeBody').innerHTML;
  const detail = () => elements.get('tradeDetail').innerHTML;
  assert.equal(state.tradeTicket.order.orderType, 'MARKET');
  assert.match(body(), /data-action="setTradeEntryType" data-arg="MARKET">Market<\/button><button[^>]*data-arg="LIMIT">Limit<\/button>/, 'Limit sits next to Market, never greyed out');
  assert.doesNotMatch(body(), /id="tradeLimit"/);
  run("actions.setTradeEntryType({ dataset: { arg: 'LIMIT' } })");
  assert.deepEqual([state.tradeTicket.order.orderType, state.tradeTicket.order.price, state.tradeTicket.order.stopPrice, state.tradeTicket.qty], ['LIMIT', 100, undefined, 250], 'at the entry the shares were sized on');
  assert.equal(storage.get('schwab_entry_type'), undefined, 'a limit is not the stop entry remembered');
  assert.match(body(), /id="tradeLimit"[^>]*value="100.00"/);
  assert.match(body(), /Buy 250 TEST at \$100\.00 limit<\/strong><span class="shares-detail">At the limit or better, not past it\. Today only\./);
  assert.match(body(), /id="tradePlace" data-action="placeTrade">Buy 250 TEST at \$100\.00</);
  assert.match(body(), /Waits until the price comes to \$100\.00\. If it hasn.{1,5}t filled by the close, it ends and the stop never goes in\./);
  // typing redraws what follows the input, not the input
  elements.get('tradeLimit').value = '100.5';
  run("actions.setTradeLimit({ value: '100.5' })");
  assert.equal(elements.get('tradeLimit').value, '100.5');
  assert.equal(elements.get('tradePlace').textContent, 'Buy 250 TEST at $100.50');
  assert.match(detail(), /\$625\.00[\s\S]*If it fills at the limit; planned \$500\.00 from entry \$100\.00/);
  assert.match(detail(), /At the limit \$100\.50, risk is \$625\.00, over your \$500\.00 plan\./);
  assert.match(detail(), /At or through the ask \$100\.02, so it likely fills right away, at \$100\.50 or better\./);
  run("setTradeLimit('97.9')");
  assert.match(detail(), /The limit \$97\.90 is at or below the stop \$98\.00\. Buy above the stop\./);
  assert.equal(elements.get('tradePlace').disabled, true);
  run("setTradeLimit('')");
  assert.match(detail(), /Set a limit price\./);
  run("setTradeLimit('99.504')");
  run("setTradeStopDuration('DAY')");
  assert.deepEqual([state.tradeTicket.entryType, state.tradeTicket.limitPrice, state.tradeTicket.order.childOrderStrategies[0].duration], ['LIMIT', 99.5, 'DAY'], 'the limit holds through other changes, on the tick');
  await run('placeTrade()');
  const posts = net.schwabCalls().filter(c => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual([JSON.parse(posts[0].body).orderType, JSON.parse(posts[0].body).price], ['LIMIT', 99.5]);
  assert.match(result(elements), /Order 1001: working\. Stop \$98\.00: awaiting parent order\./);
  assert.match(body(), /data-action="openOrderEdit" data-arg="1001"[^>]*>Change limit</, 'a limit still waiting can move from Positions\' Edit');
  await run('openTrade()');
  assert.equal(state.tradeTicket.entryType, 'MARKET', 'the next review starts at market again');
});

test('a lost answer is never retried and the next review warns about a repeat', async () => {
  const net = network(async (path, init) => { if (init.method === 'POST') throw new TypeError('Failed to fetch'); return json({}, 404); });
  const { run, elements, state } = await sharesCard({ fetch: net.fetch, storage: connected() });
  await run('openTrade()');
  await run('placeTrade()');
  assert.equal(net.schwabCalls().filter(c => c.method === 'POST').length, 1);
  assert.match(result(elements), /No answer from Schwab\. Check your Schwab orders before trying again\./);
  assert.ok(state.tradeTicket.sent);
  await run('openTrade()');
  assert.match(state.tradeTicket.warnings.join(' '), /You sent a TEST order \d+s ago/);
});

test('a rejected order shows Schwab\'s reason', async () => {
  const net = network(async (path, init) => init.method === 'POST' ? json({ message: 'A validation error occurred.', errors: ['Not enough buying power.'] }, 400) : json({}, 404));
  const { run, elements } = await sharesCard({ fetch: net.fetch, storage: connected() });
  await run('openTrade()');
  await run('placeTrade()');
  assert.equal(result(elements), 'Schwab rejected the order. A validation error occurred. Not enough buying power.');
});

test('a stop through the market opens a review with the reason and nothing to send', async () => {
  const { run, elements, state } = await sharesCard({ fetch: network(async () => json({}, 404)).fetch, storage: connected() });
  run("quoteData = { ...quoteData, bid: 97.5, ask: 97.6 }; renderShares()");
  const ticket = run('buildTradeTicket()');
  assert.match(ticket.error, /at or above the bid/);
  state.tradeTicket = ticket;
  run('renderTradeSheet()');
  assert.doesNotMatch(elements.get('tradeBody').innerHTML, /data-action="placeTrade"/);
});

test('the review flags off-hours fills and risk above the plan', async () => {
  const { run } = await sharesCard({ storage: connected() });
  run("quoteData = { ...quoteData, bid: 100.9, ask: 101 }");
  const night = run('buildTradeTicket(Date.UTC(2026, 9, 6, 2, 0))').warnings.join(' ');
  assert.match(night, /Outside regular hours/);
  assert.match(night, /At the ask \$101\.00, risk is \$750\.00, over your \$500\.00 plan/);
  const open = run('buildTradeTicket(Date.UTC(2026, 9, 5, 15, 0))').warnings.join(' ');
  assert.doesNotMatch(open, /Outside regular hours/);
});

// ---------- the worker ----------

const ENV = { SCHWAB_APP_KEY: 'appkey', SCHWAB_APP_SECRET: 'secret', SCHWAB_CALLBACK_URL: 'https://127.0.0.1', ALLOWED_ORIGINS: 'https://size-calc.example.workers.dev, http://localhost:8765' };
const ORIGIN = { Origin: 'https://size-calc.example.workers.dev' };

async function upstream(respond, fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), ...init }); return respond(String(url), init); };
  try { return { res: await fn(), calls }; } finally { globalThis.fetch = real; }
}

test('worker: login redirects to Schwab with the app key, callback, and state', async () => {
  const res = await worker.fetch(new Request('https://w.test/login?state=abc123'), ENV);
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get('Location'));
  assert.equal(to.origin + to.pathname, 'https://api.schwabapi.com/v1/oauth/authorize');
  assert.equal(to.searchParams.get('client_id'), 'appkey');
  assert.equal(to.searchParams.get('redirect_uri'), 'https://127.0.0.1');
  assert.equal(to.searchParams.get('state'), 'abc123');
});

test('worker: browsers from other sites get nothing', async () => {
  const { res, calls } = await upstream(() => json({}), () => worker.fetch(new Request('https://w.test/token', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{"code":"x"}' }), ENV));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
  const pre = await worker.fetch(new Request('https://w.test/trader/v1/accounts', { method: 'OPTIONS', headers: ORIGIN }), ENV);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), 'https://size-calc.example.workers.dev');
  assert.match(pre.headers.get('Access-Control-Expose-Headers'), /Location/);
});

test('worker: the code swap uses the secret and returns only the tokens', async () => {
  const { res, calls } = await upstream(
    () => json({ access_token: 'a', refresh_token: 'r', expires_in: 1800, id_token: 'jwt', scope: 'api' }),
    () => worker.fetch(new Request('https://w.test/token', { method: 'POST', headers: ORIGIN, body: JSON.stringify({ code: 'C0.abc@def' }) }), ENV));
  assert.equal(calls[0].url, 'https://api.schwabapi.com/v1/oauth/token');
  assert.equal(calls[0].headers.Authorization, 'Basic ' + btoa('appkey:secret'));
  assert.equal(calls[0].body, 'grant_type=authorization_code&code=C0.abc%40def&redirect_uri=https%3A%2F%2F127.0.0.1');
  assert.deepEqual(await res.json(), { access_token: 'a', refresh_token: 'r', expires_in: 1800 });
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('worker: Trader calls pass the bearer through and expose the new order id', async () => {
  const order = JSON.stringify({ orderType: 'MARKET' });
  const { res, calls } = await upstream(
    () => new Response(null, { status: 201, headers: { Location: 'https://api.schwabapi.com/trader/v1/accounts/H/orders/77' } }),
    () => worker.fetch(new Request('https://w.test/trader/v1/accounts/H/orders', { method: 'POST', headers: { ...ORIGIN, Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: order }), ENV));
  assert.equal(calls[0].url, 'https://api.schwabapi.com/trader/v1/accounts/H/orders');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].body, order);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.match(res.headers.get('Location'), /\/orders\/77$/);

  const bare = await worker.fetch(new Request('https://w.test/trader/v1/accounts', { headers: ORIGIN }), ENV);
  assert.equal(bare.status, 401);
  const other = await worker.fetch(new Request('https://w.test/v1/oauth/token', { headers: ORIGIN }), ENV);
  assert.equal(other.status, 404);
});

test('worker: the app can read the callback, other sites cannot', async () => {
  const res = await worker.fetch(new Request('https://w.test/callback', { headers: ORIGIN }), ENV);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { callback: 'https://127.0.0.1' });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://size-calc.example.workers.dev');
  const other = await worker.fetch(new Request('https://w.test/callback', { headers: { Origin: 'https://evil.example' } }), ENV);
  assert.equal(other.status, 403);
});

test('worker: a missing app key, secret, or callback says so instead of half working', async () => {
  const res = await worker.fetch(new Request('https://w.test/login'), { ...ENV, SCHWAB_APP_SECRET: '' });
  assert.equal(res.status, 500);
  assert.match(await res.text(), /missing SCHWAB_APP_SECRET/);
});

// ---------- checked again before sending ----------

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const placed = path => path === '/trader/v1/accounts/HASH1/orders';

// Tradier answers each quote call with the next one in the list (the last one repeats); Schwab calls go to the handler
function quotes(list, schwab) {
  const calls = [];
  let n = 0;
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (url.startsWith(PROXY)) return schwab(url.slice(PROXY.length), init);
    if (url.includes('/markets/quotes')) {
      const q = list[Math.min(n++, list.length - 1)];
      if (q instanceof Error) throw q;
      return json({ quotes: { quote: q } });
    }
    return json({});
  };
  return { calls, fetch, posts: () => calls.filter(c => c.method === 'POST' && c.url.startsWith(PROXY)) };
}
const created = async (path, init) => init.method === 'POST' && placed(path) ? json(null, 201, { Location: `${PROXY}/trader/v1/accounts/HASH1/orders/1001` }) : json({}, 404);

test('no review from a stale quote: when the refresh fails, the sheet does not open', async () => {
  const net = quotes([new TypeError('Failed to fetch')], created);
  const { run, elements, state } = await sharesCard({ fetch: net.fetch, storage: connected() });
  await run('openTrade()');
  assert.equal(state.tradeTicket, null);
  assert.match(elements.get('errorBox').textContent, /Could not refresh the TEST quote, so there is nothing to review yet/);
});

test('Place checks the quote again: a stop now through the bid sends nothing', async () => {
  const net = quotes([QUOTE, { ...QUOTE, bid: 97.9, ask: 98.1, last: 98 }], created);
  const { run, elements } = await sharesCard({ fetch: net.fetch, storage: connected() });
  await run('openTrade()');
  await run('placeTrade()');
  assert.equal(net.posts().length, 0);
  assert.match(elements.get('tradeBody').innerHTML, /The stop \$98\.00 is at or above the bid \$97\.90\. It would sell as soon as the buy fills\. Nothing was sent\./);
  assert.doesNotMatch(elements.get('tradeBody').innerHTML, /data-action="placeTrade"/);
});

test('a quote that moves past the plan shows the new warning and waits for a second Place', async () => {
  const net = quotes([QUOTE, { ...QUOTE, bid: 100.9, ask: 101 }], created);
  const { run, elements, state } = await sharesCard({ fetch: net.fetch, storage: connected() });
  await run('openTrade()');
  const reviewed = state.tradeTicket;
  await run('placeTrade()');
  assert.equal(net.posts().length, 0, 'a new warning means a new review');
  assert.notEqual(state.tradeTicket, reviewed);
  assert.match(elements.get('tradeBody').innerHTML, /At the ask \$101\.00, risk is \$750\.00, over your \$500\.00 plan/);
  assert.match(result(elements), /The quote moved since you reviewed this\. Nothing was sent\./);
  await run('placeTrade()');
  assert.equal(net.posts().length, 1);
  assert.deepEqual(JSON.parse(net.posts()[0].body), JSON.parse(JSON.stringify(reviewed.order)), 'still the order reviewed');
});

test('a new trade goes only to the account it was reviewed for', async () => {
  const storage = connected([['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }, { hash: 'HASH2', last4: '4321' }])]]);
  const net = quotes([QUOTE], created);
  const { run, state } = await sharesCard({ fetch: net.fetch, storage });
  await run('openTrade()');
  assert.equal(state.tradeTicket.hash, 'HASH1');
  storage.set('schwab_account', 'HASH2');
  await run('placeTrade()');
  assert.equal(net.calls.filter(c => c.url.startsWith(PROXY)).length, 0);
  assert.match(state.tradeTicket.result.text, /You switched Schwab accounts since this was reviewed\. Nothing was sent\./);
  assert.equal(state.tradeTicket.sent, false);
});

// ---------- after it goes ----------

test('a filled entry whose stop Schwab rejected is a loud warning, not a success', async () => {
  const net = quotes([QUOTE], async (path, init) => {
    if (init.method === 'POST') return created(path, init);
    if (path.endsWith('/orders/1001')) return json({ status: 'FILLED', filledQuantity: 250, orderActivityCollection: [{ executionLegs: [{ quantity: 250, price: 100.03 }] }], childOrderStrategies: [{ status: 'REJECTED' }] });
    return json({}, 404);
  });
  const { run, elements } = await sharesCard({ fetch: net.fetch, storage: connected() });
  await run('openTrade()');
  await run('placeTrade()');
  assert.match(result(elements), /Order 1001: filled 250 at \$100\.03\. Stop \$98\.00: rejected\. Your 250 TEST have no stop\. Set one in Schwab now\./);
  assert.match(elements.get('tradeBody').innerHTML, /class="trade-result bad"/);
});

test('a refresh that fails before the order leaves says nothing reached Schwab, and arms no repeat warning', async () => {
  const stale = connected([['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'old', accessExp: 0, refresh: 'ref-1', refreshExp: Date.now() + DAY })]]);
  const net = quotes([QUOTE], async path => { if (path === '/refresh') throw new TypeError('Failed to fetch'); return json({}, 404); });
  const { run, state } = await sharesCard({ fetch: net.fetch, storage: stale });
  await run('openTrade()');
  await run('placeTrade()');
  assert.equal(net.posts().filter(c => !c.url.endsWith('/refresh')).length, 0, 'no order request');
  assert.equal(state.tradeTicket.result.text, 'Could not reach the Schwab worker. Nothing was sent to Schwab.');
  assert.equal(state.tradeLast, null);
});

// ---------- the login changing while a refresh is out ----------

test('a refresh that lands after a logout is not saved; a refusal after a new login does not end it', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const stale = connected([['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'old', accessExp: 0, refresh: 'ref-1', refreshExp: Date.now() + DAY })]]);
  const net = network(async path => { if (path === '/refresh') { await gate; return json({ access_token: 'fresh', refresh_token: 'ref-9', expires_in: 1800 }); } return json([]); });
  const { run } = await app({ fetch: net.fetch, storage: stale });
  const call = run("schwabApi('/accounts/accountNumbers')");
  await settle();
  run('schwabDisconnect()');
  release();
  await assert.rejects(call, /login changed/);
  assert.equal(stale.has('schwab_tokens'), false, 'logged out stays logged out');

  let refuse;
  const later = new Promise(r => { refuse = r; });
  const over = connected([['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'old', accessExp: 0, refresh: 'ref-1', refreshExp: Date.now() + DAY })]]);
  const refused = network(async path => { if (path === '/refresh') { await later; return json({ error: 'invalid_grant' }, 400); } return json([]); });
  const second = await app({ fetch: refused.fetch, storage: over });
  const pending = second.run("schwabApi('/accounts/accountNumbers')");
  await settle();
  const fresh = JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'new', accessExp: Date.now() + 20 * 60000, refresh: 'ref-2', refreshExp: Date.now() + 5 * DAY });
  over.set('schwab_tokens', fresh); // logged in again meanwhile
  refuse();
  await assert.rejects(pending, /login changed/);
  assert.equal(over.get('schwab_tokens'), fresh, 'the new login is kept');
});
