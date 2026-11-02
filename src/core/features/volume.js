// @ts-check
// Volume features: how heavy the trading was when you got in (and out), against the stock's own normal, and where it
// traded. An option reads its underlying, never the contract.
import { family, feature } from './define.js';

export const VOLUME_FAMILY = family({ key: 'volume', name: 'Volume', version: 1 });

/** the sessions a run rate compares against */
const RVOL_SESSIONS = 20;
/** the ended bars the recent-volume features look at: the 15 minutes before the moment */
const RECENT_BARS = 3;
/** the ended bars on-balance volume sums: the 30 minutes before the moment */
const OBV_BARS = 6;

/** @typedef {import('./context.js').FeatureContext} Ctx */
/** @typedef {{ time?: string, open: number, high: number, low: number, close: number, volume?: number }} Bar */

/** the stock's price at the moment: your fill for a stock, the underlying's last price for an option or spread */
const stockPrice = (/** @type {Ctx} */ ctx, /** @type {{ price: number | null } | null} */ s) => ctx.entryPrice ?? s?.price ?? null;
/** none yet before 9:35: the first 5-minute bar hasn't ended @param {Ctx} ctx @param {string} what */
const tooEarly = (ctx, what) => ctx.clock < '09:35' ? { value: null, note: ctx.clock < '09:30' ? `${what} before the open` : `${what} in the first 5 minutes` } : null;
const sum = (/** @type {number[]} */ xs) => xs.reduce((a, b) => a + b, 0);
const vol = (/** @type {Bar} */ b) => b.volume || 0;

/** the run rate at a moment: volume from 9:30 over the 20 sessions before by the same time (`how`: their average or median) */
function runRate(/** @type {Ctx} */ ctx, /** @type {string} */ what, /** @type {'avg' | 'median'} */ how = 'avg') {
  const s = ctx.intraday('$underlying');
  if (!s) return null;
  const early = tooEarly(ctx, what);
  if (early) return early;
  const base = how === 'median' ? s.medianVolumeByTime(RVOL_SESSIONS) : s.avgVolumeByTime(RVOL_SESSIONS);
  return base ? s.volumeSoFar() / base : null;
}

/** the session VWAP and its volume-weighted standard deviation over the ended bars @param {Bar[]} bars */
function vwapBand(bars) {
  const tp = (/** @type {Bar} */ b) => (b.high + b.low + b.close) / 3;
  const v = sum(bars.map(vol));
  if (!v) return null;
  const vwap = sum(bars.map(b => tp(b) * vol(b))) / v;
  return { vwap, sd: Math.sqrt(sum(bars.map(b => vol(b) * (tp(b) - vwap) ** 2)) / v) };
}

export const VOLUME_FEATURES = [
  feature(VOLUME_FAMILY, {
    key: 'rvol_at_entry',
    name: 'Volume run rate at entry',
    desc: "The stock's volume from 9:30 to your entry over its average volume to that same time across the 20 sessions before. Volume is heavy at the open and close, so it's compared by time of day.",
    version: 1, at: 'entry', unit: 'x', bins: [1, 1.5, 2, 3],
    needs: { intraday: ['$underlying'], lookback: RVOL_SESSIONS, session: 'regular' },
    compute: ctx => runRate(ctx, 'entered'),
  }),
  feature(VOLUME_FAMILY, {
    key: 'rvol_median_at_entry',
    name: 'Volume run rate at entry (median)',
    desc: "The run rate at entry against the median of the 20 sessions before by that same time, not their average, so one earnings day or news spike in the lookback doesn't drag the normal up.",
    version: 1, at: 'entry', unit: 'x', bins: [1, 1.5, 2, 3],
    needs: { intraday: ['$underlying'], lookback: RVOL_SESSIONS, session: 'regular' },
    compute: ctx => runRate(ctx, 'entered', 'median'),
  }),
  feature(VOLUME_FAMILY, {
    key: 'rvol_at_exit',
    name: 'Volume run rate at exit',
    desc: "The run rate at your exit: the stock's volume from 9:30 that day to the exit over the 20 sessions before by that same time. Against the entry's, it shows whether volume came in or dried up while you held.",
    version: 1, at: 'exit', unit: 'x', bins: [1, 1.5, 2, 3],
    needs: { intraday: ['$underlying'], lookback: RVOL_SESSIONS, session: 'regular' },
    compute: ctx => runRate(ctx, 'exited'),
  }),
  feature(VOLUME_FAMILY, {
    key: 'rvol_recent_at_entry',
    name: 'Volume before entry vs usual',
    desc: "The stock's volume in the 15 minutes before your entry (the last three 5-minute bars) over its average in those same 15 minutes across the 20 sessions before. The surge right at your fill, not the whole morning's.",
    version: 1, at: 'entry', unit: 'x', bins: [1, 1.5, 2, 3],
    needs: { intraday: ['$underlying'], lookback: RVOL_SESSIONS, session: 'regular' },
    compute: ctx => {
      const s = ctx.intraday('$underlying');
      if (!s) return null;
      if (ctx.clock < '09:45') return { value: null, note: ctx.clock < '09:30' ? 'entered before the open' : 'entered before 15 minutes of bars' };
      const r = s.recentVolumeByTime(RECENT_BARS, RVOL_SESSIONS);
      return r && r.avg ? r.now / r.avg : null;
    },
  }),
  feature(VOLUME_FAMILY, {
    key: 'day_volume_at_exit',
    name: "Share of a normal day's volume by exit",
    desc: "The stock's regular-hours volume that day up to your exit over a whole normal session's (the average 9:30 to 16:00 across the 20 sessions before). Not adjusted for time of day: 1× by noon is a very heavy day. Exited after the close, it's the whole day's relative volume.",
    version: 1, at: 'exit', unit: 'x', bins: [0.5, 1, 1.5, 2],
    needs: { intraday: ['$underlying'], lookback: RVOL_SESSIONS, session: 'regular' },
    compute: ctx => {
      const s = ctx.intraday('$underlying');
      if (!s) return null;
      if (ctx.clock < '09:35') return { value: null, note: ctx.clock < '09:30' ? 'exited before the open' : 'exited in the first 5 minutes' };
      const avg = s.avgSessionVolume(RVOL_SESSIONS);
      return avg ? s.volumeSoFar() / avg : null;
    },
  }),
  feature(VOLUME_FAMILY, {
    key: 'rvol_prior_day',
    name: 'Prior day relative volume',
    desc: "The stock's volume the session before your entry over its average daily volume across the 20 sessions before that. A heavy day yesterday often means news or a breakout still in play.",
    version: 1, at: 'entry', unit: 'x', bins: [1, 1.5, 2, 3],
    needs: { daily: ['$underlying'], dailySessions: RVOL_SESSIONS + 1 },
    compute: ctx => {
      const d = ctx.daily('$underlying', RVOL_SESSIONS + 1);
      if (!d) return null;
      if (d.bars.length < RVOL_SESSIONS + 1) return d.bars.length ? { value: null, note: `only ${d.bars.length} sessions of daily history` } : null;
      const last = d.bars[d.bars.length - 1], avg = sum(d.bars.slice(0, -1).map(vol)) / RVOL_SESSIONS;
      return avg ? vol(last) / avg : null;
    },
  }),
  feature(VOLUME_FAMILY, {
    key: 'avg_dollar_volume_20d',
    name: 'Average dollar volume, 20 days ($M)',
    desc: "The stock's average daily close × volume across the 20 sessions before your entry, in millions of dollars. How liquid the name is: thin names fill worse and gap more.",
    version: 1, at: 'entry', unit: '', bins: [10, 50, 250, 1000],
    needs: { daily: ['$underlying'], dailySessions: RVOL_SESSIONS },
    compute: ctx => {
      const d = ctx.daily('$underlying', RVOL_SESSIONS);
      if (!d) return null;
      if (d.bars.length < RVOL_SESSIONS) return d.bars.length ? { value: null, note: `only ${d.bars.length} sessions of daily history` } : null;
      return sum(d.bars.map((/** @type {Bar} */ b) => b.close * vol(b))) / RVOL_SESSIONS / 1e6;
    },
  }),
  feature(VOLUME_FAMILY, {
    key: 'volume_trend_5_20',
    name: 'Volume trend, 5 vs 20 days',
    desc: "The stock's average daily volume over the 5 sessions before your entry against the 20 before it. Above 1× = interest building into the trade, below = fading.",
    version: 1, at: 'entry', unit: 'x', bins: [0.8, 1, 1.25, 1.5],
    needs: { daily: ['$underlying'], dailySessions: RVOL_SESSIONS },
    compute: ctx => {
      const d = ctx.daily('$underlying', RVOL_SESSIONS);
      if (!d) return null;
      if (d.bars.length < RVOL_SESSIONS) return d.bars.length ? { value: null, note: `only ${d.bars.length} sessions of daily history` } : null;
      const long = sum(d.bars.map(vol)) / RVOL_SESSIONS, short = sum(d.bars.slice(-5).map(vol)) / 5;
      return long ? short / long : null;
    },
  }),
  feature(VOLUME_FAMILY, {
    key: 'last_bar_vol_vs_session',
    name: "Last bar's volume vs the session's",
    desc: "The volume of the last 5-minute bar ended before your entry over the average bar's that session so far. Above 1× = you got in on a spike.",
    version: 1, at: 'entry', unit: 'x', bins: [0.75, 1, 1.5, 2.5],
    needs: { intraday: ['$underlying'], session: 'regular' },
    compute: ctx => {
      const s = ctx.intraday('$underlying');
      if (!s) return null;
      if (ctx.clock < '09:40') return { value: null, note: ctx.clock < '09:30' ? 'entered before the open' : 'entered before two bars had ended' };
      const bars = /** @type {Bar[]} */ (s.bars);
      if (bars.length < 2) return null;
      const avg = sum(bars.map(vol)) / bars.length;
      return avg ? vol(bars[bars.length - 1]) / avg : null;
    },
  }),
  feature(VOLUME_FAMILY, {
    key: 'volume_above_entry',
    name: 'Volume traded at or above entry',
    desc: "The share of the session's volume so far that traded at or above your entry price, as a %. Each bar's volume is spread evenly over its range. Low = you bought above where most of the day's shares changed hands. An option uses its underlying's price.",
    version: 1, at: 'entry', unit: '%', bins: [25, 50, 75],
    needs: { intraday: ['$underlying'], session: 'regular' },
    compute: ctx => {
      const s = ctx.intraday('$underlying');
      if (!s) return null;
      const early = tooEarly(ctx, 'entered');
      if (early) return early;
      const price = stockPrice(ctx, s), bars = /** @type {Bar[]} */ (s.bars), total = sum(bars.map(vol));
      if (!price || !total) return null;
      const above = sum(bars.map(b => {
        if (b.low >= price) return vol(b);
        if (b.high < price) return 0;
        return b.high > b.low ? vol(b) * (b.high - price) / (b.high - b.low) : vol(b);
      }));
      return above / total * 100;
    },
  }),
  feature(VOLUME_FAMILY, {
    key: 'vwap_sd_at_entry',
    name: 'Entry vs VWAP, in standard deviations',
    desc: "Your entry's distance from the stock's session VWAP in volume-weighted standard deviations (the VWAP bands). +2 = up at the upper 2σ band, stretched; near 0 = at VWAP. An option uses its underlying.",
    version: 1, at: 'entry', unit: '', bins: [-2, -1, 0, 1, 2],
    needs: { intraday: ['$underlying'], session: 'regular' },
    compute: ctx => {
      const s = ctx.intraday('$underlying');
      if (!s) return null;
      if (ctx.clock < '09:40') return { value: null, note: ctx.clock < '09:30' ? 'entered before the open' : 'entered before two bars had ended' };
      const band = vwapBand(/** @type {Bar[]} */ (s.bars)), price = stockPrice(ctx, s);
      if (!band || !price) return null;
      if (!band.sd) return { value: null, note: 'no spread around VWAP yet' };
      return (price - band.vwap) / band.sd;
    },
  }),
  feature(VOLUME_FAMILY, {
    key: 'obv_30m_at_entry',
    name: 'On-balance volume, 30 minutes before entry',
    desc: "The stock's on-balance volume over the 30 minutes before your entry (each bar's volume counted up when it closed above the bar before, down when below; the 9:30 bar against its open) as a % of the volume traded. +100 = every bar closed higher, buyers in control.",
    version: 1, at: 'entry', unit: '%', bins: [-50, 0, 50],
    needs: { intraday: ['$underlying'], session: 'regular' },
    compute: ctx => {
      const s = ctx.intraday('$underlying');
      if (!s) return null;
      const bars = /** @type {Bar[]} */ (s.bars);
      if (bars.length < OBV_BARS) return { value: null, note: ctx.clock < '09:30' ? 'entered before the open' : 'entered before 30 minutes of bars' };
      let net = 0, total = 0;
      for (let i = bars.length - OBV_BARS; i < bars.length; i++) {
        const v = vol(bars[i]), before = i ? bars[i - 1].close : bars[i].open; // the session's first bar: against its open
        total += v;
        net += Math.sign(bars[i].close - before) * v;
      }
      return total ? net / total * 100 : null;
    },
  }),
];
