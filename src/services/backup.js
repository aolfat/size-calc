import { store } from '../lib/store.js';
import { mergeTombstones } from './sync.js';
import { showError, showToast } from '../ui/feedback.js';

// ---------- backup: everything the app stores, as a JSON file ----------
// also the sync payload — deleted_positions are tombstones so a delete beats a merge

export const BACKUP_KEYS = ['tradier_key', 'tradier_env', 'calc_account', 'calc_risk', 'calc_allocation', 'last_ticker', 'saved_positions', 'risk_usd_presets', 'deleted_positions', 'atr_multiplier', 'stop_strategy', 'stop_percent'];

export function buildBackup() {
  const out = { app: 'size-calc', exported: new Date().toISOString(), data: {} };
  BACKUP_KEYS.forEach(k => { const v = store.get(k); if (v !== null) out.data[k] = v; });
  return JSON.stringify(out, null, 2);
}

export function exportBackup() {
  const json = buildBackup();
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'size-calc-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  if (navigator.clipboard) navigator.clipboard.writeText(json).catch(() => {});
  showToast('Backup downloaded (and copied to clipboard). Keep it private — it includes your API key.');
}

export function applyBackup(text) { // returns restored key count, throws on junk
  const j = JSON.parse(text);
  const payload = j && j.app === 'size-calc' && j.data ? j.data : j;
  // validate before touching storage — a rejected import must not mutate anything
  if (!payload || !BACKUP_KEYS.some(k => payload[k] !== undefined && payload[k] !== null)) throw new Error('no recognized keys');
  return mergeBackupPayload(payload, new Set());
}

// shared by file import and live sync: tombstoned deletes first, positions merge per id,
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

export function importBackup(input) {
  const f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyBackup(reader.result);
      location.reload(); // rehydrate everything from storage
    } catch(e) {
      showError('Import failed — not a Size Calc backup file.');
    }
  };
  reader.readAsText(f);
}
