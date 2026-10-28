// Schwab Trader API through the size-calc-schwab worker, which holds the app secret, swaps codes for tokens,
// and relays /trader/v1 calls and /marketdata/v1 reads (futures quotes and bars). Signed in, the login is shared by your
// devices through the account (Vault); signed out, it stays on the device. The worker URL syncs as a setting.
import { state } from '../state.js';
import { store } from '../lib/store.js';
import { assertCredentialOrigin, credentialOriginAllowed } from '../lib/credential-origin.js';
import { supabaseClient } from './supabase.js';

export const SCHWAB_KEYS = ['schwab_proxy', 'schwab_tokens', 'schwab_accounts', 'schwab_account', 'schwab_oauth_state', 'schwab_stop_duration', 'schwab_acct_size', 'schwab_acct_source', 'schwab_callback', 'schwab_capture', 'schwab_share_off'];
const REFRESH_LIFE = 7 * 24 * 60 * 60 * 1000; // Schwab ends a login seven days after it starts; refreshes don't extend it

export function schwabProxy() { return (store.get('schwab_proxy') || '').trim().replace(/\/+$/, ''); }

export function proxyOk(url) { return /^https:\/\/[^/\s]+/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url); }

function readTokens() { try { return JSON.parse(store.get('schwab_tokens') || 'null'); } catch(e) { return null; } }
const googleUser = () => state.session?.user?.id || null;
const loginChanged = () => new Error('Your Schwab login changed. Log in again.');

/** a live login, or null once the seven days are up */
export function schwabSession() {
  if (!credentialOriginAllowed()) return null;
  const t = readTokens();
  return t && t.refresh && t.refreshExp > Date.now() && typeof t.connectionId === 'string'
    && Object.hasOwn(t, 'userId') && t.userId === googleUser() && t.proxy === schwabProxy() ? t : null;
}

export function schwabAccounts() { try { return JSON.parse(store.get('schwab_accounts') || '[]'); } catch(e) { return []; } }

export function schwabAccount() {
  const hash = store.get('schwab_account');
  return schwabAccounts().find(a => a.hash === hash) || null;
}

export function schwabConnected() { return !!(schwabSession() && schwabAccount()); }

const ENDING_SOON = 24 * 60 * 60 * 1000; // the banner warns in the login's last day

/**
 * Where this device's Schwab login stands, for the banner: null when Schwab isn't set up here (no worker URL) or the
 * login is fine; 'ending' in its last day (left = ms), 'noAccount', 'off' (ended: a login was kept and is over; else never made)
 */
export function schwabStanding(now = Date.now()) {
  if (!credentialOriginAllowed() || !proxyOk(schwabProxy())) return null;
  const t = schwabSession();
  if (t) {
    if (!schwabAccount()) return { kind: 'noAccount' };
    return t.refreshExp - now < ENDING_SOON ? { kind: 'ending', left: t.refreshExp - now } : null;
  }
  const kept = readTokens();
  // a live login waiting for its Google session (still loading, or offline) isn't over: schwabSession binds it to that user
  if (kept && kept.refreshExp > now && kept.proxy === schwabProxy() && kept.userId && kept.userId !== googleUser()) return null;
  return { kind: 'off', ended: !!kept };
}

/** the worker's callback as last read: { proxy, callback }, kept per worker URL so a new worker is asked again */
export function schwabCallbackCached() {
  try {
    const c = JSON.parse(store.get('schwab_callback') || 'null');
    return c && c.proxy === schwabProxy() && typeof c.callback === 'string' ? c.callback : null;
  } catch(e) { return null; }
}

/** ask the worker where Schwab sends the browser after login. null when it doesn't say (a worker from before /callback) */
export async function schwabFetchCallback() {
  const proxy = schwabProxy();
  const res = await fetch(proxy + '/callback');
  const body = res.ok ? await res.json().catch(() => null) : null;
  const callback = typeof body?.callback === 'string' ? body.callback : null;
  if (callback) store.set('schwab_callback', JSON.stringify({ proxy, callback }));
  else store.del('schwab_callback');
  return callback;
}

/** true when the callback is this app's own page (any trailing slash, query or hash aside), so it finishes the login itself */
export function callbackIsHere(callback, href) {
  try {
    const a = new URL(callback), b = new URL(href);
    const path = u => u.pathname.replace(/\/+$/, '').replace(/\/index\.html$/, '');
    return a.origin === b.origin && path(a) === path(b);
  } catch(e) { return false; }
}

/** how long a stop placed from here lasts: Today or Until canceled (the default) */
export function schwabStopDuration() { return store.get('schwab_stop_duration') === 'DAY' ? 'DAY' : 'GOOD_TILL_CANCEL'; }

// the worker URL and your preferences outlast a logout
const KEPT = ['schwab_proxy', 'schwab_stop_duration', 'schwab_acct_source', 'schwab_callback'];
/** end the login on this device; keepAttempt leaves a login just started here (its state) to finish on the callback page */
export function schwabDisconnect({ keepAttempt = false } = {}) {
  SCHWAB_KEYS.filter(k => !KEPT.includes(k) && !(keepAttempt && k === 'schwab_oauth_state')).forEach(k => store.del(k));
}

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

async function tokenCall(path, payload, proxy = schwabProxy()) {
  assertCredentialOrigin();
  const res = await fetch(proxy + path, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await readJson(res);
  if (!res.ok || !body?.access_token) {
    const err = schwabError(body, res.status);
    if (typeof body?.error === 'string') err.code = body.error; // OAuth's reason, e.g. invalid_grant
    throw err;
  }
  return body;
}

function saveTokens(j, refreshExp, binding) {
  const t = { userId: binding.userId, proxy: binding.proxy, connectionId: binding.connectionId,
    access: j.access_token, accessExp: Date.now() + (Number(j.expires_in) || 1800) * 1000, refresh: j.refresh_token, refreshExp,
    ...(binding.shared ? { shared: true } : {}) };
  store.set('schwab_tokens', JSON.stringify(t));
  return t;
}

// ---------- one login for every device: signed in, the account keeps it in Vault ----------
// Schwab keeps one login per app at a time, so a phone logging in on its own ended the desktop's. `shared` on the
// tokens marks a login the account has had, so an account with none means it was ended everywhere.

const LOGIN_FIELDS = ['proxy', 'connectionId', 'access', 'accessExp', 'refresh', 'refreshExp'];
const loginForm = t => Object.fromEntries(LOGIN_FIELDS.map(k => [k, t[k]]));
/** a kept login this device can use: live, through this device's worker */
const usable = s => !!s && typeof s.refresh === 'string' && typeof s.connectionId === 'string' && s.refreshExp > Date.now() && s.proxy === schwabProxy();
/** a is the newer login: a later one, or the same one renewed later with a new refresh token */
const newer = (a, b) => a.connectionId === b.connectionId ? a.refresh !== b.refresh && a.accessExp > b.accessExp : a.refreshExp > b.refreshExp;
/**
 * this device uses the account's login: signed in, not after Disconnect on this device (until it logs in again), and
 * not while a worker URL the account changed waits for a yes here (the login would go through that worker)
 */
const sharing = () => !!state.session && store.get('schwab_share_off') !== '1'
  && !(store.get('schwab_proxy_confirm') !== null && store.get('schwab_proxy_confirm') === store.get('schwab_proxy'));

async function sharedRpc(name, args) {
  const client = await supabaseClient();
  const res = await client.rpc(name, args);
  if (res?.error) throw new Error(res.error.message || 'Supabase error');
  return res?.data ?? null;
}

function markShared(t) {
  const now = readTokens();
  if (now?.connectionId === t.connectionId && now.refresh === t.refresh && !now.shared) store.set('schwab_tokens', JSON.stringify({ ...now, shared: true }));
}

/**
 * Keep this device's login in the account. expect: the refresh token it renewed from (the account only swaps that one);
 * without it the account takes only a newer login. Quiet when the account can't be reached: the next sync sends it.
 */
async function shareLogin(t, expect = null) {
  if (!sharing() || t.userId !== googleUser()) return;
  try {
    const kept = await sharedRpc('set_schwab_login', { p_login: loginForm(t), p_expect: expect });
    if (kept?.connectionId === t.connectionId && kept.refresh === t.refresh) markShared(t);
  } catch(e) {}
}

let sharedListener = () => {};
/** the UI hears when the account's login replaced or ended this device's @param {() => void} fn */
export function onSchwabShared(fn) { sharedListener = fn; }

/**
 * Line this device's login up with the account's: take the account's when it's newer or this device has none, send
 * this device's when it's newer, and disconnect when the account's was ended on every device. True when this
 * device's login changed.
 */
export async function schwabSyncShared() {
  if (!sharing() || !credentialOriginAllowed() || !proxyOk(schwabProxy())) return false;
  const uid = googleUser();
  const before = store.get('schwab_tokens');
  let kept;
  try { kept = await sharedRpc('get_schwab_login'); } catch(e) { return false; }
  if (googleUser() !== uid || store.get('schwab_tokens') !== before || !sharing()) return false; // the next sync looks again
  const mine = schwabSession();
  let changed = false;
  if (!usable(kept)) {
    if (mine?.shared && !kept) { schwabDisconnect(); changed = true; } // ended on every device, or refused there
    else if (mine) await shareLogin(mine);
  } else if (!mine || newer(kept, mine)) {
    store.set('schwab_tokens', JSON.stringify({ userId: uid, ...loginForm(kept), shared: true }));
    if (!schwabAccount()) await schwabFetchAccounts().catch(() => {});
    changed = true;
  } else if (newer(mine, kept)) await shareLogin(mine, mine.connectionId === kept.connectionId ? kept.refresh : null);
  else markShared(mine);
  if (changed) sharedListener();
  return changed;
}

/** Disconnect on every device: the account's login goes, then this device's. False when the account couldn't be reached */
export async function schwabDisconnectEverywhere() {
  let ok = true;
  if (state.session) { try { await sharedRpc('clear_schwab_login'); } catch(e) { ok = false; } }
  schwabDisconnect();
  return ok;
}

/** Disconnect on this device only: it stops using the account's login until it logs in to Schwab again */
export function schwabDisconnectHere() {
  schwabDisconnect();
  if (state.session) store.set('schwab_share_off', '1');
}

/** the code Schwab put in the callback address, swapped for tokens by the worker */
export async function schwabExchangeCode(code) {
  const binding = { userId: googleUser(), proxy: schwabProxy(), connectionId: crypto.randomUUID() };
  const attempt = store.get('schwab_oauth_state');
  const j = await tokenCall('/token', { code }, binding.proxy);
  if (binding.userId !== googleUser() || binding.proxy !== schwabProxy() || attempt !== store.get('schwab_oauth_state')) throw loginChanged();
  if (!j.refresh_token) throw new Error('Schwab sent no refresh token.');
  schwabDisconnect(); // and a Disconnect on this device ends: logging in here shares again
  await shareLogin(saveTokens(j, Date.now() + REFRESH_LIFE, binding)); // the other devices pick it up
}

const freshAccess = t => !!t?.access && t.accessExp - Date.now() > 120000;

// one refresh at a time across this origin's tabs: two tabs spending the same refresh token at once could see one
// refused and end a login the other just renewed
function refreshTokens(connectionId) {
  const run = () => refreshOnce(connectionId, false);
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request('schwab-refresh', run) : run();
}

async function refreshOnce(connectionId, retried) {
  const t = schwabSession();
  if (t?.connectionId !== connectionId) throw loginChanged();
  if (freshAccess(t)) return t.access; // another tab refreshed while this one waited
  // a logout or a new login while the refresh was out wins: its answer is neither saved nor allowed to end that login
  const same = () => schwabSession()?.connectionId === connectionId && readTokens()?.refresh === t.refresh;
  let j;
  try {
    j = await tokenCall('/refresh', { refresh_token: t.refresh }, t.proxy);
  } catch(e) {
    if (!same()) {
      const now = schwabSession(); // another tab renewed it meanwhile: its tokens stand
      if (now?.connectionId === connectionId && freshAccess(now)) return now.access;
      throw loginChanged();
    }
    // a network blip leaves the login in place for the next try
    if (e.status !== 400 && e.status !== 401) throw e;
    // refused: another device may have logged in again (ending this login) or renewed it, so take the account's
    if (!retried && await schwabSyncShared()) {
      const now = schwabSession();
      if (now) return freshAccess(now) ? now.access : refreshOnce(now.connectionId, true);
    }
    // the login is over: here, and in the account if it's still the one kept there
    store.del('schwab_tokens');
    if (state.session) sharedRpc('set_schwab_login', { p_login: null, p_expect: t.refresh }).catch(() => {});
    throw new Error(`Your Schwab login expired${e.code ? ` (Schwab: ${e.code})` : ''}. Log in again in Settings.`);
  }
  if (!same()) throw loginChanged();
  const saved = saveTokens({ ...j, refresh_token: j.refresh_token || t.refresh }, t.refreshExp, t);
  // a new refresh token goes to the account in place of the one it came from (quietly: the call shouldn't wait)
  if (saved.refresh !== t.refresh || !saved.shared) shareLogin(saved, saved.shared ? t.refresh : null);
  return saved.access;
}

/** an error from before any request reached Schwab: nothing went out, so there is nothing to check there */
function notSent(e) {
  e.notSent = true;
  return e;
}

/** a bearer token good for at least two more minutes, refreshing once if needed */
export async function schwabAccessToken() {
  const t = schwabSession();
  if (!t) throw new Error('Log in to Schwab in Settings.');
  if (freshAccess(t)) return t.access;
  if (!state.schwabRefreshing) state.schwabRefreshing = refreshTokens(t.connectionId).finally(() => { state.schwabRefreshing = null; });
  return state.schwabRefreshing;
}

const READ_TIMEOUT = 15000;

/**
 * One Trader API call (base '/marketdata/v1' for a market data read), never cached and never retried here, so an order
 * is never sent twice; a login that fails first is tagged notSent.
 */
export async function schwabApi(path, { method = 'GET', body, base = '/trader/v1' } = {}) {
  let token;
  try { token = await schwabAccessToken(); } catch(e) { throw notSent(e); }
  // the login the token belongs to (the account's, when the refresh took it): anything else changed meanwhile
  const connection = schwabSession();
  if (!connection || connection.access !== token) throw notSent(loginChanged());
  // a read gives up after 15s so a hung call can't leave Refresh dead; an order waits, since giving up wouldn't unsend it
  const ctrl = method === 'GET' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), READ_TIMEOUT) : 0;
  let res;
  try {
    res = await fetch(connection.proxy + base + path, {
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
    if (t && t.access === token) store.set('schwab_tokens', JSON.stringify({ ...t, accessExp: 0 }));
  }
  if (schwabSession()?.connectionId !== connection.connectionId) throw loginChanged();
  return res;
}

/** linked accounts as { hash, last4 }; the full account number is not kept */
export async function schwabFetchAccounts() {
  const connectionId = schwabSession()?.connectionId;
  const res = await schwabApi('/accounts/accountNumbers');
  const body = await readJson(res);
  if (schwabSession()?.connectionId !== connectionId) throw loginChanged();
  if (!res.ok || !Array.isArray(body)) throw schwabError(body, res.status);
  const list = body.filter(a => a?.hashValue).map(a => ({ hash: a.hashValue, last4: String(a.accountNumber || '').slice(-4) }));
  store.set('schwab_accounts', JSON.stringify(list));
  if (!list.some(a => a.hash === store.get('schwab_account'))) {
    if (list[0]) store.set('schwab_account', list[0].hash); else store.del('schwab_account');
  }
  return list;
}

/**
 * The selected account's path. A ticket passes the account it was reviewed for (hash): when another one is selected now,
 * nothing goes out, so a step can never land in an account nobody reviewed it for.
 * @param {string} [hash]
 */
function accountPath(hash) {
  const acct = schwabAccount();
  if (!acct) throw notSent(new Error('Pick a Schwab account in Settings.'));
  if (hash && hash !== acct.hash) throw notSent(new Error('You switched Schwab accounts since this was reviewed.'));
  return `/accounts/${encodeURIComponent(acct.hash)}`;
}

const newOrderId = res => { const id = (res.headers.get('Location') || '').match(/\/orders\/(\d+)/); return { orderId: id ? id[1] : '' }; };

/** POST the order to the account (hash: the one it was reviewed for); Schwab answers 201 with the new id in Location */
export async function schwabPlaceOrder(order, hash) {
  const res = await schwabApi(accountPath(hash) + '/orders', { method: 'POST', body: order });
  if (!res.ok) throw schwabError(await readJson(res), res.status);
  return newOrderId(res);
}

/** PUT a new order in place of a working one; Schwab cancels the old one and gives the new one its own id */
export async function schwabReplaceOrder(orderId, order, hash) {
  const res = await schwabApi(`${accountPath(hash)}/orders/${encodeURIComponent(orderId)}`, { method: 'PUT', body: order });
  if (!res.ok) throw schwabError(await readJson(res), res.status);
  return newOrderId(res);
}

export async function schwabCancelOrder(orderId, hash) {
  const res = await schwabApi(`${accountPath(hash)}/orders/${encodeURIComponent(orderId)}`, { method: 'DELETE' });
  if (!res.ok) throw schwabError(await readJson(res), res.status);
}

/** one order as Schwab shows it now, or null when it can't be read */
export async function schwabOrder(orderId, hash) {
  if (!orderId) return null;
  let path;
  try { path = accountPath(hash); } catch(e) { return null; }
  const res = await schwabApi(`${path}/orders/${encodeURIComponent(orderId)}`);
  return res.ok ? readJson(res) : null;
}

/** the selected account with its positions and balances */
export async function schwabPositions(hash) {
  const res = await schwabApi(`${accountPath(hash)}?fields=positions`);
  const body = await readJson(res);
  if (!res.ok || !body?.securitiesAccount) throw schwabError(body, res.status);
  return body.securitiesAccount;
}

/** the selected account's balances alone, for the daily account size */
export async function schwabBalances(hash) {
  const res = await schwabApi(accountPath(hash));
  const body = await readJson(res);
  if (!res.ok || !body?.securitiesAccount) throw schwabError(body, res.status);
  return body.securitiesAccount;
}

/** orders entered in the last 59 days (Schwab's window is 60), where the working stops are */
export async function schwabRecentOrders(now = Date.now(), hash) {
  const q = new URLSearchParams({ fromEnteredTime: new Date(now - 59 * 86400000).toISOString(), toEnteredTime: new Date(now).toISOString() });
  const res = await schwabApi(`${accountPath(hash)}/orders?${q}`);
  const body = await readJson(res);
  if (!res.ok || !Array.isArray(body)) throw schwabError(body, res.status);
  return body;
}

/**
 * TRADE transactions between two times. Schwab decides how far back this reaches (sources say 60 days or a year);
 * the journal spike's export tries several ranges to find out.
 * @param {number} from ms @param {number} to ms @param {string} [hash]
 */
export async function schwabTransactions(from, to, hash) {
  const q = new URLSearchParams({ startDate: new Date(from).toISOString(), endDate: new Date(to).toISOString(), types: 'TRADE' });
  const res = await schwabApi(`${accountPath(hash)}/transactions?${q}`);
  const body = await readJson(res);
  if (!res.ok || !Array.isArray(body)) throw schwabError(body, res.status);
  return body;
}

/** a market data read through the worker's relay: Schwab's body, or its refusal as an error with the status */
async function marketData(path) {
  const res = await schwabApi(path, { base: '/marketdata/v1' });
  const body = await readJson(res);
  if (!res.ok) throw schwabError(body, res.status);
  return body;
}

/**
 * One futures ticker's quote ('/MES' answers with the active contract, '/MESZ26' with that month). A worker from before
 * the market data relay answers 404, a Schwab app without Market Data Production 401 or 403.
 * @param {string} symbol
 */
export function schwabFuturesQuote(symbol) {
  return marketData(`/quotes?${new URLSearchParams({ symbols: symbol, fields: 'quote,reference' })}`);
}

/**
 * A futures ticker's 5-minute candles over the last `days` days, overnight included (Schwab's price history body).
 * @param {string} symbol @param {number} [days] @param {number} [now]
 */
export function schwabFuturesBars(symbol, days = 8, now = Date.now()) {
  const q = new URLSearchParams({
    symbol, periodType: 'day', frequencyType: 'minute', frequency: '5',
    startDate: String(now - days * 864e5), endDate: String(now), needExtendedHoursData: 'true',
  });
  return marketData(`/pricehistory?${q}`);
}

/** a futures ticker's daily candles over the last year (Schwab's price history body) @param {string} symbol */
export function schwabFuturesDaily(symbol) {
  const q = new URLSearchParams({ symbol, periodType: 'year', period: '1', frequencyType: 'daily', frequency: '1' });
  return marketData(`/pricehistory?${q}`);
}

/** where to send the browser to log in; state ties the callback to this attempt */
export function schwabLoginUrl() {
  assertCredentialOrigin();
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
