// Futures ticket: contract picker, the live Schwab quote, entry and stop, contracts, copy.
import { state } from '../state.js';
import { fmt$, fmtFuturesPrice, marketEscape } from '../core/format.js';
import { FUTURES_CONTRACTS, calcFutures, futuresEntryFrom, futuresStopFrom, onTick, parseFuturesQuote } from '../core/futures.js';
import { riskForQty } from '../core/sizing.js';
import { store } from '../lib/store.js';
import { inZone, zoneAbbr } from '../lib/zone.js';
import { schwabFuturesQuote, schwabSession } from '../services/schwab.js';
import { copyPlainText } from './copy-text.js';
import { withFlash } from './feedback.js';
import { syncFromDollar } from './risk.js';
import { effects } from './effects.js';

export function initFutures() {
  const select = document.getElementById('futuresContract');
  select.innerHTML = Object.entries(FUTURES_CONTRACTS)
    .map(([symbol, d]) => `<option value="${symbol}">${symbol} · ${d.name}</option>`).join('')
    + '<option value="custom">Custom contract</option>';
  const saved = store.get('futures_contract');
  select.value = Object.hasOwn(FUTURES_CONTRACTS, saved) || saved === 'custom' ? saved : 'MES';
  applyFuturesContract();
}

export function applyFuturesContract() {
  const symbol = document.getElementById('futuresContract').value;
  const preset = Object.hasOwn(FUTURES_CONTRACTS, symbol) ? FUTURES_CONTRACTS[symbol] : null;
  const size = document.getElementById('futuresTickSize');
  const value = document.getElementById('futuresTickValue');
  size.readOnly = value.readOnly = !!preset;
  size.value = preset ? preset.tickSize : (store.get('futures_custom_tick_size') || '');
  value.value = preset ? preset.tickValue : (store.get('futures_custom_tick_value') || '');
  renderFutures();
}

export function futuresContractChanged() {
  store.set('futures_contract', document.getElementById('futuresContract').value);
  // Prices and commissions belong to the selected instrument, never the next one.
  ['futuresEntry', 'futuresStop', 'futuresFees'].forEach(id => document.getElementById(id).value = '');
  state.futuresTyped = { entry: false, stop: false };
  state.futuresQuote = null;
  state.futuresQuoteError = '';
  state.futuresQuoteId++; // a read still out is for the old contract
  state.futuresQuoteBusy = false;
  applyFuturesContract();
  refreshFuturesQuote();
}

/** typing an entry or stop holds it; clearing it lets the live quote fill it again */
export function futuresPriceTyped(el, which) {
  state.futuresTyped = { ...state.futuresTyped, [which]: el.value.trim() !== '' };
  renderFutures();
}

// ---------- the live quote (Schwab market data through the worker) ----------

/** the picked contract's root when it can have a live quote ('MES'), or '' for a custom contract */
export function futuresRoot() {
  const symbol = document.getElementById('futuresContract').value;
  return Object.hasOwn(FUTURES_CONTRACTS, symbol) ? symbol : '';
}

/** why the ticket can't go live now, or '' when it can */
export function futuresLiveError() {
  if (!futuresRoot()) return 'Live prices need a listed contract, not a custom one.';
  if (!schwabSession()) return 'Log in to Schwab in Settings for live futures prices.';
  return '';
}

/** Schwab's refusals in words that say what to fix */
function quoteErrorWords(e) {
  if (e?.status === 404) return 'Your Schwab worker can\'t read quotes yet. Redeploy it (worker/schwab/README.md).';
  if (e?.status === 401 || e?.status === 403) return 'Schwab refused the quote. Check that your Schwab app has Market Data Production.';
  return e?.message || 'Couldn\'t read the quote from Schwab.';
}

/**
 * Read the picked contract's quote and let untyped prices follow it. Quiet (no read, nothing shown) without a listed
 * contract or a Schwab login; a failed read keeps the last good quote and says why. Answers true when a quote landed.
 */
export async function refreshFuturesQuote() {
  const root = futuresRoot();
  if (!root || !schwabSession()) { renderFutures(); return false; }
  const id = ++state.futuresQuoteId;
  state.futuresQuoteBusy = true;
  renderFuturesQuote();
  try {
    const quote = parseFuturesQuote(await schwabFuturesQuote(root), root);
    if (id !== state.futuresQuoteId) return false; // the contract changed, or a newer read went out
    if (!quote) throw new Error(`Schwab sent no price for /${root}.`);
    state.futuresQuote = quote;
    state.futuresQuoteError = '';
    return true;
  } catch(e) {
    if (id !== state.futuresQuoteId) return false;
    state.futuresQuoteError = quoteErrorWords(e);
    return false;
  } finally {
    if (id === state.futuresQuoteId) {
      state.futuresQuoteBusy = false;
      renderFutures();
    }
  }
}

/** the live quote for the contract on the ticket, or null (none read yet, or it was another contract's) */
function liveQuote() {
  const q = state.futuresQuote;
  return q && q.root === futuresRoot() ? q : null;
}

/** untyped entry and stop take the live market: the ask (bid) for the entry, the session low (high) for the stop */
function followQuote() {
  const q = liveQuote();
  const tick = parseFloat(document.getElementById('futuresTickSize').value);
  if (!q || !(tick > 0)) return;
  const dir = state.futuresDirection;
  const fill = (id, v) => { if (v !== null) document.getElementById(id).value = String(onTick(v, tick)); };
  if (!state.futuresTyped.entry) fill('futuresEntry', futuresEntryFrom(q, dir));
  if (!state.futuresTyped.stop) fill('futuresStop', futuresStopFrom(q, dir));
}

const price = v => (v === null ? '–' : fmtFuturesPrice(v));

export function renderFuturesQuote() {
  const box = document.getElementById('futuresQuote');
  const feed = document.getElementById('futuresFeed');
  const live = !futuresLiveError();
  document.getElementById('futuresRefresh').disabled = !live || state.futuresQuoteBusy;
  document.getElementById('futuresLiveBtn').disabled = !live;
  if (!futuresRoot()) { box.innerHTML = ''; feed.textContent = 'Custom contract: typed prices only.'; return; }
  if (!schwabSession()) { box.innerHTML = ''; feed.textContent = 'Log in to Schwab in Settings for live prices. Typed prices work without it.'; return; }
  const q = liveQuote();
  const err = state.futuresQuoteError ? `<div class="futures-quote-error">${marketEscape(state.futuresQuoteError)}</div>` : '';
  if (!q) {
    box.innerHTML = err;
    feed.textContent = state.futuresQuoteBusy ? 'Reading the price from Schwab…' : err ? 'Typed prices still work.' : '';
    return;
  }
  const dir = state.futuresDirection;
  const chg = q.change === null ? ''
    : `<span class="quote-chg ${q.change >= 0 ? 'up' : 'dn'}">${q.change >= 0 ? '+' : '−'}${fmtFuturesPrice(Math.abs(q.change))}${q.changePct === null ? '' : ` (${q.change >= 0 ? '+' : '−'}${Math.abs(q.changePct).toFixed(2)}%)`}</span>`;
  const feedTag = q.realtime === false ? '<span class="tag futures-delayed">Delayed</span>' : q.realtime ? '<span class="tag futures-realtime">Real-time</span>' : '';
  box.innerHTML = `
    <div class="quote-bar futures-quote-bar"><span class="quote-ticker">${marketEscape(q.contract)}</span><span class="futures-last">${price(q.last)}</span>${chg}${feedTag}</div>
    <div class="futures-quote-row"><span>Bid ${price(q.bid)}</span><span>Ask ${price(q.ask)}</span><span class="quote-lod">LOD ${price(q.low)}</span><span class="quote-hod">HOD ${price(q.high)}</span>${q.time ? `<span>${inZone(q.time)} ${zoneAbbr()}</span>` : ''}</div>
    ${q.specMismatch ? `<div class="futures-quote-error">Schwab's tick for /${marketEscape(q.root)} is ${fmtFuturesPrice(q.specMismatch.tick)} × ${fmt$(q.specMismatch.tickAmount)}, not this ticket's. Check the contract before sizing.</div>` : ''}
    ${q.realtime === false ? '<div class="futures-quote-error">Schwab sent a delayed quote. Check the price before you size off it.</div>' : ''}
    ${err}`;
  const entryWords = state.futuresTyped.entry ? 'typed' : `${dir === 'short' ? (q.bid !== null ? 'the bid' : 'the last') : (q.ask !== null ? 'the ask' : 'the last')}`;
  const stopWords = state.futuresTyped.stop ? 'typed'
    : futuresStopFrom(q, dir) === null ? `type one, no ${dir === 'short' ? 'HOD' : 'LOD'} from Schwab yet`
    : dir === 'short' ? 'high of day (HOD)' : 'low of day (LOD)';
  feed.textContent = `Entry: ${entryWords} · Stop: ${stopWords}${state.futuresTyped.entry || state.futuresTyped.stop ? ' · clear a box to follow the market' : ' · type to hold a price'}`;
}

export function futuresSpecsChanged() {
  if (document.getElementById('futuresContract').value === 'custom') {
    store.set('futures_custom_tick_size', document.getElementById('futuresTickSize').value);
    store.set('futures_custom_tick_value', document.getElementById('futuresTickValue').value);
  }
  renderFutures();
}

export function setFuturesDirection(dir) {
  state.futuresDirection = dir;
  document.getElementById('futuresLong').className = dir === 'long' ? 'active long' : '';
  document.getElementById('futuresShort').className = dir === 'short' ? 'active short' : '';
  document.getElementById('futuresStop').placeholder = dir === 'long' ? 'Below entry' : 'Above entry';
  renderFutures();
}

export function futuresInputs() {
  const number = id => parseFloat(document.getElementById(id).value);
  return {
    risk: number('riskDollar'), entry: number('futuresEntry'), stop: number('futuresStop'),
    direction: state.futuresDirection, tickSize: number('futuresTickSize'), tickValue: number('futuresTickValue'),
    fees: document.getElementById('futuresFees').value === '' ? 0 : number('futuresFees')
  };
}

export function renderFutures() {
  followQuote();
  renderFuturesQuote();
  const input = futuresInputs();
  const result = calcFutures(input);
  const validSpec = Number.isFinite(input.tickSize) && input.tickSize > 0 && Number.isFinite(input.tickValue) && input.tickValue > 0;
  document.getElementById('futuresSpecInfo').textContent = validSpec
    ? `${fmt$(input.tickValue / input.tickSize)} per point per contract`
    : 'Custom contract: enter its tick size and dollar value per tick.';
  ['futuresEntry', 'futuresStop'].forEach(id => document.getElementById(id).step = validSpec ? input.tickSize : 'any');
  const el = document.getElementById('futuresStats');
  document.getElementById('futuresCopy').disabled = !!result.error || result.contracts < 1;
  if (result.error) {
    el.innerHTML = '';
    document.getElementById('futuresMessage').textContent = result.error;
    return;
  }
  document.getElementById('futuresMessage').textContent = result.contracts === 0
    ? `Budget is below one contract's ${fmt$(result.riskPerContract)} risk.` : '';
  const acct = parseFloat(document.getElementById('accountSize').value);
  const acctPct = acct > 0 ? `${(result.totalRisk / acct * 100).toFixed(2)}% of acct` : 'set account size for %';
  el.innerHTML = `
    <div class="stat highlight"><div class="s-label">Contracts</div><div class="s-val"><input type="number" class="s-val-input" aria-label="Futures contracts" value="${result.contracts}" min="0" step="1" title="Type a contract count, risk $ follows" data-change="futuresQtyChanged" /></div><div class="s-sub">to ${input.direction === 'long' ? 'buy' : 'short'} · edit to set risk</div></div>
    <div class="stat danger"><div class="s-label">Risk @ stop</div><div class="s-val">${fmt$(result.totalRisk)}</div><div class="s-sub">${acctPct}</div></div>
    <div class="stat teal"><div class="s-label">Risk / contract</div><div class="s-val">${fmt$(result.riskPerContract)}</div><div class="s-sub">${result.ticks} ticks × ${fmt$(input.tickValue)}${input.fees > 0 ? ' + ' + fmt$(input.fees) + ' fees' : ''}</div></div>
    <div class="stat"><div class="s-label">Stop distance</div><div class="s-val">${fmtFuturesPrice(result.points)} pts</div><div class="s-sub">${fmtFuturesPrice(input.entry)} → ${fmtFuturesPrice(input.stop)}</div></div>
  `;
  withFlash(el);
}

export function futuresQtyChanged(el) {
  const qty = Math.floor(parseFloat(el.value));
  const result = calcFutures(futuresInputs());
  if (result.error || !Number.isSafeInteger(qty) || qty < 0) { renderFutures(); return; }
  document.getElementById('riskDollar').value = riskForQty(qty, result.riskPerContract);
  syncFromDollar();
}

export function copyFutures() {
  const input = futuresInputs();
  const result = calcFutures(input);
  if (result.error || result.contracts < 1) return;
  const symbol = document.getElementById('futuresContract').value;
  const label = symbol === 'custom' ? 'custom futures' : liveQuote()?.contract || symbol;
  effects.copyPlainText(`${input.direction === 'long' ? 'Long' : 'Short'} ${result.contracts} ${label} contract${result.contracts === 1 ? '' : 's'} @ ${fmtFuturesPrice(input.entry)} · stop ${fmtFuturesPrice(input.stop)} · ${result.ticks} ticks × ${fmt$(input.tickValue)}/tick · risk @ stop ${fmt$(result.totalRisk)}${input.fees > 0 ? ` incl. ${fmt$(input.fees)}/ct round-trip fees` : ' before fees'} · excludes slippage`);
}
