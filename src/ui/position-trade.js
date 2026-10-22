// Position trades: a breakeven stop, a stop at your price, a profit target or a close (market or limit, all or part) for one Schwab position, reviewed in a sheet and sent once.
// Schwab is re-read right before sending, and the steps go only if they are still the ones reviewed, to the account they
// were read from. Steps run in order and stop at the first failure; nothing retries. Schwab is re-read afterwards to say
// what it now shows, and until it shows the last result, that symbol in that account takes no new order from here.
import { state } from '../state.js';
import { fmt$, marketEscape as esc } from '../core/format.js';
import { closingInstruction, inRegularHours, optionPriceTick, priceTick } from '../core/orders.js';
import { INSTRUCTION_WORDS, breakevenPlan, closePlan, closersInTheWay, fmtPositionPrice, orderGone, orderTypeWord, ordersFor, stopLocked, stopPlan, targetGain, targetPlan, targetRoom } from '../core/positions.js';
import { store } from '../lib/store.js';
import { schwabAccount, schwabCancelOrder, schwabConnected, schwabOrder, schwabPlaceOrder, schwabReplaceOrder, schwabStopDuration } from '../services/schwab.js';
import { showError, showToast } from './feedback.js';
import { positionStopPlaced, positionTargetPlaced } from './position-chart.js';
import { refreshPositions } from './positions.js';
import { maxLossPerTrade } from './risk.js';
import { openSheet } from './sheets.js';

const UNCONFIRMED_WAIT = 120000;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const units = (row, n) => `${n.toLocaleString('en-US')} ${row.tradeAs === 'OPTION' ? (n === 1 ? 'contract' : 'contracts') : (n === 1 ? 'share' : 'shares')}`;
const have = n => n === 1 ? 'has' : 'have';
const statusWord = s => String(s || 'unknown').toLowerCase().replace(/_/g, ' ');

function orderWord(row, was) {
  const px = was.stop ?? was.price;
  return orderTypeWord(was.orderType) + (px === null ? '' : ' ' + fmtPositionPrice(px, row.tradeAs));
}

function stepText(t, step) {
  const row = t.row;
  if (step.kind === 'cancel') {
    return `Cancel ${orderWord(row, step.was)} for ${units(row, step.was.qty)}${step.pairs === step.was ? ', to pair it with a stop' : ''}${step.note ? ` (${step.note})` : ''}`;
  }
  if (step.order.orderStrategyType === 'OCO') {
    const [limit, stop] = step.order.childOrderStrategies;
    return `Place limit ${fmtPositionPrice(limit.price, row.tradeAs)} for ${units(row, limit.orderLegCollection[0].quantity)} paired with stop ${fmtPositionPrice(stop.stopPrice, row.tradeAs)} (one cancels the other)`;
  }
  const leg = step.order.orderLegCollection[0];
  if (step.order.orderType === 'MARKET') return `${cap(INSTRUCTION_WORDS[leg.instruction])} ${units(row, leg.quantity)} ${row.label} at market`;
  if (step.order.orderType === 'LIMIT') return `Place a limit ${fmtPositionPrice(step.order.price, row.tradeAs)} for ${units(row, leg.quantity)} (${INSTRUCTION_WORDS[leg.instruction]})`;
  if (step.kind === 'replace' && step.was.stop === step.order.stopPrice && leg.quantity < step.was.qty) {
    return `Cut ${orderWord(row, step.was)} from ${units(row, step.was.qty)} to ${leg.quantity.toLocaleString('en-US')}`;
  }
  const limit = step.order.orderType === 'STOP_LIMIT' ? ` (limit ${fmtPositionPrice(step.order.price, row.tradeAs)})` : '';
  const next = `${orderTypeWord(step.order.orderType)} ${fmtPositionPrice(step.order.stopPrice, row.tradeAs)}${limit} for ${units(row, leg.quantity)}`;
  return step.kind === 'replace' ? `Replace ${orderWord(row, step.was)} for ${units(row, step.was.qty)} with ${next}` : `Place a ${next} (${INSTRUCTION_WORDS[leg.instruction]})`;
}

/** what pairing changes about a limit: it takes the stop's duration and works in regular hours */
function pairingWarnings(t) {
  const out = new Set();
  const lasts = d => d === 'DAY' ? 'today only' : 'until canceled';
  for (const l of t.paired || []) {
    if (l.duration && l.duration !== t.stopDuration) out.add(`Your limit was for ${l.duration === 'DAY' ? 'today only' : 'longer than today'}. Paired, it lasts ${lasts(t.stopDuration)}, like the stop.`);
    if (l.session && l.session !== 'NORMAL') out.add('Your limit also worked outside regular hours. Paired, it works in regular hours only.');
  }
  return [...out];
}

/** the frozen ticket for one position: its plan, and what could go wrong spelled out. target: { price, qty } for a profit target */
export function buildPositionTicket(row, kind, symbol, now = Date.now(), target = null) {
  // hash: the account it was read from, and the only one its steps go to
  const t = { kind, symbol, hash: (state.positions && state.positions.hash) || '', row: row || null, error: '', notice: '', listing: false, stop: 0, steps: [], paired: [], rest: 0, bare: 0, kept: 0, locked: 0,
    choose: false, mode: null, options: null, target, price: 0, moved: 0, stopDuration: schwabStopDuration(), warnings: [], warnFlags: [], sent: false, checking: false, failure: '', done: '', confirmed: false };
  if (!row) { t.error = `Schwab no longer shows a ${symbol} position.`; return t; }
  if (state.positions && state.positions.stopsMissing) {
    t.error = 'Schwab did not return the orders on this account, so there is no telling what already covers the position. Try again in a moment.';
    return t;
  }
  const last = state.posLast;
  if (last && last.hash === t.hash && last.symbol === row.symbol && !last.confirmed && now - last.at < UNCONFIRMED_WAIT) {
    t.error = `Your last order on ${row.label} has not shown up at Schwab yet. Check Schwab's order list before sending another.`;
    t.listing = true;
    return t;
  }
  if (kind === 'close') {
    const all = closePlan(row); // what blocks any close of it
    if (all.error) { t.error = all.error; return t; }
    t.close = { type: 'MARKET', qty: Math.abs(row.qty), portion: null, price: row.tradeAs === 'OPTION' ? optionPriceTick(row.price) : priceTick(row.price) };
    planClose(t);
  } else if (kind === 'target') planTarget(t);
  else {
    // a stop at your price starts at the nearest stop when some shares have none, else empty
    // the chart's stop when it has one
    if (kind === 'stop') { t.stopInput = target && target.price > 0 ? target.price : row.stop !== null && row.covered < Math.abs(row.qty) ? row.stop : 0; t.target = null; }
    planStops(t);
  }
  if (t.error) return t;
  t.warnings = buildWarnings(t, now);
  return t;
}

// orders already selling part of the position: ask whether to keep them (stop the rest), pair them with stops, or cancel them,
// and send nothing until answered; an option that can't work is shown greyed out with its reason.
// A stop at your price shows its errors (no price, through the market) next to the price input, like the close ticket
function planStops(t) {
  const plan = limits => t.kind === 'stop' ? stopPlan(t.row, { stop: t.stopInput, duration: t.stopDuration, limits }) : breakevenPlan(t.row, t.stopDuration, { limits });
  const options = { keep: plan('keep'), pair: plan('pair'), cancel: plan('cancel') };
  t.choose = closersInTheWay(t.row).length > 0 && Object.values(options).some(p => !p.error);
  t.options = t.choose ? options : null;
  if (t.mode && (!t.options || t.options[t.mode].error)) t.mode = null;
  Object.assign(t, !t.choose ? options.pair : t.mode ? t.options[t.mode] : { error: '', stop: options.pair.stop, steps: [], paired: [], rest: 0, bare: 0, kept: 0, locked: 0 });
  if (t.kind === 'stop') { t.planError = t.error; t.error = ''; }
}

const stopOpen = () => { const t = state.posTicket; return t && t.kind === 'stop' && !t.error && !t.sent ? t : null; };

function stopChanged(form) {
  const t = state.posTicket;
  planStops(t);
  t.warnings = buildWarnings(t, Date.now());
  renderPositionTradeSheet(form);
}

// typing re-plans everything but the input, so the cursor stays where it is
export function setPositionStopPrice(value) {
  const t = stopOpen();
  if (!t) return;
  t.stopInput = parseFloat(value) || 0;
  stopChanged(false);
}

/** a price chip under the stop input (Breakeven) */
export function setPositionStopAt(value) {
  const t = stopOpen();
  if (!t || !(Number(value) > 0)) return;
  t.stopInput = Number(value);
  stopChanged(true);
}

// the close ticket's own errors (too many shares, no price) show in the sheet next to the form instead of replacing it
function planClose(t) {
  const plan = closePlan(t.row, { ...t.close, duration: t.stopDuration });
  Object.assign(t, plan, { error: '', planError: plan.error });
}

function closeChanged(form) {
  const t = state.posTicket;
  planClose(t);
  t.warnings = buildWarnings(t, Date.now());
  renderPositionTradeSheet(form);
}

const closeOpen = () => { const t = state.posTicket; return t && t.kind === 'close' && !t.error && !t.sent ? t : null; };

export function setCloseType(type) {
  const t = closeOpen();
  if (!t || (type !== 'MARKET' && type !== 'LIMIT')) return;
  t.close.type = type;
  closeChanged(true);
}

/** a portion chip: that share of what's held (All = everything, which cancels the targets) */
export function setClosePortion(fraction) {
  const t = closeOpen();
  const n = t && portionQty(t, fraction);
  if (!n) return;
  t.close.qty = n;
  t.close.portion = fraction;
  closeChanged(true);
}

// typing re-plans everything but the inputs, so the cursor stays where it is
export function setCloseQty(value) {
  const t = closeOpen();
  if (!t) return;
  t.close.qty = Number(value);
  t.close.portion = null;
  closeChanged(false);
}

export function setClosePrice(value) {
  const t = closeOpen();
  if (!t) return;
  t.close.price = parseFloat(value) || 0;
  closeChanged(false);
}

function planTarget(t) {
  Object.assign(t, targetPlan(t.row, { price: t.target ? t.target.price : 0, qty: t.target ? t.target.qty : 0, duration: t.stopDuration }));
}

export function setPositionBeMode(mode) {
  const t = state.posTicket;
  if (!t || !t.choose || t.sent || !['keep', 'pair', 'cancel'].includes(mode) || t.options[mode].error) return;
  t.mode = mode;
  planStops(t);
  t.warnings = buildWarnings(t, Date.now());
  renderPositionTradeSheet();
}

/** what a stop ticket locks over your cost (negative: risks): its plan's, or every share at the new price until the cover question is answered */
const stopRiskLocked = t => t.steps.length ? t.locked : stopLocked(t.row, t.stop);

function buildWarnings(t, now) {
  const row = t.row, out = [], flags = [];
  // flags name the warnings, so a send can tell a new one from the same one with fresher numbers
  const warn = (flag, text) => { flags.push(flag); out.push(text); };
  const limit = t.kind === 'close' && t.close.type === 'LIMIT';
  if (!inRegularHours(now)) {
    warn('hours', limit ? 'Outside regular hours. The limit starts working at the next open.'
      : t.kind === 'close' ? 'Outside regular hours. A market order waits for the next open and can fill far from here.'
      : t.kind === 'target' ? 'Outside regular hours. The target starts working at the next open.' : 'Outside regular hours. The stop starts working at the next open.');
  }
  if (limit && !t.planError && (row.qty > 0 ? t.price <= row.price : t.price >= row.price)) {
    warn('fills', `The limit ${fmtPositionPrice(t.price, row.tradeAs)} is at or ${row.qty > 0 ? 'below' : 'above'} the price ${fmtPositionPrice(row.price, row.tradeAs)}, so it likely fills right away.`);
  }
  if ((t.kind === 'target' || limit) && t.stop > 0 && t.stopDuration === 'DAY') {
    const what = t.kind === 'target' ? 'target' : 'limit', n = t.kind === 'target' ? t.target.qty : t.close.qty;
    warn('today', `Today only: at the close the ${what} and the stop paired with it both end, and ${n === 1 ? 'that' : 'those'} ${units(row, n)} ${have(n)} no stop.`);
  }
  if (row.tradeAs === 'OPTION' && !((limit || t.kind === 'target') && !t.stop)) warn('option', t.kind === 'close' && !limit ? 'A market order on an option can fill far from the mark.' : 'An option stop triggers on the option\'s own price, which jumps with its spread.');
  for (const w of pairingWarnings(t)) warn(w, w);
  const risk = t.kind === 'stop' && !t.planError && row.avg > 0 ? -stopRiskLocked(t) : 0, max = maxLossPerTrade();
  if (max > 0 && risk > max + 0.005) warn('maxloss', `At the stop this loses ${fmt$(risk)}, more than your max loss per trade, ${fmt$(max)}.`);
  const last = state.tradeLast;
  if (last && last.symbol === row.symbol && now - last.at < UNCONFIRMED_WAIT) warn('repeat', `You sent a ${row.label} order ${Math.round((now - last.at) / 1000)}s ago.`);
  t.warnFlags = flags;
  return out;
}

/** the ticket from the newest read; prev carries the choices made on an open one (the close form, what the stop covers) */
function freshTicket(kind, symbol, target, prev = null, now = Date.now()) {
  if (state.positionsError || !state.positions) {
    const t = buildPositionTicket(null, kind, symbol, now, target);
    t.error = 'Could not re-read the position from Schwab. ' + state.positionsError;
    return t;
  }
  const t = buildPositionTicket(state.positions.rows.find(r => r.symbol === symbol), kind, symbol, now, target);
  if (!prev || t.error) return t;
  if (kind === 'close') { t.close = { ...prev.close }; planClose(t); }
  else if (kind === 'breakeven' || kind === 'stop') {
    if (kind === 'stop') t.stopInput = prev.stopInput;
    planStops(t);
    if (prev.mode && t.choose && !t.options[prev.mode].error) { t.mode = prev.mode; planStops(t); }
  }
  t.warnings = buildWarnings(t, now);
  return t;
}

/** what a ticket sends, and where: two tickets that match send the same orders to the same account */
const sendsSame = (a, b) => JSON.stringify([a.hash, a.steps.map(s => [s.kind, s.orderId ?? null, s.order || null])])
  === JSON.stringify([b.hash, b.steps.map(s => [s.kind, s.orderId ?? null, s.order || null])]);

export async function openPositionTrade(symbol, kind) {
  if (state.posTradeBusy) return;
  // a target (and a stop picked on the chart) is frozen from the chart's form as it is now
  const c = state.posChart;
  const target = kind === 'target' ? (c && c.symbol === symbol ? { price: c.price || 0, qty: c.qty || 0 } : { price: 0, qty: 0 })
    : kind === 'stop' && c && c.symbol === symbol && c.stop > 0 ? { price: c.stop, qty: 0 } : null;
  if (!schwabConnected()) { showError('Connect Schwab in Settings first.'); openSheet('settings'); return; }
  state.posTradeBusy = true;
  try { await refreshPositions(); } finally { state.posTradeBusy = false; } // the plan is built from what Schwab shows now
  state.posTicket = freshTicket(kind, symbol, target);
  renderPositionTradeSheet();
  openSheet('posTrade');
}

export function setPositionStopDuration(d) {
  const t = state.posTicket;
  if (!t || (t.kind === 'close' && t.close.type !== 'LIMIT') || t.error || t.sent || (d !== 'DAY' && d !== 'GOOD_TILL_CANCEL')) return;
  store.set('schwab_stop_duration', d);
  t.stopDuration = d;
  if (t.kind === 'close') planClose(t); else if (t.kind === 'target') planTarget(t); else planStops(t);
  t.warnings = buildWarnings(t, Date.now());
  renderPositionTradeSheet();
}

/** a cancel Schwab refused: fine if the order is already on its way out (its pair took it), a stop if it filled */
async function cancelStep(t, step) {
  try { await schwabCancelOrder(step.orderId, t.hash); }
  catch(e) {
    if (e instanceof TypeError || !e.status) throw e;
    const o = await schwabOrder(step.orderId, t.hash).catch(() => null);
    if (o && o.status === 'FILLED') throw new Error(`Schwab filled the ${orderWord(t.row, step.was)} for ${units(t.row, step.was.qty)} while this ran. Nothing more was sent.`);
    if (!o || !orderGone(o.status || '')) throw e;
    step.note = 'already cancelled';
  }
}

/** why a step failed; notSent = it never reached Schwab (the login or the account stopped it first) */
export function failureText(e) {
  if (e.notSent) return e instanceof TypeError ? 'Could not reach the Schwab worker. Nothing more was sent.' : `${e.message} Nothing more was sent.`;
  return e instanceof TypeError ? 'No answer from Schwab. Check your Schwab orders before trying again.' : e.status ? 'Schwab refused it. ' + e.message : e.message;
}

export async function placePositionTrade() {
  const t = state.posTicket;
  if (!t || t.error || t.planError || t.sent || state.posTradeBusy || (t.choose && !t.mode)) return;
  state.posTradeBusy = true;
  // Schwab again right before sending: the orders go only while they are still the ones reviewed
  t.checking = true;
  renderPositionTradeSheet();
  let fresh;
  try { await refreshPositions(); fresh = freshTicket(t.kind, t.symbol, t.target, t); } finally { t.checking = false; }
  const moved = state.positions && fresh.hash !== t.hash ? 'account' : fresh.error || fresh.planError || (fresh.choose && !fresh.mode) || !sendsSame(fresh, t) ? 'orders'
    : (fresh.warnFlags || []).some(f => !(t.warnFlags || []).includes(f)) ? 'warnings' : '';
  if (moved) {
    state.posTradeBusy = false;
    if (moved === 'account') { fresh.error = 'You switched Schwab accounts since this was reviewed. Nothing was sent.'; fresh.listing = false; }
    else if (fresh.error) fresh.error = 'Nothing was sent. ' + fresh.error;
    else if (moved === 'warnings') fresh.notice = 'Nothing was sent: something new to know. Check the warnings, then send again.';
    else fresh.notice = 'Schwab changed since you opened this, so nothing was sent. This is what it would send now: review it, then send again.';
    if (state.posTicket === t) { state.posTicket = fresh; renderPositionTradeSheet(); }
    return;
  }
  Object.assign(t, { row: fresh.row, warnings: fresh.warnings, warnFlags: fresh.warnFlags }); // the same orders, judged against what Schwab shows now
  t.sent = true; // one review, one run: no step is sent twice, and nothing retries
  try {
    for (const step of t.steps) {
      step.status = 'sending';
      renderPositionTradeSheet();
      try {
        if (step.kind === 'cancel') await cancelStep(t, step);
        else if (step.kind === 'replace') step.newId = (await schwabReplaceOrder(step.orderId, step.order, t.hash)).orderId;
        else step.newId = (await schwabPlaceOrder(step.order, t.hash)).orderId;
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
      state.tradeLast = { symbol: t.row.symbol, at: Date.now() };
      await refreshPositions(); // what Schwab shows now, not what the answers implied
      Object.assign(t, outcome(t));
      state.posLast = { hash: t.hash, symbol: t.row.symbol, at: Date.now(), confirmed: t.confirmed };
      if (t.kind === 'target' && t.confirmed) positionTargetPlaced(t.row.symbol);
      if (t.kind === 'stop' && t.confirmed) positionStopPlaced(t.row.symbol);
    }
  } finally {
    state.posTradeBusy = false;
    if (state.posTicket === t) renderPositionTradeSheet();
  }
  if (t.confirmed) showToast(t.done);
}

function outcome(t) {
  if (state.positionsError || !state.positions || state.positions.hash !== t.hash) return { done: 'Could not re-read Schwab. Check your Schwab orders.', confirmed: false };
  const row = state.positions.rows.find(r => r.symbol === t.row.symbol);
  if (!row) return { done: `Schwab no longer shows the ${t.row.label} position.`, confirmed: t.kind === 'close' && !t.failure };
  const held = Math.abs(row.qty), bare = held - row.covered;
  const exposed = bare > 0 ? ` ${cap(units(row, bare))} ${bare === 1 ? 'has' : 'have'} no stop now.` : '';
  // a limit cancelled to be paired, whose pair never went out
  const lost = t.steps.filter(s => s.kind === 'cancel' && s.pairs === s.was && s.status === 'done'
    && !t.steps.some(p => p.kind === 'place' && p.pairs === s.was && p.status === 'done'))
    .map(s => ` Your ${orderWord(row, s.was)} for ${units(row, s.was.qty)} was cancelled and not placed again.`).join('');
  // the limits Schwab lists at the order's price, before (less any this run cancelled) and after
  const at = r => r.closers.filter(o => o.orderType === 'LIMIT' && o.price === t.price).reduce((n, o) => n + o.qty, 0);
  const cancelledAt = t.steps.filter(s => s.kind === 'cancel' && s.status === 'done' && s.was.orderType === 'LIMIT' && s.was.price === t.price).reduce((n, s) => n + s.was.qty, 0);
  const added = () => at(row) - Math.max(0, at(t.row) - cancelledAt);
  if (t.kind === 'close') {
    const n = t.close.qty, limit = t.close.type === 'LIMIT';
    if (!t.failure && held <= Math.abs(t.row.qty) - n) return { done: (`Schwab now shows ${units(row, held)} ${row.label}.` + exposed).trim(), confirmed: true };
    if (!t.failure && limit && added() >= n) {
      const paired = t.stop > 0 ? `, paired with a stop at ${fmtPositionPrice(t.stop, row.tradeAs)}` : '';
      return { done: (`Schwab now shows a limit ${fmtPositionPrice(t.price, row.tradeAs)} for ${units(row, n)}${paired}.` + exposed).trim(), confirmed: true };
    }
    const wait = t.failure ? '' : limit ? ' Schwab does not show the limit yet. Check Schwab.' : ' A market order can take a moment to fill.';
    return { done: (`Schwab still shows ${units(row, held)} ${row.label}.${wait}` + exposed + lost).trim(), confirmed: false };
  }
  if (t.kind === 'target') {
    if (!t.failure && added() >= t.target.qty) {
      const paired = t.stop > 0 ? `, paired with a stop at ${fmtPositionPrice(t.stop, row.tradeAs)}` : '';
      return { done: (`Schwab now shows a target at ${fmtPositionPrice(t.price, row.tradeAs)} for ${units(row, t.target.qty)}${paired}.` + exposed).trim(), confirmed: true };
    }
    return { done: ((t.failure ? '' : 'Schwab does not show the target yet. Check Schwab.') + exposed).trim(), confirmed: false };
  }
  // a breakeven stop counts where Schwab shows stops at or past it; the ones already past stayed where they were
  const px = fmtPositionPrice(t.stop, row.tradeAs);
  const past = s => row.qty > 0 ? s.stop >= t.stop - 1e-9 : s.stop <= t.stop + 1e-9;
  const covers = list => list.filter(past).reduce((n, s) => n + s.qty, 0);
  const at$ = list => list.every(s => s.stop === t.stop) ? `at ${px}` : `at or past ${px}`;
  if (t.mode === 'keep') {
    const plain = row.stopOrders.filter(s => s.oco === null);
    if (!t.failure && plain.length && covers(plain) >= t.rest) {
      const one = plain.length === 1 ? 'a stop' : 'stops';
      return { done: `Schwab now shows ${one} ${at$(plain)} for ${units(row, t.rest)}.${t.bare ? ` Your limit keeps ${units(row, t.bare)} without a stop.` : ''}`, confirmed: true };
    }
  }
  if (!t.failure && row.stopOrders.length > 0 && covers(row.stopOrders) >= held) {
    return { done: row.stopOrders.length === 1 ? `Schwab now shows a stop ${at$(row.stopOrders)} for ${units(row, held)}.` : `Schwab now shows stops ${at$(row.stopOrders)} for all ${units(row, held)}.`, confirmed: true };
  }
  return { done: ((t.failure ? '' : 'Schwab does not show the new stop yet. Check Schwab.') + exposed + lost).trim(), confirmed: false };
}

/** every order Schwab lists on the symbol, any status: the ground truth when a result isn't confirmed */
function schwabList(t) {
  const p = state.positions;
  const list = p && p.orders ? ordersFor(p.orders, t.symbol) : [];
  if (!list.length) return '';
  const as = t.row ? t.row.tradeAs : null;
  const item = o => {
    const px = o.stop ?? o.price;
    return `<li>${esc(orderTypeWord(o.orderType))}${px === null ? '' : ' ' + fmtPositionPrice(px, as)} · ${esc(INSTRUCTION_WORDS[o.instruction] || statusWord(o.instruction))} ${o.qty.toLocaleString('en-US')} · ${esc(statusWord(o.status))}</li>`;
  };
  return `<div class="pos-orders"><div class="pos-orders-title">Schwab lists for ${esc(t.row ? t.row.label : t.symbol)}</div><ul>${list.map(item).join('')}</ul></div>`;
}

/** the question orders in the way raise: keep them and stop the rest, pair them with stops, or cancel them and stop everything */
function choicePrompt(t) {
  const row = t.row, held = Math.abs(row.qty);
  const inWay = closersInTheWay(row), many = inWay.length > 1;
  const inLimit = inWay.reduce((n, l) => n + l.qty, 0);
  const verb = row.qty > 0 ? (many ? 'sell' : 'sells') : (many ? 'buy back' : 'buys back');
  const what = many ? `Your orders for ${units(row, inLimit)} already ${verb}` : `Your ${orderWord(row, inWay[0])} for ${units(row, inLimit)} already ${verb}`;
  const share = inLimit >= held ? 'the whole position' : 'part of this position';
  const { keep, pair, cancel } = t.options;
  const limitCount = inWay.filter(o => o.orderType === 'LIMIT').length;
  const targets = limitCount ? ` You lose the ${limitCount > 1 ? 'targets' : 'target'}.` : '';
  // the breakeven stop, or the stop at your price
  const be = t.kind !== 'stop', name = be ? 'breakeven stop' : `stop at ${fmtPositionPrice(t.stop, row.tradeAs)}`;
  const keepSub = keep.error || `${cap(name)} for the ${units(row, keep.rest)} outside the ${many ? 'limits' : 'limit'}. ${many ? 'The limits stay as they are' : 'The limit stays as it is'}${keep.bare ? `; ${many ? 'their' : 'its'} ${units(row, keep.bare)} ${have(keep.bare)} no stop.` : ', with its own stop where it is.'}`;
  const pairSub = pair.error || `Every share gets a ${name}. The ${many ? 'limits are' : 'limit is'} cancelled and placed again with ${many ? 'their' : 'its'} own stop.`;
  const cancelSub = cancel.error || `${many ? 'Cancel them' : 'Cancel it'}, then one ${name} for all ${units(row, held)}.${targets}`;
  const opt = (mode, title, sub, off) => `<button class="pos-choice-opt${t.mode === mode ? ' active' : ''}" aria-pressed="${t.mode === mode}" data-action="setPositionBeMode" data-arg="${mode}"${off || t.sent ? ' disabled' : ''}><strong>${esc(title)}</strong><span>${esc(sub)}</span></button>`;
  return `<div><dt>Stop covers</dt><dd><span class="shares-detail">${esc(what)} ${share}. Schwab won't take a stop for the same shares too.</span>
    <div class="pos-choice" role="group" aria-label="What the ${be ? 'breakeven ' : ''}stop covers">
      ${opt('keep', 'Stop the rest', keepSub, !!keep.error)}
      ${opt('pair', 'Pair with the limit', pairSub, !!pair.error)}
      ${opt('cancel', many ? 'Cancel them' : `Cancel the ${orderTypeWord(inWay[0].orderType)}`, cancelSub, !!cancel.error)}
    </div></dd></div>`;
}

/** a target's own rows: how long its orders last, and what it makes */
function targetRows(t, duration) {
  const row = t.row, g = targetGain(row, t.price, t.target.qty);
  const sign = v => (v >= 0 ? '+' : '−') + fmt$(Math.abs(v));
  const r = g.r === null ? '' : ` · ${g.r.toFixed(1)}R from the ${fmtPositionPrice(t.stop, row.tradeAs)} stop`;
  const left = Math.abs(row.qty) - t.target.qty;
  return `<div><dt>Orders last</dt><dd><div class="seg" role="group" aria-label="Orders last">${duration('DAY', 'Today')}${duration('GOOD_TILL_CANCEL', 'Until canceled')}</div></dd></div>
    <div><dt>At target</dt><dd>${g.gain === null ? '<span class="shares-detail">Schwab shows no cost basis for this position.</span>'
      : `<span class="${g.gain >= 0 ? 'pos-locked' : 'pos-loss'}">${sign(g.gain)}</span><span class="shares-detail">${g.pct >= 0 ? '+' : '−'}${Math.abs(g.pct).toFixed(1)}% over your cost${r}. ${left ? `${cap(units(row, left))} left after it fills.` : 'Nothing left after it fills.'}</span>`}</dd></div>`;
}

function targetHint(t) {
  const row = t.row, verb = INSTRUCTION_WORDS[closingInstruction(row.tradeAs, row.qty > 0)], same = row.tradeAs === 'OPTION' ? 'contracts' : 'shares';
  const pairing = t.moved > 0
    ? `Schwab won't take orders to ${verb} more than you hold, so the target is paired with a stop for the same ${same} (one cancels the other) and your stop is cut to make room. While the target goes in, ${units(row, t.moved)} ${have(t.moved)} no stop for a moment.`
    : t.stop > 0 ? `The target is paired with a stop at ${fmtPositionPrice(t.stop, row.tradeAs)} for the same ${same}: one cancels the other.`
    : 'This position has no stop, so the target goes alone.';
  return pairing + ' A limit fills at the target or better, and only if the price gets there.';
}

const CLOSE_PORTIONS = [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1];

/** what a portion chip closes: that share of what's held, at least one; 0 when it's more than is left to close (targets hold the rest) */
function portionQty(t, f) {
  const held = Math.abs(t.row.qty);
  if (f >= 1) return held;
  const n = Math.max(1, Math.floor(held * f + 1e-9));
  return n <= Math.min(held, targetRoom(t.row).free) ? n : 0;
}

/** the close ticket, like a broker's: Market or Limit, how many, and for a limit its price and how long it lasts */
function closeForm(t, duration) {
  const row = t.row, c = t.close, held = Math.abs(row.qty), limit = c.type === 'LIMIT', off = t.sent ? ' disabled' : '';
  const type = (v, label) => `<button class="${c.type === v ? 'active' : ''}" aria-pressed="${c.type === v}" data-action="setCloseType" data-arg="${v}"${off}>${label}</button>`;
  const chips = CLOSE_PORTIONS.map(f => {
    const n = portionQty(t, f), ok = !t.sent && n > 0, on = ok && c.qty === n && (c.portion === f || (f >= 1 && c.portion == null));
    const why = n ? units(row, n) : 'More than your other orders leave free';
    return `<button class="filter-btn${on ? ' active' : ''}" aria-pressed="${on}" data-action="setClosePortion" data-arg="${f}" title="${why}"${ok ? '' : ' disabled'}>${f >= 1 ? 'All' : Math.round(f * 100) + '%'}</button>`;
  }).join('');
  const what = `${row.tradeAs === 'OPTION' ? 'Contracts' : 'Shares'} to ${row.qty > 0 ? 'sell' : 'buy back'}`;
  const price = c.price > 0 ? c.price.toFixed(row.tradeAs === 'OPTION' || c.price >= 1 ? 2 : 4) : '';
  return `<div><dt>Order</dt><dd><div class="seg" role="group" aria-label="Order type">${type('MARKET', 'Market')}${type('LIMIT', 'Limit')}</div></dd></div>
    <div><dt><label for="posCloseQty">${what}</label></dt><dd><div class="pos-close-qty"><input type="number" id="posCloseQty" step="1" min="1" max="${held}" inputmode="numeric" autocomplete="off" value="${c.qty > 0 ? c.qty : ''}" data-input="setCloseQty"${off} /><div class="chip-row pos-portions pos-close-portions pos-close-tens" role="group" aria-label="Percent of the position">${chips}</div></div></dd></div>
    ${limit ? `<div><dt><label for="posClosePrice">Limit price</label></dt><dd><div class="prefix-wrap pos-close-price"><span class="prefix">$</span><input type="number" id="posClosePrice" step="0.01" min="0" inputmode="decimal" autocomplete="off" value="${price}" data-input="setClosePrice"${off} /></div><span class="shares-detail">Now ${fmtPositionPrice(row.price, row.tradeAs)} at Schwab's mark</span></dd></div>
    <div><dt>Orders last</dt><dd><div class="seg" role="group" aria-label="Orders last">${duration('DAY', 'Today')}${duration('GOOD_TILL_CANCEL', 'Until canceled')}</div></dd></div>` : ''}`;
}

/** what the close brings in (or costs, for a short) and what it makes over your cost */
function closeEstimate(t) {
  const row = t.row, limit = t.close.type === 'LIMIT', n = t.close.qty, at = limit ? t.price : row.price;
  const g = targetGain(row, at, n);
  const gain = g.gain === null ? '' : ` · <span class="${g.gain >= 0 ? 'pos-locked' : 'pos-loss'}">${(g.gain >= 0 ? '+' : '−') + fmt$(Math.abs(g.gain))}</span> (${g.pct >= 0 ? '+' : '−'}${Math.abs(g.pct).toFixed(1)}%) on your cost`;
  return `<div><dt>Estimate</dt><dd>${fmt$(n * at * row.mult)}<span class="shares-detail">${limit ? 'If it fills at the limit' : "At Schwab's mark, before the fill"}${gain}</span></dd></div>`;
}

function closeHint(t) {
  const row = t.row, c = t.close, held = Math.abs(row.qty), limit = c.type === 'LIMIT';
  const verb = INSTRUCTION_WORDS[row.qty > 0 ? 'SELL' : 'BUY_TO_COVER'];
  const room = c.qty === held
    ? (t.steps.length > 1 ? 'Orders that would close it are cancelled first, so nothing closes twice. If a cancel fails, the close is not sent.' : '')
    : t.moved > 0 ? `Schwab won't take orders to ${verb} more than you hold, so your stops are cut to fit. Your targets stay.` : '';
  const pair = !limit ? '' : t.stop > 0
    ? `The limit is paired with a stop at ${fmtPositionPrice(t.stop, row.tradeAs)} for the same ${row.tradeAs === 'OPTION' ? 'contracts' : 'shares'}: one cancels the other.${c.qty === held ? ` While it goes in, ${units(row, held)} ${have(held)} no stop for a moment.` : ''}`
    : 'This position has no stop, so the limit goes alone.';
  return [room, pair, limit ? 'A limit fills at your price or better, and only if the price gets there.' : ''].filter(Boolean).join(' ');
}

/** the stop ticket's price, with breakeven a tap away when the price is past it */
function stopForm(t) {
  const row = t.row, long = row.qty > 0, off = t.sent ? ' disabled' : '';
  const v = t.stopInput, value = v > 0 ? v.toFixed(row.tradeAs === 'OPTION' || v >= 1 ? 2 : 4) : '';
  const beOk = row.be !== null && (long ? row.price > row.be : row.price < row.be);
  const on = beOk && t.stop === row.be && !t.planError;
  const chip = beOk ? `<button class="filter-btn pos-stop-at${on ? ' active' : ''}" aria-pressed="${on}" data-action="setPositionStopAt" data-arg="${row.be}" title="Your average cost, on the tick"${off}>Breakeven ${fmtPositionPrice(row.be, row.tradeAs)}</button>` : '';
  const now = row.stop !== null ? ` · nearest stop ${fmtPositionPrice(row.stop, row.tradeAs)}${row.covered < Math.abs(row.qty) ? ` for ${units(row, row.covered)}` : ''}` : ' · no stop now';
  return `<div><dt><label for="posStopPrice">Stop price</label></dt><dd><div class="pos-close-qty"><div class="prefix-wrap pos-close-price"><span class="prefix">$</span><input type="number" id="posStopPrice" step="0.01" min="0" inputmode="decimal" autocomplete="off" value="${value}" data-input="setPositionStopPrice"${off} /></div>${chip}</div><span class="shares-detail">Now ${fmtPositionPrice(row.price, row.tradeAs)} at Schwab's mark${now}</span></dd></div>`;
}

/** a stop at your price: how long it lasts, and what the position risks (or locks) at its stops afterwards */
function stopRows(t, duration) {
  const row = t.row, px = p => fmtPositionPrice(p, row.tradeAs);
  const lasts = `<div><dt>Stop lasts</dt><dd><div class="seg" role="group" aria-label="Stop lasts">${duration('DAY', 'Today')}${duration('GOOD_TILL_CANCEL', 'Until canceled')}</div></dd></div>`;
  if (t.planError) return lasts;
  if (!(row.avg > 0)) return lasts + '<div><dt>Risk at stop</dt><dd><span class="shares-detail">Schwab shows no cost basis for this position.</span></dd></div>';
  const gain = stopRiskLocked(t);
  const acct = state.positions && state.positions.value > 0 ? ` · ${(Math.abs(gain) * 100 / state.positions.value).toFixed(2)}% of acct` : '';
  const figure = gain > 0.005 ? `<span class="pos-locked">+${fmt$(gain)} locked</span>` : gain < -0.005 ? `<span class="pos-loss">−${fmt$(-gain)}</span>` : '<span class="pos-locked">$0.00</span>';
  const words = [`From your average cost ${px(row.avg)}${gain < -0.005 ? acct : ''}`,
    t.kept ? `${cap(units(row, t.kept))} keep ${t.kept === 1 ? 'its' : 'their'} tighter stop` : '',
    t.bare ? `${cap(units(row, t.bare))} in your limit have no stop` : ''].filter(Boolean).join('. ');
  return `${lasts}<div><dt>Risk at stop</dt><dd>${figure}<span class="shares-detail">${esc(words)}</span></dd></div>`;
}

export function renderPositionTradeSheet(form = true) {
  const t = state.posTicket;
  const acct = schwabAccount();
  document.getElementById('posTradeAccount').textContent = acct ? 'Account ••' + acct.last4 : '';
  document.getElementById('posTradeTitle').textContent = !t || t.kind === 'breakeven' ? 'Stop at breakeven' : t.kind === 'stop' ? 'Set a stop' : t.kind === 'close' ? 'Close position' : 'Profit target';
  const body = document.getElementById('posTradeBody');
  if (!t) { body.innerHTML = ''; return; }
  if (t.error) {
    body.innerHTML = `<p class="trade-warn" role="alert">${esc(t.error)}</p>${t.listing ? schwabList(t) : ''}<div class="trade-actions"><button class="btn" data-action="closeSheet">Close</button></div>`;
    return;
  }
  const row = t.row, held = Math.abs(row.qty), px = p => fmtPositionPrice(p, row.tradeAs);
  const marks = { sending: '…', done: '✓', failed: '✗' };
  const steps = t.steps.map(s => `<li class="pos-step${s.status ? ' ' + s.status : ''}">${s.status ? marks[s.status] + ' ' : ''}${esc(stepText(t, s))}</li>`).join('');
  const duration = (d, label) => `<button class="${t.stopDuration === d ? 'active' : ''}" aria-pressed="${t.stopDuration === d}" data-action="setPositionStopDuration" data-arg="${d}"${t.sent ? ' disabled' : ''}>${label}</button>`;
  // ≥ 0: the rounding is toward the market, and stops already past breakeven stay where they are
  const locked = t.steps.length ? t.locked : (row.qty > 0 ? t.stop - row.avg : row.avg - t.stop) * held * row.mult;
  const rounding = (t.stop === row.avg ? 'Exactly your average cost' : `Rounded from ${px(row.avg)}${row.tradeAs === 'OPTION' ? ': option stops use $0.05 steps under $3 and $0.10 from $3' : ''}`)
    + (t.kept ? `. ${cap(units(row, t.kept))} keep ${t.kept === 1 ? 'its' : 'their'} stop past it` : '')
    + (t.bare ? `. ${cap(units(row, t.bare))} in your limit have no stop` : '');
  const extra = t.kind === 'close' ? (t.planError ? '' : closeEstimate(t))
    : t.kind === 'target' ? targetRows(t, duration)
    : t.kind === 'stop' ? stopRows(t, duration)
    : `<div><dt>Stop lasts</dt><dd><div class="seg" role="group" aria-label="Stop lasts">${duration('DAY', 'Today')}${duration('GOOD_TILL_CANCEL', 'Until canceled')}</div></dd></div>
      <div><dt>Risk at stop</dt><dd><span class="pos-locked">${locked > 0.005 ? '+' + fmt$(locked) + ' locked' : '$0.00'}</span><span class="shares-detail">${rounding}</span></dd></div>`;
  const pairedQty = (t.paired || []).reduce((n, l) => n + l.qty, 0);
  const hint = t.kind === 'close' ? closeHint(t)
    : t.kind === 'target' ? targetHint(t)
    : t.kind === 'stop' && t.planError ? ''
    : `${pairedQty
      ? `Schwab won't take orders to ${INSTRUCTION_WORDS[row.qty > 0 ? (row.tradeAs === 'OPTION' ? 'SELL_TO_CLOSE' : 'SELL') : (row.tradeAs === 'OPTION' ? 'BUY_TO_CLOSE' : 'BUY_TO_COVER')]} more than you hold, so shares in a limit get their stop paired with it, and the rest get one stop. While ${t.paired.length === 1 ? 'the limit is' : 'the limits are'} placed again, ${units(row, pairedQty)} ${have(pairedQty)} no stop for a moment.`
      : t.steps.some(s => s.kind !== 'place') ? 'Other stops are cancelled first, then Schwab swaps the nearest one for the new stop.' : ''}${t.kept ? (t.kind === 'stop' ? ' Tighter stops stay where they are.' : ' Stops already past breakeven stay where they are.') : ''} A triggered stop becomes a market order and can fill past it.`.trim();
  const closeWords = () => `${cap(INSTRUCTION_WORDS[closingInstruction(row.tradeAs, row.qty > 0)])} ${(t.close.qty || 0).toLocaleString('en-US')} ${row.label}`
    + (t.close.type === 'LIMIT' ? `, limit ${px(t.planError ? t.close.price : t.price)}` : ' at market');
  const confirm = t.kind === 'close' ? closeWords() : t.kind === 'target' ? `Place target ${px(t.price)}` : t.planError ? 'Set stop' : `Set stop ${px(t.stop)}`;
  const orders = t.steps.map(s => s.kind === 'cancel' ? { cancel: s.orderId } : s.kind === 'replace' ? { replace: s.orderId, with: s.order } : { place: s.order });
  const settled = t.sent && !state.posTradeBusy;
  const blocked = (t.choose && !t.mode) || !!t.planError;
  const willSend = t.planError ? `<p class="trade-warn">${esc(t.planError)}</p>`
    : steps ? `<ol class="pos-steps">${steps}</ol>` : '<span class="shares-detail">Pick what the stop covers first.</span>';
  // a stop at your price asks what it covers below its input, since the choices change with the price
  const choice = t.choose ? choicePrompt(t) : '';
  const detail = `
    ${t.notice ? `<p class="trade-warn" role="alert">${esc(t.notice)}</p>` : ''}
    <dl class="trade-legs">
      ${t.kind === 'stop' ? choice : ''}
      <div><dt>${t.sent ? 'Sent' : 'Will send'}</dt><dd>${willSend}</dd></div>
      ${extra}
    </dl>
    ${t.warnings.map(w => `<p class="trade-warn">${esc(w)}</p>`).join('')}
    ${hint ? `<p class="hint">${esc(hint)}</p>` : ''}
    <details class="hint-details"><summary>Orders sent to Schwab</summary><pre class="trade-json">${esc(JSON.stringify(orders, null, 2))}</pre></details>
    <div class="trade-actions">
      <button class="btn" data-action="closeSheet">${t.sent ? 'Done' : 'Cancel'}</button>
      ${t.sent ? '' : `<button class="btn trade-confirm" data-action="placePositionTrade"${state.posTradeBusy || blocked ? ' disabled' : ''}>${esc(confirm)}</button>`}
    </div>
    <p class="trade-result${settled ? (t.failure ? ' bad' : t.confirmed ? ' ok' : '') : ''}" role="status">${esc(t.checking ? 'Checking Schwab…' : [t.failure, t.done].filter(Boolean).join(' '))}</p>
    ${settled && (t.failure || !t.confirmed) ? schwabList(t) : ''}`;
  // typing in the close or stop ticket redraws only what follows the inputs
  if (!form && (t.kind === 'close' || t.kind === 'stop')) { document.getElementById('posTradeDetail').innerHTML = detail; return; }
  body.innerHTML = `
    <dl class="trade-legs">
      <div><dt>Position</dt><dd><strong>${row.qty > 0 ? 'Long' : 'Short'} ${units(row, held)} ${esc(row.label)}</strong><span class="shares-detail">Average cost ${px(row.avg)} · now ${px(row.price)}</span></dd></div>
      ${t.kind === 'breakeven' ? choice : ''}
      ${t.kind === 'close' ? closeForm(t, duration) : t.kind === 'stop' ? stopForm(t) : ''}
    </dl>
    <div id="posTradeDetail">${detail}</div>`;
}
