// @ts-check
// Chart indicators: moving averages of the closes (EMA and SMA), warmed up on bars before the ones shown. Pure, no DOM.

/**
 * An exponential moving average, seeded with the first close (the 8 EMA every chart has drawn this way).
 * @param {number[]} closes @param {number} n
 * @returns {number[]}
 */
export function ema(closes, n) {
  const k = 2 / (n + 1), out = [];
  let e = closes.length ? closes[0] : 0;
  for (const c of closes) { e = c * k + e * (1 - k); out.push(e); }
  return out;
}

/**
 * A simple moving average: null until there are n closes.
 * @param {number[]} closes @param {number} n
 * @returns {(number | null)[]}
 */
export function sma(closes, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= n) sum -= closes[i - n];
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

/**
 * One moving average over the bars shown, warmed up on the closes before them (warm), so a 21 EMA on today's
 * 5-minute bars starts from the days before instead of today's first bar. An SMA without n closes yet is null.
 * @param {number[]} warm the closes before the first bar shown, oldest first
 * @param {number[]} closes the closes shown
 * @param {'ema' | 'sma'} kind @param {number} n
 * @returns {(number | null)[]}
 */
export function movingAverage(warm, closes, kind, n) {
  const all = [...warm, ...closes];
  return (kind === 'ema' ? ema(all, n) : sma(all, n)).slice(warm.length);
}
