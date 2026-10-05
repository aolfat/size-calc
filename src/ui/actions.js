// The action registry: every data-action / data-input / data-change / data-enter name in the markup
// and in rendered templates maps to one call here. Adapters turn data-arg strings into arguments.
import { store } from '../lib/store.js';
import { syncEnabled } from '../services/sync.js';
import { state } from '../state.js';
import { allocationChanged, allocationQtyChanged, pinAllocation, setAllocationPct, setOptionTradeSide, setSizingMode } from './allocation.js';
import { pinnedStopChanged, refreshAllPinned, refreshPinned, removePinned } from './cards.js';
import { renderChain, selectExp, setSide, setZoneMode, toggleExps } from './chain.js';
import { setChartInterval } from './chart.js';
import { copyPinned, copySaved, copyShares } from './copy-text.js';
import { dailyToday, setDailyRange, toggleDaily } from './daily.js';
import { closeDetails } from './detail.js';
import { effects } from './effects.js';
import { copyFutures, futuresContractChanged, futuresQtyChanged, futuresSpecsChanged, renderFutures, setFuturesDirection } from './futures.js';
import { toggleLive } from './live.js';
import { marketCancelRefresh, marketClearSearch, marketRefreshToday, marketSearchChanged, marketSetDisplay, marketSetScope, marketShowMore, marketToggleAuto, marketUseSnapshot } from './market.js';
import { refreshAllSaved, refreshSaved, removeSaved, saveCard, savedEntryChanged, savedQtyChanged, savedStopChanged } from './positions.js';
import { fetchQuickOption, parseQuick, toggleQuick } from './quick-lookup.js';
import { recalcAll, setRiskPct, setRiskUsd, syncFromDollar, toggleUsdEdit } from './risk.js';
import { exportBackup, importBackup, saveKey, toggleSync } from './settings.js';
import { sharePinned, shareSaved, shareShares } from './share-image.js';
import { contractsQtyChanged, sharesQtyChanged } from './shares.js';
import { closeSheet, openSheet } from './sheets.js';
import { toggleKbdHelp } from './shortcuts.js';
import { closeSim, drawSim, simFromPinned, simFromSaved, simPriceTyped, simSetPrice } from './sim.js';
import { cancelSpread, startSpread } from './spreads.js';
import { jumpTo } from './sticky-bar.js';
import { setAtrMultiplier, setDirection, setStopPercent, setStopStrategy, stopsChanged } from './stops.js';
import { loadTicker, refreshQuote, submitTicker, tickerInputChanged } from './ticker.js';
import { findLevEtfs, levLoad, levTarget, renderGain, setLevDir } from './tools.js';
import { setMode, setView } from './views.js';

const arg = el => el.dataset.arg || '';
const num = el => Number(el.dataset.arg);

/** @type {Record<string, import('../lib/delegate.js').Handler>} */
export const actions = {
  // ---------- views and navigation ----------
  setView: el => setView(arg(el)),
  setMode: el => setMode(arg(el)),
  scrollToTop: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
  jumpTo: el => jumpTo(arg(el)),
  toggleKbdHelp: () => toggleKbdHelp(),
  openSheet: el => openSheet(arg(el)),
  closeSheet: () => closeSheet(),

  // ---------- settings: key, backup, sync ----------
  saveKey: () => saveKey(),
  exportBackup: () => exportBackup(),
  pickImportFile: () => document.getElementById('importFile').click(),
  importBackup: el => importBackup(el),
  toggleSync: () => toggleSync(),
  syncPassEnter: () => { if (!syncEnabled()) toggleSync(); },

  // ---------- account and risk ----------
  setSizingMode: el => setSizingMode(arg(el)),
  recalcAll: () => recalcAll(),
  syncFromDollar: () => syncFromDollar(),
  setRiskPct: el => setRiskPct(num(el)),
  setRiskUsd: el => setRiskUsd(num(el)),
  toggleUsdEdit: () => toggleUsdEdit(),
  allocationChanged: () => allocationChanged(),
  setAllocationPct: el => setAllocationPct(num(el)),
  setOptionTradeSide: el => setOptionTradeSide(arg(el)),

  // ---------- ticket: ticker, direction, entry and stops ----------
  submitTicker: el => { if (el.tagName === 'INPUT') el.blur(); submitTicker(); },
  tickerInputChanged: () => tickerInputChanged(),
  refreshQuote: () => refreshQuote(),
  toggleLive: () => toggleLive(),
  loadTicker: el => loadTicker(arg(el)),
  setDirection: el => setDirection(arg(el)),
  stopsChanged: () => stopsChanged(),
  setStopStrategy: el => setStopStrategy(/** @type {HTMLSelectElement} */ (el).value),
  setAtrMultiplier: el => setAtrMultiplier(num(el)),
  setStopPercent: el => setStopPercent(num(el)),
  stopPercentTyped: el => setStopPercent(/** @type {HTMLInputElement} */ (el).value, true),

  // ---------- shares answer ----------
  sharesQtyChanged: el => sharesQtyChanged(el),
  shareShares: () => shareShares(),
  copyShares: () => copyShares(),

  // ---------- futures ----------
  futuresContractChanged: () => futuresContractChanged(),
  futuresSpecsChanged: () => futuresSpecsChanged(),
  setFuturesDirection: el => setFuturesDirection(arg(el)),
  renderFutures: () => renderFutures(),
  futuresQtyChanged: el => futuresQtyChanged(el),
  copyFutures: () => copyFutures(),

  // ---------- charts ----------
  setChartInterval: el => setChartInterval(num(el)),
  toggleDaily: () => toggleDaily(),
  setDailyRange: el => setDailyRange(num(el)),
  dailyToday: () => dailyToday(),

  // ---------- option chain and details ----------
  selectExp: el => selectExp(arg(el)),
  toggleExps: () => toggleExps(),
  setSide: el => setSide(arg(el)),
  setZoneMode: el => setZoneMode(arg(el)),
  renderChain: () => renderChain(),
  bothStrikesChanged: el => { store.set('both_strikes', /** @type {HTMLInputElement} */ (el).value); renderChain(); },
  contractsQtyChanged: el => contractsQtyChanged(el, num(el)),
  closeDetails: () => closeDetails(),
  openSimFor: el => effects.openSim(state.simReg[arg(el)]),
  pinAllocation: el => pinAllocation(arg(el)),
  allocationQtyChanged: el => allocationQtyChanged(Math.floor(Number(/** @type {HTMLInputElement} */ (el).value)), num(el), el.dataset.arg2 || ''),
  startSpread: el => startSpread(arg(el), el.dataset.arg2 === 'credit'),
  cancelSpread: () => cancelSpread(),

  // ---------- quick lookup and pinned cards ----------
  toggleQuick: () => toggleQuick(),
  parseQuick: () => parseQuick(),
  fetchQuickOption: () => fetchQuickOption(),
  copyPinned: el => copyPinned(arg(el)),
  sharePinned: el => sharePinned(arg(el)),
  simFromPinned: el => simFromPinned(arg(el)),
  saveCard: el => saveCard(arg(el)),
  refreshPinned: el => refreshPinned(arg(el)),
  removePinned: el => removePinned(arg(el)),
  pinnedStopChanged: el => pinnedStopChanged(arg(el), el),
  refreshAllPinned: () => refreshAllPinned(),

  // ---------- saved positions ----------
  copySaved: el => copySaved(arg(el)),
  shareSaved: el => shareSaved(arg(el)),
  simFromSaved: el => simFromSaved(arg(el)),
  refreshSaved: el => refreshSaved(arg(el)),
  removeSaved: el => removeSaved(arg(el)),
  savedEntryChanged: el => savedEntryChanged(arg(el), el),
  savedQtyChanged: el => savedQtyChanged(arg(el), el),
  savedStopChanged: el => savedStopChanged(arg(el), el),
  refreshAllSaved: () => refreshAllSaved(),

  // ---------- simulator ----------
  closeSim: () => closeSim(),
  closeSimBackdrop: (el, event) => { if (event.target === el) closeSim(); },
  drawSim: () => drawSim(),
  simPriceTyped: el => simPriceTyped(el),
  simSetPrice: el => simSetPrice(Number.isNaN(num(el)) ? arg(el) : num(el)), // 'stop' | 'current' | R multiple

  // ---------- market ----------
  marketToggleAuto: () => marketToggleAuto(),
  marketUseSnapshot: () => marketUseSnapshot(),
  marketRefreshToday: () => marketRefreshToday(),
  marketCancelRefresh: () => marketCancelRefresh(),
  marketSetScope: el => marketSetScope(arg(el)),
  marketSearchChanged: () => marketSearchChanged(),
  marketClearSearch: () => marketClearSearch(),
  marketSetDisplay: el => marketSetDisplay(arg(el)),
  marketShowMore: () => marketShowMore(),

  // ---------- tools ----------
  renderGain: () => renderGain(),
  findLevEtfs: el => { if (el.tagName === 'INPUT') el.blur(); findLevEtfs(); },
  setLevDir: el => setLevDir(arg(el)),
  levLoad: el => levLoad(arg(el)),
  levTarget: el => { if (el.tagName === 'INPUT') el.blur(); levTarget(); },
};
