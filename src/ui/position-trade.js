// Position trades: a breakeven stop or a market close for one Schwab position, reviewed in a sheet and sent once.
// Steps run in order and stop at the first failure; nothing retries. Schwab is re-read afterwards to say what it now shows.
import { state } from '../state.js';
import { fmt$, marketEscape as esc } from '../core/format.js';
import { inRegularHours } from '../core/orders.js';
import { INSTRUCTION_WORDS, breakevenPlan, closePlan, fmtPositionPrice } from '../core/positions.js';
import { store } from '../lib/store.js';
import { schwabAccount, schwabCancelOrder, schwabConnected, schwabPlaceOrder, schwabReplaceOrder, schwabStopDuration } from '../services/schwab.js';
import { showError, showToast } from './feedback.js';
import { refreshPositions } from './positions.js';
import { openSheet } from './sheets.js';

const ORDER_WORDS = { STOP: 'stop', STOP_LIMIT: 'stop limit', LIMIT: 'limit', TRAILING_STOP: 'trailing stop', TRAILING_STOP_LIMIT: 'trailing stop limit', MARKET: 'market order' };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const units = (row, n) => `${n.toLocaleString('en-US')} ${row.tradeAs === 'OPTION' ? (n === 1 ? 'contract' : 'contracts') : (n === 1 ? 'share' : 'shares')}`;

function orderWord(row, was) {
  const px = was.stop ?? was.price;
  return (ORDER_WORDS[was.orderType] || was.orderType.toLowerCase().replace(/_/g, ' ')) + (px === null ? '' : ' ' + fmtPositionPrice(px, row.tradeAs));
}

function stepText(t, step) {
  const row = t.row;
  if (step.kind === 'cancel') return `Cancel ${orderWord(row, step.was)} for ${units(row, step.was.qty)}`;
  const leg = step.order.orderLegCollection[0];
  if (t.kind === 'close') return `${cap(INSTRUCTION_WORDS[leg.instruction])} ${units(row, leg.quantity)} ${row.label} at market`;
  const next = `stop ${fmtPositionPrice(step.order.stopPrice, row.tradeAs)} for ${units(row, leg.quantity)}`;
  return step.kind === 'replace' ? `Replace ${orderWord(row, step.was)} for ${units(row, step.was.qty)} with ${next}` : `Place a ${next} (${INSTRUCTION_WORDS[leg.instruction]})`;
}

/** the frozen ticket for one position: its plan, and what could go wrong spelled out */
export function buildPositionTicket(row, kind, symbol, now = Date.now()) {
  const t = { kind, symbol, row: row || null, error: '', stop: 0, steps: [], stopDuration: schwabStopDuration(), warnings: [], sent: false, failure: '', done: '' };
  if (!row) { t.error = `Schwab no longer shows a ${symbol} position.`; return t; }
  Object.assign(t, kind === 'close' ? closePlan(row) : breakevenPlan(row, t.stopDuration));
  if (t.error) return t;
  if (!inRegularHours(now)) t.warnings.push(kind === 'close' ? 'Outside regular hours. A market order waits for the next open and can fill far from here.' : 'Outside regular hours. The stop starts working at the next open.');
  if (row.tradeAs === 'OPTION') t.warnings.push(kind === 'close' ? 'A market order on an option can fill far from the mark.' : 'An option stop triggers on the option\'s own price, which jumps with its spread.');
  const last = state.tradeLast;
  if (last && last.symbol === row.symbol && now - last.at < 120000) t.warnings.push(`You sent a ${row.label} order ${Math.round((now - last.at) / 1000)}s ago.`);
  return t;
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
  Object.assign(t, breakevenPlan(t.row, d));
  renderPositionTradeSheet();
}

export async function placePositionTrade() {
  const t = state.posTicket;
  if (!t || t.error || t.sent || state.posTradeBusy) return;
  t.sent = true; // one review, one run: no step is sent twice, and nothing retries
  state.posTradeBusy = true;
  try {
    for (const step of t.steps) {
      step.status = 'sending';
      renderPositionTradeSheet();
      try {
        if (step.kind === 'cancel') await schwabCancelOrder(step.orderId);
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
    t.done = outcome(t);
  } finally {
    state.posTradeBusy = false;
    if (state.posTicket === t) renderPositionTradeSheet();
  }
  if (!t.failure) showToast(t.done);
}

function outcome(t) {
  if (state.positionsError || !state.positions) return 'Could not re-read Schwab. Check your Schwab orders.';
  const row = state.positions.rows.find(r => r.symbol === t.row.symbol);
  if (!row) return `Schwab no longer shows the ${t.row.label} position.`;
  const held = Math.abs(row.qty), bare = held - row.covered;
  const exposed = bare > 0 ? ` ${cap(units(row, bare))} ${bare === 1 ? 'has' : 'have'} no stop now.` : '';
  if (t.kind === 'close') return `Schwab still shows ${units(row, held)} ${row.label}.${t.failure ? '' : ' A market order can take a moment to fill.'}${exposed}`;
  if (row.stops === 1 && row.stop === t.stop && row.covered >= held) return `Schwab now shows a stop at ${fmtPositionPrice(t.stop, row.tradeAs)} for ${units(row, held)}.`;
  return ((t.failure ? '' : 'Schwab doesn\'t show the new stop yet. Check Schwab.') + exposed).trim();
}

export function renderPositionTradeSheet() {
  const t = state.posTicket;
  const acct = schwabAccount();
  document.getElementById('posTradeAccount').textContent = acct ? 'Account ••' + acct.last4 : '';
  document.getElementById('posTradeTitle').textContent = t && t.kind === 'close' ? 'Close position' : 'Stop at breakeven';
  const body = document.getElementById('posTradeBody');
  if (!t) { body.innerHTML = ''; return; }
  if (t.error) {
    body.innerHTML = `<p class="trade-warn" role="alert">${esc(t.error)}</p><div class="trade-actions"><button class="btn" data-action="closeSheet">Close</button></div>`;
    return;
  }
  const row = t.row, held = Math.abs(row.qty), px = p => fmtPositionPrice(p, row.tradeAs);
  const marks = { sending: '…', done: '✓', failed: '✗' };
  const steps = t.steps.map(s => `<li class="pos-step${s.status ? ' ' + s.status : ''}">${s.status ? marks[s.status] + ' ' : ''}${esc(stepText(t, s))}</li>`).join('');
  const duration = (d, label) => `<button class="${t.stopDuration === d ? 'active' : ''}" aria-pressed="${t.stopDuration === d}" data-action="setPositionStopDuration" data-arg="${d}"${t.sent ? ' disabled' : ''}>${label}</button>`;
  const locked = (row.qty > 0 ? t.stop - row.avg : row.avg - t.stop) * held * row.mult; // ≥ 0: the rounding is toward the market
  const rounding = t.stop === row.avg ? 'Exactly your average cost' : `Rounded from ${px(row.avg)}${row.tradeAs === 'OPTION' ? ': option stops use $0.05 steps under $3 and $0.10 from $3' : ''}`;
  const extra = t.kind === 'close'
    ? `<div><dt>Value</dt><dd>${fmt$(Math.abs(row.value))}<span class="shares-detail">At Schwab's mark, before the fill</span></dd></div>`
    : `<div><dt>Stop lasts</dt><dd><div class="seg" role="group" aria-label="Stop lasts">${duration('DAY', 'Today')}${duration('GOOD_TILL_CANCEL', 'Until canceled')}</div></dd></div>
      <div><dt>Risk at stop</dt><dd><span class="pos-locked">${locked > 0.005 ? '+' + fmt$(locked) + ' locked' : '$0.00'}</span><span class="shares-detail">${rounding}</span></dd></div>`;
  const confirm = t.kind === 'close' ? `Close ${units(row, held)} ${row.label}` : `Set stop ${px(t.stop)}`;
  const orders = t.steps.map(s => s.kind === 'cancel' ? { cancel: s.orderId } : s.kind === 'replace' ? { replace: s.orderId, with: s.order } : { place: s.order });
  body.innerHTML = `
    <dl class="trade-legs">
      <div><dt>Position</dt><dd><strong>${row.qty > 0 ? 'Long' : 'Short'} ${units(row, held)} ${esc(row.label)}</strong><span class="shares-detail">Average cost ${px(row.avg)} · now ${px(row.price)}</span></dd></div>
      <div><dt>${t.sent ? 'Sent' : 'Will send'}</dt><dd><ol class="pos-steps">${steps}</ol></dd></div>
      ${extra}
    </dl>
    ${t.warnings.map(w => `<p class="trade-warn">${esc(w)}</p>`).join('')}
    <p class="hint">${t.kind === 'close' ? 'Orders that would close it are cancelled first, so nothing sells twice. If a cancel fails, the close is not sent.' : 'Other stops are cancelled first, then Schwab swaps the nearest one for the new stop. A triggered stop becomes a market order and can fill past it.'}</p>
    <details class="hint-details"><summary>Orders sent to Schwab</summary><pre class="trade-json">${esc(JSON.stringify(orders, null, 2))}</pre></details>
    <div class="trade-actions">
      <button class="btn" data-action="closeSheet">${t.sent ? 'Done' : 'Cancel'}</button>
      ${t.sent ? '' : `<button class="btn trade-confirm" data-action="placePositionTrade"${state.posTradeBusy ? ' disabled' : ''}>${esc(confirm)}</button>`}
    </div>
    <p class="trade-result${t.sent && !state.posTradeBusy ? (t.failure ? ' bad' : ' ok') : ''}" role="status">${esc([t.failure, t.done].filter(Boolean).join(' '))}</p>`;
}
