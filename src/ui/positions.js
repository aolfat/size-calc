// Positions: the selected Schwab account's holdings, read live every 30s while the tab is open, with stops from its working stop orders
// and buttons into the breakeven-stop and close reviews (position-trade.js).
import { state } from '../state.js';
import { fmt$, marketEscape as esc } from '../core/format.js';
import { positionRows } from '../core/positions.js';
import { schwabAccount, schwabConnected, schwabPositions, schwabRecentOrders } from '../services/schwab.js';

const POLL_MS = 30000;
const money = v => (v < 0 ? '−' : '') + fmt$(Math.abs(v));
const count = q => (q < 0 ? '−' : '') + Math.abs(q).toLocaleString('en-US');

export async function refreshPositions() {
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
    state.positions = { ...positionRows(account, orders || []), last4: acct.last4, asOf: Date.now(), stopsMissing: !orders };
    state.positionsError = '';
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
  if (state.positionsView && !document.hidden && schwabConnected()) state.positionsTimer = setTimeout(refreshPositions, POLL_MS);
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

// BE stop and Close sit under the symbol, in the pinned column, so phones see them without scrolling
function tradeButtons(r) {
  if (!r.tradeAs) return '';
  const atBe = r.be !== null && r.stops === 1 && r.stop === r.be && r.covered >= Math.abs(r.qty);
  const arg = esc(r.symbol);
  return `<span class="pos-acts">${atBe ? '<span class="pos-locked">stop at breakeven</span>' : `<button class="pos-act" data-action="openPositionTrade" data-arg="${arg}" data-arg2="breakeven" title="Move the stop to your average cost">BE stop</button>`}<button class="pos-act" data-action="openPositionTrade" data-arg="${arg}" data-arg2="close" title="Close the whole position at market">Close</button></span>`;
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
  const el = document.getElementById('positionsSection');
  const p = state.positions;
  document.getElementById('posCount').textContent = p && p.rows.length ? String(p.rows.length) : '';
  const refresh = `<button class="btn" data-action="refreshPositions"${state.positionsBusy ? ' disabled' : ''} title="Read positions from Schwab now (r)">↻ Refresh</button>`;
  if (!p) {
    el.innerHTML = !schwabConnected()
      ? `<div class="card empty-card"><div class="setup-title">Connect Schwab to see your positions</div><p>${state.positionsError ? esc(state.positionsError) : 'Positions come live from your Schwab account. Log in under Settings, Schwab trading.'}</p><button class="btn primary" data-action="openSheet" data-arg="settings">Open settings</button></div>`
      : `<div class="card empty-card"><div class="setup-title">${state.positionsBusy ? '<span class="spinner" style="vertical-align:middle;margin-right:8px;"></span>Loading positions…' : 'Positions'}</div>${state.positionsError ? `<p class="shares-error" role="status">${esc(state.positionsError)}</p>` : ''}${refresh}</div>`;
    return;
  }
  const wrap = el.querySelector('.positions-wrap');
  const scrollLeft = wrap ? wrap.scrollLeft : 0; // a 30s refresh must not jump a phone's sideways scroll back
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
  </div>`;
  const next = el.querySelector('.positions-wrap');
  if (next) next.scrollLeft = scrollLeft;
}
