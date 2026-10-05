// Ticker: load a symbol (or send shorthand to quick lookup), fetch the quote, recent ticker chips.
import { state } from '../state.js';
import { isShorthand, parseQuickStr } from '../core/shorthand.js';
import { store } from '../lib/store.js';
import { baseUrl, headers } from '../services/tradier.js';
import { fetchChain, markActiveExp, renderChain, renderExpTabs } from './chain.js';
import { fetchChart } from './chart.js';
import { fetchAdr } from './daily.js';
import { clearError, showError } from './feedback.js';
import { fetchQuickOption } from './quick-lookup.js';
import { requireKey } from './settings.js';
import { renderQuote, setQuoteVisible } from './shares.js';

export function pushRecentTicker(t) {
  let arr = [];
  try { arr = JSON.parse(store.get('recent_tickers') || '[]'); } catch(e) {}
  arr = [t, ...arr.filter(x => x !== t)].slice(0, 5);
  store.set('recent_tickers', JSON.stringify(arr));
  renderRecentTickers();
}

export function renderRecentTickers() {
  let arr = [];
  try { arr = JSON.parse(store.get('recent_tickers') || '[]'); } catch(e) {}
  const cur = document.getElementById('ticker').value.trim().toUpperCase();
  document.getElementById('recentTickers').innerHTML = arr
    .filter(t => t !== cur)
    .map(t => `<button class="filter-btn" data-action="loadTicker" data-arg="${t}">${t}</button>`)
    .join('');
}

export function loadTicker(t) {
  document.getElementById('ticker').value = t;
  fetchQuote();
}

export async function fetchQuote() {
  if (state.currentMode === 'futures') return;
  const ticker = document.getElementById('ticker').value.trim().toUpperCase();
  if (!ticker) { showError('Enter a ticker symbol.'); return; }
  if (!requireKey()) return;

  clearError();
  document.getElementById('fetchBtnText').innerHTML = '<span class="spinner"></span>';
  setQuoteVisible(false);

  try {
    const qRes = await fetch(`${baseUrl()}/markets/quotes?symbols=${ticker}&greeks=true`, { headers: headers() });
    const qJson = await qRes.json();
    if (ticker !== document.getElementById('ticker').value.trim().toUpperCase()) return;
    const q = qJson?.quotes?.quote;
    if (!q || q.type === 'option') throw new Error('Symbol not found or invalid.');

    // stops belong to the underlying's levels; clear them on a symbol change
    if (state.quoteData && state.quoteData.symbol !== q.symbol) {
      document.getElementById('stopLong').value = '';
      document.getElementById('stopShort').value = '';
      document.getElementById('entryPrice').value = '';
    }
    state.quoteData = q;
    state.chainData = [];
    store.set('last_ticker', ticker);
    pushRecentTicker(ticker);
    renderQuote();
    fetchChart(ticker);
    fetchAdr(ticker);

    if (state.currentMode === 'options') {
      const expRes = await fetch(`${baseUrl()}/markets/options/expirations?symbol=${ticker}&includeAllRoots=true`, { headers: headers() });
      const expJson = await expRes.json();
      if (ticker !== document.getElementById('ticker').value.trim().toUpperCase()) return;
      const exps = expJson?.expirations?.date;
      if (!exps) throw new Error('No options expirations found.');
      const expList = Array.isArray(exps) ? exps : [exps];

      renderExpTabs(expList);
      state.selectedExp = expList[0];
      markActiveExp(state.selectedExp);
      await fetchChain(ticker, state.selectedExp, true);
    }

    if (ticker !== document.getElementById('ticker').value.trim().toUpperCase()) return;
    setQuoteVisible(!(state.positionsView || state.utilsView || state.marketView || state.currentMode === 'futures'));
    document.getElementById('lastUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch(e) {
    if (ticker === document.getElementById('ticker').value.trim().toUpperCase()) showError('Error: ' + e.message);
  } finally {
    if (ticker === document.getElementById('ticker').value.trim().toUpperCase()) document.getElementById('fetchBtnText').innerHTML = state.currentMode === 'shares' ? 'Load<span class="btn-word"> quote</span>' : 'Load<span class="btn-word"> chain</span>';
  }
}

export async function refreshQuote() {
  if (state.currentMode === 'futures') return;
  const ticker = document.getElementById('ticker').value.trim().toUpperCase();
  if (!ticker || !state.quoteData) return;
  try {
    const qRes = await fetch(`${baseUrl()}/markets/quotes?symbols=${ticker}`, { headers: headers() });
    const qJson = await qRes.json();
    if (ticker !== document.getElementById('ticker').value.trim().toUpperCase()) return;
    const q = qJson?.quotes?.quote;
    if (q) { state.quoteData = q; renderQuote(); renderChain(); fetchChart(ticker); }
    document.getElementById('lastUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch(e) {}
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
