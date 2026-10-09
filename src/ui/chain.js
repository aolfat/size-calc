// Option chain: expiration tabs, zone filter, both-sides T-chart and single-side tables, ATM scroll.
import { state } from '../state.js';
import { RISK_FREE, bsPrice, normCdf } from '../core/black-scholes.js';
import { effectivePrice } from '../core/extended-hours.js';
import { fmt$, fmtN } from '../core/format.js';
import { isMonthlyExp, lossClass, yearsToExp } from '../core/options.js';
import { unitsFor } from '../core/sizing.js';
import { COMPACT_CHAIN_MQ, mq } from '../lib/media.js';
import { baseUrl, headers } from '../services/tradier.js';
import { calcAllocationOption, updateSizingControls } from './allocation.js';
import { drawChart } from './chart.js';
import { ivRankInfo, renderAdr } from './daily.js';
import { clearRailDetail, showDetail } from './detail.js';
import { riskDollars } from './risk.js';
import { updateModeSections } from './shares.js';
import { cancelSpread, completeSpread } from './spreads.js';
import { rawStop, stopLongVal, stopShortVal, updateStopVisibility } from './stops.js';

export function renderExpTabs(exps) {
  state.allExps = exps;
  const el = document.getElementById('expTabs');
  const show = state.expsExpanded ? exps : exps.slice(0, 12);
  let html = show.map(e => {
    const monthly = isMonthlyExp(e);
    const dte = Math.max(0, Math.ceil((new Date(e + 'T16:00:00') - Date.now()) / 864e5));
    return `<button class="exp-tab${monthly ? ' monthly' : ''}" data-action="selectExp" data-arg="${e}" id="exp_${e.replace(/-/g,'_')}" title="${monthly ? 'Monthly expiration' : 'Weekly expiration'}">${e}<span class="dte">${dte}d</span></button>`;
  }).join('');
  if (exps.length > 12) {
    html += `<button class="exp-tab" style="color:var(--text3);" data-action="toggleExps">${state.expsExpanded ? 'Show fewer' : '+' + (exps.length - 12) + ' more'}</button>`;
  }
  el.innerHTML = html;
  if (state.selectedExp) markActiveExp(state.selectedExp);
}

export function toggleExps() {
  state.expsExpanded = !state.expsExpanded;
  renderExpTabs(state.allExps);
}

export function markActiveExp(exp) {
  document.querySelectorAll('.exp-tab').forEach(t => t.classList.remove('active'));
  const el = document.getElementById('exp_' + exp.replace(/-/g,'_'));
  if (el) el.classList.add('active');
}

export async function selectExp(exp) {
  state.selectedExp = exp;
  markActiveExp(exp);
  const ticker = state.quoteData?.symbol; // the loaded symbol, not the field
  if (ticker) await fetchChain(ticker, exp, true);
}

export async function fetchChain(ticker, exp, scrollAtm) {
  const target = ticker + '/' + exp;
  if (state.chainLoading && state.chainLoadingFor === target) return;
  const requestId = ++state.chainRequestId;
  state.chainLoading = true;
  state.chainLoadingFor = target;
  document.getElementById('chainStatus').innerHTML = '<span class="spinner" style="vertical-align:middle;"></span> loading ' + exp;
  const tbody = document.getElementById('chainBody');
  if (!state.chainData.length) {
    tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;color:var(--text3);padding:28px;"><span class="spinner" style="vertical-align:middle;margin-right:8px;"></span>Loading chain…</td></tr>';
  } else {
    tbody.style.opacity = '0.4';
  }
  try {
    const res = await fetch(`${baseUrl()}/markets/options/chains?symbol=${encodeURIComponent(ticker)}&expiration=${encodeURIComponent(exp)}&greeks=true`, { headers: headers() });
    const json = await res.json();
    if (requestId !== state.chainRequestId || ticker !== (state.quoteData?.symbol ?? ticker) || exp !== state.selectedExp) return;
    const opts = json?.options?.option;
    if (!opts) {
      state.chainData = [];
      tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;color:var(--text3);padding:28px;">No contracts for ' + exp + '</td></tr>';
      document.getElementById('chainStatus').textContent = '0 contracts';
      return;
    }
    state.chainData = Array.isArray(opts) ? opts : [opts];
    cancelSpread();
    document.getElementById('chainStatus').textContent = state.chainData.length + ' contracts · ' + exp;
    state.pendingAtmScroll = !!scrollAtm;
    renderChain();
  } catch(e) {
    if (requestId === state.chainRequestId) document.getElementById('chainStatus').textContent = 'Error loading chain — check key/network';
  } finally {
    if (requestId === state.chainRequestId) { state.chainLoading = false; tbody.style.opacity = '1'; }
  }
}

export function setZoneMode(m) {
  // zones are per-side; the T-chart shows an ATM window instead. Picking a zone
  // from Both view moves to Calls (tap Puts if that's the trade).
  if (state.chainSide === 'both') setSide('call');
  state.zoneMode = m;
  state.zoneFilter.otm = m === 'otm' || m === 'both';
  state.zoneFilter.itm = m === 'itm' || m === 'both';
  const btns = { otm: 'zOtm', itm: 'zItm', both: 'zBoth', all: 'zAll' };
  Object.values(btns).forEach(id => document.getElementById(id).classList.remove('active'));
  document.getElementById(btns[m]).classList.add('active');
  document.getElementById('otmFloorGroup').style.display = state.zoneFilter.otm ? 'flex' : 'none';
  document.getElementById('itmFloorGroup').style.display = state.zoneFilter.itm ? 'flex' : 'none';
  state.pendingAtmScroll = true; // re-orient to ATM — the tradeable end of an ITM ladder is at the bottom
  renderChain();
}

export function updateChainControls() {
  const both = state.chainSide === 'both';
  document.getElementById('bothCountGroup').style.display = both ? 'flex' : 'none';
  document.getElementById('zoneSeg').style.display = both ? 'none' : '';
  document.getElementById('otmFloorGroup').style.display = !both && state.zoneFilter.otm ? 'flex' : 'none';
  document.getElementById('itmFloorGroup').style.display = !both && state.zoneFilter.itm ? 'flex' : 'none';
}

export function setSide(s) {
  if (state.sizingMode === 'allocation' && state.optionTradeSide === 'sell-put' && s !== 'put') { state.optionTradeSide = 'buy'; updateSizingControls(); }
  cancelSpread();
  state.chainSide = s;
  updateChainControls();
  ['sBoth','sCall','sPut'].forEach(id => document.getElementById(id).classList.remove('active'));
  document.getElementById('s' + s.charAt(0).toUpperCase() + s.slice(1)).classList.add('active');
  state.pendingAtmScroll = true;
  updateStopVisibility();
  renderAdr();
  renderChain();
  if (state.chartBars.length) drawChart();
}

export function calcOpt(opt, price, callStop, putStop, risk, Texp, entryU) {
  if (!opt) return null;
  if (state.sizingMode === 'allocation') return calcAllocationOption(opt, price);
  const mid = ((opt.bid || 0) + (opt.ask || 0)) / 2;
  const delta = opt.greeks?.delta || 0;
  const gamma = opt.greeks?.gamma || 0;
  const iv = opt.greeks?.smv_vol || opt.greeks?.mid_iv || 0;
  const isCall = opt.option_type === 'call';
  const stop = isCall ? callStop : putStop;
  if (!Number.isFinite(stop) || !(stop > 0)) return null;
  const entry = entryU > 0 ? entryU : price; // planned underlying entry, blank = spot
  const losing = isCall ? stop < entry : stop > entry;
  // premiums at the entry and the stop: Black-Scholes moves applied to the market mid
  // (baseline stays the real mid, so IV-skew level offsets cancel); Δ+½Γ approx when no IV
  let entryPremEst, atStopEst, atStopEstON, model;
  if (iv > 0 && Texp > 0) {
    const K = opt.strike;
    const baseNow = bsPrice(isCall, price, K, Texp, iv, RISK_FREE);
    entryPremEst = mid + bsPrice(isCall, entry, K, Texp, iv, RISK_FREE) - baseNow;
    atStopEst = mid + bsPrice(isCall, stop, K, Texp, iv, RISK_FREE) - baseNow;
    atStopEstON = mid + bsPrice(isCall, stop, K, Math.max(0, Texp - 1 / 365), iv, RISK_FREE) - baseNow;
    model = 'bs';
  } else {
    const dropE = entry - price, drop = stop - price;
    entryPremEst = mid + delta * dropE + 0.5 * gamma * dropE * dropE;
    atStopEst = mid + delta * drop + 0.5 * gamma * drop * drop;
    atStopEstON = atStopEst;
    model = 'approx';
  }
  const entryPrem = Math.max(0, entryPremEst);
  if (losing) { atStopEst = Math.min(atStopEst, entryPrem); atStopEstON = Math.min(atStopEstON, entryPrem); } // a stop-out can't show a gain
  const atStop = Math.max(0, atStopEst);
  const atStopON = Math.max(0, atStopEstON);
  const lossPerContractON = (entryPrem - atStopON) * 100;
  const lossOfCostON = entryPrem > 0 ? ((entryPrem - atStopON) / entryPrem * 100) : 0;
  const spreadPct = mid > 0 ? ((opt.ask || 0) - (opt.bid || 0)) / mid * 100 : 0;
  const wideSpread = spreadPct > 10 && (opt.ask || 0) > 0;
  const lossPerContract = (entryPrem - atStop) * 100;
  const contracts = unitsFor(risk, lossPerContract);
  const totalCost = contracts * entryPrem * 100;
  const lossOfCost = entryPrem > 0 ? ((entryPrem - atStop) / entryPrem * 100) : 0;
  const itm = isCall ? opt.strike < price : opt.strike > price;
  const vol = opt.volume || 0;
  const oi = opt.open_interest || 0;
  return { opt, mid, entryPrem, entryU: entry, customEntry: entryU > 0 && Math.abs(entryU - price) > 0.004, delta, gamma, iv, atStop, lossPerContract, contracts, totalCost, lossOfCost, itm, vol, oi, isCall, stop, spreadPct, wideSpread, atStopON, lossPerContractON, lossOfCostON, model };
}

// mobile-compact formatters — keep 9 columns fitting a 375px screen

export function fmtKM(v) { // 12,345 → 12k · 2,000 → 2.0k
  v = Number(v) || 0;
  if (!isMobileChain()) return v.toLocaleString();
  if (v >= 10000) return (v / 1000).toFixed(0) + 'k';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
}

export function fmt$M(v) { return isMobileChain() ? fmtN(v, 2) : fmt$(v); } // drop $ on mobile

export function fmtStrikeM(v) { return isMobileChain() ? String(+v) : fmt$(v); } // 100 not $100.00

export function sideCells(c, mirror) {
  // mirror=true → calls side (reads right-to-left toward strike)
  if (!c) {
    // positions must mirror the cells below: OI (2) and Δ (4) hidden on mobile
    const empties = [0,1,2,3,4,5].map(i => `<td class="empty-cell${i <= 1 ? ' m-size' : i === 2 ? ' m-hide m-oi' : i === 4 ? ' m-hide m-delta' : ''}">—</td>`);
    return (mirror ? empties : empties.slice().reverse()).join('');
  }
  const volStyle = c.vol > c.oi && c.vol > 0 ? 'color:var(--amber);font-weight:700' : 'color:var(--gold);font-weight:600';
  const cells = [
    `<td class="side-cell m-size${c.itm ? ' itm-tint' : ''}" style="font-weight:600;color:var(--blue)">${c.contracts > 0 ? c.contracts : '—'}</td>`,
    `<td class="side-cell m-size${c.itm ? ' itm-tint' : ''}">${c.allocation ? (c.allocation.error ? '—' : fmt$M(c.unitCost)) : c.lossPerContract > 0 ? `<span class="loss-cell ${lossClass(c.lossOfCost)}">${fmt$M(c.lossPerContract)}</span><div class="loss-pct ${lossClass(c.lossOfCost)}">${c.lossOfCost.toFixed(0)}%</div>` : '—'}</td>`,
    `<td class="side-cell voloi m-hide m-oi${c.itm ? ' itm-tint' : ''}" style="${volStyle}">${fmtKM(c.oi)}</td>`,
    `<td class="side-cell voloi${c.itm ? ' itm-tint' : ''}" style="${volStyle}">${fmtKM(c.vol)}</td>`,
    `<td class="side-cell m-hide m-delta${c.itm ? ' itm-tint' : ''}" style="color:var(--text2)">${Number.isFinite(c.delta) ? fmtN(c.delta, 3) : '—'}</td>`,
    `<td class="side-cell${c.itm ? ' itm-tint' : ''}"${c.wideSpread ? ` style="color:var(--amber)" title="wide spread: ${c.spreadPct.toFixed(0)}% of mid"` : ''}>${Number.isFinite(c.mid) ? fmt$M(c.mid) : '—'}</td>`
  ];
  return (mirror ? cells : cells.slice().reverse()).join('');
}

export function twoPaneChain() {
  return mq(COMPACT_CHAIN_MQ);
}

export function chainColCount() {
  if (twoPaneChain()) return state.chainSide === 'both' ? 13 : 8; // compact + Δ + OI
  if (isMobileChain()) return state.chainSide === 'both' ? 9 : 5; // phone: OI/Vol/Δ/Mid per side
  return state.chainSide === 'both' ? 13 : 12;
}

export function isMobileChain() {
  // phone, or the narrow main pane of the compact desktop shell
  return mq('(max-width: 500px)') || twoPaneChain();
}

export function renderChainHead() {
  const head = document.getElementById('chainHead');
  const m = isMobileChain();
  const sideSpan = twoPaneChain() ? 6 : m ? 4 : 6; // per-side visible columns: two-pane / phone (OI Vol Δ Mid) / full
  const alloc = state.sizingMode === 'allocation';
  const lossH = alloc ? 'Commit/ct' : m ? 'Loss' : 'Loss/ct';
  if (state.chainSide === 'both') {
    head.innerHTML = `<tr>
      <th class="call-h m-size">Cts</th><th class="call-h m-size">${lossH}</th><th class="call-h m-hide m-oi">OI</th><th class="call-h">Vol</th><th class="call-h m-hide m-delta">Δ</th><th class="call-h">Mid</th>
      <th class="strike-col" style="width:80px;">Strike</th>
      <th class="put-h">Mid</th><th class="put-h m-hide m-delta">Δ</th><th class="put-h">Vol</th><th class="put-h m-hide m-oi">OI</th><th class="put-h m-size">${lossH}</th><th class="put-h m-size">Cts</th>
    </tr>
    <tr><th colspan="${sideSpan}" class="call-h" style="text-align:center;border-bottom:none;padding:2px;">← CALLS (${alloc ? 'buy · full debit' : 'stop: call stop'})</th><th class="strike-col" style="border-bottom:none;"></th><th colspan="${sideSpan}" class="put-h" style="text-align:center;border-bottom:none;padding:2px;">PUTS (${alloc ? 'buy · full debit' : 'stop: put stop'}) →</th></tr>`;
  } else {
    head.innerHTML = `<tr>
      <th class="strike-col" style="width:80px;">Strike</th>
      <th class="m-hide">Bid</th><th class="m-hide">Ask</th><th>Mid</th><th class="m-hide m-delta">Δ</th><th class="m-hide">IV</th><th>Vol</th><th class="m-hide m-oi">OI</th><th class="m-hide">${alloc ? 'Trade' : '@ stop'}</th><th class="m-size">${lossH}</th><th class="m-size">Cts</th><th class="m-size">${alloc ? 'Commitment' : 'Total cost'}</th>
    </tr>`;
  }
}

export function renderChain() {
  updateModeSections();
  if (state.currentMode !== 'options') return;

  const q = state.quoteData;
  if (!q || !state.chainData.length) return;

  const price = effectivePrice(q);
  const callStop = stopLongVal();
  const putStop = stopShortVal();
  const risk = riskDollars();
  const acct = parseFloat(document.getElementById('accountSize').value) || 1;

  renderChainHead();

  const otmFloor = Math.abs(parseFloat(document.getElementById('otmDelta').value)) || 0;
  const itmCeil = Math.abs(parseFloat(document.getElementById('itmDelta').value)) || 1;

  // group by strike
  const byStrike = new Map();
  for (const o of state.chainData) {
    if (!byStrike.has(o.strike)) byStrike.set(o.strike, {});
    byStrike.get(o.strike)[o.option_type] = o;
  }

  // ATM strike from the full chain, before filtering — the ITM zone runs down to it
  let atmAll = null, atmAllDist = Infinity;
  for (const s of byStrike.keys()) {
    const dd = Math.abs(s - price);
    if (dd < atmAllDist) { atmAllDist = dd; atmAll = s; }
  }

  // expected move by this expiry: the ATM straddle mid (computed before the zone filter mutates pairs)
  const atmPair = byStrike.get(atmAll);
  let em = 0;
  if (atmPair && atmPair.call && atmPair.put) {
    em = ((atmPair.call.bid || 0) + (atmPair.call.ask || 0)) / 2 + ((atmPair.put.bid || 0) + (atmPair.put.ask || 0)) / 2;
  }
  document.getElementById('emInfo').textContent = em > 0 && price > 0
    ? `±${fmt$(em)} (${(em / price * 100).toFixed(1)}%) exp move` : '';
  // ATM IV of the loaded expiry → cheap/rich gauge + the per-ticker IV diary
  let atmIv = 0;
  if (atmPair) {
    const ivs = [atmPair.call, atmPair.put].map(o => o && o.greeks ? (o.greeks.smv_vol || o.greeks.mid_iv || 0) : 0).filter(v => v > 0);
    if (ivs.length) atmIv = ivs.reduce((a, b) => a + b, 0) / ivs.length;
  }
  const ivEl = document.getElementById('ivInfo');
  if (atmIv > 0 && state.quoteData) {
    const rank = ivRankInfo(state.quoteData.symbol, atmIv);
    if (rank) {
      const col = rank.pct >= 80 ? 'var(--amber)' : rank.pct <= 20 ? 'var(--green)' : 'var(--text2)';
      ivEl.innerHTML = `IV ${(atmIv * 100).toFixed(0)}% · <span style="color:${col};font-weight:600;">${rank.pct}%ile</span>`;
      ivEl.title = `ATM IV of the loaded expiry vs ${rank.basis}. High percentile = options are historically expensive for this ticker, low = cheap.`;
    } else {
      ivEl.textContent = `IV ${(atmIv * 100).toFixed(0)}%`;
      ivEl.title = 'ATM IV of the loaded expiry';
    }
  } else if (ivEl) ivEl.textContent = '';

  const Tex = yearsToExp(state.selectedExp);
  // filter on a BS-computed delta: Tradier greeks can come back flat (1.000 across
  // every ITM strike), which makes any floor useless. Display still shows the API delta.
  const filterDelta = o => {
    const api = Math.abs(o.greeks?.delta || 0);
    const iv = o.greeks?.smv_vol || o.greeks?.mid_iv || 0;
    if (!(iv > 0) || !(Tex > 0) || !(price > 0) || !(o.strike > 0)) return api;
    const d1 = (Math.log(price / o.strike) + (RISK_FREE + iv * iv / 2) * Tex) / (iv * Math.sqrt(Tex));
    const nd1 = normCdf(d1);
    return o.option_type === 'call' ? nd1 : 1 - nd1;
  };
  const passesDelta = o => {
    if (!o) return false;
    if (!state.zoneFilter.otm && !state.zoneFilter.itm) return true; // no zones active → full chain
    const isCall = o.option_type === 'call';
    const itm = isCall ? o.strike < price : o.strike > price;
    const d = filterDelta(o);
    if (o.strike === atmAll && state.zoneFilter.itm) return true; // ATM belongs to the ITM view
    // ITM runs from ATM down to the depth limit: |Δ| ≤ the setting (deeper = All view)
    if (itm) return state.zoneFilter.itm && d <= itmCeil;
    return state.zoneFilter.otm && d >= otmFloor;
  };
  // Both view is a fixed window of strikes around ATM — no delta filtering there.
  // Zones only apply once a side is chosen.
  if (state.chainSide !== 'both') {
    for (const [strike, pair] of byStrike) {
      if (!passesDelta(pair.call)) delete pair.call;
      if (!passesDelta(pair.put)) delete pair.put;
      const wantCall = state.chainSide !== 'put', wantPut = state.chainSide !== 'call';
      if (!(wantCall && pair.call) && !(wantPut && pair.put)) byStrike.delete(strike);
    }
  }
  let strikes = [...byStrike.keys()].sort((a, b) => a - b);
  if (state.chainSide === 'both') {
    const n = Math.max(1, parseInt(document.getElementById('bothStrikes').value, 10) || 8);
    const ai = strikes.indexOf(atmAll);
    if (ai >= 0) strikes = strikes.slice(Math.max(0, ai - n), ai + n + 1);
  }

  // nearest strike to spot for ATM highlight
  let atmStrike = null, atmDist = Infinity;
  for (const s of strikes) {
    const d = Math.abs(s - price);
    if (d < atmDist) { atmDist = d; atmStrike = s; }
  }

  const tbody = document.getElementById('chainBody');
  // keep an expanded detail (inline row or rail ticket) open and recalculated across re-renders
  const openSym = document.querySelector('.detail-row')?.dataset.sym || state.railDetailSym;
  state.railDetailSym = null; // re-armed below if the contract is still on screen, else the ticket clears
  let reopened = false;
  tbody.innerHTML = '';

  const entryU = rawStop('entryPrice');
  strikes.forEach(strike => {
    const pair = byStrike.get(strike);
    const c = calcOpt(pair.call, price, callStop, putStop, risk, Tex, entryU);
    const p = calcOpt(pair.put, price, callStop, putStop, risk, Tex, entryU);
    const tr = document.createElement('tr');
    if (strike === atmStrike) tr.classList.add('atm-row');

    if (state.chainSide === 'both') {
      tr.innerHTML = sideCells(c, true) + `<td class="strike-col">${fmtStrikeM(strike)}</td>` + sideCells(p, false);
      // click left half → call detail, right half → put detail
      const tds = tr.querySelectorAll('td');
      tds.forEach((td, i) => {
        if (i < 6 && c) td.addEventListener('click', () => showDetail(tr, c, acct));
        if (i > 6 && p) td.addEventListener('click', () => showDetail(tr, p, acct));
      });
    } else {
      const one = state.chainSide === 'call' ? c : p;
      if (!one) return;
      const volStyle = one.vol > one.oi && one.vol > 0 ? 'color:var(--amber);font-weight:700' : 'color:var(--gold);font-weight:600';
      tr.innerHTML = `
        <td class="strike-col">${fmtStrikeM(strike)}${strike === atmAll ? '<span class="badge-itm" style="background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-bd);" title="ATM boundary strike — always shown in the ITM→ATM view, exempt from the Δ floor">ATM</span>' : one.itm ? '<span class="badge-itm">ITM</span>' : ''}</td>
        <td class="m-hide">${fmt$(one.opt.bid || 0)}</td>
        <td class="m-hide">${fmt$(one.opt.ask || 0)}</td>
        <td${one.wideSpread ? ` style="color:var(--amber)" title="wide spread: ${one.spreadPct.toFixed(0)}% of mid"` : ''}>${Number.isFinite(one.mid) ? fmt$M(one.mid) : '—'}</td>
        <td class="m-hide m-delta" style="color:var(--text2)">${Number.isFinite(one.delta) ? fmtN(one.delta, 3) : '—'}</td>
        <td class="m-hide" style="color:var(--text2)">${one.iv > 0 ? (one.iv * 100).toFixed(1) + '%' : '—'}</td>
        <td class="voloi" style="${volStyle}">${fmtKM(one.vol)}</td>
        <td class="voloi m-hide m-oi" style="${volStyle}">${fmtKM(one.oi)}</td>
        <td class="m-hide" style="color:var(--teal)">${one.allocation ? (one.shortPut ? 'Sell put' : 'Buy') : fmt$(one.atStop)}</td>
        <td class="m-size ${one.allocation ? '' : 'loss-cell ' + lossClass(one.lossOfCost)}">${one.allocation ? (one.allocation.error ? '—' : fmt$M(one.unitCost)) : one.lossPerContract > 0 ? fmt$M(one.lossPerContract) + `<div class="loss-pct ${lossClass(one.lossOfCost)}">${one.lossOfCost.toFixed(0)}%</div>` : '—'}</td>
        <td class="m-size" style="font-weight:600;color:var(--blue)">${one.contracts > 0 ? one.contracts : '—'}</td>
        <td class="m-size" style="color:var(--text2)">${one.contracts > 0 ? fmt$(one.totalCost) : '—'}</td>
      `;
      tr.addEventListener('click', () => { if (state.spreadPending) completeSpread(one); else showDetail(tr, one, acct); });
    }
    tbody.appendChild(tr);
    if (openSym) {
      const visible = x => x && (state.chainSide === 'both' || (state.chainSide === 'call') === x.isCall);
      const reopen = [c, p].find(x => visible(x) && x.opt.symbol === openSym);
      if (reopen) { showDetail(tr, reopen, acct); reopened = true; }
    }
  });
  if (!reopened) clearRailDetail();

  if (!strikes.length) {
    tbody.innerHTML = `<tr><td colspan="${chainColCount()}" style="text-align:center;color:var(--text3);padding:20px;">No contracts match filter</td></tr>`;
  }
  if (state.pendingAtmScroll) {
    state.pendingAtmScroll = false;
    const atmRow = tbody.querySelector('tr.atm-row');
    const panel = document.querySelector('.chain-scroll');
    // scroll the chain's own panel when it has one, so the chart above stays put; center ATM in the
    // part of the panel that's actually on screen (in the desktop shell it can start below the fold)
    if (atmRow && panel && panel.scrollHeight > panel.clientHeight + 1) {
      const box = panel.getBoundingClientRect();
      const pane = panel.closest('#mainPane')?.getBoundingClientRect() || { top: 0, bottom: window.innerHeight };
      const visTop = Math.max(box.top, pane.top, 0), visBottom = Math.min(box.bottom, pane.bottom, window.innerHeight);
      panel.scrollTop = atmRow.offsetTop - (visTop - box.top) - Math.max(80, visBottom - visTop) / 2;
    } else if (atmRow) atmRow.scrollIntoView({ block: 'center' });
  }
  if (state.chartBars.length) drawChart();
}

// [ and ] step through expirations
export function cycleExp(dir) {
  if (state.currentMode !== 'options' || !state.allExps.length || !state.selectedExp) return;
  const i = state.allExps.indexOf(state.selectedExp);
  const next = state.allExps[i + dir];
  if (next) selectExp(next);
}
