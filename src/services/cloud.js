// Cloud sync for the signed-in user: settings and the Tradier key in Supabase. Edits are marked
// pending and sent together after a pause; pulls ask only for rows changed since the last one; a device's first
// sign-in merges with the account. Never touches the page: it reports through onCloudView.
import { state } from '../state.js';
import { store, onStoreWrite } from '../lib/store.js';
import { mergeFirstSignIn, pullFrom, seenAfter, unseenRows } from '../core/cloud-merge.js';
import { hasStoredSession, supabaseClient } from './supabase.js';

/** settings that live in the account (the Tradier key goes to Vault) */
export const CLOUD_KEYS = ['calc_account', 'calc_risk', 'calc_allocation', 'risk_usd_presets', 'atr_multiplier', 'stop_strategy', 'stop_percent', 'last_ticker', 'tradier_env', 'schwab_proxy'];
/** synced, but kept on sign-out: this device's own Schwab login still needs its worker */
const KEPT_ON_SIGN_OUT = ['schwab_proxy'];
/** device-local bookkeeping, never sent */
export const CLOUD_LOCAL_KEYS = ['cloud_pending', 'cloud_user', 'cloud_seen'];
/** the old encrypted Cloudflare sync, removed: its keys are deleted at first sign-in */
export const OLD_SYNC_KEYS = ['sync_id', 'sync_key', 'sync_dirty', 'last_sync_t', 'sync_url'];

const SETTINGS_COLS = 'key,value,updated_at';

let view = { status: (/** @type {string} */ text) => {}, applied: () => {}, pulled: () => {} };
/** @param {{ status: (text: string) => void, applied: () => void, pulled: () => void }} handlers */
export function onCloudView(handlers) { view = handlers; }

/**
 * edits count while signed in, while holding a saved session not read yet (offline at load), and while this device
 * is still bound to an account whose session ended: they go out after signing in again
 */
export function cloudActive() { return !!state.session || hasStoredSession() || !!store.get('cloud_user'); }

/** signed in and merged with this account: the first sign-in has finished here */
const merged = () => !!state.session && store.get('cloud_user') === state.session.user.id;

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

// ---------- one at a time ----------

/** run a push, pull or merge alone: state.cloudBusy holds it while it runs, so others can wait for it */
function exclusive(work) {
  const run = (async () => { try { return await work(); } finally { state.cloudBusy = false; } })();
  state.cloudBusy = run;
  return run;
}

/** wait until no push, pull or merge is running; false when one is still running after ms (a dead connection) */
async function settle(ms = Infinity) {
  const LATE = Symbol('late');
  let timer;
  const late = Number.isFinite(ms) ? new Promise(r => { timer = setTimeout(() => r(LATE), ms); }) : null;
  try {
    while (typeof state.cloudBusy?.then === 'function') {
      const busy = state.cloudBusy.catch(() => {});
      if ((await (late ? Promise.race([busy, late]) : busy)) === LATE) return false;
    }
    return true;
  } finally { clearTimeout(timer); }
}

/** how long Sign out waits for a save or check already running */
const FLUSH_WAIT = 10000;

// ---------- pending edits ----------

// every value-changing write to an account key marks it pending, except while server data is being applied
onStoreWrite(k => {
  if (state.cloudSuppress || !cloudActive()) return;
  if (CLOUD_KEYS.includes(k) || k === 'tradier_key') markPending(k);
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
  if (!state.cloudPending.size) return true;
  if (!merged()) return false; // kept until the session is back
  if (state.cloudBusy) { schedulePush(1000); return false; }
  return exclusive(async () => {
    view.status('Saving…');
    // sent as they are now, and pending (on the device too) until the server has them: a page killed mid-save resends
    const sending = new Map([...state.cloudPending].map(k => [k, store.get(k)]));
    // done = the server has this value; a key edited again mid-flight stays pending for the next push
    const done = keys => { keys.forEach(k => { if (store.get(k) === sending.get(k)) state.cloudPending.delete(k); }); savePending(); };
    try {
      const client = await supabaseClient();
      const uid = state.session.user.id;
      const rows = CLOUD_KEYS.filter(k => sending.has(k) && sending.get(k) !== null).map(k => ({ user_id: uid, key: k, value: sending.get(k) }));
      if (rows.length) check(await client.from('settings').upsert(rows));
      done([...sending.keys()].filter(k => k !== 'tradier_key')); // saved, removed (nothing to send), or not an account key
      if (sending.has('tradier_key')) {
        check(await client.rpc('set_tradier_key', { new_key: sending.get('tradier_key') || '' }));
        done(['tradier_key']);
      }
      view.status('Synced ' + clock());
      return !state.cloudPending.size;
    } catch(e) {
      failed(e);
      return false;
    }
  });
}

/**
 * Sign out's last save: wait (a while, not forever) for a running push or pull, then send what's pending. True when
 * nothing is left; false when edits couldn't be sent or the running one never finished.
 */
export async function cloudFlush(ms = FLUSH_WAIT) {
  if (!(await settle(ms))) return !state.cloudPending.size;
  return state.cloudBusy ? !state.cloudPending.size : cloudPush(); // a poll that slipped in first: nothing pending is fine
}

// ---------- pull ----------

/**
 * apply rows changed on the server since the last pull. Each pull re-reads a minute back (a save can commit after a
 * later-stamped one); rows already seen are skipped. Edits not yet sent win over what comes back.
 */
export async function cloudPull() {
  if (!merged() || state.cloudBusy) return;
  return exclusive(async () => {
    try {
      const client = await supabaseClient();
      const seen = readJson('cloud_seen', {});
      let sq = client.from('settings').select(SETTINGS_COLS);
      const since = pullFrom(seen.settings);
      if (since) sq = sq.gt('updated_at', since);
      const settingRows = check(await sq).data || [];
      const fresh = unseenRows(settingRows, seen.keys || {});

      let changed = false;
      let newKey = null;
      const keyBefore = store.get('tradier_key');
      if (fresh.some(r => r.key === 'tradier_key_at') && !state.cloudPending.has('tradier_key')) {
        newKey = check(await client.rpc('get_tradier_key')).data || '';
      }
      state.cloudSuppress = true;
      try {
        for (const r of fresh) {
          if (!CLOUD_KEYS.includes(r.key) || state.cloudPending.has(r.key)) continue;
          if (store.get(r.key) !== r.value) { store.set(r.key, r.value); changed = true; }
        }
        // a key typed while Vault answered is newer than Vault's
        const keptHere = state.cloudPending.has('tradier_key') || store.get('tradier_key') !== keyBefore;
        if (newKey !== null && !keptHere && (keyBefore || '') !== newKey) { store.set('tradier_key', newKey); changed = true; }
      } finally { state.cloudSuppress = false; }
      store.set('cloud_seen', JSON.stringify(seenAfter(settingRows, seen)));
      view.status('Synced ' + clock());
      if (changed) { view.applied(); view.pulled(); }
      if (state.cloudPending.size) schedulePush(1000);
    } catch(e) {
      failed(e);
    }
  });
}

// ---------- first sign-in on this device ----------

/**
 * Merge this device with the account: an empty account is filled from here, otherwise the account's settings and
 * key win. A device last bound to another account holds that account's data: nothing is uploaded, and synced
 * settings the new account doesn't have are cleared, the key too. Uploads go first, so a failure leaves this device
 * as it was and the next sign-in retries.
 * Returns { seeded: this device filled the account, foreign: it was another account's, dropped: that account's unsent edits }.
 */
export async function cloudFirstSignIn() {
  await settle();
  return exclusive(async () => {
    const client = await supabaseClient();
    const uid = state.session.user.id;
    const before = store.get('cloud_user');
    const foreign = !!before && before !== uid;
    const settingRows = check(await client.from('settings').select(SETTINGS_COLS)).data || [];
    const cloudKey = check(await client.rpc('get_tradier_key')).data || '';

    /** @type {Record<string, string>} */
    const localSettings = {};
    for (const k of CLOUD_KEYS) { const v = store.get(k); if (v !== null) localSettings[k] = v; }
    /** @type {Record<string, string>} */
    const cloudSettings = {};
    for (const r of settingRows) if (CLOUD_KEYS.includes(r.key)) cloudSettings[r.key] = r.value;

    const m = mergeFirstSignIn({ settings: localSettings, key: store.get('tradier_key') || '' }, { settings: cloudSettings, key: cloudKey }, { foreign });

    const uploadSettings = Object.entries(m.upload.settings).map(([key, value]) => ({ user_id: uid, key, value }));
    if (uploadSettings.length) check(await client.from('settings').upsert(uploadSettings));
    if (m.upload.key) check(await client.rpc('set_tradier_key', { new_key: m.upload.key }));

    const dropped = foreign ? state.cloudPending.size : 0;
    state.cloudSuppress = true;
    try {
      for (const [k, v] of Object.entries(m.settings)) store.set(k, v);
      m.clear.filter(k => !KEPT_ON_SIGN_OUT.includes(k)).forEach(k => store.del(k));
      if (m.key) store.set('tradier_key', m.key);
      else if (foreign) store.del('tradier_key');
      store.set('cloud_seen', JSON.stringify(seenAfter(settingRows, {})));
      state.cloudPending.clear();
      savePending();
      OLD_SYNC_KEYS.forEach(k => store.del(k));
      store.set('cloud_user', uid);
    } finally { state.cloudSuppress = false; }
    return { seeded: m.seeded, foreign, dropped };
  });
}

// ---------- signing out ----------

/** remove everything synced from this device, so a shared computer doesn't keep the key */
export function cloudClearDevice() {
  [...CLOUD_KEYS.filter(k => !KEPT_ON_SIGN_OUT.includes(k)), 'tradier_key', ...CLOUD_LOCAL_KEYS].forEach(k => store.del(k));
  clearTimeout(state.cloudTimer);
  state.cloudPending.clear();
  state.session = null;
}
