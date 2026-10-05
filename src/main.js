import './legacy-globals.js';
import { state } from './state.js';
import { store } from './lib/store.js';
import { syncPull } from './services/sync.js';
import { updateSizingControls } from './ui/allocation.js';
import { updateChainControls } from './ui/chain.js';
import { initChartEvents, updateIntervalChips } from './ui/chart.js';
import { initDailyChartEvents } from './ui/daily.js';
import { initFutures } from './ui/futures.js';
import { pauseLive, resumeLive } from './ui/live.js';
import { initMarketEvents, marketScheduleRefresh } from './ui/market.js';
import { loadSaved } from './ui/positions.js';
import { applyQuickOpen } from './ui/quick-lookup.js';
import { renderUsdPresets, syncRiskDollar, updateRiskStatus } from './ui/risk.js';
import { initSync, loadKey, updateApiStatus } from './ui/settings.js';
import { initShortcuts } from './ui/shortcuts.js';
import { initSimEvents } from './ui/sim.js';
import { updateStickyBar } from './ui/sticky-bar.js';
import { updateStopVisibility } from './ui/stops.js';
import { fetchQuote, renderRecentTickers } from './ui/ticker.js';
import { setView } from './ui/views.js';

state.syncSuppress = true; // init reads back what storage already holds — nothing here is a fresh edit

loadKey();

syncRiskDollar();

initFutures();

updateSizingControls();

state.syncSuppress = false;

initChartEvents();

initDailyChartEvents();

initShortcuts();

initSimEvents();

initMarketEvents();

updateApiStatus();

renderUsdPresets();

state.showDaily = store.get('show_daily') !== '0';

if (store.get('both_strikes')) document.getElementById('bothStrikes').value = store.get('both_strikes');

updateChainControls();

updateRiskStatus();

applyQuickOpen();

updateStopVisibility();

loadSaved();

setView(location.hash === '#market' ? 'market' : 'calc'); // direct link to Market; sizing remains the default

updateIntervalChips();

window.addEventListener('scroll', () => requestAnimationFrame(updateStickyBar), { passive: true });

// backgrounding the app ends a live session instead of polling blind; foregrounding pulls fresh sync data

document.addEventListener('visibilitychange', () => {
  marketScheduleRefresh();
  if (document.hidden) { pauseLive(); } else { resumeLive(); syncPull(); }
});

window.addEventListener('online', marketScheduleRefresh);

window.addEventListener('offline', marketScheduleRefresh);

renderRecentTickers();

initSync();

// scrolling over a focused number input should scroll the page, not spin the value

document.addEventListener('wheel', () => {
  const el = document.activeElement;
  if (el && el.tagName === 'INPUT' && el.type === 'number') el.blur();
}, { passive: true });

// network-first service worker keeps the iOS home-screen app fresh

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js');
}

// ask the browser to protect this origin's storage from eviction (key + saved positions live here)

try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch(e) {}

// pick up where you left off: auto-load the last ticker if a key is saved

if (!state.marketView && document.getElementById('apiKey').value.trim() && document.getElementById('ticker').value.trim()) fetchQuote();
