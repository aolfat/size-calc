// @ts-check
// The economic calendar, pure (docs/journal.md, Calendar): the US releases that move the market, on their New York day
// and time, Jan 2025 to Dec 2027. Fed rate decisions and their press conferences, CPI, PPI, the jobs report, PCE
// (personal income and outlays) and the first GDP estimate are high impact; the FOMC minutes and the Beige Book medium,
// listed only as far as the Fed has dated them (through 2026). Copied by hand from each agency's own schedule
// (federalreserve.gov fomccalendars.htm, its monthly calendars and Beige Book pages; bls.gov news release archives and
// schedules; bea.gov/news/schedule), past dates as they actually came out: the fall 2025 shutdown moved some and
// cancelled October 2025's CPI, PPI and jobs report and Q3 2025's advance GDP.
// To extend it, add the next dates below from the same pages (the agencies publish a year ahead, the Fed's minutes and
// Beige Book less) and move ECON_TO.

/** @typedef {{ kind: string, short: string, name: string, time: string, impact: 'high' | 'medium', ref: string, note: string }} EconEvent */

/** each kind: its tag, its name, its usual New York release time (24h), its impact; a press conference follows each rate decision */
export const ECON_KINDS = /** @type {Record<string, { short: string, name: string, time: string, impact: 'high' | 'medium' }>} */ ({
  fomc: { short: 'FOMC', name: 'Fed rate decision', time: '14:00', impact: 'high' },
  presser: { short: 'Fed presser', name: 'Fed press conference', time: '14:30', impact: 'high' },
  cpi: { short: 'CPI', name: 'CPI', time: '08:30', impact: 'high' },
  ppi: { short: 'PPI', name: 'PPI', time: '08:30', impact: 'high' },
  jobs: { short: 'Jobs', name: 'Jobs report', time: '08:30', impact: 'high' },
  pce: { short: 'PCE', name: 'PCE', time: '08:30', impact: 'high' },
  gdp: { short: 'GDP', name: 'GDP, first estimate', time: '08:30', impact: 'high' },
  minutes: { short: 'Minutes', name: 'FOMC minutes', time: '14:00', impact: 'medium' },
  beige: { short: 'Beige Book', name: 'Beige Book', time: '14:00', impact: 'medium' },
});
/** the days the schedule covers: none are shown outside them */
export const ECON_FROM = '2025-01-01';
export const ECON_TO = '2027-12-31';

// 'day ref' each, a time after '@' when it isn't the kind's usual one; ref is the month ('2025-09') or quarter ('2025Q3')
// the numbers are for, '+' joins two months released together; an FOMC ref of 'sep' marks the meetings with projections,
// a minutes ref the decision day they're from
const SCHEDULE = /** @type {Record<string, string[]>} */ ({
  fomc: [
    '2025-01-29', '2025-03-19 sep', '2025-05-07', '2025-06-18 sep', '2025-07-30', '2025-09-17 sep', '2025-10-29', '2025-12-10 sep',
    '2026-01-28', '2026-03-18 sep', '2026-04-29', '2026-06-17 sep', '2026-07-29', '2026-09-16 sep', '2026-10-28', '2026-12-09 sep',
    '2027-01-27', '2027-03-17 sep', '2027-04-28', '2027-06-09 sep', '2027-07-28', '2027-09-15 sep', '2027-10-27', '2027-12-08 sep',
  ],
  minutes: [
    '2025-02-19 2025-01-29', '2025-04-09 2025-03-19', '2025-05-28 2025-05-07', '2025-07-09 2025-06-18', '2025-08-20 2025-07-30',
    '2025-10-08 2025-09-17', '2025-11-19 2025-10-29', '2025-12-30 2025-12-10',
    '2026-02-18 2026-01-28', '2026-04-08 2026-03-18', '2026-05-20 2026-04-29', '2026-07-08 2026-06-17', '2026-08-19 2026-07-29',
    '2026-10-07 2026-09-16', '2026-11-18 2026-10-28', '2026-12-30 2026-12-09',
  ],
  beige: [
    '2025-01-15', '2025-03-05', '2025-04-23', '2025-06-04', '2025-07-16', '2025-09-03', '2025-10-15', '2025-11-26',
    '2026-01-14', '2026-03-04', '2026-04-15', '2026-06-03', '2026-07-15', '2026-09-02', '2026-10-14', '2026-11-25',
  ],
  cpi: [
    '2025-01-15 2024-12', '2025-02-12 2025-01', '2025-03-12 2025-02', '2025-04-10 2025-03', '2025-05-13 2025-04', '2025-06-11 2025-05',
    '2025-07-15 2025-06', '2025-08-12 2025-07', '2025-09-11 2025-08', '2025-10-24 2025-09', '2025-12-18 2025-11',
    '2026-01-13 2025-12', '2026-02-13 2026-01', '2026-03-11 2026-02', '2026-04-10 2026-03', '2026-05-12 2026-04', '2026-06-10 2026-05',
    '2026-07-14 2026-06', '2026-08-12 2026-07', '2026-09-11 2026-08', '2026-10-14 2026-09', '2026-11-10 2026-10', '2026-12-10 2026-11',
    '2027-01-13 2026-12', '2027-02-11 2027-01', '2027-03-10 2027-02', '2027-04-13 2027-03', '2027-05-12 2027-04', '2027-06-10 2027-05',
    '2027-07-14 2027-06', '2027-08-11 2027-07', '2027-09-14 2027-08', '2027-10-14 2027-09', '2027-11-10 2027-10', '2027-12-10 2027-11',
  ],
  ppi: [
    '2025-01-14 2024-12', '2025-02-13 2025-01', '2025-03-13 2025-02', '2025-04-11 2025-03', '2025-05-15 2025-04', '2025-06-12 2025-05',
    '2025-07-16 2025-06', '2025-08-14 2025-07', '2025-09-10 2025-08', '2025-11-25 2025-09',
    '2026-01-14 2025-11', '2026-01-30 2025-12', '2026-02-27 2026-01', '2026-03-18 2026-02', '2026-04-14 2026-03', '2026-05-13 2026-04',
    '2026-06-11 2026-05', '2026-07-15 2026-06', '2026-08-13 2026-07', '2026-09-10 2026-08', '2026-10-15 2026-09', '2026-11-13 2026-10', '2026-12-15 2026-11',
    '2027-01-14 2026-12', '2027-02-12 2027-01', '2027-03-12 2027-02', '2027-04-14 2027-03', '2027-05-13 2027-04', '2027-06-11 2027-05',
    '2027-07-15 2027-06', '2027-08-10 2027-07', '2027-09-10 2027-08', '2027-10-15 2027-09', '2027-11-12 2027-10', '2027-12-15 2027-11',
  ],
  jobs: [
    '2025-01-10 2024-12', '2025-02-07 2025-01', '2025-03-07 2025-02', '2025-04-04 2025-03', '2025-05-02 2025-04', '2025-06-06 2025-05',
    '2025-07-03 2025-06', '2025-08-01 2025-07', '2025-09-05 2025-08', '2025-11-20 2025-09', '2025-12-16 2025-11',
    '2026-01-09 2025-12', '2026-02-11 2026-01', '2026-03-06 2026-02', '2026-04-03 2026-03', '2026-05-08 2026-04', '2026-06-05 2026-05',
    '2026-07-02 2026-06', '2026-08-07 2026-07', '2026-09-04 2026-08', '2026-10-02 2026-09', '2026-11-06 2026-10', '2026-12-04 2026-11',
    '2027-01-08 2026-12', '2027-02-05 2027-01', '2027-03-05 2027-02', '2027-04-02 2027-03', '2027-05-07 2027-04', '2027-06-04 2027-05',
    '2027-07-02 2027-06', '2027-08-06 2027-07', '2027-09-03 2027-08', '2027-10-08 2027-09', '2027-11-05 2027-10', '2027-12-03 2027-11',
  ],
  pce: [
    '2025-01-31 2024-12', '2025-02-28 2025-01', '2025-03-28 2025-02', '2025-04-30 2025-03@10:00', '2025-05-30 2025-04', '2025-06-27 2025-05',
    '2025-07-31 2025-06', '2025-08-29 2025-07', '2025-09-26 2025-08', '2025-12-05 2025-09@10:00',
    '2026-01-22 2025-10+11@10:00', '2026-02-20 2025-12', '2026-03-13 2026-01', '2026-04-09 2026-02', '2026-04-30 2026-03', '2026-05-28 2026-04',
    '2026-06-25 2026-05', '2026-07-30 2026-06', '2026-08-26 2026-07', '2026-09-30 2026-08', '2026-10-29 2026-09', '2026-11-25 2026-10', '2026-12-23 2026-11',
    '2027-01-28 2026-12', '2027-02-25 2027-01', '2027-03-31 2027-02', '2027-04-29 2027-03', '2027-05-27 2027-04', '2027-06-25 2027-05',
    '2027-07-29 2027-06', '2027-08-25 2027-07', '2027-09-30 2027-08', '2027-10-28 2027-09', '2027-11-24 2027-10', '2027-12-22 2027-11',
  ],
  gdp: [
    '2025-01-30 2024Q4', '2025-04-30 2025Q1', '2025-07-30 2025Q2', '2025-12-23 2025Q3',
    '2026-02-20 2025Q4', '2026-04-30 2026Q1', '2026-07-30 2026Q2', '2026-10-29 2026Q3',
    '2027-01-28 2026Q4', '2027-04-29 2027Q1', '2027-07-29 2027Q2', '2027-10-28 2027Q3',
  ],
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const shortDay = (/** @type {string} */ d) => `${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8)}`;

/** what the numbers are for: 'Sep', 'Oct and Nov', 'Q3', the minutes' meeting 'Oct 28 meeting', the projections
 * @param {string} kind @param {string} ref */
function refWords(kind, ref) {
  if (kind === 'fomc') return ref === 'sep' ? 'with projections' : '';
  if (kind === 'minutes') return /^\d{4}-\d{2}-\d{2}$/.test(ref) ? `${shortDay(ref)} meeting` : '';
  const q = /^(\d{4})Q(\d)$/.exec(ref);
  if (q) return `Q${q[2]}`;
  const m = /^(\d{4})-(\d{2})(?:\+(\d{2}))?$/.exec(ref);
  if (!m) return '';
  return m[3] ? `${MONTHS[+m[2] - 1]} and ${MONTHS[+m[3] - 1]}` : MONTHS[+m[2] - 1];
}

/** day → its events, release time order */
const BY_DAY = (() => {
  /** @type {Map<string, EconEvent[]>} */
  const map = new Map();
  for (const [kind, rows] of Object.entries(SCHEDULE)) {
    for (const row of rows) {
      const [main, at] = row.split('@');
      const [day, ref = ''] = main.split(' ');
      const list = map.get(day) || [];
      const add = (/** @type {string} */ kind, /** @type {string} */ time) => {
        const k = ECON_KINDS[kind];
        list.push({ kind, short: k.short, name: k.name, time, impact: k.impact, ref: kind === 'fomc' || kind === 'presser' ? '' : ref, note: refWords(kind, ref) });
      };
      add(kind, at || ECON_KINDS[kind].time);
      if (kind === 'fomc') add('presser', ECON_KINDS.presser.time);
      map.set(day, list);
    }
  }
  for (const list of map.values()) list.sort((a, b) => a.time.localeCompare(b.time) || Object.keys(ECON_KINDS).indexOf(a.kind) - Object.keys(ECON_KINDS).indexOf(b.kind));
  return map;
})();

/** a New York day's ('YYYY-MM-DD') releases, earliest first; none outside ECON_FROM..ECON_TO
 * @param {string} day @returns {EconEvent[]} */
export function econEvents(day) {
  return (BY_DAY.get(day) || []).map(e => ({ ...e }));
}

/** the loudest of a day's events: 'high', 'medium' or '' */
export const econImpact = (/** @type {EconEvent[]} */ list) => list.some(e => e.impact === 'high') ? 'high' : list.length ? 'medium' : '';

/** whether the schedule covers a day (past ECON_TO it says nothing, not "no events") */
export const econCovers = (/** @type {string} */ day) => day >= ECON_FROM && day <= ECON_TO;

/** '8:30 am', '2:00 pm' from '08:30', '14:00' @param {string} time */
export function econTime(time) {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}
