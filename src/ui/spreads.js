// Vertical spread builder: mark the near leg, tap the far strike, pin the spread card.
import { state } from '../state.js';
import { effectivePrice } from '../core/extended-hours.js';
import { fmt$ } from '../core/format.js';
import { strikesLabel, typeLabel } from '../core/options.js';
import { recalcPinnedStop, renderPinnedCard, updatePinnedBar } from './cards.js';
import { closeDetails } from './detail.js';
import { showError, showToast } from './feedback.js';
import { autoStopName, rawStop, stopLongVal, stopShortVal } from './stops.js';

export function startSpread(sym, credit) {
  const c = state.detailReg[sym];
  if (!c) return;
  state.spreadPending = c;
  state.spreadPendingCredit = !!credit;
  closeDetails();
  const b = document.getElementById('spreadBanner');
  b.style.display = 'block';
  const dir = c.isCall ? 'higher' : 'lower';
  const leg = `${state.quoteData.symbol} $${+c.opt.strike}${c.isCall ? 'C' : 'P'} @ ${fmt$(c.mid)}`;
  b.innerHTML = (credit
    ? `credit spread · short ${leg} — tap the strike to BUY (${dir})`
    : `debit spread · long ${leg} — tap the strike to SELL (${dir})`)
    + ` <button data-action="cancelSpread" style="float:right;background:none;border:none;color:var(--blue);cursor:pointer;font-weight:700;font-size:13px;line-height:1;">✕</button>`;
}

export function cancelSpread() {
  state.spreadPending = null;
  state.spreadPendingCredit = false;
  const b = document.getElementById('spreadBanner');
  if (b) b.style.display = 'none';
}

export function completeSpread(farC) {
  const L = state.spreadPending;
  if (!L) return;
  const credit = state.spreadPendingCredit;
  if (farC.opt.symbol === L.opt.symbol) { showError(`Pick a different strike for the ${credit ? 'long' : 'short'} leg.`); return; }
  const okDir = L.isCall ? farC.opt.strike > L.opt.strike : farC.opt.strike < L.opt.strike;
  if (!okDir) { showError(`${credit ? 'Credit' : 'Debit'} ${L.isCall ? 'call' : 'put'} spread: ${credit ? 'buy' : 'sell'} a ${L.isCall ? 'higher' : 'lower'} strike than $${+L.opt.strike}.`); return; }
  const net = L.mid - farC.mid; // debit paid, or credit received
  if (!(net > 0)) { showError(credit ? 'No credit there — the far leg costs more than the one you are selling.' : 'That combination is a credit, not a debit — pick a strike closer to the money.'); return; }
  cancelSpread();
  const bull = credit ? !L.isCall : L.isCall;
  const rawS = rawStop(bull ? 'stopLong' : 'stopShort');
  const stopLevel = bull ? stopLongVal() : stopShortVal();
  if (!Number.isFinite(stopLevel)) { showError('Stop unavailable. Check the selected adjustment and price data, enter a manual stop, or choose None.'); return; }
  const cardId = 'pinned_' + Date.now();
  const d = {
    kind: 'spread', credit,
    parsed: { ticker: state.quoteData.symbol, strike: L.opt.strike, expStr: state.selectedExp, occ: L.opt.symbol },
    legs: [
      { K: L.opt.strike, iv: L.iv, side: 1, occ: L.opt.symbol, mid: L.mid, delta: L.delta },
      { K: farC.opt.strike, iv: farC.iv, side: -1, occ: farC.opt.symbol, mid: farC.mid, delta: farC.delta }
    ],
    isCall: L.isCall, itm: L.itm,
    underlyingPrice: effectivePrice(state.quoteData),
    stopName: rawS > 0 ? 'stop' : autoStopName(bull) + (state.stopStrategy !== 'none' ? ' · fixed' : ''),
    stopLevel,
    mid: net,
    bid: (L.opt.bid || 0) - (farC.opt.ask || 0),
    ask: (L.opt.ask || 0) - (farC.opt.bid || 0),
    delta: L.delta - farC.delta, gamma: (L.gamma || 0) - (farC.gamma || 0), iv: L.iv,
    vol: Math.min(L.vol, farC.vol), oi: Math.min(L.oi, farC.oi),
    spreadPct: net > 0 ? (((L.opt.ask || 0) - (farC.opt.bid || 0)) - ((L.opt.bid || 0) - (farC.opt.ask || 0))) / net * 100 : 0,
    asOf: new Date().toLocaleTimeString()
  };
  recalcPinnedStop(d);
  state.pinnedData[cardId] = d;
  const div = document.createElement('div');
  div.className = 'pinned-card';
  div.id = cardId;
  document.getElementById('pinnedSection').prepend(div);
  renderPinnedCard(cardId);
  updatePinnedBar();
  showToast(`Spread added: ${state.quoteData.symbol} ${strikesLabel(d)} ${typeLabel(d)} · ${fmt$(net)} ${credit ? 'credit' : 'debit'}`);
}
