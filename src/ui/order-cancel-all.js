// Cancel all: every working order in the account (or only the entries, keeping stops and targets), reviewed in a sheet and
// sent once after a re-read shows the same plan; each order is its own cancel, a refused one doesn't stop the rest,
// and afterwards Schwab is re-read to say what still works.
import { state } from '../state.js';
import { marketEscape as esc } from '../core/format.js';
import { cancelAllPlan, workingOrders, workingWords } from '../core/positions.js';
import { schwabAccount, schwabConnected } from '../services/schwab.js';
import { showError, showToast } from './feedback.js';
import { cancelWorking, sendsSame } from './order-cancel.js';
import { failureText } from './position-trade.js';
import { refreshPositions } from './positions.js';
import { openSheet } from './sheets.js';

const isStopType = o => /STOP/.test(o.orderType);
const count = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const open = o => o.qty - o.filled;
const units = (o, n) => `${n.toLocaleString('en-US')} ${o.assetType === 'OPTION' ? (n === 1 ? 'contract' : 'contracts') : (n === 1 ? 'share' : 'shares')}`;

/** what each held position's stops still cover once the run is done */
function stopWarnings(gone) {
  const p = state.positions, out = [];
  if (!p) return out;
  const ids = new Set(gone.filter(isStopType).map(o => String(o.orderId)));
  for (const row of p.rows.filter(r => r.stopOrders.some(s => ids.has(String(s.orderId))))) {
    const held = Math.abs(row.qty);
    const left = Math.min(held, row.stopOrders.filter(s => !ids.has(String(s.orderId))).reduce((n, s) => n + s.qty, 0));
    out.push(left ? `After this, stops cover ${left.toLocaleString('en-US')} of your ${held.toLocaleString('en-US')} ${row.label}.`
      : `After this, your ${held.toLocaleString('en-US')} ${row.label} have no stop.`);
  }
  return out;
}

/** the frozen review: the plan from what Schwab shows now */
export function buildCancelAllTicket(only = 'all') {
  const p = state.positions;
  const t = { hash: (p && p.hash) || '', only, error: '', notice: '', steps: [], gone: [], kept: [], warnings: [], sent: false, checking: false, failures: 0, done: '', confirmed: false };
  if (!p) { t.error = 'Could not read your orders from Schwab. ' + state.positionsError; return t; }
  if (p.stopsMissing) { t.error = 'Schwab did not return the orders on this account. Try again in a moment.'; return t; }
  Object.assign(t, cancelAllPlan(p.orders, p.rows, { only }));
  if (t.error) return t;
  t.warnings = [...stopWarnings(t.gone), ...t.gone.filter(o => o.filled > 0)
    .map(o => `${o.label}: ${o.filled.toLocaleString('en-US')} of ${o.qty.toLocaleString('en-US')} already filled and stay filled.`)];
  return t;
}

export async function openCancelAll() {
  if (state.posTradeBusy) return;
  if (!schwabConnected()) { showError('Connect Schwab in Settings first.'); openSheet('settings'); return; }
  state.posTradeBusy = true;
  try { await refreshPositions(); } finally { state.posTradeBusy = false; } // the plan is built from what Schwab shows now
  state.cancelAllTicket = buildCancelAllTicket();
  if (state.positionsError && !state.cancelAllTicket.error) state.cancelAllTicket.error = 'Could not re-read your orders from Schwab. ' + state.positionsError;
  renderCancelAllSheet();
  openSheet('cancelAll');
}

/** everything, or only the entries (stops and targets on what you hold stay) */
export function setCancelAllOnly(only) {
  const t = state.cancelAllTicket;
  if (!t || t.sent || state.posTradeBusy || (only !== 'all' && only !== 'entries')) return;
  state.cancelAllTicket = buildCancelAllTicket(only);
  renderCancelAllSheet();
}

export async function sendCancelAll() {
  const t = state.cancelAllTicket;
  if (!t || t.error || t.sent || state.posTradeBusy) return;
  state.posTradeBusy = true;
  // Schwab again right before sending: the cancels go only while they are still the ones reviewed
  t.checking = true;
  renderCancelAllSheet();
  let fresh;
  try { await refreshPositions(); fresh = buildCancelAllTicket(t.only); } finally { t.checking = false; }
  if (state.positionsError && !fresh.error) fresh.error = 'Could not re-read your orders from Schwab. ' + state.positionsError;
  const moved = state.positions && fresh.hash !== t.hash ? 'account' : fresh.error || !sendsSame(fresh, t) ? 'orders' : '';
  if (moved) {
    state.posTradeBusy = false;
    if (moved === 'account') fresh.error = 'You switched Schwab accounts since this was reviewed. Nothing was sent.';
    else if (fresh.error) fresh.error = 'Nothing was sent. ' + fresh.error;
    else fresh.notice = 'Schwab changed since you opened this, so nothing was sent. This is what it would send now: review it, then send again.';
    if (state.cancelAllTicket === t) { state.cancelAllTicket = fresh; renderCancelAllSheet(); }
    return;
  }
  t.sent = true; // one review, one run: no cancel is sent twice, and nothing retries
  try {
    for (const step of t.steps) {
      const w = t.gone.find(o => String(o.orderId) === String(step.orderId));
      step.status = 'sending';
      renderCancelAllSheet();
      // each order on its own: one Schwab refuses (or fills first) doesn't keep the rest working
      try { await cancelWorking(w, t.hash, step, 'cancelled', ''); step.status = 'done'; }
      catch(e) { step.status = 'failed'; step.failure = failureText(e); t.failures++; }
    }
    await refreshPositions(); // what Schwab shows now, not what the answers implied
    Object.assign(t, outcome(t));
  } finally {
    state.posTradeBusy = false;
    if (state.cancelAllTicket === t) renderCancelAllSheet();
  }
  if (t.confirmed) showToast(t.done);
}

function outcome(t) {
  const p = state.positions;
  if (state.positionsError || !p || p.stopsMissing || p.hash !== t.hash) return { done: 'Could not re-read Schwab. Check your Schwab orders.', confirmed: false };
  const ids = new Set(t.gone.map(o => String(o.orderId)));
  const still = workingOrders(p.orders).filter(o => ids.has(String(o.orderId)));
  if (!still.length) return { done: `Schwab no longer shows ${t.gone.length === 1 ? 'the order' : `any of the ${t.gone.length} orders`} working.`, confirmed: !t.failures };
  return { done: `Schwab still shows ${count(still.length, 'order', 'orders')} working: ${still.map(o => `${workingWords(o)} ${o.label}`).join(', ')}. Check Schwab.`, confirmed: false };
}

function stepText(t, step) {
  const w = t.gone.find(o => String(o.orderId) === String(step.orderId));
  if (!w) return `Cancel order ${step.orderId}`;
  const partner = w.oco !== null ? t.gone.find(o => o.oco === w.oco && o !== w) : null;
  const children = t.gone.filter(o => o.parentId !== null && o.parentId === w.orderId);
  const withIt = [...(partner ? [`the paired ${workingWords(partner)}`] : []), ...children.map(c => `its ${workingWords(c)} waiting on it`)];
  return `Cancel ${workingWords(w)} for ${units(w, open(w))} ${w.label}${withIt.length ? ', and with it ' + withIt.join(' and ') : ''}${step.note ? ` (${step.note})` : ''}`;
}

function onlyChoice(t) {
  const opt = (only, title, sub) => `<button class="pos-choice-opt${t.only === only ? ' active' : ''}" aria-pressed="${t.only === only}" data-action="setCancelAllOnly" data-arg="${only}"${t.sent || state.posTradeBusy ? ' disabled' : ''}><strong>${esc(title)}</strong><span>${esc(sub)}</span></button>`;
  return `<div><dt>Cancel</dt><dd><div class="pos-choice" role="group" aria-label="Which orders to cancel">
      ${opt('all', 'Everything', 'Every working order, stops and targets on what you hold included.')}
      ${opt('entries', 'Only entries', 'Stops and targets on what you hold stay.')}
    </div></dd></div>`;
}

export function renderCancelAllSheet() {
  const t = state.cancelAllTicket;
  const acct = schwabAccount();
  document.getElementById('cancelAllAccount').textContent = acct ? 'Account ••' + acct.last4 : '';
  const body = document.getElementById('cancelAllBody');
  if (!t) { body.innerHTML = ''; return; }
  const choice = !t.sent && t.only === 'entries' && /closes something you hold/.test(t.error);
  if (t.error) {
    body.innerHTML = `${choice ? `<dl class="trade-legs">${onlyChoice(t)}</dl>` : ''}<p class="trade-warn" role="alert">${esc(t.error)}</p><div class="trade-actions"><button class="btn" data-action="closeSheet">Close</button></div>`;
    return;
  }
  const marks = { sending: '…', done: '✓', failed: '✗' };
  const steps = t.steps.map(s => `<li class="pos-step${s.status ? ' ' + s.status : ''}">${s.status ? marks[s.status] + ' ' : ''}${esc(stepText(t, s))}${s.failure ? `<span class="shares-detail">${esc(s.failure)}</span>` : ''}</li>`).join('');
  const settled = t.sent && !state.posTradeBusy;
  const n = t.gone.length;
  body.innerHTML = `
    ${t.notice ? `<p class="trade-warn" role="alert">${esc(t.notice)}</p>` : ''}
    <dl class="trade-legs">
      ${onlyChoice(t)}
      <div><dt>${t.sent ? 'Sent' : 'Will send'}</dt><dd><ol class="pos-steps">${steps}</ol></dd></div>
      ${t.kept.length ? `<div><dt>Stays</dt><dd><span class="shares-detail">${esc(t.kept.map(o => `${workingWords(o)} ${o.label}`).join(', '))}</span></dd></div>` : ''}
    </dl>
    ${t.warnings.map(w => `<p class="trade-warn">${esc(w)}</p>`).join('')}
    <p class="hint">A cancel can lose to a fill: if an order fills first, it stays filled.</p>
    <details class="hint-details"><summary>Orders sent to Schwab</summary><pre class="trade-json">${esc(JSON.stringify(t.steps.map(s => ({ cancel: s.orderId })), null, 2))}</pre></details>
    <div class="trade-actions">
      <button class="btn" data-action="closeSheet">${t.sent ? 'Done' : 'Back'}</button>
      ${t.sent ? '' : `<button class="btn trade-confirm" data-action="sendCancelAll"${state.posTradeBusy ? ' disabled' : ''}>${esc(`Cancel ${n === 1 ? 'the order' : `all ${n} orders`}`)}</button>`}
    </div>
    <p class="trade-result${settled ? (t.failures ? ' bad' : t.confirmed ? ' ok' : '') : ''}" role="status">${esc(t.checking ? 'Checking Schwab…' : [t.failures ? `Schwab refused ${count(t.failures, 'cancel', 'cancels')}.` : '', t.done].filter(Boolean).join(' '))}</p>`;
}
