// Where the journal's bars come from: one provider at a time behind barSource, so moving off Tradier is a new provider
// here and nothing else. Every provider answers in the app's own form (core/bars.js barsByDay): symbols as the OCC symbol
// without its padding ('AAPL261218C00245000', a stock as itself), New York days, each bar stamped with its START in New
// York time ('09:30' = 9:30 to 9:35), [time, open, high, low, close, volume] rows. A provider whose symbols or stamps
// differ translates them here. Its name goes on every saved row (bars_5m.source). Daily bars come through here too (the
// trade features' EMAs, gaps and all-time highs): { date, open, high, low, close, volume }, oldest first, not saved,
// since every provider serves them back years any time. A future's bars always come from Schwab (Tradier has no
// futures), whichever provider the rest use: its 5-minute bars for the contract traded ('/MNQZ26'), named 'schwab' when
// saved; its daily bars for its continuous root ('/MNQZ26' reads '/MNQ', the front month as it rolled, so its averages
// have history), at most 20 years back (Schwab takes dates from 1970 on, so 'back to the listing' can't go to 1960).
import { barsByDay } from '../core/bars.js';
import { futuresDays, futuresSymbol, futuresTimesales } from '../core/futures.js';
import { schwabFuturesBarsBetween, schwabFuturesHistory, schwabSession } from './schwab.js';

/** a futures read needs the Schwab login: refused like a provider's 401 otherwise, so what needs it waits */
function needSchwab() {
  if (schwabSession()) return;
  const err = new Error('Futures bars need the Schwab login');
  err.status = 401;
  throw err;
}
import { baseUrl, headers } from './tradier.js';
import { marketFetch, marketSource } from './market-source.js';

/**
 * Tradier: timesales already speaks the app's form (unpadded OCC symbols, bars stamped with their start, New York time).
 * Without a Tradier key the same reads go to Schwab's price history (services/market-source.js answers them in Tradier's
 * form), and the rows say so: name is 'schwab' then. Schwab has no price history for options, so an option's bars wait
 * for a Tradier key.
 */
const tradier = {
  get name() { return marketSource() === 'schwab' ? 'schwab' : 'tradier'; },
  /** the provider a symbol's saved bars name: a future's are always Schwab's @param {string} symbol */
  sourceFor(symbol) { return futuresSymbol(symbol) ? 'schwab' : this.name; },
  /**
   * one symbol's 5-minute bars from one New York day through another, extended hours included (04:00 to 20:00)
   * @param {string} symbol @param {string} from @param {string} to @returns {Promise<Map<string, (string | number)[][]>>}
   */
  async intraday(symbol, from, to) {
    if (futuresSymbol(symbol)) {
      needSchwab();
      return barsByDay(futuresTimesales(await schwabFuturesBarsBetween(symbol, from, to)).filter(b => b.time.slice(0, 10) >= from && b.time.slice(0, 10) <= to));
    }
    const url = `${baseUrl()}/markets/timesales?symbol=${encodeURIComponent(symbol)}&interval=5min&start=${encodeURIComponent(from + ' 04:00')}&end=${encodeURIComponent(to + ' 20:00')}&session_filter=all`;
    const res = await marketFetch(url, { headers: headers() });
    if (!res.ok) { const err = new Error(`${this.name === 'schwab' ? 'Schwab' : 'Tradier'} answered ${res.status}`); err.status = res.status; throw err; }
    const data = (await res.json())?.series?.data;
    return barsByDay(data ? (Array.isArray(data) ? data : [data]) : []);
  },
  /**
   * one symbol's daily bars from one New York day through another, oldest first ([] = none). Tradier's docs say the
   * history usually reaches back to the listing, and don't say whether it's adjusted for splits: the features that
   * compare it with the day's own prices line the two up first (core/features/context.js dailyBasis).
   * @param {string} symbol @param {string} from @param {string} to
   * @returns {Promise<{ date: string, open: number, high: number, low: number, close: number, volume: number }[]>}
   */
  async daily(symbol, from, to) {
    const future = futuresSymbol(symbol);
    if (future) {
      needSchwab();
      const floor = `${Number(to.slice(0, 4)) - 20}${to.slice(4)}`, start = from > floor ? from : floor;
      return futuresDays(await schwabFuturesHistory(`/${future.root}`, start, to)).filter(d => d.date >= start && d.date <= to);
    }
    const url = `${baseUrl()}/markets/history?symbol=${encodeURIComponent(symbol)}&interval=daily&start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}`;
    const res = await marketFetch(url, { headers: headers() });
    if (!res.ok) { const err = new Error(`${this.name === 'schwab' ? 'Schwab' : 'Tradier'} answered ${res.status}`); err.status = res.status; throw err; }
    const days = (await res.json())?.history?.day;
    return (days ? (Array.isArray(days) ? days : [days]) : [])
      .map(d => ({ date: String(d?.date || ''), open: +d?.open, high: +d?.high, low: +d?.low, close: +d?.close, volume: +d?.volume || 0 }))
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && [d.open, d.high, d.low, d.close].every(v => Number.isFinite(v) && v > 0))
      .sort((a, b) => a.date.localeCompare(b.date));
  },
};

/** the provider in use */
export const barSource = tradier;
