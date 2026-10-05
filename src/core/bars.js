// @ts-check
// Bar math: client-side interval aggregation, HV20 from daily closes, percentile ranks.

/** @typedef {{ t: string, o: number, h: number, l: number, c: number, v?: number }} Bar */

/** Roll 5-minute bars up to `iv` minutes; buckets never cross a session. @param {Bar[]} bars5 @param {number} iv @returns {Bar[]} */
export function aggregateBars(bars5, iv) {
  if (iv <= 5) return bars5;
  const chunk = Math.round(iv / 5);
  const out = [];
  let day = null, idx = 0;
  for (const b of bars5) {
    const d = (b.t || '').slice(0, 10);
    if (d !== day) { day = d; idx = 0; } // buckets never cross a session boundary
    if (idx % chunk === 0) out.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
    else {
      const cur = out[out.length - 1];
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v || 0;
    }
    idx++;
  }
  return out;
}

// annualized 20-day HV ending at index `end` (exclusive); shared with the lev ETF target tool

/** @param {number[]} closes @param {number} end @returns {number} */
export function hv20At(closes, end) {
  const rets = [];
  for (let i = end - 19; i < end; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
  return Math.sqrt(v * 252);
}

/** Rank of `value` within `arr` (0–100), or null without 20 samples. @param {number} value @param {number[]} arr @returns {number | null} */
export function percentileOf(value, arr) {
  if (!(value > 0) || arr.length < 20) return null;
  return Math.round(arr.filter(v => v < value).length / arr.length * 100);
}
