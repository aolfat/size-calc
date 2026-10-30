// Spread close: a held spread closed or trimmed as one multi-leg order (every leg in its ratio, at market or a net limit),
// reviewed in a sheet and sent once. Like the position trades: Schwab is re-read right before sending and the order goes only
// if the plan is still the one reviewed, to the account it was read from; nothing retries; Schwab is re-read afterwards to say
// what it shows, and until it shows the result, that spread in that account takes no new order from here.
import { state } from '../state.js';
import { fmt$, marketEscape as esc } from '../core/format.js';
import { inRegularHours, optionPriceTick } from '../core/orders.js';
import { orderGone, spreadClosePlan, spreadClosers } from '../core/positions.js';
import { store } from '../lib/store.js';
import { schwabAccount, schwabCancelOrder, schwabConnected, schwabOrder, schwabPlaceOrder, schwabStopDuration } from '../services/schwab.js';
import { showError, showToast } from './feedback.js';
import { failureText } from './position-trade.js';
import { refreshPositions } from './positions.js';
import { tradierSymbol, watchSheetQuote } from './sheet-quote.js';
import { openSheet } from './sheets.js';

const UNCONFIRMED_WAIT = 120000;
const PORTIONS = [0.25, 0.5, 0.75, 1];
const spreads = n => `${n.toLocaleString('en-US')} ${n === 1 ? 'spread' : 'spreads'}`;
const contracts = n => `${n.toLocaleString('en-US')} ${n === 1 ? 'contract' : 'contracts'}`;
const px = p => '$' + Number(p).toFixed(2);
const words = s => String(s || '').toLowerCase().replace(/_/g, ' ');

const findSpread = key => (state.positions && (state.positions.spreads || []).find(s => s.key === key)) || null;

/** the frozen ticket for one spread; prev carries the form of an open one */
export function buildSpreadTicket(spread, key, now = Date.now(), prev = null) {
  const t = { key, hash: (state.positions && state.positions.hash) || '', spread, error: '', notice: '', listing: false, steps: [], price: 0, qty: 0, closers: [],
    stopDuration: schwabStopDuration(), warnings: [], warnFlags: [], planError: '', sent: false, checking: false, failure: '', done: '', confirmed: false, close: null };
  if (!spread) { t.error = 'Schwab no longer shows this spread.'; return t; }
  if (state.positions && state.positions.stopsMissing) {
    t.error = 'Schwab did not return the orders on this account, so there is no telling what already closes the legs. Try again in a moment.';
    return t;
  }
  const last = state.posLast;
  if (last && last.hash === t.hash && last.symbol === key && !last.confirmed && now - last.at < UNCONFIRMED_WAIT) {
    t.error = `Your last order on ${spread.label} has not shown up at Schwab yet. Check Schwab's order list before sending another.`;
    t.listing = true;
    return t;
  }
  const all = spreadClosePlan(spread, state.positions ? state.positions.orders : [], { type: 'MARKET' }); // what blocks any close of it
  if (all.error) { t.error = all.error; return t; }
  t.close = prev ? { ...prev.close } : { type: 'LIMIT', qty: spread.units, portion: 1, price: optionPriceTick(Math.max(0, spread.price)) };
  if (prev && prev.close.portion != null) t.close.qty = portionQty(t, prev.close.portion); // All (or ½) means of what's held now
  plan(t);
  t.warnings = buildWarnings(t, now);
  return t;
}

function plan(t) {
  const p = spreadClosePlan(t.spread, state.positions ? state.positions.orders : [], { ...t.close, duration: t.stopDuration });
  Object.assign(t, { steps: p.steps, price: p.price, qty: p.qty, closers: p.closers, planError: p.error });
}

function buildWarnings(t, now) {
  const s = t.spread, out = [], flags = [];
  const warn = (flag, text) => { flags.push(flag); out.push(text); };
  const limit = t.close.type === 'LIMIT';
  if (!inRegularHours(now)) warn('hours', limit ? 'Outside regular hours. The limit starts working at the next open.' : 'Outside regular hours. A market order waits for the next open and can fill far from here.');
  // a debit spread closes for a credit (selling it): a limit at or under the mark likely fills now; a credit spread the other way
  if (limit && !t.planError && (s.kind === 'debit' ? t.price <= s.price : t.price >= s.price)) {
    warn('fills', `The limit ${px(t.price)} is at or ${s.kind === 'debit' ? 'below' : 'above'} the mark ${px(s.price)}, so it likely fills right away.`);
  }
  if (!limit) warn('market', 'A market order on a spread fills each leg at its own market and can land far from the mark.');
  const last = state.tradeLast;
  if (last && last.symbol === t.key && now - last.at < UNCONFIRMED_WAIT) warn('repeat', `You sent a ${s.label} order ${Math.round((now - last.at) / 1000)}s ago.`);
  t.warnFlags = flags;
  return out;
}

export async function openSpreadClose(key) {
  if (state.posTradeBusy) return;
  if (!schwabConnected()) { showError('Connect Schwab in Settings first.'); openSheet('settings'); return; }
  state.posTradeBusy = true;
  try { await refreshPositions(); } finally { state.posTradeBusy = false; } // the plan is built from what Schwab shows now
  state.spreadTicket = fresh(key);
  renderSpreadCloseSheet();
  openSheet('spreadClose');
  // the net bid and ask over it, from the legs in ratio, signed like the sheet's price; the side the close fills on is lit
  const s = state.spreadTicket.spread, sign = s && s.kind === 'debit' ? 1 : -1;
  return watchSheetQuote({ sheet: 'spreadClose', el: 'spreadCloseQuote', legs: s ? s.legs.map(l => ({ symbol: tradierSymbol(l.symbol), n: sign * l.qty / s.units })) : [],
    fills: () => sign > 0 ? 'bid' : 'ask' });
}

function fresh(key, prev = null, now = Date.now()) {
  if (state.positionsError || !state.positions) {
    const t = buildSpreadTicket(null, key, now);
    t.error = 'Could not re-read the spread from Schwab. ' + state.positionsError;
    return t;
  }
  return buildSpreadTicket(findSpread(key), key, now, prev);
}

const formOpen = () => { const t = state.spreadTicket; return t && !t.error && !t.sent ? t : null; };

function changed(form) {
  const t = state.spreadTicket;
  plan(t);
  t.warnings = buildWarnings(t, Date.now());
  renderSpreadCloseSheet(form);
}

export function setSpreadCloseType(type) {
  const t = formOpen();
  if (!t || (type !== 'MARKET' && type !== 'LIMIT')) return;
  t.close.type = type;
  changed(true);
}

/** a portion chip: that share of the spreads held, at least one */
export function setSpreadClosePortion(fraction) {
  const t = formOpen(), f = Number(fraction);
  if (!t || !PORTIONS.includes(f)) return;
  t.close.qty = portionQty(t, f);
  t.close.portion = f;
  changed(true);
}

// typing re-plans everything after the inputs, so the cursor stays where it is
export function setSpreadCloseQty(value) {
  const t = formOpen();
  if (!t) return;
  t.close.qty = Number(value);
  t.close.portion = null;
  changed(false);
}

export function setSpreadClosePrice(value) {
  const t = formOpen();
  if (!t) return;
  t.close.price = parseFloat(value) || 0;
  changed(false);
}

export function setSpreadCloseDuration(d) {
  const t = formOpen();
  if (!t || t.close.type !== 'LIMIT' || (d !== 'DAY' && d !== 'GOOD_TILL_CANCEL')) return;
  store.set('schwab_stop_duration', d);
  t.stopDuration = d;
  changed(true);
}

const portionQty = (t, f) => f >= 1 ? t.spread.units : Math.max(1, Math.floor(t.spread.units * f + 1e-9));

const sendsSame = (a, b) => JSON.stringify([a.hash, a.steps.map(s => [s.kind, s.orderId ?? null, s.order || null])])
  === JSON.stringify([b.hash, b.steps.map(s => [s.kind, s.orderId ?? null, s.order || null])]);

/** a cancel Schwab refused: fine if the order is already on its way out, a stop if it filled */
async function cancelStep(t, step) {
  try { await schwabCancelOrder(step.orderId, t.hash); }
  catch(e) {
    if (e instanceof TypeError || !e.status) throw e;
    const o = await schwabOrder(step.orderId, t.hash).catch(() => null);
    if (o && o.status === 'FILLED') throw new Error(`Schwab filled order ${step.orderId} while this ran. Nothing more was sent.`);
    if (!o || !orderGone(o.status || '')) throw e;
    step.note = 'already cancelled';
  }
}

export async function placeSpreadClose() {
  const t = state.spreadTicket;
  if (!t || t.error || t.planError || t.sent || state.posTradeBusy) return;
  state.posTradeBusy = true;
  t.checking = true;
  renderSpreadCloseSheet();
  let next;
  try { await refreshPositions(); next = fresh(t.key, t); } finally { t.checking = false; }
  const moved = state.positions && next.hash !== t.hash ? 'account' : next.error || next.planError || !sendsSame(next, t) ? 'orders'
    : (next.warnFlags || []).some(f => !(t.warnFlags || []).includes(f)) ? 'warnings' : '';
  if (moved) {
    state.posTradeBusy = false;
    if (moved === 'account') { next.error = 'You switched Schwab accounts since this was reviewed. Nothing was sent.'; next.listing = false; }
    else if (next.error) next.error = 'Nothing was sent. ' + next.error;
    else if (moved === 'warnings') next.notice = 'Nothing was sent: something new to know. Check the warnings, then send again.';
    else next.notice = 'Schwab changed since you opened this, so nothing was sent. This is what it would send now: review it, then send again.';
    if (state.spreadTicket === t) { state.spreadTicket = next; renderSpreadCloseSheet(); }
    return;
  }
  Object.assign(t, { spread: next.spread, warnings: next.warnings, warnFlags: next.warnFlags });
  t.sent = true; // one review, one run: no step is sent twice, and nothing retries
  try {
    for (const step of t.steps) {
      step.status = 'sending';
      renderSpreadCloseSheet();
      try {
        if (step.kind === 'cancel') await cancelStep(t, step);
        else step.newId = (await schwabPlaceOrder(step.order, t.hash)).orderId;
        step.status = 'done';
      } catch(e) {
        step.status = 'failed';
        step.notSent = !!e.notSent;
        t.failure = failureText(e);
        break;
      }
    }
    if (t.steps.some(s => s.status === 'done' || (s.status === 'failed' && !s.notSent))) {
      state.tradeLast = { symbol: t.key, at: Date.now() };
      await refreshPositions(); // what Schwab shows now, not what the answers implied
      Object.assign(t, outcome(t));
      state.posLast = { hash: t.hash, symbol: t.key, at: Date.now(), confirmed: t.confirmed };
    }
  } finally {
    state.posTradeBusy = false;
    if (state.spreadTicket === t) renderSpreadCloseSheet();
  }
  if (t.confirmed) showToast(t.done);
}

/** confirmed when every leg is smaller by its share of the close, or (a limit) Schwab lists a new spread close for it */
function outcome(t) {
  const p = state.positions;
  if (state.positionsError || !p || p.hash !== t.hash) return { done: 'Could not re-read Schwab. Check your Schwab orders.', confirmed: false };
  const s = t.spread, n = t.qty;
  const now = s.legs.map(l => Math.abs((p.rows.find(r => r.symbol === l.symbol) || { qty: 0 }).qty));
  const ratios = s.legs.map(l => Math.abs(l.qty) / s.units);
  const left = Math.min(...now.map((q, i) => Math.floor(q / ratios[i] + 1e-9)));
  if (!t.failure && now.every((q, i) => q <= Math.abs(s.legs[i].qty) - n * ratios[i] + 1e-9)) {
    return { done: left ? `Schwab now shows ${spreads(left)} ${s.label}.` : `Schwab no longer shows the ${s.label} spread.`, confirmed: true };
  }
  const before = t.closers.filter(c => !t.steps.some(st => st.kind === 'cancel' && st.status === 'done' && st.orderId === c.orderId));
  const added = spreadClosers(s, p.orders).filter(c => c.price === t.price && !before.some(b => b.orderId === c.orderId)).reduce((q, c) => q + c.qty, 0);
  if (!t.failure && t.close.type === 'LIMIT' && added >= n) return { done: `Schwab now shows a net limit ${px(t.price)} to close ${spreads(n)} ${s.label}.`, confirmed: true };
  const wait = t.failure ? '' : t.close.type === 'LIMIT' ? ' Schwab does not show the limit yet. Check Schwab.' : ' A market order can take a moment to fill.';
  return { done: `Schwab still shows ${spreads(left)} ${s.label}.${wait}`, confirmed: false };
}

/** every order Schwab lists on the spread's legs, any status: the ground truth when a result isn't confirmed */
function schwabList(t) {
  const p = state.positions, s = t.spread;
  if (!p || !p.orders || !s) return '';
  const mine = new Set(s.legs.map(l => l.symbol));
  const list = [];
  const walk = o => {
    const legs = o.orderLegCollection || [];
    if (legs.some(l => mine.has(l.instrument?.symbol))) list.push(o);
    (o.childOrderStrategies || []).forEach(walk);
  };
  p.orders.forEach(walk);
  if (!list.length) return '';
  const item = o => `<li>${esc(words(o.orderType))}${o.price ? ' ' + px(o.price) : o.stopPrice ? ' ' + px(o.stopPrice) : ''} · ${(o.orderLegCollection || []).length > 1 ? `${(o.orderLegCollection || []).length} legs` : esc(words(o.orderLegCollection[0].instruction))} ${Number(o.quantity) || 0} · ${esc(words(o.status))}</li>`;
  return `<div class="pos-orders"><div class="pos-orders-title">Schwab lists for ${esc(s.label)}</div><ul>${list.sort((a, b) => String(b.enteredTime || '').localeCompare(String(a.enteredTime || ''))).slice(0, 8).map(item).join('')}</ul></div>`;
}

function stepText(t, step) {
  if (step.kind === 'cancel') {
    const w = step.was, at = w.stop ?? w.price;
    const what = w.symbol === t.key ? 'spread close' : `${words(w.orderType)} on ${(t.spread.legs.find(l => l.symbol === w.symbol) || { label: w.symbol }).label}`;
    return `Cancel ${what}${at === null ? '' : ' ' + px(at)} for ${w.symbol === t.key ? spreads(w.qty) : contracts(w.qty)}${step.note ? ` (${step.note})` : ''}`;
  }
  const o = step.order;
  const legs = o.orderLegCollection.map(l => `${l.instruction === 'SELL_TO_CLOSE' ? 'sell' : 'buy'} ${l.quantity} ${(t.spread.legs.find(x => x.symbol === l.instrument.symbol) || { label: l.instrument.symbol }).label}`).join(', ');
  const how = o.orderType === 'MARKET' ? 'at market' : `for a net ${o.orderType === 'NET_CREDIT' ? 'credit' : 'debit'} of ${px(o.price)} or better`;
  return `Close ${spreads(t.qty)} ${t.spread.label} ${how}, as one order: ${legs}`;
}

function form(t, duration) {
  const s = t.spread, c = t.close, limit = c.type === 'LIMIT', off = t.sent ? ' disabled' : '';
  const type = (v, label) => `<button class="${c.type === v ? 'active' : ''}" aria-pressed="${c.type === v}" data-action="setSpreadCloseType" data-arg="${v}"${off}>${label}</button>`;
  const chips = PORTIONS.map(f => {
    const n = portionQty(t, f), on = c.qty === n && (c.portion === f || (f >= 1 && c.portion == null));
    return `<button class="filter-btn${on ? ' active' : ''}" aria-pressed="${on}" data-action="setSpreadClosePortion" data-arg="${f}" title="${spreads(n)}"${off}>${f >= 1 ? 'All' : Math.round(f * 100) + '%'}</button>`;
  }).join('');
  const price = c.price > 0 ? c.price.toFixed(2) : '';
  const net = s.kind === 'debit' ? 'credit' : 'debit';
  return `<div><dt>Order</dt><dd><div class="seg" role="group" aria-label="Order type">${type('LIMIT', 'Net limit')}${type('MARKET', 'Market')}</div></dd></div>
    <div><dt><label for="spreadCloseQty">Spreads to close</label></dt><dd><div class="pos-close-qty"><input type="number" id="spreadCloseQty" step="1" min="1" max="${s.units}" inputmode="numeric" autocomplete="off" value="${c.qty > 0 ? c.qty : ''}" data-input="setSpreadCloseQty"${off} /><div class="chip-row pos-portions pos-close-portions" role="group" aria-label="Percent of the spreads held">${chips}</div></div></dd></div>
    ${limit ? `<div><dt><label for="spreadClosePrice">Net ${net}</label></dt><dd><div class="prefix-wrap pos-close-price"><span class="prefix">$</span><input type="number" id="spreadClosePrice" step="0.05" min="0" inputmode="decimal" autocomplete="off" value="${price}" data-input="setSpreadClosePrice"${off} /></div><span class="shares-detail">Per spread. Now ${px(s.price)} at Schwab's marks; $0.05 steps under $3, $0.10 from $3</span></dd></div>
    <div><dt>Order lasts</dt><dd><div class="seg" role="group" aria-label="Order lasts">${duration('DAY', 'Today')}${duration('GOOD_TILL_CANCEL', 'Until canceled')}</div></dd></div>` : ''}`;
}

function estimate(t) {
  const s = t.spread, at = t.close.type === 'LIMIT' ? t.price : s.price, n = t.qty;
  const gain = s.avg > 0 ? (s.kind === 'debit' ? at - s.avg : s.avg - at) * n * s.mult : null;
  const pct = gain === null ? null : gain / (s.avg * n * s.mult) * 100;
  const g = gain === null ? '' : ` · <span class="${gain >= 0 ? 'pos-locked' : 'pos-loss'}">${(gain >= 0 ? '+' : '−') + fmt$(Math.abs(gain))}</span> (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%) on the ${s.kind} ${fmt$(s.avg)}`;
  return `<div><dt>Estimate</dt><dd>${fmt$(n * at * s.mult)} ${s.kind === 'debit' ? 'in' : 'out'}<span class="shares-detail">${t.close.type === 'LIMIT' ? 'If it fills at the limit' : "At Schwab's marks, before the fill"}${g}</span></dd></div>`;
}

export function renderSpreadCloseSheet(full = true) {
  const t = state.spreadTicket;
  const acct = schwabAccount();
  document.getElementById('spreadCloseAccount').textContent = acct ? 'Account ••' + acct.last4 : '';
  const body = document.getElementById('spreadCloseBody');
  if (!t) { body.innerHTML = ''; return; }
  if (t.error) {
    body.innerHTML = `<p class="trade-warn" role="alert">${esc(t.error)}</p>${t.listing ? schwabList(t) : ''}<div class="trade-actions"><button class="btn" data-action="closeSheet">Close</button></div>`;
    return;
  }
  const s = t.spread, c = t.close;
  const marks = { sending: '…', done: '✓', failed: '✗' };
  const steps = t.steps.map(st => `<li class="pos-step${st.status ? ' ' + st.status : ''}">${st.status ? marks[st.status] + ' ' : ''}${esc(stepText(t, st))}</li>`).join('');
  const duration = (d, label) => `<button class="${t.stopDuration === d ? 'active' : ''}" aria-pressed="${t.stopDuration === d}" data-action="setSpreadCloseDuration" data-arg="${d}"${t.sent ? ' disabled' : ''}>${label}</button>`;
  const cancelsFirst = t.steps.some(st => st.kind === 'cancel');
  const hint = [
    'Every leg goes out in one order, so the spread closes together and no leg is left on its own.',
    cancelsFirst ? 'Orders that would close a leg are cancelled first, so nothing closes twice. If a cancel fails, the close is not sent.' : '',
    c.type === 'LIMIT' ? `A net limit fills at your price or better, and only if the spread gets there.` : '',
  ].filter(Boolean).join(' ');
  const confirm = `Close ${(c.qty || 0).toLocaleString('en-US')} ${s.label}` + (c.type === 'LIMIT' ? `, net ${px(t.planError ? c.price : t.price)}` : ' at market');
  const orders = t.steps.map(st => st.kind === 'cancel' ? { cancel: st.orderId } : { place: st.order });
  const settled = t.sent && !state.posTradeBusy;
  const willSend = t.planError ? `<p class="trade-warn">${esc(t.planError)}</p>` : `<ol class="pos-steps">${steps}</ol>`;
  const detail = `
    ${t.notice ? `<p class="trade-warn" role="alert">${esc(t.notice)}</p>` : ''}
    <dl class="trade-legs">
      <div><dt>${t.sent ? 'Sent' : 'Will send'}</dt><dd>${willSend}</dd></div>
      ${t.planError ? '' : estimate(t)}
    </dl>
    ${t.warnings.map(w => `<p class="trade-warn">${esc(w)}</p>`).join('')}
    <p class="hint">${esc(hint)}</p>
    <details class="hint-details"><summary>Orders sent to Schwab</summary><pre class="trade-json">${esc(JSON.stringify(orders, null, 2))}</pre></details>
    <div class="trade-actions">
      <button class="btn" data-action="closeSheet">${t.sent ? 'Done' : 'Cancel'}</button>
      ${t.sent ? '' : `<button class="btn trade-confirm" data-action="placeSpreadClose"${state.posTradeBusy || t.planError ? ' disabled' : ''}>${esc(confirm)}</button>`}
    </div>
    <p class="trade-result${settled ? (t.failure ? ' bad' : t.confirmed ? ' ok' : '') : ''}" role="status">${esc(t.checking ? 'Checking Schwab…' : [t.failure, t.done].filter(Boolean).join(' '))}</p>
    ${settled && (t.failure || !t.confirmed) ? schwabList(t) : ''}`;
  if (!full && document.getElementById('spreadCloseDetail')) { document.getElementById('spreadCloseDetail').innerHTML = detail; return; }
  body.innerHTML = `
    <dl class="trade-legs">
      <div><dt>Spread</dt><dd><strong>${s.kind === 'debit' ? 'Long' : 'Short'} ${spreads(s.units)} ${esc(s.label)}</strong><span class="shares-detail">${esc(s.structure)} · ${esc(s.legWords)} · ${s.kind} ${s.avg > 0 ? px(s.avg) : '—'} · now ${px(s.price)}</span></dd></div>
      ${form(t, duration)}
    </dl>
    <div id="spreadCloseDetail">${detail}</div>`;
}
