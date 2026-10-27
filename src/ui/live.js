// Live mode: polls quote, chain, chart and cards (in Futures, the Schwab futures quote) on a duration ladder; pauses while the app is backgrounded.
import { state } from '../state.js';
import { inZone } from '../lib/zone.js';
import { baseUrl, headers } from '../services/tradier.js';
import { refreshAllPinned } from './cards.js';
import { fetchChain } from './chain.js';
import { fetchChart } from './chart.js';
import { futuresLiveError, refreshFuturesQuote } from './futures.js';
import { clearError, showError } from './feedback.js';
import { renderQuote } from './shares.js';
import { syncSbLive } from './sticky-bar.js';

// each tap climbs a rung; longer sessions poll slower to stay well inside API limits

export const LIVE_MODES = [
  { dur: 60e3, tick: 5e3, label: '1m' },
  { dur: 300e3, tick: 10e3, label: '5m' },
  { dur: 1800e3, tick: 20e3, label: '30m' }
];

export function startLiveTimers() {
  clearInterval(state.liveInterval); clearInterval(state.liveCountdown);
  state.liveInterval = setInterval(livePoll, LIVE_MODES[state.liveModeIdx].tick);
  state.liveCountdown = setInterval(updateLiveBtn, 1000);
}

/** both Live buttons (the ticker row's and the futures ticket's) show the one live session */
function paintLive(className, html) {
  for (const id of ['liveBtn', 'futuresLiveBtn']) {
    const b = document.getElementById(id);
    b.className = className;
    b.innerHTML = html;
  }
  syncSbLive();
}

export function toggleLive() {
  if (state.liveInterval || state.livePausedRemaining > 0) {
    // running (or paused): climb to the next rung, or stop past the last one
    if (state.liveModeIdx + 1 >= LIVE_MODES.length) { stopLive(); return; }
    state.liveModeIdx++;
    state.livePausedRemaining = 0;
    state.liveEnd = Date.now() + LIVE_MODES[state.liveModeIdx].dur;
    startLiveTimers();
    updateLiveBtn();
    return;
  }
  const futures = state.currentMode === 'futures';
  const notReady = futures ? futuresLiveError() : state.quoteData ? '' : 'Load a ticker first, then go live.';
  if (notReady) { showError(notReady); return; }
  clearError();
  state.liveModeIdx = 0;
  state.liveEnd = Date.now() + LIVE_MODES[0].dur;
  state.liveTicks = 0;
  livePoll();
  startLiveTimers();
  updateLiveBtn();
}

export function stopLive() {
  clearInterval(state.liveInterval); clearInterval(state.liveCountdown);
  state.liveInterval = null; state.liveCountdown = null;
  state.livePausedRemaining = 0;
  paintLive('btn', '⚡ Live');
}

export function pauseLive() { // backgrounded: keep the session, stop the polling
  if (!state.liveInterval) return;
  state.livePausedRemaining = Math.max(0, state.liveEnd - Date.now());
  clearInterval(state.liveInterval); clearInterval(state.liveCountdown);
  state.liveInterval = null; state.liveCountdown = null;
  if (!(state.livePausedRemaining > 0)) { stopLive(); return; }
  paintLive('btn live-on', `<span class="pulse"></span> Live paused`);
}

export function resumeLive() {
  if (!(state.livePausedRemaining > 0) || state.liveInterval || state.marketView) return;
  state.liveEnd = Date.now() + state.livePausedRemaining;
  state.livePausedRemaining = 0;
  livePoll();
  startLiveTimers();
  updateLiveBtn();
}

export function updateLiveBtn() {
  const remain = Math.max(0, Math.ceil((state.liveEnd - Date.now()) / 1000));
  if (remain <= 0) { stopLive(); return; }
  const mmss = remain >= 60 ? `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, '0')}` : `${remain}s`;
  const next = state.liveModeIdx + 1 < LIVE_MODES.length ? `tap: ${LIVE_MODES[state.liveModeIdx + 1].label}` : 'tap: stop';
  paintLive('btn live-on', `<span class="pulse"></span> Live ${mmss} · ${next}`);
}

export async function livePoll() {
  if (state.currentMode === 'futures') { await liveFuturesPoll(); return; }
  // the loaded symbol, never the field: it doubles as the search box and may hold half a new ticker
  const ticker = state.quoteData?.symbol;
  if (state.livePolling || state.currentMode === 'futures' || !ticker) return;
  state.livePolling = true;
  try {
    const qRes = await fetch(`${baseUrl()}/markets/quotes?symbols=${encodeURIComponent(ticker)}`, { headers: headers() });
    const qJson = await qRes.json();
    if (ticker !== state.quoteData?.symbol) return; // a Load landed meanwhile
    const q = qJson?.quotes?.quote;
    if (q && q.symbol === ticker) { state.quoteData = q; renderQuote(); }
    if (state.currentMode === 'options' && state.selectedExp) {
      await fetchChain(ticker, state.selectedExp);
    }
    // heavier refreshes spread across ticks: chart ~20s, cards ~20s offset
    if (state.liveTicks % 4 === 0) fetchChart(ticker);
    if (state.liveTicks % 4 === 2) refreshAllPinned();
    state.liveTicks++;
    document.getElementById('lastUpdated').textContent = 'Live · updated ' + inZone(Date.now());
  } catch(e) {} finally {
    state.livePolling = false;
  }
}

/** a futures tick: the picked contract's Schwab quote; a custom contract or a lost login ends the session */
async function liveFuturesPoll() {
  if (state.livePolling) return;
  if (futuresLiveError()) { stopLive(); return; }
  state.livePolling = true;
  try { await refreshFuturesQuote(); } finally { state.livePolling = false; }
}
