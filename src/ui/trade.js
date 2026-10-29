// Schwab trading: the connect section in Settings, the shares card's trade button, and the order review sheet.
// The sheet freezes one ticket when it opens, for the account selected then; Place re-checks it against a fresh quote,
// then sends exactly that payload once and never retries it. A limit entry still waiting moves through Positions' Edit.
// The setup and entry tactic picks, and the plan kept once the order goes, are ui/order-plan.js.
import { state } from '../state.js';
import { fmt$, marketEscape as esc } from '../core/format.js';
import { defaultEntryLimit, entryLimitError, fmtTick, inRegularHours, limitEntryError, priceTick, sharesStopOrder, sharesTicketError, stopEntryError, stopTick } from '../core/orders.js';
import { store } from '../lib/store.js';
import { inZone } from '../lib/zone.js';
import { callbackIsHere, parseSchwabRedirect, proxyOk, schwabAccount, schwabCallbackCached, schwabAccounts, schwabConnected, schwabDisconnectEverywhere, schwabDisconnectHere, schwabExchangeCode, schwabFetchAccounts, schwabFetchCallback, schwabLoginUrl, schwabOrder, schwabPlaceOrder, schwabProxy, schwabSession, schwabStanding, schwabStopDuration, onSchwabShared } from '../services/schwab.js';
import { dailyAccountSize, updateAccountSourceUi } from './account-size.js';
import { showError, showToast } from './feedback.js';
import { positionsAccountChanged } from './positions.js';
import { sharesPlan } from './shares.js';
import { orbEntryName } from './orb.js';
import { loadPlanChoices, planContext, saveTradePlan, startTradePlan, tradePlanHtml } from './order-plan.js';
import { onSheetChange, openSheet } from './sheets.js';
import { rawStop } from './stops.js';
import { refreshQuote, tradierQuote } from './ticker.js';
import { maybeCapture } from './schwab-capture.js';

const TRADE_LABEL = 'Trade at Schwab';
const mask = last4 => '••' + last4;
const unreachable = 'Could not reach the Schwab worker. Check its URL in Settings.';

// ---------- Settings: worker URL, login, account ----------

export function schwabProxyChanged() {
  store.set('schwab_proxy', document.getElementById('schwabProxy').value.trim());
  store.del('schwab_proxy_confirm'); // typed on this device: nothing to confirm
  updateSchwabUi();
  clearTimeout(state.schwabCallbackTimer);
  state.schwabCallbackTimer = setTimeout(refreshSchwabCallback, 600); // ask the worker once typing settles
}

/** the worker URL shows as one line once it's set and known to work (it answered, or you're logged in through it) */
export function schwabProxySettled() {
  return proxyOk(schwabProxy()) && (!!schwabCallbackCached() || !!schwabSession()) && !state.schwabProxyEditing;
}

/** Change: bring the worker URL box back */
export function editSchwabProxy() {
  state.schwabProxyEditing = true;
  updateSchwabUi();
  document.getElementById('schwabProxy').focus();
}

/** leaving the box (or Enter) ends editing; it folds back to one line once the worker answers */
export function schwabProxyDone() {
  state.schwabProxyEditing = false;
  updateSchwabUi();
}

/** true when Schwab sends the browser back to this page after login, so no address needs pasting */
export function schwabReturnsHere() {
  const callback = schwabCallbackCached();
  return !!callback && callbackIsHere(callback, globalThis.location?.href || '');
}

/** ask the worker for its callback and show or hide the paste box; a worker that can't say keeps the box */
export async function refreshSchwabCallback() {
  if (!proxyOk(schwabProxy())) return;
  try { await schwabFetchCallback(); } catch(e) { return; } // offline: the last answer stands
  updateSchwabUi();
}

export function connectSchwab() {
  if (!proxyOk(schwabProxy())) {
    showError('Paste your Schwab worker URL first. It starts with https://');
    document.getElementById('schwabProxy').focus();
    return;
  }
  // a worker URL that came from your account, not typed here: whoever runs it sees the login, so ask once
  if (proxyNeedsConfirm()) {
    if (state.schwabProxyConfirming !== schwabProxy()) {
      state.schwabProxyConfirming = schwabProxy();
      setSchwabNote(`Your worker URL changed to ${new URL(schwabProxy()).host} through your account. The login goes through it, so use it only if you set it. Press Log in again to use it, or Change it.`);
      return;
    }
    store.del('schwab_proxy_confirm');
    state.schwabProxyConfirming = null;
  }
  window.open(schwabLoginUrl(), '_blank', 'noopener');
  if (schwabReturnsHere()) {
    setSchwabNote('Log in at Schwab in the new tab. It comes back to this app and connects by itself.');
  } else {
    setSchwabNote('Log in at Schwab. Then copy the address you land on and paste it here.');
    document.getElementById('schwabRedirect').focus();
  }
}

/** a worker URL synced from the account that this device hasn't used yet */
export function proxyNeedsConfirm() {
  const pending = store.get('schwab_proxy_confirm');
  return pending !== null && pending === store.get('schwab_proxy');
}

/** finish a login from the callback address: pasted by hand, or this page's own address when the app is the callback */
export async function finishSchwab(text = document.getElementById('schwabRedirect').value, fromCallback = false) {
  const parsed = parseSchwabRedirect(text);
  if (!parsed) { showError('No login code in that address. Copy the whole address Schwab sent you to.'); return false; }
  const expected = store.get('schwab_oauth_state') || '';
  // a callback page must carry this device's state; a pasted address may come back without one
  const stateBad = fromCallback ? !expected || parsed.state !== expected : !!(parsed.state && expected && parsed.state !== expected);
  if (stateBad) { store.del('schwab_oauth_state'); showError('That login is from another attempt. Log in to Schwab again.'); return false; }
  if (!proxyOk(schwabProxy())) { showError('Paste your Schwab worker URL in Settings first.'); return false; }
  if (proxyNeedsConfirm()) { showError('Your worker URL changed through your account. Press Log in in Settings to check it first.'); return false; }
  setSchwabNote('Connecting…');
  try {
    await schwabExchangeCode(parsed.code);
  } catch(e) {
    store.del('schwab_oauth_state'); // one attempt per login: a failed code means logging in again
    setSchwabNote('');
    showError(e.status ? `Schwab refused the login code. ${e.message} Codes expire in about 30 seconds, so log in again and paste right away.` : unreachable);
    return false;
  }
  store.del('schwab_oauth_state');
  document.getElementById('schwabRedirect').value = '';
  setSchwabNote('');
  const ok = await reloadSchwabAccounts();
  if (ok) { showToast(`Schwab connected. Account ${mask(schwabAccount().last4)}.`); maybeCapture(); }
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

/** @param {string} [where] 'everywhere' ends the login on every device; otherwise this device only */
export async function disconnectSchwab(where) {
  const shared = !!state.session;
  let reached = true;
  if (where === 'everywhere') reached = await schwabDisconnectEverywhere();
  else schwabDisconnectHere();
  updateSchwabUi();
  positionsAccountChanged();
  if (where !== 'everywhere') showToast(shared ? 'Schwab disconnected on this device. Your other devices stay logged in.' : 'Schwab disconnected on this device.');
  else if (reached) showToast('Schwab disconnected on every device.');
  else showError("Schwab disconnected here, but your account couldn't be reached, so your other devices stay logged in.");
}

// another device's login (or its Disconnect everywhere) reached this one through the account
onSchwabShared(() => {
  updateSchwabUi();
  positionsAccountChanged();
  dailyAccountSize();
  maybeCapture();
});

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
  const settled = schwabProxySettled() && document.activeElement !== proxyEl; // never fold away while typing
  document.getElementById('schwabProxyLine').style.display = settled ? '' : 'none';
  document.getElementById('schwabProxyField').style.display = settled ? 'none' : '';
  if (settled) document.getElementById('schwabProxyHost').textContent = new URL(schwabProxy()).host;
  document.getElementById('schwabLogin').style.display = session ? 'none' : '';
  document.getElementById('schwabPaste').style.display = schwabReturnsHere() ? 'none' : '';
  document.getElementById('schwabAccountRow').style.display = session ? '' : 'none';
  document.getElementById('schwabSharedLine').style.display = session?.shared && state.session ? '' : 'none';
  const accounts = schwabAccounts();
  document.getElementById('schwabAccount').innerHTML = accounts.length
    ? accounts.map(a => `<option value="${esc(a.hash)}"${acct && a.hash === acct.hash ? ' selected' : ''}>Account ${esc(mask(a.last4))}</option>`).join('')
    : '<option value="">No accounts loaded</option>';
  document.getElementById('schwabStatus').innerHTML = session
    ? `<span style="color:var(--green)">●</span> ${acct ? 'Connected · ' + esc(mask(acct.last4)) : 'Logged in, no account'} · ${loginLeft(session.refreshExp - Date.now())}`
    : store.get('schwab_tokens') ? '<span style="color:var(--amber)">●</span> Login expired' : '○ Not connected';
  updateTradeButton();
  updateAccountSourceUi();
  updateSchwabBanner();
}

// ---------- the banner under the header: not connected, or the login's last day ----------

export function updateSchwabBanner() {
  const s = state.schwabBannerReady && !state.schwabBannerHidden ? schwabStanding() : null;
  const banner = document.getElementById('schwabBanner');
  banner.style.display = s ? '' : 'none';
  if (!s) return;
  banner.classList.toggle('ending', s.kind === 'ending');
  document.getElementById('schwabBannerText').textContent = s.kind === 'ending'
    ? `Your Schwab login ends in ${Math.max(1, Math.ceil(s.left / 3600000))}h. Log in again to keep positions and trading working.`
    : s.kind === 'noAccount' ? 'Schwab is logged in, but no account is loaded.'
    : s.ended ? 'Your Schwab login ended. Positions, trading and imports are off until you log in again.'
    : "Schwab isn't connected on this device. Positions, trading and imports are off.";
  document.getElementById('schwabBannerLogin').textContent = s.kind === 'noAccount' ? 'Open settings' : 'Log in to Schwab';
}

/** the banner's button: straight to Schwab's login, with Settings open for the note and the paste box */
export function schwabBannerLogin() {
  openSheet('settings');
  if (schwabStanding()?.kind !== 'noAccount') connectSchwab();
}

export function hideSchwabBanner() {
  state.schwabBannerHidden = true;
  updateSchwabBanner();
}

// ---------- the shares card's trade button ----------

export function updateTradeButton() {
  const btn = document.getElementById('sharesTrade');
  const q = state.quoteData;
  const show = !!q && state.currentMode === 'shares' && state.sizingMode === 'risk' && schwabConnected() && (!q.type || q.type === 'stock' || q.type === 'etf');
  btn.style.display = show ? '' : 'none';
  btn.disabled = !show || state.tradeBusy || !sharesPlan().valid;
  if (show) loadPlanChoices(); // the review's setups, read before it opens
}

// ---------- review sheet ----------

const ENTRY_TYPES = ['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'];
const atMarket = type => type === 'MARKET' || type === 'LIMIT'; // sized from the planned entry, its stop checked against the market
// the stop entry you picked last (Stop or Stop limit), on this device
const savedStopEntry = () => store.get('schwab_entry_type') === 'STOP' ? 'STOP' : 'STOP_LIMIT';

/**
 * the order exactly as the card sizes it right now, with what could go wrong spelled out. A planned entry past the market
 * (over the ask on a long, under the bid on a short: a breakout) starts as the stop entry you picked last, anything else at market.
 * A limit is never where a review starts; picked, it starts at the planned entry.
 */
export function buildTradeTicket(now = Date.now()) {
  const q = state.quoteData;
  const plan = sharesPlan();
  const { isLong, entry, shares: qty } = plan;
  const stop = plan.valid ? stopTick(plan.stop, isLong) : NaN;
  const acct = schwabAccount();
  const customEntry = rawStop('entryPrice') > 0, entryStop = entry > 0 ? priceTick(entry) : 0;
  const breakout = customEntry && !stopEntryError({ isLong, entryStop, bid: q.bid, ask: q.ask, last: q.last });
  return ticketFor({
    symbol: q.symbol, qty, isLong, stop, entry, customEntry, entryNote: orbEntryName(), stopDuration: schwabStopDuration(), hash: acct ? acct.hash : '', valid: plan.valid,
    entryType: breakout ? savedStopEntry() : 'MARKET', entryStop, entryLimit: entryStop > 0 ? defaultEntryLimit(entryStop, isLong) : 0,
    limitPrice: entry > 0 ? priceTick(entry) : 0,
    setups: [], tactics: [], planCtx: planContext(isLong, plan.stop),
  }, q, now);
}

/** the quote a ticket was reviewed on, to re-plan it (a new entry type or limit) without moving it to a newer one */
const reviewedQuote = t => ({ type: t.quoteType, bid: t.bid, ask: t.ask, last: t.last });

/**
 * A ticket for these frozen terms (symbol, size, stop, entry and its order type, the account it goes to) against quote q.
 * flags name the warnings, so a re-check before sending can tell a new one from one already reviewed. limitError is a limit
 * (a limit entry's price, a stop limit's limit) that can't work: shown in the sheet, it holds the order back until it's fixed.
 * entryStatus and filled are what Schwab showed of the entry once sent.
 */
function ticketFor(p, q, now) {
  const { symbol, qty, isLong, stop, entry, entryType, entryStop, entryLimit, limitPrice } = p;
  const error = !p.valid ? 'No valid stop on the card. Fix the stop first.'
    : sharesTicketError({ symbol, type: q.type, qty, isLong, stop, bid: q.bid, ask: q.ask, last: q.last, entryType, entryStop });
  const limitError = entryType === 'STOP_LIMIT' ? entryLimitError({ isLong, entryStop, entryLimit })
    : entryType === 'LIMIT' ? limitEntryError({ isLong, stop, limit: limitPrice }) : '';
  // where it's likely to fill: a market order at the ask (bid), a limit no worse than its price, a stop at its stop, a stop limit no worse than its limit
  const fill = entryType === 'STOP' ? entryStop : entryType === 'STOP_LIMIT' ? entryLimit : entryType === 'LIMIT' ? limitPrice : (isLong ? q.ask : q.bid) || q.last || entry;
  const at = atMarket(entryType) ? entry : entryStop; // what the shares were sized from
  const perShare = px => isLong ? px - stop : stop - px;
  const t = {
    symbol, qty, isLong, stop, entry: at, fill, bid: q.bid || 0, ask: q.ask || 0, last: q.last || 0, quoteType: q.type,
    customEntry: p.customEntry, entryNote: p.entryNote || '', stopDuration: p.stopDuration, hash: p.hash, valid: p.valid,
    entryType, entryStop, entryLimit, limitPrice, limitError,
    plannedRisk: qty * perShare(at), fillRisk: qty * perShare(fill),
    error, order: null, warnings: [], flags: [], sent: false, orderId: '', result: null, entryStatus: '', filled: 0,
    // the picks and what the calculator knew go with every re-plan; the saved plan's id comes once it's sent
    setups: p.setups || [], tactics: p.tactics || [], setupOrder: p.setupOrder || null, planCtx: p.planCtx || null, picksTouched: !!p.picksTouched, prefilled: !!p.prefilled, planId: '',
  };
  if (error) return t;
  if (!limitError) t.order = sharesStopOrder({ symbol, qty, isLong, stop, stopDuration: t.stopDuration, entryType, entryStop, entryLimit: entryType === 'LIMIT' ? limitPrice : entryLimit });
  const warn = (flag, text) => { t.flags.push(flag); t.warnings.push(text); };
  if (!inRegularHours(now)) warn('hours', entryType === 'MARKET' ? 'Outside regular hours. A market order waits for the next open and can fill far from here.'
    : entryType === 'LIMIT' ? 'Outside regular hours. The limit waits for the next open.' : 'Outside regular hours. The stop entry waits for the next regular session.');
  if (atMarket(entryType) && !limitError && t.fillRisk > t.plannedRisk * 1.1 + 0.01) warn('risk', `At the ${entryType === 'LIMIT' ? 'limit' : isLong ? 'ask' : 'bid'} ${fmtTick(fill)}, risk is ${fmt$(t.fillRisk)}, over your ${fmt$(t.plannedRisk)} plan${t.customEntry ? ' from the planned entry' : ''}.`);
  const last = state.tradeLast;
  if (last && last.symbol === symbol && now - last.at < 120000) warn('repeat', `You sent a ${symbol} order ${Math.round((now - last.at) / 1000)}s ago. This places another one.`);
  return t;
}

/** The quote again for the symbol under review; true only when a fresh one came in. */
async function freshQuote(symbol) {
  let ok = false;
  try { ok = await refreshQuote(); } catch(e) {}
  return ok === true && state.quoteData?.symbol === symbol;
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
  state.tradeSetupQuery = '';
  startTradePlan(state.tradeTicket);
  renderTradeSheet();
  openSheet('trade');
  startTradeQuote(state.quoteData);
}

// ---------- the live quote at the top of the review ----------

const TRADE_QUOTE_MS = 2000;

/** last, bid and ask while the review is open, polled on their own: the frozen ticket never moves with them */
function startTradeQuote(q) {
  const gen = ++state.tradeQuoteGen;
  setTradeQuote(q);
  const tick = async () => {
    const t = state.tradeTicket;
    if (gen !== state.tradeQuoteGen || !t) return;
    if (!document.hidden) {
      const fresh = await tradierQuote(t.symbol, false).catch(() => null);
      if (gen !== state.tradeQuoteGen) return; // closed, or another review opened, while it was out
      if (fresh && fresh.symbol === t.symbol) setTradeQuote(fresh);
      else if (state.tradeQuote) { state.tradeQuote.failed = true; renderTradeQuote(); }
    }
    state.tradeQuoteTimer = setTimeout(tick, TRADE_QUOTE_MS);
  };
  clearTimeout(state.tradeQuoteTimer);
  state.tradeQuoteTimer = setTimeout(tick, TRADE_QUOTE_MS);
}

function stopTradeQuote() {
  state.tradeQuoteGen++;
  clearTimeout(state.tradeQuoteTimer);
  state.tradeQuote = null;
  renderTradeQuote();
}

onSheetChange(name => { if (name !== 'trade' && state.tradeQuote) stopTradeQuote(); });

function setTradeQuote(q) {
  if (!q) return;
  state.tradeQuote = { symbol: q.symbol, last: Number(q.last) || 0, bid: Number(q.bid) || 0, ask: Number(q.ask) || 0, at: Date.now(), failed: false };
  renderTradeQuote();
}

/** Last, Bid, Ask; the side a market order fills on is lit (the ask on a buy, the bid on a short) */
export function renderTradeQuote() {
  const el = document.getElementById('tradeQuote');
  const q = state.tradeQuote, t = state.tradeTicket;
  el.style.display = q ? '' : 'none';
  if (!q) { el.innerHTML = ''; return; }
  const px = v => v > 0 ? fmtTick(v) : '—';
  const cell = (label, v, cls = '', tail = '') => `<div class="tq-cell${cls}"><span class="tq-label">${label}${tail}</span><span class="tq-val">${px(v)}</span></div>`;
  const fills = t && !t.error ? (t.isLong ? 'ask' : 'bid') : '';
  // a failed poll keeps the last numbers and says how old they are
  const status = q.failed ? `<span class="tq-status stale">${esc(inZone(q.at))}</span>` : '<span class="tq-status"><span class="tq-dot"></span>Live</span>';
  el.innerHTML = cell('Last', q.last, '', status) + cell('Bid', q.bid, fills === 'bid' ? ' fills' : '') + cell('Ask', q.ask, fills === 'ask' ? ' fills' : '');
}

export function setTradeStopDuration(d) {
  const t = state.tradeTicket;
  if (!t || t.error || t.sent || state.tradeBusy || (d !== 'DAY' && d !== 'GOOD_TILL_CANCEL')) return;
  store.set('schwab_stop_duration', d);
  state.tradeTicket = ticketFor({ ...t, stopDuration: d }, reviewedQuote(t), Date.now());
  renderTradeSheet();
}

/** Market | Limit | Stop | Stop limit: the entry's order type; a stop entry only while the planned entry is past the market */
export function setTradeEntryType(type) {
  const t = state.tradeTicket;
  if (!t || t.error || t.sent || state.tradeBusy || !ENTRY_TYPES.includes(type) || type === t.entryType) return;
  if (!atMarket(type) && stopEntryError({ isLong: t.isLong, entryStop: t.entryStop, ...reviewedQuote(t) })) return;
  if (!atMarket(type)) store.set('schwab_entry_type', type);
  state.tradeTicket = ticketFor({ ...t, entryType: type }, reviewedQuote(t), Date.now());
  renderTradeSheet();
}

/** typing a stop limit's limit: re-plans and redraws only the details, so the cursor stays put */
export function setTradeEntryLimit(value) {
  const t = state.tradeTicket;
  if (!t || t.error || t.sent || state.tradeBusy || t.entryType !== 'STOP_LIMIT') return;
  const v = parseFloat(value);
  const next = ticketFor({ ...t, entryLimit: v > 0 ? priceTick(v) : 0 }, reviewedQuote(t), Date.now());
  state.tradeTicket = next;
  document.getElementById('tradeDetail').innerHTML = tradeDetail(next);
  const place = document.getElementById('tradePlace');
  if (place) place.disabled = !next.order || state.tradeBusy;
}

/** typing a limit entry's price: re-plans and redraws only the details and the Place label, so the cursor stays put */
export function setTradeLimit(value) {
  const t = state.tradeTicket;
  if (!t || t.error || t.sent || state.tradeBusy || t.entryType !== 'LIMIT') return;
  const v = parseFloat(value);
  const next = ticketFor({ ...t, limitPrice: v > 0 ? priceTick(v) : 0 }, reviewedQuote(t), Date.now());
  state.tradeTicket = next;
  document.getElementById('tradeDetail').innerHTML = tradeDetail(next);
  const place = document.getElementById('tradePlace');
  if (place) { place.disabled = !next.order || state.tradeBusy; place.textContent = placeLabel(next); }
}

/** why the reviewed ticket can't go as it is, from a fresh quote; '' when it still can */
function recheck(t, fresh) {
  const acct = schwabAccount();
  if (!acct || acct.hash !== t.hash) return { why: 'You switched Schwab accounts since this was reviewed. Nothing was sent. Open the review again.', again: null };
  if (!fresh) return { why: `Could not refresh the ${t.symbol} quote, so nothing was sent. Try again.`, again: null };
  const again = ticketFor(t, state.quoteData, Date.now());
  if (again.error) return { why: again.error + ' Nothing was sent.', again };
  if (!again.order) return { why: again.limitError + ' Nothing was sent.', again: null };
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
  if (fresh && state.openSheetName === 'trade') setTradeQuote(state.quoteData);
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
    const how = t.entryType === 'LIMIT' ? ` at ${fmtTick(t.limitPrice)} limit` : t.entryType === 'STOP' ? ` on a stop at ${fmtTick(t.entryStop)}` : t.entryType === 'STOP_LIMIT' ? ` on a stop at ${fmtTick(t.entryStop)}, limit ${fmtTick(t.entryLimit)}` : '';
    showToast(`Order sent: ${t.isLong ? 'buy' : 'short'} ${t.qty} ${t.symbol}${how}, stop ${fmtTick(t.stop)}.`);
    const saving = saveTradePlan(t); // after the send, beside the status check: never in the order's way
    await updateTradeStatus(t);
    await saving;
  } catch(e) {
    if (e.notSent) {
      // the login or the account stopped it before the order request: nothing reached Schwab, so nothing to look for there
      t.result = { ok: false, text: (e instanceof TypeError ? 'Could not reach the Schwab worker.' : e.message) + ' Nothing was sent to Schwab.' };
    } else {
      if (e instanceof TypeError) {
        state.tradeLast = { symbol: t.symbol, at: Date.now() }; // it may have gone through
        await saveTradePlan(t); // with no id: the journal finds its trade by time, if there is one
      }
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
  const filled = Number(o.filledQuantity) || (o.orderActivityCollection || []).flatMap(a => a.executionLegs || []).reduce((n, l) => n + (Number(l.quantity) || 0), 0);
  t.entryStatus = o.status || '';
  t.filled = filled;
  let text = orderStatusLine(t, o);
  if (entryOk && child && child.status && !stopOk) {
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

/** a limit entry still waiting with nothing filled: its price can move (Positions' Edit, which places it again with its stop) */
export const limitWaiting = t => t.entryType === 'LIMIT' && !!t.orderId && t.filled === 0 && !!t.entryStatus && t.entryStatus !== 'FILLED' && !ENDED.test(t.entryStatus);

const priceText = v => v > 0 ? v.toFixed(v >= 1 ? 2 : 4) : '';
const ENTRY_WORDS = { MARKET: '', LIMIT: '', STOP: ' stop', STOP_LIMIT: ' stop limit' };
/** what Place says: "Buy 543 ACME", "Buy 543 ACME at $49.95", "Buy stop 543 ACME" */
const placeLabel = t => `${t.isLong ? 'Buy' : 'Sell short'}${ENTRY_WORDS[t.entryType]} ${t.qty} ${t.symbol}${t.entryType === 'LIMIT' && t.limitPrice > 0 ? ' at ' + fmtTick(t.limitPrice) : ''}`;

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
  const off = t.sent ? ' disabled' : '';
  const type = (v, label) => {
    const why = atMarket(v) ? '' : stopEntryError({ isLong: t.isLong, entryStop: t.entryStop, ...reviewedQuote(t) });
    return `<button class="${t.entryType === v ? 'active' : ''}" aria-pressed="${t.entryType === v}" data-action="setTradeEntryType" data-arg="${v}"${why ? ` title="${esc(why)}" disabled` : off}>${label}</button>`;
  };
  const limit = t.entryType === 'LIMIT'
    ? `<div class="trade-limit"><label for="tradeLimit">Limit</label><div class="prefix-wrap"><span class="prefix">$</span><input type="number" id="tradeLimit" step="0.01" min="0" inputmode="decimal" autocomplete="off" value="${priceText(t.limitPrice)}" data-input="setTradeLimit"${off} /></div></div>`
    : t.entryType !== 'STOP_LIMIT' ? ''
    : `<div class="trade-limit"><label for="tradeEntryLimit">Limit</label><div class="prefix-wrap"><span class="prefix">$</span><input type="number" id="tradeEntryLimit" step="0.01" min="0" inputmode="decimal" autocomplete="off" value="${t.entryLimit > 0 ? t.entryLimit.toFixed(t.entryLimit >= 1 ? 2 : 4) : ''}" data-input="setTradeEntryLimit"${off} /></div></div>`;
  const action = t.sent
    ? (t.orderId ? `<button class="btn" data-action="checkTradeStatus"${state.tradeBusy ? ' disabled' : ''}>↻ Status</button>` : '')
      + (limitWaiting(t) ? `<button class="btn" data-action="openOrderEdit" data-arg="${esc(t.orderId)}" title="Move the limit if it isn't filling">Change limit</button>` : '')
    : `<button class="btn trade-confirm" id="tradePlace" data-action="placeTrade"${state.tradeBusy || !t.order ? ' disabled' : ''}>${esc(placeLabel(t))}</button>`;
  body.innerHTML = `
    <dl class="trade-legs">
      <div><dt>Entry order</dt><dd><div class="seg entry-types" role="group" aria-label="Entry order">${type('MARKET', 'Market')}${type('LIMIT', 'Limit')}${type('STOP', 'Stop')}${type('STOP_LIMIT', 'Stop limit')}</div>${limit}</dd></div>
    </dl>
    <div id="tradeDetail">${tradeDetail(t)}</div>
    <div class="trade-plan" id="tradePlan">${tradePlanHtml(t)}</div>
    <div class="trade-actions">
      <button class="btn" data-action="closeSheet">${t.sent ? 'Close' : 'Cancel'}</button>
      ${action}
    </div>
    <p class="trade-result${t.result && t.result.ok !== null ? (t.result.ok ? ' ok' : ' bad') : ''}" id="tradeResult" role="status">${t.result ? esc(t.result.text) : ''}</p>`;
}

/** everything under the entry order switch: what goes to Schwab, the risk, the warnings and the payload */
function tradeDetail(t) {
  const verb = t.isLong ? 'Buy' : 'Sell short', sym = esc(t.symbol), at = fmtTick(t.entryStop);
  const duration = (d, label) => `<button class="${t.stopDuration === d ? 'active' : ''}" aria-pressed="${t.stopDuration === d}" data-action="setTradeStopDuration" data-arg="${d}"${t.sent ? ' disabled' : ''}>${label}</button>`;
  const market = t.bid > 0 && t.ask > 0 ? `Bid ${fmtTick(t.bid)} · ask ${fmtTick(t.ask)}` : `Last ${fmtTick(t.last)}`;
  const entry = t.entryType === 'STOP'
    ? `<strong>${verb} ${t.qty} ${sym} on a stop at ${at}</strong><span class="shares-detail">Once ${sym} trades at ${at}, ${t.isLong ? 'buys' : 'shorts'} at market. Today only.</span>`
    : t.entryType === 'STOP_LIMIT'
    ? `<strong>${verb} ${t.qty} ${sym} on a stop at ${at}, limit ${t.entryLimit > 0 ? fmtTick(t.entryLimit) : '—'}</strong><span class="shares-detail">Once ${sym} trades at ${at}, ${t.isLong ? 'buys' : 'shorts'} at the limit or better, and not past it. Today only.</span>`
    : t.entryType === 'LIMIT'
    ? `<strong>${verb} ${t.qty} ${sym} at ${t.limitPrice > 0 ? fmtTick(t.limitPrice) : '—'} limit</strong><span class="shares-detail">At the limit or better, not past it. Today only.</span>`
    : `<strong>${verb} ${t.qty} ${sym}</strong><span class="shares-detail">Market order, today</span>`;
  const from = atMarket(t.entryType) ? `From ${t.customEntry ? 'planned ' : ''}entry ${fmtTick(t.entry)}` : `From the stop entry ${at}`;
  const note = t.entryNote && !atMarket(t.entryType) ? ` (${esc(t.entryNote)})` : '';
  // a limit's risk is at its price, the worst it fills; the plan it was sized on follows
  const limited = t.entryType === 'LIMIT' && !t.limitError;
  const risk = limited ? `<span class="shares-loss">${fmt$(t.fillRisk)}</span><span class="shares-detail">If it fills at the limit; planned ${fmt$(t.plannedRisk)} ${from.toLowerCase()}</span>`
    : null;
  const side = t.isLong ? 'ask' : 'bid', quoteSide = t.isLong ? t.ask : t.bid;
  const fillsNow = quoteSide > 0 && (t.isLong ? t.limitPrice >= quoteSide : t.limitPrice <= quoteSide);
  const limitHint = !limited ? ''
    : fillsNow ? `At or through the ${side} ${fmtTick(quoteSide)}, so it likely fills right away, at ${fmtTick(t.limitPrice)} or better. `
    : `Waits until the price comes to ${fmtTick(t.limitPrice)}. If it hasn't filled by the close, it ends and the stop never goes in. `;
  const worst = t.entryType === 'STOP_LIMIT' && !t.limitError ? `. Up to ${fmt$(t.fillRisk)} filled at the limit` : '';
  const hint = t.entryType === 'STOP' ? 'The entry and the stop both turn into market orders when they trigger, so a fast move can fill past either.'
    : t.entryType === 'STOP_LIMIT' ? 'The entry never fills past its limit, so a fast break can leave it unfilled. A triggered stop becomes a market order, so a gap can fill past it.'
    : 'A triggered stop becomes a market order, so a gap can fill past it.';
  return `<dl class="trade-legs">
      <div><dt>Entry</dt><dd>${entry}</dd></div>
      <div><dt>Then stop</dt><dd><strong>${t.isLong ? 'Sell' : 'Buy to cover'} ${t.qty} at ${fmtTick(t.stop)}</strong><span class="shares-detail">Stop order, placed once the ${t.isLong ? 'buy' : 'short'} fills</span></dd></div>
      <div><dt>Stop lasts</dt><dd><div class="seg" role="group" aria-label="Stop lasts">${duration('DAY', 'Today')}${duration('GOOD_TILL_CANCEL', 'Until canceled')}</div></dd></div>
      <div><dt>Risk at stop</dt><dd>${risk || `<span class="shares-loss">${fmt$(t.plannedRisk)}</span><span class="shares-detail">${from}${note}${worst}</span>`}</dd></div>
      <div><dt>Reviewed at</dt><dd>${market}</dd></div>
    </dl>
    ${t.limitError ? `<p class="trade-warn" role="alert">${esc(t.limitError)}</p>` : ''}
    ${t.warnings.map(w => `<p class="trade-warn">${esc(w)}</p>`).join('')}
    <p class="hint">${esc(limitHint)}${hint}${t.isLong ? '' : ' Shorting needs margin and shares to borrow.'}</p>
    ${t.order ? `<details class="hint-details"><summary>Order sent to Schwab</summary><pre class="trade-json">${esc(JSON.stringify(t.order, null, 2))}</pre></details>` : ''}`;
}

// ---------- boot ----------

/** take a Schwab callback's code out of the address bar (Google's return keeps its own, for initCloud) */
export function stripSchwabCallback(href) {
  const url = new URL(href);
  if (url.searchParams.get('login') === 'google' || !url.searchParams.get('code')) return;
  globalThis.history?.replaceState(null, '', url.pathname + url.hash);
}

export async function initSchwab(href = location.href) {
  updateSchwabUi();
  refreshSchwabCallback(); // a worker whose callback is this app hides the paste box
  // a login finished in another tab shows up here, and a new day's account size comes in
  window.addEventListener('focus', () => { updateSchwabUi(); dailyAccountSize(); maybeCapture(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) updateSchwabBanner(); }); // the home-screen app comes back without a focus event
  const url = new URL(href);
  // Google's return through Supabase carries a code too: not ours
  if (url.searchParams.get('login') !== 'google' && url.searchParams.get('code')) {
    // the app as its own callback page: drop the code from the address, then finish the login
    globalThis.history?.replaceState(null, '', url.pathname + url.hash);
    if (await finishSchwab(url.search, true)) openSheet('settings');
  } else dailyAccountSize();
  state.schwabBannerReady = true;
  updateSchwabBanner();
}
