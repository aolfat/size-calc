// @ts-check
// Stats by a trade feature (docs/journal-features.md, part 3): closed trades split by one feature's stamped value, into
// five even groups or at the feature's own cut points, each group with the same numbers as every Stats table
// (groupStats). Only a stamp from the feature's current version counts; the trades without one are counted apart, as
// unknown (the data was gone) or not stamped yet.
import { featureValueWords, featureVersion } from './features/index.js';
import { groupStats } from './journal-stats.js';

/** how a feature's values are split: even = five groups with about the same number of trades, cuts = its own cut points */
export const FEATURE_GROUP_MODES = /** @type {const} */ (['even', 'cuts']);
const EVEN_GROUPS = 5;

/**
 * @typedef {import('./journal-stats.js').StatTrade} StatTrade
 * @typedef {import('./features/define.js').Feature} Feature
 * @typedef {{ group: string, stats: ReturnType<typeof groupStats> }} FeatureGroup
 */

/** a group's edge in words: the feature's own ('+1.25 ATR', '2.34×', '+3.10%'), a plain number to two places @param {Feature} f @param {number} v */
export function edgeWords(f, v) {
  if (!f.unit) return String(Math.round(v * 100) / 100);
  return featureValueWords(f, v);
}

/**
 * The trades by one feature. Words (a feature with `values`) group by word, in the feature's order. Numbers: even makes
 * up to five groups split at the values a fifth, two fifths... of the way through (a value equal to a split goes to the
 * group above, so equal values never straddle two groups), each named by its own lowest and highest value; cuts makes
 * one group under the first cut point, one between each pair, and one at the last and over. Empty groups are left out.
 * @param {StatTrade[]} trades the closed trades (or the period's slices of them) @param {Record<string, any> | null} stampsByKey
 * @param {Feature} f @param {'even' | 'cuts'} [mode]
 * @returns {{ rows: FeatureGroup[], total: number, valued: number, unknown: number, pending: number }}
 */
export function featureBreakdown(trades, stampsByKey, f, mode = 'even') {
  const v = featureVersion(f);
  /** @type {{ t: StatTrade, value: number | string }[]} */
  const valued = [];
  let unknown = 0, pending = 0;
  for (const t of trades) {
    const s = stampsByKey?.[t.key]?.[f.key];
    if (!s || s.v !== v) pending++;
    else if (s.value === null || s.value === undefined) unknown++;
    else valued.push({ t, value: s.value });
  }
  const counts = { total: trades.length, valued: valued.length, unknown, pending };
  /** @param {string} group @param {StatTrade[]} ts @returns {FeatureGroup} */
  const row = (group, ts) => ({ group, stats: groupStats(ts) });
  if (f.values?.length) {
    const rows = f.values.map(([k, name]) => row(name, valued.filter(x => x.value === k).map(x => x.t))).filter(r => r.stats.trades);
    return { rows, ...counts };
  }
  const nums = valued.filter(x => typeof x.value === 'number').map(x => ({ t: x.t, value: /** @type {number} */ (x.value) })).sort((a, b) => a.value - b.value);
  if (!nums.length) return { rows: [], ...counts };
  const cuts = mode === 'cuts' && f.bins?.length ? [...f.bins].sort((a, b) => a - b) : null;
  /** @type {number[]} */
  let edges;
  if (cuts) edges = cuts;
  else {
    const k = Math.min(EVEN_GROUPS, new Set(nums.map(x => x.value)).size);
    // each split between the trade before it and the next; inside a run of equal values it moves up to the next value
    const split = (/** @type {number} */ at) => nums.slice(at).find(x => x.value > nums[at - 1].value)?.value;
    edges = [...new Set(Array.from({ length: k - 1 }, (_, i) => split(Math.max(1, Math.floor(nums.length * (i + 1) / k)))))]
      .filter(/** @returns {e is number} */ e => e !== undefined);
  }
  /** @type {typeof nums[]} */
  const groups = Array.from({ length: edges.length + 1 }, () => []);
  for (const x of nums) groups[edges.filter(e => x.value >= e).length].push(x);
  const rows = groups.map((g, i) => {
    if (!g.length) return null;
    if (cuts) {
      const name = i === 0 ? `Under ${edgeWords(f, cuts[0])}` : i === cuts.length ? `${edgeWords(f, cuts[i - 1])} and over` : `${edgeWords(f, cuts[i - 1])} to ${edgeWords(f, cuts[i])}`;
      return row(name, g.map(x => x.t));
    }
    const lo = g[0].value, hi = g[g.length - 1].value;
    return row(lo === hi ? edgeWords(f, lo) : `${edgeWords(f, lo)} to ${edgeWords(f, hi)}`, g.map(x => x.t));
  }).filter(/** @returns {r is FeatureGroup} */ r => !!r);
  return { rows, ...counts };
}
