// Run with: node --test
// The account: Google sign-in through Supabase, a device's first sign-in, pending edits, pushes, pulls, sign-out,
// and leftover keys. A small in-memory fake stands in for the Supabase client: nothing reaches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const USER = { id: 'user-1', email: 'me@example.com' };
const SESSION = { user: USER, access_token: 'jwt' };
const GOOGLE_RETURN = 'https://aolfat.github.io/size-calc/?login=google&code=abc';
const SESSION_KEY = 'sb-dhohfavttsxwutanvcuj-auth-token';

/** a fake Supabase client over in-memory tables; rows get server-side updated_at stamps like the real triggers */
function fakeSupabase({ settings = [], key = '' } = {}) {
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 9, 12, 0, 0, ++tick)).toISOString();
  const db = {
    settings: settings.map(r => ({ user_id: USER.id, updated_at: stamp(), ...r })),
    key,
  };
  const calls = [];
  let failure = null;
  let gate = null, gateFor = null; // hold(name): those requests (all without a name) wait until released
  const held = name => gate && (!gateFor || gateFor === name) ? gate : Promise.resolve();
  const answer = data => failure ? { data: null, error: { message: failure.message }, status: failure.status } : { data, error: null, status: 200 };
  const write = (table, rows) => {
    for (const r of rows) {
      const row = { ...r, updated_at: stamp() };
      const i = db[table].findIndex(x => x.key === r.key);
      if (i >= 0) db[table][i] = row; else db[table].push(row);
    }
  };
  const client = {
    db, calls,
    fail(f) { failure = f; },
    hold(name = null) { let release; gateFor = name; gate = new Promise(r => { release = r; }); return () => { gate = null; release(); }; },
    from(table) {
      return {
        select() {
          let since = '';
          const query = {
            gt(col, value) { since = value; return query; },
            then(resolve, reject) {
              calls.push(['select', table, since]);
              return held('select').then(() => answer(db[table].filter(r => !since || r.updated_at > since).map(r => ({ ...r })))).then(resolve, reject);
            },
          };
          return query;
        },
        async upsert(rows) {
          calls.push(['upsert', table, rows]);
          await held('upsert');
          if (!failure) write(table, rows);
          return answer(null);
        },
      };
    },
    async rpc(name, args) {
      calls.push(['rpc', name, args]);
      await held(name);
      if (failure) return answer(null);
      if (name === 'get_tradier_key') return answer(db.key);
      if (name === 'set_tradier_key') { db.key = args.new_key; write('settings', [{ user_id: USER.id, key: 'tradier_key_at', value: 'now' }]); }
      return answer(null);
    },
    auth: {
      async signInWithOAuth(opts) { calls.push(['oauth', opts]); return { error: null }; },
      async exchangeCodeForSession(code) { calls.push(['exchange', code]); return { data: { session: SESSION }, error: null }; },
      async getSession() { return { data: { session: SESSION } }; },
      async signOut(opts) { calls.push(['signOut', opts]); return { error: null }; },
    },
  };
  return client;
}

/** a device that already finished its first sign-in */
const joined = (entries = []) => new Map([['cloud_user', USER.id], ...entries]);
/** let pending promise work run until cond holds (a held request has been reached) */
async function until(cond) {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise(r => setImmediate(r));
  assert.ok(cond(), 'never got there');
}

// ---------- first sign-in ----------

test('the first device fills an empty account and drops the old sync keys', async () => {
  const supabase = fakeSupabase();
  const storage = new Map([
    ['calc_account', '50000'], ['calc_risk', '1'], ['tradier_key', 'TK-local'], ['show_daily', '0'],
    ['sync_id', 'old'], ['sync_key', 'old'], ['sync_dirty', '[]'], ['last_sync_t', '1'],
  ]);
  const { run, elements, state } = await app({ supabase, storage });
  await run(`initCloud('${GOOGLE_RETURN}')`);

  assert.deepEqual(supabase.calls.find(c => c[0] === 'exchange'), ['exchange', 'abc']);
  assert.equal(state.session.user.id, USER.id);
  assert.deepEqual(Object.fromEntries(supabase.db.settings.filter(r => r.key !== 'tradier_key_at').map(r => [r.key, r.value])), { calc_account: '50000', calc_risk: '1' });
  assert.ok(supabase.db.settings.every(r => r.user_id === USER.id));
  assert.equal(supabase.db.key, 'TK-local', 'the key goes to Vault');
  for (const k of ['sync_id', 'sync_key', 'sync_dirty', 'last_sync_t']) assert.equal(storage.has(k), false, k);
  assert.equal(storage.get('show_daily'), '0', 'device-only settings stay put');
  assert.equal(storage.get('cloud_user'), USER.id);
  assert.match(elements.get('errorBox').textContent, /Saved this device's settings/);
  assert.equal(elements.get('signOutBtn').style.display, '');
  assert.equal(elements.get('signInBtn').style.display, 'none');
  assert.match(elements.get('accountEmail').textContent, /me@example\.com/);
  assert.equal(state.cloudPending.size, 0, 'the merge itself is not a pending edit');
});

test('a second device adopts the account, and uploads a setting only it has', async () => {
  const supabase = fakeSupabase({
    settings: [{ key: 'calc_account', value: '80000' }, { key: 'calc_risk', value: '2' }],
    key: 'TK-cloud',
  });
  const storage = new Map([
    ['calc_account', '50000'], ['calc_allocation', '15'], ['tradier_key', 'TK-local'],
  ]);
  const { run, elements } = await app({ supabase, storage });
  await run(`initCloud('${GOOGLE_RETURN}')`);

  assert.equal(storage.get('calc_account'), '80000', "the account's settings win");
  assert.equal(storage.get('calc_risk'), '2');
  assert.equal(storage.get('calc_allocation'), '15', 'a setting only this device has is kept');
  assert.equal(supabase.db.settings.find(r => r.key === 'calc_allocation').value, '15', 'and uploaded');
  assert.equal(storage.get('tradier_key'), 'TK-cloud');
  assert.equal(elements.get('apiKey').value, 'TK-cloud', 'the page shows the account without a reload');
  assert.equal(supabase.db.key, 'TK-cloud', "this device's key doesn't overwrite the account's");
  assert.match(elements.get('errorBox').textContent, /Loaded your settings/);
});

test("a device last signed in to another account sends none of its data, and that account's leftovers are cleared", async () => {
  const supabase = fakeSupabase({ settings: [{ key: 'calc_account', value: '80000' }] });
  const storage = new Map([
    ['cloud_user', 'someone-else'], ['calc_account', '50000'], ['calc_risk', '3'], ['calc_allocation', '15'], ['tradier_key', 'TK-theirs'],
    ['schwab_proxy', 'https://w.example'], ['cloud_pending', '["calc_risk"]'], ['cloud_seen', '{"settings":"2031-01-01T00:00:00.000Z"}'], ['show_daily', '0'],
  ]);
  const { run, elements, state } = await app({ supabase, storage });
  Object.assign(elements.get('allocationPct'), { value: '15', defaultValue: '5' });
  Object.assign(elements.get('riskPct'), { value: '3', defaultValue: '1' });
  await run(`initCloud('${GOOGLE_RETURN}')`);

  assert.ok(!supabase.calls.some(c => c[0] === 'upsert' || (c[0] === 'rpc' && c[1] === 'set_tradier_key')), 'nothing of theirs is uploaded');
  assert.equal(supabase.db.key, '');
  assert.equal(storage.get('calc_account'), '80000', "the new account's settings win");
  for (const k of ['calc_allocation', 'tradier_key']) assert.equal(storage.has(k), false, k);
  assert.equal(elements.get('allocationPct').value, '5', 'a cleared setting shows the default');
  assert.equal(storage.get('calc_risk'), '1', 'the page default, not theirs');
  assert.equal(elements.get('apiKey').value, '');
  assert.equal(storage.get('schwab_proxy'), 'https://w.example', "kept, like sign-out: this device's Schwab login needs it");
  assert.equal(storage.get('show_daily'), '0');
  assert.equal(storage.get('cloud_user'), USER.id);
  assert.equal(state.cloudPending.size, 0);
  assert.notEqual(JSON.parse(storage.get('cloud_seen')).settings, '2031-01-01T00:00:00.000Z', "their pull cursor is gone");
  assert.match(elements.get('errorBox').textContent, /Loaded your settings.*previous account's unsaved changes/);
});

test('a device last signed in to another account does not fill an empty account', async () => {
  const supabase = fakeSupabase();
  const storage = new Map([['cloud_user', 'someone-else'], ['calc_account', '75000'], ['tradier_key', 'TK-theirs']]);
  const { run, elements, state } = await app({ supabase, storage });
  Object.assign(elements.get('accountSize'), { value: '75000', defaultValue: '50000' });
  await run(`initCloud('${GOOGLE_RETURN}')`);
  assert.equal(supabase.db.settings.length, 0);
  assert.equal(supabase.db.key, '');
  assert.equal(storage.get('calc_account'), '50000', 'the page default, not theirs');
  assert.equal(storage.has('tradier_key'), false);
  assert.equal(state.cloudPending.size, 0);
  assert.doesNotMatch(elements.get('errorBox').textContent, /Saved this device's/);
});

test('a failed first sign-in leaves the device as it was and is retried later', async () => {
  const supabase = fakeSupabase();
  supabase.fail({ status: 500, message: 'boom' });
  const storage = new Map([['calc_account', '50000']]);
  const { run, elements, state } = await app({ supabase, storage });
  await run(`initCloud('${GOOGLE_RETURN}')`);
  assert.equal(state.session, null, 'not merged means not signed in here');
  assert.equal(storage.has('cloud_user'), false);
  assert.equal(storage.get('calc_account'), '50000');
  assert.match(elements.get('errorBox').textContent, /Google sign-in failed/);
});

test('an old return address opened again keeps the session this device already has', async () => {
  // Chrome's history and autocomplete bring back ?login=google&code=…; the code is spent, the session it made is not
  const supabase = fakeSupabase();
  supabase.auth.exchangeCodeForSession = async () => ({ data: { session: null }, error: { message: 'PKCE code verifier not found in storage.' } });
  const storage = joined([[SESSION_KEY, '{"access_token":"jwt"}']]);
  const { run, elements, state } = await app({ supabase, storage });
  await run(`initCloud('${GOOGLE_RETURN}')`);
  assert.equal(state.session, SESSION);
  assert.equal(elements.get('signInBtn').style.display, 'none');
  assert.equal(elements.get('signOutBtn').style.display, '');
  assert.doesNotMatch(elements.get('errorBox').textContent, /sign-in failed/);
});

test('an old return address without a session here says the sign-in failed', async () => {
  const supabase = fakeSupabase();
  supabase.auth.exchangeCodeForSession = async () => ({ data: { session: null }, error: { message: 'PKCE code verifier not found in storage.' } });
  const { run, elements, state } = await app({ supabase });
  await run(`initCloud('${GOOGLE_RETURN}')`);
  assert.equal(state.session, null);
  assert.equal(elements.get('signInBtn').style.display, '');
  assert.match(elements.get('errorBox').textContent, /Google sign-in failed/);
});

test("Google's refusal is shown, and nothing is swapped", async () => {
  const supabase = fakeSupabase();
  const { run, elements } = await app({ supabase });
  await run("initCloud('https://aolfat.github.io/size-calc/?login=google&error=access_denied&error_description=You%20said%20no')");
  assert.ok(!supabase.calls.some(c => c[0] === 'exchange'));
  assert.match(elements.get('errorBox').textContent, /You said no/);
});

test('Sign in with Google asks to come back to the app with the login marker', async () => {
  const supabase = fakeSupabase();
  const { run } = await app({ supabase });
  run("location = { href: 'https://aolfat.github.io/size-calc/?x=1#market' }");
  await run('signIn()');
  const [, opts] = supabase.calls.find(c => c[0] === 'oauth');
  assert.equal(opts.provider, 'google');
  assert.equal(opts.options.redirectTo, 'https://aolfat.github.io/size-calc/?login=google');
});

// ---------- while signed in ----------

test('signed out, edits stay on the device and nothing is sent', async () => {
  const { run, storage } = await app();
  run("store.set('calc_risk', '2')");
  assert.equal(storage.has('cloud_pending'), false);
});

test('an account edit is pending until a push sends it; device-only keys never are', async () => {
  const supabase = fakeSupabase();
  const { run, storage, state, elements } = await app({ supabase, session: SESSION, storage: joined() });
  run("store.set('calc_risk', '2'); store.set('show_daily', '0'); store.set('tradier_key', 'TK-2')");
  assert.deepEqual(JSON.parse(storage.get('cloud_pending')).sort(), ['calc_risk', 'tradier_key']);
  assert.equal(elements.get('cloudStatus').textContent, 'Saving…');
  assert.equal(await run('cloudPush()'), true);
  assert.equal(supabase.db.settings.find(r => r.key === 'calc_risk').value, '2');
  assert.equal(supabase.db.key, 'TK-2');
  assert.equal(state.cloudPending.size, 0);
  assert.match(elements.get('cloudStatus').textContent, /^Synced /);
});

test('a failed push keeps its edits pending, and a refused session asks to sign in again', async () => {
  const supabase = fakeSupabase();
  const { run, state, elements } = await app({ supabase, session: SESSION, storage: joined() });
  run("store.set('calc_risk', '2')");
  supabase.fail({ status: 503, message: 'unavailable' });
  assert.equal(await run('cloudPush()'), false);
  assert.deepEqual([...state.cloudPending], ['calc_risk']);
  assert.equal(elements.get('cloudStatus').textContent, 'Offline, will retry');

  supabase.fail({ status: 401, message: 'JWT expired' });
  await run('cloudPush()');
  assert.equal(state.session, null);
  assert.match(elements.get('cloudStatus').textContent, /Sign in again/);
  assert.deepEqual([...state.cloudPending], ['calc_risk'], 'the edit waits for the next sign-in');
});

test('edits stay pending on the device until the server has them, and one changed mid-save stays pending', async () => {
  const supabase = fakeSupabase();
  const { run, storage, state } = await app({ supabase, session: SESSION, storage: joined() });
  run("store.set('calc_risk', '2'); store.set('calc_account', '60000')");
  const release = supabase.hold('upsert');
  const pushing = run('cloudPush()');
  await until(() => supabase.calls.some(c => c[0] === 'upsert'));
  assert.deepEqual(JSON.parse(storage.get('cloud_pending')).sort(), ['calc_account', 'calc_risk'], 'a page killed now sends them next time');
  run("store.set('calc_risk', '3')");
  release();
  assert.equal(await pushing, false);
  assert.equal(supabase.db.settings.find(r => r.key === 'calc_risk').value, '2');
  assert.deepEqual(JSON.parse(storage.get('cloud_pending')), ['calc_risk'], 'the saved one is done, the edited one is not');
  assert.equal(await run('cloudPush()'), true);
  assert.equal(supabase.db.settings.find(r => r.key === 'calc_risk').value, '3');
  assert.equal(state.cloudPending.size, 0);
});

test("a Tradier key typed while a pull fetches the account's key is kept and sent", async () => {
  const supabase = fakeSupabase({ key: 'TK-cloud' });
  supabase.db.settings.push({ user_id: USER.id, key: 'tradier_key_at', value: 'now', updated_at: '2026-10-09T12:00:01.000Z' });
  const { run, storage, state } = await app({ supabase, session: SESSION, storage: joined([['tradier_key', 'TK-old']]) });
  const release = supabase.hold('get_tradier_key');
  const pulling = run('cloudPull()');
  await until(() => supabase.calls.some(c => c[1] === 'get_tradier_key'));
  run("store.set('tradier_key', 'TK-typed')");
  release();
  await pulling;
  assert.equal(storage.get('tradier_key'), 'TK-typed', "the account's older key doesn't overwrite it");
  assert.deepEqual([...state.cloudPending], ['tradier_key']);
  await run('cloudPush()');
  assert.equal(supabase.db.key, 'TK-typed');
});

test('edits made after the session ended stay pending and reach the account after signing in again', async () => {
  // the library dropped its saved session (refresh failed for good); the device is still bound to the account
  const supabase = fakeSupabase({ settings: [{ key: 'calc_risk', value: '1' }] });
  const storage = joined([['calc_risk', '1']]);
  const { run, state } = await app({ supabase, storage });
  run("store.set('calc_risk', '2')");
  assert.deepEqual(JSON.parse(storage.get('cloud_pending')), ['calc_risk']);
  await run(`initCloud('${GOOGLE_RETURN}')`);
  assert.equal(storage.get('calc_risk'), '2', 'the pending edit wins over the pull');
  assert.equal(supabase.db.settings.find(r => r.key === 'calc_risk').value, '2');
  assert.equal(state.cloudPending.size, 0);
});

test("a pull applies the other device's changes, keeps unsent edits, and doesn't mark anything pending", async () => {
  const supabase = fakeSupabase({ settings: [{ key: 'calc_account', value: '90000' }, { key: 'calc_risk', value: '3' }], key: 'TK-new' });
  supabase.db.settings.push({ user_id: USER.id, key: 'tradier_key_at', value: 'now', updated_at: '2026-10-09T12:00:01.000Z' });
  const storage = joined([['calc_account', '50000'], ['calc_risk', '1'], ['tradier_key', 'TK-old'], ['cloud_pending', '["calc_risk"]']]);
  const { run, elements, state } = await app({ supabase, session: SESSION, storage });
  run('loadPending()');
  await run('cloudPull()');
  assert.equal(storage.get('calc_account'), '90000');
  assert.equal(elements.get('accountSize').value, '90000');
  assert.equal(storage.get('calc_risk'), '1', 'an edit not yet sent wins');
  assert.equal(storage.get('tradier_key'), 'TK-new', 'a key change elsewhere is fetched from Vault');
  assert.deepEqual([...state.cloudPending], ['calc_risk']);
  assert.match(elements.get('errorBox').textContent, /Synced changes from your other device/);
});

test('a pull asks only for rows changed since the last one, and an echo of our own save is not news', async () => {
  const supabase = fakeSupabase();
  const { run, storage, elements } = await app({ supabase, session: SESSION, storage: joined() });
  run("store.set('calc_risk', '2')");
  await run('cloudPush()');
  await run('cloudPull()');
  assert.equal(elements.get('errorBox').textContent, '', 'our own save coming back is not a change');
  const seen = JSON.parse(storage.get('cloud_seen')).settings;
  assert.ok(seen);
  supabase.db.settings.push({ user_id: USER.id, key: 'calc_account', value: '70000', updated_at: '2030-01-01T00:00:00.000Z' });
  await run('cloudPull()');
  assert.equal(storage.get('calc_account'), '70000');
  assert.equal(JSON.parse(storage.get('cloud_seen')).settings, '2030-01-01T00:00:00.000Z');
});

test('a pull re-reads a minute back, so a save that committed late is not skipped, and rows already seen are no news', async () => {
  const supabase = fakeSupabase({ key: 'TK-cloud' });
  supabase.db.settings.push(
    { user_id: USER.id, key: 'calc_account', value: '70000', updated_at: '2026-10-09T13:00:00.000Z' },
    { user_id: USER.id, key: 'tradier_key_at', value: 'now', updated_at: '2026-10-09T12:59:50.000Z' },
  );
  const { run, storage, elements } = await app({ supabase, session: SESSION, storage: joined() });
  await run('cloudPull()');
  assert.equal(storage.get('calc_account'), '70000');
  assert.equal(storage.get('tradier_key'), 'TK-cloud');

  // started before the 13:00 save, committed after this device's pull: stamped earlier than anything seen
  supabase.db.settings.push({ user_id: USER.id, key: 'calc_risk', value: '2', updated_at: '2026-10-09T12:59:30.000Z' });
  elements.get('errorBox').textContent = '';
  await run('cloudPull()');
  assert.equal(supabase.calls.filter(c => c[0] === 'select').at(-1)[2], '2026-10-09T12:59:00.000Z', 'a minute before the newest row seen');
  assert.equal(storage.get('calc_risk'), '2', 'the late save still arrives');
  assert.match(elements.get('errorBox').textContent, /Synced changes/);

  elements.get('errorBox').textContent = '';
  await run('cloudPull()');
  assert.equal(elements.get('errorBox').textContent, '', 'rows read again in the overlap change nothing');
  assert.equal(supabase.calls.filter(c => c[1] === 'get_tradier_key').length, 1, 'the key is fetched once');
});

test("the Schwab worker URL from another device fills the Settings field, and sign-out leaves it", async () => {
  const supabase = fakeSupabase({ settings: [{ key: 'schwab_proxy', value: 'https://w.example' }] });
  const storage = joined([['schwab_tokens', '{"refresh":"r"}']]);
  const { run, elements } = await app({ supabase, session: SESSION, storage });
  run('reloadPage = () => {}');
  await run('cloudPull()');
  assert.equal(storage.get('schwab_proxy'), 'https://w.example');
  assert.equal(elements.get('schwabProxy').value, 'https://w.example', 'shown without a reload');
  await run('signOut()');
  assert.equal(storage.get('schwab_proxy'), 'https://w.example', "this device's Schwab login still needs its worker");
  assert.equal(storage.get('schwab_tokens'), '{"refresh":"r"}', 'signing out of Google is not a Schwab logout');
});

// ---------- signing out ----------

test('sign out sends pending edits, clears synced data from the device, and starts over', async () => {
  const supabase = fakeSupabase();
  const storage = joined([['calc_account', '50000'], ['tradier_key', 'TK'], ['show_daily', '0']]);
  const { run, state } = await app({ supabase, session: SESSION, storage });
  run('reloadPage = () => { globalThis.reloaded = true }; globalThis.reloaded = false');
  state.cloudPending.add('calc_account');
  await run('signOut()');
  assert.equal(supabase.db.settings.find(r => r.key === 'calc_account').value, '50000', 'sent before signing out');
  assert.deepEqual(supabase.calls.find(c => c[0] === 'signOut'), ['signOut', { scope: 'local' }], 'other devices stay signed in');
  for (const k of ['calc_account', 'tradier_key', 'cloud_user', 'cloud_seen']) assert.equal(storage.has(k), false, k);
  assert.equal(storage.get('show_daily'), '0');
  assert.equal(state.session, null);
  assert.equal(run('globalThis.reloaded'), true);
});

test('offline, the first Sign out warns and the second discards', async () => {
  const supabase = fakeSupabase();
  const storage = joined([['calc_account', '50000']]);
  const { run, state, elements } = await app({ supabase, session: SESSION, storage });
  run('reloadPage = () => { globalThis.reloaded = true }; globalThis.reloaded = false');
  run("store.set('calc_risk', '2')");
  supabase.fail({ status: 0, message: 'Failed to fetch' });
  await run('signOut()');
  assert.equal(run('globalThis.reloaded'), false);
  assert.match(elements.get('errorBox').textContent, /Sign out again to discard/);
  assert.ok(state.session);
  await run('signOut()');
  assert.equal(run('globalThis.reloaded'), true);
  assert.equal(storage.has('calc_account'), false);
});

test('Sign out waits for a check already running, then sends pending edits without a false warning', async () => {
  const supabase = fakeSupabase();
  const storage = joined([['calc_account', '50000']]);
  const { run, elements } = await app({ supabase, session: SESSION, storage });
  run('reloadPage = () => { globalThis.reloaded = true }; globalThis.reloaded = false');
  const release = supabase.hold('select');
  const pulling = run('cloudPull()');
  await until(() => supabase.calls.some(c => c[0] === 'select'));
  run("store.set('calc_risk', '2')");
  const out = run('signOut()');
  await until(() => elements.get('cloudStatus').textContent === 'Signing out…');
  release();
  await pulling;
  await out;
  assert.doesNotMatch(elements.get('errorBox').textContent, /haven't reached/);
  assert.equal(supabase.db.settings.find(r => r.key === 'calc_risk').value, '2', 'sent before signing out');
  assert.equal(run('globalThis.reloaded'), true);
});

test('Sign out during a check with nothing pending signs out without a warning', async () => {
  const supabase = fakeSupabase();
  const { run, elements } = await app({ supabase, session: SESSION, storage: joined() });
  run('reloadPage = () => { globalThis.reloaded = true }; globalThis.reloaded = false');
  const release = supabase.hold('select');
  const pulling = run('cloudPull()');
  const out = run('signOut()');
  release();
  await Promise.all([pulling, out]);
  assert.doesNotMatch(elements.get('errorBox').textContent, /haven't reached/);
  assert.equal(run('globalThis.reloaded'), true);
});

// ---------- merge rules ----------

test('first sign-in merge: an empty account takes everything; otherwise the account wins', async () => {
  const { run } = await app();
  const seed = JSON.parse(run(`JSON.stringify(mergeFirstSignIn({ settings: { calc_risk: '1' }, key: 'K' }, { settings: {}, key: '' }))`));
  assert.equal(seed.seeded, true);
  assert.deepEqual(seed.upload, { settings: { calc_risk: '1' }, key: 'K' });
  const join = JSON.parse(run(`JSON.stringify(mergeFirstSignIn({ settings: { calc_risk: '1', calc_allocation: '9' }, key: '' }, { settings: { calc_risk: '2' }, key: 'K2' }))`));
  assert.equal(join.seeded, false);
  assert.deepEqual(join.settings, { calc_risk: '2', calc_allocation: '9' });
  assert.deepEqual(join.upload, { settings: { calc_allocation: '9' }, key: null });
  assert.equal(join.key, 'K2');
  const foreign = JSON.parse(run(`JSON.stringify(mergeFirstSignIn({ settings: { calc_risk: '1', calc_allocation: '9' }, key: 'K' }, { settings: { calc_risk: '2' }, key: '' }, { foreign: true }))`));
  assert.deepEqual(foreign.settings, { calc_risk: '2' });
  assert.deepEqual(foreign.clear, ['calc_allocation']);
  assert.deepEqual(foreign.upload, { settings: {}, key: null });
  assert.equal(foreign.key, '', "another account's key isn't kept");
  assert.equal(foreign.seeded, false);
});

test('pull bookkeeping: a minute of overlap, and a row already seen is skipped', async () => {
  const { run } = await app();
  assert.equal(run("pullFrom('2026-10-09T13:00:00.000Z')"), '2026-10-09T12:59:00.000Z');
  assert.equal(run('pullFrom(undefined)'), '');
  const seen = JSON.parse(run(`JSON.stringify(seenAfter([{ key: 'a', updated_at: '2026-10-09T12:00:00.000Z' }, { key: 'b', updated_at: '2026-10-09T13:00:00.000Z' }], {}))`));
  assert.deepEqual(seen, { settings: '2026-10-09T13:00:00.000Z', keys: { a: '2026-10-09T12:00:00.000Z', b: '2026-10-09T13:00:00.000Z' } });
  const rows = run(`unseenRows([{ key: 'a', updated_at: '2026-10-09T12:00:00.000Z' }, { key: 'b', updated_at: '2026-10-09T13:00:01.000Z' }], ${JSON.stringify(seen.keys)}).map(r => r.key)`);
  assert.deepEqual([...rows], ['b']);
});

// ---------- leftover keys ----------

test('old saved positions from other devices are left alone and never sent', async () => {
  const storage = joined([['saved_positions', '{"a":1}'], ['calc_risk', '1']]);
  const { run } = await app({ storage, session: SESSION });
  assert.deepEqual(run("CLOUD_KEYS.filter(k => /positions/.test(k))"), []);
  run(`store.set('calc_risk', '2')`);
  run(`store.set('saved_positions', '{"c":3}')`);
  assert.deepEqual(JSON.parse(storage.get('cloud_pending')), ['calc_risk'], 'a leftover positions key is not an account edit');
});
