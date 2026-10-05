import { state } from '../state.js';
import { store, onStoreWrite } from '../lib/store.js';
import { BACKUP_KEYS, buildBackup, mergeBackupPayload } from './backup.js';
import { showToast } from '../ui/feedback.js';
import { setSyncUi, syncRehydrate } from '../ui/settings.js';

export const SYNC_SERVER = 'https://size-calc-sync.aolfat.workers.dev'; // hardcoded for now

export function syncEnabled() { return !!(store.get('sync_id') && store.get('sync_key')); }

export function syncEndpoint() { return SYNC_SERVER + '/' + store.get('sync_id'); }

export function lastSyncT() { return Number(store.get('last_sync_t') || 0); }

export function b64FromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function bytesFromB64(s) {
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

export async function deriveSyncCreds(pass) {
  // both halves come out of the slow KDF: the public sync_id must cost as much
  // to brute-force as the key, or it becomes a fast offline cracking oracle
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('size-calc-sync-v1'), iterations: 200000, hash: 'SHA-256' }, base, 512));
  return {
    id: [...bits.slice(32)].map(b => b.toString(16).padStart(2, '0')).join(''),
    keyB64: b64FromBytes(bits.slice(0, 32))
  };
}

export async function getSyncAesKey() {
  if (!state.syncKeyObj) state.syncKeyObj = await crypto.subtle.importKey('raw', bytesFromB64(store.get('sync_key')), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return state.syncKeyObj;
}

export async function syncEncrypt(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getSyncAesKey(), new TextEncoder().encode(text));
  return b64FromBytes(iv) + '.' + b64FromBytes(new Uint8Array(ct));
}

export async function syncDecrypt(blob) {
  const parts = String(blob).split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytesFromB64(parts[0]) }, await getSyncAesKey(), bytesFromB64(parts[1]));
  return new TextDecoder().decode(pt);
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

// every value-changing write to a synced key marks it dirty, except while a remote apply is in progress
onStoreWrite(k => { if (!state.syncSuppress && BACKUP_KEYS.includes(k)) markSyncDirty(k); });

export function saveDirty() { store.set('sync_dirty', JSON.stringify([...state.syncDirty])); }

export function markSyncDirty(k) {
  state.syncDirty.add(k);
  saveDirty();
  if (!syncEnabled()) return;
  clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(syncPush, 2500); // debounce: ten quick edits = one upload
  setSyncUi('saving…');
}

export function scheduleSyncPush() { clearTimeout(state.syncTimer); state.syncTimer = setTimeout(syncPush, 1000); }

export async function syncFetchRemote(metaOnly) {
  const res = await fetch(syncEndpoint() + (metaOnly ? '?meta=1' : ''), { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('sync http ' + res.status);
  return res.json();
}

// merge a decrypted remote payload into local storage. dirty keys = local edit the remote
// hasn't seen yet, so local wins there; positions merge per id, tombstones prune deletes.

export function syncApplyRemote(j) {
  const payload = j && j.data ? j.data : j;
  if (!payload) return;
  state.syncSuppress = true;
  try { mergeBackupPayload(payload, state.syncDirty); }
  finally { state.syncSuppress = false; }
  syncRehydrate();
}

// pull-merge-push: a push can never clobber a change it hasn't seen. The PUT carries the
// timestamp we read (?ift=), so the worker rejects with 409 if another device wrote in between.

export async function syncPush() {
  if (!syncEnabled()) return;
  if (state.syncBusy) { scheduleSyncPush(); return; }
  state.syncBusy = true;
  setSyncUi('saving…');
  let pushing = null; // dirty keys this push covers; edits landing mid-flight stay dirty for the next one
  try {
    const remote = await syncFetchRemote(false);
    if (remote && remote.t > lastSyncT()) {
      try { syncApplyRemote(JSON.parse(await syncDecrypt(remote.blob))); }
      catch(e) {} // unreadable cloud copy: our PUT below replaces it
    }
    pushing = [...state.syncDirty];
    state.syncDirty.clear();
    saveDirty();
    const blob = await syncEncrypt(buildBackup());
    const res = await fetch(syncEndpoint() + '?ift=' + (remote ? remote.t : 0), { method: 'PUT', body: blob });
    if (res.status === 409) { // another device pushed between our read and write: adopt it, then retry
      pushing.forEach(k => state.syncDirty.add(k));
      pushing = null;
      saveDirty();
      try {
        const cur = await res.json();
        if (cur && cur.blob) {
          syncApplyRemote(JSON.parse(await syncDecrypt(cur.blob)));
          store.set('last_sync_t', String(cur.t));
        }
      } catch(e) {}
      scheduleSyncPush();
      return;
    }
    if (!res.ok) throw new Error('sync http ' + res.status);
    store.set('last_sync_t', String((await res.json()).t));
    saveDirty();
    setSyncUi('synced · ' + new Date().toLocaleTimeString());
  } catch(e) {
    if (pushing) { pushing.forEach(k => state.syncDirty.add(k)); saveDirty(); }
    setSyncUi('offline · will retry'); // dirty set persists; the poll or the next edit retries
  } finally { state.syncBusy = false; }
}

export async function syncPull() {
  if (!syncEnabled() || state.syncBusy) return;
  state.syncBusy = true;
  try {
    const meta = await syncFetchRemote(true); // timestamp-only poll, fetch the blob only when newer
    if (meta && meta.t > lastSyncT()) {
      const remote = await syncFetchRemote(false);
      try {
        syncApplyRemote(JSON.parse(await syncDecrypt(remote.blob)));
      } catch(e) {
        store.set('last_sync_t', String(remote.t)); // don't re-download a blob we can't read
        setSyncUi('cloud copy unreadable · the next save from this device replaces it');
        return;
      }
      store.set('last_sync_t', String(remote.t));
      setSyncUi('synced · ' + new Date().toLocaleTimeString());
      showToast('Synced changes from your other device.');
      if (state.syncDirty.size) scheduleSyncPush(); // local edits got merged in — publish them
    }
  } catch(e) {
    setSyncUi('offline · will retry');
  } finally { state.syncBusy = false; }
}
