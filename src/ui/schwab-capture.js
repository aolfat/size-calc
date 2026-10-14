// Settings → Schwab trading: the line saying when your Schwab history was last saved to your account, Save now, and
// the quiet automatic save (at most every 6 hours, once both the Google and Schwab logins are in place).
import { captureDue, captureReady, captureSchwab, lastCapture } from '../services/capture.js';
import { state } from '../state.js';
import { showError, showToast } from './feedback.js';

const clock = ms => new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function renderCaptureStatus() {
  const el = document.getElementById('schwabCaptureStatus');
  if (!el) return;
  if (!state.session) { el.innerHTML = 'Sign in with Google to keep your Schwab history.'; return; }
  if (state.captureBusy) { el.innerHTML = 'Saving your Schwab history…'; return; }
  const last = lastCapture();
  const now = '<button class="link-btn" data-action="captureNow">Save now</button>';
  el.innerHTML = last
    ? `History saved ${clock(last.at)} · ${last.orders} orders, ${last.transactions} trades · ${now}`
    : `History not saved yet · ${now}`;
  if (state.captureError) el.innerHTML += ` · <span style="color:var(--amber)">last try failed</span>`;
}

async function run(quiet) {
  if (state.captureBusy || !captureReady()) return null;
  state.captureBusy = true;
  renderCaptureStatus();
  try {
    const r = await captureSchwab();
    state.captureError = '';
    if (!quiet) showToast(`Saved ${r.orders} orders and ${r.transactions} trades to your account.`);
    return r;
  } catch(e) {
    state.captureError = String(e?.message || e);
    if (!quiet) showError("Couldn't save your Schwab history. " + state.captureError);
    return null;
  } finally {
    state.captureBusy = false;
    renderCaptureStatus();
  }
}

/** Save now: any time both logins are in place */
export function captureNow() {
  if (!state.session) { showError('Sign in with Google first, so there is an account to save into.'); return null; }
  if (!captureReady()) { showError('Log in to Schwab first.'); return null; }
  return run(false);
}

/** the automatic save: only when due, and quietly (a failure shows on the status line, not as a toast) */
export function maybeCapture() {
  renderCaptureStatus();
  return captureReady() && captureDue() ? run(true) : null;
}
