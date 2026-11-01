// @ts-check
// Tradier's streaming market data: frames into events, and an event folded into the REST quote the app already reads.
// The stream sends trade, quote (bid/ask) and summary (open/high/low/prevClose) events as JSON, numbers often as strings.

/** the WebSocket that streams market events (a production brokerage key; the sandbox has none) */
export const STREAM_URL = 'wss://ws.tradier.com/v1/markets/events';

/**
 * One stream event, its fields as Tradier sends them.
 * @typedef {{ type: string, symbol: string, [k: string]: any }} StreamEvent
 */

/** what the socket sends to watch these symbols; sent again on the open socket to change them @param {string[]} symbols @param {string} sessionid */
export function subscribeMessage(symbols, sessionid) {
  return JSON.stringify({ symbols, sessionid, linebreak: true, filter: ['trade', 'quote', 'summary'], validOnly: true });
}

/** a frame's events: one JSON object per line (linebreak on), anything unreadable or without a type and symbol skipped @param {unknown} data @returns {StreamEvent[]} */
export function parseStreamData(data) {
  if (typeof data !== 'string') return [];
  /** @type {StreamEvent[]} */
  const out = [];
  for (const line of data.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const ev = JSON.parse(s);
      if (ev && typeof ev.type === 'string' && typeof ev.symbol === 'string') out.push(ev);
    } catch (e) {}
  }
  return out;
}

/** a positive number, else undefined @param {unknown} v */
const pos = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined; };

/** whether an epoch-ms time is in New York's regular session, 9:30 to 16:00 @param {number} ms */
function regularHours(ms) {
  const [h, m] = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
    .format(new Date(ms)).split(':').map(Number);
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

/**
 * The quote with one stream event folded in, or the same quote when the event isn't for it or carries nothing usable.
 * A trade moves last, volume and the change (and widens the day's low and high when it prints in regular hours); a quote
 * moves bid and ask; a summary sets open, low, high and the prior close. Dates are epoch ms, like the REST quote's.
 * @template {Record<string, any>} Q
 * @param {Q} q @param {StreamEvent} ev @returns {Q}
 */
export function applyStreamEvent(q, ev) {
  if (!q || !ev || ev.symbol !== q.symbol) return q;
  /** @type {Record<string, any>} */
  const n = { ...q };
  if (ev.type === 'trade') {
    const price = pos(ev.price ?? ev.last);
    if (!price) return q;
    const when = pos(ev.date);
    n.last = price;
    if (when) n.trade_date = when;
    const vol = pos(ev.cvol);
    if (vol) n.volume = vol;
    if (!when || regularHours(when)) {
      if (!(n.high > 0) || price > n.high) n.high = price;
      if (!(n.low > 0) || price < n.low) n.low = price;
    }
  } else if (ev.type === 'quote') {
    const bid = pos(ev.bid), ask = pos(ev.ask);
    if (!bid && !ask) return q;
    if (bid) { n.bid = bid; const d = pos(ev.biddate); if (d) n.bid_date = d; }
    if (ask) { n.ask = ask; const d = pos(ev.askdate); if (d) n.ask_date = d; }
    return /** @type {Q} */ (n);
  } else if (ev.type === 'summary') {
    const open = pos(ev.open), high = pos(ev.high), low = pos(ev.low), prev = pos(ev.prevClose);
    if (!open && !high && !low && !prev) return q;
    if (open) n.open = open;
    if (high) n.high = high;
    if (low) n.low = low;
    if (prev) n.prevclose = prev;
  } else return q;
  if (n.last > 0 && n.prevclose > 0) {
    n.change = +(n.last - n.prevclose).toFixed(4);
    n.change_percentage = +((n.last - n.prevclose) / n.prevclose * 100).toFixed(2);
  }
  return /** @type {Q} */ (n);
}
