// Position trades: a breakeven stop or a market close for one Schwab position, reviewed in a sheet and sent once.
// Steps run in order and stop at the first failure; nothing retries. Schwab is re-read afterwards to say what it now shows,
// and until it shows the last result, that symbol takes no new order from here.
import { state } from '../state.js';
import { fmt$, marketEscape as esc } from '../core/format.js';
import { inRegularHours } from '../core/orders.js';
import { INSTRUCTION_WORDS, breakevenPlan, closePlan, fmtPositionPrice, orderGone, orderTypeWord, ordersFor } from '../core/positions.js';
import { store } from '../lib/store.js';
import { schwabAccount, schwabCancelOrder, schwabConnected, schwabOrder, schwabPlaceOrder, schwabReplaceOrder, schwabStopDuration } from '../services/schwab.js';
import { showError, showToast } from './feedback.js';
import { refreshPositions } from './positions.js';
import { openSheet } from './sheets.js';

const UNCONFIRMED_WAIT = 120000;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const units = (row, n) => `${n.toLocaleString('en-US')} ${row.tradeAs === 'OPTION' ? (n === 1 ? 'contract' : 'contracts') : (n === 1 ? 'share' : 'shares')}`;
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
  if (t.kind === 'close') return `${cap(INSTRUCTION_WORDS[leg.instruction])} ${units(row, leg.quantity)} ${row.label} at market`;
  const next = `stop ${fmtPositionPrice(step.order.stopPrice, row.tradeAs)} for ${units(row, leg.quantity)}`;
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

/** the frozen ticket for one position: its plan, and what could go wrong spelled out */
export function buildPositionTicket(row, kind, symbol, now = Date.now()) {
  const t = { kind, symbol, row: row || null, error: '', listing: false, stop: 0, steps: [], paired: [], rest: 0, bare: 0, choose: false, mode: null, options: null,
    stopDuration: schwabStopDuration(), warnings: [], sent: false, failure: '', done: '', confirmed: false };
  if (!row) { t.error = `Schwab no longer shows a ${symbol} position.`; return t; }
  if (state.positions && state.positions.stopsMissing) {
    t.error = 'Schwab did not return the orders on this account, so there is no telling what already covers the position. Try again in a moment.';
    return t;
  }
  const last = state.posLast;
  if (last && last.symbol === row.symbol && !last.confirmed && now - last.at < UNCONFIRMED_WAIT) {
    t.error = `Your last order on ${row.label} has not shown up at Schwab yet. Check Schwab's order list before sending another.`;
    t.listing = true;
    return t;
  }
  if (kind === 'close') Object.assign(t, closePlan(row)); else planBreakeven(t);
  if (t.error) return t;
  t.warnings = buildWarnings(t, now);
  return t;
}

// a limit in the way of a breakeven stop: ask whether to stop only the rest or pair the limit, and send nothing until answered
function planBreakeven(t) {
  const pair = breakevenPlan(t.row, t.stopDuration, { pair: true });
  t.choose = !pair.error && pair.paired.length > 0;
  t.options = t.choose ? { pair, only: breakevenPlan(t.row, t.stopDuration, { pair: false }) } : null;
  if (t.mode && t.options && t.options[t.mode].error) t.mode = null;
  Object.assign(t, !t.choose ? pair : t.mode ? t.options[t.mode] : { error: '', stop: pair.stop, steps: [], paired: [], rest: 0, bare: 0 });
}

export function setPositionBeMode(mode) {
  const t = state.posTicket;
  if (!t || !t.choose || t.sent || (mode !== 'only' && mode !== 'pair') || t.options[mode].error) return;
  t.mode = mode;
  planBreakeven(t);
  t.warnings = buildWarnings(t, Date.now());
  renderPositionTradeSheet();
}

function buildWarnings(t, now) {
  const row = t.row, out = [];
  if (!inRegularHours(now)) out.push(t.kind === 'close' ? 'Outside regular hours. A market order waits for the next open and can fill far from here.' : 'Outside regular hours. The stop starts working at the next open.');
  if (row.tradeAs === 'OPTION') out.push(t.kind === 'close' ? 'A market order on an option can fill far from the mark.' : 'An option stop triggers on the option\'s own price, which jumps with its spread.');
  out.push(...pairingWarnings(t));
  const last = state.tradeLast;
  if (last && last.symbol === row.symbol && now - last.at < UNCONFIRMED_WAIT) out.push(`You sent a ${row.label} order ${Math.round((now - last.at) / 1000)}s ago.`);
  return out;
}

export async function openPositionTrade(symbol, kind) {
  if (state.posTradeBusy) return;
  if (!schwabConnected()) { showError('Connect Schwab in Settings first.'); openSheet('settings'); return; }
  state.posTradeBusy = true;
  try { await refreshPositions(); } finally { state.posTradeBusy = false; } // the plan is built from what Schwab shows now
  if (state.positionsError || !state.positions) {
    state.posTicket = buildPositionTicket(null, kind, symbol);
    state.posTicket.error = 'Could not re-read the position from Schwab. ' + state.positionsError;
  } else state.posTicket = buildPositionTicket(state.positions.rows.find(r => r.symbol === symbol), kind, symbol);
  renderPositionTradeSheet();
  openSheet('posTrade');
}

export function setPositionStopDuration(d) {
  const t = state.posTicket;
  if (!t || t.kind !== 'breakeven' || t.error || t.sent || (d !== 'DAY' && d !== 'GOOD_TILL_CANCEL')) return;
  store.set('schwab_stop_duration', d);
  t.stopDuration = d;
  planBreakeven(t);
  t.warnings = buildWarnings(t, Date.now());
  renderPositionTradeSheet();
}

/** a cancel Schwab refused: fine if the order is already on its way out (its pair took it), a stop if it filled */
async function cancelStep(t, step) {
  try { await schwabCancelOrder(step.orderId); }
  catch(e) {
    if (e instanceof TypeError || !e.status) throw e;
    const o = await schwabOrder(step.orderId).catch(() => null);
    if (o && o.status === 'FILLED') throw new Error(`Schwab filled the ${orderWord(t.row, step.was)} for ${units(t.row, step.was.qty)} while this ran. Nothing more was sent.`);
    if (!o || !orderGone(o.status || '')) throw e;
    step.note = 'already cancelled';
  }
}

export async function placePositionTrade() {
  const t = state.posTicket;
  if (!t || t.error || t.sent || state.posTradeBusy || (t.choose && !t.mode)) return;
  t.sent = true; // one review, one run: no step is sent twice, and nothing retries
  state.posTradeBusy = true;
  try {
    for (const step of t.steps) {
      step.status = 'sending';
      renderPositionTradeSheet();
      try {
        if (step.kind === 'cancel') await cancelStep(t, step);
        else if (step.kind === 'replace') step.newId = (await schwabReplaceOrder(step.orderId, step.order)).orderId;
        else step.newId = (await schwabPlaceOrder(step.order)).orderId;
        step.status = 'done';
      } catch(e) {
        step.status = 'failed';
        t.failure = e instanceof TypeError ? 'No answer from Schwab. Check your Schwab orders before trying again.' : e.status ? 'Schwab refused it. ' + e.message : e.message;
        break;
      }
    }
    state.tradeLast = { symbol: t.row.symbol, at: Date.now() };
    await refreshPositions(); // what Schwab shows now, not what the answers implied
    Object.assign(t, outcome(t));
    state.posLast = { symbol: t.row.symbol, at: Date.now(), confirmed: t.confirmed };
  } finally {
    state.posTradeBusy = false;
    if (state.posTicket === t) renderPositionTradeSheet();
  }
  if (t.confirmed) showToast(t.done);
}

function outcome(t) {
  if (state.positionsError || !state.positions) return { done: 'Could not re-read Schwab. Check your Schwab orders.', confirmed: false };
  const row = state.positions.rows.find(r => r.symbol === t.row.symbol);
  if (!row) return { done: `Schwab no longer shows the ${t.row.label} position.`, confirmed: t.kind === 'close' && !t.failure };
  const held = Math.abs(row.qty), bare = held - row.covered;
  const exposed = bare > 0 ? ` ${cap(units(row, bare))} ${bare === 1 ? 'has' : 'have'} no stop now.` : '';
  // a limit cancelled to be paired, whose pair never went out
  const lost = t.steps.filter(s => s.kind === 'cancel' && s.pairs === s.was && s.status === 'done'
    && !t.steps.some(p => p.kind === 'place' && p.pairs === s.was && p.status === 'done'))
    .map(s => ` Your ${orderWord(row, s.was)} for ${units(row, s.was.qty)} was cancelled and not placed again.`).join('');
  if (t.kind === 'close') return { done: (`Schwab still shows ${units(row, held)} ${row.label}.${t.failure ? '' : ' A market order can take a moment to fill.'}` + exposed + lost).trim(), confirmed: false };
  if (t.mode === 'only') {
    const plain = row.stopOrders.filter(s => s.oco === null);
    if (!t.failure && plain.length && plain.every(s => s.stop === t.stop) && plain.reduce((n, s) => n + s.qty, 0) >= t.rest) {
      return { done: `Schwab now shows a stop at ${fmtPositionPrice(t.stop, row.tradeAs)} for ${units(row, t.rest)}.${t.bare ? ` Your limit keeps ${units(row, t.bare)} without a stop.` : ''}`, confirmed: true };
    }
  }
  const atBe = row.stopOrders.length > 0 && row.stopOrders.every(s => s.stop === t.stop) && row.covered >= held;
  if (atBe && !t.failure) {
    const px = fmtPositionPrice(t.stop, row.tradeAs);
    return { done: row.stopOrders.length === 1 ? `Schwab now shows a stop at ${px} for ${units(row, held)}.` : `Schwab now shows stops at ${px} for all ${units(row, held)}.`, confirmed: true };
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

/** the question a limit in the way raises: stop only the rest, or pair the limit with a stop too */
function choicePrompt(t) {
  const row = t.row, px = p => fmtPositionPrice(p, row.tradeAs);
  const limits = t.options.pair.paired, many = limits.length > 1;
  const inLimit = limits.reduce((n, l) => n + l.qty, 0);
  const verb = row.qty > 0 ? (many ? 'sell' : 'sells') : (many ? 'buy back' : 'buys back');
  const what = many ? `Your limits for ${units(row, inLimit)} already ${verb}` : `Your limit ${px(limits[0].price)} for ${units(row, inLimit)} already ${verb}`;
  const only = t.options.only;
  const onlySub = only.error || `Breakeven stop for the ${units(row, only.rest)} outside the ${many ? 'limits' : 'limit'}. ${many ? 'The limits stay as they are' : 'The limit stays as it is'}${only.bare ? `; ${many ? 'their' : 'its'} ${units(row, only.bare)} have no stop.` : ', with its own stop where it is.'}`;
  const opt = (mode, title, sub, off) => `<button class="pos-choice-opt${t.mode === mode ? ' active' : ''}" aria-pressed="${t.mode === mode}" data-action="setPositionBeMode" data-arg="${mode}"${off || t.sent ? ' disabled' : ''}><strong>${title}</strong><span>${esc(sub)}</span></button>`;
  return `<div><dt>Stop covers</dt><dd><span class="shares-detail">${esc(what)} part of this position. Schwab won't take a stop for the same shares too.</span>
    <div class="pos-choice" role="group" aria-label="What the breakeven stop covers">
      ${opt('only', 'Stop the rest', onlySub, !!only.error)}
      ${opt('pair', 'Pair with the limit', `Every share gets a breakeven stop. The ${many ? 'limits are' : 'limit is'} cancelled and placed again with ${many ? 'their' : 'its'} own stop.`, false)}
    </div></dd></div>`;
}

export function renderPositionTradeSheet() {
  const t = state.posTicket;
  const acct = schwabAccount();
  document.getElementById('posTradeAccount').textContent = acct ? 'Account ••' + acct.last4 : '';
  document.getElementById('posTradeTitle').textContent = t && t.kind === 'close' ? 'Close position' : 'Stop at breakeven';
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
  const locked = (row.qty > 0 ? t.stop - row.avg : row.avg - t.stop) * held * row.mult; // ≥ 0: the rounding is toward the market
  const rounding = (t.stop === row.avg ? 'Exactly your average cost' : `Rounded from ${px(row.avg)}${row.tradeAs === 'OPTION' ? ': option stops use $0.05 steps under $3 and $0.10 from $3' : ''}`)
    + (t.bare ? `. ${cap(units(row, t.bare))} in your limit have no stop` : '');
  const extra = t.kind === 'close'
    ? `<div><dt>Value</dt><dd>${fmt$(Math.abs(row.value))}<span class="shares-detail">At Schwab's mark, before the fill</span></dd></div>`
    : `<div><dt>Stop lasts</dt><dd><div class="seg" role="group" aria-label="Stop lasts">${duration('DAY', 'Today')}${duration('GOOD_TILL_CANCEL', 'Until canceled')}</div></dd></div>
      <div><dt>Risk at stop</dt><dd><span class="pos-locked">${locked > 0.005 ? '+' + fmt$(locked) + ' locked' : '$0.00'}</span><span class="shares-detail">${rounding}</span></dd></div>`;
  const pairedQty = (t.paired || []).reduce((n, l) => n + l.qty, 0);
  const hint = t.kind === 'close'
    ? 'Orders that would close it are cancelled first, so nothing sells twice. If a cancel fails, the close is not sent.'
    : `${pairedQty
      ? `Schwab won't take orders to ${INSTRUCTION_WORDS[row.qty > 0 ? (row.tradeAs === 'OPTION' ? 'SELL_TO_CLOSE' : 'SELL') : (row.tradeAs === 'OPTION' ? 'BUY_TO_CLOSE' : 'BUY_TO_COVER')]} more than you hold, so shares in a limit get their stop paired with it, and the rest get one stop. While ${t.paired.length === 1 ? 'the limit is' : 'the limits are'} placed again, ${units(row, pairedQty)} have no stop for a moment.`
      : 'Other stops are cancelled first, then Schwab swaps the nearest one for the new stop.'} A triggered stop becomes a market order and can fill past it.`;
  const confirm = t.kind === 'close' ? `Close ${units(row, held)} ${row.label}` : `Set stop ${px(t.stop)}`;
  const orders = t.steps.map(s => s.kind === 'cancel' ? { cancel: s.orderId } : s.kind === 'replace' ? { replace: s.orderId, with: s.order } : { place: s.order });
  const settled = t.sent && !state.posTradeBusy;
  const waiting = t.choose && !t.mode;
  body.innerHTML = `
    <dl class="trade-legs">
      <div><dt>Position</dt><dd><strong>${row.qty > 0 ? 'Long' : 'Short'} ${units(row, held)} ${esc(row.label)}</strong><span class="shares-detail">Average cost ${px(row.avg)} · now ${px(row.price)}</span></dd></div>
      ${t.choose ? choicePrompt(t) : ''}
      <div><dt>${t.sent ? 'Sent' : 'Will send'}</dt><dd>${steps ? `<ol class="pos-steps">${steps}</ol>` : '<span class="shares-detail">Pick what the stop covers first.</span>'}</dd></div>
      ${extra}
    </dl>
    ${t.warnings.map(w => `<p class="trade-warn">${esc(w)}</p>`).join('')}
    <p class="hint">${esc(hint)}</p>
    <details class="hint-details"><summary>Orders sent to Schwab</summary><pre class="trade-json">${esc(JSON.stringify(orders, null, 2))}</pre></details>
    <div class="trade-actions">
      <button class="btn" data-action="closeSheet">${t.sent ? 'Done' : 'Cancel'}</button>
      ${t.sent ? '' : `<button class="btn trade-confirm" data-action="placePositionTrade"${state.posTradeBusy || waiting ? ' disabled' : ''}>${esc(confirm)}</button>`}
    </div>
    <p class="trade-result${settled ? (t.failure ? ' bad' : t.confirmed ? ' ok' : '') : ''}" role="status">${esc([t.failure, t.done].filter(Boolean).join(' '))}</p>
    ${settled && (t.failure || !t.confirmed) ? schwabList(t) : ''}`;
}
