// Allocation sizing: target % of account less existing exposure, for long shares, long options and sold puts.
import { state } from '../state.js';
import { expChat, fmt$, fmtN, marketEscape } from '../core/format.js';
import { expiryCloseMs, isBull, sizeUnit, typeLabel } from '../core/options.js';
import { calcAllocation, optionDte, shortPutMetrics, unitsFor } from '../core/sizing.js';
import { store } from '../lib/store.js';
import { renderPinnedCard, updatePinnedBar } from './cards.js';
import { renderChain, setSide } from './chain.js';
import { showError, withFlash } from './feedback.js';
import { recalcAll, riskDollars } from './risk.js';
import { drawShareCard, shareCanvasToClipboard } from './share-image.js';
import { cancelSpread } from './spreads.js';
import { setDirection, updateStopVisibility } from './stops.js';
import { effects } from './effects.js';

export function allocationInputs(symbol) {
  return { account: parseFloat(document.getElementById('accountSize').value),
    pct: parseFloat(document.getElementById('allocationPct').value), existing: state.exposureBySymbol[symbol] ?? 0 };
}

export function allocationSymbol() { return state.quoteData?.symbol || document.getElementById('ticker').value.trim().toUpperCase(); }

export function allocationChanged() {
  const symbol = allocationSymbol();
  if (symbol) state.exposureBySymbol[symbol] = parseFloat(document.getElementById('existingExposure').value);
  store.set('calc_allocation', document.getElementById('allocationPct').value);
  recalcAll();
}

export function setAllocationPct(pct) {
  document.getElementById('allocationPct').value = pct;
  allocationChanged();
}

export function updateSizingControls() {
  const alloc = state.sizingMode === 'allocation';
  for (const id of ['riskPctField', 'riskDollarField', 'riskPresets', 'riskUsdRow']) document.getElementById(id).style.display = alloc ? 'none' : '';
  document.getElementById('allocationControls').style.display = alloc ? '' : 'none';
  document.getElementById('optionTradeControls').style.display = alloc && state.currentMode === 'options' ? '' : 'none';
  for (const [id, active] of [['sizingRisk', !alloc], ['sizingAllocation', alloc], ['optionBuy', state.optionTradeSide === 'buy'], ['optionSellPut', state.optionTradeSide === 'sell-put']]) {
    document.getElementById(id).classList.toggle('active', active);
    document.getElementById(id).setAttribute('aria-pressed', String(active));
  }
  document.getElementById('sizingAllocation').disabled = state.currentMode === 'futures';
  const symbol = allocationSymbol();
  document.getElementById('exposureSymbol').textContent = symbol;
  document.getElementById('existingExposure').disabled = !symbol;
  if (document.activeElement !== document.getElementById('existingExposure')) document.getElementById('existingExposure').value = state.exposureBySymbol[symbol] ?? 0;
  updateStopVisibility();
}

export function setSizingMode(mode) {
  const next = mode === 'allocation' && state.currentMode !== 'futures' ? 'allocation' : 'risk';
  if (next !== state.sizingMode) state.optionTradeSide = 'buy';
  state.sizingMode = next;
  cancelSpread();
  if (state.sizingMode === 'allocation' && state.direction === 'short') setDirection('long');
  updateSizingControls();
  recalcAll();
}

export function setOptionTradeSide(side) {
  state.optionTradeSide = state.sizingMode === 'allocation' && side === 'sell-put' ? 'sell-put' : 'buy';
  if (state.optionTradeSide === 'sell-put') setSide('put');
  updateSizingControls();
  renderChain();
}

export function allocationQtyChanged(qty, unitCost, symbol) {
  const input = allocationInputs(symbol);
  if (!Number.isSafeInteger(qty) || qty < 0 || !(unitCost > 0) || !Number.isFinite(unitCost) || !Number.isFinite(input.existing) || input.existing < 0 || !(input.account > 0)) return;
  const pct = (input.existing + qty * unitCost) / input.account * 100;
  if (pct > 100) { showError('That quantity exceeds 100% of the account.'); return; }
  document.getElementById('allocationPct').value = pct;
  store.set('calc_allocation', pct);
  recalcAll();
}

export function allocationQuoteError(d) {
  // Tradier quote type, contract_size and root_symbol identify the supported scope.
  // https://docs.tradier.com/docs/quotes
  if (!['stock', 'etf'].includes(d.underlyingType)) return 'Allocation options require a stock or ETF underlying.';
  if (d.rootSymbol !== d.parsed.ticker) return 'Adjusted or unverified option roots are not supported.';
  if (d.contractSize !== 100) return 'Only standard 100-share contracts are supported.';
  if (![d.bid, d.ask, d.mid, d.parsed.strike].every(Number.isFinite) || d.bid <= 0 || d.ask < d.bid || d.mid <= 0 || d.parsed.strike <= 0) return 'A valid two-sided quote is required.';
  // expired once the 4pm New York close on expiry has passed, not at midnight
  if (!Number.isFinite(optionDte(d.parsed.expStr)) || !(expiryCloseMs(d.parsed.expStr) > Date.now())) return 'This contract has expired or has an invalid expiration.';
  if (d.shortPut && (d.isCall || d.mid >= d.parsed.strike)) return 'Select a put with credit below its strike.';
  return '';
}

export function allocationForCard(d) {
  const error = allocationQuoteError(d);
  if (error) return { units: 0, error };
  return calcAllocation({ ...allocationInputs(d.parsed.ticker), unitCost: (d.shortPut ? d.parsed.strike : d.mid) * 100 });
}

export function quantityForCard(d) { return d.sizing === 'allocation' ? allocationForCard(d).units : unitsFor(riskDollars(), sizeUnit(d)); }

export function calcAllocationOption(opt, price) {
  const isCall = opt.option_type === 'call';
  const shortPut = state.optionTradeSide === 'sell-put';
  const mid = Number.isFinite(opt.bid) && Number.isFinite(opt.ask) ? (opt.bid + opt.ask) / 2 : NaN;
  const d = { sizing: 'allocation', shortPut, credit: shortPut, isCall,
    parsed: { ticker: state.quoteData.symbol, strike: opt.strike, expStr: state.selectedExp, occ: opt.symbol },
    contractSize: opt.contract_size, rootSymbol: opt.root_symbol, underlyingType: state.quoteData.type, mid, bid: opt.bid, ask: opt.ask,
    delta: opt.greeks?.delta ?? null, iv: opt.greeks?.smv_vol || opt.greeks?.mid_iv || 0,
    underlyingPrice: price, asOf: new Date().toLocaleTimeString() };
  const allocation = allocationForCard(d);
  return { opt, card: d, allocation, shortPut, isCall, mid, entryPrem: mid,
    delta: d.delta, iv: d.iv, contracts: allocation.units, unitCost: (shortPut ? opt.strike : mid) * 100,
    totalCost: allocation.commitment || 0, itm: isCall ? opt.strike < price : opt.strike > price,
    vol: opt.volume || 0, oi: opt.open_interest || 0, spreadPct: mid > 0 ? (opt.ask - opt.bid) / mid * 100 : 0,
    wideSpread: mid > 0 && (opt.ask - opt.bid) / mid > 0.1 };
}

export function allocationStats(r, unitCost, symbol, word) {
  if (r.error) return `<p class="shares-error" role="status">${r.error}</p>`;
  return `<div class="stat-grid">
    <div class="stat highlight"><div class="s-label">${word}</div><div class="s-val"><input class="s-val-input" type="number" aria-label="${word}" value="${r.units}" min="0" step="1" data-change="allocationQtyChanged" data-arg="${unitCost}" data-arg2="${marketEscape(symbol)}" /></div><div class="s-sub">edit to set allocation</div></div>
    <div class="stat"><div class="s-label">New commitment</div><div class="s-val">${fmt$(r.commitment)}</div><div class="s-sub">${fmt$(r.budget)} available before trade</div></div>
    <div class="stat"><div class="s-label">Existing exposure</div><div class="s-val">${fmt$(r.existing)}</div><div class="s-sub">in this name</div></div>
    <div class="stat teal"><div class="s-label">Total allocation</div><div class="s-val">${r.actualPct.toFixed(2)}%</div><div class="s-sub">${fmt$(r.totalExposure)} after trade</div></div>
    </div>${r.reason ? `<p class="hint" role="status">${r.reason}</p>` : ''}`;
}

export function allocationOptionBody(d, qty, entry, r) {
  const remaining = optionDte(d.parsed.expStr);
  const duration = `${Math.max(0, remaining)} DTE`;
  const m = d.shortPut ? shortPutMetrics(d.parsed.strike, entry, qty, remaining) : null;
  const delta = Number.isFinite(d.delta) ? d.delta.toFixed(3) : 'n/a';
  const spread = d.mid > 0 && Number.isFinite(d.bid) && Number.isFinite(d.ask) && d.ask >= d.bid ? ((d.ask - d.bid) / d.mid * 100).toFixed(1) + '%' : 'n/a';
  return `${allocationStats(r, (d.shortPut ? d.parsed.strike : entry) * 100, d.parsed.ticker, 'Contracts')}
    <div class="stat-grid" style="margin-top:12px;">
      ${m ? `<div class="stat highlight"><div class="s-label">Assignment notional</div><div class="s-val">${fmt$(m.notional)}</div><div class="s-sub">${qty * 100} shares at ${fmt$(d.parsed.strike)}</div></div>
      <div class="stat"><div class="s-label">Premium received</div><div class="s-val">${fmt$(m.premium)}</div><div class="s-sub">${fmt$(entry)} per share</div></div>
      <div class="stat teal"><div class="s-label">Breakeven / basis</div><div class="s-val">${fmt$(m.basis)}</div><div class="s-sub">at expiration, before fees</div></div>
      <div class="stat danger"><div class="s-label">Maximum loss</div><div class="s-val">${fmt$(m.maxLoss)}</div><div class="s-sub">if underlying reaches $0</div></div>
      <div class="stat"><div class="s-label">Return on notional</div><div class="s-val">${(m.returnOnNotional * 100).toFixed(2)}%</div><div class="s-sub">${duration} · ${m.annualized === null ? 'annualized n/a' : (m.annualized * 100).toFixed(1) + '% simple annualized'}</div></div>`
      : `<div class="stat"><div class="s-label">Debit / share</div><div class="s-val">${fmt$(entry)}</div><div class="s-sub">${fmt$(entry * 100)} per contract</div></div><div class="stat danger"><div class="s-label">Maximum loss</div><div class="s-val">${fmt$(entry * 100 * qty)}</div><div class="s-sub">full debit, before fees</div></div>`}
    </div>
    <p class="hint">${remaining < 0 ? 'Expired · ' : ''}Quote Δ ${delta} · spread ${spread} of mid · bid ${Number.isFinite(d.bid) ? fmt$(d.bid) : 'n/a'} / ask ${Number.isFinite(d.ask) ? fmt$(d.ask) : 'n/a'}. ${m ? 'Return assumes the full premium is retained; annualization is an extrapolation, not a forecast.' : 'Sized by full debit.'}</p>`;
}

export function pinAllocation(symbol) {
  const d = state.detailReg[symbol]?.card;
  if (!d || allocationForCard(d).error) return;
  const id = 'pinned_' + Date.now();
  state.pinnedData[id] = { ...d, parsed: { ...d.parsed } };
  const div = document.createElement('div');
  div.className = 'pinned-card'; div.id = id;
  document.getElementById('pinnedSection').prepend(div);
  renderPinnedCard(id); updatePinnedBar();
}

export function renderAllocationCard(id, d) {
  const r = allocationForCard(d);
  const qty = r.units;
  const error = allocationQuoteError(d);
  const el = document.getElementById(id);
  el.innerHTML = `<div class="pinned-header allocation-header">
    <span class="tag ${isBull(d) ? 'call' : 'put'}">${d.shortPut ? 'Short put' : 'Long ' + (d.isCall ? 'call' : 'put')}</span>
    <span class="pinned-symbol">${marketEscape(d.parsed.ticker)} $${d.parsed.strike} ${marketEscape(d.parsed.expStr)}</span>
    <span class="pinned-meta">ALLOCATION · ${marketEscape(d.asOf || '')}</span>
    <button class="filter-btn" data-action="copyPinned" data-arg="${id}">copy</button>
    <button class="filter-btn" data-action="sharePinned" data-arg="${id}">share</button>
    <button class="filter-btn" ${error || qty < 1 ? 'disabled' : ''} data-action="simFromPinned" data-arg="${id}">sim</button>
    <button class="filter-btn" data-action="refreshPinned" data-arg="${id}">↻</button>
    <button class="filter-btn" aria-label="Remove card" data-action="removePinned" data-arg="${id}">×</button>
    </div>
    ${error ? `<p class="shares-error">${error}</p>` : allocationOptionBody(d, qty, d.mid, r)}`;
  withFlash(el);
}

export function allocationSummary(d, qty, entry, r) {
  const total = d.shortPut ? d.parsed.strike * 100 * qty : entry * 100 * qty;
  const metrics = d.shortPut ? shortPutMetrics(d.parsed.strike, entry, qty, optionDte(d.parsed.expStr)) : null;
  return `${d.shortPut ? 'Sell' : 'Buy'} ${qty} $${d.parsed.ticker} ${expChat(d.parsed.expStr)} $${d.parsed.strike} ${d.isCall ? 'call' : 'put'} @ ${fmtN(entry, 2)} · ${d.shortPut ? 'assignment notional' : 'debit'} ${fmt$(total)}${metrics ? ` · breakeven ${fmt$(metrics.basis)} · maximum loss ${fmt$(metrics.maxLoss)} · return on notional ${(metrics.returnOnNotional * 100).toFixed(2)}%` : ''} · total allocation ${r.actualPct.toFixed(2)}% · before fees`;
}

export function shareAllocation(d, qty, entry, r) {
  if (!Number.isFinite(entry) || entry <= 0 || r.error) return;
  const m = d.shortPut ? shortPutMetrics(d.parsed.strike, entry, qty, optionDte(d.parsed.expStr)) : null;
  effects.shareCanvasToClipboard(effects.drawShareCard({
    title: [{ t: `${d.parsed.ticker} $${d.parsed.strike} ${typeLabel(d).toUpperCase()} ${d.parsed.expStr}` }],
    sub: `${qty} contracts · allocation plan · before fees`,
    stats: [
      { label: m ? 'Assignment notional' : 'Full debit', value: fmt$(m ? m.notional : entry * 100 * qty) },
      { label: m ? 'Premium received' : 'Entry premium', value: fmt$(m ? m.premium : entry) },
      { label: m ? 'Breakeven' : 'Maximum loss', value: fmt$(m ? m.basis : entry * 100 * qty) },
      { label: m ? 'Maximum loss' : 'Contracts', value: m ? fmt$(m.maxLoss) : String(qty) }
    ], footer: m ? `Return on notional ${(m.returnOnNotional * 100).toFixed(2)}%${r ? ` · total allocation ${r.actualPct.toFixed(2)}%` : ''}` : ''
  }), `${d.parsed.ticker}-allocation`);
}
