import { state } from '../state.js';
import { effectivePrice, extSession } from '../core/extended-hours.js';
import { fmt$, fmtN } from '../core/format.js';
import { calcAllocation, riskForQty, unitsFor } from '../core/sizing.js';
import { allocationInputs, allocationQtyChanged, allocationStats, updateSizingControls } from './allocation.js';
import { renderPinnedCards } from './cards.js';
import { renderChain } from './chain.js';
import { drawChart } from './chart.js';
import { renderAdr } from './daily.js';
import { withFlash } from './feedback.js';
import { riskDollars, syncFromDollar } from './risk.js';
import { updateStickyBar } from './sticky-bar.js';
import { currentAtr5, entryVal, rawStop, stopLongVal, stopShortVal, stopSourceName, updateStopAdjustment } from './stops.js';

// reverse sizing: type a share/contract count, risk $ follows

export function sharesQtyChanged(el) {
  if (state.sizingMode === 'allocation' && state.quoteData) { allocationQtyChanged(Math.floor(Number(el.value)), entryVal(), state.quoteData.symbol); renderShares(); return; }
  const qty = Math.floor(parseFloat(el.value) || 0);
  if (!state.quoteData || qty <= 0) { renderShares(); return; }
  const entry = entryVal();
  const isLong = state.direction === 'long';
  const stop = isLong ? stopLongVal() : stopShortVal();
  const rps = isLong ? entry - stop : stop - entry;
  if (!(rps > 0) || !Number.isFinite(stop)) { renderShares(); return; }
  document.getElementById('riskDollar').value = riskForQty(qty, rps);
  syncFromDollar();
}

export function contractsQtyChanged(el, lossPerCt) {
  const qty = Math.floor(parseFloat(el.value) || 0);
  if (qty <= 0 || !(lossPerCt > 0)) { renderChain(); renderPinnedCards(); return; }
  document.getElementById('riskDollar').value = riskForQty(qty, lossPerCt);
  syncFromDollar();
}

export function renderExt(q) {
  const ext = extSession(q);
  document.getElementById('qExt').innerHTML = ext
    ? `<span style="color:var(--text3);">${ext.label}</span> <span style="color:${ext.chg >= 0 ? 'var(--green)' : 'var(--red)'};">${fmt$(ext.price)} ${ext.chg >= 0 ? '+' : ''}${fmtN(ext.chgPct, 2)}%</span>`
    : '';
  // sizing anchors on the extended price when there is one — cue it in the entry field
  document.getElementById('entryPrice').placeholder = ext ? `${ext.label} ${fmtN(ext.price, 2)}` : 'now';
  return ext;
}

// Quote-bound surfaces. The shares answer sits in the rail, outside #quoteSection, so it follows that section by hand.

export function setQuoteVisible(show) {
  document.getElementById('quoteSection').style.display = show ? '' : 'none';
  updateModeSections();
}

export function updateModeSections() {
  const quoteShown = !!state.quoteData && document.getElementById('quoteSection').style.display !== 'none';
  document.getElementById('sharesSection').style.display = quoteShown && state.currentMode === 'shares' ? 'block' : 'none';
  if (state.quoteData) document.getElementById('optionsSection').style.display = state.currentMode === 'options' ? 'block' : 'none';
  document.getElementById('optionTicket').style.display = quoteShown && state.currentMode === 'options' && state.railDetailSym ? '' : 'none';
}

export function renderQuote() {
  updateSizingControls();
  const q = state.quoteData;
  const price = q.last || q.ask || 0;
  const lod = q.low || 0;
  const hod = q.high || 0;
  const chg = q.change || 0;
  const chgPct = q.change_percentage || 0;
  const lodPct = price > 0 ? ((lod - price) / price * 100).toFixed(2) : 0;
  const hodPct = price > 0 ? ((hod - price) / price * 100).toFixed(2) : 0;

  document.getElementById('qTicker').textContent = q.symbol + '  ';
  document.getElementById('qPrice').textContent = fmt$(price);
  const chgEl = document.getElementById('qChg');
  chgEl.textContent = ` ${chg >= 0 ? '+' : ''}${fmtN(chg, 2)} (${chgPct >= 0 ? '+' : ''}${fmtN(chgPct, 2)}%)`;
  chgEl.className = 'quote-chg ' + (chg >= 0 ? 'up' : 'dn');
  renderExt(q);
  document.getElementById('qLod').textContent = fmt$(lod);
  document.getElementById('qLodPct').textContent = `(${lodPct}%)`;
  document.getElementById('qHod').textContent = fmt$(hod);
  document.getElementById('qHodPct').textContent = `(+${hodPct}%)`;
  document.getElementById('qVol').textContent = 'Vol ' + Number(q.volume || 0).toLocaleString();

  renderAdr();
  renderShares();
  updateModeSections();
}

export function renderShares() {
  const q = state.quoteData;
  if (!q) return;
  if (state.sizingMode === 'allocation') {
    const entry = entryVal();
    const r = calcAllocation({ ...allocationInputs(q.symbol), unitCost: entry });
    document.getElementById('sharesStats').innerHTML = `<div class="section-title">Long shares · allocation</div>${allocationStats(r, entry, q.symbol, 'Shares')}<p class="hint">Entry ${fmt$(entry)} · before fees</p>`;
    document.getElementById('sharesImage').disabled = !!r.error;
    document.getElementById('sharesCopy').disabled = !!r.error;
    return;
  }
  const price = effectivePrice(q);
  const isLong = state.direction === 'long';
  const stop = isLong ? stopLongVal() : stopShortVal();
  updateStopAdjustment();
  const entry = entryVal();
  const customEntry = rawStop('entryPrice') > 0;
  const risk = riskDollars();
  const riskPerShare = isLong ? (entry - stop) : (stop - entry);
  const acct = parseFloat(document.getElementById('accountSize').value) || 1;
  const valid = Number.isFinite(stop) && stop > 0 && Number.isFinite(entry) && riskPerShare > 0;
  document.getElementById('sharesImage').disabled = !valid;
  document.getElementById('sharesCopy').disabled = !valid;

  if (!valid) {
    const msg = !Number.isFinite(stop)
      ? (state.stopStrategy === 'percent' && !Number.isFinite(state.stopPercent) ? 'Enter a percentage from 0% to less than 100%.' : state.stopStrategy === 'atr' && !currentAtr5() ? '5m ATR(14) unavailable. Refresh intraday data, enter a manual stop, or choose None.' : 'No valid stop price. Check the LOD / HOD, reduce the buffer, or enter a manual stop.')
      : isLong
      ? `Stop (${fmt$(stop)}) must be below entry (${fmt$(entry)}) for a long.`
      : `Stop (${fmt$(stop)}) must be above entry (${fmt$(entry)}) for a short.`;
    document.getElementById('sharesStats').innerHTML = `<div class="shares-error" role="status">${msg}</div>`;
    if (state.chartBars.length) drawChart();
    updateStickyBar();
    return;
  }
  const shares = unitsFor(risk, riskPerShare);
  const posSize = shares * entry;
  const stopSource = stopSourceName(isLong, true);

  document.getElementById('sharesStats').innerHTML = `
    <div class="shares-primary">
      <div class="shares-quantity">
        <label class="shares-label" for="sharesQty">Shares to ${isLong ? 'buy' : 'short'}</label>
        <div class="s-val"><input id="sharesQty" type="number" class="s-val-input" value="${shares}" min="0" step="1" title="Type a share count, risk $ follows" aria-describedby="sharesQtyHint" onchange="sharesQtyChanged(this)" /></div>
        <div class="shares-detail">Entry <strong>${fmt$(entry)}</strong>${customEntry ? ' · planned' : ''}</div>
        <div class="shares-edit-hint" id="sharesQtyHint">Edit shares to set risk</div>
      </div>
      <div class="shares-stop">
        <div class="shares-label">Stop price</div>
        <div class="s-val">${fmt$(stop)}</div>
        <div class="shares-detail">${stopSource}</div>
      </div>
    </div>
    <dl class="shares-metrics">
      <div><dt>Risk at stop</dt><dd class="shares-loss">${fmt$(shares * riskPerShare)}<span class="shares-detail">${(shares * riskPerShare / acct * 100).toFixed(2)}% of account</span></dd></div>
      <div><dt>Position value</dt><dd>${fmt$(posSize)}<span class="shares-detail">${(posSize / acct * 100).toFixed(1)}% of account</span></dd></div>
      <div><dt>Risk per share</dt><dd>${fmt$(riskPerShare)}${customEntry ? `<span class="shares-detail">Now ${fmt$(price)}</span>` : ''}</dd></div>
    </dl>
  `;
  withFlash(document.getElementById('sharesStats'));
  if (state.chartBars.length) drawChart();
  updateStickyBar();
}
