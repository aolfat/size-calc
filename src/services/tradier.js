// Tradier REST: base URL and auth headers from the settings inputs (saveKey keeps storage in step on every keystroke), and daily history.
import { nyDateStr } from '../core/format.js';
import { marketFetch } from './market-source.js';

export function baseUrl() {
  const env = document.getElementById('apiEnv').value;
  return env === 'sandbox' ? 'https://sandbox.tradier.com/v1' : 'https://api.tradier.com/v1';
}

export function headers() {
  return {
    'Authorization': 'Bearer ' + document.getElementById('apiKey').value.trim(),
    'Accept': 'application/json'
  };
}

/** about a year of daily bars, oldest first, today's forming bar included; [] when Tradier has none */
export async function dailyHistory(symbol, back = 380) {
  const from = new Date();
  from.setDate(from.getDate() - back); // ~1 year: the daily charts use it all, HV percentile needs the year, ADR/HV20 use the tail (the Size tab's pane asks for more, for its 200 SMA)
  const url = `${baseUrl()}/markets/history?symbol=${encodeURIComponent(symbol)}&interval=daily&start=${nyDateStr(from)}&end=${nyDateStr(new Date())}`;
  const res = await marketFetch(url, { headers: headers() });
  const days = (await res.json())?.history?.day;
  return days ? (Array.isArray(days) ? days : [days]) : [];
}

/** a session id for the streaming socket (good for 5 minutes until the socket uses it); throws without one */
export async function streamSession() {
  const res = await fetch(`${baseUrl()}/markets/events/session`, { method: 'POST', headers: headers() });
  const id = (await res.json())?.stream?.sessionid;
  if (!res.ok || typeof id !== 'string' || !id) throw new Error('No stream session');
  return id;
}
