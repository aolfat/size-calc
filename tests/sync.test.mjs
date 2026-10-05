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

test('positions merge per id and a tombstoned delete stays deleted', async () => {
  const local = JSON.stringify({ a: { v: 1 }, b: { v: 1 } });
  const remote = "JSON.stringify({ b: { v: 2 }, c: { v: 2 } })";
  const tombstone = "JSON.stringify({ a: Date.now() })";

  const clean = new Map([['saved_positions', local]]);
  (await app({ storage: clean })).run(`mergeBackupPayload({ saved_positions: ${remote}, deleted_positions: ${tombstone} }, new Set())`);
  assert.deepEqual(JSON.parse(clean.get('saved_positions')), { b: { v: 2 }, c: { v: 2 } });

  const dirty = new Map([['saved_positions', local]]);
  (await app({ storage: dirty })).run(`mergeBackupPayload({ saved_positions: ${remote}, deleted_positions: ${tombstone} }, new Set(['saved_positions']))`);
  assert.deepEqual(JSON.parse(dirty.get('saved_positions')), { b: { v: 1 }, c: { v: 2 } }, 'local edits win where both changed');
});

test('a file import with no recognized keys changes nothing', async () => {
  const storage = new Map([['calc_account', '50000']]);
  const { run } = await app({ storage });
  assert.throws(() => run("applyBackup(JSON.stringify({ app: 'size-calc', data: { nope: 1 } }))"), /no recognized keys/);
  assert.deepEqual([...storage], [['calc_account', '50000']]);
});
