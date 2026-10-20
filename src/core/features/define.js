// @ts-check
// How a feature is written (docs/journal-features.md): family(...) once per features file, then feature(...) per entry.
// A family carries a version too: bump it when a helper its features share changes, and every one of them restamps.

/**
 * @typedef {{ key: string, name: string, version: number }} FeatureFamily
 * @typedef {{ intraday?: string[], lookback?: number, daily?: string[], dailySessions?: number, session?: 'regular' | 'all', breadth?: boolean }} FeatureNeeds
 *   intraday: symbols whose 5-minute bars on the moment's day it reads ('$self', '$underlying' or a name); lookback: the
 *   weekdays before that day it compares against (the underlying's); daily: symbols whose daily bars it reads, the last
 *   dailySessions before the day (absent = back to the listing); session: the intraday hours it reads; breadth: it
 *   reads the market's breadth (market_breadth). None at all = it reads only the trade itself (its time, its contract).
 * @typedef {number | string | null | { value: number | string | null, note?: string }} FeatureOutput
 *   a number, a word from `values`, or null (unknown); with a note to say how it was found or why it isn't known
 * @typedef {{ key: string, name: string, desc: string, version: number, at: 'entry' | 'exit', needs: FeatureNeeds,
 *   unit?: '%' | 'x' | '$' | '', values?: [string, string][], bins?: number[], family: FeatureFamily,
 *   compute: (ctx: import('./context.js').FeatureContext) => FeatureOutput }} Feature
 *   key: permanent, never reused. name and desc: free to change (nothing restamps). version: bump when what it measures
 *   changes. bins: where Stats will cut it later (part 3); changing them never restamps.
 */

/** @param {FeatureFamily} f @returns {FeatureFamily} */
export const family = f => Object.freeze({ ...f });

/**
 * One feature. Throws on a malformed entry, so a mistake shows the moment the module loads.
 * @param {FeatureFamily} fam @param {Omit<Feature, 'family'>} def @returns {Feature}
 */
export function feature(fam, def) {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(def.key)) throw new Error(`feature key ${def.key}: lowercase letters, digits and _`);
  if (!Number.isInteger(def.version) || def.version < 1) throw new Error(`${def.key}: version is a whole number from 1`);
  if (def.at !== 'entry' && def.at !== 'exit') throw new Error(`${def.key}: at is 'entry' or 'exit'`);
  if (typeof def.compute !== 'function') throw new Error(`${def.key}: compute`);
  return Object.freeze({ unit: '', ...def, family: fam });
}
