// Schwab Trader API through the size-calc-schwab worker, which holds the app secret, swaps codes for tokens,
// and relays /trader/v1 calls. Login tokens are device-local: not in CLOUD_KEYS, so never in the account. Only the worker URL syncs.
import { state } from '../state.js';
import { store } from '../lib/store.js';

export const SCHWAB_KEYS = ['schwab_proxy', 'schwab_tokens', 'schwab_accounts', 'schwab_account', 'schwab_oauth_state', 'schwab_stop_duration', 'schwab_acct_size', 'schwab_acct_source'];
const REFRESH_LIFE = 7 * 24 * 60 * 60 * 1000; // Schwab ends a login seven days after it starts; refreshes don't extend it

export function schwabProxy() { return (store.get('schwab_proxy') || '').trim().replace(/\/+$/, ''); }

export function proxyOk(url) { return /^https:\/\/[^/\s]+/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url); }

function readTokens() { try { return JSON.parse(store.get('schwab_tokens') || 'null'); } catch(e) { return null; } }

/** a live login, or null once the seven days are up */
export function schwabSession() {
  const t = readTokens();
  return t && t.refresh && t.refreshExp > Date.now() ? t : null;
}

export function schwabAccounts() { try { return JSON.parse(store.get('schwab_accounts') || '[]'); } catch(e) { return []; } }

export function schwabAccount() {
  const hash = store.get('schwab_account');
  return schwabAccounts().find(a => a.hash === hash) || null;
}

export function schwabConnected() { return !!(schwabSession() && schwabAccount()); }

/** how long a stop placed from here lasts: Today or Until canceled (the default) */
export function schwabStopDuration() { return store.get('schwab_stop_duration') === 'DAY' ? 'DAY' : 'GOOD_TILL_CANCEL'; }

// the worker URL and your preferences outlast a logout
const KEPT = ['schwab_proxy', 'schwab_stop_duration', 'schwab_acct_source'];
export function schwabDisconnect() { SCHWAB_KEYS.filter(k => !KEPT.includes(k)).forEach(k => store.del(k)); }

// Schwab's errors come as { message, errors: [...] }, { error, error_description }, or nothing at all
export function schwabMessage(body, status) {
  const errs = Array.isArray(body?.errors) ? body.errors.map(e => typeof e === 'string' ? e : e?.detail || e?.title || e?.message).filter(Boolean) : [];
  const parts = [body?.message, ...errs, body?.error_description].filter(Boolean);
  return parts.length ? [...new Set(parts)].join(' ') : `Schwab returned ${status}.`;
}

/** an answer from Schwab (or the worker) that said no; status tells it apart from a network failure */
function schwabError(body, status) {
  const err = new Error(schwabMessage(body, status));
  err.status = status;
  return err;
}

async function readJson(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch(e) { return { message: text.slice(0, 200) }; }
}

async function tokenCall(path, payload) {
  const res = await fetch(schwabProxy() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await readJson(res);
  if (!res.ok || !body?.access_token) throw schwabError(body, res.status);
  return body;
}

function saveTokens(j, refreshExp) {
  const t = { access: j.access_token, accessExp: Date.now() + (Number(j.expires_in) || 1800) * 1000, refresh: j.refresh_token, refreshExp };
  store.set('schwab_tokens', JSON.stringify(t));
  return t;
}

/** the code Schwab put in the callback address, swapped for tokens by the worker */
export async function schwabExchangeCode(code) {
  const j = await tokenCall('/token', { code });
  if (!j.refresh_token) throw new Error('Schwab sent no refresh token.');
  saveTokens(j, Date.now() + REFRESH_LIFE);
}

async function refreshTokens(t) {
  try {
    const j = await tokenCall('/refresh', { refresh_token: t.refresh });
    return saveTokens({ ...j, refresh_token: j.refresh_token || t.refresh }, t.refreshExp).access;
  } catch(e) {
    // a refused refresh means the login is over; a network blip leaves it in place for the next try
    if (e.status === 400 || e.status === 401) { store.del('schwab_tokens'); throw new Error('Your Schwab login expired. Log in again in Settings.'); }
    throw e;
  }
}

/** a bearer token good for at least two more minutes, refreshing once if needed */
export async function schwabAccessToken() {
  const t = schwabSession();
  if (!t) throw new Error('Log in to Schwab in Settings.');
  if (t.access && t.accessExp - Date.now() > 120000) return t.access;
  if (!state.schwabRefreshing) state.schwabRefreshing = refreshTokens(t).finally(() => { state.schwabRefreshing = null; });
  return state.schwabRefreshing;
}

const READ_TIMEOUT = 15000;

/** one Trader API call, never cached and never retried here, so an order is never sent twice */
export async function schwabApi(path, { method = 'GET', body } = {}) {
  const token = await schwabAccessToken();
  // a read gives up after 15s so a hung call can't leave Refresh dead; an order waits, since giving up wouldn't unsend it
  const ctrl = method === 'GET' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), READ_TIMEOUT) : 0;
  let res;
  try {
    res = await fetch(schwabProxy() + '/trader/v1' + path, {
      method,
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
  } catch(e) {
    if (ctrl && ctrl.signal.aborted) throw new Error(`No answer from Schwab in ${READ_TIMEOUT / 1000} seconds. Try again.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) { // the access token was refused: the next call refreshes first
    const t = readTokens();
    if (t) store.set('schwab_tokens', JSON.stringify({ ...t, accessExp: 0 }));
  }
  return res;
}

/** linked accounts as { hash, last4 }; the full account number is not kept */
export async function schwabFetchAccounts() {
  const res = await schwabApi('/accounts/accountNumbers');
  const body = await readJson(res);
  if (!res.ok || !Array.isArray(body)) throw schwabError(body, res.status);
  const list = body.filter(a => a?.hashValue).map(a => ({ hash: a.hashValue, last4: String(a.accountNumber || '').slice(-4) }));
  store.set('schwab_accounts', JSON.stringify(list));
  if (!list.some(a => a.hash === store.get('schwab_account'))) {
    if (list[0]) store.set('schwab_account', list[0].hash); else store.del('schwab_account');
  }
  return list;
}

function ordersPath() {
  const acct = schwabAccount();
  if (!acct) throw new Error('Pick a Schwab account in Settings.');
  return `/accounts/${encodeURIComponent(acct.hash)}/orders`;
}

const newOrderId = res => { const id = (res.headers.get('Location') || '').match(/\/orders\/(\d+)/); return { orderId: id ? id[1] : '' }; };

/** POST the order to the selected account; Schwab answers 201 with the new id in Location */
export async function schwabPlaceOrder(order) {
  const res = await schwabApi(ordersPath(), { method: 'POST', body: order });
  if (!res.ok) throw schwabError(await readJson(res), res.status);
  return newOrderId(res);
}

/** PUT a new order in place of a working one; Schwab cancels the old one and gives the new one its own id */
export async function schwabReplaceOrder(orderId, order) {
  const res = await schwabApi(`${ordersPath()}/${encodeURIComponent(orderId)}`, { method: 'PUT', body: order });
  if (!res.ok) throw schwabError(await readJson(res), res.status);
  return newOrderId(res);
}

export async function schwabCancelOrder(orderId) {
  const res = await schwabApi(`${ordersPath()}/${encodeURIComponent(orderId)}`, { method: 'DELETE' });
  if (!res.ok) throw schwabError(await readJson(res), res.status);
}

export async function schwabOrder(orderId) {
  const acct = schwabAccount();
  if (!acct || !orderId) return null;
  const res = await schwabApi(`/accounts/${encodeURIComponent(acct.hash)}/orders/${encodeURIComponent(orderId)}`);
  return res.ok ? readJson(res) : null;
}

/** the selected account with its positions and balances */
export async function schwabPositions() {
  const acct = schwabAccount();
  if (!acct) throw new Error('Pick a Schwab account in Settings.');
  const res = await schwabApi(`/accounts/${encodeURIComponent(acct.hash)}?fields=positions`);
  const body = await readJson(res);
  if (!res.ok || !body?.securitiesAccount) throw schwabError(body, res.status);
  return body.securitiesAccount;
}

/** the selected account's balances alone, for the daily account size */
export async function schwabBalances() {
  const acct = schwabAccount();
  if (!acct) throw new Error('Pick a Schwab account in Settings.');
  const res = await schwabApi(`/accounts/${encodeURIComponent(acct.hash)}`);
  const body = await readJson(res);
  if (!res.ok || !body?.securitiesAccount) throw schwabError(body, res.status);
  return body.securitiesAccount;
}

/** orders entered in the last 59 days (Schwab's window is 60), where the working stops are */
export async function schwabRecentOrders(now = Date.now()) {
  const acct = schwabAccount();
  if (!acct) throw new Error('Pick a Schwab account in Settings.');
  const q = new URLSearchParams({ fromEnteredTime: new Date(now - 59 * 86400000).toISOString(), toEnteredTime: new Date(now).toISOString() });
  const res = await schwabApi(`/accounts/${encodeURIComponent(acct.hash)}/orders?${q}`);
  const body = await readJson(res);
  if (!res.ok || !Array.isArray(body)) throw schwabError(body, res.status);
  return body;
}

/** where to send the browser to log in; state ties the callback to this attempt */
export function schwabLoginUrl() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const oauthState = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  store.set('schwab_oauth_state', oauthState);
  return schwabProxy() + '/login?state=' + oauthState;
}

/** the code and state from the callback address, pasted whole or just its query */
export function parseSchwabRedirect(text) {
  const s = String(text || '').trim();
  const q = s.includes('?') ? s.slice(s.indexOf('?') + 1) : s;
  const params = new URLSearchParams(q.split('#')[0]);
  const code = params.get('code');
  return code ? { code, state: params.get('state') || '' } : null;
}
