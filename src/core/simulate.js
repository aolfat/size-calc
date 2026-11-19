// @ts-check
// The return simulator's model: the market sessions from now to expiry on a market-minutes axis, what a contract or a
// spread is worth at a stock price and moment, its P&L, its breakeven, and the levels its chart marks. Pure, no DOM.
import { RISK_FREE, bsPrice } from './black-scholes.js';
import { nyDateStr, nyWallMs } from './format.js';
import { expiryCloseMs, nyseHoliday } from './options.js';

/** a regular session's length in minutes, 9:30 to 4:00 New York */
export const SESSION_MINUTES = 390;
const MIN = 60000, YEAR = 365 * 24 * 3600 * 1000;

/** @typedef {{ day: string, open: number, close: number }} Session a trading day: its New York date and the open and close as epoch ms */
/**
 * What the simulator prices, as openSim receives it: a single option (isCall, K, iv), or legs (each its own side, strike,
 * fitted iv, and maybe its own type and expiry). A credit is short what the legs (or the option) are worth.
 * @typedef {{ isCall: boolean, K?: number, iv: number, expStr: string, entry: number, credit?: boolean,
 *   legs?: { K: number, side: number, iv?: number, isCall?: boolean, expStr?: string }[] }} SimContract
 */

/** the day after a New York date @param {string} day */
const nextDay = day => new Date(Date.parse(day + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);

/** a weekday the NYSE is open @param {string} day */
export const isSessionDay = day => { const w = new Date(day + 'T12:00:00Z').getUTCDay(); return w > 0 && w < 6 && !nyseHoliday(day); };

/**
 * The sessions from the one `now` falls in (or the next, outside hours) through expiry's.
 * @param {number} now @param {string} expStr YYYY-MM-DD @returns {Session[]}
 */
export function sessionsThrough(now, expStr) {
  /** @type {Session[]} */
  const out = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expStr || '')) return out;
  for (let day = nyDateStr(new Date(now)), i = 0; day <= expStr && i < 1200; day = nextDay(day), i++) {
    if (!isSessionDay(day)) continue;
    const close = nyWallMs(day, '16:00');
    if (close > now) out.push({ day, open: nyWallMs(day, '09:30'), close });
  }
  return out;
}

/**
 * An instant on the market-minutes axis: each session is SESSION_MINUTES wide, nights and weekends take no room.
 * Before the first open it's 0; between sessions it's the next one's open.
 * @param {Session[]} sessions @param {number} t
 */
export function minuteOf(sessions, t) {
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (t <= s.close) return i * SESSION_MINUTES + Math.max(0, (t - s.open) / MIN);
  }
  return sessions.length * SESSION_MINUTES;
}

/** the instant at a point on the market-minutes axis @param {Session[]} sessions @param {number} u */
export function momentAt(sessions, u) {
  if (!sessions.length) return NaN;
  const i = Math.max(0, Math.min(sessions.length - 1, Math.floor(u / SESSION_MINUTES - 1e-9)));
  return sessions[i].open + Math.max(0, Math.min(SESSION_MINUTES, u - i * SESSION_MINUTES)) * MIN;
}

/**
 * What one contract (or one spread, its legs netted in their ratio) is worth per share with the stock at S at instant t,
 * IV held. A leg's own expiry prices it; past its expiry it's worth its intrinsic value.
 * @param {SimContract} o @param {number} S @param {number} t
 */
export function contractValue(o, S, t) {
  const exp = expiryCloseMs(o.expStr);
  const years = (/** @type {number} */ end) => Math.max(0, (end - t) / YEAR);
  if (o.legs) return o.legs.reduce((a, L) => a + L.side * bsPrice(L.isCall ?? o.isCall, S, L.K, years(L.expStr ? expiryCloseMs(L.expStr) : exp), L.iv || o.iv, RISK_FREE), 0);
  return bsPrice(o.isCall, S, /** @type {number} */ (o.K), years(exp), o.iv, RISK_FREE);
}

/** the gain per share against the entry: a credit gains as what it's short loses value @param {SimContract} o @param {number} value */
export const gainPerShare = (o, value) => o.credit ? o.entry - value : value - o.entry;

/**
 * The stock price where a P&L crosses zero nearest the price now, within half to one and a half times it; null when
 * it never does there (a spread already past its max, a deep loser).
 * @param {(S: number) => number} pnl @param {number} spot @returns {number | null}
 */
export function breakevenNear(pnl, spot) {
  const lo = spot * 0.5, hi = spot * 1.5, N = 240;
  /** @type {number | null} */
  let best = null;
  let a = lo, fa = pnl(lo);
  for (let i = 1; i <= N; i++) {
    const b = lo + (hi - lo) * i / N, fb = pnl(b);
    if (fa === 0 || (fa < 0) !== (fb < 0)) {
      let x = a, y = b, fx = fa;
      for (let k = 0; k < 40 && fx !== 0; k++) { const m = (x + y) / 2, fm = pnl(m); if ((fm < 0) === (fx < 0)) { x = m; fx = fm; } else y = m; }
      const at = fx === 0 ? x : (x + y) / 2;
      if (best === null || Math.abs(at - spot) < Math.abs(best - spot)) best = at;
    }
    a = b; fa = fb;
  }
  return best;
}

/**
 * The levels the chart marks and the target snaps to: the stop and 1R, 2R and 3R past the price on the trade's side
 * (R = the distance to the stop), or one standard deviation either way by expiry for a position with no stop.
 * @param {{ spot: number, stop?: number | null, em?: number }} o @returns {{ id: string, label: string, price: number, tone: 'stop' | 'target' | 'band' }[]}
 */
export function simLevels(o) {
  const round = (/** @type {number} */ v) => Math.round(v * 100) / 100;
  if (o.stop != null && o.stop > 0 && o.stop !== o.spot) {
    const r = o.spot - o.stop;
    return [{ id: 'stop', label: 'Stop', price: o.stop, tone: 'stop' },
      ...[1, 2, 3].map(n => ({ id: `${n}R`, label: `${n}R`, price: round(o.spot + n * r), tone: /** @type {'target'} */ ('target') }))];
  }
  if (o.em && o.em > 0) return [-1, 1].map(n => ({ id: n < 0 ? '-1s' : '+1s', label: n < 0 ? '−1σ' : '+1σ', price: round(o.spot + n * o.em), tone: /** @type {'band'} */ ('band') }));
  return [];
}
