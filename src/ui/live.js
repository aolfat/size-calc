// Live mode: the price streams from Tradier's socket (polled when the stream is down, and for a futures ticker from Schwab);
// the chain, chart and cards poll. Phones and tablets start it on every Load and keep it on; desktop climbs a duration
// ladder. Pauses while the app is backgrounded.
import { state } from '../state.js';
import { isFuturesQuote } from '../core/futures.js';
import { applyStreamEvent, parseStreamData, STREAM_URL, subscribeMessage } from '../core/stream.js';
import { DESKTOP_MQ, mq } from '../lib/media.js';
import { store } from '../lib/store.js';
import { inZone } from '../lib/zone.js';
import { baseUrl, headers, streamSession } from '../services/tradier.js';
import { refreshAllPinned } from './cards.js';
import { fetchChain } from './chain.js';
import { fetchChart } from './chart.js';
import { effects } from './effects.js';
import { fetchFuturesQuote } from './futures.js';
import { clearError, showError } from './feedback.js';
import { renderQuote } from './shares.js';
import { syncSbLive } from './sticky-bar.js';

// each tap climbs a rung; longer sessions poll slower to stay well inside API limits

export const LIVE_MODES = [
  { dur: 60e3, tick: 5e3, label: '1m' },
  { dur: 300e3, tick: 10e3, label: '5m' },
  { dur: 1800e3, tick: 20e3, label: '30m' }
];

/** always-on Live ticks each second: the quote every 2nd while the stream is down (and for futures), the chain every 5th, chart and cards every 20th */
const ALWAYS_TICK = 1e3;
/** stream events redraw the quote at most this often */
const STREAM_RENDER_MS = 250;
/** after a socket fails, the next try waits this long (it polls meanwhile) */
const STREAM_RETRY_MS = 15e3;

/** Live by default: on phones and tablets (below the desktop shell) unless Settings turned it off */
export function liveByDefault() {
  return !!window.matchMedia && !mq(DESKTOP_MQ) && store.get('live_mobile') !== '0';
}

/** Settings' Live switch: 'on' starts Live on every Load on phones and tablets, 'off' leaves it to a tap (this device only) @param {string} v */
export function setLiveDefault(v) {
  store.set('live_mobile', v === 'off' ? '0' : '1');
  paintLiveDefault();
}

export function paintLiveDefault() {
  const on = store.get('live_mobile') !== '0';
  for (const [id, lit] of [['liveDefaultOn', on], ['liveDefaultOff', !on]]) {
    const b = document.getElementById(id);
    b.classList.toggle('active', lit);
    b.setAttribute('aria-pressed', String(lit));
  }
}

export function startLiveTimers() {
  clearInterval(state.liveInterval); clearInterval(state.liveCountdown);
  if (state.liveAlways) {
    state.liveInterval = setInterval(alwaysTick, ALWAYS_TICK);
    state.liveCountdown = null;
    return;
  }
  state.liveInterval = setInterval(livePoll, LIVE_MODES[state.liveModeIdx].tick);
  state.liveCountdown = setInterval(updateLiveBtn, 1000);
}

function paintLive(className, html) {
  const b = document.getElementById('liveBtn');
  b.className = className;
  b.innerHTML = html;
  syncSbLive();
}

/** start Live with no countdown: the stream for the price, the rest polled; runs until stopped or the app closes */
export function startAlwaysLive() {
  if (!state.quoteData) return;
  stopLive();
  state.liveAlways = true;
  state.liveOptOut = '';
  state.liveEnd = Infinity;
  state.liveTicks = 0;
  alwaysTick();
  startLiveTimers();
  updateLiveBtn();
}

/** after a Load: Live starts by itself on phones and tablets, unless it's running or you stopped it for this symbol */
export function autoLive() {
  const sym = state.quoteData?.symbol;
  if (!sym || state.liveInterval || state.livePausedRemaining > 0 || state.marketView || !liveByDefault()) return;
  if (state.liveOptOut === sym) return;
  startAlwaysLive();
}

export function toggleLive() {
  if (state.liveAlways && (state.liveInterval || state.livePausedRemaining > 0)) {
    // always-on: a tap stops it, and a Load of the same symbol leaves it off
    state.liveOptOut = state.quoteData?.symbol || '';
    stopLive();
    return;
  }
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
  if (liveByDefault()) { startAlwaysLive(); return; }
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
  state.liveAlways = false;
  stopStream();
  paintLive('btn', '⚡ Live');
}

export function pauseLive() { // backgrounded: keep the session, stop the polling and the stream
  if (!state.liveInterval) return;
  state.livePausedRemaining = Math.max(0, state.liveEnd - Date.now());
  clearInterval(state.liveInterval); clearInterval(state.liveCountdown);
  state.liveInterval = null; state.liveCountdown = null;
  stopStream();
  if (!(state.livePausedRemaining > 0)) { stopLive(); return; }
  paintLive('btn live-on', `<span class="pulse"></span> Live paused`);
}

export function resumeLive() {
  if (!(state.livePausedRemaining > 0) || state.liveInterval || state.marketView) return;
  state.liveEnd = Date.now() + state.livePausedRemaining;
  state.livePausedRemaining = 0;
  state.liveStreamRetry = 0; // back in the app: try the stream again at once
  if (state.liveAlways) alwaysTick(); else livePoll();
  startLiveTimers();
  updateLiveBtn();
}

export function updateLiveBtn() {
  if (state.liveAlways) {
    paintLive('btn live-on', `<span class="pulse"></span> Live · tap: stop`);
    return;
  }
  const remain = Math.max(0, Math.ceil((state.liveEnd - Date.now()) / 1000));
  if (remain <= 0) { stopLive(); return; }
  const mmss = remain >= 60 ? `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, '0')}` : `${remain}s`;
  const next = state.liveModeIdx + 1 < LIVE_MODES.length ? `tap: ${LIVE_MODES[state.liveModeIdx + 1].label}` : 'tap: stop';
  paintLive('btn live-on', `<span class="pulse"></span> Live ${mmss} · ${next}`);
}

function stampUpdated() {
  document.getElementById('lastUpdated').textContent = (state.liveStreamOk ? 'Live · streaming · ' : 'Live · updated ') + inZone(Date.now());
}

/** typing a share count: a redraw would wipe it, so the quote waits */
function editingAnswer() {
  const a = /** @type {any} */ (document.activeElement);
  return !!a && a.tagName === 'INPUT' && !!a.closest?.('#sharesStats');
}

/** the quote from Tradier (or Schwab for futures), unless a Load or a stream event got there first */
async function pollQuote() {
  const ticker = state.quoteData?.symbol;
  if (state.livePolling || !ticker) return;
  state.livePolling = true;
  try {
    const futures = isFuturesQuote(state.quoteData);
    const q = futures ? await fetchFuturesQuote(ticker)
      : (await (await fetch(`${baseUrl()}/markets/quotes?symbols=${encodeURIComponent(ticker)}`, { headers: headers() })).json())?.quotes?.quote;
    if (ticker !== state.quoteData?.symbol) return; // a Load landed meanwhile
    if (!futures && state.liveStreamOk) return; // the stream is fresher
    if (q && q.symbol === ticker) { state.quoteData = q; if (!editingAnswer()) renderQuote(); }
  } catch(e) {} finally {
    state.livePolling = false;
  }
}

/** one always-on tick: keep the stream on the loaded symbol, and poll what it doesn't carry */
export async function alwaysTick() {
  const q = state.quoteData;
  if (!q) return;
  const n = state.liveTicks++;
  const sym = q.symbol;
  const futures = isFuturesQuote(q);
  if (!futures) ensureStream(); else stopStream();
  if (n % 2 === 0 && (futures || !state.liveStreamOk)) pollQuote();
  if (n % 20 === 0) fetchChart(sym);
  if (!futures && n % 20 === 10) refreshAllPinned();
  stampUpdated();
  if (!futures && n % 5 === 0 && state.currentMode === 'options' && state.selectedExp && !state.liveChainBusy) {
    state.liveChainBusy = true;
    try { await fetchChain(sym, state.selectedExp); } catch(e) {} finally { state.liveChainBusy = false; }
  }
}

export async function livePoll() {
  // the loaded symbol, never the field: it doubles as the search box and may hold half a new ticker
  const ticker = state.quoteData?.symbol;
  if (state.livePolling || !ticker) return;
  const futures = isFuturesQuote(state.quoteData);
  if (!futures && state.liveInterval) ensureStream();
  if (futures || !state.liveStreamOk) {
    await pollQuote();
    if (ticker !== state.quoteData?.symbol) return;
  }
  try {
    if (futures) { // no chain or cards: the quote each tick, the chart every 4th
      if (state.liveTicks % 4 === 0) fetchChart(ticker);
      state.liveTicks++;
      stampUpdated();
      return;
    }
    if (state.currentMode === 'options' && state.selectedExp) {
      await fetchChain(ticker, state.selectedExp);
    }
    // heavier refreshes spread across ticks: chart ~20s, cards ~20s offset
    if (state.liveTicks % 4 === 0) fetchChart(ticker);
    if (state.liveTicks % 4 === 2) refreshAllPinned();
    state.liveTicks++;
    stampUpdated();
  } catch(e) {}
}

// ---------- the stream ----------

/** the socket watches the loaded stock: opened when missing (production keys only), told the new symbol after a Load */
export function ensureStream() {
  const sym = state.quoteData?.symbol;
  if (!sym || isFuturesQuote(state.quoteData)) return;
  if (document.getElementById('apiEnv').value === 'sandbox' || !document.getElementById('apiKey').value.trim()) return;
  const ws = state.liveSocket;
  if (ws) {
    if (ws.readyState === 1 && ws.sessionid && state.liveStreamSymbol !== sym) {
      state.liveStreamSymbol = sym;
      state.liveStreamOk = false; // polls until the new symbol's first event
      try { ws.send(subscribeMessage([sym], ws.sessionid)); } catch(e) { dropStream(ws); }
    }
    return;
  }
  if (Date.now() < state.liveStreamRetry) return;
  openStream(sym);
}

async function openStream(sym) {
  /** @type {any} */
  const pending = { readyState: 0, close() { this.closed = true; } }; // holds the place while the session is asked for
  state.liveSocket = pending;
  let sessionid;
  try { sessionid = await streamSession(); } catch(e) {
    if (state.liveSocket === pending) failStream();
    return;
  }
  if (state.liveSocket !== pending || pending.closed) return; // stopped or paused meanwhile
  let ws;
  try { ws = effects.openSocket(STREAM_URL); } catch(e) { failStream(); return; }
  ws.sessionid = sessionid;
  state.liveSocket = ws;
  ws.onopen = () => {
    if (state.liveSocket !== ws) return;
    const now = state.quoteData?.symbol || sym;
    state.liveStreamSymbol = now;
    ws.send(subscribeMessage([now], sessionid));
  };
  ws.onmessage = e => { if (state.liveSocket === ws) streamEvents(e.data); };
  ws.onerror = () => { if (state.liveSocket === ws) failStream(); };
  ws.onclose = () => { if (state.liveSocket === ws) failStream(); };
}

/** events in: folded into the quote, drawn at most every STREAM_RENDER_MS */
export function streamEvents(data) {
  let q = state.quoteData;
  if (!q) return;
  for (const ev of parseStreamData(data)) {
    if (ev.symbol !== state.liveStreamSymbol) continue;
    q = applyStreamEvent(q, ev);
  }
  if (q === state.quoteData) return;
  state.quoteData = q;
  state.liveStreamOk = true;
  scheduleStreamRender();
}

function scheduleStreamRender() {
  if (state.liveRenderTimer) return;
  const wait = state.liveRenderAt + STREAM_RENDER_MS - Date.now();
  if (wait <= 0 && !editingAnswer()) { streamRender(); return; }
  state.liveRenderTimer = setTimeout(() => { state.liveRenderTimer = null; if (editingAnswer()) scheduleStreamRender(); else streamRender(); }, Math.max(wait, STREAM_RENDER_MS));
}

function streamRender() {
  state.liveRenderAt = Date.now();
  if (!state.quoteData || !state.liveInterval) return;
  renderQuote();
  stampUpdated();
}

/** the socket broke or never came up: poll, and try again later */
function failStream() {
  dropStream(state.liveSocket);
  state.liveStreamRetry = Date.now() + STREAM_RETRY_MS;
}

function dropStream(ws) {
  if (state.liveSocket === ws) { state.liveSocket = null; state.liveStreamSymbol = ''; state.liveStreamOk = false; }
  try { ws?.close(); } catch(e) {}
}

export function stopStream() {
  clearTimeout(state.liveRenderTimer);
  state.liveRenderTimer = null;
  dropStream(state.liveSocket);
}
