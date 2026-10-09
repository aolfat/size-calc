// Tradier REST: base URL and auth headers from the settings inputs (saveKey keeps storage in step on every keystroke), and daily history.
import { nyDateStr } from '../core/format.js';

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
export async function dailyHistory(symbol) {
  const from = new Date();
  from.setDate(from.getDate() - 380); // ~1 year: the daily charts use it all, HV percentile needs the year, ADR/HV20 use the tail
  const url = `${baseUrl()}/markets/history?symbol=${encodeURIComponent(symbol)}&interval=daily&start=${nyDateStr(from)}&end=${nyDateStr(new Date())}`;
  const res = await fetch(url, { headers: headers() });
  const days = (await res.json())?.history?.day;
  return days ? (Array.isArray(days) ? days : [days]) : [];
}
