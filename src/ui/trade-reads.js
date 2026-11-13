// Each closed trade's reads from its saved 5-minute bars, read once and kept in state.journalExcursions (trade key →
// { sig, ex, after, stop }): its excursions (MFE, MAE, exit efficiency), what it did after the exits (afterExit) and
// whether its stop was too tight (stopCheck), all from core/trade-page.js. One bars query per symbol; a stock or fund
// held overnight also reads its daily bars (Tradier or Schwab), so the hold matches its trade page. The week and month
// reviews (ui/journal-week.js) and the Setups tab's Exits and stops (ui/journal-setups.js) read through here.
import { nyDay, weekdaysBetween } from '../core/bars.js';
import { fillsFrom } from '../core/journal-records.js';
import { parseSchwabOption } from '../core/positions.js';
import { afterExit, excursions, stopCheck, unpackBars } from '../core/trade-page.js';
import { loadTradeBars, marketDataHere } from '../services/bars.js';
import { dailyHistory } from '../services/tradier.js';
import { state } from '../state.js';

/** what a trade's reads came from: a change (a late fill, a re-close) reads them again */
const signature = t => `${t.closedAt}|${t.entryQty}|${t.avgEntry}`;
/** the 5-minute bars a trade's reads come from: an option contract's own, a stock's; spreads have none */
const barsSymbol = t => t.legs ? '' : t.assetType === 'OPTION' && parseSchwabOption(t.symbol) ? t.symbol.replace(/\s+/g, '') : t.symbol;
/** a trade whose daily bars are its own symbol's (a stock or a fund; not an option, a future, or a fund read on its
 * underlying): the ones held on past the exit on them, here and on the trade page */
export const onOwnDaily = t => !t.legs && !t.setupOn && !['OPTION', 'FUTURE', 'SPREAD'].includes(t.assetType);
/** the fills that closed a trade: a long's sells, a short's buys */
export const exitFillsOf = (t, fills) => { const ids = new Set(t.fillIds); return fills.filter(f => ids.has(f.id) && f.side === (t.direction === 'short' ? 'buy' : 'sell')); };
/** at most this many symbols' bars are read at once */
const AT_ONCE = 4;

const cached = t => { const c = state.journalExcursions[t.key]; return c && c.sig === signature(t) ? c : undefined; };
/** a trade's excursions: undefined until read, null when there are no bars for it */
export const excursionOf = t => cached(t)?.ex;
/** what the price did after a trade's exits: undefined until read, null without bars or exit fills */
export const afterExitOf = t => { const c = cached(t); return c ? c.after ?? null : undefined; };
/** whether a trade's stop was too tight: undefined until read, null without bars or a stop */
export const stopCheckOf = t => { const c = cached(t); return c ? c.stop ?? null : undefined; };
/** all three for core/exit-stats.js: undefined until read */
export const tradeRead = t => { const c = cached(t); return c ? { after: c.after ?? null, stop: c.stop ?? null, maeR: c.ex?.maeR ?? null } : undefined; };

/**
 * Read the closed trades among `trades` that haven't been read yet. onStart runs at once when there's any to read (to
 * say so); resolves true when it read any (the caller redraws), false when there was nothing to read.
 */
export async function readTrades(trades, onStart = () => {}) {
  const closed = trades.filter(t => t.closedAt && t.status !== 'open' && t.status !== 'history' && !t.deleted);
  for (const t of closed) if (!barsSymbol(t) && !cached(t)) state.journalExcursions[t.key] = { sig: signature(t), ex: null, after: null, stop: null };
  const todo = closed.filter(t => barsSymbol(t) && !cached(t));
  if (!todo.length) return false;
  onStart();
  const bySymbol = new Map(), fills = fillsFrom(state.journalRecords || []);
  for (const t of todo) {
    const s = bySymbol.get(barsSymbol(t)) || { days: new Set(), trades: [] };
    weekdaysBetween(nyDay(t.openedAt), nyDay(t.closedAt)).forEach(d => s.days.add(d));
    s.trades.push(t);
    bySymbol.set(barsSymbol(t), s);
  }
  // a few symbols at a time: the Setups tab reads every trade with a setup, and a journal can hold hundreds of symbols
  const queue = [...bySymbol];
  const one = async ([symbol, { days, trades: ts }]) => {
    let bars = [];
    // a stock held overnight is held on past its exit on the daily bars (afterExit, stopCheck), as on its trade page
    const overnight = ts.some(t => onOwnDaily(t) && nyDay(t.openedAt) < nyDay(t.closedAt));
    const dailyBars = overnight && marketDataHere()
      ? dailyHistory(symbol).then(ds => ds.map(d => ({ date: d.date, open: +d.open, high: +d.high, low: +d.low, close: +d.close }))).catch(() => [])
      : Promise.resolve([]);
    try { bars = unpackBars(await loadTradeBars(symbol, [...days].sort())); } catch(e) { bars = []; }
    const daily = await dailyBars;
    for (const t of ts) {
      const exits = exitFillsOf(t, fills), own = onOwnDaily(t) ? daily : [];
      state.journalExcursions[t.key] = { sig: signature(t), ex: bars.length ? excursions(t, bars) : null,
        after: bars.length ? afterExit(t, exits, bars, own) : null, stop: bars.length ? stopCheck(t, exits, bars, own) : null };
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, async () => { while (queue.length) await one(/** @type {any} */ (queue.shift())); }));
  return true;
}
