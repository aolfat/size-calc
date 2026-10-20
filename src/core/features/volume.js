// @ts-check
// Volume features: how heavy the trading was when you got in.
import { family, feature } from './define.js';

export const VOLUME_FAMILY = family({ key: 'volume', name: 'Volume', version: 1 });

/** the sessions a run rate compares against */
const RVOL_SESSIONS = 20;

export const VOLUME_FEATURES = [
  feature(VOLUME_FAMILY, {
    key: 'rvol_at_entry',
    name: 'Volume run rate at entry',
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
];
