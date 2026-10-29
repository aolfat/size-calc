// Ticker: load a symbol (or send shorthand to quick lookup), fetch the quote (a futures ticker's from Schwab), recent ticker chips.
import { state } from '../state.js';
import { inZone } from '../lib/zone.js';
import { marketEscape } from '../core/format.js';
import { futuresSymbol, isFuturesQuote } from '../core/futures.js';
import { cleanExpirations } from '../core/options.js';
import { isShorthand, parseQuickStr, quickParseHint } from '../core/shorthand.js';
import { store } from '../lib/store.js';
import { baseUrl, headers } from '../services/tradier.js';
import { fetchChain, markActiveExp, renderChain, renderExpTabs } from './chain.js';
import { fetchChart } from './chart.js';
import { fetchAdr, updateChartVisibility } from './daily.js';
import { clearError, showError } from './feedback.js';
import { fetchFuturesQuote, futuresLoadError } from './futures.js';
import { fetchQuickOption } from './quick-lookup.js';
import { setSizingMode } from './allocation.js';
import { requireKey } from './settings.js';
import { renderQuote, setQuoteVisible } from './shares.js';

// what a stock / ETF / index symbol can look like (BRK.B, BF-B); anything else is never fetched or stored
export const SYMBOL_RE = /^[A-Z0-9][A-Z0-9./^-]{0,14}$/;
export const isSymbol = s => typeof s === 'string' && SYMBOL_RE.test(s);
/** a ticker the box can load and the recent chips keep: a stock's, or a futures root or month (/MES, /MESZ26) */
export const isTicker = s => isSymbol(s) || !!futuresSymbol(s);

function recentTickers() {
  let arr = [];
  try { arr = JSON.parse(store.get('recent_tickers') || '[]'); } catch(e) {}
  return Array.isArray(arr) ? arr.filter(isTicker) : [];
}

export function pushRecentTicker(t) {
  if (!isTicker(t)) return;
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
  const ticker = document.getElementById('ticker').value.trim().toUpperCase();
  if (!ticker) { showError('Enter a ticker symbol.'); return; }
  const futures = ticker.startsWith('/');
  if (futures) {
    const err = futuresLoadError(ticker);
    if (err) { showError(err); return; }
    if (state.currentMode === 'options') { showError('No option chains for futures here. Size them in Stocks & futures.'); return; }
  } else {
    if (!isSymbol(ticker)) { showError('Not a ticker symbol. Try AAPL, BRK.B or /MES.'); return; }
    if (!requireKey()) return;
  }

  const req = ++state.quoteRequestId;
  const current = () => req === state.quoteRequestId;
  clearError();
  document.getElementById('fetchBtnText').innerHTML = '<span class="spinner"></span>';
  setQuoteVisible(false);

  try {
    const q = futures ? await fetchFuturesQuote(ticker) : await tradierQuote(ticker);
    if (!current()) return;
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
    if (futures && state.sizingMode === 'allocation') setSizingMode('risk'); // futures size by risk only
    if (isTicker(sym)) { store.set('last_ticker', sym); pushRecentTicker(sym); }
    renderQuote();
    updateChartVisibility();
    fetchChart(sym);
    fetchAdr(sym);

    if (state.currentMode === 'options') {
      const expRes = await fetch(`${baseUrl()}/markets/options/expirations?symbol=${encodeURIComponent(sym)}&includeAllRoots=true`, { headers: headers() });
      const expJson = await expRes.json();
      if (!current()) return;
      const expList = cleanExpirations(expJson?.expirations?.date);
      if (!expList.length) throw new Error('No options expirations found.');

      renderExpTabs(expList);
      state.selectedExp = expList[0];
      markActiveExp(state.selectedExp);
      await fetchChain(sym, state.selectedExp, true);
    }
    if (current()) document.getElementById('lastUpdated').textContent = 'Updated ' + inZone(Date.now());
  } catch(e) {
    if (current()) showError('Error: ' + e.message);
  } finally {
    // a newer Load owns the button and the sections; otherwise show whatever quote is loaded now
    if (current()) {
      document.getElementById('fetchBtnText').innerHTML = state.currentMode === 'shares' ? 'Load<span class="btn-word"> quote</span>' : 'Load<span class="btn-word"> chain</span>';
      setQuoteVisible(!!state.quoteData && !(state.positionsView || state.utilsView || state.marketView || state.journalView));
    }
  }
}

// re-reads the LOADED symbol, never the field; true only when a fresh quote for it was applied
export async function refreshQuote() {
  const ticker = state.quoteData?.symbol;
  if (!ticker) return false;
  try {
    const q = isFuturesQuote(state.quoteData) ? await fetchFuturesQuote(ticker) : await tradierQuote(ticker, false).catch(() => null);
    if (!q || q.symbol !== ticker || state.quoteData?.symbol !== ticker) return false;
    state.quoteData = q; renderQuote(); renderChain(); fetchChart(ticker);
    document.getElementById('lastUpdated').textContent = 'Updated ' + inZone(Date.now());
    return true;
  } catch(e) { return false; }
}

/**
 * A stock's quote from Tradier, or an error when it isn't one; its symbol goes into markup unescaped, so only a
 * well-formed one is kept.
 * @param {string} ticker @param {boolean} [greeks]
 */
export async function tradierQuote(ticker, greeks = true) {
  const qRes = await fetch(`${baseUrl()}/markets/quotes?symbols=${encodeURIComponent(ticker)}${greeks ? '&greeks=true' : ''}`, { headers: headers() });
  const q = (await qRes.json())?.quotes?.quote;
  if (!q || Array.isArray(q) || q.type === 'option') throw new Error('Symbol not found or invalid.');
  if (!isSymbol(q.symbol)) q.symbol = ticker;
  return q;
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
  el.textContent = !isShorthand(v) ? TICKER_HINT : parsed ? 'Pin ' + parsed.display : quickParseHint(v) || 'Keep typing: ticker, strike, and expiry';
  el.className = 'ticker-hint' + (!isShorthand(v) ? '' : parsed ? ' ok' : ' wait');
}
