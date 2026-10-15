// @ts-check
// The Journal's trade page, pure: a trade's saved 5-minute bars unpacked and cut to its hold, where its fills land on a
// chart, the daily window around it, and its excursions (MFE, MAE, exit efficiency; docs/journal-step-2.md, slice 3).
// Times are New York's, the way the bars are stamped.

/** @typedef {{ date: string, time?: string, open: number, high: number, low: number, close: number, volume?: number }} Candle */

const NY_STAMP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** an ISO time as New York's 'YYYY-MM-DD HH:MM'. @param {string} iso */
export function nyStamp(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  /** @type {Record<string, string>} */
  const p = {};
  for (const part of NY_STAMP.formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** the 5-minute bar a stamp falls in: '2026-10-13 09:43' → '2026-10-13 09:40'. @param {string} stamp */
export const barStart = stamp => stamp ? `${stamp.slice(0, 14)}${String(Math.floor(Number(stamp.slice(14, 16)) / 5) * 5).padStart(2, '0')}` : '';

const stampOf = (/** @type {Candle} */ b) => `${b.date} ${b.time || '00:00'}`;

/**
 * Saved rows (bars_5m: { day, bars: [[time, o, h, l, c, v], ...] }) as candles, oldest first.
 * @param {{ day: string, bars: any[] }[]} rows @returns {Candle[]}
 */
export function unpackBars(rows) {
  /** @type {Candle[]} */
  const out = [];
  for (const r of [...rows].sort((a, b) => String(a.day).localeCompare(String(b.day)))) {
    const date = String(r.day).slice(0, 10);
    for (const b of Array.isArray(r.bars) ? r.bars : []) {
      if (!Array.isArray(b) || b.length < 5) continue;
      out.push({ date, time: String(b[0]), open: Number(b[1]), high: Number(b[2]), low: Number(b[3]), close: Number(b[4]), volume: Number(b[5]) || 0 });
    }
  }
  return out.sort((a, b) => stampOf(a).localeCompare(stampOf(b)));
}

const REGULAR = (/** @type {Candle} */ b) => (b.time || '') >= '09:30' && (b.time || '') < '16:00';

/**
 * The bars a chart shows for a trade: its days, regular hours only unless a fill happened outside them.
 * @param {Candle[]} bars @param {{ time: string }[]} fills
 */
export function holdChartBars(bars, fills) {
  const outside = fills.some(f => { const t = nyStamp(f.time).slice(11); return t < '09:30' || t >= '16:00'; });
  return outside ? bars : bars.filter(REGULAR);
}

/**
 * Where each fill lands: the index of the bar it falls in (5-minute: the bar it happened in; daily: its day), and its side.
 * Fills outside the bars are left out.
 * @param {Candle[]} bars @param {{ time: string, side: 'buy' | 'sell', qty: number, price: number }[]} fills
 */
export function fillMarks(bars, fills) {
  const daily = !bars.some(b => b.time);
  /** @type {Map<string, number>} */
  const at = new Map(bars.map((b, i) => [daily ? b.date : stampOf(b), i]));
  /** @type {{ index: number, side: 'buy' | 'sell', qty: number, price: number }[]} */
  const out = [];
  for (const f of fills) {
    const s = nyStamp(f.time);
    const i = at.get(daily ? s.slice(0, 10) : barStart(s));
    if (i !== undefined) out.push({ index: i, side: f.side, qty: f.qty, price: f.price });
  }
  return out;
}

/**
 * The daily view around a trade: 40 sessions before it opened through 10 after it closed (or to the latest bar).
 * @param {Candle[]} daily @param {{ openedAt: string, closedAt: string | null }} trade
 * @returns {{ count: number, offset: number }}
 */
export function dailyWindow(daily, trade) {
  const n = daily.length;
  if (!n) return { count: 63, offset: 0 };
  const day = (/** @type {string} */ iso) => nyStamp(iso).slice(0, 10);
  const idx = (/** @type {string} */ d) => { const i = daily.findIndex(b => b.date >= d); return i < 0 ? n - 1 : i; };
  const open = idx(day(trade.openedAt)), close = trade.closedAt ? idx(day(trade.closedAt)) : n - 1;
  const end = Math.min(n, close + 11), start = Math.max(0, open - 40);
  return { count: Math.max(10, end - start), offset: n - end };
}

/**
 * How far the trade went for and against you while it was open, from the bars inside the hold (the bar it opened in
 * through the bar it closed in). Long: the best high and worst low against the average entry; short, the other way.
 * Dollars on the whole entry (quantity × multiplier), R against the trade's risk. Exit efficiency = realized P&L ÷ MFE,
 * winners only (a loser has no gain to keep), at most 100%. Null for spreads, trades from before the history, and
 * holds with no bars.
 * @param {{ direction: 'long' | 'short', avgEntry: number, entryQty: number, multiplier: number, openedAt: string,
 *   closedAt: string | null, status: string, pnl: number, risk: number | null, legs?: any[] }} trade
 * @param {Candle[]} bars
 */
export function excursions(trade, bars) {
  if (trade.legs || trade.status === 'history' || !(trade.avgEntry > 0)) return null;
  const from = barStart(nyStamp(trade.openedAt)), to = trade.closedAt ? nyStamp(trade.closedAt) : '9999';
  const held = bars.filter(b => { const s = stampOf(b); return s >= from && s <= to; });
  if (!held.length) return null;
  const long = trade.direction === 'long', size = trade.entryQty * trade.multiplier;
  let bestPx = long ? -Infinity : Infinity, worstPx = long ? Infinity : -Infinity;
  for (const b of held) {
    if (long) { bestPx = Math.max(bestPx, b.high); worstPx = Math.min(worstPx, b.low); }
    else { bestPx = Math.min(bestPx, b.low); worstPx = Math.max(worstPx, b.high); }
  }
  const sign = long ? 1 : -1;
  const round = (/** @type {number} */ v) => Math.round(v * 100) / 100;
  const mfe = round(Math.max(0, (bestPx - trade.avgEntry) * sign) * size);
  const mae = round(Math.min(0, (worstPx - trade.avgEntry) * sign) * size);
  const r = (/** @type {number} */ v) => trade.risk && trade.risk > 0 ? Math.round((v / trade.risk) * 100) / 100 : null;
  const closed = trade.status !== 'open';
  return {
    mfe, mae, mfePrice: bestPx, maePrice: worstPx, mfeR: r(mfe), maeR: r(mae), bars: held.length,
    efficiency: closed && trade.pnl > 0 && mfe > 0 ? Math.min(1, Math.round((trade.pnl / mfe) * 1000) / 1000) : null,
  };
}
