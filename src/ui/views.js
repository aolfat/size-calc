// Top-level views (Market, Size, Positions, Tools) and the Shares / Options / Futures switch.
import { state } from '../state.js';
import { baseUrl, headers } from '../services/tradier.js';
import { fetchChain, markActiveExp, renderExpTabs } from './chain.js';
import { drawChart } from './chart.js';
import { drawDailyChart, renderAdr, updateChartVisibility } from './daily.js';
import { renderFutures } from './futures.js';
import { pauseLive, resumeLive, stopLive } from './live.js';
import { loadMarket, marketScheduleRefresh } from './market.js';
import { refreshPositions, stopPositions } from './positions.js';
import { recalcAll } from './risk.js';
import { updateSetupNotice } from './settings.js';
import { setQuoteVisible, updateModeSections } from './shares.js';
import { cancelSpread } from './spreads.js';
import { updateStickyBar } from './sticky-bar.js';
import { updateStopVisibility } from './stops.js';
import { renderGain } from './tools.js';

export function setView(v) {
  state.positionsView = v === 'positions';
  state.utilsView = v === 'utils';
  state.marketView = v === 'market';
  const calc = !state.positionsView && !state.utilsView && !state.marketView;
  const futures = calc && state.currentMode === 'futures';
  const app = document.getElementById('app');
  app.classList.toggle('futures-view', futures);
  app.classList.toggle('calc-view', calc && !futures);
  app.classList.toggle('positions-view', state.positionsView);
  app.classList.toggle('utils-view', state.utilsView);
  document.getElementById('modeShares').classList.toggle('active', calc && state.currentMode === 'shares');
  document.getElementById('modeOptions').classList.toggle('active', calc && state.currentMode === 'options');
  document.getElementById('modeFutures').classList.toggle('active', futures);
  [['brandSize', calc], ['brandPositions', state.positionsView], ['brandTools', state.utilsView], ['brandMarket', state.marketView]].forEach(([id, active]) => {
    const button = document.getElementById(id);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  document.getElementById('viewTitle').textContent = state.marketView ? 'Market' : state.positionsView ? 'Positions' : state.utilsView ? 'Tools' : 'Size';
  document.querySelector('.app').classList.toggle('market-view', state.marketView);
  document.getElementById('lastUpdated').style.display = state.marketView || state.utilsView || futures ? 'none' : '';
  document.getElementById('modeCard').style.display = calc ? '' : 'none';
  document.getElementById('riskStrip').style.display = calc ? '' : 'none';
  updateSetupNotice();
  const hide = calc && !futures ? '' : 'none';
  document.getElementById('futuresControls').style.display = futures ? '' : 'none';
  document.getElementById('futuresSection').style.display = futures ? '' : 'none';
  if (futures) renderFutures();
  document.getElementById('sizingControls').style.display = hide;
  document.getElementById('quickCard').style.display = hide;
  document.getElementById('pinnedBar').style.display = hide;
  document.getElementById('pinnedSection').style.display = hide;
  setQuoteVisible(calc && !futures && !!state.quoteData);
  updateChartVisibility();
  // the window may have resized while the charts were hidden: repaint at the current size on the way back
  if (calc && !futures && document.getElementById('chartWrap').clientWidth > 0) { if (state.chartBars.length) drawChart(); else if (state.dailyBars.length) drawDailyChart(); }
  document.getElementById('positionsSection').style.display = state.positionsView ? '' : 'none';
  document.getElementById('posChartSection').style.display = state.positionsView && state.posChart ? '' : 'none';
  document.getElementById('utilsSection').style.display = state.utilsView ? '' : 'none';
  document.getElementById('marketSection').style.display = state.marketView ? '' : 'none';
  marketScheduleRefresh();
  if (state.marketView) { pauseLive(); loadMarket(); }
  else if (calc && !document.hidden) resumeLive();
  if (state.utilsView) renderGain(); // no auto-focus: it swallowed the next t/u keypress, wedging the toggle
  if (state.positionsView) refreshPositions(); else stopPositions();
  updateStickyBar();
}

export async function setMode(mode) {
  cancelSpread();
  state.currentMode = mode;
  if (mode !== 'options') state.optionTradeSide = 'buy';
  if (mode === 'futures') { state.sizingMode = 'risk'; state.optionTradeSide = 'buy'; }
  if (mode === 'futures') stopLive();
  setView('calc');
  document.getElementById('fetchBtnText').innerHTML = mode === 'shares' ? 'Load<span class="btn-word"> quote</span>' : 'Load<span class="btn-word"> chain</span>';
  updateStopVisibility();
  renderAdr();
  recalcAll();
  updateModeSections();
  if (state.chartBars.length) drawChart();
  // switching to options with a quote loaded but no chain yet — load it
  if (mode === 'options' && state.quoteData && state.chainData.length === 0) {
    const ticker = state.quoteData.symbol; // the loaded symbol, not whatever the field holds now
    if (ticker && document.getElementById('apiKey').value.trim()) {
      try {
        const expRes = await fetch(`${baseUrl()}/markets/options/expirations?symbol=${encodeURIComponent(ticker)}&includeAllRoots=true`, { headers: headers() });
        const expJson = await expRes.json();
        if (ticker !== state.quoteData?.symbol || state.currentMode !== 'options') return;
        const exps = expJson?.expirations?.date;
        if (exps) {
          const expList = Array.isArray(exps) ? exps : [exps];
          renderExpTabs(expList);
          state.selectedExp = expList[0];
          markActiveExp(state.selectedExp);
          await fetchChain(ticker, state.selectedExp, true);
        }
      } catch(e) {}
    }
  }
}
