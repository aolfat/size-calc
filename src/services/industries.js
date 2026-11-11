// The stock universe's industry groups (data/market-universe-*.csv, the Market tab's snapshot): ticker → group, read once
// when the Journal loads (core/industries.js puts each group in its sector). A failed read is asked again next time.
import { industryMap } from '../core/industries.js';
import { MarketData } from '../core/market-data.js';

/** the stock universe the Market tab and the Journal read */
export const UNIVERSE_FILE = 'data/market-universe-2026-09-16.csv';

/** @type {Promise<Map<string, string>> | null} the read under way: two Journal loads at once share it */
let pending = null;

/** ticker → industry group; throws when the file can't be read. The caller keeps the map (state.industries). */
export function loadIndustryMap() {
  if (!pending) {
    pending = (async () => {
      const response = await fetch(UNIVERSE_FILE);
      if (!response.ok) throw new Error('Could not load the industry groups.');
      return industryMap(MarketData.parseCsv(await response.text()));
    })();
    pending.then(() => { pending = null; }, () => { pending = null; });
  }
  return pending;
}
