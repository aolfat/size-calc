// Order cancel: one working order from the Positions list, reviewed in a sheet and sent once, after a re-read shows the same plan.
// Schwab cancels a target-and-stop pair together, so the other half goes back in on its own unless you pick cancelling both,
// and only once Schwab shows it cancelled, never filled; afterwards Schwab is re-read to say what it shows.
import { state } from '../state.js';
import { marketEscape as esc } from '../core/format.js';
import { cancelPlan, orderGone, ordersFor, schwabTime, workingOrders, workingWords } from '../core/positions.js';
import { schwabAccount, schwabCancelOrder, schwabConnected, schwabOrder, schwabPlaceOrder } from '../services/schwab.js';
import { effects } from './effects.js';
import { showError, showToast } from './feedback.js';
import { failureText } from './position-trade.js';
import { refreshPositions } from './positions.js';
import { openSheet } from './sheets.js';

const UNCONFIRMED_WAIT = 120000;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const units = (o, n) => `${n.toLocaleString('en-US')} ${o.assetType === 'OPTION' ? (n === 1 ? 'contract' : 'contracts') : (n === 1 ? 'share' : 'shares')}`;
const open = o => o.qty - o.filled;
const isStopType = o => /STOP/.test(o.orderType);
const words = s => String(s || '').toLowerCase().replace(/_/g, ' ');

/** the orders the plan cancels and doesn't put back: the order, a pair's other half when not kept, an entry's waiting children */
function lost(t) {
  return [t.order, ...(t.partner && !t.keep ? [t.partner] : []), ...t.children];
}

/** stops a held position loses: what its stops still cover afterwards */
function stopWarnings(t) {
  const p = state.positions, out = [];
  if (!p) return out;
  const gone = new Set(lost(t).filter(isStopType).map(o => String(o.orderId)));
  for (const row of p.rows.filter(r => r.stopOrders.some(s => gone.has(String(s.orderId))))) {
    const held = Math.abs(row.qty);
    const left = Math.min(held, row.stopOrders.filter(s => !gone.has(String(s.orderId))).reduce((n, s) => n + s.qty, 0));
    out.push(left ? `After this, stops cover ${left.toLocaleString('en-US')} of your ${held.toLocaleString('en-US')} ${row.label}.`
      : `After this, your ${held.toLocaleString('en-US')} ${row.label} have no stop.`);
  }
  return out;
}

function buildWarnings(t) {
  const o = t.order, out = [...stopWarnings(t)];
  if (o.filled > 0) out.push(`${o.filled.toLocaleString('en-US')} of ${o.qty.toLocaleString('en-US')} already filled and stay filled; the cancel stops the other ${open(o).toLocaleString('en-US')}.`);
  for (const c of t.children) out.push(`Its ${workingWords(c)}, waiting on it, is cancelled too.`);
  if (t.keep && isStopType(t.partner)) out.push(`Until the stop is placed again, ${units(t.partner, open(t.partner))} have no stop for a moment.`);
  return out;
}

/** the frozen review: the plan from what Schwab shows now */
export function buildCancelTicket(orderId, keep = true, now = Date.now()) {
  const p = state.positions;
  // hash: the account the orders were read from, and the only one its steps go to
  const t = { orderId, hash: (p && p.hash) || '', error: '', notice: '', order: null, partner: null, children: [], keep: false, keepError: '', steps: [], warnings: [], sent: false, checking: false,
    failure: '', done: '', confirmed: false, before: [] };
  if (!p) { t.error = 'Could not read your orders from Schwab. ' + state.positionsError; return t; }
  if (p.stopsMissing) { t.error = 'Schwab did not return the orders on this account. Try again in a moment.'; return t; }
  Object.assign(t, cancelPlan(p.orders, orderId, { keep }));
  if (t.error) return t;
  const last = state.posLast;
  if (last && last.hash === t.hash && last.symbol === t.order.symbol && !last.confirmed && now - last.at < UNCONFIRMED_WAIT) {
    t.error = `Your last order on ${t.order.label} has not shown up at Schwab yet. Check Schwab's order list before sending another.`;
    return t;
  }
  t.before = workingOrders(p.orders).map(o => String(o.orderId));
  t.warnings = buildWarnings(t);
  return t;
}

export async function openOrderCancel(orderId) {
  if (state.posTradeBusy) return;
  if (!schwabConnected()) { showError('Connect Schwab in Settings first.'); openSheet('settings'); return; }
  state.posTradeBusy = true;
  try { await refreshPositions(); } finally { state.posTradeBusy = false; } // the plan is built from what Schwab shows now
  state.cancelTicket = buildCancelTicket(orderId);
  if (state.positionsError && !state.cancelTicket.error) state.cancelTicket.error = 'Could not re-read your orders from Schwab. ' + state.positionsError;
  renderCancelSheet();
  openSheet('cancel');
}

/** keep the other half of a pair (placed again on its own), or cancel both */
export function setCancelKeep(keep) {
  const t = state.cancelTicket;
  if (!t || t.error || t.sent || !t.partner || (keep && t.keepError)) return;
  state.cancelTicket = buildCancelTicket(t.orderId, keep);
  renderCancelSheet();
}

/** a cancel Schwab refused: fine when the order is already on its way out, a stop when it filled */
async function cancelStep(t) {
  try { await schwabCancelOrder(t.order.orderId, t.hash); }
  catch(e) {
    if (e instanceof TypeError || !e.status) throw e;
    const o = await schwabOrder(t.order.orderId, t.hash).catch(() => null);
    if (o && o.status === 'FILLED') throw new Error(`Schwab filled the ${workingWords(t.order)} before it could be cancelled. Nothing more was sent.`);
    if (!o || !orderGone(o.status || '')) throw e;
    t.steps[0].note = 'already cancelled';
  }
}

/** reads of the other half while Schwab is still cancelling it (PENDING_CANCEL, WORKING...), a second apart */
const PARTNER_READS = 6, PARTNER_GAP = 1000;

/**
 * The other half goes back in only when Schwab shows it cancelled with nothing more filled. A fill (the target sold, so its
 * stop went with it), a partial fill or a half still working stops here: placing it again would sell what is already sold.
 * Schwab cancels the other half on its own schedule, so a half on its way out is read again for a few seconds first.
 */
async function partnerCancelled(t) {
  const q = t.partner;
  let o = null;
  for (let i = 0; i < PARTNER_READS && q.orderId !== null; i++) {
    if (i) await effects.wait(PARTNER_GAP);
    o = await schwabOrder(q.orderId, t.hash).catch(() => null);
    if (o && (o.status === 'CANCELED' || o.status === 'FILLED' || (Number(o.filledQuantity) || 0) > q.filled)) break;
  }
  if (!o) throw new Error(`Could not check the ${workingWords(q)} at Schwab, so it was not placed again. Check Schwab.`);
  const filled = Number(o.filledQuantity) || 0;
  if (o.status === 'FILLED') throw new Error(`Schwab shows the ${workingWords(q)} filled, so it was not placed again.`);
  if (filled > q.filled) throw new Error(`Schwab shows ${filled.toLocaleString('en-US')} of the ${workingWords(q)} filled, so it was not placed again. Check Schwab.`);
  if (o.status !== 'CANCELED') throw new Error(`Schwab shows the ${workingWords(q)} ${words(o.status) || 'in an unknown state'}, so it was not placed again. Check Schwab.`);
}

const sendsSame = (a, b) => JSON.stringify([a.hash, a.steps.map(s => [s.kind, s.orderId ?? null, s.order || null])])
  === JSON.stringify([b.hash, b.steps.map(s => [s.kind, s.orderId ?? null, s.order || null])]);

export async function sendOrderCancel() {
  const t = state.cancelTicket;
  if (!t || t.error || t.sent || state.posTradeBusy) return;
  state.posTradeBusy = true;
  // Schwab again right before sending: the steps go only while they are still the ones reviewed
  t.checking = true;
  renderCancelSheet();
  let fresh;
  try { await refreshPositions(); fresh = buildCancelTicket(t.orderId, t.keep); } finally { t.checking = false; }
  if (state.positionsError && !fresh.error) fresh.error = 'Could not re-read your orders from Schwab. ' + state.positionsError;
  const moved = state.positions && fresh.hash !== t.hash ? 'account' : fresh.error || !sendsSame(fresh, t) ? 'orders' : '';
  if (moved) {
    state.posTradeBusy = false;
    if (moved === 'account') fresh.error = 'You switched Schwab accounts since this was reviewed. Nothing was sent.';
    else if (fresh.error) fresh.error = 'Nothing was sent. ' + fresh.error;
    else fresh.notice = 'Schwab changed since you opened this, so nothing was sent. This is what it would send now: review it, then send again.';
    if (state.cancelTicket === t) { state.cancelTicket = fresh; renderCancelSheet(); }
    return;
  }
  t.sent = true; // one review, one run: no step is sent twice, and nothing retries
  try {
    for (const step of t.steps) {
      step.status = 'sending';
      renderCancelSheet();
      try {
        if (step.kind === 'cancel') await cancelStep(t);
        else {
          await partnerCancelled(t);
          step.newId = (await schwabPlaceOrder(step.order, t.hash)).orderId;
        }
        step.status = 'done';
      } catch(e) {
        step.status = 'failed';
        step.notSent = !!e.notSent;
        t.failure = failureText(e);
        break;
      }
    }
    // a step that got as far as Schwab may have gone through; a run stopped before any did leaves nothing to look for
    if (t.steps.some(s => s.status === 'done' || (s.status === 'failed' && !s.notSent))) {
      state.tradeLast = { symbol: t.order.symbol, at: Date.now() };
      await refreshPositions(); // what Schwab shows now, not what the answers implied
      Object.assign(t, outcome(t));
      state.posLast = { hash: t.hash, symbol: t.order.symbol, at: Date.now(), confirmed: t.confirmed };
    }
  } finally {
    state.posTradeBusy = false;
    if (state.cancelTicket === t) renderCancelSheet();
  }
  if (t.confirmed) showToast(t.done);
}

/** an order's status in the read, children of triggers and pairs included */
function statusOf(orders, id) {
  for (const o of orders || []) {
    if (String(o.orderId) === String(id)) return o.status || '';
    const inner = statusOf(o.childOrderStrategies, id);
    if (inner !== null) return inner;
  }
  return null;
}

function outcome(t) {
  const p = state.positions;
  if (state.positionsError || !p || p.stopsMissing || p.hash !== t.hash) return { done: 'Could not re-read Schwab. Check your Schwab orders.', confirmed: false };
  const now = workingOrders(p.orders);
  const o = t.order, still = now.some(w => String(w.orderId) === String(o.orderId));
  const status = statusOf(p.orders, o.orderId);
  if (still) return { done: `Schwab still shows the ${workingWords(o)} working. Check Schwab.`, confirmed: false };
  if (status === 'FILLED') return { done: `Schwab shows the ${workingWords(o)} filled.`, confirmed: false };
  let done = `Schwab no longer shows the ${workingWords(o)}.`;
  if (!t.partner || !t.keep) return { done, confirmed: !t.failure };
  // the other half, placed again: a new working order like it
  const q = t.partner, back = now.some(w => !t.before.includes(String(w.orderId)) && w.oco === null && w.symbol === q.symbol
    && w.instruction === q.instruction && w.orderType === q.orderType && w.stop === q.stop && w.price === q.price && w.qty >= open(q));
  if (back) return { done: `${done} The ${workingWords(q)} for ${units(q, open(q))} is working on its own.`, confirmed: true };
  if (statusOf(p.orders, q.orderId) === 'FILLED') return { done, confirmed: false }; // the failure says it filled
  const bare = isStopType(q) ? ` ${cap(units(q, open(q)))} have no stop.` : '';
  return { done: `${done} The ${workingWords(q)} went with it and Schwab doesn't show it placed again.${bare}`, confirmed: false };
}

function stepText(t, step) {
  const o = t.order;
  if (step.kind === 'cancel') {
    const withIt = t.partner ? `, and with it the paired ${workingWords(t.partner)}` : '';
    return `Cancel ${workingWords(o)} for ${units(o, open(o))} ${o.label}${withIt}${step.note ? ` (${step.note})` : ''}`;
  }
  return `Place the ${workingWords(t.partner)} for ${units(t.partner, open(t.partner))} again on its own`;
}

/** a pair: keep its other half, or cancel both */
function pairChoice(t) {
  const q = t.partner, n = units(q, open(q));
  const keepSub = t.keepError || `Placed again on its own: ${workingWords(q)} for ${n}, ${q.duration === 'DAY' ? 'today only' : 'until canceled'}.`;
  const bothSub = isStopType(q) ? `The stop goes too: those ${n} lose it.` : `The ${workingWords(q)} goes too.`;
  const opt = (keep, title, sub, off) => `<button class="pos-choice-opt${t.keep === keep ? ' active' : ''}" aria-pressed="${t.keep === keep}" data-action="setCancelKeep" data-arg="${keep ? 'keep' : 'both'}"${off || t.sent ? ' disabled' : ''}><strong>${esc(title)}</strong><span>${esc(sub)}</span></button>`;
  return `<div><dt>Its pair</dt><dd><span class="shares-detail">It's paired with the ${esc(workingWords(q))} for ${esc(n)}. Schwab cancels the two together.</span>
    <div class="pos-choice" role="group" aria-label="The other half of the pair">
      ${opt(true, `Keep the ${q.orderType === 'LIMIT' ? 'limit' : isStopType(q) ? 'stop' : 'other order'}`, keepSub, !!t.keepError)}
      ${opt(false, 'Cancel both', bothSub, false)}
    </div></dd></div>`;
}

/** every order Schwab lists on the symbol, any status: the ground truth when a result isn't confirmed */
function schwabList(t) {
  const p = state.positions;
  const list = p && p.orders && t.order ? ordersFor(p.orders, t.order.symbol) : [];
  if (!list.length) return '';
  const item = w => `<li>${esc(words(w.instruction))} ${esc(words(w.orderType))}${w.stop ?? w.price ? ' $' + Number(w.stop ?? w.price).toFixed(2) : ''} · ${w.qty.toLocaleString('en-US')} · ${esc(words(w.status))}</li>`;
  return `<div class="pos-orders"><div class="pos-orders-title">Schwab lists for ${esc(t.order.label)}</div><ul>${list.map(item).join('')}</ul></div>`;
}

export function renderCancelSheet() {
  const t = state.cancelTicket;
  const acct = schwabAccount();
  document.getElementById('cancelAccount').textContent = acct ? 'Account ••' + acct.last4 : '';
  const body = document.getElementById('cancelBody');
  if (!t) { body.innerHTML = ''; return; }
  if (t.error) {
    body.innerHTML = `<p class="trade-warn" role="alert">${esc(t.error)}</p><div class="trade-actions"><button class="btn" data-action="closeSheet">Close</button></div>`;
    return;
  }
  const o = t.order;
  const marks = { sending: '…', done: '✓', failed: '✗' };
  const steps = t.steps.map(s => `<li class="pos-step${s.status ? ' ' + s.status : ''}">${s.status ? marks[s.status] + ' ' : ''}${esc(stepText(t, s))}</li>`).join('');
  const entered = schwabTime(o.entered);
  const meta = [o.duration === 'DAY' ? 'Today only' : o.duration === 'GOOD_TILL_CANCEL' ? 'Until canceled' : words(o.duration), words(o.status),
    Number.isNaN(entered) ? '' : 'placed ' + new Date(entered).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })].filter(Boolean).join(' · ');
  const orders = t.steps.map(s => s.kind === 'cancel' ? { cancel: s.orderId } : { place: s.order });
  const settled = t.sent && !state.posTradeBusy;
  body.innerHTML = `
    ${t.notice ? `<p class="trade-warn" role="alert">${esc(t.notice)}</p>` : ''}
    <dl class="trade-legs">
      <div><dt>Order</dt><dd><strong>${esc(cap(workingWords(o)))} · ${esc(units(o, open(o)))} ${esc(o.label)}</strong><span class="shares-detail">${esc(cap(meta))}</span></dd></div>
      ${t.partner ? pairChoice(t) : ''}
      <div><dt>${t.sent ? 'Sent' : 'Will send'}</dt><dd><ol class="pos-steps">${steps}</ol></dd></div>
    </dl>
    ${t.warnings.map(w => `<p class="trade-warn">${esc(w)}</p>`).join('')}
    <p class="hint">A cancel can lose to a fill: if the order fills first, it stays filled.</p>
    <details class="hint-details"><summary>Orders sent to Schwab</summary><pre class="trade-json">${esc(JSON.stringify(orders, null, 2))}</pre></details>
    <div class="trade-actions">
      <button class="btn" data-action="closeSheet">${t.sent ? 'Done' : 'Back'}</button>
      ${t.sent ? '' : `<button class="btn trade-confirm" data-action="sendOrderCancel"${state.posTradeBusy ? ' disabled' : ''}>${esc('Cancel ' + workingWords(o))}</button>`}
    </div>
    <p class="trade-result${settled ? (t.failure ? ' bad' : t.confirmed ? ' ok' : '') : ''}" role="status">${esc(t.checking ? 'Checking Schwab…' : [t.failure, t.done].filter(Boolean).join(' '))}</p>
    ${settled && (t.failure || !t.confirmed) ? schwabList(t) : ''}`;
}
