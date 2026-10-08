// @ts-check
// Schwab orders: the shares entry that triggers a stop, stops and market closes for held positions, price ticks, and ticket checks.

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
 * Snap an option stop to a step every option class accepts ($0.05 under $3, $0.10 from $3; penny classes take these too),
 * rounding toward the market: up on a long, down on a short.
 * @param {number} stop @param {boolean} isLong @returns {number}
 */
export function optionStopTick(stop, isLong) {
  const step = stop < 3 ? 5 : 10; // cents
  const n = stop * 100 / step;
  const near = Math.round(n);
  const steps = Math.abs(n - near) < 1e-6 ? near : isLong ? Math.ceil(n) : Math.floor(n);
  return steps * step / 100;
}

/** @typedef {'EQUITY' | 'OPTION'} TradeAs */

/** The instruction that closes a long or a short. @param {TradeAs} assetType @param {boolean} isLong */
export function closingInstruction(assetType, isLong) {
  return assetType === 'OPTION' ? (isLong ? 'SELL_TO_CLOSE' : 'BUY_TO_CLOSE') : (isLong ? 'SELL' : 'BUY_TO_COVER');
}

/** @param {{ symbol: string, assetType: TradeAs, isLong: boolean, qty: number }} p */
const closingLeg = ({ symbol, assetType, isLong, qty }) => [{ instruction: closingInstruction(assetType, isLong), quantity: qty, instrument: { symbol, assetType } }];

/**
 * A stop that closes a held position.
 * @param {{ symbol: string, assetType: TradeAs, isLong: boolean, qty: number, stop: number, stopDuration: StopDuration }} p
 */
export function closeStopOrder(p) {
  return { orderType: 'STOP', session: 'NORMAL', duration: p.stopDuration, orderStrategyType: 'SINGLE', stopPrice: p.stop, orderLegCollection: closingLeg(p) };
}

/** A market order that closes a held position, today. @param {{ symbol: string, assetType: TradeAs, isLong: boolean, qty: number }} p */
export function closeMarketOrder(p) {
  return { orderType: 'MARKET', session: 'NORMAL', duration: 'DAY', orderStrategyType: 'SINGLE', orderLegCollection: closingLeg(p) };
}

/**
 * A limit that closes a held position: a target.
 * @param {{ symbol: string, assetType: TradeAs, isLong: boolean, qty: number, price: number, duration: StopDuration }} p
 */
export function closeLimitOrder(p) {
  return { orderType: 'LIMIT', session: 'NORMAL', duration: p.duration, orderStrategyType: 'SINGLE', price: p.price, orderLegCollection: closingLeg(p) };
}

/** Two orders where the first to fill cancels the other: a target and its stop. @param {object} a @param {object} b */
export function ocoOrder(a, b) { return { orderStrategyType: 'OCO', childOrderStrategies: [a, b] }; }

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
