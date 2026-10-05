// Quick lookup: the shorthand box, its parse preview, and fetch-and-pin.
import { state } from '../state.js';
import { effectivePrice } from '../core/extended-hours.js';
import { parseQuickStr } from '../core/shorthand.js';
import { calculateAtr5 } from '../core/stops.js';
import { mq } from '../lib/media.js';
import { baseUrl, headers } from '../services/tradier.js';
import { recalcPinnedStop, renderPinnedCard, updatePinnedBar } from './cards.js';
import { fetchFiveMinuteBars } from './chart.js';
import { clearError, showError } from './feedback.js';
import { requireKey } from './settings.js';
import { adjustedStop, autoStopName, rawStop, stopLongVal, stopShortVal } from './stops.js';
import { tickerInputChanged } from './ticker.js';

export function applyQuickOpen() {
  document.getElementById('quickBody').style.display = state.quickOpen ? 'block' : 'none';
  document.getElementById('quickToggle').classList.toggle('open', state.quickOpen);
}

export function toggleQuick(force) {
  state.quickOpen = typeof force === 'boolean' ? force : !state.quickOpen;
  applyQuickOpen();
}

export function parseQuick() {
  const val = document.getElementById('quickInput').value;
  const parsed = parseQuickStr(val);
  document.getElementById('quickParsed').textContent = parsed ? parsed.display : (val.trim() ? '?' : '');
}

export async function fetchQuickOption(str, fromSearch = false) {
  const val = typeof str === 'string' ? str : document.getElementById('quickInput').value;
  const parsed = parseQuickStr(val);
  if (!parsed) { showError('Could not parse — try: AAPL 245 6/20  or  SPY 580 put 6/20'); return; }
  const allocationTrade = state.sizingMode === 'allocation' && !parsed.spread;
  const shortPutTrade = allocationTrade && state.optionTradeSide === 'sell-put';
  if (shortPutTrade && parsed.optType !== 'put') { showError('Sell put requires a put contract.'); return; }
  if (!requireKey()) return;
  clearError();

  const busyEl = document.getElementById(fromSearch ? 'fetchBtnText' : 'quickBtnText'); // spin whichever button started it
  const idleLabel = busyEl.innerHTML;
  busyEl.innerHTML = '<span class="spinner"></span>';

  try {
    const optSyms = parsed.spread ? `${parsed.occ},${parsed.occ2}` : parsed.occ;
    const [quoteRes, optRes] = await Promise.all([
      fetch(`${baseUrl()}/markets/quotes?symbols=${parsed.ticker}`, { headers: headers() }),
      fetch(`${baseUrl()}/markets/quotes?symbols=${optSyms}&greeks=true`, { headers: headers() })
    ]);
    const quoteJson = await quoteRes.json();
    const optJson = await optRes.json();

    const uq = quoteJson?.quotes?.quote;
    const oqRaw = optJson?.quotes?.quote;

    if (!uq) throw new Error(`Could not find underlying ${parsed.ticker}`);
    if (!oqRaw) throw new Error(`Option not found: ${parsed.occ} — check strike/expiry`);

    const underlyingPrice = effectivePrice(uq);
    const isCall = parsed.optType === 'call';
    // Risk sizing uses the loaded ticker's stop, or this underlying's own ATR.
    const bull = parsed.credit ? !isCall : isCall; // credit spreads win the other way
    const sameTicker = state.quoteData && state.quoteData.symbol === parsed.ticker;
    const raw = sameTicker ? rawStop(bull ? 'stopLong' : 'stopShort') : 0;
    const usingDefault = raw <= 0;
    const ownAtr = !allocationTrade && !sameTicker && state.stopStrategy === 'atr' ? calculateAtr5(await fetchFiveMinuteBars(parsed.ticker)) : null;
    const stopLevel = allocationTrade ? 0 : sameTicker ? (bull ? stopLongVal() : stopShortVal()) : adjustedStop(bull ? uq.low : uq.high, bull, ownAtr);
    if (!allocationTrade && !Number.isFinite(stopLevel)) throw new Error('Stop unavailable. Check the selected adjustment and price data, enter a manual stop, or choose None.');
    // Buffered plans freeze their numeric stop; future quotes must not widen it.
    const stopName = allocationTrade ? '' : usingDefault ? autoStopName(bull) + (state.stopStrategy !== 'none' ? ' · fixed' : '') : 'stop';
    const itm = isCall ? parsed.strike < underlyingPrice : parsed.strike > underlyingPrice;

    const cardId = 'pinned_' + Date.now();
    let d;
    if (parsed.spread) {
      const oqs = Array.isArray(oqRaw) ? oqRaw : [oqRaw];
      const legQ = occ => oqs.find(o => o.symbol === occ && o.type === 'option');
      const q1 = legQ(parsed.occ), q2 = legQ(parsed.occ2);
      if (!q1 || !q2) throw new Error(`Spread leg not found — check strikes/expiry (${parsed.occ}, ${parsed.occ2})`);
      const leg = (q2x, K, side) => ({
        K, side, occ: q2x.symbol,
        mid: ((q2x.bid || 0) + (q2x.ask || 0)) / 2, bid: q2x.bid || 0, ask: q2x.ask || 0,
        iv: q2x.greeks?.smv_vol || q2x.greeks?.mid_iv || 0, delta: q2x.greeks?.delta || 0
      });
      const lg = leg(q1, parsed.strike, 1), sh = leg(q2, parsed.strike2, -1);
      const net = lg.mid - sh.mid; // debit paid, or credit received
      if (!(net > 0)) throw new Error(parsed.credit ? 'No credit at current mids — check the strikes.' : 'That combination is a credit at current mids, not a debit.');
      d = {
        kind: 'spread', credit: !!parsed.credit, parsed, legs: [lg, sh],
        isCall, itm, underlyingPrice, stopName, stopLevel,
        mid: net, bid: lg.bid - sh.ask, ask: lg.ask - sh.bid,
        delta: lg.delta - sh.delta, gamma: (q1.greeks?.gamma || 0) - (q2.greeks?.gamma || 0), iv: lg.iv,
        vol: Math.min(q1.volume || 0, q2.volume || 0), oi: Math.min(q1.open_interest || 0, q2.open_interest || 0),
        spreadPct: net > 0 ? ((lg.ask - sh.bid) - (lg.bid - sh.ask)) / net * 100 : 0,
        asOf: new Date().toLocaleTimeString()
      };
    } else {
      const oq = oqRaw;
      if (oq.type !== 'option') throw new Error(`Option not found: ${parsed.occ} — check strike/expiry`);
      const mid = ((oq.bid || 0) + (oq.ask || 0)) / 2;
      d = {
        parsed, isCall, itm, underlyingPrice, stopName, stopLevel,
        ...(allocationTrade ? { sizing: 'allocation', shortPut: shortPutTrade, credit: shortPutTrade, contractSize: oq.contract_size, rootSymbol: oq.root_symbol, underlyingType: uq.type } : {}),
        mid, bid: allocationTrade ? oq.bid : oq.bid || 0, ask: allocationTrade ? oq.ask : oq.ask || 0,
        delta: oq.greeks?.delta ?? (allocationTrade ? null : 0), gamma: oq.greeks?.gamma || 0,
        iv: oq.greeks?.smv_vol || oq.greeks?.mid_iv || 0,
        vol: oq.volume || 0, oi: oq.open_interest || 0,
        spreadPct: mid > 0 ? ((oq.ask || 0) - (oq.bid || 0)) / mid * 100 : 0,
        asOf: new Date().toLocaleTimeString()
      };
    }
    recalcPinnedStop(d);
    state.pinnedData[cardId] = d;
    const newCard = document.createElement('div');
    newCard.className = 'pinned-card';
    newCard.id = cardId;
    document.getElementById('pinnedSection').prepend(newCard);
    renderPinnedCard(cardId);
    updatePinnedBar();
    if (fromSearch) {
      // the field goes back to the symbol the stops and chart belong to
      document.getElementById('ticker').value = state.quoteData?.symbol || parsed.ticker;
      tickerInputChanged();
      if (mq('(max-width: 600px)')) newCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      document.getElementById('quickInput').value = '';
      document.getElementById('quickParsed').textContent = '';
    }
    document.getElementById('lastUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch(e) {
    showError('Error: ' + e.message);
  } finally {
    busyEl.innerHTML = idleLabel;
  }
}
