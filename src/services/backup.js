// Backup and the sync payload: every synced key as one JSON blob, plus the merge rules both use.
// deleted_positions are tombstones so a delete beats a merge. The settings sheet owns the file buttons.
import { store } from '../lib/store.js';

export const BACKUP_KEYS = ['tradier_key', 'tradier_env', 'calc_account', 'calc_risk', 'calc_allocation', 'last_ticker', 'saved_positions', 'risk_usd_presets', 'deleted_positions', 'atr_multiplier', 'stop_strategy', 'stop_percent'];

export function buildBackup() {
  const out = { app: 'size-calc', exported: new Date().toISOString(), data: {} };
  BACKUP_KEYS.forEach(k => { const v = store.get(k); if (v !== null) out.data[k] = v; });
  return JSON.stringify(out, null, 2);
}

export function applyBackup(text) { // returns restored key count, throws on junk
  const j = JSON.parse(text);
  const payload = j && j.app === 'size-calc' && j.data ? j.data : j;
  // validate before touching storage — a rejected import must not mutate anything
  if (!payload || !BACKUP_KEYS.some(k => payload[k] !== undefined && payload[k] !== null)) throw new Error('no recognized keys');
  return mergeBackupPayload(payload, new Set());
}

// tombstones: deleted position ids, merged and pruned; a delete on one device beats a merge from another

export function mergeTombstones(extra) {
  let t = {};
  try { t = JSON.parse(store.get('deleted_positions') || '{}'); } catch(e) {}
  try { Object.assign(t, typeof extra === 'string' ? JSON.parse(extra) : (extra || {})); } catch(e) {}
  const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 180;
  Object.keys(t).forEach(id => { if (t[id] < cutoff) delete t[id]; });
  store.set('deleted_positions', JSON.stringify(t));
  return t;
}

// a backup file's merge: tombstoned deletes first, positions merge per id,
// scalars adopt the payload except keys in dirtySet (local edits the payload hasn't seen)

export function mergeBackupPayload(payload, dirtySet) {
  const tombs = mergeTombstones(payload.deleted_positions);
  let n = 0;
  BACKUP_KEYS.forEach(k => {
    if (k === 'deleted_positions' || payload[k] === undefined || payload[k] === null) return;
    if (k === 'saved_positions') {
      let local = {}, remote = {};
      try { local = JSON.parse(store.get(k) || '{}'); } catch(e) {}
      try { remote = JSON.parse(String(payload[k])); } catch(e) {}
      const merged = dirtySet.has(k) ? Object.assign({}, remote, local) : Object.assign({}, local, remote);
      Object.keys(tombs).forEach(id => delete merged[id]);
      store.set(k, JSON.stringify(merged));
      n++;
    } else if (!dirtySet.has(k)) {
      store.set(k, String(payload[k]));
      n++;
    }
  });
  return n;
}
