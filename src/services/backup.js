// Backup and the sync payload: every synced key as one JSON blob, plus the merge rule both use.
// The settings sheet owns the file buttons.
import { store } from '../lib/store.js';

export const BACKUP_KEYS = ['tradier_key', 'tradier_env', 'calc_account', 'calc_risk', 'calc_allocation', 'last_ticker', 'risk_usd_presets', 'atr_multiplier', 'stop_strategy', 'stop_percent'];

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

// shared by file import and live sync: keys adopt the payload except those in dirtySet (local edits the payload hasn't seen)

export function mergeBackupPayload(payload, dirtySet) {
  let n = 0;
  BACKUP_KEYS.forEach(k => {
    if (payload[k] === undefined || payload[k] === null || dirtySet.has(k)) return;
    store.set(k, String(payload[k]));
    n++;
  });
  return n;
}
