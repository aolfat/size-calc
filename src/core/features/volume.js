// @ts-check
// Volume features: how heavy the trading was when you got in.
import { earlyCloseDay } from '../bars.js';
import { family, feature } from './define.js';
import { clockMinutes, median, monthDay, volumeWords } from './prices.js';

export const VOLUME_FAMILY = family({ key: 'volume', name: 'Volume', version: 1 });

/** the sessions a run rate compares against */
const RVOL_SESSIONS = 20;
/** the sessions the run rate's intraday curve averages, and the fewest it's worked out from */
const CURVE_SESSIONS = 50, CURVE_MIN = 15;
/** the regular open and close, in minutes */
const OPEN_MIN = 570, CLOSE_MIN = 960;

const regular = (/** @type {{ time?: string }} */ b) => (b.time || '') >= '09:30' && (b.time || '') < '16:00';
const ended = (/** @type {{ time?: string }} */ b, /** @type {number} */ cut) => clockMinutes(b.time || '00:00') + 5 <= cut;
const sumVolume = (/** @type {{ volume?: number }[]} */ bars) => bars.reduce((n, b) => n + (b.volume || 0), 0);

/**
 * The volume run rate: the day's projected volume over the median day's.
 *   projected = premarket + regular prints so far ÷ U(now)
 * The premarket is over by 9:30, so it's added as it is, never scaled. U(now) is the stock's own curve: over the 50
 * sessions before, the share of each day's whole volume less its premarket that had printed in regular-hours 5-minute
 * bars by the same time, averaged. Its denominator is the daily total, not the sum of the bars, because the bars miss the
 * closing auction, after-hours and late prints (U at the close comes out about 0.65 to 0.80, not 1), so dividing by it
 * projects the whole day, which is what the median measures. Half days are left out of the curve, and a half day gets
 * none. Stamped as the % over the median day (+34 = 1.34 times), with the projection in its note.
 * @param {import('./context.js').FeatureContext} ctx @param {number} n the median's sessions
 */
function runRate(ctx, n) {
  if (ctx.clock < '09:30') return { value: null, note: 'entered before the open' };
  if (ctx.clock < '09:35') return { value: null, note: 'entered in the first 5 minutes' };
  if (earlyCloseDay(ctx.day)) return { value: null, note: 'a half day: no curve for it' };
  const s = ctx.intraday('$underlying', { session: 'all' }), d = ctx.daily('$underlying', CURVE_SESSIONS);
  if (!s || !d) return null;
  const prior = s.priorSessions(CURVE_SESSIONS);
  if (s.missing || d.missing) return null;
  const cut = Math.min(clockMinutes(ctx.clock), CLOSE_MIN);
  const totals = new Map(d.bars.map(b => [b.date, b.volume || 0]));
  const shares = [];
  for (const p of prior) {
    const total = totals.get(p.day) || 0, pm = sumVolume(p.bars.filter(b => (b.time || '') < '09:30'));
    if (earlyCloseDay(p.day) || !(total - pm > 0)) continue;
    shares.push(sumVolume(p.bars.filter(b => regular(b) && ended(b, cut))) / (total - pm));
  }
  if (shares.length < CURVE_MIN) return { value: null, note: `the curve needs ${CURVE_MIN} of the ${CURVE_SESSIONS} sessions before; ${shares.length} kept` };
  const u = shares.reduce((a, b) => a + b, 0) / shares.length;
  const base = d.bars.length >= n ? median(d.bars.slice(-n).map(b => b.volume || 0)) : null;
  if (!u || !base) return { value: null, note: base ? 'no volume by this time on the sessions before' : `fewer than ${n} daily sessions before` };
  const pm = s.premarketVolume() || 0, prints = sumVolume(s.bars.filter(regular));
  const projected = pm + prints / u;
  const words = [`projected ${volumeWords(projected)} vs median ${volumeWords(base)}`, `curve from ${shares.length} sessions`, ...(cut < OPEN_MIN + 15 ? ['~ first 15 minutes, noisy'] : [])];
  return { value: (projected / base - 1) * 100, note: words.join(' · ') };
}

/** @param {number} n @param {'entry' | 'exit'} at */
const runRateFeature = (n, at) => feature(VOLUME_FAMILY, {
  key: at === 'entry' ? `run_rate_${n}` : `run_rate_${n}_at_exit`,
  name: `Volume run rate (${n}-day)${at === 'exit' ? ' at exit' : ''}`,
  desc: `The day's projected volume at your ${at} over the median day of the ${n} sessions before, as a % (+34 = 1.34 times a normal day). Projected = the premarket plus the regular-hours volume so far divided by how much of a day has usually printed by then (the stock's own curve over 50 sessions, measured against the whole day, closing auction included). Before 9:45 it's noisy; half days get none.`,
  version: 1, at, unit: '%', bins: [-25, 0, 50, 100],
  needs: { intraday: ['$underlying'], lookback: CURVE_SESSIONS, daily: ['$underlying'], dailySessions: CURVE_SESSIONS, session: 'all' },
  compute: ctx => runRate(ctx, n),
});

export const VOLUME_FEATURES = [
  feature(VOLUME_FAMILY, {
    key: 'rvol_at_entry',
    name: 'Relative volume by time of day',
    desc: "The stock's volume from 9:30 to your entry over its average volume to that same time across the 20 sessions before. Volume is heavy at the open and close, so it's compared by time of day.",
    version: 1, at: 'entry', unit: 'x', bins: [1, 1.5, 2, 3],
    needs: { intraday: ['$underlying'], lookback: RVOL_SESSIONS, session: 'regular' },
    compute: ctx => {
      const s = ctx.intraday('$underlying');
      if (!s) return null;
      if (ctx.clock < '09:35') return { value: null, note: ctx.clock < '09:30' ? 'entered before the open' : 'entered in the first 5 minutes' };
      const avg = s.avgVolumeByTime(RVOL_SESSIONS);
      return avg ? s.volumeSoFar() / avg : null;
    },
  }),
  runRateFeature(20, 'entry'),
  runRateFeature(50, 'entry'),
  runRateFeature(20, 'exit'),
  feature(VOLUME_FAMILY, {
    key: 'premarket_rvol',
    name: 'Premarket volume vs usual',
    desc: "The stock's premarket volume (4:00 to 9:30, or to your entry if it came first) over the median premarket to the same time across the 20 sessions before.",
    version: 1, at: 'entry', unit: 'x', bins: [1, 2, 5],
    needs: { intraday: ['$underlying'], lookback: RVOL_SESSIONS, session: 'all' },
    compute: ctx => {
      const s = ctx.intraday('$underlying', { session: 'all' });
      if (!s) return null;
      const cut = Math.min(clockMinutes(ctx.clock), OPEN_MIN);
      if (cut < 245) return { value: null, note: 'entered before the first premarket bar ended' };
      const prior = s.priorSessions(RVOL_SESSIONS);
      if (s.missing) return null;
      const past = prior.map(p => sumVolume(p.bars.filter(b => (b.time || '') < '09:30' && ended(b, cut))));
      if (past.length < RVOL_SESSIONS / 2) return { value: null, note: `fewer than ${RVOL_SESSIONS / 2} of the ${RVOL_SESSIONS} sessions before` };
      const usual = median(past);
      if (!usual) return { value: null, note: 'no premarket volume on the sessions before' };
      const today = s.premarketVolume() || 0;
      return { value: today / usual, note: `${volumeWords(today)} vs a usual ${volumeWords(usual)}` };
    },
  }),
  feature(VOLUME_FAMILY, {
    key: 'prev_bar_rvol',
    name: 'Last bar before entry vs usual',
    desc: "The volume of the last 5-minute bar that ended before your entry over that same bar's average across the 20 sessions before. A spike right before you got in. (The bar you entered in isn't over at your entry, so it isn't counted.)",
    version: 1, at: 'entry', unit: 'x', bins: [1, 2, 4],
    needs: { intraday: ['$underlying'], lookback: RVOL_SESSIONS, session: 'regular' },
    compute: ctx => {
      if (ctx.clock < '09:35') return { value: null, note: ctx.clock < '09:30' ? 'entered before the open' : 'entered in the first 5 minutes' };
      const s = ctx.intraday('$underlying');
      if (!s) return null;
      const prior = s.priorSessions(RVOL_SESSIONS);
      const last = s.bars[s.bars.length - 1];
      if (!last) return null;
      const past = prior.map(p => p.bars.find(b => b.time === last.time)?.volume).filter(v => typeof v === 'number');
      if (past.length < RVOL_SESSIONS / 2) return { value: null, note: `fewer than ${RVOL_SESSIONS / 2} of the ${RVOL_SESSIONS} sessions before` };
      const avg = /** @type {number[]} */ (past).reduce((a, b) => a + b, 0) / past.length;
      return avg ? { value: (last.volume || 0) / avg, note: `the ${last.time} bar` } : null;
    },
  }),
  feature(VOLUME_FAMILY, {
    key: 'prior_day_rvol',
    name: "Prior day's volume vs usual",
    desc: "The day before's volume over the median day of the 50 sessions before it. A heavy day before (a pocket pivot, an earnings reaction) shows here.",
    version: 1, at: 'entry', unit: 'x', bins: [1, 1.5, 2, 3],
    needs: { daily: ['$underlying'], dailySessions: 51 },
    compute: ctx => {
      const d = ctx.daily('$underlying', 51);
      if (!d || d.bars.length < 51) return d && !d.missing ? { value: null, note: 'fewer than 51 daily sessions before' } : null;
      const usual = median(d.bars.slice(0, -1).map(b => b.volume || 0));
      const last = d.bars[d.bars.length - 1];
      return usual ? { value: (last.volume || 0) / usual, note: `${monthDay(last.date)}: ${volumeWords(last.volume || 0)} vs a usual ${volumeWords(usual)}` } : null;
    },
  }),
  feature(VOLUME_FAMILY, {
    key: 'up_down_volume_50',
    name: 'Up / down volume (50 days)',
    desc: 'Over the 50 sessions before, the volume on days that closed up over the volume on days that closed down. Above 1 = heavier buying (accumulation).',
    version: 1, at: 'entry', unit: 'x', bins: [0.8, 1, 1.25, 1.5],
    needs: { daily: ['$underlying'], dailySessions: 51 },
    compute: ctx => {
      const d = ctx.daily('$underlying', 51);
      if (!d || d.bars.length < 51) return d && !d.missing ? { value: null, note: 'fewer than 51 daily sessions before' } : null;
      let up = 0, down = 0;
      d.bars.slice(1).forEach((b, i) => { if (b.close > d.bars[i].close) up += b.volume || 0; else if (b.close < d.bars[i].close) down += b.volume || 0; });
      return down ? up / down : { value: null, note: 'no down days in the 50 sessions' };
    },
  }),
  feature(VOLUME_FAMILY, {
    key: 'dollar_volume_20',
    name: 'Median dollar volume (20 days)',
    desc: 'How liquid the stock is: the median of close × volume over the 20 sessions before.',
    version: 1, at: 'entry', unit: '$', bins: [1e7, 5e7, 2e8, 1e9],
    needs: { daily: ['$underlying'], dailySessions: 20 },
    compute: ctx => {
      const d = ctx.daily('$underlying', 20);
      if (!d || d.bars.length < 20) return d && !d.missing ? { value: null, note: 'fewer than 20 daily sessions before' } : null;
      return median(d.bars.map(b => b.close * (b.volume || 0)));
    },
  }),
];
