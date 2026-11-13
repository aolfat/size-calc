// @ts-check
// How good the exits and stops were, by group (owner request: by setup), pure: each closed trade's after-the-exit read
// (core/trade-page.js afterExit), stop check (stopCheck) and excursions, added up per label the way statsByLabel does
// (a trade counts in each of its groups). The caller reads them from the saved bars; nothing here reads state.
import { countedTrades } from './journal-stats.js';

/** @typedef {import('./journal-stats.js').StatTrade} StatTrade
 * @typedef {{ score: number | null, verdict: string | null, held: number | null, heldR: number | null }} AfterRead
 * @typedef {{ stopped: boolean, verdict: string }} StopRead
 * @typedef {{ after?: AfterRead | null, stop?: StopRead | null, maeR?: number | null } | null | undefined} TradeRead
 * @typedef {{ trades: number, judged: number, score: number | null, good: number, early: number, late: number, stopped: number,
 *   winners: number, cut: number, cutMore: number, cutR: number | null, held: number | null, heldR: number | null,
 *   stopOuts: number, shaken: number, dip80: number | null, pending: number }} ExitStats */

const round2 = (/** @type {number} */ v) => Math.round(v * 100) / 100;

/**
 * One group's exits and stops over its closed trades. read(t): undefined while it's still being read (pending), null
 * with nothing to read (no bars).
 * - score: the average exit score; good, early, late, stopped: how many of each verdict.
 * - winners, cut: closed winners, and the ones sold too early (verdict early and holding on would have made more);
 *   cutMore and cutR what holding on would have added on them (R when every one has it).
 * - held, heldR: holding on with the stops against the exits, over every trade with a hold (plus: holding made more).
 * - stopOuts, shaken: stop-outs, and the ones that came back to the entry.
 * - dip80: with three or more winners, how far against you 80% of them went no further than (R).
 * @param {StatTrade[]} trades closed, counted @param {(t: StatTrade) => TradeRead} read @returns {ExitStats}
 */
export function exitStats(trades, read) {
  const reads = trades.map(t => ({ t, r: read(t) }));
  const after = reads.filter(x => x.r?.after && x.r.after.score !== null);
  const verdict = (/** @type {string} */ v) => after.filter(x => x.r?.after?.verdict === v).length;
  const winners = reads.filter(x => x.t.pnl > 0 && x.r?.after);
  const cut = winners.filter(x => x.r?.after?.verdict === 'early' && /** @type {number} */ (x.r?.after?.held) > 0);
  const cutRs = cut.map(x => x.r?.after?.heldR).filter(v => v !== null && v !== undefined);
  const holds = reads.filter(x => x.r?.after && x.r.after.held !== null && x.r.after.held !== undefined);
  const holdRs = holds.map(x => x.r?.after?.heldR).filter(v => v !== null && v !== undefined);
  const stops = reads.filter(x => x.r?.stop?.stopped);
  const depths = reads.filter(x => x.t.pnl > 0).map(x => x.r?.maeR).filter(v => v !== null && v !== undefined).map(v => /** @type {number} */ (v)).sort((a, b) => b - a);
  const sum = (/** @type {number[]} */ xs) => round2(xs.reduce((n, x) => n + x, 0));
  return {
    trades: trades.length, judged: after.length, pending: reads.filter(x => x.r === undefined).length,
    score: after.length ? Math.round((after.reduce((n, x) => n + /** @type {number} */ (x.r?.after?.score), 0) / after.length) * 1000) / 1000 : null,
    good: verdict('good'), early: verdict('early'), late: verdict('late'), stopped: verdict('stopped'),
    winners: winners.length, cut: cut.length, cutMore: sum(cut.map(x => /** @type {number} */ (x.r?.after?.held))),
    cutR: cut.length && cutRs.length === cut.length ? sum(/** @type {number[]} */ (cutRs)) : null,
    held: holds.length ? sum(holds.map(x => /** @type {number} */ (x.r?.after?.held))) : null,
    heldR: holds.length && holdRs.length === holds.length ? sum(/** @type {number[]} */ (holdRs)) : null,
    stopOuts: stops.length, shaken: stops.filter(x => x.r?.stop?.verdict === 'shaken').length,
    dip80: depths.length >= 3 ? depths[Math.ceil(depths.length * 0.8) - 1] : null,
  };
}

/**
 * exitStats per label over the closed trades: a trade counts in each of its groups, most trades first (statsByLabel's way),
 * order's groups first in its order.
 * @param {StatTrade[]} trades @param {(t: StatTrade) => string[]} keysOf @param {(t: StatTrade) => TradeRead} read @param {string[]} [order]
 * @returns {{ group: string, stats: ExitStats }[]}
 */
export function exitStatsByLabel(trades, keysOf, read, order = []) {
  /** @type {Map<string, StatTrade[]>} */
  const by = new Map();
  for (const t of countedTrades(trades)) for (const k of new Set(keysOf(t))) { if (!by.has(k)) by.set(k, []); /** @type {StatTrade[]} */ (by.get(k)).push(t); }
  const at = (/** @type {string} */ g) => { const i = order.indexOf(g); return i < 0 ? order.length : i; };
  return [...by].map(([group, ts]) => ({ group, stats: exitStats(ts, read) }))
    .sort((a, b) => at(a.group) - at(b.group) || b.stats.trades - a.stats.trades);
}
