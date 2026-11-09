// Schwab trading: the connect section in Settings, the shares card's trade button, and the order review sheet (an option entry
// shares the sheet and its ticket slot, but its ticket, checks and send are ui/option-trade.js's).
// The sheet freezes one ticket when it opens, for the account selected then; Place re-checks it against a fresh quote,
// then sends exactly that payload once and never retries it. A limit entry still waiting moves through Positions' Edit.
// The setup and entry tactic picks, and the plan kept once the order goes, are ui/order-plan.js.
// A share order card (ui/share-orders.js) opens the same review for its own ticker, quote and stop.
import { state } from '../state.js';
import { fmt$, marketEscape as esc } from '../core/format.js';
import { defaultEntryLimit, entryLimitError, fmtTick, inRegularHours, limitEntryError, priceTick, quoteLimit, sharesBaseError, sharesStopOrder, sharesTicketError, stopEntryError, stopTick } from '../core/orders.js';
import { unitsFor } from '../core/sizing.js';
import { fmtPositionPrice } from '../core/positions.js';
import { store } from '../lib/store.js';
import { callbackIsHere, parseSchwabRedirect, proxyOk, schwabAccount, schwabCallbackCached, schwabAccounts, schwabConnected, schwabDisconnectEverywhere, schwabDisconnectHere, schwabExchangeCode, schwabFetchAccounts, schwabFetchCallback, schwabLoginUrl, schwabAccessToken, schwabOrder, schwabPlaceOrder, schwabWarm, schwabProxy, schwabSession, schwabStanding, schwabStopDuration, onSchwabShared } from '../services/schwab.js';
import { dailyAccountSize, updateAccountSourceUi } from './account-size.js';
import { showError, showToast } from './feedback.js';
import { positionsAccountChanged } from './positions.js';
import { sharesPlan } from './shares.js';
import { orbEntryName } from './orb.js';
import { loadPlanChoices, planContext, riskContext, saveTradePlan, startTradePlan, tradePlanHtml } from './order-plan.js';
import { cardPlan, refreshShareOrderQuote, renderShareOrderCard, renderShareOrderCards, updatePinSharesButton } from './share-orders.js';
import { inZone } from '../lib/zone.js';
import { showSheetQuote, watchSheetQuote } from './sheet-quote.js';
import { openSheet } from './sheets.js';
import { updateApiStatus } from './settings.js';
import { riskDollars } from './risk.js';
import { rawStop } from './stops.js';
import { drawQuote, refreshQuote, tradierQuote } from './ticker.js';
import { maybeCapture, scheduleCloseCapture } from './schwab-capture.js';

const TRADE_LABEL = 'Trade at Schwab';
export const mask = last4 => '••' + last4;
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
  renderShareOrderCards(); // their Trade at Schwab follows the login
  updateAccountSourceUi();
  updateSchwabBanner();
  updateApiStatus(); // without a Tradier key, the Schwab login is what loads quotes
  const here = globalThis.location;
  if (here?.origin && /^https?:/.test(here.protocol)) document.getElementById('schwabCallbackHint').textContent = here.origin + here.pathname.replace(/index\.html$/, '');
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
  updatePinSharesButton();
  if (show || Object.values(state.pinnedData).some(d => d.kind === 'shares')) loadPlanChoices(); // the review's setups, read before it opens
}

// ---------- review sheet ----------

const ENTRY_TYPES = ['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'];
const atMarket = type => type === 'MARKET' || type === 'LIMIT'; // sized from the planned entry, its stop checked against the market
const LIMIT_PICKS = ['mid', 'ask', 'bid'];
// the stop entry you picked last (Stop or Stop limit), on this device
const savedStopEntry = () => store.get('schwab_entry_type') === 'STOP' ? 'STOP' : 'STOP_LIMIT';

/**
 * the order exactly as the card sizes it right now, with what could go wrong spelled out. A planned entry past the market
 * (over the ask on a long, under the bid on a short: a breakout) starts as the stop entry you picked last, anything else at market.
 * A limit is never where a review starts; picked, it starts at the planned entry. A stop entry can be picked any time: its trigger
 * starts at the planned entry when that's past the market, else blank, and a typed trigger re-sizes the shares to the max loss.
 */
export function buildTradeTicket(now = Date.now()) {
  const plan = sharesPlan();
  return ticketFromPlan(plan, state.quoteData, { customEntry: rawStop('entryPrice') > 0, entryNote: orbEntryName(), planCtx: planContext(plan.isLong, plan.stop) }, now);
}

/**
 * A share order card's order, sized as the card shows it now against its own fresh quote. What the calculator knew comes from
 * when it was pinned, and the max loss and account from now, since the card sizes from them.
 */
export function buildCardTicket(cardId, now = Date.now()) {
  const d = state.pinnedData[cardId];
  const plan = cardPlan(d);
  const planCtx = { ...d.planCtx, ...riskContext(), stop_planned: Number.isFinite(plan.stop) ? plan.stop : null };
  return ticketFromPlan(plan, d.quote, { customEntry: !!d.customEntry, entryNote: d.entryNote, planCtx, cardId }, now);
}

/** a ticket for a plan in sharesPlan's shape, on quote q; a breakout entry starts on the stop entry you picked last */
function ticketFromPlan(plan, q, { customEntry, entryNote, planCtx, cardId = '' }, now) {
  const { isLong, entry, shares: qty } = plan;
  const stop = plan.valid ? stopTick(plan.stop, isLong) : NaN;
  const acct = schwabAccount();
  const entryStop = entry > 0 ? priceTick(entry) : 0;
  const breakout = customEntry && !stopEntryError({ isLong, entryStop, bid: q.bid, ask: q.ask, last: q.last });
  return ticketFor({
    symbol: q.symbol, qty, isLong, stop, entry, customEntry, entryNote, stopDuration: schwabStopDuration(), hash: acct ? acct.hash : '', valid: plan.valid,
    entryType: breakout ? savedStopEntry() : 'MARKET', entryStop, entryLimit: entryStop > 0 ? defaultEntryLimit(entryStop, isLong) : 0,
    limitPrice: entry > 0 ? priceTick(entry) : 0, budget: riskDollars(),
    setups: [], tactics: [], planCtx, cardId,
  }, q, now);
}

/** the quote a ticket was reviewed on, to re-plan it (a new entry type or limit) without moving it to a newer one */
const reviewedQuote = t => ({ type: t.quoteType, bid: t.bid, ask: t.ask, last: t.last });

/**
 * The shares a stop entry sends: the calculator's at its planned entry, else what the max loss buys from the trigger to the stop
 * (never under one share: an unfillable size keeps the plan's, and the risk row shows what it risks).
 */
function stopEntryQty(p) {
  const per = p.isLong ? p.entryStop - p.stop : p.stop - p.entryStop;
  if (!(p.entryStop > 0) || p.entryStop === priceTick(p.planEntry) || !(per > 0) || !(p.budget > 0)) return p.planQty;
  return unitsFor(p.budget, per) || p.planQty;
}

/**
 * A ticket for these frozen terms (symbol, size, stop, entry and its order type, the account it goes to) against quote q.
 * flags name the warnings, so a re-check before sending can tell a new one from one already reviewed. limitError is a price
 * that can't work (a limit entry's, a stop entry's trigger, a stop limit's limit): shown in the sheet, it holds the order back
 * until it's fixed. planEntry and planQty are what the calculator sized; a stop entry's trigger may re-size from its budget.
 * entryStatus and filled are what Schwab showed of the entry once sent.
 */
function ticketFor(p, q, now) {
  const { symbol, isLong, stop, entryType, entryStop, entryLimit, limitPrice } = p;
  const planEntry = p.planEntry ?? p.entry, planQty = p.planQty ?? p.qty;
  const stopEntry = !atMarket(entryType);
  const qty = stopEntry ? stopEntryQty({ ...p, planEntry, planQty }) : planQty;
  const terms = { symbol, type: q.type, qty, isLong, stop, bid: q.bid, ask: q.ask, last: q.last, entryType, entryStop };
  // a stop entry's trigger is typed in the sheet, so one that can't work holds the order back instead of closing the review
  const error = !p.valid ? 'No valid stop on the card. Fix the stop first.' : stopEntry ? sharesBaseError(terms) : sharesTicketError(terms);
  const limitError = stopEntry ? sharesTicketError(terms) || (entryType === 'STOP_LIMIT' ? entryLimitError({ isLong, entryStop, entryLimit }) : '')
    : entryType === 'LIMIT' ? limitEntryError({ isLong, stop, limit: limitPrice }) : '';
  // where it's likely to fill: a market order at the ask (bid), a limit no worse than its price, a stop at its stop, a stop limit no worse than its limit
  const fill = entryType === 'STOP' ? entryStop : entryType === 'STOP_LIMIT' ? entryLimit : entryType === 'LIMIT' ? limitPrice : (isLong ? q.ask : q.bid) || q.last || planEntry;
  const at = atMarket(entryType) ? planEntry : entryStop; // what the shares were sized from
  const perShare = px => isLong ? px - stop : stop - px;
  const t = {
    symbol, qty, isLong, stop, entry: at, fill, bid: q.bid || 0, ask: q.ask || 0, last: q.last || 0, quoteType: q.type,
    customEntry: p.customEntry, entryNote: p.entryNote || '', stopDuration: p.stopDuration, hash: p.hash, valid: p.valid,
    entryType, entryStop, entryLimit, limitPrice, limitError, limitAt: p.limitAt || '', planEntry, planQty, budget: p.budget || 0,
    plannedRisk: qty * perShare(at), fillRisk: qty * perShare(fill),
    error, order: null, warnings: [], flags: [], sent: false, orderId: '', result: null, entryStatus: '', filled: 0,
    // the picks and what the calculator knew go with every re-plan; the saved plan's id comes once it's sent
    setups: p.setups || [], tactics: p.tactics || [], setupOrder: p.setupOrder || null, planCtx: p.planCtx || null, picksTouched: !!p.picksTouched, prefilled: !!p.prefilled, planId: '',
    cardId: p.cardId || '', // the share order card it came from; '' for the shares card
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

/**
 * The quote again for the symbol under review, or null when no fresh one came in: the loaded ticker's (the calculator
 * re-renders with it; draw false holds the card, chain and chart redraw for later, drawQuote), or a share order card's own
 * (the card redraws with it).
 */
async function freshQuote(symbol, cardId = '', draw = true) {
  if (cardId) {
    // a card removed while its review is open still gets its re-check, from the ticker's own quote
    const q = state.pinnedData[cardId] ? await refreshShareOrderQuote(cardId).catch(() => null) : await tradierQuote(symbol, false).catch(() => null);
    if (q) renderShareOrderCard(cardId);
    return q && q.symbol === symbol ? q : null;
  }
  let ok = false;
  try { ok = await refreshQuote(draw); } catch(e) {}
  return ok === true && state.quoteData?.symbol === symbol ? state.quoteData : null;
}

/** busy starts or ends: the shares card's button and every order card's follow */
function busyChanged() {
  updateTradeButton();
  renderShareOrderCards();
}

/** the review's live bid and ask, when it was read for this ticket's symbol within LIVE_FRESH: good enough to recheck against without another read */
const LIVE_FRESH = 3000;
function liveQuote(t, now) {
  const s = state.sheetQuote;
  if (!s || s.sheet !== 'trade' || s.failed || !s.at || now - s.at > LIVE_FRESH || s.legs.length !== 1 || s.legs[0].symbol !== t.symbol) return null;
  return { symbol: t.symbol, type: t.quoteType, bid: s.bid, ask: s.ask, last: s.last };
}

const secs = ms => (ms / 1000).toFixed(1) + 's';
/** 'Sent in 0.7s: live quote, login 0.3s, Schwab 0.4s' */
export function timingWords(m) {
  const parts = [m.quote === null ? 'live quote' : 'quote ' + secs(m.quote), ...(m.login >= 50 ? ['login ' + secs(m.login)] : []), 'Schwab ' + secs(m.schwab)];
  return `Sent in ${secs(m.total)}: ${parts.join(', ')}.`;
}

export async function openTrade() {
  if (state.tradeBusy || !state.quoteData) return;
  if (!schwabConnected()) { showError('Connect Schwab in Settings first.'); openSheet('settings'); return; }
  const symbol = state.quoteData.symbol;
  const btn = document.getElementById('sharesTrade');
  state.tradeBusy = true;
  btn.disabled = true;
  btn.textContent = 'Checking quote…';
  renderShareOrderCards();
  let fresh = null;
  try { fresh = await freshQuote(symbol); } finally {
    state.tradeBusy = false;
    btn.textContent = TRADE_LABEL;
    busyChanged();
  }
  if (!state.quoteData || state.quoteData.symbol !== symbol) { showError('The ticker changed. Check the card, then try again.'); return; }
  if (!fresh) { showError(`Could not refresh the ${symbol} quote, so there is nothing to review yet. Try again.`); return; }
  showReview(buildTradeTicket(), fresh);
}

/** a share order card's Trade at Schwab: the same review, for the card's ticker on a quote read for it now */
export async function openCardTrade(cardId) {
  const d = state.pinnedData[cardId];
  if (state.tradeBusy || !d || d.kind !== 'shares') return;
  if (!schwabConnected()) { showError('Connect Schwab in Settings first.'); openSheet('settings'); return; }
  state.tradeBusy = true;
  d.checking = true;
  busyChanged();
  let fresh = null;
  try { fresh = await freshQuote(d.symbol, cardId); } finally {
    state.tradeBusy = false;
    d.checking = false;
    busyChanged();
  }
  if (state.pinnedData[cardId] !== d) return; // removed while the quote came
  if (!fresh) { showError(`Could not refresh the ${d.symbol} quote, so there is nothing to review yet. Try again.`); return; }
  showReview(buildCardTicket(cardId), fresh);
}

/** a card's sent order: its review again, with ↻ Status */
export function openCardOrder(cardId) {
  const t = state.pinnedData[cardId]?.lastOrder?.ticket;
  if (!t) return;
  state.tradeTicket = t;
  renderTradeSheet();
  openSheet('trade');
  watchTradeQuote(t, state.pinnedData[cardId].quote);
}

function showReview(t, q) {
  state.tradeTicket = t;
  state.tradeSetupQuery = '';
  startTradePlan(t);
  renderTradeSheet();
  openSheet('trade');
  schwabWarm(t.hash, { post: true }); // the login, the connection and the browser's permission to post, while you review
  watchTradeQuote(t, q);
}

function watchTradeQuote(t, q) {
  // the live bid and ask over it, from the quote just read; the side a market order fills on is lit (the ask on a buy, the bid on a short)
  watchSheetQuote({ sheet: 'trade', el: 'tradeQuote', legs: [{ symbol: t.symbol, n: 1 }], first: q,
    fills: () => { const t = state.tradeTicket; return t && !t.error ? (t.isLong ? 'ask' : 'bid') : ''; } });
}

export function setTradeStopDuration(d) {
  const t = state.tradeTicket;
  if (!t || t.option || t.error || t.sent || state.tradeBusy || (d !== 'DAY' && d !== 'GOOD_TILL_CANCEL')) return;
  store.set('schwab_stop_duration', d);
  state.tradeTicket = ticketFor({ ...t, stopDuration: d }, reviewedQuote(t), Date.now());
  renderTradeSheet();
}

/**
 * Market | Limit | Stop | Stop limit: the entry's order type. A stop entry whose trigger isn't past the market (the planned
 * entry at the price, with nothing typed) starts blank, with the trigger box focused.
 */
export function setTradeEntryType(type) {
  const t = state.tradeTicket;
  if (!t || t.option || t.error || t.sent || state.tradeBusy || !ENTRY_TYPES.includes(type) || type === t.entryType) return;
  const next = { ...t, entryType: type };
  const blank = !atMarket(type) && !!stopEntryError({ isLong: t.isLong, entryStop: t.entryStop, ...reviewedQuote(t) });
  if (blank) Object.assign(next, { entryStop: 0, entryLimit: 0 });
  if (!atMarket(type)) store.set('schwab_entry_type', type);
  state.tradeTicket = ticketFor(next, reviewedQuote(t), Date.now());
  renderTradeSheet();
  if (blank) /** @type {any} */ (document.getElementById('tradeEntryStop'))?.focus?.();
}

/** redraw what follows the entry row: the details and Place, so a box being typed in keeps its cursor */
function redrawTradeDetail(next) {
  document.getElementById('tradeDetail').innerHTML = tradeDetail(next);
  const place = document.getElementById('tradePlace');
  if (place) { place.disabled = !next.order || state.tradeBusy; place.textContent = placeLabel(next); }
}

/** typing a stop entry's trigger: the shares re-size to it, and a stop limit's limit follows it to its default room */
export function setTradeEntryStop(value) {
  const t = state.tradeTicket;
  if (!t || t.option || t.error || t.sent || state.tradeBusy || atMarket(t.entryType)) return;
  const v = parseFloat(value);
  const entryStop = v > 0 ? priceTick(v) : 0;
  const entryLimit = entryStop > 0 ? defaultEntryLimit(entryStop, t.isLong) : 0;
  const next = ticketFor({ ...t, entryStop, entryLimit }, reviewedQuote(t), Date.now());
  state.tradeTicket = next;
  const box = /** @type {HTMLInputElement | null} */ (document.getElementById('tradeEntryLimit'));
  if (box) box.value = priceText(entryLimit);
  redrawTradeDetail(next);
}

/**
 * Mid | Ask | Bid beside a limit entry's price: the review's live quote when it's fresh for this symbol, else the one reviewed;
 * the mid rounds toward a fill (up on a buy, down on a short). The ticket moves to that quote, as Place's re-check would.
 */
export function setTradeLimitAt(at) {
  const t = state.tradeTicket;
  if (!t || t.option || t.error || t.sent || state.tradeBusy || t.entryType !== 'LIMIT' || !LIMIT_PICKS.includes(at)) return;
  const q = liveQuote(t, Date.now()) || reviewedQuote(t);
  const { price } = quoteLimit(at, q, { buy: t.isLong, option: false });
  if (!(price > 0)) { showError(`No ${at === 'mid' ? 'bid and ask' : at} in the quote to set the limit from.`); return; }
  state.tradeTicket = ticketFor({ ...t, limitPrice: price, limitAt: at }, q, Date.now());
  renderTradeSheet();
}

/** typing a stop limit's limit: re-plans and redraws only the details, so the cursor stays put */
export function setTradeEntryLimit(value) {
  const t = state.tradeTicket;
  if (!t || t.option || t.error || t.sent || state.tradeBusy || t.entryType !== 'STOP_LIMIT') return;
  const v = parseFloat(value);
  const next = ticketFor({ ...t, entryLimit: v > 0 ? priceTick(v) : 0 }, reviewedQuote(t), Date.now());
  state.tradeTicket = next;
  redrawTradeDetail(next);
}

/** typing a limit entry's price: re-plans and redraws only the details and the Place label, so the cursor stays put */
export function setTradeLimit(value) {
  const t = state.tradeTicket;
  if (!t || t.option || t.error || t.sent || state.tradeBusy || t.entryType !== 'LIMIT') return;
  const v = parseFloat(value);
  const next = ticketFor({ ...t, limitPrice: v > 0 ? priceTick(v) : 0, limitAt: '' }, reviewedQuote(t), Date.now());
  state.tradeTicket = next;
  redrawTradeDetail(next);
  document.getElementById('tradeLimitPicks').innerHTML = limitPicks(next); // a typed price is your own: no pick stays lit
}

/** why the reviewed ticket can't go as it is, from a fresh quote (null when none came); '' when it still can */
function recheck(t, fresh) {
  const acct = schwabAccount();
  if (!acct || acct.hash !== t.hash) return { why: 'You switched Schwab accounts since this was reviewed. Nothing was sent. Open the review again.', again: null };
  if (!fresh) return { why: `Could not refresh the ${t.symbol} quote, so nothing was sent. Try again.`, again: null };
  const again = ticketFor(t, fresh, Date.now());
  if (again.error) return { why: again.error + ' Nothing was sent.', again };
  if (!again.order) return { why: again.limitError + ' Nothing was sent.', again }; // a trigger the price broke through: move it, or pick Market
  if (JSON.stringify(again.order) !== JSON.stringify(t.order)) return { why: 'The order changed since you reviewed it. Nothing was sent. Review it, then place again.', again };
  if (again.flags.some(f => !t.flags.includes(f))) return { why: 'The quote moved since you reviewed this. Nothing was sent. Check the warnings, then place again.', again };
  return { why: '', again };
}

export async function placeTrade() {
  const t = state.tradeTicket;
  if (!t || t.option || !t.order || t.sent || state.tradeBusy) return; // an option entry is ui/option-trade.js's
  const how = t.entryType === 'LIMIT' ? ` at ${fmtTick(t.limitPrice)} limit` : t.entryType === 'STOP' ? ` on a stop at ${fmtTick(t.entryStop)}` : t.entryType === 'STOP_LIMIT' ? ` on a stop at ${fmtTick(t.entryStop)}, limit ${fmtTick(t.entryLimit)}` : '';
  let live = false, held = false;
  return sendReviewed(t, {
    // the quote again right before sending: the frozen order goes only while the market still allows it as reviewed.
    // The review's live quote when it's seconds old; else one read, the calculator's redraw held until the order is out
    reread: async () => {
      const q = liveQuote(t, Date.now());
      if (q) { live = true; return q; }
      held = !t.cardId;
      const fresh = await freshQuote(t.symbol, t.cardId, false);
      if (fresh) showSheetQuote('trade', fresh);
      return fresh;
    },
    live: () => live,
    redraw: () => { if (held) { held = false; drawQuote(); } },
    recheck, render: renderTradeSheet,
    sentText: `Order sent: ${t.isLong ? 'buy' : 'short'} ${t.qty} ${t.symbol}${how}, stop ${fmtTick(t.stop)}.`,
  });
}

/**
 * The review sheet's one send, for a shares or an option ticket: read the market again (reread), re-check the frozen order
 * against it (recheck answers why it can't go, and the ticket rebuilt on the new read), then send exactly that payload ONCE to
 * the account it was reviewed for. Nothing retries it; the plan is kept after the send, never in its way.
 * live: the read was the review's own live quote (the timing says so); redraw: what the read held back, run once the order is out.
 * @param {any} t @param {{ reread: () => Promise<any>, recheck: (t: any, read: any) => { why: string, again: any }, render: () => void, sentText: string, live?: () => boolean, redraw?: () => void }} how
 */
export async function sendReviewed(t, { reread, recheck: check, render, sentText, live, redraw }) {
  state.tradeBusy = true;
  t.result = { ok: null, text: 'Checking the quote…' };
  render();
  busyChanged();
  const t0 = Date.now();
  let read = null;
  try { read = await reread(); } catch(e) {}
  const timing = { quote: live && live() ? null : Date.now() - t0, login: 0, schwab: 0, total: 0 };
  const drawn = () => { if (redraw) redraw(); }; // the redraw a read held back, once the order is out (or isn't going)
  const { why, again } = check(t, read);
  if (why) {
    drawn();
    state.tradeBusy = false;
    const next = again || t;
    if (next.error) next.error = why; // a ticket that can't go shows only its reason
    next.result = { ok: false, text: why };
    if (state.tradeTicket === t) state.tradeTicket = next;
    render();
    busyChanged();
    return;
  }
  t.sent = true; // one review, one order: this ticket can't be sent again, and nothing retries it
  t.result = { ok: null, text: 'Sending…' };
  render();
  try {
    const t1 = Date.now();
    // timed on its own; a login that fails here stops the send with its own reason (nothing reached Schwab), never renewed twice
    try { await schwabAccessToken(); } catch(e) { e.notSent = true; throw e; }
    const t2 = Date.now();
    const { orderId } = await schwabPlaceOrder(t.order, t.hash);
    const t3 = Date.now();
    Object.assign(timing, { login: t2 - t1, schwab: t3 - t2, total: t3 - t0 });
    t.timing = timingWords(timing);
    drawn();
    t.orderId = orderId;
    state.tradeLast = { symbol: t.symbol, at: Date.now() };
    t.result = { ok: null, text: `Sent${orderId ? ', order ' + orderId : ''}. Checking status…` };
    cardSent(t); // a share order card's ticket: its card says so (an option ticket has none)
    render();
    showToast(sentText);
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
        cardSent(t, { lost: true });
        await saveTradePlan(t); // with no id: the journal finds its trade by time, if there is one
      }
      t.result = { ok: false, text: e instanceof TypeError ? 'No answer from Schwab. Check your Schwab orders before trying again.' : e.status ? 'Schwab rejected the order. ' + e.message : e.message };
    }
    if (!t.timing) drawn();
  } finally {
    state.tradeBusy = false;
    if (state.tradeTicket === t) render();
    busyChanged();
  }
}

/** the order card a sent ticket came from says so, and keeps the ticket for its status */
function cardSent(t, { lost = false } = {}) {
  const d = t.cardId && state.pinnedData[t.cardId];
  if (!d) return;
  d.lastOrder = { ticket: t, qty: t.qty, isLong: t.isLong, orderId: t.orderId || '', lost, time: inZone(Date.now(), { hour: 'numeric', minute: '2-digit' }) };
  renderShareOrderCard(t.cardId, { force: true });
}

export async function checkTradeStatus() {
  const t = state.tradeTicket;
  if (!t || t.option || !t.orderId || state.tradeBusy) return;
  return refreshTradeStatus(t, renderTradeSheet);
}

/** ↻ Status: one more read of the sent order, for a shares or an option ticket */
export async function refreshTradeStatus(t, render) {
  state.tradeBusy = true;
  render();
  try { await updateTradeStatus(t); } finally {
    state.tradeBusy = false;
    if (state.tradeTicket === t) render();
  }
}

const ENDED = /REJECTED|CANCELED|EXPIRED/;

/** green only when the entry is filled or working and its stop is in place; a stop Schwab refused is said out loud */
export async function updateTradeStatus(t) {
  const o = await schwabOrder(t.orderId, t.hash).catch(() => null);
  if (!o) { t.result = { ok: null, text: `Sent${t.orderId ? ', order ' + t.orderId : ''}. Check Schwab for the fill and the stop.` }; return; }
  const child = o.childOrderStrategies && o.childOrderStrategies[0];
  const entryOk = !ENDED.test(o.status || ''), stopOk = !!(child && child.status) && !ENDED.test(child.status);
  const filled = Number(o.filledQuantity) || (o.orderActivityCollection || []).flatMap(a => a.executionLegs || []).reduce((n, l) => n + (Number(l.quantity) || 0), 0);
  t.entryStatus = o.status || '';
  t.filled = filled;
  let text = orderStatusLine(t, o);
  if (entryOk && child && child.status && !stopOk) {
    text += filled > 0 ? ` Your ${filled} ${t.label || t.symbol} have no stop. Set one in Schwab now.` : ' The stop is not in place. Check Schwab before the entry fills.';
  }
  t.result = { ok: !entryOk || (child && child.status && !stopOk) ? false : stopOk ? true : null, text };
}

/** "Order 123: filled 125 at $247.11. Stop $243.10: working." from Schwab's order record */
export function orderStatusLine(t, o) {
  const word = s => String(s || 'unknown').toLowerCase().replace(/_/g, ' ');
  const legs = (o.orderActivityCollection || []).flatMap(a => a.executionLegs || []);
  const qty = legs.reduce((n, l) => n + (Number(l.quantity) || 0), 0);
  const avg = qty ? legs.reduce((n, l) => n + (Number(l.quantity) || 0) * (Number(l.price) || 0), 0) / qty : 0;
  const px = v => fmtPositionPrice(v, t.option ? 'OPTION' : 'EQUITY'); // option prices in dollars and cents, whatever their size
  let text = `Order ${t.orderId}: ${word(o.status)}`;
  if (avg > 0) text += ` ${qty} at ${px(avg)}`;
  const child = o.childOrderStrategies && o.childOrderStrategies[0];
  if (child && child.status) text += `. Stop ${px(t.stop)}: ${word(child.status)}`;
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
  const past = t.isLong ? t.ask || t.last : t.bid || t.last; // a trigger has to be past this
  const type = (v, label) => `<button class="${t.entryType === v ? 'active' : ''}" aria-pressed="${t.entryType === v}" data-action="setTradeEntryType" data-arg="${v}"${off}>${label}</button>`;
  const box = '<div class="prefix-wrap"><span class="prefix">$</span>', num = 'type="number" step="0.01" min="0" inputmode="decimal" autocomplete="off"';
  const hold = past > 0 ? ` placeholder="${t.isLong ? '&gt;' : '&lt;'} ${fmtTick(past).slice(1)}"` : ''; // the ask (bid) a trigger has to clear
  const limit = t.entryType === 'LIMIT'
    ? `<div class="trade-limit"><label for="tradeLimit">Limit</label>${box}<input id="tradeLimit" ${num} value="${priceText(t.limitPrice)}" data-input="setTradeLimit"${off} /></div><div class="seg limit-picks" id="tradeLimitPicks" role="group" aria-label="Limit at">${limitPicks(t)}</div></div>`
    : atMarket(t.entryType) ? ''
    : `<div class="trade-limit"><label for="tradeEntryStop">Trigger</label>${box}<input id="tradeEntryStop" ${num} value="${priceText(t.entryStop)}"${hold} data-input="setTradeEntryStop"${off} /></div></div>`
      + (t.entryType === 'STOP_LIMIT' ? `<div class="trade-limit"><label for="tradeEntryLimit">Limit</label>${box}<input id="tradeEntryLimit" ${num} value="${priceText(t.entryLimit)}" data-input="setTradeEntryLimit"${off} /></div></div>` : '');
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
    <p class="trade-result${t.result && t.result.ok !== null ? (t.result.ok ? ' ok' : ' bad') : ''}" id="tradeResult" role="status">${t.result ? esc(t.result.text) : ''}</p>
    ${t.timing ? `<p class="hint trade-timing">${esc(t.timing)}</p>` : ''}`;
}

/** Mid | Ask | Bid for a limit entry (the fill-now side second), lit while the price is still the one picked */
function limitPicks(t) {
  const off = t.sent ? ' disabled' : '';
  const fillSide = t.isLong ? 'ask' : 'bid', waitSide = t.isLong ? 'bid' : 'ask';
  const pick = (at, title) => `<button class="${t.limitAt === at ? 'active' : ''}" aria-pressed="${t.limitAt === at}" data-action="setTradeLimitAt" data-arg="${at}" title="${title}"${off}>${at[0].toUpperCase() + at.slice(1)}</button>`;
  return pick('mid', `The mid, rounded ${t.isLong ? 'up' : 'down'} toward a fill`) + pick(fillSide, `The ${fillSide}: likely fills now`) + pick(waitSide, `The ${waitSide}: waits for the price to come to it`);
}

/** everything under the entry order switch: what goes to Schwab, the risk, the warnings and the payload */
function tradeDetail(t) {
  const verb = t.isLong ? 'Buy' : 'Sell short', sym = esc(t.symbol), at = t.entryStop > 0 ? fmtTick(t.entryStop) : '—';
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
  const note = t.entryNote && !atMarket(t.entryType) && t.entryStop === priceTick(t.planEntry) ? ` (${esc(t.entryNote)})` : ''; // the note names the planned entry, not a typed trigger
  const resized = !atMarket(t.entryType) && t.qty !== t.planQty ? `. ${t.qty} shares, re-sized from ${t.planQty} at the trigger` : '';
  // a limit's risk is at its price, the worst it fills; the plan it was sized on follows
  const limited = t.entryType === 'LIMIT' && !t.limitError;
  const risk = limited ? `<span class="shares-loss">${fmt$(t.fillRisk)}</span><span class="shares-detail">If it fills at the limit; planned ${fmt$(t.plannedRisk)} ${from.toLowerCase()}</span>`
    : !atMarket(t.entryType) && !(t.entryStop > 0) ? '<span class="shares-loss">—</span><span class="shares-detail">Set the trigger</span>'
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
      <div><dt>Risk at stop</dt><dd>${risk || `<span class="shares-loss">${fmt$(t.plannedRisk)}</span><span class="shares-detail">${from}${note}${resized}${worst}</span>`}</dd></div>
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { updateSchwabBanner(); maybeCapture(); } }); // the home-screen app comes back without a focus event
  scheduleCloseCapture(); // the day's import just after the close, while the app is open
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
