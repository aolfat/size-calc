// Schwab trading: the connect section in Settings, the shares card's trade button, and the order review sheet.
// The sheet freezes one ticket when it opens, for the account selected then; Place re-checks it against a fresh quote,
// then sends exactly that payload once and never retries it.
import { state } from '../state.js';
import { fmt$, marketEscape as esc } from '../core/format.js';
import { fmtTick, inRegularHours, sharesStopOrder, sharesTicketError, stopTick } from '../core/orders.js';
import { store } from '../lib/store.js';
import { parseSchwabRedirect, proxyOk, schwabAccount, schwabAccounts, schwabConnected, schwabDisconnect, schwabExchangeCode, schwabFetchAccounts, schwabLoginUrl, schwabOrder, schwabPlaceOrder, schwabProxy, schwabSession, schwabStopDuration } from '../services/schwab.js';
import { dailyAccountSize, updateAccountSourceUi } from './account-size.js';
import { showError, showToast } from './feedback.js';
import { positionsAccountChanged } from './positions.js';
import { renderShares, sharesPlan } from './shares.js';
import { openSheet } from './sheets.js';
import { rawStop } from './stops.js';
import { refreshQuote } from './ticker.js';

const TRADE_LABEL = 'Trade at Schwab';
const mask = last4 => '••' + last4;
const unreachable = 'Could not reach the Schwab worker. Check its URL in Settings.';

// ---------- Settings: worker URL, login, account ----------

export function schwabProxyChanged() {
  store.set('schwab_proxy', document.getElementById('schwabProxy').value.trim());
  updateSchwabUi();
}

export function connectSchwab() {
  if (!proxyOk(schwabProxy())) {
    showError('Paste your Schwab worker URL first. It starts with https://');
    document.getElementById('schwabProxy').focus();
    return;
  }
  window.open(schwabLoginUrl(), '_blank', 'noopener');
  setSchwabNote('Log in at Schwab. Then copy the address you land on and paste it here.');
  document.getElementById('schwabRedirect').focus();
}

/** finish a login from the callback address: pasted by hand, or this page's own address when the app is the callback */
export async function finishSchwab(text = document.getElementById('schwabRedirect').value, fromCallback = false) {
  const parsed = parseSchwabRedirect(text);
  if (!parsed) { showError('No login code in that address. Copy the whole address Schwab sent you to.'); return false; }
  const expected = store.get('schwab_oauth_state') || '';
  // a callback page must carry this device's state; a pasted address may come back without one
  const stateBad = fromCallback ? !expected || parsed.state !== expected : !!(parsed.state && expected && parsed.state !== expected);
  if (stateBad) { showError('That login is from another attempt. Log in to Schwab again.'); return false; }
  if (!proxyOk(schwabProxy())) { showError('Paste your Schwab worker URL in Settings first.'); return false; }
  setSchwabNote('Connecting…');
  try {
    await schwabExchangeCode(parsed.code);
  } catch(e) {
    setSchwabNote('');
    showError(e.status ? `Schwab refused the login code. ${e.message} Codes expire in about 30 seconds, so log in again and paste right away.` : unreachable);
    return false;
  }
  store.del('schwab_oauth_state');
  document.getElementById('schwabRedirect').value = '';
  setSchwabNote('');
  const ok = await reloadSchwabAccounts();
  if (ok) showToast(`Schwab connected. Account ${mask(schwabAccount().last4)}.`);
  return ok;
}

export async function reloadSchwabAccounts() {
  try {
    const list = await schwabFetchAccounts();
    if (!list.length) throw new Error('Schwab returned no accounts.');
    return true;
  } catch(e) {
    showError(e instanceof TypeError ? unreachable : 'Could not load your Schwab accounts. ' + e.message);
    return false;
  } finally {
    updateSchwabUi();
    positionsAccountChanged();
    dailyAccountSize();
  }
}

export function schwabAccountChanged() {
  store.set('schwab_account', /** @type {HTMLSelectElement} */ (document.getElementById('schwabAccount')).value);
  updateSchwabUi();
  positionsAccountChanged();
  dailyAccountSize();
}

export function disconnectSchwab() {
  schwabDisconnect();
  updateSchwabUi();
  positionsAccountChanged();
  showToast('Schwab disconnected on this device.');
}

function setSchwabNote(text) {
  const el = document.getElementById('schwabNote');
  el.textContent = text;
  el.style.display = text ? '' : 'none';
}

function loginLeft(ms) {
  const hours = ms / 3600000;
  return hours < 24 ? `login ends in ${Math.max(1, Math.ceil(hours))}h` : `${Math.round(hours / 24)}d left on login`;
}

export function updateSchwabUi() {
  const session = schwabSession();
  const acct = schwabAccount();
  const proxyEl = document.getElementById('schwabProxy');
  if (document.activeElement !== proxyEl) proxyEl.value = store.get('schwab_proxy') || '';
  document.getElementById('schwabLogin').style.display = session ? 'none' : '';
  document.getElementById('schwabAccountRow').style.display = session ? '' : 'none';
  const accounts = schwabAccounts();
  document.getElementById('schwabAccount').innerHTML = accounts.length
    ? accounts.map(a => `<option value="${esc(a.hash)}"${acct && a.hash === acct.hash ? ' selected' : ''}>Account ${esc(mask(a.last4))}</option>`).join('')
    : '<option value="">No accounts loaded</option>';
  document.getElementById('schwabStatus').innerHTML = session
    ? `<span style="color:var(--green)">●</span> ${acct ? 'Connected · ' + esc(mask(acct.last4)) : 'Logged in, no account'} · ${loginLeft(session.refreshExp - Date.now())}`
    : store.get('schwab_tokens') ? '<span style="color:var(--amber)">●</span> Login expired' : '○ Not connected';
  updateTradeButton();
  updateAccountSourceUi();
}

// ---------- the shares card's trade button ----------

export function updateTradeButton() {
  const btn = document.getElementById('sharesTrade');
  const q = state.quoteData;
  const show = !!q && state.currentMode === 'shares' && state.sizingMode === 'risk' && schwabConnected() && (!q.type || q.type === 'stock' || q.type === 'etf');
  btn.style.display = show ? '' : 'none';
  btn.disabled = !show || state.tradeBusy || !sharesPlan().valid;
}

// ---------- review sheet ----------

/** the order exactly as the card sizes it right now, with what could go wrong spelled out */
export function buildTradeTicket(now = Date.now()) {
  const q = state.quoteData;
  const plan = sharesPlan();
  const { isLong, entry, shares: qty } = plan;
  const stop = plan.valid ? stopTick(plan.stop, isLong) : NaN;
  const acct = schwabAccount();
  return ticketFor({ symbol: q.symbol, qty, isLong, stop, entry, customEntry: rawStop('entryPrice') > 0, stopDuration: schwabStopDuration(), hash: acct ? acct.hash : '', valid: plan.valid }, q, now);
}

/**
 * A ticket for these frozen terms (symbol, size, stop, entry, the account it goes to) against quote q. flags name the warnings,
 * so a re-check before sending can tell a new one from one already reviewed.
 */
function ticketFor(p, q, now) {
  const { symbol, qty, isLong, stop, entry } = p;
  const error = !p.valid ? 'No valid stop on the card. Fix the stop first.'
    : sharesTicketError({ symbol, type: q.type, qty, isLong, stop, bid: q.bid, ask: q.ask, last: q.last });
  const fill = (isLong ? q.ask : q.bid) || q.last || entry; // where a market order is likely to fill
  const perShare = px => isLong ? px - stop : stop - px;
  const t = {
    symbol, qty, isLong, stop, entry, fill, bid: q.bid || 0, ask: q.ask || 0, last: q.last || 0,
    customEntry: p.customEntry, stopDuration: p.stopDuration, hash: p.hash, valid: p.valid,
    plannedRisk: qty * perShare(entry), fillRisk: qty * perShare(fill),
    error, order: null, warnings: [], flags: [], sent: false, orderId: '', result: null,
  };
  if (error) return t;
  t.order = sharesStopOrder({ symbol, qty, isLong, stop, stopDuration: t.stopDuration });
  const warn = (flag, text) => { t.flags.push(flag); t.warnings.push(text); };
  if (!inRegularHours(now)) warn('hours', 'Outside regular hours. A market order waits for the next open and can fill far from here.');
  if (t.fillRisk > t.plannedRisk * 1.1 + 0.01) warn('risk', `At the ${isLong ? 'ask' : 'bid'} ${fmtTick(fill)}, risk is ${fmt$(t.fillRisk)}, over your ${fmt$(t.plannedRisk)} plan${t.customEntry ? ' from the planned entry' : ''}.`);
  const last = state.tradeLast;
  if (last && last.symbol === symbol && now - last.at < 120000) warn('repeat', `You sent a ${symbol} order ${Math.round((now - last.at) / 1000)}s ago. This places another one.`);
  return t;
}

/**
 * The quote again for the symbol under review; true only when a fresh one came in. refreshQuote answers true or false;
 * an older one that answered nothing counts as fresh only when it put a new quote in place.
 */
async function freshQuote(symbol) {
  const before = state.quoteData;
  let ok;
  try { ok = await refreshQuote(); } catch(e) { ok = false; }
  const q = state.quoteData;
  if (!q || q.symbol !== symbol) return false;
  return ok === true || (ok === undefined && q !== before);
}

export async function openTrade() {
  if (state.tradeBusy || !state.quoteData) return;
  if (!schwabConnected()) { showError('Connect Schwab in Settings first.'); openSheet('settings'); return; }
  const symbol = state.quoteData.symbol;
  const btn = document.getElementById('sharesTrade');
  state.tradeBusy = true;
  btn.disabled = true;
  btn.textContent = 'Checking quote…';
  let fresh = false;
  try { fresh = await freshQuote(symbol); } finally {
    state.tradeBusy = false;
    btn.textContent = TRADE_LABEL;
    updateTradeButton();
  }
  if (!state.quoteData || state.quoteData.symbol !== symbol) { showError('The ticker changed. Check the card, then try again.'); return; }
  if (!fresh) { showError(`Could not refresh the ${symbol} quote, so there is nothing to review yet. Try again.`); return; }
  state.tradeTicket = buildTradeTicket();
  renderTradeSheet();
  openSheet('trade');
}

export function setTradeStopDuration(d) {
  const t = state.tradeTicket;
  if (!t || !t.order || t.sent || state.tradeBusy || (d !== 'DAY' && d !== 'GOOD_TILL_CANCEL')) return;
  store.set('schwab_stop_duration', d);
  t.stopDuration = d;
  t.order = sharesStopOrder({ symbol: t.symbol, qty: t.qty, isLong: t.isLong, stop: t.stop, stopDuration: d });
  renderTradeSheet();
}

/** why the reviewed ticket can't go as it is, from a fresh quote; '' when it still can */
function recheck(t, fresh) {
  const acct = schwabAccount();
  if (!acct || acct.hash !== t.hash) return { why: 'You switched Schwab accounts since this was reviewed. Nothing was sent. Open the review again.', again: null };
  if (!fresh) return { why: `Could not refresh the ${t.symbol} quote, so nothing was sent. Try again.`, again: null };
  const again = ticketFor(t, state.quoteData, Date.now());
  if (again.error) return { why: again.error + ' Nothing was sent.', again };
  if (JSON.stringify(again.order) !== JSON.stringify(t.order)) return { why: 'The order changed since you reviewed it. Nothing was sent. Review it, then place again.', again };
  if (again.flags.some(f => !t.flags.includes(f))) return { why: 'The quote moved since you reviewed this. Nothing was sent. Check the warnings, then place again.', again };
  return { why: '', again };
}

export async function placeTrade() {
  const t = state.tradeTicket;
  if (!t || !t.order || t.sent || state.tradeBusy) return;
  state.tradeBusy = true;
  // the quote again right before sending: the frozen order goes only while the market still allows it as reviewed
  t.result = { ok: null, text: 'Checking the quote…' };
  renderTradeSheet();
  updateTradeButton();
  let fresh = false;
  try { fresh = await freshQuote(t.symbol); } catch(e) {}
  const { why, again } = recheck(t, fresh);
  if (why) {
    state.tradeBusy = false;
    const next = again || t;
    if (next.error) next.error = why; // a ticket that can't go shows only its reason
    next.result = { ok: false, text: why };
    if (state.tradeTicket === t) state.tradeTicket = next;
    renderTradeSheet();
    updateTradeButton();
    return;
  }
  t.sent = true; // one review, one order: this ticket can't be sent again, and nothing retries it
  t.result = { ok: null, text: 'Sending…' };
  renderTradeSheet();
  try {
    const { orderId } = await schwabPlaceOrder(t.order, t.hash);
    t.orderId = orderId;
    state.tradeLast = { symbol: t.symbol, at: Date.now() };
    t.result = { ok: null, text: `Sent${orderId ? ', order ' + orderId : ''}. Checking status…` };
    renderTradeSheet();
    showToast(`Order sent: ${t.isLong ? 'buy' : 'short'} ${t.qty} ${t.symbol}, stop ${fmtTick(t.stop)}.`);
    await updateTradeStatus(t);
  } catch(e) {
    if (e.notSent) {
      // the login or the account stopped it before the order request: nothing reached Schwab, so nothing to look for there
      t.result = { ok: false, text: (e instanceof TypeError ? 'Could not reach the Schwab worker.' : e.message) + ' Nothing was sent to Schwab.' };
    } else {
      if (e instanceof TypeError) state.tradeLast = { symbol: t.symbol, at: Date.now() }; // it may have gone through
      t.result = { ok: false, text: e instanceof TypeError ? 'No answer from Schwab. Check your Schwab orders before trying again.' : e.status ? 'Schwab rejected the order. ' + e.message : e.message };
    }
  } finally {
    state.tradeBusy = false;
    if (state.tradeTicket === t) renderTradeSheet();
    updateTradeButton();
  }
}

export async function checkTradeStatus() {
  const t = state.tradeTicket;
  if (!t || !t.orderId || state.tradeBusy) return;
  state.tradeBusy = true;
  renderTradeSheet();
  try { await updateTradeStatus(t); } finally {
    state.tradeBusy = false;
    if (state.tradeTicket === t) renderTradeSheet();
  }
}

const ENDED = /REJECTED|CANCELED|EXPIRED/;

/** green only when the entry is filled or working and its stop is in place; a stop Schwab refused is said out loud */
async function updateTradeStatus(t) {
  const o = await schwabOrder(t.orderId, t.hash).catch(() => null);
  if (!o) { t.result = { ok: null, text: `Sent${t.orderId ? ', order ' + t.orderId : ''}. Check Schwab for the fill and the stop.` }; return; }
  const child = o.childOrderStrategies && o.childOrderStrategies[0];
  const entryOk = !ENDED.test(o.status || ''), stopOk = !!(child && child.status) && !ENDED.test(child.status);
  let text = orderStatusLine(t, o);
  if (entryOk && child && child.status && !stopOk) {
    const filled = Number(o.filledQuantity) || (o.orderActivityCollection || []).flatMap(a => a.executionLegs || []).reduce((n, l) => n + (Number(l.quantity) || 0), 0);
    text += filled > 0 ? ` Your ${filled} ${t.symbol} have no stop. Set one in Schwab now.` : ' The stop is not in place. Check Schwab before the entry fills.';
  }
  t.result = { ok: !entryOk || (child && child.status && !stopOk) ? false : stopOk ? true : null, text };
}

/** "Order 123: filled 125 at $247.11. Stop $243.10: working." from Schwab's order record */
export function orderStatusLine(t, o) {
  const word = s => String(s || 'unknown').toLowerCase().replace(/_/g, ' ');
  const legs = (o.orderActivityCollection || []).flatMap(a => a.executionLegs || []);
  const qty = legs.reduce((n, l) => n + (Number(l.quantity) || 0), 0);
  const avg = qty ? legs.reduce((n, l) => n + (Number(l.quantity) || 0) * (Number(l.price) || 0), 0) / qty : 0;
  let text = `Order ${t.orderId}: ${word(o.status)}`;
  if (avg > 0) text += ` ${qty} at ${fmtTick(avg)}`;
  const child = o.childOrderStrategies && o.childOrderStrategies[0];
  if (child && child.status) text += `. Stop ${fmtTick(t.stop)}: ${word(child.status)}`;
  if (o.statusDescription) text += `. ${o.statusDescription}`;
  return text + '.';
}

export function renderTradeSheet() {
  const t = state.tradeTicket;
  const acct = (t && schwabAccounts().find(a => a.hash === t.hash)) || schwabAccount(); // the account the ticket goes to
  document.getElementById('tradeAccount').textContent = acct ? 'Account ' + mask(acct.last4) : '';
  const body = document.getElementById('tradeBody');
  if (!t) { body.innerHTML = ''; return; }
  if (t.error) {
    body.innerHTML = `<p class="trade-warn" role="alert">${esc(t.error)}</p><div class="trade-actions"><button class="btn" data-action="closeSheet">Close</button></div>`;
    return;
  }
  const verb = t.isLong ? 'Buy' : 'Sell short';
  const duration = (d, label) => `<button class="${t.stopDuration === d ? 'active' : ''}" aria-pressed="${t.stopDuration === d}" data-action="setTradeStopDuration" data-arg="${d}"${t.sent ? ' disabled' : ''}>${label}</button>`;
  const market = t.bid > 0 && t.ask > 0 ? `Bid ${fmtTick(t.bid)} · ask ${fmtTick(t.ask)}` : `Last ${fmtTick(t.last)}`;
  const action = t.sent
    ? (t.orderId ? `<button class="btn" data-action="checkTradeStatus"${state.tradeBusy ? ' disabled' : ''}>↻ Status</button>` : '')
    : `<button class="btn trade-confirm" id="tradePlace" data-action="placeTrade"${state.tradeBusy ? ' disabled' : ''}>${verb} ${t.qty} ${esc(t.symbol)}</button>`;
  body.innerHTML = `
    <dl class="trade-legs">
      <div><dt>Entry</dt><dd><strong>${verb} ${t.qty} ${esc(t.symbol)}</strong><span class="shares-detail">Market order, today</span></dd></div>
      <div><dt>Then stop</dt><dd><strong>${t.isLong ? 'Sell' : 'Buy to cover'} ${t.qty} at ${fmtTick(t.stop)}</strong><span class="shares-detail">Stop order, placed once the ${t.isLong ? 'buy' : 'short'} fills</span></dd></div>
      <div><dt>Stop lasts</dt><dd><div class="seg" role="group" aria-label="Stop lasts">${duration('DAY', 'Today')}${duration('GOOD_TILL_CANCEL', 'Until canceled')}</div></dd></div>
      <div><dt>Risk at stop</dt><dd><span class="shares-loss">${fmt$(t.plannedRisk)}</span><span class="shares-detail">From ${t.customEntry ? 'planned ' : ''}entry ${fmtTick(t.entry)}</span></dd></div>
      <div><dt>Market</dt><dd>${market}</dd></div>
    </dl>
    ${t.warnings.map(w => `<p class="trade-warn">${esc(w)}</p>`).join('')}
    <p class="hint">A triggered stop becomes a market order, so a gap can fill past it.${t.isLong ? '' : ' Shorting needs margin and shares to borrow.'}</p>
    <details class="hint-details"><summary>Order sent to Schwab</summary><pre class="trade-json">${esc(JSON.stringify(t.order, null, 2))}</pre></details>
    <div class="trade-actions">
      <button class="btn" data-action="closeSheet">${t.sent ? 'Close' : 'Cancel'}</button>
      ${action}
    </div>
    <p class="trade-result${t.result && t.result.ok !== null ? (t.result.ok ? ' ok' : ' bad') : ''}" id="tradeResult" role="status">${t.result ? esc(t.result.text) : ''}</p>`;
}

// ---------- boot ----------

export async function initSchwab(href = location.href) {
  updateSchwabUi();
  // a login finished in another tab shows up here, and a new day's account size comes in
  window.addEventListener('focus', () => { updateSchwabUi(); dailyAccountSize(); });
  const url = new URL(href);
  if (url.searchParams.get('login') === 'google') { dailyAccountSize(); return; } // Google's return through Supabase carries a code too: not ours
  if (!url.searchParams.get('code')) { dailyAccountSize(); return; }
  // the app as its own callback page: drop the code from the address, then finish the login
  globalThis.history?.replaceState(null, '', url.pathname + url.hash);
  if (await finishSchwab(url.search, true)) openSheet('settings');
}
