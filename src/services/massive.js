// Massive (formerly Polygon) market data, for the market breadth (docs/journal-features.md): the key (device-local in
// localStorage, never synced; Settings → Massive API key), every US-listed common stock's ticker, and every US stock's
// daily bar on a date in one call (the grouped daily bars). The free plan allows 5 calls a minute and two years back and
// posts a day after it ends; pacing is the caller's (`pace` runs before each request). Never touches the page.
import { store } from '../lib/store.js';

const BASE = 'https://api.massive.com';

export const massiveKey = () => (store.get('massive_key') || '').trim();
export const massiveKeyHere = () => !!massiveKey();

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
