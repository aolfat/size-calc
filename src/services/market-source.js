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

const answer = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** gives up with an AbortError when the caller's signal fires, like fetch would */
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const stop = () => reject(new DOMException('Aborted', 'AbortError'));
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
  if (marketSource() !== 'schwab') return fetch(url, init);
  const req = schwabRequest(url, typeof init.body === 'string' ? init.body : null);
  if (!req) return answer({ fault: 'Schwab has no stand-in for this read.' }, 404);
  const res = await abortable(schwabApi(req.path, { base: '/marketdata/v1' }), init.signal);
  let body = null;
  try { body = await res.json(); } catch (e) {}
  if (!res.ok) return answer(body ?? {}, res.status);
  const out = tradierBody(req, body);
  if (req.kind === 'history') await withToday(req, out, init.signal);
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
    if (e?.name === 'AbortError') throw e;
  }
}
