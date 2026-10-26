// @ts-check
// The time zone clock times show in: New York (ET, the default) or Pacific (PT), picked in Settings (state.timeZone).
// Only what's shown moves: sessions, trading days, buckets and stats stay on New York's clock.
import { nyWallIn } from '../core/format.js';
import { state } from '../state.js';

export const TIME_ZONES = {
  et: { id: 'America/New_York', abbr: 'ET' },
  pt: { id: 'America/Los_Angeles', abbr: 'PT' },
};

const shown = () => TIME_ZONES[/** @type {'et' | 'pt'} */ (state.timeZone)] || TIME_ZONES.et;
/** the IANA zone clock times show in */
export const displayZone = () => shown().id;
/** 'ET' or 'PT' */
export const zoneAbbr = () => shown().abbr;

/**
 * An instant in the shown zone, toLocaleString with its timeZone filled in; a time of day ('3:45:12 PM') by default.
 * @param {number | string | Date} t @param {Intl.DateTimeFormatOptions} [opts]
 */
export const inZone = (t, opts = { hour: 'numeric', minute: '2-digit', second: '2-digit' }) =>
  new Date(t).toLocaleString('en-US', { ...opts, timeZone: displayZone() });

/** a New York wall clock ('HH:MM' on a 'YYYY-MM-DD' day, the way bars are stamped) as the shown zone's 'HH:MM' @param {string} day @param {string} hhmm */
export const zoneClock = (day, hhmm) => nyWallIn(day, hhmm, displayZone()).time;

/** a New York wall clock on a 12-hour dial, the way the copy says times: '13:30' → '1:30' (or '10:30' in PT) @param {string} day @param {string} hhmm */
export const zoneDial = (day, hhmm) => { const [h, m] = zoneClock(day, hhmm).split(':'); return `${+h % 12 || 12}:${m}`; };

/** a New York wall clock in words: '09:45' → '9:45 ET', or '6:45 PT' @param {string} day @param {string} hhmm */
export const zoneWords = (day, hhmm) => `${zoneDial(day, hhmm)} ${zoneAbbr()}`;
