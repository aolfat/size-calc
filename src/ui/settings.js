// Settings sheet: the account (Google sign-in and sync status), API key and environment.
import { state } from '../state.js';
import { normalizeAtrMultiplier, normalizeStopStrategy, parseStopPercent } from '../core/stops.js';
import { store } from '../lib/store.js';
import { cloudClearDevice, cloudFirstSignIn, cloudPull, cloudPush, loadPending, onCloudView } from '../services/cloud.js';
import { currentSession, finishGoogleReturn, hasStoredSession, isGoogleReturn, signInWithGoogle, signOutSupabase } from '../services/supabase.js';
import { effects } from './effects.js';
import { showError, showToast } from './feedback.js';
import { recalcAll, renderUsdPresets, syncRiskDollar } from './risk.js';
import { openSheet } from './sheets.js';
import { updateStopVisibility } from './stops.js';
import { updateSchwabUi } from './trade.js';

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

// re-read storage into the UI without a page reload (imports and sign-out reload; synced changes shouldn't)

export function cloudRehydrate() {
  state.cloudSuppress = true;
  try {
    const tick = document.getElementById('ticker').value;
    loadKey();
    if (tick.trim()) document.getElementById('ticker').value = tick; // never yank a symbol the user typed or loaded
    updateApiStatus();
    updateSchwabUi(); // the worker URL syncs
    renderUsdPresets();
    recalcAll();
  } finally { state.cloudSuppress = false; }
}

// ---------- account: Google sign-in through Supabase ----------

export async function signIn() {
  setCloudUi('Opening Google…');
  try {
    await signInWithGoogle(location.href); // the browser leaves for Google here
  } catch(e) {
    setCloudUi('');
    showError("Couldn't start Google sign-in. Check your connection and try again.");
  }
}

export async function signOut() {
  if (!state.session) return;
  setCloudUi('Signing out…');
  const sent = await cloudPush();
  if (!sent && !state.signOutArmed) {
    state.signOutArmed = true;
    setCloudUi('Offline, will retry');
    showError("Your last changes haven't reached your account. Sign out again to discard them.");
    return;
  }
  state.signOutArmed = false;
  await signOutSupabase();
  cloudClearDevice();
  effects.reloadPage();
}

// a session on this device: the first one merges with the account, later ones catch up and send what's pending
async function startSession(session) {
  state.session = session;
  setCloudUi('Syncing…');
  if (store.get('cloud_user') !== session.user.id) {
    let seeded;
    // not merged yet = not signed in here: the poll retries the whole first sign-in rather than syncing half-joined
    try { seeded = await cloudFirstSignIn(); } catch(e) { state.session = null; throw e; }
    cloudRehydrate();
    showToast(seeded ? "Signed in. Saved this device's settings to your account." : 'Signed in. Loaded your settings from your account.');
    setCloudUi('Synced');
  } else {
    await cloudPull();
    if (state.cloudPending.size) await cloudPush();
  }
  updateApiStatus();
}

async function resumeSession() {
  const session = await currentSession();
  if (session) await startSession(session);
  else setCloudUi('');
}

// synced changes report here: status line, re-read storage, and a toast when another device's edits land
onCloudView({ status: setCloudUi, applied: cloudRehydrate, pulled: () => showToast('Synced changes from your other device.') });

export function setCloudUi(status) {
  const s = state.session;
  document.getElementById('signInBtn').style.display = s ? 'none' : '';
  document.getElementById('signOutBtn').style.display = s ? '' : 'none';
  const who = document.getElementById('accountEmail');
  who.textContent = s ? 'Signed in as ' + (s.user.email || 'your Google account') : '';
  who.style.display = s ? '' : 'none';
  document.getElementById('cloudStatus').textContent = status || '';
  document.getElementById('accountHint').textContent = s
    ? 'Your settings and Tradier key sync across your devices.'
    : 'Sync your settings and Tradier key across devices. The calculator works without signing in.';
  document.getElementById('apiNotice').innerHTML = (s ? 'Saved to your account, encrypted. ' : 'Stored in this browser. ')
    + 'Requests go straight to Tradier. Get a free key at <a href="https://developer.tradier.com" target="_blank" rel="noopener">developer.tradier.com</a>.';
}

export async function initCloud(href = location.href) {
  loadPending();
  setCloudUi('');
  if (isGoogleReturn(href)) {
    const url = new URL(href);
    globalThis.history?.replaceState(null, '', url.pathname + url.hash); // the code is single-use: off the address bar now
    const failed = e => {
      state.session = null;
      setCloudUi('');
      showError('Google sign-in failed. ' + (e && e.message ? e.message : 'Try again.'));
    };
    let session = null;
    try { session = await finishGoogleReturn(href); } catch(e) {
      // an old return address opened again (Chrome's history, autocomplete, a restored tab): its code is spent,
      // but the session it made is still on this device
      if (hasStoredSession()) await resumeSession().catch(() => setCloudUi('Offline, will retry'));
      if (!state.session && !hasStoredSession()) failed(e);
    }
    if (session) {
      try {
        await startSession(session);
        openSheet('settings');
      } catch(e) { failed(e); }
    }
  } else if (hasStoredSession()) {
    await resumeSession().catch(() => setCloudUi('Offline, will retry'));
  }
  // gentle poll keeps an open idle device current; it also retries failed saves and a session that couldn't load
  setInterval(() => {
    if (document.hidden || state.cloudBusy) return;
    if (!state.session) { if (hasStoredSession()) resumeSession().catch(() => {}); return; }
    state.cloudPending.size ? cloudPush() : cloudPull();
  }, 60000);
  window.addEventListener('focus', () => cloudPull());
}

// setup status: the key line in Settings, the settings button's dot, and the first-run notice

export function updateApiStatus() {
  const key = document.getElementById('apiKey').value.trim();
  document.getElementById('apiStatus').innerHTML = (key
    ? `<span style="color:var(--green)">●</span> Key saved · ${document.getElementById('apiEnv').value}`
    : '○ No key yet') + (state.session ? ' · <span style="color:var(--blue)">Signed in</span>' : '');
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
