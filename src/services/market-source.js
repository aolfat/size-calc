// Where stock and option market data comes from: Tradier with a saved key, else Schwab's market data through the Schwab login; marketFetch takes Tradier's URLs either way and answers in Tradier's form.
import { schwabRequest, tradierBody } from '../core/schwab-market.js';
import { nyDateStr } from '../core/format.js';
import { schwabApi, schwabSession } from './schwab.js';

/** the Tradier key in Settings, '' without one */
export const tradierKey = () => document.getElementById('apiKey')?.value.trim() || '';

/** 'tradier' with a key (it streams, and the key wins when both are there), 'schwab' with only a Schwab login, '' with neither */
export function marketSource() {
  return tradierKey() ? 'tradier' : schwabSession() ? 'schwab' : '';
}

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

const answer = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

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
 * fetch for a Tradier market data URL. With a Tradier key it is fetch. Without one, a Schwab login answers it: the same
 * JSON Tradier would send (core/schwab-market.js), Schwab's status on a refusal, 404 for what Schwab
 * has no stand-in for (the streaming session).
 * @param {string} url @param {RequestInit} [init]
 */
export async function marketFetch(url, init = {}) {
  const signal = withDeadline(init.signal);
  if (marketSource() !== 'schwab') return fetch(url, signal ? { ...init, signal } : init); // the signal ends the body's read too
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
