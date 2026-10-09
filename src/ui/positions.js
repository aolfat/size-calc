// Positions: the selected Schwab account's holdings, read live every 30s while the tab is open, with stops from its working stop orders,
// buttons into a stock's chart and targets (position-chart.js) and the breakeven-stop and close reviews (position-trade.js),
// and every order still working in the account.
import { state } from '../state.js';
import { fmt$, marketEscape as esc } from '../core/format.js';
import { INSTRUCTION_WORDS, fmtPositionPrice, orderTypeWord, positionRows, schwabTime, workingOrders } from '../core/positions.js';
import { schwabAccount, schwabConnected, schwabPositions, schwabRecentOrders } from '../services/schwab.js';
import { showToast } from './feedback.js';
import { renderPositionChart } from './position-chart.js';

const POLL_MS = 30000;
const money = v => (v < 0 ? '−' : '') + fmt$(Math.abs(v));
const count = q => (q < 0 ? '−' : '') + Math.abs(q).toLocaleString('en-US');
const words = s => String(s || '').toLowerCase().replace(/_/g, ' ');
const DURATION_WORDS = { DAY: 'Today', GOOD_TILL_CANCEL: 'Until canceled', FILL_OR_KILL: 'Fill or kill', IMMEDIATE_OR_CANCEL: 'Immediate or cancel' };
const STATUS_WORDS = { AWAITING_PARENT_ORDER: 'waiting on entry', PENDING_ACTIVATION: 'pending', AWAITING_RELEASE_TIME: 'waiting on release' };

/** read the account now; asked = a tap on Refresh (or r), which confirms when it lands; the 30s timer stays quiet */
export async function refreshPositions(asked = false) {
  stopPositions();
  const id = ++state.positionsRequest;
  const acct = schwabConnected() ? schwabAccount() : null;
  if (!acct) { state.positions = null; state.positionsBusy = false; renderPositions(); return; }
  state.positionsBusy = true;
  renderPositions();
  try {
    // stops are extra: positions still show when the orders read fails
    const [account, orders] = await Promise.all([schwabPositions(), schwabRecentOrders().catch(() => null)]);
    if (id !== state.positionsRequest) return;
    state.positions = { ...positionRows(account, orders || []), orders: orders || [], last4: acct.last4, asOf: Date.now(), stopsMissing: !orders };
    state.positionsError = '';
    if (asked) showToast(`Positions refreshed at ${new Date(state.positions.asOf).toLocaleTimeString()}.`);
  } catch(e) {
    if (id !== state.positionsRequest) return;
    state.positionsError = e instanceof TypeError ? 'Could not reach the Schwab worker. Check its URL in Settings.' : e.message;
    if (!schwabConnected()) state.positions = null; // the login ended
  } finally {
    if (id === state.positionsRequest) { state.positionsBusy = false; renderPositions(); schedulePositions(); }
  }
}

export function schedulePositions() {
  stopPositions();
  if (state.positionsView && !document.hidden && schwabConnected()) state.positionsTimer = setTimeout(() => refreshPositions(), POLL_MS);
}

export function stopPositions() {
  clearTimeout(state.positionsTimer);
  state.positionsTimer = null;
}

export function positionsVisibilityChanged() {
  if (state.positionsView && !document.hidden) refreshPositions(); else stopPositions();
}

/** a login, logout or account switch: the old account's table goes, and the tab reloads if it's open */
export function positionsAccountChanged() {
  state.positions = null;
  state.posChart = null;
  state.positionsError = '';
  if (state.positionsView) { refreshPositions(); return; }
  state.positionsRequest++;
  state.positionsBusy = false;
  renderPositions();
}

function riskCell(r) {
  if (r.risk === null) return '—';
  const held = Math.abs(r.qty);
  const partial = r.covered < held ? `<span class="pos-sub pos-partial">covers ${r.covered.toLocaleString('en-US')} of ${held.toLocaleString('en-US')}</span>` : '';
  if (Math.abs(r.risk) < 0.005) return `<span class="pos-locked">$0.00</span><span class="pos-sub">at breakeven</span>${partial}`;
  return r.risk > 0
    ? `<span class="pos-loss">−${fmt$(r.risk)}</span><span class="pos-sub">${r.riskPct.toFixed(2)}% of acct</span>${partial}`
    : `<span class="pos-locked">+${fmt$(-r.risk)} locked</span>${partial}`;
}

// Chart, BE stop and Close sit under the symbol, in the pinned column, so phones see them without scrolling
function tradeButtons(r) {
  if (!r.tradeAs) return '';
  const atBe = r.be !== null && r.stops > 0 && r.stopOrders.every(s => s.stop === r.be) && r.covered >= Math.abs(r.qty);
  const arg = esc(r.symbol);
  const charted = !!state.posChart && state.posChart.symbol === r.symbol;
  const chart = r.tradeAs === 'EQUITY' ? `<button class="pos-act${charted ? ' active' : ''}" aria-pressed="${charted}" data-action="togglePositionChart" data-arg="${arg}" title="Daily chart with your cost, stops and targets: set a profit target on it">Chart</button>` : '';
  return `<span class="pos-acts">${chart}${atBe ? '<span class="pos-locked">stop at breakeven</span>' : `<button class="pos-act" data-action="openPositionTrade" data-arg="${arg}" data-arg2="breakeven" title="Move the stop to your average cost">BE stop</button>`}<button class="pos-act" data-action="openPositionTrade" data-arg="${arg}" data-arg2="close" title="Close the whole position at market">Close</button></span>`;
}

function positionRow(r) {
  return `<tr>
    <td><b>${esc(r.label)}</b>${tradeButtons(r)}</td>
    <td>${count(r.qty)}</td>
    <td>${r.avg > 0 ? fmt$(r.avg) : '—'}</td>
    <td>${fmt$(r.price)}</td>
    <td>${money(r.value)}</td>
    <td>${r.pctAcct.toFixed(2)}%</td>
    <td>${r.stop === null ? '—' : fmt$(r.stop) + (r.stops > 1 ? `<span class="pos-sub">+${r.stops - 1} more</span>` : '')}</td>
    <td>${riskCell(r)}</td>
  </tr>`;
}

export function renderPositions() {
  renderPositionsTable();
  renderPositionChart(); // its lines, sizes and target checks follow each read
}

function renderPositionsTable() {
  const el = document.getElementById('positionsSection');
  const p = state.positions;
  document.getElementById('posCount').textContent = p && p.rows.length ? String(p.rows.length) : '';
  const refresh = `<button class="btn" data-action="refreshPositions"${state.positionsBusy ? ' disabled' : ''} title="Read positions from Schwab now (r)">${state.positionsBusy ? '<span class="spinner" style="width:12px;height:12px;"></span> Refreshing…' : '↻ Refresh'}</button>`;
  if (!p) {
    el.innerHTML = !schwabConnected()
      ? `<div class="card empty-card"><div class="setup-title">Connect Schwab to see your positions</div><p>${state.positionsError ? esc(state.positionsError) : 'Positions come live from your Schwab account. Log in under Settings, Schwab trading.'}</p><button class="btn primary" data-action="openSheet" data-arg="settings">Open settings</button></div>`
      : `<div class="card empty-card"><div class="setup-title">${state.positionsBusy ? '<span class="spinner" style="vertical-align:middle;margin-right:8px;"></span>Loading positions…' : 'Positions'}</div>${state.positionsError ? `<p class="shares-error" role="status">${esc(state.positionsError)}</p>` : ''}${refresh}</div>`;
    return;
  }
  // a 30s refresh must not jump a phone's sideways scroll back
  const scrolled = [...el.querySelectorAll('.positions-wrap')].map(w => w.scrollLeft);
  const asOf = new Date(p.asOf).toLocaleTimeString();
  el.innerHTML = `<div class="card positions-card">
    <div class="positions-head">
      <span class="section-title">Schwab ••${esc(p.last4)}</span>
      <span class="positions-meta">Account value ${fmt$(p.value)} · cash ${money(p.cash)} · as of ${asOf}</span>
      ${refresh}
    </div>
    ${state.positionsError ? `<p class="shares-error" role="status">Refresh failed: ${esc(state.positionsError)} Showing ${asOf}.</p>` : ''}
    ${p.stopsMissing ? '<p class="hint">Stops unavailable: Schwab did not return this account\'s orders.</p>' : ''}
    ${p.rows.length ? `<div class="positions-wrap"><table class="positions-table">
      <thead><tr><th scope="col">Symbol</th><th scope="col">Qty</th><th scope="col">Avg cost</th><th scope="col">Price</th><th scope="col">Market value</th><th scope="col">% of acct</th><th scope="col">Stop</th><th scope="col">Risk @ stop</th></tr></thead>
      <tbody>${p.rows.map(positionRow).join('')}</tbody>
      <tfoot><tr><th scope="row">Total</th><td></td><td></td><td></td><td>${money(p.total)}</td><td>${p.totalPct.toFixed(2)}%</td><td></td><td>${p.risk > 0 ? `<span class="pos-loss">−${fmt$(p.risk)}</span><span class="pos-sub">${p.riskPct.toFixed(2)}% of acct</span>` : '—'}</td></tr></tfoot>
    </table></div>
    <p class="hint">Stop is the nearest working stop order that closes the position, from the last 59 days of orders. Risk @ stop is the loss if it fills, measured from your average cost.</p>` : '<p class="hint">No open positions in this account.</p>'}
  </div>
  ${ordersCard(p)}`;
  el.querySelectorAll('.positions-wrap').forEach((w, i) => { w.scrollLeft = scrolled[i] || 0; });
}

const orderPx = (o, v) => fmtPositionPrice(v, o.assetType === 'OPTION' ? 'OPTION' : null);

/** the price an order works at, as plain words: stop, limit, the stop of a stop limit, the trail of a trailing stop */
function priceText(o) {
  if (o.trail) return 'trail ' + o.trail;
  if (o.stop !== null) return orderPx(o, o.stop) + (o.price !== null ? ' stop' : '');
  if (o.price !== null) return orderPx(o, o.price);
  return o.orderType === 'MARKET' ? 'market' : '—';
}

/** the price cell: a stop limit's limit and a trailing stop's current stop go underneath */
function orderPrice(o) {
  const under = o.trail && o.stop !== null ? `now ${orderPx(o, o.stop)}` : !o.trail && o.stop !== null && o.price !== null ? `${orderPx(o, o.price)} limit` : '';
  return esc(priceText(o)) + (under ? `<span class="pos-sub">${esc(under)}</span>` : '');
}

const orderWords = o => o.legs > 1 ? `${o.legs}-leg ${orderTypeWord(o.orderType)}` : `${INSTRUCTION_WORDS[o.instruction] || words(o.instruction)} ${orderTypeWord(o.orderType)}`;

/** when it went in: the time today, else the date */
function placed(entered) {
  const t = schwabTime(entered);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t), now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : `${d.getMonth() + 1}/${d.getDate()}`;
}

function orderRow(o, list) {
  const partner = o.oco !== null ? list.find(x => x.oco === o.oco && x !== o) : null;
  const note = partner ? `one cancels the other with the ${orderTypeWord(partner.orderType)} ${priceText(partner)}`
    : o.parent ? `after the ${INSTRUCTION_WORDS[o.parent] || words(o.parent)} fills` : '';
  const what = orderWords(o);
  const left = o.qty - o.filled;
  const lasts = (DURATION_WORDS[o.duration] || words(o.duration) || '—') + (o.session && o.session !== 'NORMAL' ? '<span class="pos-sub">extended hours</span>' : '');
  return `<tr${o.oco !== null ? ' class="pos-oco"' : ''}>
    <td><b>${esc(o.label)}</b></td>
    <td class="pos-order">${esc(what.charAt(0).toUpperCase() + what.slice(1))}${note ? `<span class="pos-sub">${esc(note)}</span>` : ''}</td>
    <td>${orderPrice(o)}</td>
    <td>${o.filled > 0 ? `${left.toLocaleString('en-US')}<span class="pos-sub">of ${o.qty.toLocaleString('en-US')}, ${o.filled.toLocaleString('en-US')} filled</span>` : o.qty.toLocaleString('en-US')}</td>
    <td>${lasts}</td>
    <td>${esc(STATUS_WORDS[o.status] || words(o.status))}</td>
    <td>${placed(o.entered)}</td>
  </tr>`;
}

/** every order still working in the account, entries included; a pair's legs sit together and name each other */
function ordersCard(p) {
  const head = n => `<div class="positions-head"><span class="section-title">Working orders</span>${n === null ? '' : `<span class="positions-meta">${n ? n.toLocaleString('en-US') : 'None'}</span>`}</div>`;
  if (p.stopsMissing) return `<div class="card positions-card orders-card">${head(null)}<p class="hint">Orders unavailable: Schwab did not return this account's orders.</p></div>`;
  const list = workingOrders(p.orders);
  return `<div class="card positions-card orders-card">${head(list.length)}
    ${list.length ? `<div class="positions-wrap"><table class="positions-table orders-table">
      <thead><tr><th scope="col">Symbol</th><th scope="col">Order</th><th scope="col">Price</th><th scope="col">Qty</th><th scope="col">Lasts</th><th scope="col">Status</th><th scope="col">Placed</th></tr></thead>
      <tbody>${list.map(o => orderRow(o, list)).join('')}</tbody>
    </table></div>` : ''}
    <p class="hint">${list.length ? 'From the last 59 days of orders: one placed before that doesn\'t show here.' : 'Nothing working in the last 59 days of orders.'}</p>
  </div>`;
}
