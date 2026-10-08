// Contract detail: the inline row on phones and tablets, the rail ticket in the desktop shell.
import { state } from '../state.js';
import { effectivePrice } from '../core/extended-hours.js';
import { expChat, fmt$ } from '../core/format.js';
import { DESKTOP_MQ, mq } from '../lib/media.js';
import { allocationOptionBody } from './allocation.js';
import { chainColCount } from './chain.js';
import { withFlash } from './feedback.js';
import { simParamsFromCard } from './sim.js';

export function detailInRail() { return mq(DESKTOP_MQ); }

export function clearRailDetail() {
  state.railDetailSym = null;
  const ticket = document.getElementById('optionTicket');
  ticket.innerHTML = '';
  ticket.style.display = 'none';
}

export function detailBody(c, acct) {
  if (c.allocation) {
    return `<div class="section-title">${c.shortPut ? 'Sell put' : 'Buy ' + (c.isCall ? 'call' : 'put')} · allocation</div>${c.allocation.error ? `<p class="shares-error">${c.allocation.error}</p>` : allocationOptionBody(c.card, c.contracts, c.mid, c.allocation)}<button class="filter-btn" ${c.allocation.error ? 'disabled' : ''} data-action="pinAllocation" data-arg="${c.opt.symbol}">pin trade</button><button class="filter-btn" ${c.allocation.error || c.contracts < 1 ? 'disabled' : ''} data-action="openSimFor" data-arg="${c.opt.symbol}">simulate returns</button>`;
  }
  return `
    <div class="stat-grid">
      <div class="stat highlight"><div class="s-label">Contracts</div><div class="s-val">${c.lossPerContract > 0 ? `<input type="number" class="s-val-input" value="${c.contracts}" min="0" step="1" title="Type a contract count, risk $ follows" data-change="contractsQtyChanged" data-arg="${c.lossPerContract}" />` : '—'}</div><div class="s-sub">${c.contracts > 0 ? fmt$(c.totalCost) + ' outlay · edit to set risk' : 'stop too wide'}</div></div>
      <div class="stat danger"><div class="s-label">Max loss @ stop</div><div class="s-val">${c.lossPerContract > 0 ? fmt$(c.contracts * c.lossPerContract) : '—'}</div><div class="s-sub">${c.lossPerContract > 0 ? (c.contracts * c.lossPerContract / acct * 100).toFixed(2) + '% of acct' : ''}</div></div>
      <div class="stat teal"><div class="s-label">Premium @ stop</div><div class="s-val">${fmt$(c.atStop)}</div><div class="s-sub">${c.customEntry ? `est ${fmt$(c.entryPrem)} @ your ${fmt$(c.entryU)} entry` : `was ${fmt$(c.mid)} mid`} · stop ${fmt$(c.stop)}</div></div>
      <div class="stat"><div class="s-label">Loss of premium</div><div class="s-val">${c.lossOfCost.toFixed(1)}%</div><div class="s-sub">per contract</div></div>
      <div class="stat ${c.vol > c.oi && c.vol > 0 ? 'highlight' : ''}"><div class="s-label">Vol / OI</div><div class="s-val">${c.vol.toLocaleString()}</div><div class="s-sub">OI ${c.oi.toLocaleString()}${c.vol > c.oi && c.vol > 0 ? ' · vol > OI' : ''}</div></div>
    </div>
    ${c.lossPerContractON > c.lossPerContract + 0.005 && c.lossPerContractON > 0 ? `<div style="font-size:11.5px;color:var(--text3);margin-top:8px;font-family:var(--num);">held overnight: −${fmt$(c.lossPerContractON)}/ct (−${c.lossOfCostON.toFixed(0)}%) · a stop hit tomorrow costs one more day of theta</div>` : ''}
    <div class="detail-meta">
      <span>${c.opt.symbol} · ${c.isCall ? 'Call' : 'Put'} ${fmt$(c.opt.strike)} · bid ${fmt$(c.opt.bid||0)} / ask ${fmt$(c.opt.ask||0)}${c.wideSpread ? ` · <span style="color:var(--amber)">wide spread: ${c.spreadPct.toFixed(0)}% of mid</span>` : ''} · Δ ${c.delta.toFixed(3)} · IV ${c.iv > 0 ? (c.iv*100).toFixed(1) + '%' : 'n/a'}${c.iv > 0 && state.hv20 > 0 ? (c.iv > state.hv20 * 1.5 ? ` <span style="color:var(--amber)">vs HV20 ${(state.hv20*100).toFixed(1)}% — paying up for vol</span>` : ` vs HV20 ${(state.hv20*100).toFixed(1)}%`) : ''} · Est. via ${c.model === 'bs' ? 'Black-Scholes, IV const' : 'Δ + ½Γ·move² approx'}</span>
      <button class="filter-btn" style="margin-left:auto;" data-action="openSimFor" data-arg="${c.opt.symbol}">simulate returns</button>
      ${state.chainSide !== 'both' ? `<button class="filter-btn" data-action="startSpread" data-arg="${c.opt.symbol}" title="Buy this leg, then tap the strike to sell against it">+ debit spread</button><button class="filter-btn" data-action="startSpread" data-arg="${c.opt.symbol}" data-arg2="credit" title="Sell this leg, then tap the strike to buy against it">+ credit spread</button>` : ''}
    </div>`;
}

export function showDetail(tr, c, acct) {
  const rail = detailInRail();
  const existingDetail = tr.nextSibling;
  const already = existingDetail && existingDetail.classList && existingDetail.classList.contains('detail-row');
  const sameSymbol = rail ? state.railDetailSym === c.opt.symbol : already && existingDetail.dataset.sym === c.opt.symbol;
  closeDetails();
  if (sameSymbol) return; // toggle off
  tr.classList.add('selected');

  state.detailReg[c.opt.symbol] = c;
  state.simReg[c.opt.symbol] = c.allocation ? simParamsFromCard(c.card, c.mid, c.contracts) : {
    isCall: c.isCall, K: c.opt.strike, expStr: state.selectedExp, iv: c.iv,
    entry: c.entryPrem, qty: Math.max(1, c.contracts), spot: effectivePrice(state.quoteData),
    stop: c.stop, parsedTicker: state.quoteData.symbol,
    label: `${state.quoteData.symbol} $${c.opt.strike} ${c.isCall ? 'call' : 'put'} ${state.selectedExp}`
  };

  if (rail) {
    state.railDetailSym = c.opt.symbol;
    const ticket = document.getElementById('optionTicket');
    ticket.innerHTML = `<div class="ticket-head"><span class="tag ${c.isCall ? 'call' : 'put'}">${c.isCall ? 'Call' : 'Put'}</span><span class="pinned-symbol">${state.quoteData.symbol} $${+c.opt.strike} ${expChat(state.selectedExp)}</span><button class="sheet-close" data-action="closeDetails" aria-label="Clear the selected contract">×</button></div>${detailBody(c, acct)}`;
    ticket.style.display = '';
    withFlash(ticket);
    return;
  }
  const dr = document.createElement('tr');
  dr.className = 'detail-row';
  dr.dataset.sym = c.opt.symbol;
  dr.innerHTML = `<td colspan="${chainColCount()}"><div class="detail-inner">${detailBody(c, acct)}</div></td>`;
  tr.parentNode.insertBefore(dr, tr.nextSibling);
  if (!c.allocation) withFlash(dr.querySelector('.detail-inner'));
}

export function closeDetails() {
  document.querySelectorAll('.detail-row').forEach(r => r.remove());
  document.querySelectorAll('tbody tr').forEach(r => r.classList.remove('selected'));
  clearRailDetail();
}
