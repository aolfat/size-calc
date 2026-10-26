// @ts-check
// Display formatting: money, numbers, dates, leverage labels, and HTML escaping.

/** @param {string} expStr @returns {string} */
export function expChat(expStr) { // 2026-09-18 → 9/18
  const p = (expStr || '').split('-');
  return p.length === 3 ? +p[1] + '/' + +p[2] : expStr;
}

/** @param {number | string} v */
export function fmtFuturesPrice(v) { return Number(v).toLocaleString('en-US', { maximumFractionDigits: 10 }); }

/** @param {unknown} value @returns {string} */
export function marketEscape(value) {
  return String(value).replace(/[&<>"']/g, ch => /** @type {Record<string, string>} */ ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
}

/** @param {number} l */
export function fmtLev(l) { return (l < 0 ? '−' : '') + Math.abs(l) + 'x'; }

/** @param {number} v */
export function fmtDayVol(v) {
  if (!(v > 0)) return '—';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(0) + 'M';
  return '$' + (v / 1e3).toFixed(0) + 'k';
}

/** @param {number | string} v */
export function fmt$(v) { return '$' + Number(v).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}); }

/** @param {number | string} v @param {number} [d] */
export function fmtN(v, d=2) { return Number(v).toFixed(d); }

const NY_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }); // en-CA formats as YYYY-MM-DD

/** The market's (New York) calendar date as YYYY-MM-DD, whatever the device's zone. @param {Date} d */
export function nyDateStr(d) { return NY_DAY.format(d); }

/** @type {Map<string, Intl.DateTimeFormat>} */
const WALL = new Map();
/** A zone's wall clock at an instant: { day: 'YYYY-MM-DD', time: 'HH:MM' }. @param {number} ms @param {string} zone an IANA zone */
export function wallClock(ms, zone) {
  let f = WALL.get(zone);
  if (!f) WALL.set(zone, f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  /** @type {Record<string, string>} */
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const asUtc = (/** @type {string} */ day, /** @type {string} */ time) => Date.parse(`${day}T${time}:00Z`);
/** A New York wall clock as epoch ms, whatever the device's zone. @param {string} day 'YYYY-MM-DD' @param {string} time 'HH:MM' */
export function nyWallMs(day, time) {
  const wall = asUtc(day, time);
  let ms = wall;
  for (let i = 0; i < 2; i++) { const w = wallClock(ms, 'America/New_York'); ms += wall - asUtc(w.day, w.time); } // the second pass settles a DST day
  return ms;
}

/** A New York wall clock read in another zone: '09:30' on a summer day is '06:30' in Los Angeles. @param {string} day @param {string} time @param {string} zone */
export function nyWallIn(day, time, zone) {
  if (zone === 'America/New_York' || !day || !time || !Number.isFinite(asUtc(day, time))) return { day, time };
  return wallClock(nyWallMs(day, time), zone);
}
