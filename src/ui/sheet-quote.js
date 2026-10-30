// Sheet quote: the live bid and ask at the top of an order review (entry, position close, target, stop, order change, spread close),
// read from Tradier every 2s while its sheet is open. Only the numbers reach markup, and the frozen ticket never moves with them.
import { state } from '../state.js';
import { fmtTick } from '../core/orders.js';
import { inZone } from '../lib/zone.js';
import { baseUrl, headers } from '../services/tradier.js';
import { onSheetChange } from './sheets.js';

const SHEET_QUOTE_MS = 2000;

/**
 * What a sheet watches: legs of { symbol, n } priced as Σ n × leg (one leg at n 1 for a stock or a contract; a spread its legs
 * in ratio, signed so the net reads as the sheet's price), and the side the order fills on now ('bid', 'ask' or '').
 * @typedef {{ symbol: string, n: number }} QuoteLeg
 */

/** Schwab's padded option symbol ('AAPL  260116C00200000') as Tradier's OCC one; stocks as they are */
export const tradierSymbol = s => String(s || '').replace(/\s+/g, '');

/** one quote read for every leg: { symbol: { last, bid, ask } }; a leg Tradier didn't answer is left out */
export async function readLegQuotes(symbols) {
  const res = await fetch(`${baseUrl()}/markets/quotes?symbols=${encodeURIComponent(symbols.join(','))}`, { headers: headers() });
  const q = (await res.json())?.quotes?.quote;
  const out = {};
  for (const one of Array.isArray(q) ? q : q ? [q] : []) {
    if (symbols.includes(one.symbol)) out[one.symbol] = { last: Number(one.last) || 0, bid: Number(one.bid) || 0, ask: Number(one.ask) || 0 };
  }
  return out;
}

/**
 * The legs as one quote: the bid is what selling it gets now (bought legs at their bids, sold ones at their asks), the ask
 * what buying it costs; a spread has no one last, so it shows the middle. null until every leg has a bid and an ask.
 * @param {QuoteLeg[]} legs @param {Record<string, { last: number, bid: number, ask: number }>} quotes
 */
export function netQuote(legs, quotes) {
  if (!legs.every(l => quotes[l.symbol])) return null;
  if (legs.length === 1 && legs[0].n === 1) return { ...quotes[legs[0].symbol], mid: false };
  let bid = 0, ask = 0;
  for (const l of legs) {
    const q = quotes[l.symbol];
    if (!(q.bid > 0) || !(q.ask > 0)) return null;
    bid += l.n * (l.n > 0 ? q.bid : q.ask);
    ask += l.n * (l.n > 0 ? q.ask : q.bid);
  }
  return { last: (bid + ask) / 2, bid, ask, mid: true };
}

/**
 * Starts the strip for one sheet: `el` is its #...Quote box, `first` a quote already read (the entry review's), `fills` says
 * which side to light as the ticket changes. Opening another sheet, or closing this one, stops it. Resolves once the first read is in.
 * @param {{ sheet: string, el: string, legs: QuoteLeg[], fills: () => string, first?: { last: number, bid: number, ask: number } | null }} watch
 */
export function watchSheetQuote({ sheet, el, legs, fills, first = null }) {
  stopSheetQuote();
  if (!legs.length || !document.getElementById('apiKey').value.trim()) return Promise.resolve(); // no Tradier key, nothing to read
  const gen = ++state.sheetQuoteGen;
  const symbols = legs.map(l => l.symbol);
  state.sheetQuote = { sheet, el, legs, fills, last: 0, bid: 0, ask: 0, mid: legs.length > 1 || legs[0].n !== 1, at: 0, failed: false };
  if (first) setSheetQuote({ last: Number(first.last) || 0, bid: Number(first.bid) || 0, ask: Number(first.ask) || 0 });
  else renderSheetQuote();
  const read = async () => {
    const q = await readLegQuotes(symbols).then(quotes => netQuote(legs, quotes)).catch(() => null);
    if (gen !== state.sheetQuoteGen) return; // closed, or another review opened, while it was out
    if (q) setSheetQuote(q);
    else { state.sheetQuote.failed = true; renderSheetQuote(); }
  };
  const tick = async () => {
    if (gen !== state.sheetQuoteGen) return;
    if (!document.hidden) await read();
    if (gen === state.sheetQuoteGen) state.sheetQuoteTimer = setTimeout(tick, SHEET_QUOTE_MS);
  };
  if (first) { state.sheetQuoteTimer = setTimeout(tick, SHEET_QUOTE_MS); return Promise.resolve(); }
  return tick(); // the first read, so an opener can wait for it
}

export function stopSheetQuote() {
  state.sheetQuoteGen++;
  clearTimeout(state.sheetQuoteTimer);
  const q = state.sheetQuote;
  state.sheetQuote = null;
  if (q) hide(q.el);
}

onSheetChange(name => { if (state.sheetQuote && name !== state.sheetQuote.sheet) stopSheetQuote(); });

/** a quote read elsewhere for the same sheet (the entry review's re-check before sending) shows right away */
export function showSheetQuote(sheet, q) {
  if (state.sheetQuote && state.sheetQuote.sheet === sheet && q) setSheetQuote({ last: Number(q.last) || 0, bid: Number(q.bid) || 0, ask: Number(q.ask) || 0 });
}

function setSheetQuote(q) {
  Object.assign(state.sheetQuote, { last: q.last, bid: q.bid, ask: q.ask, at: Date.now(), failed: false });
  renderSheetQuote();
}

function hide(id) {
  const box = document.getElementById(id);
  box.style.display = 'none';
  box.innerHTML = '';
}

/** Last (a spread's Mid), Bid, Ask; the side the order fills on is lit (the ask on a buy, the bid on a sell) */
export function renderSheetQuote() {
  const q = state.sheetQuote;
  if (!q) return;
  const box = document.getElementById(q.el);
  box.style.display = '';
  const px = v => v > 0 ? fmtTick(v) : '—';
  const cell = (label, v, cls = '', tail = '') => `<div class="tq-cell${cls}"><span class="tq-label">${label}${tail}</span><span class="tq-val">${px(v)}</span></div>`;
  const fills = q.fills();
  // a failed read keeps the last numbers and says how old they are; nothing read yet says nothing
  const status = q.failed ? `<span class="tq-status stale">${q.at ? inZone(q.at) : 'No quote'}</span>`
    : q.at ? '<span class="tq-status"><span class="tq-dot"></span>Live</span>' : '';
  box.innerHTML = cell(q.mid ? 'Mid' : 'Last', q.last, '', status) + cell('Bid', q.bid, fills === 'bid' ? ' fills' : '') + cell('Ask', q.ask, fills === 'ask' ? ' fills' : '');
}
