// Settings sheet: API key and environment, backup file, and the sync switch and status line.
import { state } from '../state.js';
import { normalizeAtrMultiplier, normalizeStopStrategy, parseStopPercent } from '../core/stops.js';
import { store } from '../lib/store.js';
import { applyBackup, buildBackup } from '../services/backup.js';
import { deriveSyncCreds, onSyncView, saveDirty, scheduleSyncPush, syncApplyRemote, syncDecrypt, syncEnabled, syncFetchRemote, syncPull, syncPush } from '../services/sync.js';
import { showError, showToast } from './feedback.js';
import { recalcAll, renderUsdPresets, syncRiskDollar } from './risk.js';
import { openSheet } from './sheets.js';
import { updateStopVisibility } from './stops.js';

export function saveKey() {
  store.set('tradier_key', document.getElementById('apiKey').value.trim());
  store.set('tradier_env', document.getElementById('apiEnv').value);
  updateApiStatus();
}

export function loadKey() {
  document.getElementById('apiKey').value = store.get('tradier_key') || '';
  document.getElementById('apiEnv').value = store.get('tradier_env') || 'production';
  const acct = store.get('calc_account');
  const risk = store.get('calc_risk');
  if (acct) document.getElementById('accountSize').value = acct;
  if (risk) document.getElementById('riskPct').value = risk;
  const allocation = store.get('calc_allocation');
  if (allocation !== null) document.getElementById('allocationPct').value = allocation;
  const lastTicker = store.get('last_ticker');
  if (lastTicker) document.getElementById('ticker').value = lastTicker;
  state.atrMultiplier = normalizeAtrMultiplier(store.get('atr_multiplier'));
  const strategy = store.get('stop_strategy');
  state.stopStrategy = strategy === null ? (state.atrMultiplier ? 'atr' : 'none') : normalizeStopStrategy(strategy);
  if (state.stopStrategy === 'atr' && !state.atrMultiplier) state.atrMultiplier = 0.5;
  const percent = parseStopPercent(store.get('stop_percent'));
  state.stopPercent = Number.isFinite(percent) ? percent : 0.05;
  document.getElementById('stopPercent').value = String(state.stopPercent);
  updateStopVisibility();
  syncRiskDollar();
}

// re-read storage into the UI without a page reload (imports reload; live pulls shouldn't)

export function syncRehydrate() {
  state.syncSuppress = true;
  try {
    const tick = document.getElementById('ticker').value;
    loadKey();
    if (tick.trim()) document.getElementById('ticker').value = tick; // never yank a symbol the user typed or loaded
    updateApiStatus();
    renderUsdPresets();
    recalcAll();
  } finally { state.syncSuppress = false; }
}

export async function toggleSync() {
  if (syncEnabled()) {
    ['sync_id', 'sync_key', 'sync_dirty', 'last_sync_t'].forEach(k => store.del(k));
    state.syncDirty.clear();
    state.syncKeyObj = null;
    document.getElementById('syncPass').value = '';
    setSyncUi('');
    updateApiStatus();
    showToast('Sync off. Local data stays put.');
    return;
  }
  const pass = document.getElementById('syncPass').value;
  if (pass.length < 8) { showError('Use a longer passphrase (8+ characters). It is the only lock on your data.'); return; }
  if (!(window.crypto && crypto.subtle)) { showError('Sync needs a secure (https) page.'); return; }
  setSyncUi('connecting…');
  try {
    const creds = await deriveSyncCreds(pass);
    store.set('sync_id', creds.id);
    store.set('sync_key', creds.keyB64);
    store.set('last_sync_t', '0');
    state.syncKeyObj = null;
    document.getElementById('syncPass').value = '';
    state.syncDirty.clear(); // enabling adopts the cloud copy as truth (positions still merge)
    saveDirty();
    const remote = await syncFetchRemote(false);
    if (remote) {
      syncApplyRemote(JSON.parse(await syncDecrypt(remote.blob)));
      store.set('last_sync_t', String(remote.t));
      showToast('Sync on. Loaded the cloud copy.');
    } else {
      showToast('Sync on. This device seeded the cloud copy.');
    }
    await syncPush();
    updateApiStatus();
  } catch(e) {
    ['sync_id', 'sync_key'].forEach(k => store.del(k));
    state.syncKeyObj = null;
    setSyncUi('');
    showError('Could not reach the sync server. Check the URL.');
  }
}

// sync reports here: status line, re-read storage after a remote apply, a toast when another device's edits land
onSyncView({ status: setSyncUi, applied: syncRehydrate, pulled: () => showToast('Synced changes from your other device.') });

export function setSyncUi(status) {
  const on = syncEnabled();
  document.getElementById('syncBtn').textContent = on ? '✕ Disable sync' : '⇄ Enable sync';
  document.getElementById('syncPass').placeholder = on ? 'Passphrase set' : 'Same phrase on every device';
  document.getElementById('syncStatus').textContent = on
    ? 'Sync ' + (status || 'on') + '. Encrypted on this device, so the server only stores ciphertext.'
    : 'Syncs settings, your key, and positions across devices. Encrypted with your passphrase before it leaves this browser. Use the same phrase on every device.';
}

export function initSync() {
  try { JSON.parse(store.get('sync_dirty') || '[]').forEach(k => state.syncDirty.add(k)); } catch(e) {}
  setSyncUi('');
  if (syncEnabled()) syncPull().then(() => { if (state.syncDirty.size) scheduleSyncPush(); });
  // gentle poll keeps an open idle device current; pushes retry here too if one failed
  setInterval(() => {
    if (document.hidden || !syncEnabled() || state.syncBusy) return;
    state.syncDirty.size ? syncPush() : syncPull();
  }, 60000);
  window.addEventListener('focus', () => syncPull());
}

// backup file: download (and copy) everything, or merge one back in and reload

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

// setup status: the key line in Settings, the settings button's dot, and the first-run notice

export function updateApiStatus() {
  const key = document.getElementById('apiKey').value.trim();
  document.getElementById('apiStatus').innerHTML = (key
    ? `<span style="color:var(--green)">●</span> Key saved · ${document.getElementById('apiEnv').value}`
    : '○ No key yet') + (syncEnabled() ? ' · <span style="color:var(--blue)">⇄ Sync on</span>' : '');
  document.getElementById('settingsBtn').classList.toggle('needs-key', !key);
  updateSetupNotice();
}

// the friendly first step: shown in the calculator until a key is saved

export function updateSetupNotice() {
  const calc = !state.positionsView && !state.utilsView && !state.marketView && state.currentMode !== 'futures';
  document.getElementById('setupNotice').style.display = calc && !document.getElementById('apiKey').value.trim() ? '' : 'none';
}

export function requireKey() {
  if (document.getElementById('apiKey').value.trim()) return true;
  showError('Add your Tradier API key in Settings.');
  openSheet('settings');
  return false;
}
