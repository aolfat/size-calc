// @ts-check
// What several feature families share: the stock's price at the moment, that price in the daily history's terms (a
// split since can leave the two apart: the context's dailyBasis), a median, and short words for volumes and days.


/**
 * The price at the moment. At an entry on the stock itself: your fill. Otherwise (an option's or spread's underlying,
 * another symbol, any exit) the last price in its 5-minute bars, extended hours included; null without them.
 * @param {import('./context.js').FeatureContext} ctx @param {string} [token]
 */
export function momentPrice(ctx, token = '$underlying') {
  if (token === '$underlying' && ctx.entryPrice !== null && !ctx.trade.closedAt) return ctx.entryPrice;
  return ctx.intraday(token, { session: 'all' })?.price ?? null;
}

/**
 * The moment's price in the daily history's terms, with the ratio that got it there; null without a price, or when the
 * two can't be lined up (said as the reason it's unknown).
 * @param {import('./context.js').FeatureContext} ctx @param {string} [token]
 * @returns {{ price: number, basis: number } | null}
 */
export function dailyTermsPrice(ctx, token = '$underlying') {
  const p = momentPrice(ctx, token);
  if (!p) return null;
  const basis = ctx.dailyBasis(token, p);
  if (basis === null) { ctx.unknown("the daily history doesn't line up with the day's prices (a split?)"); return null; }
  return { price: p * basis, basis };
}

/** the middle value; null for none @param {number[]} xs */
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** a volume in words: 1.26M, 850k @param {number} n */
export const volumeWords = n => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(Math.round(n));

/** '10/14' @param {string} d */
export const monthDay = d => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

/** minutes since midnight of an 'HH:MM' clock @param {string} hhmm */
export const clockMinutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
