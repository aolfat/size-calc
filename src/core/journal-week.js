// @ts-check
// Week and month reviews, pure (docs/journal-step-3.md, slice 6): a period's trades in numbers, one set per part of how you
// trade (selection, entry, exits, risk, emotions, the market, preparation, consistency), so the self-assessment is graded
// against what happened rather than a blank box. Results count the exits taken in the period, like the calendar; entry
// habits count the trades opened in it. The caller passes your review (grades, notes, labels, the day's market) and each
// trade's excursions from its saved 5-minute bars; nothing here reads state.
import { fmt$ } from './format.js';
import { countedTrades, groupStats, inPeriod, nyParts, periodKey, underlyingOf } from './journal-stats.js';

/** @typedef {import('./journal-stats.js').StatTrade & { avgEntry?: number, entryQty?: number, multiplier?: number,
 *   schwabStop?: number | null, movedTo?: number | null, rBasis?: string | null }} WeekTrade
 * @typedef {{ mfe: number, mae: number, mfeR: number | null, maeR: number | null, efficiency: number | null }} Excursion
 * @typedef {{ text: string, tone?: 'good' | 'bad' | '' }} Fact
 * @typedef {{ key: string, name: string, facts: Fact[] }} Category
 * @typedef {{
 *   review: (key: string) => { setup_grade?: string | null, plan_followed?: string | null, note?: string | null, entry_note?: string | null } | undefined,
 *   labels: (key: string) => { kind: string, value: string }[],
 *   market: (t: WeekTrade) => string | null,
 *   nameOf: (kind: string, value: string) => string,
 *   excursion: (t: WeekTrade) => Excursion | null | undefined,
 *   reviewed: (t: WeekTrade) => boolean,
 *   saved: (key: string) => boolean,
 *   barsPending?: boolean,
 * }} ReviewContext */

/** the parts of a self-assessment, in the order the review shows them */
export const PERIOD_CATEGORIES = /** @type {[string, string][]} */ ([
  ['selection', 'Trade selection'], ['entry', 'Entry timing'], ['exit', 'Exit discipline'], ['risk', 'Risk management'],
  ['emotion', 'Emotional control'], ['market', 'Market awareness'], ['prep', 'Preparedness'], ['consistency', 'Execution consistency'],
]);
/** which category each default mistake speaks to; your own mistakes go under consistency */
const MISTAKE_CATEGORY = /** @type {Record<string, string>} */ ({ chased: 'entry', exited_early: 'exit', oversized: 'risk', moved_stop: 'risk', skipped_stop: 'risk', revenge: 'emotion' });
/** a trade opened this soon after a losing close counts as one taken on the back of a loss */
export const AFTER_LOSS_MS = 15 * 60000;
/** an entry before this (New York) is an early one */
const EARLY = '09:45';

const round2 = (/** @type {number} */ v) => Math.round(v * 100) / 100;
const signed$ = (/** @type {number} */ v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt$(Math.abs(v))}`;
const signedR = (/** @type {number} */ r) => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)}R`;
/** a share as a signed percent, one decimal under 10% (a stock's move is small): '+3.5%', '−12%' */
const pct = (/** @type {number} */ v) => { const a = Math.abs(v) * 100; return `${v > 0 ? '+' : v < 0 ? '−' : ''}${a < 10 ? a.toFixed(1) : Math.round(a)}%`; };
const plural = (/** @type {number} */ n, /** @type {string} */ word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sum = (/** @type {number[]} */ xs) => xs.reduce((n, x) => n + x, 0);
const avg = (/** @type {number[]} */ xs) => xs.length ? sum(xs) / xs.length : null;
/** 'AAPL, NVDA and 2 more' */
const names = (/** @type {WeekTrade[]} */ ts) => {
  const n = [...new Set([...ts].sort((a, b) => (a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : 0)).map(underlyingOf))];
  return n.length > 3 ? `${n.slice(0, 3).join(', ')} and ${n.length - 3} more` : n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : n[0] || '';
};
/** the cost of the whole entry: price × quantity × multiplier. @param {WeekTrade} t */
const costOf = t => (t.avgEntry || 0) * (t.entryQty || 0) * (t.multiplier || 1);

/** the period before: the week before a week, the month before a month. @param {string} unit @param {string} key */
export function previousPeriod(unit, key) {
  if (unit === 'month') { const [y, m] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); }
  return new Date(Date.parse(`${key}T00:00:00Z`) - 7 * 864e5).toISOString().slice(0, 10);
}

/** a stamp falls in the period. @param {string | null | undefined} iso @param {string} unit @param {string} key */
const inside = (iso, unit, key) => !!iso && periodKey(nyParts(iso).day, unit) === key;

/**
 * The trades a review covers: closed (the period's exits, sliced like the calendar), closedHere (whole trades that closed
 * in it, for excursions), opened (trades opened in it), and every one of them once (all, by key).
 * @param {WeekTrade[]} trades @param {string} unit week | month @param {string} key its Monday or 'YYYY-MM'
 */
export function reviewTrades(trades, unit, key) {
  const live = trades.filter(t => !t.deleted && t.status !== 'history');
  const closed = /** @type {WeekTrade[]} */ (inPeriod(live, unit, key));
  const closedHere = countedTrades(live).filter(t => inside(t.closedAt, unit, key));
  const opened = live.filter(t => inside(t.openedAt, unit, key));
  /** @type {Map<string, WeekTrade>} */
  const all = new Map();
  for (const t of [...opened, ...closedHere]) all.set(t.key, t);
  for (const t of closed) if (!all.has(t.key)) all.set(t.key, /** @type {WeekTrade} */ (live.find(x => x.key === t.key)));
  return { closed, closedHere, opened, all: [...all.values()] };
}

/**
 * Trades grouped by a label (a trade counts in each of its values), with their count, net and R over the period's exits,
 * biggest net first. @param {WeekTrade[]} closed @param {(t: WeekTrade) => string[]} keysOf
 */
function byLabel(closed, keysOf) {
  /** @type {Map<string, WeekTrade[]>} */
  const by = new Map();
  for (const t of closed) for (const k of new Set(keysOf(t))) { if (!by.has(k)) by.set(k, []); /** @type {WeekTrade[]} */ (by.get(k)).push(t); }
  return [...by].map(([k, ts]) => {
    const rs = ts.map(t => t.r).filter(r => r !== null && r !== undefined);
    return { key: k, trades: ts.length, net: round2(sum(ts.map(t => t.pnl))), r: rs.length ? round2(sum(/** @type {number[]} */ (rs))) : null };
  }).sort((a, b) => b.net - a.net);
}
const groupWords = (/** @type {string} */ name, /** @type {{ trades: number, net: number, r: number | null }} */ g) => `${name}: ${plural(g.trades, 'trade')}, ${signed$(g.net)}${g.r !== null ? ` (${signedR(g.r)})` : ''}`;

/**
 * The review of a week or a month: the headline (stats against the period before, best and worst trade, the trades saved
 * for the weekly review, how many are still open) and each category's facts in words, a tone on the ones that read good
 * or bad. Empty periods get an empty list of trades and no facts.
 * @param {WeekTrade[]} trades every trade in the journal (no filters) @param {string} unit @param {string} key @param {ReviewContext} ctx
 */
export function periodReview(trades, unit, key, ctx) {
  const { closed, closedHere, opened, all } = reviewTrades(trades, unit, key);
  const prevKey = previousPeriod(unit, key);
  const stats = groupStats(closed), prev = groupStats(reviewTrades(trades, unit, prevKey).closed);
  const byPnl = [...closed].sort((a, b) => b.pnl - a.pnl);
  const label = (/** @type {string} */ k, /** @type {string} */ kind) => ctx.labels(k).filter(l => l.kind === kind).map(l => l.value);
  const has = (/** @type {WeekTrade} */ t, /** @type {string} */ kind) => label(t.key, kind).length > 0;
  /** @type {Record<string, Fact[]>} */
  const facts = Object.fromEntries(PERIOD_CATEGORIES.map(([k]) => [k, []]));
  const add = (/** @type {string} */ cat, /** @type {string} */ text, /** @type {Fact['tone']} */ tone = '') => facts[cat].push({ text, tone });
  const word = unit === 'month' ? 'month' : 'week';

  if (all.length) {
    // --- trade selection: how often it worked, how good the setups were, which ones paid
    if (stats.trades) add('selection', `${stats.wins} of ${plural(stats.trades, 'closed trade')} won (${stats.winRate}%)${prev.trades ? `, ${prev.winRate}% the ${word} before` : ''}`);
    const grades = /** @type {Record<string, number>} */ ({});
    let ungraded = 0;
    for (const t of closed) { const g = ctx.review(t.key)?.setup_grade; if (g) grades[g] = (grades[g] || 0) + 1; else ungraded++; }
    const order = ['A++', 'A', 'B', 'C', 'D', 'F'];
    const graded = order.filter(g => grades[g]).map(g => `${grades[g]} ${g}`);
    if (graded.length) add('selection', `Setup grades: ${graded.join(', ')}${ungraded ? `, ${ungraded} not graded` : ''}`);
    else if (closed.length) add('selection', 'No setup grades yet');
    const setups = byLabel(closed, t => label(t.key, 'setup'));
    if (setups.length) {
      const best = setups[0], worst = setups[setups.length - 1];
      add('selection', `Best setup: ${groupWords(ctx.nameOf('setup', best.key), best)}`, best.net > 0 ? 'good' : '');
      if (worst !== best && worst.net < 0) add('selection', `Worst setup: ${groupWords(ctx.nameOf('setup', worst.key), worst)}`, 'bad');
    }
    const noSetup = closed.filter(t => !has(t, 'setup')).length;
    if (noSetup && setups.length) add('selection', `${plural(noSetup, 'trade')} with no setup labeled`);

    // --- entry timing: how far it went against you, early entries, which tactic worked
    const heat = closedHere.map(t => ({ t, ex: ctx.excursion(t) })).filter(x => x.ex && x.ex.maeR !== null);
    if (heat.length) {
      const worst = heat.reduce((a, b) => (/** @type {number} */ (b.ex?.maeR) < /** @type {number} */ (a.ex?.maeR) ? b : a));
      const a = /** @type {number} */ (avg(heat.map(x => /** @type {number} */ (x.ex?.maeR))));
      add('entry', `Average heat: ${signedR(a)} against you before the exit, worst ${signedR(/** @type {number} */ (worst.ex?.maeR))} on ${underlyingOf(worst.t)}`, a <= -0.75 ? 'bad' : a > -0.3 ? 'good' : '');
    } else {
      // no stops to measure in R: how far against you as a share of what the entry cost
      const byCost = closedHere.map(t => ({ t, ex: ctx.excursion(t) })).filter(x => x.ex && costOf(x.t) > 0);
      if (byCost.length) {
        const share = (/** @type {{ t: WeekTrade, ex: any }} */ x) => x.ex.mae / costOf(x.t);
        const worst = byCost.reduce((a, b) => (share(b) < share(a) ? b : a));
        add('entry', `Average heat: ${pct(/** @type {number} */ (avg(byCost.map(share))))} of cost against you before the exit, worst ${pct(share(worst))} on ${underlyingOf(worst.t)}`);
      }
    }
    const early = opened.filter(t => nyParts(t.openedAt).time < EARLY);
    if (early.length) {
      const done = early.filter(t => t.status !== 'open');
      add('entry', `${plural(early.length, 'trade')} opened before 9:45${done.length ? `: ${done.filter(t => t.pnl > 0).length} won, ${signed$(round2(sum(done.map(t => t.pnl))))}` : ''}`, done.length && sum(done.map(t => t.pnl)) < 0 ? 'bad' : '');
    }
    const tactics = byLabel(closed, t => label(t.key, 'tactic'));
    if (tactics.length) add('entry', `By entry tactic: ${tactics.map(g => `${ctx.nameOf('tactic', g.key)} ${plural(g.trades, 'trade')} ${signed$(g.net)}`).join(' · ')}`);

    // --- exit discipline: how much of the move you kept
    const winners = closedHere.filter(t => t.pnl > 0).map(t => ({ t, ex: ctx.excursion(t) }));
    const kept = winners.filter(x => x.ex && x.ex.efficiency !== null);
    if (kept.length) {
      const e = /** @type {number} */ (avg(kept.map(x => /** @type {number} */ (x.ex?.efficiency))));
      add('exit', `Kept ${Math.round(e * 100)}% of the best move on ${plural(kept.length, 'winner')}`, e < 0.5 ? 'bad' : e >= 0.7 ? 'good' : '');
      const priced = kept.filter(x => costOf(x.t) > 0);
      if (priced.length) add('exit', `Winners made ${pct(/** @type {number} */ (avg(priced.map(x => x.t.pnl / costOf(x.t)))))} of cost on average; the best they reached was ${pct(/** @type {number} */ (avg(priced.map(x => /** @type {number} */ (x.ex?.mfe) / costOf(x.t)))))}`);
      const gave = kept.filter(x => x.t.pnl < 0.5 * /** @type {number} */ (x.ex?.mfe)).map(x => x.t);
      if (gave.length) add('exit', `Gave back over half the best move on ${plural(gave.length, 'winner')}: ${names(gave)}`, 'bad');
    }
    const turned = closedHere.filter(t => t.pnl < 0).filter(t => { const ex = ctx.excursion(t); return ex && ex.mfeR !== null && ex.mfeR >= 1; });
    if (turned.length) add('exit', `${plural(turned.length, 'loser')} ${turned.length === 1 ? 'was' : 'were'} up 1R or more first: ${names(turned)}`, 'bad');
    const noBars = closedHere.filter(t => !t.legs && ctx.excursion(t) === null);
    if (ctx.barsPending) add('exit', 'Loading the 5-minute bars for the best and worst of each trade…');
    else if (noBars.length) add('exit', `No 5-minute bars for ${plural(noBars.length, 'trade')} (${names(noBars)}), so they're left out of the excursions`);

    // --- risk management: the size of the losses and of the risk taken
    const losers = closed.filter(t => t.pnl < 0);
    if (losers.length) {
      const big = losers.reduce((a, b) => (b.pnl < a.pnl ? b : a));
      add('risk', `Biggest loss: ${signed$(big.pnl)}${big.r !== null && big.r !== undefined ? ` (${signedR(big.r)})` : ''} on ${underlyingOf(big)}`);
    }
    if (stats.bigLosses) add('risk', `${plural(stats.bigLosses, 'loss')} worse than −1.5R`, 'bad');
    else if (closed.some(t => t.r !== null && t.r !== undefined)) add('risk', 'No loss worse than −1.5R', 'good');
    const risks = opened.map(t => t.risk).filter(r => r && r > 0);
    if (risks.length > 1) {
      const lo = Math.min(.../** @type {number[]} */ (risks)), hi = Math.max(.../** @type {number[]} */ (risks)), mean = /** @type {number} */ (avg(/** @type {number[]} */ (risks)));
      add('risk', `Risk per trade: ${fmt$(lo)} to ${fmt$(hi)}, ${fmt$(round2(mean))} on average`, hi > 2 * mean ? 'bad' : '');
    } else if (risks.length) add('risk', `Risk on the one trade with a stop: ${fmt$(/** @type {number} */ (risks[0]))}`);
    const noStop = opened.filter(t => !t.legs && !(t.risk && t.risk > 0));
    if (noStop.length) add('risk', `${plural(noStop.length, 'trade')} with no stop: ${names(noStop)}`, 'bad');
    const loosened = all.filter(t => t.movedTo !== null && t.movedTo !== undefined && t.schwabStop !== null && t.schwabStop !== undefined
      && (t.direction === 'short' ? t.movedTo > t.schwabStop : t.movedTo < t.schwabStop));
    if (loosened.length) add('risk', `Stop moved farther away on ${plural(loosened.length, 'trade')}: ${names(loosened)}`, 'bad');

    // --- emotional control: trades on the back of a loss, the busiest day
    const losses = countedTrades(trades.filter(t => !t.deleted)).filter(t => t.pnl < 0);
    const afterLoss = opened.filter(o => losses.some(l => l.key !== o.key && l.closedAt && Date.parse(o.openedAt) >= Date.parse(l.closedAt) && Date.parse(o.openedAt) - Date.parse(l.closedAt) <= AFTER_LOSS_MS));
    if (afterLoss.length) {
      const done = afterLoss.filter(t => t.status !== 'open');
      add('emotion', `${plural(afterLoss.length, 'trade')} opened within 15 minutes of a loss${done.length ? `: ${signed$(round2(sum(done.map(t => t.pnl))))}` : ''}`, 'bad');
    } else if (opened.length) add('emotion', 'No trade opened within 15 minutes of a loss', 'good');
    if (opened.length) {
      /** @type {Map<string, number>} */
      const perDay = new Map();
      for (const t of opened) { const d = nyParts(t.openedAt).day; perDay.set(d, (perDay.get(d) || 0) + 1); }
      const [day, most] = [...perDay].sort().reduce((a, b) => (b[1] > a[1] ? b : a));
      const weekday = new Date(`${day}T12:00:00Z`).toLocaleString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
      if (most === 1) add('emotion', 'No more than 1 trade opened a day');
      else add('emotion', `Most trades opened in a day: ${most} (${weekday}), ${(opened.length / perDay.size).toFixed(1)} a day on average`, most >= 3 * (opened.length / perDay.size) && most > 3 ? 'bad' : '');
    }

    // --- market awareness: results by the day's market and the sector, trades against the market
    const markets = byLabel(closed, t => { const m = ctx.market(t); return m ? [m] : []; });
    if (markets.length) add('market', `By market: ${markets.map(g => `${ctx.nameOf('market', g.key)} ${plural(g.trades, 'trade')} ${signed$(g.net)}`).join(' · ')}`);
    const noMarket = closed.filter(t => !ctx.market(t)).length;
    if (noMarket) add('market', `${plural(noMarket, 'trade')} with no market set`);
    const against = closed.filter(t => { const m = ctx.market(t), b = t.bias || t.direction; return (m === 'bearish' && b === 'long') || (m === 'bullish' && b === 'short'); });
    if (against.length) add('market', `${plural(against.length, 'trade')} against the market: ${signed$(round2(sum(against.map(t => t.pnl))))}`, sum(against.map(t => t.pnl)) < 0 ? 'bad' : '');
    const sectors = byLabel(closed, t => label(t.key, 'sector'));
    if (sectors.length) add('market', `By sector: ${sectors.map(g => `${ctx.nameOf('sector', g.key)} ${plural(g.trades, 'trade')} ${signed$(g.net)}`).join(' · ')}`);

    // --- preparedness: what was written down going in
    if (opened.length) {
      const notes = opened.filter(t => ctx.review(t.key)?.entry_note?.trim()).length;
      add('prep', `Entry notes on ${notes} of ${plural(opened.length, 'trade')} opened`, notes === opened.length ? 'good' : notes < opened.length / 2 ? 'bad' : '');
      const labeled = opened.filter(t => has(t, 'setup') && has(t, 'tactic')).length;
      add('prep', `Setup and entry tactic labeled on ${labeled} of ${opened.length}`);
    }

    // --- execution consistency: the plan, the grade ladder, how much is reviewed
    const plans = byLabel(closed, t => { const p = ctx.review(t.key)?.plan_followed; return p ? [p] : []; });
    if (plans.length) {
      const order = ['yes', 'partly', 'no'], word = /** @type {Record<string, string>} */ ({ yes: 'yes', partly: 'partly', no: 'no' });
      plans.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
      const no = plans.find(g => g.key === 'no');
      add('consistency', `Followed the plan: ${plans.map(g => `${g.trades} ${word[g.key] || g.key} (${signed$(g.net)})`).join(', ')}`, no ? 'bad' : plans.every(g => g.key === 'yes') ? 'good' : '');
    }
    const ladder = byLabel(closed, t => { const g = ctx.review(t.key)?.setup_grade; return !g ? [] : ['A++', 'A'].includes(g) ? ['top'] : ['C', 'D', 'F'].includes(g) ? ['low'] : []; });
    const top = ladder.find(g => g.key === 'top'), low = ladder.find(g => g.key === 'low');
    if (top && low) add('consistency', `A++ and A trades ${signed$(top.net)} over ${top.trades}; C and below ${signed$(low.net)} over ${low.trades}`, top.net <= low.net ? 'bad' : '');
    const reviewed = closedHere.filter(t => ctx.reviewed(t)).length;
    if (closedHere.length) add('consistency', `Reviewed ${reviewed} of ${plural(closedHere.length, 'trade')} closed`, reviewed === closedHere.length ? 'good' : '');

    // --- the mistakes you tagged, each under the part it speaks to
    /** @type {Map<string, WeekTrade[]>} */
    const tagged = new Map();
    for (const t of all) for (const v of label(t.key, 'mistake')) { if (!tagged.has(v)) tagged.set(v, []); /** @type {WeekTrade[]} */ (tagged.get(v)).push(t); }
    for (const [v, ts] of tagged) add(MISTAKE_CATEGORY[v] || 'consistency', `Tagged "${ctx.nameOf('mistake', v)}" on ${plural(ts.length, 'trade')}: ${names(ts)}`, 'bad');
  }

  return {
    unit, key, prevKey, stats, prev,
    trades: all.length, closedCount: closed.length, openCount: opened.filter(t => t.status === 'open').length,
    best: byPnl.length && byPnl[0].pnl > 0 ? byPnl[0] : null,
    worst: byPnl.length && byPnl[byPnl.length - 1].pnl < 0 ? byPnl[byPnl.length - 1] : null,
    saved: all.filter(t => ctx.saved(t.key)),
    /** @type {Category[]} */
    categories: PERIOD_CATEGORIES.map(([k, name]) => ({ key: k, name, facts: facts[k] })),
  };
}
