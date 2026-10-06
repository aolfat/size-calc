// @ts-check
// Schwab share orders: the market entry that triggers a stop, the stop's price tick, and the checks a ticket must pass.

/** @typedef {'DAY' | 'GOOD_TILL_CANCEL'} StopDuration */

/**
 * Snap a stop to Schwab's tick (cents from $1 up, four decimals below), rounding toward the entry
 * so the stop sent is never looser than the one the shares were sized on.
 * @param {number} stop @param {boolean} isLong @returns {number}
 */
export function stopTick(stop, isLong) {
  const f = stop >= 1 ? 100 : 10000;
  const n = stop * f;
  const near = Math.round(n);
  const ticks = Math.abs(n - near) < 1e-6 ? near : isLong ? Math.ceil(n) : Math.floor(n);
  return ticks / f;
}

/** Price as Schwab ticks it: two decimals from $1 up, four below. @param {number} p @returns {string} */
export function fmtTick(p) { return '$' + Number(p).toFixed(p >= 1 ? 2 : 4); }

/**
 * One order that triggers another: buy (or sell short) at market, and once it fills, a stop for the same shares.
 * @param {{ symbol: string, qty: number, isLong: boolean, stop: number, stopDuration: StopDuration }} t
 */
export function sharesStopOrder({ symbol, qty, isLong, stop, stopDuration }) {
  const leg = (/** @type {string} */ instruction) => ({ instruction, quantity: qty, instrument: { symbol, assetType: 'EQUITY' } });
  return {
    orderType: 'MARKET',
    session: 'NORMAL',
    duration: 'DAY',
    orderStrategyType: 'TRIGGER',
    orderLegCollection: [leg(isLong ? 'BUY' : 'SELL_SHORT')],
    childOrderStrategies: [{
      orderType: 'STOP',
      session: 'NORMAL',
      duration: stopDuration,
      orderStrategyType: 'SINGLE',
      stopPrice: stop,
      orderLegCollection: [leg(isLong ? 'SELL' : 'BUY_TO_COVER')],
    }],
  };
}

/**
 * Why a shares ticket can't be sent, or '' when it can.
 * @param {{ symbol: string, type?: string, qty: number, isLong: boolean, stop: number, bid?: number, ask?: number, last?: number }} t
 * @returns {string}
 */
export function sharesTicketError({ symbol, type, qty, isLong, stop, bid = 0, ask = 0, last = 0 }) {
  if (type && type !== 'stock' && type !== 'etf') return `${symbol} is not a stock or ETF.`;
  if (!/^[A-Z][A-Z0-9./]{0,9}$/.test(symbol)) return `${symbol} is not a symbol Schwab can trade.`;
  if (!Number.isInteger(qty) || qty < 1) return 'The size is under one share. Raise the risk or tighten the stop.';
  if (!(stop > 0)) return 'No valid stop price.';
  // a stop already through the market would fire the moment the entry fills
  const ref = isLong ? (bid > 0 ? bid : last) : (ask > 0 ? ask : last);
  if (!(ref > 0)) return 'No live quote for ' + symbol + '.';
  if (isLong && stop >= ref) return `The stop ${fmtTick(stop)} is at or above the bid ${fmtTick(ref)}. It would sell as soon as the buy fills.`;
  if (!isLong && stop <= ref) return `The stop ${fmtTick(stop)} is at or below the ask ${fmtTick(ref)}. It would cover as soon as the short fills.`;
  return '';
}

/**
 * Regular session: weekdays 9:30 to 16:00 New York time. Exchange holidays are not known here.
 * @param {number} ms @returns {boolean}
 */
export function inRegularHours(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
  const part = (/** @type {string} */ type) => parts.find(p => p.type === type)?.value || '';
  if (part('weekday') === 'Sat' || part('weekday') === 'Sun') return false;
  const mins = (Number(part('hour')) % 24) * 60 + Number(part('minute'));
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}
