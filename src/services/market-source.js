// Where stock and option market data comes from: Tradier with a saved key, else Schwab's market data through the Schwab login; marketFetch takes Tradier's URLs either way and answers in Tradier's form.
// With both, a Tradier read that fails (no answer, a timeout, 401, 403, 429 or 5xx) is asked of Schwab instead, and Tradier rests a minute before it's tried again.
import { schwabRequest, tradierBody } from '../core/schwab-market.js';
import { nyDateStr } from '../core/format.js';
import { isOccSymbol } from '../core/options.js';
import { state } from '../state.js';
import { schwabApi, schwabSession } from './schwab.js';

/** the Tradier key in Settings, '' without one */
export const tradierKey = () => document.getElementById('apiKey')?.value.trim() || '';

/** 'tradier' with a key (it streams, and the key wins when both are there), 'schwab' with only a Schwab login, '' with neither */
export function marketSource() {
  return tradierKey() ? 'tradier' : schwabSession() ? 'schwab' : '';
}

/** how long Tradier rests after a failed read, while Schwab answers for it */
export const TRADIER_REST_MS = 60000;
let fallbackListener = (/** @type {boolean} */ out) => {};

/** the UI's seam: told true when Schwab starts answering for Tradier, false when Tradier answers again @param {(out: boolean) => void} fn */
export function onMarketFallback(fn) { fallbackListener = fn; }

/** true while Tradier is failing and a Schwab login answers for it */
export function tradierFallingBack() { return state.tradierOut && marketSource() === 'tradier' && !!schwabSession(); }

/** the source answering right now: marketSource, except 'schwab' while it answers for a failing Tradier */
export function marketSourceNow() { return tradierFallingBack() ? 'schwab' : marketSource(); }

/** a Tradier answer that says Tradier can't serve right now (a missing symbol's 400 or 404 is not one) @param {number} status */
const tradierFailed = status => status === 401 || status === 403 || status === 429 || status >= 500;

function tradierDown() {
  state.tradierRestUntil = Date.now() + TRADIER_REST_MS;
  if (state.tradierOut) return;
  state.tradierOut = true;
  fallbackListener(true);
}

function tradierUp() {
  state.tradierRestUntil = 0;
  if (!state.tradierOut) return;
  state.tradierOut = false;
  fallbackListener(false);
}

/** forgets a Tradier failure (tests, and a new key) */
export function resetMarketFallback() { state.tradierRestUntil = 0; state.tradierOut = false; }

/** what a cache of market data is keyed on: the key, 'schwab', or '' when nothing can be read */
export function marketKey() {
  const source = marketSource();
  return source === 'tradier' ? tradierKey() : source;
}

/**
 * A refused Schwab market data read in words that say what to fix ('' for a status that says nothing about the setup):
 * 404 is a worker from before the market data relay, 401 or 403 a Schwab app without Market Data Production.
 * @param {number} status
 */
export function schwabRefusal(status) {
  if (status === 404) return 'Your Schwab worker can\'t read market data yet. Redeploy it (worker/schwab/README.md).';
  if (status === 401 || status === 403) return 'Schwab refused the market data. Check that your Schwab app has Market Data Production, then log in to Schwab again.';
  return '';
}

/** an answer made from Schwab's, marked so a reader can tell it from Tradier's own */
const answer = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Market-Source': 'schwab' } });

/**
 * a market data read gives up after this long, its body included: a stalled request (a phone back from the background,
 * a dropped connection) would otherwise leave Load spinning and Live waiting for good
 */
export const MARKET_TIMEOUT = 15000;

/** the caller's signal, plus the deadline (a TimeoutError); the caller's alone where the browser can't combine them */
export function withDeadline(signal) {
  const S = globalThis.AbortSignal;
  if (typeof S?.timeout !== 'function') return signal;
  const deadline = S.timeout(MARKET_TIMEOUT);
  if (!signal) return deadline;
  return typeof S.any === 'function' ? S.any([signal, deadline]) : signal;
}

/** an error in words: a read that ran out of time says so @param {any} e */
export function marketError(e) {
  return e?.name === 'TimeoutError' ? `No answer in ${MARKET_TIMEOUT / 1000} seconds. Check your connection and try again.` : String(e?.message || e);
}

/** gives up with the signal's reason (an AbortError, or the deadline's TimeoutError) when it fires, like fetch would */
function abortable(promise, signal) {
  if (!signal) return promise;
  const why = () => signal.reason ?? new DOMException('Aborted', 'AbortError');
  if (signal.aborted) return Promise.reject(why());
  return new Promise((resolve, reject) => {
    const stop = () => reject(why());
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/**
 * fetch for a Tradier market data URL. With a Tradier key it is fetch, and Schwab answers instead when Tradier fails and
 * a Schwab login has a stand-in for the read. Without a key, a Schwab login answers it: the same JSON Tradier would send
 * (core/schwab-market.js), Schwab's status on a refusal, 404 for what Schwab has no stand-in for (the streaming session).
 * @param {string} url @param {RequestInit} [init]
 */
export async function marketFetch(url, init = {}) {
  const source = marketSource();
  if (source === 'schwab') return schwabFetch(url, init);
  const spare = source === 'tradier' && !!schwabSession() && standsIn(url, init);
  if (spare && Date.now() < state.tradierRestUntil) {
    const res = await schwabFetch(url, init).catch(e => { state.tradierRestUntil = 0; throw e; });
    if (!res.ok) state.tradierRestUntil = 0; // Schwab can't answer either: the next read tries Tradier again
    return res;
  }
  const signal = withDeadline(init.signal);
  const ask = signal ? { ...init, signal } : init; // the signal ends the body's read too
  if (!spare) return fetch(url, ask);
  let failed = /** @type {Response | null} */ (null), thrown = null;
  try {
    const res = await fetch(url, ask);
    if (!tradierFailed(res.status)) {
      if (res.ok) tradierUp();
      return res;
    }
    failed = res;
  } catch (e) {
    if (init.signal?.aborted) throw e; // the caller gave up: not Tradier's failure
    thrown = e;
  }
  // Schwab answers for Tradier; when it can't either, Tradier's own failure stands and nothing rests
  let res = null;
  try { res = await schwabFetch(url, init); } catch (e) { if (init.signal?.aborted) throw e; }
  if (res?.ok) { tradierDown(); return res; }
  if (failed) return failed;
  throw thrown;
}

/**
 * true when Schwab can answer this Tradier read in Tradier's place: it has a stand-in, and it isn't an option's bars,
 * which Schwab's price history doesn't carry (an empty answer there would read as a day with no trades)
 * @param {string} url @param {RequestInit} init
 */
function standsIn(url, init) {
  const req = schwabRequest(url, typeof init.body === 'string' ? init.body : null);
  if (!req) return false;
  if (req.kind !== 'timesales' && req.kind !== 'history') return true;
  return !isOccSymbol(String(new URL(url).searchParams.get('symbol') || '').toUpperCase());
}

/** a Tradier URL answered from Schwab's market data, in Tradier's form @param {string} url @param {RequestInit} init */
async function schwabFetch(url, init) {
  const signal = withDeadline(init.signal);
  const req = schwabRequest(url, typeof init.body === 'string' ? init.body : null);
  if (!req) return answer({ fault: 'Schwab has no stand-in for this read.' }, 404);
  // the deadline covers the login's renewal and the body too, which schwabApi's own timeout doesn't
  const res = await abortable(schwabApi(req.path, { base: '/marketdata/v1' }), signal);
  let body = null;
  try { body = await abortable(res.json(), signal); } catch (e) { if (signal?.aborted) throw e; }
  if (!res.ok) return answer(body ?? {}, res.status);
  const out = tradierBody(req, body);
  if (req.kind === 'history') await withToday(req, out, signal);
  return answer(out);
}

/**
 * Tradier's daily history ends with today's forming bar; Schwab's may not carry it until the close, so a read that
 * reaches today adds one from the quote's open, high, low and last when the quote traded today.
 */
async function withToday(req, out, signal) {
  const today = nyDateStr(new Date());
  const days = out.history?.day || [];
  if (req.end < today || days.at(-1)?.date === today) return;
  try {
    const quote = schwabRequest(`https://schwab.invalid/v1/markets/quotes?symbols=${encodeURIComponent(req.symbol)}`);
    if (!quote) return;
    const res = await abortable(schwabApi(quote.path, { base: '/marketdata/v1' }), signal);
    if (!res.ok) return;
    const q = tradierBody(quote, await res.json()).quotes?.quote;
    if (!q || Array.isArray(q) || !(q.trade_date > 0) || nyDateStr(new Date(q.trade_date)) !== today) return;
    if (![q.open, q.high, q.low, q.last].every(v => v > 0)) return;
    out.history = { day: [...days, { date: today, open: q.open, high: q.high, low: q.low, close: q.last, volume: q.volume || 0 }] };
  } catch (e) {
    if (signal?.aborted) throw e;
  }
}
