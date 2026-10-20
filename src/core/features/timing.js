// @ts-check
// Timing features: when in the day you got in. They read only the trade's own time.
import { family, feature } from './define.js';
import { clockMinutes } from './prices.js';

export const TIMING_FAMILY = family({ key: 'timing', name: 'Timing', version: 1 });

export const TIMING_FEATURES = [
  feature(TIMING_FAMILY, {
    key: 'minutes_from_open',
    name: 'Minutes after the open',
    desc: 'Minutes from the 9:30 open to your entry, New York time. Below 0 = in the premarket.',
    version: 1, at: 'entry', unit: '', bins: [15, 30, 60, 120, 240],
    needs: {},
    compute: ctx => clockMinutes(ctx.clock) - 570,
  }),
  feature(TIMING_FAMILY, {
    key: 'session_at_entry',
    name: 'Session',
    desc: 'Whether you got in in the premarket (before 9:30), the regular session, or after hours (4pm on), New York time.',
    version: 1, at: 'entry', unit: '', values: [['premarket', 'Premarket'], ['regular', 'Regular hours'], ['afterhours', 'After hours']],
    needs: {},
    compute: ctx => ctx.clock < '09:30' ? 'premarket' : ctx.clock < '16:00' ? 'regular' : 'afterhours',
  }),
];
