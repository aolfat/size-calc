// Fund link: a leveraged or inverse fund's position priced off its underlying (TQQQ off QQQ). Both are read at one moment
// (fundAnchor, a quote read, kept fresh while it's used), and within today a price on one converts to the other at the fund's
// leverage (core/lev-etfs.js fundPriceAt / underPriceAt). The position chart, its forms and the close ticket use it.
import { store } from '../lib/store.js';
import { state } from '../state.js';
import { fundOf, parseFunds } from '../core/journal.js';
import { fundPriceAt, underPriceAt } from '../core/lev-etfs.js';
import { priceTick } from '../core/orders.js';
import { marketSource } from '../services/market-source.js';
import { readLegQuotes } from './sheet-quote.js';

const FRESH_MS = 15000;
const listeners = [];

/** called with the symbol after each read, so whatever shows a converted price redraws */
export const onFundAnchor = fn => { listeners.push(fn); };

/**
 * A stock position's fund link: what it moves with and at what leverage, from the built-in list (one of your own funds from
 * the Journal only says which way, not how much, so it has none). Your Journal funds still win: one you keep on itself has none.
 * @param {{ symbol: string, option?: unknown } | null | undefined} row
 * @returns {{ under: string, lev: number } | null}
 */
export function fundLink(row) {
  if (!row || row.option) return null;
  const f = fundOf({ symbol: row.symbol, assetType: 'EQUITY' }, parseFunds(store.get('journal_funds')));
  return f && !f.mine ? { under: f.under, lev: f.lev } : null;
}

/** the read for this position when there is one; reads again when it's older than 15s and a market source exists */
export function fundAnchor(row) {
  const link = fundLink(row);
  if (!link) return null;
  const a = state.fundRead && state.fundRead.symbol === row.symbol ? state.fundRead : null;
  if (marketSource() && (!a || (!a.busy && Date.now() - a.at > FRESH_MS))) readFundAnchor(row.symbol, link);
  return a && a.fundNow > 0 && a.underNow > 0 ? a : null;
}

async function readFundAnchor(symbol, link) {
  const was = state.fundRead && state.fundRead.symbol === symbol ? state.fundRead : null;
  state.fundRead = { ...(was || { fundNow: 0, underNow: 0, at: 0 }), symbol, under: link.under, lev: link.lev, busy: true, failed: false };
  let q = {};
  try { q = await readLegQuotes([symbol, link.under]); } catch (e) { q = {}; }
  if (!state.fundRead || state.fundRead.symbol !== symbol) return;
  const fundNow = q[symbol]?.last || 0, underNow = q[link.under]?.last || 0;
  state.fundRead = fundNow > 0 && underNow > 0
    ? { symbol, under: link.under, lev: link.lev, fundNow, underNow, at: Date.now(), busy: false, failed: false }
    : { ...state.fundRead, busy: false, failed: true, at: Date.now() };
  for (const fn of listeners) fn(symbol);
}

/** the fund's price, on the order grid, when the underlying is at under; 0 when it can't be told */
export function fundPriceFor(row, under) {
  const a = fundAnchor(row);
  const p = a ? fundPriceAt(under, a.lev, a.fundNow, a.underNow) : 0;
  return p > 0 ? priceTick(p) : 0;
}

/** the underlying's price that puts the fund at fund (not rounded: it's a level to watch, not an order); 0 when it can't be told */
export function underPriceFor(row, fund) {
  const a = fundAnchor(row);
  return a ? underPriceAt(fund, a.lev, a.fundNow, a.underNow) : 0;
}

/** '3×' or '3× inverse' */
export const levWords = lev => `${Math.abs(lev)}×${lev < 0 ? ' inverse' : ''}`;

/** what a converted price rests on, for the line under it */
export function anchorWords(row) {
  const link = fundLink(row);
  if (!link) return '';
  const a = fundAnchor(row);
  if (!a) {
    const failed = state.fundRead && state.fundRead.symbol === row.symbol && state.fundRead.failed;
    return failed ? `No quote for ${row.symbol} and ${link.under} to convert with.` : marketSource() ? `Reading ${row.symbol} and ${link.under}…` : 'Converting needs a Tradier key or a Schwab login.';
  }
  return `From ${row.symbol} $${a.fundNow.toFixed(2)} and ${a.under} $${a.underNow.toFixed(2)} now, at ${levWords(a.lev)}. Good for today: the fund resets daily, so recheck an order left open past the close.`;
}
