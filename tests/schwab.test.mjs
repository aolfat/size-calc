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
  ['schwab_tokens', JSON.stringify({ access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
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
  return { calls, fetch, schwabCalls: () => calls.filter(c => c.url.startsWith(PROXY)) };
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

test('a callback page with someone else\'s state is ignored', async () => {
  const net = network(async () => json({}, 500));
  const storage = new Map([['schwab_proxy', PROXY], ['schwab_oauth_state', 'mine']]);
  const { run, elements } = await app({ fetch: net.fetch, storage });
  await run("initSchwab('https://aolfat.github.io/size-calc/?code=attacker&state=theirs')");
  await run("initSchwab('https://aolfat.github.io/size-calc/?code=attacker')");
  assert.equal(net.schwabCalls().length, 0);
  assert.match(elements.get('errorBox').textContent, /another attempt/);
});

test('Schwab logins never travel in backups or the account', async () => {
  const storage = connected([]);
  const { run } = await app({ storage, session: { user: { id: 'u1' } } });
  assert.deepEqual(run('BACKUP_KEYS.filter(k => k.startsWith("schwab"))'), []);
  assert.deepEqual(run('CLOUD_KEYS.filter(k => k.startsWith("schwab"))'), []);
  assert.doesNotMatch(run('buildBackup()'), /schwab|acc-1|ref-1|HASH1/);
  run("store.set('schwab_tokens', 'changed'); store.set('schwab_proxy', 'https://other.example')");
  assert.equal(storage.get('cloud_pending'), undefined);
});

test('Google\'s return carries a code too, and the Schwab callback leaves it alone', async () => {
  const storage = new Map([['schwab_proxy', PROXY], ['schwab_oauth_state', 'mine']]);
  const net = network(async () => json({}, 500));
  const { run, elements } = await app({ fetch: net.fetch, storage });
  await run("initSchwab('https://aolfat.github.io/size-calc/?login=google&code=from-google')");
  assert.equal(net.schwabCalls().length, 0);
  assert.equal(elements.get('errorBox').textContent, '', 'no Schwab error for a Google sign-in');
});

test('an expired access token refreshes once before the call; a refused refresh ends the login', async () => {
  const stale = connected([['schwab_tokens', JSON.stringify({ access: 'old', accessExp: Date.now() - 1000, refresh: 'ref-1', refreshExp: Date.now() + DAY })]]);
  const net = network(async path => path === '/refresh' ? json({ access_token: 'fresh', expires_in: 1800 }) : json([]));
  const { run } = await app({ fetch: net.fetch, storage: stale });
  await run("Promise.all([schwabApi('/accounts/accountNumbers'), schwabApi('/accounts/accountNumbers')])");
  const calls = net.schwabCalls();
  assert.equal(calls.filter(c => c.url.endsWith('/refresh')).length, 1, 'concurrent calls share one refresh');
  assert.deepEqual(JSON.parse(calls[0].body), { refresh_token: 'ref-1' });
  assert.ok(calls.slice(1).every(c => c.headers.Authorization === 'Bearer fresh'));
  assert.equal(JSON.parse(stale.get('schwab_tokens')).refresh, 'ref-1', 'the refresh token carries over when Schwab sends none');

  const over = connected([['schwab_tokens', JSON.stringify({ access: 'old', accessExp: 0, refresh: 'dead', refreshExp: Date.now() + DAY })]]);
  const refused = network(async () => json({ error: 'invalid_grant' }, 400));
  const second = await app({ fetch: refused.fetch, storage: over });
  await assert.rejects(second.run("schwabApi('/accounts/accountNumbers')"), /login expired/);
  assert.equal(over.has('schwab_tokens'), false);
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

const ENV = { SCHWAB_APP_KEY: 'appkey', SCHWAB_APP_SECRET: 'secret', SCHWAB_CALLBACK_URL: 'https://127.0.0.1', ALLOWED_ORIGINS: 'https://aolfat.github.io, http://localhost:8765' };
const ORIGIN = { Origin: 'https://aolfat.github.io' };

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
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), 'https://aolfat.github.io');
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
  assert.match(res.headers.get('Location'), /\/orders\/77$/);

  const bare = await worker.fetch(new Request('https://w.test/trader/v1/accounts', { headers: ORIGIN }), ENV);
  assert.equal(bare.status, 401);
  const other = await worker.fetch(new Request('https://w.test/v1/oauth/token', { headers: ORIGIN }), ENV);
  assert.equal(other.status, 404);
});

test('worker: a missing app key, secret, or callback says so instead of half working', async () => {
  const res = await worker.fetch(new Request('https://w.test/login'), { ...ENV, SCHWAB_APP_SECRET: '' });
  assert.equal(res.status, 500);
  assert.match(await res.text(), /missing SCHWAB_APP_SECRET/);
});
