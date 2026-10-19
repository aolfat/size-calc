// Where the journal's bars come from: one provider at a time behind barSource, so moving off Tradier is a new provider
// here and nothing else. Every provider answers in the app's own form (core/bars.js barsByDay): symbols as the OCC symbol
// without its padding ('AAPL261218C00245000', a stock as itself), New York days, each bar stamped with its START in New
// York time ('09:30' = 9:30 to 9:35), [time, open, high, low, close, volume] rows. A provider whose symbols or stamps
// differ translates them here. Its name goes on every saved row (bars_5m.source).
import { barsByDay } from '../core/bars.js';
import { baseUrl, headers } from './tradier.js';

/** Tradier: timesales already speaks the app's form (unpadded OCC symbols, bars stamped with their start, New York time) */
const tradier = {
  name: 'tradier',
  /**
   * one symbol's 5-minute bars from one New York day through another, extended hours included (04:00 to 20:00)
   * @param {string} symbol @param {string} from @param {string} to @returns {Promise<Map<string, (string | number)[][]>>}
   */
  async intraday(symbol, from, to) {
    const url = `${baseUrl()}/markets/timesales?symbol=${encodeURIComponent(symbol)}&interval=5min&start=${encodeURIComponent(from + ' 04:00')}&end=${encodeURIComponent(to + ' 20:00')}&session_filter=all`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) { const err = new Error(`Tradier answered ${res.status}`); err.status = res.status; throw err; }
    const data = (await res.json())?.series?.data;
    return barsByDay(data ? (Array.isArray(data) ? data : [data]) : []);
  },
};

/** the provider in use */
export const barSource = tradier;
