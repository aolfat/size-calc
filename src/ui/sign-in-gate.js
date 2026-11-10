// The sign-in gate: Size works signed out, every other tab (Market, Positions, Journal, Tools) asks for a Google sign-in first.
import { state } from '../state.js';
import { CREDENTIAL_ORIGIN_MESSAGE, credentialOriginAllowed } from '../lib/credential-origin.js';
import { hasStoredSession } from '../services/supabase.js';

const TAB_NAMES = { market: 'Market', positions: 'Positions', journal: 'Journal', utils: 'Tools' };

/** the open tab: 'calc' (Size), 'market', 'positions', 'journal' or 'utils' */
export function openTab() {
  return state.marketView ? 'market' : state.positionsView ? 'positions' : state.journalView ? 'journal' : state.utilsView ? 'utils' : 'calc';
}

/** a tab other than Size is open and nobody is signed in: the gate shows instead of it, and nothing loads behind it */
export function viewLocked() { return openTab() !== 'calc' && !state.session; }

/** the gate card: what to do (sign in), or that a saved sign-in is coming back */
export function renderSignInGate() {
  const el = document.getElementById('signInGate');
  if (!el) return;
  const locked = viewLocked();
  el.style.display = locked ? '' : 'none';
  if (!locked) return;
  const tab = TAB_NAMES[openTab()];
  const allowed = credentialOriginAllowed();
  // a session saved on this device is read back at boot, and retried every minute when it couldn't be (offline)
  const loading = allowed && hasStoredSession() && (state.sessionResuming || !state.sessionTried);
  const offline = allowed && hasStoredSession() && !loading && state.sessionOffline;
  const coming = loading || offline;
  const title = loading ? 'Signing you in…' : offline ? "Can't reach your account" : `Sign in to use ${tab}`;
  const text = !allowed ? CREDENTIAL_ORIGIN_MESSAGE
    : loading ? `${tab} opens once your account loads.`
    : offline ? 'Check your connection. It tries again every minute.'
    : `Size works without an account. ${tab} and the other tabs need you signed in with Google.`;
  document.getElementById('signInGateTitle').textContent = title;
  document.getElementById('signInGateText').textContent = text;
  const btn = document.getElementById('signInGateBtn');
  btn.style.display = coming ? 'none' : '';
  btn.disabled = !allowed;
}
