// @ts-check
// Black-Scholes pricing, shared by the option loss model, card values and the returns simulator.

export const RISK_FREE = 0.04;

/** @param {number} x @returns {number} */
export function normCdf(x) {
  // Abramowitz-Stegun approximation, |error| < 7.5e-8
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

/**
 * European option value; at or past expiry (or with no vol) it is intrinsic.
 * @param {boolean} isCall @param {number} S spot @param {number} K strike @param {number} T years left
 * @param {number} sigma annualized IV @param {number} r risk-free rate
 * @returns {number}
 */
export function bsPrice(isCall, S, K, T, sigma, r) {
  if (T <= 0 || sigma <= 0 || S <= 0) return Math.max(0, isCall ? S - K : K - S);
  const sqT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * sqT);
  const d2 = d1 - sigma * sqT;
  return isCall
    ? S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2)
    : K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

/**
 * Fit this model to an observed premium. Null when the inputs cannot be priced by it;
 * do not substitute an unrelated vendor IV and silently show a different current price.
 * @param {boolean} isCall @param {number} price premium per share @param {number} S spot
 * @param {number} K strike @param {number} T years left @param {number} r risk-free rate
 * @returns {number | null}
 */
export function impliedVolatility(isCall, price, S, K, T, r) {
  if (![price, S, K, T, r].every(Number.isFinite) || price <= 0 || S <= 0 || K <= 0 || T <= 0) return null;
  const value = (/** @type {number} */ vol) => bsPrice(isCall, S, K, T, vol, r);
  let lo = 1e-8, hi = 1;
  // Use a positive near-zero IV: bsPrice's zero-IV shortcut returns intrinsic,
  // whereas the discounted strike sets the lower bound before expiry.
  if (price < value(lo) - 1e-8 || price >= (isCall ? S : K * Math.exp(-r * T))) return null;
  while (value(hi) < price && hi < 1024) hi *= 2;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const estimate = value(mid);
    if (Math.abs(estimate - price) < 1e-8) return mid;
    if (estimate < price) lo = mid; else hi = mid;
  }
  return null;
}
