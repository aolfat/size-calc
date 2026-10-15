// @ts-check
// Journal calendar and stats, pure (docs/journal-step-2.md, slice 4): the closed trades in numbers. A trade's P&L goes on
// the New York day it closed. Every group (the whole set, a symbol, a weekday, a time of day...) gets the same stats, and a
// group under 10 trades is thin. Trades still open, deleted, or from before the history never count.

/** @typedef {{ key: string, symbol: string, label: string, assetType: string, status: string, bias?: string, direction: string,
 *   openedAt: string, closedAt: string | null, pnl: number, r: number | null, exits: number, holdMs: number | null,
 *   deleted?: boolean, legs?: any[] }} StatTrade */

/** groups smaller than this are marked thin: a handful of trades says little */
export const THIN = 10;
/** a big loss, in R so it scales with size: worse than this */
export const BIG_LOSS_R = -1.5;

const NY_PARTS = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
/** New York's date, time and weekday of an ISO time: { day: 'YYYY-MM-DD', time: 'HH:MM', weekday: 'Mon' } @param {string} iso */
export function nyParts(iso) {
  /** @type {Record<string, string>} */
  const p = {};
  for (const part of NY_PARTS.formatToParts(new Date(iso))) p[part.type] = part.value;
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday };
}

/** the trades the stats count: closed, not deleted, with a known entry. @param {StatTrade[]} trades */
export const countedTrades = trades => trades.filter(t => !t.deleted && t.closedAt && t.status !== 'open' && t.status !== 'history');

const round2 = (/** @type {number} */ v) => Math.round(v * 100) / 100;
const median = (/** @type {number[]} */ xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The same numbers for any group of closed trades: count, net, average and median P&L, win rate, average win and loss,
 * profit factor (gross wins ÷ gross losses; null with no losses), expectancy (= the average P&L per trade), average R
 * over the trades that have one, big losses (worse than −1.5R), and thin under 10 trades.
 * @param {StatTrade[]} trades
 */
export function groupStats(trades) {
  const pnls = trades.map(t => t.pnl);
  const wins = pnls.filter(p => p > 0), losses = pnls.filter(p => p < 0);
  const grossWin = wins.reduce((n, p) => n + p, 0), grossLoss = -losses.reduce((n, p) => n + p, 0);
  const net = pnls.reduce((n, p) => n + p, 0);
  const rs = trades.map(t => t.r).filter(r => r !== null && r !== undefined);
  const n = trades.length;
  return {
    trades: n, net: round2(net),
    avg: n ? round2(net / n) : null, median: n ? round2(/** @type {number} */ (median(pnls))) : null,
    wins: wins.length, losses: losses.length,
    winRate: n ? Math.round((wins.length / n) * 1000) / 10 : null,
    avgWin: wins.length ? round2(grossWin / wins.length) : null, avgLoss: losses.length ? round2(-grossLoss / losses.length) : null,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
    expectancy: n ? round2(net / n) : null,
    avgR: rs.length ? Math.round((rs.reduce((a, r) => a + /** @type {number} */ (r), 0) / rs.length) * 100) / 100 : null,
    bigLosses: trades.filter(t => t.r !== null && t.r !== undefined && t.r < BIG_LOSS_R).length,
    thin: n < THIN,
  };
}

/** P&L per New York day each trade closed: 'YYYY-MM-DD' → { pnl, trades }. @param {StatTrade[]} trades */
export function dailyPnl(trades) {
  /** @type {Map<string, { pnl: number, trades: number }>} */
  const out = new Map();
  for (const t of countedTrades(trades)) {
    const d = nyParts(/** @type {string} */ (t.closedAt)).day;
    const c = out.get(d) || { pnl: 0, trades: 0 };
    c.pnl = round2(c.pnl + t.pnl); c.trades++;
    out.set(d, c);
  }
  return out;
}

/**
 * A month as weeks of weekdays (Mon to Fri), each day with its P&L and trade count, and each week's total; weekend closes
 * (rare: a late fill stamped Saturday) fold into that week's total. Days outside the month are null.
 * @param {Map<string, { pnl: number, trades: number }>} daily @param {string} month 'YYYY-MM'
 */
export function calendarMonth(daily, month) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)), last = new Date(Date.UTC(y, m, 0));
  // back to the Monday on or before the 1st
  const start = new Date(first.getTime() - ((first.getUTCDay() + 6) % 7) * 864e5);
  /** @type {{ days: ({ day: string, pnl: number | null, trades: number } | null)[], pnl: number, trades: number }[]} */
  const weeks = [];
  for (let t = start.getTime(); t <= last.getTime(); t += 7 * 864e5) {
    const week = { days: /** @type {({ day: string, pnl: number | null, trades: number } | null)[]} */ ([]), pnl: 0, trades: 0 };
    for (let i = 0; i < 7; i++) {
      const d = new Date(t + i * 864e5), day = d.toISOString().slice(0, 10), inMonth = d.getUTCMonth() === m - 1;
      const c = daily.get(day);
      if (inMonth && c) { week.pnl = round2(week.pnl + c.pnl); week.trades += c.trades; }
      if (i < 5) week.days.push(inMonth ? { day, pnl: c ? c.pnl : null, trades: c ? c.trades : 0 } : null);
    }
    weeks.push(week);
  }
  const days = [...daily].filter(([d]) => d.startsWith(month));
  return { month, weeks, pnl: round2(days.reduce((n, [, c]) => n + c.pnl, 0)), trades: days.reduce((n, [, c]) => n + c.trades, 0), green: days.filter(([, c]) => c.pnl > 0).length, red: days.filter(([, c]) => c.pnl < 0).length };
}

/** the months that have closed trades, newest first ('YYYY-MM'). @param {Map<string, any>} daily */
export const activeMonths = daily => [...new Set([...daily.keys()].map(d => d.slice(0, 7)))].sort().reverse();

/**
 * The account's P&L over time, trade by trade in the order they closed: the running total, its running peak, the drawdown
 * from that peak, and the deepest drawdown.
 * @param {StatTrade[]} trades
 */
export function equityCurve(trades) {
  const list = countedTrades(trades).sort((a, b) => String(a.closedAt).localeCompare(String(b.closedAt)));
  let total = 0, peak = 0, maxDd = 0, maxDdAt = '';
  const points = list.map(t => {
    total = round2(total + t.pnl);
    peak = Math.max(peak, total);
    const dd = round2(total - peak);
    if (dd < maxDd) { maxDd = dd; maxDdAt = /** @type {string} */ (t.closedAt); }
    return { at: /** @type {string} */ (t.closedAt), total, peak, drawdown: dd };
  });
  return { points, maxDrawdown: maxDd, maxDrawdownAt: maxDdAt };
}

/** the longest runs of wins and of losses in the order trades closed, and the run you're on (breakevens end a run). @param {StatTrade[]} trades */
export function streaks(trades) {
  const list = countedTrades(trades).sort((a, b) => String(a.closedAt).localeCompare(String(b.closedAt)));
  let win = 0, loss = 0, run = 0, kind = '';
  for (const t of list) {
    const k = t.pnl > 0 ? 'win' : t.pnl < 0 ? 'loss' : '';
    run = k && k === kind ? run + 1 : k ? 1 : 0;
    kind = k;
    if (k === 'win') win = Math.max(win, run);
    if (k === 'loss') loss = Math.max(loss, run);
  }
  return { longestWin: win, longestLoss: loss, current: kind ? { kind, count: run } : null };
}

/** P&L per month, newest first: [{ month, ...groupStats }]. @param {StatTrade[]} trades */
export function monthlyResults(trades) {
  /** @type {Map<string, StatTrade[]>} */
  const by = new Map();
  for (const t of countedTrades(trades)) {
    const m = nyParts(/** @type {string} */ (t.closedAt)).day.slice(0, 7);
    if (!by.has(m)) by.set(m, []);
    /** @type {StatTrade[]} */ (by.get(m)).push(t);
  }
  return [...by].sort((a, b) => b[0].localeCompare(a[0])).map(([month, list]) => ({ month, ...groupStats(list) }));
}

// the time-of-day buckets on the first entry, New York time (from Trading-Journal-AI)
const TIME_BUCKETS = [['09:30', '09:45', '9:30–9:45'], ['09:45', '10:30', '9:45–10:30'], ['10:30', '11:00', '10:30–11:00'], ['11:00', '13:30', '11:00–1:30'], ['13:30', '15:30', '1:30–3:30'], ['15:30', '16:00', '3:30–4:00']];
/** @param {string} time 'HH:MM' */
export const timeBucket = time => (TIME_BUCKETS.find(([a, b]) => time >= a && time < b) || ['', '', 'Extended hours'])[2];

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** @param {number | null} ms */
export const holdBucket = ms => ms === null ? 'Unknown' : ms < 15 * MIN ? 'Under 15m' : ms < HOUR ? '15m–1h' : ms < 4 * HOUR ? '1–4h' : ms < DAY ? 'Same day, 4h+' : ms < 5 * DAY ? '1–5 days' : 'Over 5 days';
const HOLD_ORDER = ['Under 15m', '15m–1h', '1–4h', 'Same day, 4h+', '1–5 days', 'Over 5 days', 'Unknown'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const R_BINS = [[-Infinity, -2, 'Under −2R'], [-2, -1.5, '−2 to −1.5R'], [-1.5, -1, '−1.5 to −1R'], [-1, -0.5, '−1 to −0.5R'], [-0.5, 0, '−0.5 to 0R'], [0, 0.5, '0 to 0.5R'], [0.5, 1, '0.5 to 1R'], [1, 2, '1 to 2R'], [2, 3, '2 to 3R'], [3, Infinity, '3R and up']];

/** @param {StatTrade} t */
const instrumentOf = t => t.legs ? 'Spreads' : t.assetType === 'OPTION' ? 'Options' : 'Stocks';
/** @param {StatTrade} t */
const sideOf = t => (t.bias || t.direction) === 'neutral' ? 'Neutral' : (t.bias || t.direction) === 'short' ? 'Short' : 'Long';
/** an option's or a spread's underlying, a stock's own symbol. @param {StatTrade} t */
export const underlyingOf = t => t.legs ? t.symbol : (t.label || t.symbol).split(' ')[0];

/**
 * @param {StatTrade[]} list @param {(t: StatTrade) => string} keyOf @param {string[]} [order]
 * @returns {{ group: string, stats: ReturnType<typeof groupStats> }[]}
 */
function groupBy(list, keyOf, order) {
  /** @type {Map<string, StatTrade[]>} */
  const by = new Map();
  for (const t of list) { const k = keyOf(t); if (!by.has(k)) by.set(k, []); /** @type {StatTrade[]} */ (by.get(k)).push(t); }
  const rows = [...by].map(([group, ts]) => ({ group, stats: groupStats(ts) }));
  if (order) rows.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  return rows;
}

/**
 * Every breakdown the stats page shows. By symbol: the top 40 by trades, then net (the rest summed as 'Others'), and a
 * concentration warning when one underlying made more than half the gross gains. Winners' and losers' average hold.
 * R distribution over the trades with an initial stop.
 * @param {StatTrade[]} trades
 */
export function breakdowns(trades) {
  const list = countedTrades(trades);
  const symbols = groupBy(list, underlyingOf).sort((a, b) => b.stats.trades - a.stats.trades || b.stats.net - a.stats.net);
  const top = symbols.slice(0, 40), rest = symbols.slice(40);
  if (rest.length) top.push({ group: `${rest.length} others`, stats: groupStats(list.filter(t => rest.some(r => r.group === underlyingOf(t)))) });
  const grossWin = list.filter(t => t.pnl > 0).reduce((n, t) => n + t.pnl, 0);
  const leader = symbols.map(s => ({ group: s.group, gain: list.filter(t => underlyingOf(t) === s.group && t.pnl > 0).reduce((n, t) => n + t.pnl, 0) })).sort((a, b) => b.gain - a.gain)[0];
  const avgHold = (/** @type {StatTrade[]} */ ts) => { const hs = ts.map(t => t.holdMs).filter(h => h !== null); return hs.length ? Math.round(hs.reduce((n, h) => n + /** @type {number} */ (h), 0) / hs.length) : null; };
  const withR = list.filter(t => t.r !== null && t.r !== undefined);
  return {
    bySymbol: top,
    concentration: leader && grossWin > 0 && leader.gain / grossWin > 0.5 ? { group: leader.group, share: Math.round((leader.gain / grossWin) * 100) } : null,
    bySide: groupBy(list, sideOf, ['Long', 'Short', 'Neutral']),
    byWeekday: groupBy(list, t => nyParts(t.openedAt).weekday, WEEKDAYS),
    byInstrument: groupBy(list, instrumentOf, ['Stocks', 'Options', 'Spreads']),
    byTimeOfDay: groupBy(list, t => timeBucket(nyParts(t.openedAt).time), [...TIME_BUCKETS.map(b => b[2]), 'Extended hours']),
    byHold: groupBy(list, t => holdBucket(t.holdMs), HOLD_ORDER),
    holdWinners: avgHold(list.filter(t => t.pnl > 0)), holdLosers: avgHold(list.filter(t => t.pnl < 0)),
    byExits: groupBy(list, t => t.exits > 1 ? 'Scaled out' : 'All at once', ['Scaled out', 'All at once']),
    rDistribution: R_BINS.map(([lo, hi, label]) => ({ group: /** @type {string} */ (label), count: withR.filter(t => /** @type {number} */ (t.r) >= /** @type {number} */ (lo) && /** @type {number} */ (t.r) < /** @type {number} */ (hi)).length })),
    withR: withR.length,
  };
}
