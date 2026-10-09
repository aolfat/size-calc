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

/** Local calendar date as YYYY-MM-DD. @param {Date} d */
export function dateStr(d) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}

const NY_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }); // en-CA formats as YYYY-MM-DD

/** The market's (New York) calendar date as YYYY-MM-DD, whatever the device's zone. @param {Date} d */
export function nyDateStr(d) { return NY_DAY.format(d); }
