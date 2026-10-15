// Order edit: change one working order from the Positions list (its stop, limit, size or how long it lasts), reviewed in a sheet
// and sent once, after a re-read shows the same plan. A plain order is replaced; a half of a target-and-stop pair can't be, so
// the pair is cancelled and placed again with the change, only once Schwab shows both halves cancelled, never filled.
import { state } from '../state.js';
import { marketEscape as esc } from '../core/format.js';
import { editPlan, fmtPositionPrice, schwabTime, workingOrders, workingWords } from '../core/positions.js';
import { schwabAccount, schwabConnected, schwabOrder, schwabPlaceOrder, schwabReplaceOrder } from '../services/schwab.js';
import { showError, showToast } from './feedback.js';
import { cancelWorking, schwabList, sendsSame, shownCancelled, statusOf } from './order-cancel.js';
import { failureText } from './position-trade.js';
import { refreshPositions } from './positions.js';
import { openSheet } from './sheets.js';

const UNCONFIRMED_WAIT = 120000;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const units = (o, n) => `${n.toLocaleString('en-US')} ${o.assetType === 'OPTION' ? (n === 1 ? 'contract' : 'contracts') : (n === 1 ? 'share' : 'shares')}`;
const open = o => o.qty - o.filled;
const isStopType = o => /STOP/.test(o.orderType);
const words = s => String(s || '').toLowerCase().replace(/_/g, ' ');
const lasts = d => d === 'DAY' ? 'today only' : d === 'GOOD_TILL_CANCEL' ? 'until canceled' : words(d);
const px = (o, v) => fmtPositionPrice(v, o.assetType === 'OPTION' ? 'OPTION' : null);
/** the order as it would be after the change */
const changed = t => ({ ...t.order, stop: t.stop, price: t.price, qty: t.qty, filled: 0, duration: t.duration });

/** the frozen review: the plan from what Schwab shows now, with the change asked for (edit: { stop, price, qty, duration }, any left out stay as they are) */
export function buildEditTicket(orderId, edit = {}, now = Date.now()) {
  const p = state.positions;
  // hash: the account the orders were read from, and the only one its steps go to
  const t = { orderId, hash: (p && p.hash) || '', edit: { ...edit }, error: '', editError: '', notice: '', order: null, partner: null, stop: null, price: null, qty: 0, duration: '',
    fills: false, steps: [], warnings: [], sent: false, checking: false, failure: '', done: '', confirmed: false, before: [] };
  if (!p) { t.error = 'Could not read your orders from Schwab. ' + state.positionsError; return t; }
  if (p.stopsMissing) { t.error = 'Schwab did not return the orders on this account. Try again in a moment.'; return t; }
  Object.assign(t, editPlan(p.orders, orderId, edit, p.rows));
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

function buildWarnings(t) {
  const o = t.order, out = [];
  if (t.editError) return out;
  const row = t.fills && state.positions.rows.find(r => r.symbol === o.symbol);
  if (row) out.push(`The limit ${px(o, t.price)} is at or ${row.qty > 0 ? 'below' : 'above'} the price ${px(o, row.price)}, so it likely fills right away.`);
  if (o.filled > 0) out.push(`${o.filled.toLocaleString('en-US')} of ${o.qty.toLocaleString('en-US')} already filled and stay filled; the changed order is for ${units(o, t.qty)}.`);
  if (t.partner && [o, t.partner].some(isStopType)) out.push(`Until the pair is placed again, ${units(o, t.qty)} ${t.qty === 1 ? 'has' : 'have'} no stop for a moment.`);
  return out;
}

export async function openOrderEdit(orderId) {
  if (state.posTradeBusy) return;
  if (!schwabConnected()) { showError('Connect Schwab in Settings first.'); openSheet('settings'); return; }
  state.posTradeBusy = true;
  try { await refreshPositions(); } finally { state.posTradeBusy = false; } // the plan is built from what Schwab shows now
  state.editTicket = buildEditTicket(orderId);
  if (state.positionsError && !state.editTicket.error) state.editTicket.error = 'Could not re-read your orders from Schwab. ' + state.positionsError;
  renderEditSheet();
  openSheet('edit');
}

const editOpen = () => { const t = state.editTicket; return t && !t.error && !t.sent ? t : null; };

/** a change in the form: re-planned from the same read; typing redraws only what follows the inputs, so the cursor stays */
function editChanged(field, value, form) {
  const t = editOpen();
  if (!t) return;
  const fresh = buildEditTicket(t.orderId, { ...t.edit, [field]: value });
  fresh.notice = t.notice;
  state.editTicket = fresh;
  renderEditSheet(form);
}

const typed = v => String(v).trim() === '' ? 0 : Number(v);
export const setEditStop = value => editChanged('stop', typed(value), false);
export const setEditPrice = value => editChanged('price', typed(value), false);
export const setEditQty = value => editChanged('qty', typed(value), false);
export function setEditDuration(d) {
  if (d === 'DAY' || d === 'GOOD_TILL_CANCEL') editChanged('duration', d, true);
}

/** a replace Schwab refused: a fill stops it */
async function replaceStep(t, step) {
  try { step.newId = (await schwabReplaceOrder(step.orderId, step.order, t.hash)).orderId; }
  catch(e) {
    if (e instanceof TypeError || !e.status) throw e;
    const o = await schwabOrder(step.orderId, t.hash).catch(() => null);
    if (o && o.status === 'FILLED') throw new Error(`Schwab filled the ${workingWords(t.order)} before it could be changed. Nothing more was sent.`);
    throw e;
  }
}

/** the same order and the same steps to the same account: a change at Schwab to the order being edited counts too */
const sameEdit = (a, b) => sendsSame(a, b) && JSON.stringify([a.order, a.partner]) === JSON.stringify([b.order, b.partner]);

export async function sendOrderEdit() {
  const t = state.editTicket;
  if (!t || t.error || t.editError || t.sent || state.posTradeBusy) return;
  state.posTradeBusy = true;
  // Schwab again right before sending: the steps go only while they are still the ones reviewed
  t.checking = true;
  renderEditSheet();
  let fresh;
  try { await refreshPositions(); fresh = buildEditTicket(t.orderId, t.edit); } finally { t.checking = false; }
  if (state.positionsError && !fresh.error) fresh.error = 'Could not re-read your orders from Schwab. ' + state.positionsError;
  const moved = state.positions && fresh.hash !== t.hash ? 'account' : fresh.error || fresh.editError || !sameEdit(fresh, t) ? 'orders' : '';
  if (moved) {
    state.posTradeBusy = false;
    if (moved === 'account') fresh.error = 'You switched Schwab accounts since this was reviewed. Nothing was sent.';
    else if (fresh.error) fresh.error = 'Nothing was sent. ' + fresh.error;
    else fresh.notice = 'Schwab changed since you opened this, so nothing was sent. This is what it would send now: review it, then send again.';
    if (state.editTicket === t) { state.editTicket = fresh; renderEditSheet(); }
    return;
  }
  t.sent = true; // one review, one run: no step is sent twice, and nothing retries
  try {
    for (const step of t.steps) {
      step.status = 'sending';
      renderEditSheet();
      try {
        if (step.kind === 'replace') await replaceStep(t, step);
        else if (step.kind === 'cancel') await cancelWorking(t.order, t.hash, step, 'changed');
        else {
          // the pair goes back in only over two cancelled halves, nothing more filled
          for (const half of [t.order, t.partner]) await shownCancelled(half, t.hash, 'the changed pair was not placed');
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
    if (state.editTicket === t) renderEditSheet();
  }
  if (t.confirmed) showToast(t.done);
}

/** a new working order like w: same symbol, instruction, type, prices, size and duration */
const like = (t, w) => now => now.find(n => !t.before.includes(String(n.orderId)) && n.symbol === w.symbol && n.instruction === w.instruction && n.orderType === w.orderType
  && n.stop === w.stop && n.price === w.price && open(n) === t.qty && n.duration === w.duration);

function outcome(t) {
  const p = state.positions;
  if (state.positionsError || !p || p.stopsMissing || p.hash !== t.hash) return { done: 'Could not re-read Schwab. Check your Schwab orders.', confirmed: false };
  const now = workingOrders(p.orders);
  const o = t.order;
  if (now.some(w => String(w.orderId) === String(o.orderId))) return { done: `Schwab still shows the ${workingWords(o)} working. Check Schwab.`, confirmed: false };
  if (statusOf(p.orders, o.orderId) === 'FILLED') return { done: `Schwab shows the ${workingWords(o)} filled.`, confirmed: false };
  const next = changed(t), mine = like(t, next)(now);
  const other = t.partner ? like(t, { ...t.partner, duration: t.duration })(now) : null;
  if (mine && (!t.partner || (other && mine.oco !== null && mine.oco === other.oco))) {
    const pair = t.partner ? `, paired with the ${workingWords(t.partner)}` : '';
    return { done: `Schwab now shows the ${workingWords(next)} for ${units(o, t.qty)}${pair}.`, confirmed: true };
  }
  if (t.failure) return { done: '', confirmed: false };
  const bare = t.partner && [o, t.partner].some(isStopType) ? ` ${cap(units(o, t.qty))} may have no stop.` : '';
  return { done: `Schwab doesn't show the changed order yet. Check Schwab.${bare}`, confirmed: false };
}

/** an order as sent, in the words a working order gets */
const asWorking = c => ({ legs: 1, instruction: c.orderLegCollection[0].instruction, orderType: c.orderType, trail: '', stop: c.stopPrice ?? null, price: c.price ?? null,
  assetType: c.orderLegCollection[0].instrument.assetType });

function stepText(t, step) {
  const o = t.order, next = changed(t);
  if (step.kind === 'replace') return `Replace ${workingWords(o)} for ${units(o, open(o))} ${o.label} with ${workingWords(next)} for ${units(o, t.qty)}, ${lasts(t.duration)}`;
  if (step.kind === 'cancel') return `Cancel ${workingWords(o)} for ${units(o, open(o))} ${o.label}, and with it the paired ${workingWords(t.partner)}${step.note ? ` (${step.note})` : ''}`;
  const [a, b] = step.order.childOrderStrategies.map(asWorking);
  return `Place ${workingWords(a)} paired with ${workingWords(b)} for ${units(o, t.qty)} (one cancels the other)`;
}

const priceText = v => v === null || !(v > 0) ? '' : v.toFixed(v >= 1 ? 2 : 4);

/** the form: the prices the order type has, its size, and how long it lasts */
function editForm(t) {
  const o = t.order, off = t.sent ? ' disabled' : '';
  const step = o.assetType === 'OPTION' ? '0.05' : '0.01';
  const shown = (field, v) => priceText(t.edit[field] ?? v);
  const duration = (d, label) => `<button class="${t.duration === d ? 'active' : ''}" aria-pressed="${t.duration === d}" data-action="setEditDuration" data-arg="${d}"${off}>${label}</button>`;
  const qty = t.edit.qty ?? open(o);
  return `${isStopType(o) ? `<div><dt><label for="editStop">Stop price</label></dt><dd><div class="prefix-wrap pos-close-price"><span class="prefix">$</span><input type="number" id="editStop" step="${step}" min="0" inputmode="decimal" autocomplete="off" value="${shown('stop', o.stop)}" data-input="setEditStop"${off} /></div></dd></div>` : ''}
    ${o.orderType !== 'STOP' ? `<div><dt><label for="editPrice">Limit price</label></dt><dd><div class="prefix-wrap pos-close-price"><span class="prefix">$</span><input type="number" id="editPrice" step="${step}" min="0" inputmode="decimal" autocomplete="off" value="${shown('price', o.price)}" data-input="setEditPrice"${off} /></div></dd></div>` : ''}
    <div><dt><label for="editQty">${o.assetType === 'OPTION' ? 'Contracts' : 'Shares'}</label></dt><dd><div class="pos-close-qty"><input type="number" id="editQty" step="1" min="1" inputmode="numeric" autocomplete="off" value="${qty > 0 ? qty : ''}" data-input="setEditQty"${off} /></div></dd></div>
    <div><dt>Lasts</dt><dd><div class="seg" role="group" aria-label="Order lasts">${duration('DAY', 'Today')}${duration('GOOD_TILL_CANCEL', 'Until canceled')}</div></dd></div>`;
}

export function renderEditSheet(form = true) {
  const t = state.editTicket;
  const acct = schwabAccount();
  document.getElementById('editAccount').textContent = acct ? 'Account ••' + acct.last4 : '';
  const body = document.getElementById('editBody');
  if (!t) { body.innerHTML = ''; return; }
  if (t.error) {
    body.innerHTML = `<p class="trade-warn" role="alert">${esc(t.error)}</p><div class="trade-actions"><button class="btn" data-action="closeSheet">Close</button></div>`;
    return;
  }
  const o = t.order, q = t.partner;
  const marks = { sending: '…', done: '✓', failed: '✗' };
  const steps = t.steps.map(s => `<li class="pos-step${s.status ? ' ' + s.status : ''}">${s.status ? marks[s.status] + ' ' : ''}${esc(stepText(t, s))}</li>`).join('');
  const orders = t.steps.map(s => s.kind === 'cancel' ? { cancel: s.orderId } : s.kind === 'replace' ? { replace: s.orderId, with: s.order } : { place: s.order });
  const settled = t.sent && !state.posTradeBusy;
  const hint = q ? `Schwab won't change one half of a pair on its own, so the pair is cancelled and placed again with your change, once Schwab shows both halves cancelled. The ${workingWords(q)} stays as it is.`
    : 'Schwab swaps the order for the changed one: it cancels this one and places the new one together.';
  const detail = `
    ${t.notice ? `<p class="trade-warn" role="alert">${esc(t.notice)}</p>` : ''}
    <dl class="trade-legs">
      <div><dt>${t.sent ? 'Sent' : 'Will send'}</dt><dd>${t.editError ? `<span class="shares-detail">${esc(t.editError)}</span>` : `<ol class="pos-steps">${steps}</ol>`}</dd></div>
    </dl>
    ${t.warnings.map(w => `<p class="trade-warn">${esc(w)}</p>`).join('')}
    <p class="hint">${esc(hint)} A change can lose to a fill: if the order fills first, it stays filled.</p>
    <details class="hint-details"><summary>Orders sent to Schwab</summary><pre class="trade-json">${esc(JSON.stringify(orders, null, 2))}</pre></details>
    <div class="trade-actions">
      <button class="btn" data-action="closeSheet">${t.sent ? 'Done' : 'Back'}</button>
      ${t.sent ? '' : `<button class="btn trade-confirm" data-action="sendOrderEdit"${state.posTradeBusy || t.editError ? ' disabled' : ''}>${esc(t.editError ? 'Send change' : `Change to ${workingWords(changed(t))} for ${t.qty.toLocaleString('en-US')}`)}</button>`}
    </div>
    <p class="trade-result${settled ? (t.failure ? ' bad' : t.confirmed ? ' ok' : '') : ''}" role="status">${esc(t.checking ? 'Checking Schwab…' : [t.failure, t.done].filter(Boolean).join(' '))}</p>
    ${settled && (t.failure || !t.confirmed) ? schwabList(t) : ''}`;
  if (!form) { document.getElementById('editDetail').innerHTML = detail; return; }
  const entered = schwabTime(o.entered);
  const meta = [cap(lasts(o.duration)), words(o.status),
    Number.isNaN(entered) ? '' : 'placed ' + new Date(entered).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })].filter(Boolean).join(' · ');
  body.innerHTML = `
    <dl class="trade-legs">
      <div><dt>Order</dt><dd><strong>${esc(cap(workingWords(o)))} · ${esc(units(o, open(o)))} ${esc(o.label)}</strong><span class="shares-detail">${esc(meta)}</span></dd></div>
      ${q ? `<div><dt>Its pair</dt><dd><span class="shares-detail">It's paired with the ${esc(workingWords(q))} for ${esc(units(q, open(q)))}. Schwab cancels the two together, so a change places both again: the size and how long it lasts go for both.</span></dd></div>` : ''}
      ${editForm(t)}
    </dl>
    <div id="editDetail">${detail}</div>`;
}
