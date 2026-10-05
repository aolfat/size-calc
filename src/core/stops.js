// @ts-check
// Stop adjustments (none, 5m ATR, percentage) and ATR(14) on regular-session 5-minute bars.

export const ATR_MULTIPLIERS = [0, 0.25, 0.5, 1, 1.5, 2];

/** @param {string | null} value @returns {string} */
export function normalizeStopStrategy(value) { return ['none', 'atr', 'percent'].includes(value) ? value : 'none'; }

/** @param {string | number | null} value @returns {number} NaN when invalid */
export function parseStopPercent(value) {
  const n = value === null || String(value).trim() === '' ? NaN : Number(value);
  return Number.isFinite(n) && n >= 0 && n < 100 ? n : NaN;
}

/** @param {unknown} value @returns {number} */
export function normalizeAtrMultiplier(value) {
  const n = Number(value);
  return ATR_MULTIPLIERS.includes(n) ? n : 0;
}

// Seed with 14 true ranges, then Wilder smoothing. Use the API's epoch timestamps
// rather than interpreting exchange-local strings in the browser's time zone.

/** @param {{ ts: number, h: number, l: number, c: number }[]} bars @param {number} [nowMs] @returns {{ value: number, asOf: number } | null} */
export function calculateAtr5(bars, nowMs = Date.now()) {
  const done = bars.filter(b => Number.isFinite(b.ts) && (b.ts + 300) * 1000 <= nowMs
    && [b.h, b.l, b.c].every(v => Number.isFinite(v) && v > 0) && b.h >= b.l)
    .slice().sort((a, b) => a.ts - b.ts)
    .filter((b, i, sorted) => i === 0 || b.ts !== sorted[i - 1].ts);
  if (done.length < 15) return null; // previous close plus 14 true ranges
  let value = 0;
  for (let i = 1; i < done.length; i++) {
    const b = done[i], prev = done[i - 1].c;
    const tr = Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
    if (i <= 14) { value += tr; if (i === 14) value /= 14; }
    else value = (value * 13 + tr) / 14;
  }
  return { value, asOf: done[done.length - 1].ts };
}
