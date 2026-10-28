// Run with: node --test
// One Schwab login for every device: signed in, the login is kept in the account (Vault) and each device takes the
// newest one. The other device is played by writing the fake account directly; set_schwab_login here mirrors the
// compare-and-swap in supabase/migrations/20261109000000_shared_schwab_login.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const USER = { id: 'user-1', email: 'me@example.com' };
const SESSION = { user: USER, access_token: 'jwt' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

const login = (over = {}) => ({ proxy: PROXY, connectionId: 'desk', access: 'desk-access', accessExp: Date.now() + 20 * 60000, refresh: 'desk-r1', refreshExp: Date.now() + 5 * DAY, ...over });
const tokens = (over = {}) => JSON.stringify({ userId: USER.id, ...login(over) });

// the account: the kept login, the settings rows (schwab_login_at), and every rpc call
function fakeAccount(kept = null) {
  const db = { kept, settings: [] };
  const calls = [];
  let tick = 0;
  const stampLogin = () => {
    const row = { key: 'schwab_login_at', value: 'now', updated_at: new Date(Date.UTC(2026, 9, 9, 12, 0, 0, ++tick)).toISOString() };
    db.settings = db.settings.filter(r => r.key !== row.key).concat(row);
  };
  const answer = data => ({ data, error: null, status: 200 });
  return {
    db, calls, stampLogin,
    from: () => ({
      select() {
        let since = '';
        const q = { gt(col, v) { since = v; return q; }, then: (ok, bad) => Promise.resolve(answer(db.settings.filter(r => !since || r.updated_at > since))).then(ok, bad) };
        return q;
      },
      upsert: async () => answer(null),
    }),
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === 'get_schwab_login') return answer(db.kept);
      if (name === 'clear_schwab_login') { db.kept = null; stampLogin(); return answer(null); }
      if (name === 'set_schwab_login') {
        const { p_login: next, p_expect: expect } = args;
        const k = db.kept;
        const ok = !k || (expect != null && k.refresh === expect)
          || (expect == null && next && next.connectionId !== k.connectionId && next.refreshExp > (k.refreshExp || 0));
        if (!ok) return answer(k);
        db.kept = next ? { ...next } : null;
        stampLogin();
        return answer(db.kept);
      }
      return answer(null);
    },
    auth: { getSession: async () => ({ data: { session: SESSION } }), onAuthStateChange: () => ({ data: { subscription: {} } }) },
  };
}

// Schwab through the worker: /refresh answers with refresh(), every other call is logged with the token it carried
function schwab(refresh = () => json({ error: 'invalid_grant' }, 400)) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.Authorization, body: init.body });
    if (url === PROXY + '/refresh') return refresh();
    if (url === PROXY + '/token') return json({ access_token: 'new-access', refresh_token: 'new-r1', expires_in: 1800 });
    if (url.endsWith('/accounts/accountNumbers')) return json([{ hashValue: 'HASH1', accountNumber: '123456789' }]);
    return json({});
  };
  return { calls, fetch, api: () => calls.filter(c => c.url.includes('/trader/v1/')) };
}

async function device({ kept = null, local = null, refresh, signedIn = true, extra = [] } = {}) {
  const account = fakeAccount(kept);
  const net = schwab(refresh);
  const storage = new Map([['schwab_proxy', PROXY], ['cloud_user', USER.id], ...(local ? [['schwab_tokens', local]] : []),
    ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }])], ['schwab_account', 'HASH1'], ...extra]);
  const h = await app({ fetch: net.fetch, storage, supabase: account, session: signedIn ? SESSION : null });
  return { ...h, account, net, storage, mine: () => JSON.parse(storage.get('schwab_tokens') || 'null') };
}

test('logging in while signed in keeps the login in the account for your other devices', async () => {
  const d = await device({ extra: [['schwab_oauth_state', 'mine']] });
  await d.run("schwabExchangeCode('C1')");
  assert.equal(d.account.db.kept.refresh, 'new-r1');
  assert.equal(d.account.db.kept.connectionId, d.mine().connectionId);
  assert.equal(d.account.db.kept.proxy, PROXY);
  assert.equal(d.account.db.kept.userId, undefined, 'the login alone: each device binds it to its own Google session');
  assert.equal(d.mine().shared, true);
});

test('a device with no login takes the account\'s, with no Schwab login of its own', async () => {
  const d = await device({ kept: login({ connectionId: 'phone', access: 'phone-access', refresh: 'phone-r1' }), extra: [['schwab_accounts', '[]']] });
  d.storage.delete('schwab_account');
  let heard = 0;
  d.run('onSchwabShared(() => { globalThis.heard = (globalThis.heard || 0) + 1 })');
  assert.equal(await d.run('schwabSyncShared()'), true);
  assert.equal(d.mine().connectionId, 'phone');
  assert.equal(d.mine().userId, USER.id);
  assert.equal(d.run('schwabConnected()'), true, 'and its accounts loaded');
  heard = d.run('globalThis.heard');
  assert.equal(heard, 1, 'the UI hears about it');
});

test('signed out, the login stays on the device: nothing goes to the account', async () => {
  const d = await device({ signedIn: false, extra: [['schwab_oauth_state', 'mine']] });
  await d.run("schwabExchangeCode('C1')");
  assert.equal(await d.run('schwabSyncShared()'), false);
  assert.deepEqual(d.account.calls, []);
});

test('your phone logged in, so Schwab refuses the desktop\'s refresh: the desktop takes the phone\'s login and the call goes out', async () => {
  const phone = login({ connectionId: 'phone', access: 'phone-access', refresh: 'phone-r1', refreshExp: Date.now() + 7 * DAY });
  const d = await device({ kept: phone, local: tokens({ accessExp: 0, shared: true }) });
  await d.run("schwabApi('/accounts/accountNumbers')");
  assert.equal(d.net.api()[0].auth, 'Bearer phone-access');
  assert.equal(d.mine().connectionId, 'phone');
  assert.equal(d.account.db.kept.connectionId, 'phone', 'the account keeps the phone\'s login');
});

test('a refused refresh of the login the account still holds ends it here and in the account', async () => {
  const d = await device({ kept: login(), local: tokens({ accessExp: 0, shared: true }) });
  await assert.rejects(d.run("schwabApi('/accounts/accountNumbers')"), /login expired \(Schwab: invalid_grant\)/);
  await settle();
  assert.equal(d.storage.has('schwab_tokens'), false);
  assert.equal(d.account.db.kept, null);
  assert.ok(d.account.calls.some(([n, a]) => n === 'set_schwab_login' && a.p_login === null && a.p_expect === 'desk-r1'), 'only if it is still that one');
});

test('a renewal that brings a new refresh token swaps it into the account in place of the old one', async () => {
  const d = await device({ kept: login(), local: tokens({ accessExp: 0, shared: true }),
    refresh: () => json({ access_token: 'desk-access-2', refresh_token: 'desk-r2', expires_in: 1800 }) });
  await d.run("schwabApi('/accounts/accountNumbers')");
  await settle();
  assert.equal(d.account.db.kept.refresh, 'desk-r2');
  assert.ok(d.account.calls.some(([n, a]) => n === 'set_schwab_login' && a.p_expect === 'desk-r1'));
});

test('the same login renewed on another device: this one takes the newer refresh token', async () => {
  const renewed = login({ access: 'phone-renewed', accessExp: Date.now() + 29 * 60000, refresh: 'desk-r2' });
  const d = await device({ kept: renewed, local: tokens({ shared: true }) });
  assert.equal(await d.run('schwabSyncShared()'), true);
  assert.equal(d.mine().refresh, 'desk-r2');
});

test('a login newer than the account\'s is sent; an older one never replaces it', async () => {
  const d = await device({ kept: login({ connectionId: 'old', refresh: 'old-r', refreshExp: Date.now() + DAY }), local: tokens() });
  assert.equal(await d.run('schwabSyncShared()'), false);
  assert.equal(d.account.db.kept.connectionId, 'desk');
  assert.equal(d.mine().shared, true);
});

test('Disconnect everywhere clears the account, and a device that had it drops it on its next pull', async () => {
  const d = await device({ kept: login(), local: tokens({ shared: true }) });
  await d.run("disconnectSchwab('everywhere')");
  assert.equal(d.account.db.kept, null);
  assert.equal(d.storage.has('schwab_tokens'), false);
  assert.match(d.elements.get('errorBox').textContent, /disconnected on every device/);

  // the other device: it still has the login, and the account's stamp says something changed
  const other = await device({ local: tokens({ shared: true }) });
  other.account.stampLogin();
  await other.run('cloudPull()');
  assert.equal(other.storage.has('schwab_tokens'), false);
});

test('Disconnect on this device leaves the others logged in and stops using the account\'s login until you log in here', async () => {
  const d = await device({ kept: login(), local: tokens({ shared: true }), extra: [['schwab_oauth_state', 'mine']] });
  await d.run('disconnectSchwab()');
  assert.equal(d.account.db.kept.connectionId, 'desk', 'still in the account');
  assert.match(d.elements.get('errorBox').textContent, /Your other devices stay logged in/);
  assert.equal(await d.run('schwabSyncShared()'), false);
  assert.equal(d.storage.has('schwab_tokens'), false, 'not taken back');
  d.storage.set('schwab_oauth_state', 'mine');
  await d.run("schwabExchangeCode('C1')");
  assert.equal(d.storage.has('schwab_share_off'), false);
  assert.equal(d.account.db.kept.refresh, 'new-r1', 'logging in here shares again');
});

test('a worker URL the account changed takes no login through it until you say yes on this device', async () => {
  const d = await device({ kept: login({ connectionId: 'phone' }), extra: [['schwab_proxy_confirm', PROXY]] });
  assert.equal(await d.run('schwabSyncShared()'), false);
  assert.equal(d.storage.has('schwab_tokens'), false);
  assert.deepEqual(d.account.calls, []);
});

test('Settings says the login is shared and offers Disconnect everywhere', async () => {
  const d = await device({ local: tokens({ shared: true }) });
  d.run('updateSchwabUi()');
  assert.equal(d.elements.get('schwabSharedLine').style.display, '');
  const alone = await device({ local: tokens() });
  alone.run('updateSchwabUi()');
  assert.equal(alone.elements.get('schwabSharedLine').style.display, 'none');
});
