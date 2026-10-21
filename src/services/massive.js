// Massive (formerly Polygon) market data (docs/journal-features.md): the key and the plan (device-local in localStorage,
// never synced; Settings → Massive API key and plan), every US-listed common stock's ticker and every US stock's daily
// bar on a date in one call (the grouped daily bars, for the market breadth), and one symbol's 5-minute aggregates (the
// paid plans' years of intraday history, through services/bar-source.js). The free plan allows 5 calls a minute and two
// years back and posts a day after it ends; the paid plans have no limit. Pacing is the caller's (`pace` runs before
// each request). Never touches the page.
import { barsReach, MASSIVE_PLANS } from '../core/bars.js';
import { store } from '../lib/store.js';

const BASE = 'https://api.massive.com';

export const massiveKey = () => (store.get('massive_key') || '').trim();
export const massiveKeyHere = () => !!massiveKey();
/** the plan chosen in Settings (MASSIVE_PLANS' key): 'free' until one is picked */
export const massivePlan = () => { const p = store.get('massive_plan') || ''; return Object.hasOwn(MASSIVE_PLANS, p) ? p : 'free'; };
/** a key and a paid plan: calls aren't paced, and the plan's years of 5-minute bars are used */
export const massivePaid = () => massiveKeyHere() && MASSIVE_PLANS[massivePlan()].paid;
/** how far back 5-minute bars reach on this device: Tradier's window, widened by a paid Massive plan with a key @param {number} now */
export const deviceBarsReach = now => barsReach(now, massiveKeyHere() ? massivePlan() : null);

/** @param {string} url @returns {Promise<any>} */
async function get(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${massiveKey()}` } });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json())?.error || ''; } catch(e) { /* not JSON */ }
    const err = new Error(res.status === 401 ? 'Massive refused the key' : res.status === 429 ? 'Massive: too many requests' : msg || `Massive answered ${res.status}`);
    /** @type {any} */ (err).status = res.status;
    throw err;
  }
  return res.json();
}

/** every US stock's daily bar on a New York day, split-adjusted: { resultsCount, results: [{ T, o, h, l, c, v }] } @param {string} day */
export const massiveGrouped = day => get(`${BASE}/v2/aggs/grouped/locale/us/market/stocks/${day}?adjusted=true`);

/** every active US-listed common stock's ticker (type CS), page by page @param {() => Promise<void>} pace */
export async function massiveCommonStocks(pace) {
  const out = [];
  let url = `${BASE}/v3/reference/tickers?market=stocks&type=CS&active=true&limit=1000`;
  for (let page = 0; url && page < 30; page++) {
    await pace();
    const body = await get(url);
    for (const r of body?.results || []) if (typeof r?.ticker === 'string') out.push(r.ticker);
    url = typeof body?.next_url === 'string' && body.next_url.startsWith(BASE + '/') ? body.next_url : '';
  }
  return out;
}

/**
 * One ticker's 5-minute aggregates from one New York day through another, unadjusted (Tradier's timesales aren't), page
 * by page: [{ t, o, h, l, c, v }], t the bar's start in epoch ms. Options as 'O:' + the OCC symbol (core/bars.js
 * massiveTicker). Massive answers up to 50,000 bars a page and links the next.
 * @param {string} ticker @param {string} from @param {string} to
 */
export async function massiveFiveMinute(ticker, from, to) {
  const out = [];
  let url = `${BASE}/v2/aggs/ticker/${ticker.split(':').map(encodeURIComponent).join(':')}/range/5/minute/${from}/${to}?adjusted=false&sort=asc&limit=50000`;
  for (let page = 0; url && page < 20; page++) {
    const body = await get(url);
    for (const r of body?.results || []) out.push(r);
    url = typeof body?.next_url === 'string' && body.next_url.startsWith(BASE + '/') ? body.next_url : '';
  }
  return out;
}
