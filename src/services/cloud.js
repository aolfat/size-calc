// Cloud sync for the signed-in user: settings, the Tradier key, and saved positions in Supabase. Edits are marked
// pending and sent together after a pause; pulls ask only for rows changed since the last one; a device's first
// sign-in merges with the account. Never touches the page: it reports through onCloudView.
import { state } from '../state.js';
import { store, onStoreWrite } from '../lib/store.js';
import { applyPositionRows, latestUpdate, mergeFirstSignIn, positionChanges, stableJson } from '../core/cloud-merge.js';
import { hasStoredSession, supabaseClient } from './supabase.js';

/** settings that live in the account (the Tradier key goes to Vault, positions to their own table) */
export const CLOUD_KEYS = ['calc_account', 'calc_risk', 'calc_allocation', 'risk_usd_presets', 'atr_multiplier', 'stop_strategy', 'stop_percent', 'last_ticker', 'tradier_env'];
/** device-local bookkeeping, never sent */
export const CLOUD_LOCAL_KEYS = ['cloud_pending', 'cloud_user', 'cloud_seen', 'cloud_positions'];
/** the old encrypted Cloudflare sync, removed: its keys are deleted at first sign-in */
export const OLD_SYNC_KEYS = ['sync_id', 'sync_key', 'sync_dirty', 'last_sync_t', 'sync_url'];

const SETTINGS_COLS = 'key,value,updated_at';
const POSITION_COLS = 'id,data,deleted_at,updated_at';

let view = { status: (/** @type {string} */ text) => {}, applied: () => {}, pulled: () => {} };
/** @param {{ status: (text: string) => void, applied: () => void, pulled: () => void }} handlers */
export function onCloudView(handlers) { view = handlers; }

/** signed in, or holding a saved session that hasn't been read yet (offline at load): either way, edits count */
export function cloudActive() { return !!state.session || hasStoredSession(); }

function readJson(k, fallback) { try { return JSON.parse(store.get(k) || 'null') ?? fallback; } catch(e) { return fallback; } }
const clock = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** a failed Supabase answer as an Error that carries its HTTP status */
function check(res) {
  if (res && res.error) {
    const err = new Error(res.error.message || 'Supabase error');
    err.status = res.status || res.error.status || 0;
    throw err;
  }
  return res || {};
}

// ---------- pending edits ----------

// every value-changing write to an account key marks it pending, except while server data is being applied
onStoreWrite(k => {
  if (state.cloudSuppress || !cloudActive()) return;
  if (CLOUD_KEYS.includes(k) || k === 'tradier_key' || k === 'saved_positions') markPending(k);
});

export function loadPending() {
  readJson('cloud_pending', []).forEach(k => state.cloudPending.add(k));
}

function savePending() { store.set('cloud_pending', JSON.stringify([...state.cloudPending])); }

export function markPending(k) {
  state.cloudPending.add(k);
  savePending();
  if (!state.session) return; // kept until the session is back
  schedulePush(2500); // debounce: ten quick edits = one save
  view.status('Saving…');
}

export function schedulePush(ms = 1000) {
  clearTimeout(state.cloudTimer);
  state.cloudTimer = setTimeout(cloudPush, ms);
}

// a refused session: keep this device's data and pending edits, and ask to sign in again
function failed(e) {
  if (e && (e.status === 401 || /jwt|session/i.test(e.message || ''))) {
    state.session = null;
    view.status('Your session ended. Sign in again.');
  } else {
    view.status('Offline, will retry');
  }
}

// ---------- push ----------

/** send pending edits. True when nothing is left pending. */
export async function cloudPush() {
  if (!state.session) return !state.cloudPending.size;
  if (state.cloudBusy) { schedulePush(1000); return false; }
  if (!state.cloudPending.size) return true;
  state.cloudBusy = true;
  view.status('Saving…');
  const pushing = new Set(state.cloudPending); // edits landing mid-flight stay pending for the next push
  state.cloudPending.clear();
  savePending();
  try {
    const client = await supabaseClient();
    const uid = state.session.user.id;
    const rows = CLOUD_KEYS.filter(k => pushing.has(k) && store.get(k) !== null).map(k => ({ user_id: uid, key: k, value: store.get(k) }));
    if (rows.length) check(await client.from('settings').upsert(rows));
    if (pushing.has('tradier_key')) check(await client.rpc('set_tradier_key', { new_key: store.get('tradier_key') || '' }));
    if (pushing.has('saved_positions')) await pushPositions(client, uid);
    view.status('Synced ' + clock());
    return !state.cloudPending.size;
  } catch(e) {
    pushing.forEach(k => state.cloudPending.add(k));
    savePending();
    failed(e);
    return false;
  } finally { state.cloudBusy = false; }
}

async function pushPositions(client, uid) {
  const local = readJson('saved_positions', {});
  const synced = readJson('cloud_positions', {});
  const { upserts, deletes } = positionChanges(local, synced);
  const now = new Date().toISOString();
  const rows = [
    ...Object.entries(upserts).map(([id, data]) => ({ user_id: uid, id, data, deleted_at: null })),
    ...deletes.map(id => ({ user_id: uid, id, data: JSON.parse(synced[id]), deleted_at: now })),
  ];
  if (!rows.length) return;
  check(await client.from('saved_positions').upsert(rows));
  for (const [id, data] of Object.entries(upserts)) synced[id] = stableJson(data);
  for (const id of deletes) delete synced[id];
  store.set('cloud_positions', JSON.stringify(synced));
}

// ---------- pull ----------

/** apply rows changed on the server since the last pull. Edits not yet sent win over what comes back. */
export async function cloudPull() {
  if (!state.session || state.cloudBusy) return;
  state.cloudBusy = true;
  try {
    const client = await supabaseClient();
    const seen = readJson('cloud_seen', {});
    let sq = client.from('settings').select(SETTINGS_COLS);
    if (seen.settings) sq = sq.gt('updated_at', seen.settings);
    const settingRows = check(await sq).data || [];
    let pq = client.from('saved_positions').select(POSITION_COLS);
    if (seen.positions) pq = pq.gt('updated_at', seen.positions);
    const positionRows = check(await pq).data || [];

    let changed = false;
    let newKey = null;
    if (settingRows.some(r => r.key === 'tradier_key_at') && !state.cloudPending.has('tradier_key')) {
      newKey = check(await client.rpc('get_tradier_key')).data || '';
    }
    state.cloudSuppress = true;
    try {
      for (const r of settingRows) {
        if (!CLOUD_KEYS.includes(r.key) || state.cloudPending.has(r.key)) continue;
        if (store.get(r.key) !== r.value) { store.set(r.key, r.value); changed = true; }
      }
      if (newKey !== null && (store.get('tradier_key') || '') !== newKey) { store.set('tradier_key', newKey); changed = true; }
      if (positionRows.length) {
        const res = applyPositionRows(readJson('saved_positions', {}), readJson('cloud_positions', {}), positionRows);
        if (res.changed) { store.set('saved_positions', JSON.stringify(res.positions)); changed = true; }
        store.set('cloud_positions', JSON.stringify(res.synced));
      }
    } finally { state.cloudSuppress = false; }
    store.set('cloud_seen', JSON.stringify({ settings: latestUpdate(settingRows, seen.settings || ''), positions: latestUpdate(positionRows, seen.positions || '') }));
    view.status('Synced ' + clock());
    if (changed) { view.applied(); view.pulled(); }
    if (state.cloudPending.size) schedulePush(1000);
  } catch(e) {
    failed(e);
  } finally { state.cloudBusy = false; }
}

// ---------- first sign-in on this device ----------

/**
 * Merge this device with the account: an empty account is filled from here, otherwise the account's settings and
 * key win and positions combine. Uploads go first, so a failure leaves this device as it was and the next sign-in
 * retries. Returns true when this device filled the account.
 */
export async function cloudFirstSignIn() {
  const client = await supabaseClient();
  const uid = state.session.user.id;
  const settingRows = check(await client.from('settings').select(SETTINGS_COLS)).data || [];
  const positionRows = check(await client.from('saved_positions').select(POSITION_COLS)).data || [];
  const cloudKey = check(await client.rpc('get_tradier_key')).data || '';

  /** @type {Record<string, string>} */
  const localSettings = {};
  for (const k of CLOUD_KEYS) { const v = store.get(k); if (v !== null) localSettings[k] = v; }
  /** @type {Record<string, string>} */
  const cloudSettings = {};
  for (const r of settingRows) if (CLOUD_KEYS.includes(r.key)) cloudSettings[r.key] = r.value;

  const m = mergeFirstSignIn(
    { settings: localSettings, key: store.get('tradier_key') || '', positions: readJson('saved_positions', {}), tombstones: readJson('deleted_positions', {}) },
    { settings: cloudSettings, key: cloudKey, positions: positionRows },
  );

  const uploadSettings = Object.entries(m.upload.settings).map(([key, value]) => ({ user_id: uid, key, value }));
  if (uploadSettings.length) check(await client.from('settings').upsert(uploadSettings));
  if (m.upload.key) check(await client.rpc('set_tradier_key', { new_key: m.upload.key }));
  const now = new Date().toISOString();
  const cloudData = new Map(positionRows.map(r => [r.id, r.data]));
  const uploadPositions = [
    ...Object.entries(m.upload.positions).map(([id, data]) => ({ user_id: uid, id, data, deleted_at: null })),
    ...m.upload.deletes.map(id => ({ user_id: uid, id, data: cloudData.get(id), deleted_at: now })),
  ];
  if (uploadPositions.length) check(await client.from('saved_positions').upsert(uploadPositions));

  state.cloudSuppress = true;
  try {
    for (const [k, v] of Object.entries(m.settings)) store.set(k, v);
    if (m.key) store.set('tradier_key', m.key);
    store.set('saved_positions', JSON.stringify(m.positions));
    /** @type {Record<string, string>} */
    const synced = {};
    for (const [id, data] of Object.entries(m.positions)) synced[id] = stableJson(data);
    store.set('cloud_positions', JSON.stringify(synced));
    store.set('cloud_seen', JSON.stringify({ settings: latestUpdate(settingRows, ''), positions: latestUpdate(positionRows, '') }));
    state.cloudPending.clear();
    savePending();
    OLD_SYNC_KEYS.forEach(k => store.del(k));
    store.set('cloud_user', uid);
  } finally { state.cloudSuppress = false; }
  return m.seeded;
}

// ---------- signing out ----------

/** remove everything synced from this device, so a shared computer keeps neither the key nor the positions */
export function cloudClearDevice() {
  [...CLOUD_KEYS, 'tradier_key', 'saved_positions', 'deleted_positions', ...CLOUD_LOCAL_KEYS].forEach(k => store.del(k));
  clearTimeout(state.cloudTimer);
  state.cloudPending.clear();
  state.session = null;
}
