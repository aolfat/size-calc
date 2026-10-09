// Run with: node --test
// The account: Google sign-in through Supabase, a device's first sign-in, pending edits, pushes, pulls, sign-out,
// and the backup file's merge rules. A small in-memory fake stands in for the Supabase client: nothing reaches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const USER = { id: 'user-1', email: 'me@example.com' };
const SESSION = { user: USER, access_token: 'jwt' };
const GOOGLE_RETURN = 'https://aolfat.github.io/size-calc/?login=google&code=abc';

/** a fake Supabase client over in-memory tables; rows get server-side updated_at stamps like the real triggers */
function fakeSupabase({ settings = [], positions = [], key = '' } = {}) {
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 9, 12, 0, 0, ++tick)).toISOString();
  const db = {
    settings: settings.map(r => ({ user_id: USER.id, updated_at: stamp(), ...r })),
    saved_positions: positions.map(r => ({ user_id: USER.id, deleted_at: null, updated_at: stamp(), ...r })),
    key,
  };
  const calls = [];
  let failure = null;
  const answer = data => failure ? { data: null, error: { message: failure.message }, status: failure.status } : { data, error: null, status: 200 };
  const write = (table, rows) => {
    const idCol = table === 'settings' ? 'key' : 'id';
    for (const r of rows) {
      const row = { ...r, updated_at: stamp() };
      const i = db[table].findIndex(x => x[idCol] === r[idCol]);
      if (i >= 0) db[table][i] = row; else db[table].push(row);
    }
  };
  const client = {
    db, calls,
    fail(f) { failure = f; },
    from(table) {
      return {
        select() {
          calls.push(['select', table]);
          let since = '';
          const query = {
            gt(col, value) { since = value; return query; },
            then(resolve, reject) {
              const rows = db[table].filter(r => !since || r.updated_at > since).map(r => ({ ...r }));
              return Promise.resolve(answer(rows)).then(resolve, reject);
            },
          };
          return query;
        },
        async upsert(rows) {
          calls.push(['upsert', table, rows]);
          if (!failure) write(table, rows);
          return answer(null);
        },
      };
    },
    async rpc(name, args) {
      calls.push(['rpc', name, args]);
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

/** a saved option card with the fields the card renderer reads */
const card = mid => ({
  parsed: { ticker: 'AAPL', strike: 200, expStr: '2026-12-18', occ: 'AAPL261218C00200000' }, isCall: true,
  underlyingPrice: 201, stopName: 'LOD', stopLevel: 198, lodPct: 1.5, mid, entry: mid, qty: 1,
  atLod: mid * 0.6, atLodON: mid * 0.5, delta: 0.5, gamma: 0.02, iv: 0.3, asOf: '9:41',
});

/** a device that already finished its first sign-in */
const joined = (entries = []) => new Map([['cloud_user', USER.id], ...entries]);

// ---------- first sign-in ----------

test('the first device fills an empty account, skipping deleted positions, and drops the old sync keys', async () => {
  const supabase = fakeSupabase();
  const storage = new Map([
    ['calc_account', '50000'], ['calc_risk', '1'], ['tradier_key', 'TK-local'], ['show_daily', '0'],
    ['saved_positions', JSON.stringify({ saved_1: card(1), saved_2: card(2) })],
    ['deleted_positions', JSON.stringify({ saved_2: Date.now() })],
    ['sync_id', 'old'], ['sync_key', 'old'], ['sync_dirty', '[]'], ['last_sync_t', '1'],
  ]);
  const { run, elements, state } = await app({ supabase, storage, lenient: true });
  await run(`initCloud('${GOOGLE_RETURN}')`);

  assert.deepEqual(supabase.calls.find(c => c[0] === 'exchange'), ['exchange', 'abc']);
  assert.equal(state.session.user.id, USER.id);
  assert.deepEqual(Object.fromEntries(supabase.db.settings.filter(r => r.key !== 'tradier_key_at').map(r => [r.key, r.value])), { calc_account: '50000', calc_risk: '1' });
  assert.ok(supabase.db.settings.every(r => r.user_id === USER.id));
  assert.equal(supabase.db.key, 'TK-local', 'the key goes to Vault');
  assert.deepEqual(supabase.db.saved_positions.map(r => r.id), ['saved_1'], 'a position deleted here is not uploaded');
  for (const k of ['sync_id', 'sync_key', 'sync_dirty', 'last_sync_t']) assert.equal(storage.has(k), false, k);
  assert.equal(storage.get('show_daily'), '0', 'device-only settings stay put');
  assert.equal(storage.get('cloud_user'), USER.id);
  assert.match(elements.get('errorBox').textContent, /Saved this device's settings/);
  assert.equal(elements.get('signOutBtn').style.display, '');
  assert.equal(elements.get('signInBtn').style.display, 'none');
  assert.match(elements.get('accountEmail').textContent, /me@example\.com/);
  assert.equal(state.cloudPending.size, 0, 'the merge itself is not a pending edit');
});

test('a second device adopts the account, combines positions, and respects deletes both ways', async () => {
  const supabase = fakeSupabase({
    settings: [{ key: 'calc_account', value: '80000' }, { key: 'calc_risk', value: '2' }],
    key: 'TK-cloud',
    positions: [
      { id: 'saved_cloud', data: card(3) },
      { id: 'saved_shared', data: { ...card(4), qty: 2 } },
      { id: 'saved_gone', data: card(5), deleted_at: '2026-10-01T00:00:00Z' },
      { id: 'saved_killed_here', data: card(6) },
    ],
  });
  const storage = new Map([
    ['calc_account', '50000'], ['calc_allocation', '15'], ['tradier_key', 'TK-local'],
    ['saved_positions', JSON.stringify({ saved_local: card(1), saved_shared: { ...card(4), qty: 9 }, saved_gone: card(5) })],
    ['deleted_positions', JSON.stringify({ saved_killed_here: Date.now() })],
  ]);
  const { run, elements, state } = await app({ supabase, storage, lenient: true });
  await run(`initCloud('${GOOGLE_RETURN}')`);

  assert.equal(storage.get('calc_account'), '80000', "the account's settings win");
  assert.equal(storage.get('calc_risk'), '2');
  assert.equal(storage.get('calc_allocation'), '15', 'a setting only this device has is kept');
  assert.equal(supabase.db.settings.find(r => r.key === 'calc_allocation').value, '15', 'and uploaded');
  assert.equal(storage.get('tradier_key'), 'TK-cloud');
  assert.equal(elements.get('apiKey').value, 'TK-cloud', 'the page shows the account without a reload');
  assert.deepEqual(Object.keys(JSON.parse(storage.get('saved_positions'))).sort(), ['saved_cloud', 'saved_local', 'saved_shared']);
  assert.equal(JSON.parse(storage.get('saved_positions')).saved_shared.qty, 2, "the account's copy of a shared position wins");
  assert.ok(supabase.db.saved_positions.find(r => r.id === 'saved_local'), 'a position only this device has is uploaded');
  assert.ok(supabase.db.saved_positions.find(r => r.id === 'saved_killed_here').deleted_at, 'a delete made here reaches the account');
  assert.match(elements.get('errorBox').textContent, /Loaded your settings/);
  assert.ok(state.savedData.saved_cloud, 'saved cards reload from the merged list');
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

test('positions sync one by one: edits and deletes go up, deletes elsewhere come down', async () => {
  const supabase = fakeSupabase({ positions: [{ id: 'saved_a', data: { mid: 1, qty: 1 } }, { id: 'saved_b', data: { mid: 2 } }] });
  const storage = joined([
    ['saved_positions', JSON.stringify({ saved_a: { qty: 1, mid: 1 }, saved_b: { mid: 2 } })],
    ['cloud_positions', JSON.stringify({ saved_a: '{"mid":1,"qty":1}', saved_b: '{"mid":2}' })],
    ['cloud_seen', JSON.stringify({ settings: '', positions: '2026-10-09T12:00:00.002Z' })],
  ]);
  const { run, state } = await app({ supabase, session: SESSION, storage, lenient: true });
  // what persistSaved writes after editing saved_a's quantity and deleting saved_b
  run(`store.set('saved_positions', JSON.stringify({ saved_a: { qty: 5, mid: 1 } }))`);
  assert.ok(state.cloudPending.has('saved_positions'));
  await run('cloudPush()');
  assert.equal(supabase.db.saved_positions.find(r => r.id === 'saved_a').data.qty, 5);
  assert.ok(supabase.db.saved_positions.find(r => r.id === 'saved_b').deleted_at);
  const upserted = supabase.calls.filter(c => c[0] === 'upsert' && c[1] === 'saved_positions').pop()[2];
  assert.deepEqual(upserted.map(r => r.id).sort(), ['saved_a', 'saved_b'], 'only what changed is sent');

  // keys reordered by Postgres jsonb are the same card; a delete from the other device removes it here
  await run('cloudPull()');
  assert.ok(JSON.parse(storage.get('saved_positions')).saved_a);
  supabase.db.saved_positions.find(r => r.id === 'saved_a').deleted_at = '2030-01-01T00:00:00.000Z';
  supabase.db.saved_positions.find(r => r.id === 'saved_a').updated_at = '2030-01-01T00:00:00.000Z';
  await run('cloudPull()');
  assert.deepEqual(JSON.parse(storage.get('saved_positions')), {});
});

// ---------- signing out ----------

test('sign out sends pending edits, clears synced data from the device, and starts over', async () => {
  const supabase = fakeSupabase();
  const storage = joined([['calc_account', '50000'], ['tradier_key', 'TK'], ['saved_positions', '{"saved_a":{"mid":1}}'], ['show_daily', '0']]);
  const { run, state } = await app({ supabase, session: SESSION, storage, lenient: true });
  run('reloadPage = () => { globalThis.reloaded = true }; globalThis.reloaded = false');
  state.cloudPending.add('calc_account');
  await run('signOut()');
  assert.equal(supabase.db.settings.find(r => r.key === 'calc_account').value, '50000', 'sent before signing out');
  assert.deepEqual(supabase.calls.find(c => c[0] === 'signOut'), ['signOut', { scope: 'local' }], 'other devices stay signed in');
  for (const k of ['calc_account', 'tradier_key', 'saved_positions', 'cloud_user']) assert.equal(storage.has(k), false, k);
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

// ---------- merge rules ----------

test('first sign-in merge: an empty account takes everything; otherwise the account wins', async () => {
  const { run } = await app();
  const seed = JSON.parse(run(`JSON.stringify(mergeFirstSignIn(
    { settings: { calc_risk: '1' }, key: 'K', positions: { a: { m: 1 } }, tombstones: {} },
    { settings: {}, key: '', positions: [] }))`));
  assert.equal(seed.seeded, true);
  assert.deepEqual(seed.upload, { settings: { calc_risk: '1' }, key: 'K', positions: { a: { m: 1 } }, deletes: [] });
  const join = JSON.parse(run(`JSON.stringify(mergeFirstSignIn(
    { settings: { calc_risk: '1' }, key: '', positions: {}, tombstones: {} },
    { settings: { calc_risk: '2' }, key: 'K2', positions: [{ id: 'b', data: { m: 2 } }] }))`));
  assert.equal(join.seeded, false);
  assert.deepEqual(join.settings, { calc_risk: '2' });
  assert.equal(join.key, 'K2');
  assert.equal(join.upload.key, null);
  assert.deepEqual(join.positions, { b: { m: 2 } });
});

test('stable JSON ignores key order', async () => {
  const { run } = await app();
  assert.equal(run("stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })"), run("stableJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 })"));
});

// ---------- backup file ----------

test('a backup file merges positions per id and a tombstoned delete stays deleted', async () => {
  const local = JSON.stringify({ a: { v: 1 }, b: { v: 1 } });
  const remote = "JSON.stringify({ b: { v: 2 }, c: { v: 2 } })";
  const tombstone = "JSON.stringify({ a: Date.now() })";
  const clean = new Map([['saved_positions', local]]);
  (await app({ storage: clean })).run(`mergeBackupPayload({ saved_positions: ${remote}, deleted_positions: ${tombstone} }, new Set())`);
  assert.deepEqual(JSON.parse(clean.get('saved_positions')), { b: { v: 2 }, c: { v: 2 } });
});

test('a file import with no recognized keys changes nothing', async () => {
  const storage = new Map([['calc_account', '50000']]);
  const { run } = await app({ storage });
  assert.throws(() => run("applyBackup(JSON.stringify({ app: 'size-calc', data: { nope: 1 } }))"), /no recognized keys/);
  assert.deepEqual([...storage], [['calc_account', '50000']]);
});
