import { state } from '../state.js';
import { effectivePrice } from '../core/extended-hours.js';
import { fmt$ } from '../core/format.js';
import { cardValueAt, isBull, sizeUnit, spreadWidth, strikesLabel, yearsToExp } from '../core/options.js';
import { unitsFor } from '../core/sizing.js';
import { baseUrl, headers } from '../services/tradier.js';
import { renderAllocationCard } from './allocation.js';
import { showError, withFlash } from './feedback.js';
import { riskDollars } from './risk.js';
import { requireKey } from './settings.js';

export function removePinned(cardId) {
  delete state.pinnedData[cardId];
  const el = document.getElementById(cardId);
  if (el) el.remove();
  updatePinnedBar();
}

// everything derived from the card's stop level

export function recalcPinnedStop(d) {
  if (d.sizing === 'allocation') return;
  const drop = d.stopLevel - d.underlyingPrice;
  const losing = isBull(d) ? drop < 0 : drop > 0;
  const T = yearsToExp(d.parsed && d.parsed.expStr);
  let atStopEst, atStopEstON;
  if (d.iv > 0 && T > 0) {
    const baseNow = cardValueAt(d, d.underlyingPrice, T);
    atStopEst = d.mid + cardValueAt(d, d.stopLevel, T) - baseNow;
    atStopEstON = d.mid + cardValueAt(d, d.stopLevel, T - 1 / 365) - baseNow;
  } else {
    atStopEst = d.mid + d.delta * drop + 0.5 * (d.gamma || 0) * drop * drop;
    atStopEstON = atStopEst;
  }
  // a loss-direction move can't show a gain: cheaper for longs, pricier to buy back for credit spreads
  if (losing) {
    atStopEst = d.credit ? Math.max(atStopEst, d.mid) : Math.min(atStopEst, d.mid);
    atStopEstON = d.credit ? Math.max(atStopEstON, d.mid) : Math.min(atStopEstON, d.mid);
  }
  const cap = d.kind === 'spread' ? spreadWidth(d) : Infinity; // a vertical is never worth more than its width
  d.atLod = Math.min(cap, Math.max(0, atStopEst));
  d.atLodON = Math.min(cap, Math.max(0, atStopEstON));
  d.lossPerContract = (d.credit ? -1 : 1) * (d.mid - d.atLod) * 100;
  const basis = d.credit ? sizeUnit(d) : d.mid * 100; // credit: % of max loss, debit/single: % of cost
  d.lossOfCost = basis > 0 ? d.lossPerContract / basis * 100 : 0;
  d.lodPct = d.underlyingPrice > 0 ? (drop / d.underlyingPrice * 100).toFixed(2) : '0.00';
}

export async function refreshCardData(d) {
  const optSyms = d.legs ? d.legs.map(L => L.occ).join(',') : d.parsed.occ;
  const [qRes, oRes] = await Promise.all([
    fetch(`${baseUrl()}/markets/quotes?symbols=${d.parsed.ticker}`, { headers: headers() }),
    fetch(`${baseUrl()}/markets/quotes?symbols=${optSyms}&greeks=true`, { headers: headers() })
  ]);
  const uq = (await qRes.json())?.quotes?.quote;
  const oqRaw = (await oRes.json())?.quotes?.quote;
  if (!uq || !oqRaw) throw new Error('no data');
  d.underlyingPrice = effectivePrice(uq);
  if (d.legs) {
    const oqs = Array.isArray(oqRaw) ? oqRaw : [oqRaw];
    for (const L of d.legs) {
      const q2 = oqs.find(o => o.symbol === L.occ);
      if (!q2) throw new Error('leg missing');
      L.mid = ((q2.bid || 0) + (q2.ask || 0)) / 2;
      L.bid = q2.bid || 0; L.ask = q2.ask || 0;
      L.iv = q2.greeks?.smv_vol || q2.greeks?.mid_iv || L.iv;
      L.delta = q2.greeks?.delta || L.delta;
    }
    const [lg, sh] = d.legs;
    d.mid = lg.mid - sh.mid;
    d.bid = (lg.bid || 0) - (sh.ask || 0);
    d.ask = (lg.ask || 0) - (sh.bid || 0);
    d.delta = (lg.delta || 0) - (sh.delta || 0);
    d.iv = lg.iv;
    d.spreadPct = d.mid > 0 ? (d.ask - d.bid) / d.mid * 100 : 0;
  } else {
    const oq = oqRaw;
    d.bid = d.sizing === 'allocation' ? oq.bid : oq.bid || 0;
    d.ask = d.sizing === 'allocation' ? oq.ask : oq.ask || 0;
    d.contractSize = oq.contract_size;
    d.rootSymbol = oq.root_symbol; d.underlyingType = uq.type;
    d.mid = Number.isFinite(d.bid) && Number.isFinite(d.ask) ? (d.bid + d.ask) / 2 : NaN;
    d.delta = oq.greeks?.delta ?? (d.sizing === 'allocation' ? null : 0);
    d.gamma = oq.greeks?.gamma || 0;
    d.iv = oq.greeks?.smv_vol || oq.greeks?.mid_iv || 0;
    d.vol = oq.volume || 0;
    d.oi = oq.open_interest || 0;
    d.itm = d.isCall ? d.parsed.strike < d.underlyingPrice : d.parsed.strike > d.underlyingPrice;
    d.spreadPct = d.mid > 0 ? (d.ask - d.bid) / d.mid * 100 : 0;
  }
  // default stops track the fresh session levels; a user-set stop stays put
  if (d.stopName === 'LOD') d.stopLevel = uq.low || d.stopLevel;
  if (d.stopName === 'HOD') d.stopLevel = uq.high || d.stopLevel;
  d.asOf = new Date().toLocaleTimeString();
  recalcPinnedStop(d);
}

export async function refreshPinned(cardId) {
  const d = state.pinnedData[cardId];
  if (!d) return;
  if (!requireKey()) return;
  try {
    await refreshCardData(d);
    renderPinnedCard(cardId);
  } catch(e) {
    showError('Card refresh failed — check key/network.');
  }
}

export function refreshAllPinned() {
  Object.keys(state.pinnedData).forEach(refreshPinned);
}

export function updatePinnedBar() {
  const n = Object.keys(state.pinnedData).length;
  document.getElementById('pinnedBar').innerHTML = n >= 2
    ? '<div style="display:flex;justify-content:flex-end;margin-bottom:10px;"><button class="btn" style="font-size:12px;padding:5px 12px;" data-action="refreshAllPinned">↻ Refresh all cards</button></div>'
    : '';
}

export function pinnedStopChanged(cardId, el) {
  const d = state.pinnedData[cardId];
  if (!d) return;
  const v = parseFloat(el.value);
  if (!isNaN(v) && v > 0) {
    d.stopLevel = v;
    d.stopName = 'stop';
    recalcPinnedStop(d);
  }
  state.flashNext = true;
  renderPinnedCard(cardId);
  state.flashNext = false;
}

export function renderPinnedCard(cardId) {
  const d = state.pinnedData[cardId];
  const el = document.getElementById(cardId);
  if (!d || !el) return;
  if (d.sizing === 'allocation') { renderAllocationCard(cardId, d); return; }
  const risk = riskDollars();
  const acct = parseFloat(document.getElementById('accountSize').value) || 1;
  const contracts = unitsFor(risk, sizeUnit(d));
  const totalCost = contracts * d.mid * 100;
  if (d.kind === 'spread') { renderSpreadCard(cardId, d, risk, acct, contracts); return; }
  el.innerHTML = `
    <div class="pinned-header">
      <span class="tag ${d.isCall ? 'call' : 'put'}">${d.isCall ? 'Call' : 'Put'}</span>
      <span class="pinned-symbol">${d.parsed.ticker} $${d.parsed.strike} ${d.parsed.expStr}</span>
      <span class="pinned-badge ${d.itm ? 'badge-itm' : 'badge-otm'}" style="font-size:11px;padding:2px 7px;border-radius:3px;">${d.itm ? 'ITM' : 'OTM'}</span>
      <span class="pinned-meta" style="font-size:12px;color:var(--text2);margin-left:4px;font-family:var(--mono);">underlying ${fmt$(d.underlyingPrice)} &nbsp;·&nbsp; <span style="color:var(--red);">${d.stopName} $<input type="number" class="s-val-input" value="${d.stopLevel.toFixed(2)}" step="0.01" min="0" title="Edit the stop, card recalculates" data-change="pinnedStopChanged" data-arg="${cardId}" style="width:64px;font-size:12px;color:var(--red);" /> (${d.lodPct}%)</span> &nbsp;·&nbsp; ${d.asOf || ''}</span>
      <button class="card-act" data-action="copyPinned" data-arg="${cardId}" title="Copy as text for the live chat" style="margin-left:auto;background:none;border:none;color:var(--text2);cursor:pointer;font-size:12px;line-height:1;font-weight:600;">copy</button>
      <button class="card-act" data-action="sharePinned" data-arg="${cardId}" title="Copy this card as an image" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:12px;line-height:1;font-weight:600;">share</button>
      <button class="card-act" data-action="simFromPinned" data-arg="${cardId}" title="Simulate returns over time (Black-Scholes)" style="background:none;border:none;color:var(--teal);cursor:pointer;font-size:12px;line-height:1;font-weight:600;">sim</button>
      <button class="card-act" data-action="saveCard" data-arg="${cardId}" title="Save as a position: persists, with editable entry price and contracts" style="background:none;border:none;color:var(--blue);cursor:pointer;font-size:12px;line-height:1;font-weight:600;">save</button>
      <button class="card-act" data-action="refreshPinned" data-arg="${cardId}" title="Refresh quote" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:14px;line-height:1;">↻</button>
      <button class="card-act" data-action="removePinned" data-arg="${cardId}" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:16px;line-height:1;">×</button>
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="s-label">Mid premium</div><div class="s-val">${fmt$(d.mid)}</div><div class="s-sub">bid ${fmt$(d.bid)} / ask ${fmt$(d.ask)}${d.spreadPct > 10 && d.ask > 0 ? ` · <span style="color:var(--amber)">spread ${d.spreadPct.toFixed(0)}%</span>` : ''}</div></div>
      <div class="stat"><div class="s-label">Delta</div><div class="s-val">${d.delta.toFixed(3)}</div><div class="s-sub">${d.iv > 0 ? 'IV ' + (d.iv*100).toFixed(1) + '%' : 'IV n/a'}</div></div>
      <div class="stat ${d.vol > d.oi && d.vol > 0 ? 'highlight' : ''}"><div class="s-label">Vol / OI</div><div class="s-val">${Number(d.vol).toLocaleString()}</div><div class="s-sub">OI ${Number(d.oi).toLocaleString()}${d.vol > d.oi && d.vol > 0 ? ' · vol > OI' : ''}</div></div>
      <div class="stat teal"><div class="s-label">Premium @ stop</div><div class="s-val">${fmt$(d.atLod)}</div><div class="s-sub">Δ × move to ${d.stopName}</div></div>
      <div class="stat ${d.lossOfCost > 60 ? 'danger' : d.lossOfCost > 25 ? '' : 'good'}"><div class="s-label">Loss of premium</div><div class="s-val">${d.lossOfCost.toFixed(1)}%</div><div class="s-sub">${fmt$(d.lossPerContract > 0 ? d.lossPerContract : 0)} per contract</div></div>
    </div>
    <div style="height:10px;"></div>
    <div class="stat-grid">
      <div class="stat highlight"><div class="s-label">Contracts</div><div class="s-val">${d.lossPerContract > 0 ? `<input type="number" class="s-val-input" value="${contracts}" min="0" step="1" title="Type a contract count, risk $ follows" data-change="contractsQtyChanged" data-arg="${d.lossPerContract}" />` : '—'}</div><div class="s-sub">for ${fmt$(risk)} risk · edit to set risk</div></div>
      <div class="stat danger"><div class="s-label">Max loss @ stop</div><div class="s-val">${contracts > 0 ? fmt$(contracts * d.lossPerContract) : '—'}</div><div class="s-sub">${contracts > 0 ? (contracts * d.lossPerContract / acct * 100).toFixed(2) + '% of acct' : ''}${contracts > 0 && (d.mid - d.atLodON) * 100 > d.lossPerContract + 0.005 ? `<br>held overnight: −${fmt$((d.mid - d.atLodON) * 100 * contracts)}` : ''}</div></div>
      <div class="stat good"><div class="s-label">Total cost</div><div class="s-val">${contracts > 0 ? fmt$(totalCost) : '—'}</div><div class="s-sub">${contracts > 0 ? (totalCost / acct * 100).toFixed(1) + '% of acct' : ''}</div></div>
      <div class="stat"><div class="s-label">Loss / contract</div><div class="s-val">${d.lossPerContract > 0 ? fmt$(d.lossPerContract) : '—'}</div><div class="s-sub">at ${d.stopName}</div></div>
    </div>
  `;
  withFlash(el);
}

export function renderSpreadCard(cardId, d, risk, acct, cts) {
  const el = document.getElementById(cardId);
  const width = spreadWidth(d);
  const credit = !!d.credit;
  const maxProfitCt = (credit ? d.mid : width - d.mid) * 100;
  const maxLossCt = sizeUnit(d); // full debit, or width − credit
  const breakeven = d.isCall ? d.legs[0].K + d.mid : d.legs[0].K - d.mid; // near strike ± net, both kinds
  const lossStopCt = (credit ? -1 : 1) * (d.mid - d.atLod) * 100;
  const lossStopCtON = (credit ? -1 : 1) * (d.mid - d.atLodON) * 100;
  // max profit lands where the far leg finishes ITM (debit) or the sold near leg finishes OTM (credit)
  const profTarget = credit ? `${d.isCall ? '≤' : '≥'} $${+d.legs[0].K}` : `${d.isCall ? '≥' : '≤'} $${+d.legs[1].K}`;
  el.innerHTML = `
    <div class="pinned-header">
      <span class="tag ${isBull(d) ? 'call' : 'put'}">${d.isCall ? 'Call' : 'Put'}</span>
      <span class="pinned-symbol">${d.parsed.ticker} ${strikesLabel(d)} ${d.parsed.expStr}</span>
      <span class="pinned-badge" style="font-size:10px;padding:2px 7px;border-radius:3px;background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-bd);font-weight:600;letter-spacing:0.04em;">${credit ? 'CREDIT' : 'DEBIT'} SPREAD</span>
      <span class="pinned-meta" style="font-size:12px;color:var(--text2);margin-left:4px;font-family:var(--mono);">underlying ${fmt$(d.underlyingPrice)} &nbsp;·&nbsp; <span style="color:var(--red);">${d.stopName} $<input type="number" class="s-val-input" value="${d.stopLevel.toFixed(2)}" step="0.01" min="0" title="Edit the stop, card recalculates" data-change="pinnedStopChanged" data-arg="${cardId}" style="width:64px;font-size:12px;color:var(--red);" /> (${d.lodPct}%)</span> &nbsp;·&nbsp; ${d.asOf || ''}</span>
      <button class="card-act" data-action="copyPinned" data-arg="${cardId}" title="Copy as text for the live chat" style="margin-left:auto;background:none;border:none;color:var(--text2);cursor:pointer;font-size:12px;line-height:1;font-weight:600;">copy</button>
      <button class="card-act" data-action="sharePinned" data-arg="${cardId}" title="Copy this card as an image" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:12px;line-height:1;font-weight:600;">share</button>
      <button class="card-act" data-action="simFromPinned" data-arg="${cardId}" title="Simulate spread returns over time (Black-Scholes, both legs)" style="background:none;border:none;color:var(--teal);cursor:pointer;font-size:12px;line-height:1;font-weight:600;">sim</button>
      <button class="card-act" data-action="saveCard" data-arg="${cardId}" title="Save as a position: persists, with editable entry ${credit ? 'credit' : 'debit'} and contracts" style="background:none;border:none;color:var(--blue);cursor:pointer;font-size:12px;line-height:1;font-weight:600;">save</button>
      <button class="card-act" data-action="refreshPinned" data-arg="${cardId}" title="Refresh both legs" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:14px;line-height:1;">↻</button>
      <button class="card-act" data-action="removePinned" data-arg="${cardId}" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:16px;line-height:1;">×</button>
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="s-label">Net ${credit ? 'credit' : 'debit'} / spread</div><div class="s-val">${fmt$(d.mid)}</div><div class="s-sub">${credit && width > 0 ? `<b>${(d.mid / width * 100).toFixed(0)}% of width</b> · ` : ''}${credit ? 'short' : 'long'} $${+d.legs[0].K} @ ${fmt$(d.legs[0].mid)} · ${credit ? 'long' : 'short'} $${+d.legs[1].K} @ ${fmt$(d.legs[1].mid)}${d.spreadPct > 15 ? ` · <span style="color:var(--amber)">wide fill risk</span>` : ''}</div></div>
      ${credit
        ? `<div class="stat danger"><div class="s-label">Max loss / spread</div><div class="s-val">${fmt$(maxLossCt)}</div><div class="s-sub">width − credit · full loss at ${d.isCall ? '≥' : '≤'} $${+d.legs[1].K} by expiry</div></div>`
        : `<div class="stat good"><div class="s-label">Max profit / spread</div><div class="s-val">${fmt$(maxProfitCt)}</div><div class="s-sub">+${maxLossCt > 0 ? (maxProfitCt / maxLossCt * 100).toFixed(0) : 0}% at ${profTarget} by expiry</div></div>`}
      <div class="stat teal"><div class="s-label">Breakeven</div><div class="s-val">${fmt$(breakeven)}</div><div class="s-sub">at expiry · width ${fmt$(width)}</div></div>
      <div class="stat"><div class="s-label">${credit ? 'Close @ stop' : 'Value @ stop'}</div><div class="s-val">${fmt$(d.atLod)}</div><div class="s-sub">${lossStopCt > 0 ? `−${fmt$(lossStopCt)} (−${d.lossOfCost.toFixed(0)}%)` : (credit ? 'keeps the credit' : 'holds value')} · BS both legs${lossStopCtON > lossStopCt + 0.005 ? `<br>held overnight: −${fmt$(lossStopCtON)}` : ''}</div></div>
    </div>
    <div style="height:10px;"></div>
    <div class="stat-grid">
      <div class="stat highlight"><div class="s-label">Spreads</div><div class="s-val">${maxLossCt > 0 ? `<input type="number" class="s-val-input" value="${cts}" min="0" step="1" title="Type a spread count, risk $ follows" data-change="contractsQtyChanged" data-arg="${maxLossCt}" />` : '—'}</div><div class="s-sub">sized by ${credit ? 'max loss (width − credit)' : 'full debit'} · edit to set risk</div></div>
      <div class="stat danger"><div class="s-label">Max loss</div><div class="s-val">${cts > 0 ? fmt$(cts * maxLossCt) : '—'}</div><div class="s-sub">${cts > 0 ? (cts * maxLossCt / acct * 100).toFixed(2) + '% of acct · ' + (credit ? 'width − credit' : 'the full debit') : ''}</div></div>
      <div class="stat good"><div class="s-label">Max profit total</div><div class="s-val">${cts > 0 ? fmt$(cts * maxProfitCt) : '—'}</div><div class="s-sub">${cts > 0 ? (cts * maxProfitCt / acct * 100).toFixed(2) + '% of acct' : ''}</div></div>
      <div class="stat"><div class="s-label">Reward / risk</div><div class="s-val">${maxLossCt > 0 ? (maxProfitCt / maxLossCt).toFixed(2) : '—'}</div><div class="s-sub">max profit ÷ ${credit ? 'max loss' : 'debit'}</div></div>
    </div>
  `;
  withFlash(el);
}

export function renderPinnedCards() {
  Object.keys(state.pinnedData).forEach(renderPinnedCard);
}
