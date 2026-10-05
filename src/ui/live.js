// Live mode: polls quote, chain, chart and cards on a duration ladder; pauses while the app is backgrounded.
import { state } from '../state.js';
import { baseUrl, headers } from '../services/tradier.js';
import { refreshAllPinned } from './cards.js';
import { fetchChain } from './chain.js';
import { fetchChart } from './chart.js';
import { clearError, showError } from './feedback.js';
import { refreshAllSaved } from './positions.js';
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

export function toggleLive() {
  if (state.currentMode === 'futures') return;
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
  if (!state.quoteData) { showError('Load a ticker first, then go live.'); return; }
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
  const b = document.getElementById('liveBtn');
  b.className = 'btn';
  b.innerHTML = '⚡ Live';
  syncSbLive();
}

export function pauseLive() { // backgrounded: keep the session, stop the polling
  if (!state.liveInterval) return;
  state.livePausedRemaining = Math.max(0, state.liveEnd - Date.now());
  clearInterval(state.liveInterval); clearInterval(state.liveCountdown);
  state.liveInterval = null; state.liveCountdown = null;
  if (!(state.livePausedRemaining > 0)) { stopLive(); return; }
  const b = document.getElementById('liveBtn');
  b.className = 'btn live-on';
  b.innerHTML = `<span class="pulse"></span> Live paused`;
  syncSbLive();
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
  const b = document.getElementById('liveBtn');
  b.className = 'btn live-on';
  const mmss = remain >= 60 ? `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, '0')}` : `${remain}s`;
  const next = state.liveModeIdx + 1 < LIVE_MODES.length ? `tap: ${LIVE_MODES[state.liveModeIdx + 1].label}` : 'tap: stop';
  b.innerHTML = `<span class="pulse"></span> Live ${mmss} · ${next}`;
  syncSbLive();
}

export async function livePoll() {
  if (state.livePolling || state.currentMode === 'futures') return;
  state.livePolling = true;
  const ticker = document.getElementById('ticker').value.trim().toUpperCase();
  try {
    const qRes = await fetch(`${baseUrl()}/markets/quotes?symbols=${ticker}`, { headers: headers() });
    const qJson = await qRes.json();
    if (ticker !== document.getElementById('ticker').value.trim().toUpperCase()) return;
    const q = qJson?.quotes?.quote;
    if (q) { state.quoteData = q; renderQuote(); }
    if (state.currentMode === 'options' && state.selectedExp) {
      await fetchChain(ticker, state.selectedExp);
    }
    // heavier refreshes spread across ticks: chart ~20s, cards ~20s offset
    if (state.liveTicks % 4 === 0) fetchChart(ticker);
    if (state.liveTicks % 4 === 2) {
      refreshAllPinned();
      if (state.positionsView) refreshAllSaved();
    }
    state.liveTicks++;
    document.getElementById('lastUpdated').textContent = 'Live · updated ' + new Date().toLocaleTimeString();
  } catch(e) {} finally {
    state.livePolling = false;
  }
}
