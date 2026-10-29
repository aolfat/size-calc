// Top-level views (Market, Size, Positions, Journal, Tools) and the Stocks & futures / Options switch.
import { state } from '../state.js';
import { store } from '../lib/store.js';
import { baseUrl, headers } from '../services/tradier.js';
import { fetchChain, markActiveExp, renderExpTabs } from './chain.js';
import { drawChart } from './chart.js';
import { drawDailyChart, renderAdr, updateChartVisibility } from './daily.js';
import { showError } from './feedback.js';
import { isFuturesQuote } from '../core/futures.js';
import { cleanExpirations } from '../core/options.js';
import { pauseLive, resumeLive } from './live.js';
import { openJournal } from './journal.js';
import { closeModelImage } from './model-books.js';
import { loadMarket, marketScheduleRefresh } from './market.js';
import { refreshPositions, stopPositions } from './positions.js';
import { recalcAll } from './risk.js';
import { updateSetupNotice } from './settings.js';
import { setQuoteVisible, updateModeSections } from './shares.js';
import { cancelSpread } from './spreads.js';
import { updateStickyBar } from './sticky-bar.js';
import { updateStopVisibility } from './stops.js';
import { renderGain } from './tools.js';

// the open tab rides in the address, so a reload opens it again (Size has none)
const VIEW_HASH = { market: '#market', positions: '#positions', journal: '#journal', utils: '#tools' };
export const viewFromHash = hash => Object.keys(VIEW_HASH).find(v => VIEW_HASH[v] === hash) || 'calc';
// boot: the address's tab, else the one open last on this device (the home-screen app always starts at the bare address)
export function startView(hash) {
  const last = store.get('last_view');
  return hash && VIEW_HASH[viewFromHash(hash)] === hash ? viewFromHash(hash) : VIEW_HASH[last] ? last : 'calc';
}

function rememberView(v) {
  store.set('last_view', VIEW_HASH[v] ? v : 'calc');
  const loc = globalThis.location;
  const want = VIEW_HASH[v] || '';
  if (!loc || !globalThis.history?.replaceState || loc.hash === want) return;
  globalThis.history.replaceState(null, '', loc.pathname + loc.search + want); // no new history entry per tab switch
}

export function setView(v) {
  if (v !== 'journal' && state.modelBooks.viewerId) closeModelImage();
  rememberView(v);
  state.positionsView = v === 'positions';
  state.utilsView = v === 'utils';
  state.marketView = v === 'market';
  state.journalView = v === 'journal';
  const calc = !state.positionsView && !state.utilsView && !state.marketView && !state.journalView;
  const app = document.getElementById('app');
  app.classList.toggle('calc-view', calc);
  app.classList.toggle('positions-view', state.positionsView);
  app.classList.toggle('utils-view', state.utilsView);
  app.classList.toggle('journal-view', state.journalView);
  document.getElementById('modeShares').classList.toggle('active', calc && state.currentMode === 'shares');
  document.getElementById('modeOptions').classList.toggle('active', calc && state.currentMode === 'options');
  [['brandSize', calc], ['brandPositions', state.positionsView], ['brandJournal', state.journalView], ['brandTools', state.utilsView], ['brandMarket', state.marketView]].forEach(([id, active]) => {
    const button = document.getElementById(id);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  document.getElementById('viewTitle').textContent = state.marketView ? 'Market' : state.positionsView ? 'Positions' : state.journalView ? 'Journal' : state.utilsView ? 'Tools' : 'Size';
  document.querySelector('.app').classList.toggle('market-view', state.marketView);
  document.getElementById('lastUpdated').style.display = state.marketView || state.utilsView || state.journalView ? 'none' : '';
  document.getElementById('modeCard').style.display = calc ? '' : 'none';
  document.getElementById('riskStrip').style.display = calc ? '' : 'none';
  updateSetupNotice();
  const hide = calc ? '' : 'none';
  document.getElementById('sizingControls').style.display = hide;
  document.getElementById('quickCard').style.display = hide;
  document.getElementById('pinnedBar').style.display = hide;
  document.getElementById('pinnedSection').style.display = hide;
  setQuoteVisible(calc && !!state.quoteData);
  updateChartVisibility();
  // the window may have resized while the charts were hidden: repaint at the current size on the way back
  if (calc && document.getElementById('chartWrap').clientWidth > 0) { if (state.chartBars.length) drawChart(); else if (state.dailyBars.length) drawDailyChart(); }
  document.getElementById('positionsSection').style.display = state.positionsView ? '' : 'none';
  document.getElementById('posChartSection').style.display = state.positionsView && state.posChart ? '' : 'none';
  document.getElementById('utilsSection').style.display = state.utilsView ? '' : 'none';
  document.getElementById('journalSection').style.display = state.journalView && !state.journalTrade ? '' : 'none';
  document.getElementById('journalTradeSection').style.display = state.journalView && state.journalTrade ? '' : 'none';
  document.getElementById('marketSection').style.display = state.marketView ? '' : 'none';
  marketScheduleRefresh();
  if (state.marketView) { pauseLive(); loadMarket(); }
  else if (calc && !document.hidden) resumeLive();
  if (state.utilsView) renderGain(); // no auto-focus: it swallowed the next t/u keypress, wedging the toggle
  if (state.positionsView) refreshPositions(); else stopPositions();
  if (state.journalView) openJournal();
  updateStickyBar();
}

export async function setMode(mode) {
  cancelSpread();
  state.currentMode = mode;
  if (mode !== 'options') state.optionTradeSide = 'buy';
  setView('calc');
  document.getElementById('fetchBtnText').innerHTML = mode === 'shares' ? 'Load<span class="btn-word"> quote</span>' : 'Load<span class="btn-word"> chain</span>';
  updateStopVisibility();
  renderAdr();
  recalcAll();
  updateModeSections();
  if (state.chartBars.length) drawChart();
  // switching to options with a quote loaded but no chain yet — load it
  if (mode === 'options' && isFuturesQuote(state.quoteData)) { showError('No option chains for futures here. Load a stock for options.'); return; }
  if (mode === 'options' && state.quoteData && state.chainData.length === 0) {
    const ticker = state.quoteData.symbol; // the loaded symbol, not whatever the field holds now
    if (ticker && document.getElementById('apiKey').value.trim()) {
      try {
        const expRes = await fetch(`${baseUrl()}/markets/options/expirations?symbol=${encodeURIComponent(ticker)}&includeAllRoots=true`, { headers: headers() });
        const expJson = await expRes.json();
        if (ticker !== state.quoteData?.symbol || state.currentMode !== 'options') return;
        const expList = cleanExpirations(expJson?.expirations?.date);
        if (expList.length) {
          renderExpTabs(expList);
          state.selectedExp = expList[0];
          markActiveExp(state.selectedExp);
          await fetchChain(ticker, state.selectedExp, true);
        }
      } catch(e) {}
    }
  }
}
