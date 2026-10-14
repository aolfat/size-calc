// Raw capture's triggers: the quiet automatic save (at most every 6 hours, once both the Google and Schwab logins are
// in place), Save now from the Journal, and a hook the Journal listens on to redraw when a save starts or finishes.
import { captureDue, captureReady, captureSchwab } from '../services/capture.js';
import { state } from '../state.js';
import { showError, showToast } from './feedback.js';

/** @type {((saved: boolean) => void)[]} */
const listeners = [];
/** the Journal registers here: called with false when a save starts or fails, true when one lands */
export function onCaptureChange(fn) { listeners.push(fn); }
const tell = saved => listeners.forEach(fn => fn(saved));

async function run(quiet) {
  if (state.captureBusy || !captureReady()) return null;
  state.captureBusy = true;
  tell(false);
  let saved = false;
  try {
    const r = await captureSchwab();
    state.captureError = '';
    saved = true;
    if (!quiet) showToast(`Saved ${r.orders} orders and ${r.transactions} trades to your account.`);
    return r;
  } catch(e) {
    state.captureError = String(e?.message || e);
    if (!quiet) showError("Couldn't import from Schwab. " + state.captureError);
    return null;
  } finally {
    state.captureBusy = false;
    tell(saved);
  }
}

/** Import (Save now): any time both logins are in place */
export function captureNow() {
  if (!state.session) { showError('Sign in with Google first, so there is an account to save into.'); return null; }
  if (!captureReady()) { showError('Log in to Schwab first.'); return null; }
  return run(false);
}

/** the automatic save: only when due, and quietly (a failure shows on the Journal's status line, not as a toast) */
export function maybeCapture() {
  return captureReady() && captureDue() ? run(true) : null;
}
