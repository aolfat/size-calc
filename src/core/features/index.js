// @ts-check
// The trade features (docs/journal-features.md, part 2): every feature from every family, and stamping them onto trades.
// A stamp is { v, value, note } per feature key, in the trade's trade_features row: v is the family's version and the
// feature's ('1.2'), so bumping either restamps it. Three states: a value; unknown for good (value null, stamped, never
// tried again until the version changes); waiting (the data could still come: nothing stamped, tried on the next run).
// Removing a feature leaves its old stamps ignored, and they're dropped the next time the row is written. An unknown
// stamp of a feature that reads 5-minute bars also carries the reach it was worked out under (`r`, core/bars.js
// REACHES; absent = Tradier's), so a provider reaching further back (a paid Massive plan) tries it once more.
import { barsReach, lastDoneDay, massiveServes, nyDay, reachFor, reachWider, weekdaysBefore } from '../bars.js';
import { featureContext, featureSymbol } from './context.js';
import { BREADTH_FAMILY, BREADTH_FEATURES } from './breadth.js';
import { CONTRACT_FAMILY, CONTRACT_FEATURES } from './contract.js';
import { LEVEL_FEATURES, LEVELS_FAMILY } from './levels.js';
import { MARKET_FAMILY, MARKET_FEATURES } from './market.js';
import { STRENGTH_FAMILY, STRENGTH_FEATURES } from './strength.js';
import { TIMING_FAMILY, TIMING_FEATURES } from './timing.js';
import { TREND_FAMILY, TREND_FEATURES } from './trend.js';
import { VOLUME_FAMILY, VOLUME_FEATURES } from './volume.js';

/**
 * @typedef {import('./define.js').Feature} Feature
 * @typedef {import('./context.js').FeatureData} FeatureData
 * @typedef {{ v: string, value: number | string | null, note?: string, r?: string }} Stamp r: the reach an unknown
 *   intraday stamp was worked out under (absent = 'tradier')
 * @typedef {Record<string, Stamp>} Stamps one trade's stamps, by feature key
 * @typedef {{ key: string, symbol: string, assetType: string, status: string, openedAt: string, closedAt: string | null,
 *   deleted?: boolean, fillIds?: string[] }} StampTrade
 * @typedef {{ state: 'value' | 'unknown' | 'waiting', value: number | string | null, note: string, waits: string[],
 *   reads: import('./context.js').FeatureRead[] }} FeatureResult
 */

export const FEATURE_FAMILIES = [MARKET_FAMILY, BREADTH_FAMILY, VOLUME_FAMILY, TREND_FAMILY, LEVELS_FAMILY, STRENGTH_FAMILY, CONTRACT_FAMILY, TIMING_FAMILY];
/** @type {Feature[]} every feature, by family */
export const FEATURES = [...MARKET_FEATURES, ...BREADTH_FEATURES, ...VOLUME_FEATURES, ...TREND_FEATURES, ...LEVEL_FEATURES, ...STRENGTH_FEATURES, ...CONTRACT_FEATURES, ...TIMING_FEATURES];

/** what a stamp has to carry to be current: the family's version and the feature's @param {Feature} f */
export const featureVersion = f => `${f.family.version}.${f.version}`;
/** the trades that get features: everything but deleted ones and closes from before your history (no entry) @param {StampTrade} t */
export const stampableTrade = t => !t.deleted && t.status !== 'history' && !!t.openedAt;
/** a feature reads 5-minute bars, so how far back they reach can change its answer @param {Feature} f */
const readsIntraday = f => !!f.needs.intraday?.length;
/**
 * Missing, stamped by an older version, or unknown under a narrower reach than `reach` (a REACHES id) for a feature
 * that reads 5-minute bars: the bars it missed may be there now.
 * @param {Feature} f @param {Stamps | undefined} stamps @param {string} [reach]
 */
export function featureDue(f, stamps, reach = 'tradier') {
  const s = stamps?.[f.key];
  if (!s || s.v !== featureVersion(f)) return true;
  return s.value === null && readsIntraday(f) && reachWider(reach, s.r);
}
/** the feature's moment on a trade (ms), or null while it can't be known yet (an exit feature on an open trade) @param {Feature} f @param {StampTrade} t */
export const momentOf = (f, t) => f.at === 'entry' ? Date.parse(t.openedAt) : t.closedAt ? Date.parse(t.closedAt) : null;

/**
 * What the bar saver has to keep for the features to fill in: every symbol a feature names (beyond $self and
 * $underlying, which the saver keeps per trade anyway), every weekday, and the most lookback days any of them compares.
 * @param {Feature[]} [features] @returns {{ market: string[], lookback: number }}
 */
export function featureBarNeeds(features = FEATURES) {
  const market = new Set(), lookback = Math.max(0, ...features.map(f => f.needs.lookback || 0));
  for (const f of features) for (const s of f.needs.intraday || []) if (!s.startsWith('$')) market.add(s);
  return { market: [...market], lookback };
}

/**
 * The trades with features due (missing, outdated, or unknown under a narrower reach), and the features due on each.
 * @param {StampTrade[]} trades @param {Record<string, Stamps>} stampsByKey @param {Feature[]} [features] @param {string} [reach]
 * @returns {{ trade: StampTrade, features: Feature[] }[]}
 */
export function featuresDue(trades, stampsByKey, features = FEATURES, reach = 'tradier') {
  return trades.filter(stampableTrade)
    .map(trade => ({ trade, features: features.filter(f => featureDue(f, stampsByKey[trade.key], reach)) }))
    .filter(d => d.features.length);
}

const DAY_MS = 86400000;
/** how far back daily bars go when a feature wants all of them: before any listing still trading */
export const DAILY_FROM_LISTING = '1960-01-01';

/**
 * What to read for these trades' due features: the 5-minute days per symbol (the moment's day, and the lookback days
 * before it), per symbol the first day of daily bars needed (back to the listing when a feature wants all of them), and
 * whether any reads the market's breadth.
 * @param {{ trade: StampTrade, features: Feature[] }[]} due
 * @returns {{ intraday: Map<string, string[]>, daily: Map<string, string>, breadth: boolean }}
 */
export function featureDataNeeds(due) {
  /** @type {Map<string, Set<string>>} */
  const intraday = new Map();
  /** @type {Map<string, string>} */
  const daily = new Map();
  let breadth = false;
  for (const { trade, features } of due) {
    for (const f of features) {
      const at = momentOf(f, trade);
      if (at === null) continue;
      if (f.needs.breadth) breadth = true;
      const day = nyDay(at);
      for (const token of f.needs.intraday || []) {
        const s = featureSymbol(token, trade);
        if (!s) continue;
        if (!intraday.has(s)) intraday.set(s, new Set());
        const days = /** @type {Set<string>} */ (intraday.get(s));
        days.add(day);
        for (const d of f.needs.lookback ? weekdaysBefore(day, f.needs.lookback) : []) days.add(d);
      }
      for (const token of f.needs.daily || []) {
        const s = featureSymbol(token, trade);
        if (!s) continue;
        // a session count back, with room for holidays: about 7 calendar days to 5 sessions, plus two weeks
        const from = f.needs.dailySessions ? nyDay(Date.parse(day + 'T12:00:00Z') - (Math.ceil(f.needs.dailySessions * 7 / 5) + 14) * DAY_MS) : DAILY_FROM_LISTING;
        const had = daily.get(s);
        if (!had || from < had) daily.set(s, from);
      }
    }
  }
  return { intraday: new Map([...intraday].map(([s, days]) => [s, [...days].sort()])), daily, breadth };
}

/**
 * Where one trade's 5-minute bars come from, per symbol, so a comparison never mixes providers' volumes (a run rate's
 * curve over 50 sessions, a relative volume over 20): the kept bars (bars_5m, Tradier's) when every finished day the
 * trade's due features read is kept; else, when Massive serves the symbol and reaches the oldest of them, all of them
 * from Massive; else the kept bars, the missing days waiting or gone by the reach.
 * @param {Map<string, string[]>} needs symbol → the days the trade's due features read (featureDataNeeds)
 * @param {Map<string, Map<string, any[]>>} kept symbol → day → candles, from bars_5m
 * @param {import('../bars.js').BarsReach} reach @param {number} now
 * @returns {Map<string, 'kept' | 'massive'>}
 */
export function intradayRoutes(needs, kept, reach, now) {
  const done = lastDoneDay(now);
  /** @type {Map<string, 'kept' | 'massive'>} */
  const out = new Map();
  for (const [symbol, days] of needs) {
    const finished = days.filter(d => d <= done), have = kept.get(symbol);
    const whole = finished.every(d => have?.has(d));
    out.set(symbol, !whole && finished.length && massiveServes(reach, symbol) && finished[0] >= reachFor(reach, symbol) ? 'massive' : 'kept');
  }
  return out;
}

const round = (/** @type {number} */ v) => Math.round(v * 1e4) / 1e4;

/**
 * One feature on one context: its value, unknown (with why), or waiting (with what for).
 * @param {Feature} f @param {import('./context.js').FeatureContext} ctx @returns {FeatureResult}
 */
export function computeFeature(f, ctx) {
  ctx.begin();
  /** @type {any} */
  let out;
  try { out = f.compute(ctx); }
  catch(e) { out = { value: null, note: `couldn't be worked out: ${String(/** @type {any} */ (e)?.message || e)}` }; }
  const r = ctx.report();
  if (r.waits.length) return { state: 'waiting', value: null, note: `waiting for ${r.waits.slice(0, 3).join(', ')}`, waits: r.waits, reads: r.reads };
  let value = out && typeof out === 'object' ? out.value : out;
  let note = out && typeof out === 'object' && out.note ? String(out.note) : '';
  if (typeof value === 'number') value = Number.isFinite(value) ? round(value) : null;
  else if (typeof value === 'string' && !(f.values || []).some(([k]) => k === value)) { note = `not one of its values: ${value}`; value = null; }
  else if (value !== null && typeof value !== 'string') value = null;
  if (value === null && !note) note = r.gones[0] || 'not enough data';
  return { state: value === null ? 'unknown' : 'value', value, note: note.slice(0, 200), waits: [], reads: r.reads };
}

/**
 * Stamp one trade's due features. `entryPrice` is the first fill's price; `reach` how far back 5-minute bars can come
 * (Tradier's window by default), which an unknown stamp reading them keeps as `r` when it's wider. The trade's other
 * stamps are kept as they are (a removed feature's dropped); waiting features stay unstamped.
 * @param {StampTrade} trade @param {Stamps | undefined} stamps @param {Feature[]} features the due ones
 * @param {FeatureData} data @param {{ now: number, entryPrice?: number | null, all?: Feature[], reach?: import('../bars.js').BarsReach }} opts
 * @returns {{ stamps: Stamps, changed: boolean, results: Record<string, FeatureResult> }}
 */
export function stampTrade(trade, stamps, features, data, { now, entryPrice = null, all = FEATURES, reach = barsReach(now) }) {
  const known = new Set(all.map(f => f.key));
  /** @type {Stamps} */
  const next = Object.fromEntries(Object.entries(stamps || {}).filter(([k]) => known.has(k)));
  /** @type {Map<number, ReturnType<typeof featureContext>>} */
  const contexts = new Map(); // one per moment, so the helpers are worked out once for the trade
  /** @type {Record<string, FeatureResult>} */
  const results = {};
  let changed = false;
  for (const f of features) {
    const at = momentOf(f, trade);
    if (at === null || !Number.isFinite(at)) { results[f.key] = { state: 'waiting', value: null, note: 'waiting for the trade to close', waits: ['the close'], reads: [] }; continue; }
    if (!contexts.has(at)) contexts.set(at, featureContext(trade, at, data, { now, entryPrice, reach }));
    const r = results[f.key] = computeFeature(f, /** @type {ReturnType<typeof featureContext>} */ (contexts.get(at)));
    if (r.state === 'waiting') continue;
    /** @type {Stamp} */
    const st = { v: featureVersion(f), value: r.value };
    if (r.note) st.note = r.note;
    if (r.value === null && readsIntraday(f) && reach.id !== 'tradier') st.r = reach.id;
    next[f.key] = st;
    changed = true;
  }
  return { stamps: next, changed, results };
}

/**
 * How far a feature is stamped over these trades: current values, unknown (with the reasons, most common first), and
 * the rest still to come (missing, outdated, waiting, or unknown under a narrower reach than `reach`).
 * @param {Feature} f @param {StampTrade[]} trades @param {Record<string, Stamps>} stampsByKey @param {string} [reach]
 */
export function featureCoverage(f, trades, stampsByKey, reach = 'tradier') {
  const list = trades.filter(stampableTrade);
  let value = 0, unknown = 0;
  /** @type {Map<string, number>} */
  const reasons = new Map();
  for (const t of list) {
    const s = stampsByKey[t.key]?.[f.key];
    if (!s || featureDue(f, stampsByKey[t.key], reach)) continue;
    if (s.value === null) { unknown++; const why = s.note || 'not known'; reasons.set(why, (reasons.get(why) || 0) + 1); }
    else value++;
  }
  return { total: list.length, value, unknown, pending: list.length - value - unknown, reasons: [...reasons].sort((a, b) => b[1] - a[1]) };
}

/** a stamped value in words: '+1.23%', '2.34×', a word's name, or '—' @param {Feature} f @param {number | string | null | undefined} value */
export function featureValueWords(f, value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return (f.values || []).find(([k]) => k === value)?.[1] || value;
  if (f.unit === '%') return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)}%`;
  if (f.unit === 'x') return `${value.toFixed(2)}×`;
  if (f.unit === '$') {
    const a = Math.abs(value), sign = value < 0 ? '−' : '';
    return a >= 1e9 ? `${sign}$${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${sign}$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${sign}$${(a / 1e3).toFixed(0)}k` : `${sign}$${a.toFixed(0)}`;
  }
  return String(Number(value.toFixed(2))).replace('-', '−'); // at most two decimals: 1.38, 62.7, 32
}

/** what a feature reads, in words: '5-minute bars: SPY · daily bars: SPY, 60 sessions' @param {Feature} f */
export function featureNeedsWords(f) {
  const name = (/** @type {string} */ s) => s === '$underlying' ? 'the stock' : s === '$self' ? 'the traded symbol' : s;
  const parts = [];
  if (f.needs.intraday?.length) parts.push(`5-minute bars: ${f.needs.intraday.map(name).join(', ')}${f.needs.session === 'all' ? ', extended hours too' : ''}${f.needs.lookback ? `, and the ${f.needs.lookback} sessions before` : ''}`);
  if (f.needs.daily?.length) parts.push(`daily bars: ${f.needs.daily.map(name).join(', ')}, ${f.needs.dailySessions ? `${f.needs.dailySessions} sessions` : 'back to the listing'}`);
  if (f.needs.breadth) parts.push("market breadth: every US common stock's close (Massive)");
  return parts.join(' · ') || 'the trade itself';
}
