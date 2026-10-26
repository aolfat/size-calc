// @ts-check
// Journal calendar and stats, pure (docs/journal-step-2.md, slice 4): the closed trades in numbers. The calendar puts each
// exit's P&L on the New York day it was taken (a trim counts that day, even while the rest is still open), and a day, week
// or month of stats counts the same exits (sliceTrade); all time counts closed trades. Every group (the whole set, a symbol,
// a weekday, a time of day...) gets the same stats, and a group under 10 trades is thin. Deleted trades and trades from
// before the history never count.

/** @typedef {{ key: string, symbol: string, label: string, assetType: string, status: string, bias?: string, direction: string,
 *   openedAt: string, closedAt: string | null, pnl: number, r: number | null, exits: number, holdMs: number | null,
 *   risk?: number | null, partial?: boolean, deleted?: boolean, legs?: any[], realized?: { at: string, qty: number, pnl: number }[] }} StatTrade
 * @typedef {{ pnl: number, keys: string[], byTrade: Record<string, number>, trades: number, wins: number, losses: number, winRate: number | null, profitFactor: number | null }} Day */

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

/** the New York day a counted trade closed, 'YYYY-MM-DD'. @param {StatTrade} t */
export const closeDay = t => nyParts(/** @type {string} */ (t.closedAt)).day;

/**
 * A trade's exits as realized P&L: each one's own when the trade has them, else its whole P&L at the close. Open trades
 * count their exits so far; deleted ones and trades from before the history (no entry, so no P&L) have none.
 * @param {StatTrade} t @returns {{ at: string, pnl: number }[]}
 */
export function exitsOf(t) {
  if (t.deleted || t.status === 'history') return [];
  if (t.realized) return t.realized;
  return t.closedAt && t.status !== 'open' ? [{ at: t.closedAt, pnl: t.pnl }] : [];
}

/** the New York days a trade took P&L on. @param {StatTrade} t */
export const exitDays = t => new Set(exitsOf(t).map(e => nyParts(e.at).day));

/**
 * Win rate and profit factor over a span (a day, a week, a month) of realized P&L: each trade's exits in the span added
 * up, a win above zero and a loss below it; profit factor = gross wins ÷ gross losses, null without a loss.
 * @param {Map<string, number>} byTrade trade key → its realized P&L in the span
 */
function tally(byTrade) {
  const v = [...byTrade.values()].map(round2), wins = v.filter(p => p > 0), losses = v.filter(p => p < 0);
  const gw = wins.reduce((n, p) => n + p, 0), gl = -losses.reduce((n, p) => n + p, 0);
  return {
    trades: v.length, wins: wins.length, losses: losses.length,
    winRate: v.length ? Math.round((wins.length / v.length) * 1000) / 10 : null,
    profitFactor: gl > 0 ? Math.round((gw / gl) * 100) / 100 : null,
  };
}
/** @param {Map<string, number>} into @param {Record<string, number>} from */
const addUp = (into, from) => { for (const [k, p] of Object.entries(from)) into.set(k, (into.get(k) || 0) + p); };

/**
 * Realized P&L per New York day, every exit on the day it was taken: 'YYYY-MM-DD' → { pnl, keys (the trades with an exit
 * that day), byTrade (each one's P&L that day), trades, wins, losses, winRate, profitFactor }, days in order.
 * @param {StatTrade[]} trades
 */
export function dailyPnl(trades) {
  /** @type {Map<string, { pnl: number, byTrade: Map<string, number> }>} */
  const by = new Map();
  for (const t of trades) {
    for (const e of exitsOf(t)) {
      const d = nyParts(e.at).day;
      const c = by.get(d) || { pnl: 0, byTrade: new Map() };
      c.pnl += e.pnl; c.byTrade.set(t.key, (c.byTrade.get(t.key) || 0) + e.pnl);
      by.set(d, c);
    }
  }
  /** @type {Map<string, Day>} */
  const out = new Map();
  for (const d of [...by.keys()].sort()) {
    const c = /** @type {{ pnl: number, byTrade: Map<string, number> }} */ (by.get(d));
    out.set(d, { pnl: round2(c.pnl), keys: [...c.byTrade.keys()], byTrade: Object.fromEntries([...c.byTrade].map(([k, p]) => [k, round2(p)])), ...tally(c.byTrade) });
  }
  return out;
}

/** the periods the stats can be narrowed to */
export const PERIODS = ['day', 'week', 'month'];
/** @param {number} ms */
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
/**
 * The period a New York day falls in: a day is itself, a week is its Monday (a weekend close folds into the week before it,
 * like the calendar), a month is 'YYYY-MM'.
 * @param {string} day 'YYYY-MM-DD' @param {string} unit day | week | month
 */
export function periodKey(day, unit) {
  if (unit === 'month') return day.slice(0, 7);
  if (unit === 'week') { const t = Date.parse(`${day}T00:00:00Z`); return isoDay(t - ((new Date(t).getUTCDay() + 6) % 7) * 864e5); }
  return day;
}
/**
 * A trade as it counts in one period: only the exits taken then, their P&L added up, closed at the last of them, R on that
 * P&L over the trade's risk (partial: true). A trim counts in its period like on the calendar, even while the rest is still
 * open or closes later. A trade with every exit inside is itself. Its realized list is cut to the period, so a week's
 * slice can be cut again by day. Null without an exit then.
 * @param {StatTrade} t @param {string} unit @param {string} key @returns {StatTrade | null}
 */
export function sliceTrade(t, unit, key) {
  const exits = exitsOf(t), inside = exits.filter(e => periodKey(nyParts(e.at).day, unit) === key);
  if (!inside.length) return null;
  if (inside.length === exits.length && t.closedAt && t.status !== 'open') return t;
  const pnl = round2(inside.reduce((n, e) => n + e.pnl, 0));
  return {
    ...t, pnl, r: t.risk && t.risk > 0.005 ? Math.round((pnl / t.risk) * 100) / 100 : null,
    status: pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven', closedAt: inside[inside.length - 1].at,
    exits: inside.length, realized: /** @type {any[]} */ (inside), partial: true,
  };
}
/** the trades with exits in one period, as they count there (sliceTrade); all time: every counted trade. @param {StatTrade[]} trades @param {string} unit @param {string} key */
export const inPeriod = (trades, unit, key) => PERIODS.includes(unit)
  ? /** @type {StatTrade[]} */ (trades.map(t => sliceTrade(t, unit, key)).filter(Boolean)) : countedTrades(trades);
/** the New York days of every exit. @param {StatTrade[]} trades */
const exitDayList = trades => trades.flatMap(t => exitsOf(t).map(e => nyParts(e.at).day));
/** the periods with exits, newest first. @param {StatTrade[]} trades @param {string} unit */
export const activePeriods = (trades, unit) => [...new Set(exitDayList(trades).map(d => periodKey(d, unit)))].sort().reverse();
/**
 * ‹ or ›: the nearest period with exits before (by < 0) or after the one shown, or null at the end.
 * @param {string[]} active newest first @param {string} key @param {number} by
 */
export function stepPeriod(active, key, by) {
  if (by < 0) return active.find(k => k < key) || null;
  const newer = active.filter(k => k > key);
  return newer.length ? newer[newer.length - 1] : null;
}
/**
 * Switching day / week / month keeps your place: the newest exit inside what's shown now (or its first day when it has
 * none) picks the new period; from all time, the newest exit of all.
 * @param {StatTrade[]} trades @param {string} fromUnit @param {string} fromKey @param {string} toUnit
 */
export function switchPeriod(trades, fromUnit, fromKey, toUnit) {
  const days = exitDayList(PERIODS.includes(fromUnit) ? inPeriod(trades, fromUnit, fromKey) : trades).sort();
  const anchor = days[days.length - 1] || (PERIODS.includes(fromUnit) && fromKey ? (fromKey.length === 7 ? `${fromKey}-01` : fromKey) : '');
  return anchor && PERIODS.includes(toUnit) ? periodKey(anchor, toUnit) : '';
}

/**
 * A month as weeks of weekdays (Mon to Fri), each day with its P&L, trade count, win rate and profit factor, and each week's
 * total, trades and win rate (start = its Monday); weekend exits (rare: a late fill stamped Saturday) fold into that week's
 * total. A trade trimmed on two days counts once in the week and the month, its exits there added up. Days outside the
 * month are null. The month's own: P&L, trades, wins, losses, win rate, profit factor, and its green and red days.
 * @param {Map<string, Day>} daily @param {string} month 'YYYY-MM'
 */
export function calendarMonth(daily, month) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)), last = new Date(Date.UTC(y, m, 0));
  // back to the Monday on or before the 1st
  const start = new Date(first.getTime() - ((first.getUTCDay() + 6) % 7) * 864e5);
  /** @typedef {{ day: string, pnl: number | null, trades: number, winRate: number | null, profitFactor: number | null } | null} CalDay */
  /** @type {({ start: string, days: CalDay[], pnl: number } & ReturnType<typeof tally>)[]} */
  const weeks = [];
  for (let t = start.getTime(); t <= last.getTime(); t += 7 * 864e5) {
    /** @type {CalDay[]} */
    const days = [];
    /** @type {Map<string, number>} */
    const byTrade = new Map();
    let pnl = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(t + i * 864e5), day = d.toISOString().slice(0, 10), inMonth = d.getUTCMonth() === m - 1;
      const c = daily.get(day);
      if (inMonth && c) { pnl = round2(pnl + c.pnl); addUp(byTrade, c.byTrade); }
      if (i < 5) days.push(inMonth ? { day, pnl: c ? c.pnl : null, trades: c ? c.trades : 0, winRate: c ? c.winRate : null, profitFactor: c ? c.profitFactor : null } : null);
    }
    weeks.push({ start: isoDay(t), days, pnl, ...tally(byTrade) });
  }
  const days = [...daily].filter(([d]) => d.startsWith(month));
  /** @type {Map<string, number>} */
  const byTrade = new Map();
  for (const [, c] of days) addUp(byTrade, c.byTrade);
  return { month, weeks, days: days.length, pnl: round2(days.reduce((n, [, c]) => n + c.pnl, 0)), ...tally(byTrade), green: days.filter(([, c]) => c.pnl > 0).length, red: days.filter(([, c]) => c.pnl < 0).length };
}

/** the months with exits, newest first ('YYYY-MM'). @param {Map<string, any>} daily */
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

/** the stats per day, week or month, each over the exits taken then (inPeriod), newest first: [{ key, ...groupStats }]. @param {StatTrade[]} trades @param {string} unit */
export const periodResults = (trades, unit) => activePeriods(trades, unit).map(key => ({ key, ...groupStats(inPeriod(trades, unit, key)) }));

/** P&L per month, newest first: [{ month, ...groupStats }]. @param {StatTrade[]} trades */
export const monthlyResults = trades => periodResults(trades, 'month').map(({ key, ...s }) => ({ month: key, ...s }));

// the time-of-day buckets on the first entry, New York time (from Trading-Journal-AI)
export const TIME_BUCKETS = [['09:30', '09:45', '9:30–9:45'], ['09:45', '10:30', '9:45–10:30'], ['10:30', '11:00', '10:30–11:00'], ['11:00', '13:30', '11:00–1:30'], ['13:30', '15:30', '1:30–3:30'], ['15:30', '16:00', '3:30–4:00']];
/** @param {string} time 'HH:MM' */
export const timeBucket = time => (TIME_BUCKETS.find(([a, b]) => time >= a && time < b) || ['', '', 'Extended hours'])[2];

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** @param {number | null} ms */
export const holdBucket = ms => ms === null ? 'Unknown' : ms < 15 * MIN ? 'Under 15m' : ms < HOUR ? '15m–1h' : ms < 4 * HOUR ? '1–4h' : ms < DAY ? 'Same day, 4h+' : ms < 5 * DAY ? '1–5 days' : 'Over 5 days';
const HOLD_ORDER = ['Under 15m', '15m–1h', '1–4h', 'Same day, 4h+', '1–5 days', 'Over 5 days', 'Unknown'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const R_BINS = [[-Infinity, -2, 'Under −2R'], [-2, -1.5, '−2 to −1.5R'], [-1.5, -1, '−1.5 to −1R'], [-1, -0.5, '−1 to −0.5R'], [-0.5, 0, '−0.5 to 0R'], [0, 0.5, '0 to 0.5R'], [0.5, 1, '0.5 to 1R'], [1, 2, '1 to 2R'], [2, 3, '2 to 3R'], [3, Infinity, '3R and up']];

/** @param {StatTrade} t */
const instrumentOf = t => t.legs ? 'Spreads' : t.assetType === 'OPTION' ? 'Options' : t.assetType === 'FUTURE' ? 'Futures' : 'Stocks';
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
 * Stats per label over the closed trades: a trade counts in each of its groups (two setups = both rows, so the rows can
 * add up to more than the total), and the ones with none are counted apart. order puts known groups first, in its order.
 * @param {StatTrade[]} trades @param {(t: StatTrade) => string[]} keysOf @param {string[]} [order]
 * @returns {{ rows: { group: string, stats: ReturnType<typeof groupStats> }[], none: number }}
 */
export function statsByLabel(trades, keysOf, order = []) {
  const list = countedTrades(trades);
  /** @type {Map<string, StatTrade[]>} */
  const by = new Map();
  let none = 0;
  for (const t of list) {
    const keys = [...new Set(keysOf(t))];
    if (!keys.length) none++;
    for (const k of keys) { if (!by.has(k)) by.set(k, []); /** @type {StatTrade[]} */ (by.get(k)).push(t); }
  }
  const at = (/** @type {string} */ g) => { const i = order.indexOf(g); return i < 0 ? order.length : i; };
  const rows = [...by].map(([group, ts]) => ({ group, stats: groupStats(ts) }))
    .sort((a, b) => at(a.group) - at(b.group) || b.stats.trades - a.stats.trades || b.stats.net - a.stats.net);
  return { rows, none };
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
