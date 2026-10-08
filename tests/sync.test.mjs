// Run with: node --test
// Sync and backup merge rules: dirty tracking, remote applies, and per-id position merges with tombstones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

// a sync id and key in storage is all syncEnabled() looks for; nothing here reaches the network
const syncOn = entries => new Map([['sync_id', 'test-id'], ['sync_key', 'dGVzdA=='], ...entries]);

test('a synced edit marks its key dirty and the settings sheet says it is saving', async () => {
  const storage = syncOn([['calc_account', '50000']]);
  const { run, elements } = await app({ storage });
  run("store.set('calc_account', '50000')");
  assert.equal(storage.get('sync_dirty'), undefined, 'a no-op rewrite is not an edit');
  run("store.set('calc_risk', '2')");
  assert.deepEqual(JSON.parse(storage.get('sync_dirty')), ['calc_risk']);
  assert.match(elements.get('syncStatus').textContent, /^Sync saving…\./);
});

test('device-local keys never mark sync dirty', async () => {
  const storage = syncOn([]);
  const { run } = await app({ storage });
  run("store.set('last_sync_t', '123'); store.set('show_daily', '0')");
  assert.equal(storage.get('sync_dirty'), undefined);
});

test('a remote apply keeps unsynced local edits, adopts the rest, and refreshes the page', async () => {
  const storage = syncOn([['calc_account', '50000'], ['calc_risk', '1']]);
  const { run, elements, state } = await app({ storage });
  run("state.syncDirty.add('calc_risk')");
  run("syncApplyRemote({ data: { calc_account: '80000', calc_risk: '3' } })");
  assert.equal(storage.get('calc_account'), '80000');
  assert.equal(storage.get('calc_risk'), '1', 'a dirty key is a local edit the remote has not seen');
  assert.equal(elements.get('accountSize').value, '80000', 'the page re-reads storage without a reload');
  assert.deepEqual([...state.syncDirty], ['calc_risk'], 'applying a remote copy is not a local edit');
});

test('old saved positions from other devices are left alone and never sent', async () => {
  const storage = new Map([['saved_positions', '{"a":1}'], ['calc_risk', '1']]);
  const { run } = await app({ storage });
  assert.deepEqual(run("BACKUP_KEYS.filter(k => /positions/.test(k))"), []);
  run(`mergeBackupPayload({ saved_positions: '{"b":2}', deleted_positions: '{"a":1}', calc_risk: '2' }, new Set())`);
  assert.equal(storage.get('saved_positions'), '{"a":1}');
  assert.equal(storage.has('deleted_positions'), false);
  assert.equal(storage.get('calc_risk'), '2');
  assert.doesNotMatch(run('buildBackup()'), /saved_positions/);
});

test('a file import with no recognized keys changes nothing', async () => {
  const storage = new Map([['calc_account', '50000']]);
  const { run } = await app({ storage });
  assert.throws(() => run("applyBackup(JSON.stringify({ app: 'size-calc', data: { nope: 1 } }))"), /no recognized keys/);
  assert.deepEqual([...storage], [['calc_account', '50000']]);
});
