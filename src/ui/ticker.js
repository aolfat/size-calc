// Ticker: load a symbol (or send shorthand to quick lookup), fetch the quote, recent ticker chips.
import { state } from '../state.js';
import { marketEscape } from '../core/format.js';
import { isShorthand, parseQuickStr } from '../core/shorthand.js';
import { store } from '../lib/store.js';
import { baseUrl, headers } from '../services/tradier.js';
import { fetchChain, markActiveExp, renderChain, renderExpTabs } from './chain.js';
import { fetchChart } from './chart.js';
import { fetchAdr, updateChartVisibility } from './daily.js';
import { clearError, showError } from './feedback.js';
import { fetchQuickOption } from './quick-lookup.js';
import { requireKey } from './settings.js';
import { renderQuote, setQuoteVisible } from './shares.js';

// what a stock / ETF / index symbol can look like (BRK.B, BF-B); anything else is never fetched or stored
export const SYMBOL_RE = /^[A-Z0-9][A-Z0-9./^-]{0,14}$/;
export const isSymbol = s => typeof s === 'string' && SYMBOL_RE.test(s);

function recentTickers() {
  let arr = [];
  try { arr = JSON.parse(store.get('recent_tickers') || '[]'); } catch(e) {}
  return Array.isArray(arr) ? arr.filter(isSymbol) : [];
}

export function pushRecentTicker(t) {
  if (!isSymbol(t)) return;
  store.set('recent_tickers', JSON.stringify([t, ...recentTickers().filter(x => x !== t)].slice(0, 5)));
  renderRecentTickers();
}

export function renderRecentTickers() {
  const cur = document.getElementById('ticker').value.trim().toUpperCase();
  document.getElementById('recentTickers').innerHTML = recentTickers()
    .filter(t => t !== cur)
    .map(t => `<button class="filter-btn" data-action="loadTicker" data-arg="${marketEscape(t)}">${marketEscape(t)}</button>`)
    .join('');
}

export function loadTicker(t) {
  document.getElementById('ticker').value = t;
  fetchQuote();
}

// the one path that reads the ticker field (it doubles as the search box); everything after keys off quoteData.symbol
export async function fetchQuote() {
  if (state.currentMode === 'futures') return;
  const ticker = document.getElementById('ticker').value.trim().toUpperCase();
  if (!ticker) { showError('Enter a ticker symbol.'); return; }
  if (!isSymbol(ticker)) { showError('Not a ticker symbol. Try AAPL or BRK.B.'); return; }
  if (!requireKey()) return;

  const req = ++state.quoteRequestId;
  const current = () => req === state.quoteRequestId;
  clearError();
  document.getElementById('fetchBtnText').innerHTML = '<span class="spinner"></span>';
  setQuoteVisible(false);

  try {
    const qRes = await fetch(`${baseUrl()}/markets/quotes?symbols=${encodeURIComponent(ticker)}&greeks=true`, { headers: headers() });
    const qJson = await qRes.json();
    if (!current()) return;
    const q = qJson?.quotes?.quote;
    if (!q || Array.isArray(q) || q.type === 'option') throw new Error('Symbol not found or invalid.');
    if (!q.symbol) q.symbol = ticker;
    const sym = q.symbol;

    // stops and bars belong to the underlying; clear them on a symbol change
    if (state.quoteData && state.quoteData.symbol !== sym) {
      document.getElementById('stopLong').value = '';
      document.getElementById('stopShort').value = '';
      document.getElementById('entryPrice').value = '';
      state.chartBars = []; // the chart hides until this symbol's bars land
      state.chartHover = -1;
    }
    state.quoteData = q;
    state.chainData = [];
    if (isSymbol(sym)) { store.set('last_ticker', sym); pushRecentTicker(sym); }
    renderQuote();
    updateChartVisibility();
    fetchChart(sym);
    fetchAdr(sym);

    if (state.currentMode === 'options') {
      const expRes = await fetch(`${baseUrl()}/markets/options/expirations?symbol=${encodeURIComponent(sym)}&includeAllRoots=true`, { headers: headers() });
      const expJson = await expRes.json();
      if (!current()) return;
      const exps = expJson?.expirations?.date;
      if (!exps) throw new Error('No options expirations found.');
      const expList = Array.isArray(exps) ? exps : [exps];

      renderExpTabs(expList);
      state.selectedExp = expList[0];
      markActiveExp(state.selectedExp);
      await fetchChain(sym, state.selectedExp, true);
    }
    if (current()) document.getElementById('lastUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch(e) {
    if (current()) showError('Error: ' + e.message);
  } finally {
    // a newer Load owns the button and the sections; otherwise show whatever quote is loaded now
    if (current()) {
      document.getElementById('fetchBtnText').innerHTML = state.currentMode === 'shares' ? 'Load<span class="btn-word"> quote</span>' : 'Load<span class="btn-word"> chain</span>';
      setQuoteVisible(!!state.quoteData && !(state.positionsView || state.utilsView || state.marketView || state.currentMode === 'futures'));
    }
  }
}

// re-reads the LOADED symbol, never the field; true only when a fresh quote for it was applied
export async function refreshQuote() {
  if (state.currentMode === 'futures') return false;
  const ticker = state.quoteData?.symbol;
  if (!ticker) return false;
  try {
    const qRes = await fetch(`${baseUrl()}/markets/quotes?symbols=${encodeURIComponent(ticker)}`, { headers: headers() });
    const qJson = await qRes.json();
    const q = qJson?.quotes?.quote;
    if (!q || q.symbol !== ticker || state.quoteData?.symbol !== ticker || state.currentMode === 'futures') return false;
    state.quoteData = q; renderQuote(); renderChain(); fetchChart(ticker);
    document.getElementById('lastUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString();
    return true;
  } catch(e) { return false; }
}

export function submitTicker() {
  const v = document.getElementById('ticker').value.trim();
  return isShorthand(v) ? fetchQuickOption(v, true) : fetchQuote();
}

export const TICKER_HINT = 'Or pin a contract: AAPL 245c 6/20';

export function tickerInputChanged() {
  const v = document.getElementById('ticker').value;
  const el = document.getElementById('tickerParsed');
  const parsed = isShorthand(v) ? parseQuickStr(v) : null;
  el.textContent = !isShorthand(v) ? TICKER_HINT : parsed ? 'Pin ' + parsed.display : 'Keep typing: ticker, strike, and expiry';
  el.className = 'ticker-hint' + (!isShorthand(v) ? '' : parsed ? ' ok' : ' wait');
}
