import { state } from '../state.js';
import { extSession } from '../core/extended-hours.js';
import { fmt$, fmtN } from '../core/format.js';
import { adrUsage } from './daily.js';
import { riskDollars } from './risk.js';

// ---------- sticky context bar ----------

export function renderStickyBar() {
  const q = state.quoteData;
  if (!q) return;
  const price = q.last || q.ask || 0;
  const chg = q.change_percentage || 0;
  const u = adrUsage();
  const adrTxt = !u ? '' : u.ctx === 'both'
    ? `ADR L ${u.usedLod.toFixed(0)}% · H ${u.usedHod.toFixed(0)}%`
    : `ADR ${(u.ctx === 'long' ? u.usedLod : u.usedHod).toFixed(0)}% used`;
  const ext = extSession(q);
  // the answer rides along while you scroll the chart: the shares count from the card
  const qtyEl = state.currentMode === 'shares' ? document.getElementById('sharesQty') : null;
  const sharesQty = qtyEl && +qtyEl.value > 0 ? Number(qtyEl.value).toLocaleString() : '';
  document.getElementById('stickyBar').innerHTML =
    `<span class="sb-sym">${q.symbol}</span>` +
    `<span class="sb-px" style="color:${chg >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt$(price)} ${chg >= 0 ? '+' : ''}${fmtN(chg, 2)}%</span>` +
    (sharesQty ? `<span class="sb-qty" title="Shares to ${state.direction === 'long' ? 'buy' : 'short'}">${sharesQty} sh</span>` : '') +
    (ext ? `<span style="color:var(--text3)">${ext.label} <span style="color:${ext.chg >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtN(ext.price, 2)} ${ext.chg >= 0 ? '+' : ''}${fmtN(ext.chgPct, 1)}%</span></span>` : '') +
    `<span style="color:var(--red)">▼ ${fmtN(q.low || 0, 2)}</span>` +
    `<span style="color:var(--green)">▲ ${fmtN(q.high || 0, 2)}</span>` +
    (adrTxt ? `<span style="color:var(--text2)">${adrTxt}</span>` : '') +
    `<span style="color:var(--blue);margin-left:auto;">${state.sizingMode === 'allocation' ? document.getElementById('allocationPct').value + '% allocation' : 'risk ' + fmt$(riskDollars())}</span>` +
    `<span class="sb-live sb-jump" title="Jump to the charts" data-action="jumpTo" data-arg="chartWrap">chart</span>` +
    (state.currentMode === 'options' ? `<span class="sb-live sb-jump" title="Jump to the option chain" data-action="jumpTo" data-arg="optionsSection">chain</span>` : '') +
    `<span id="sbLive" class="sb-live" title="Live: tap to start, tap again to extend (1m→5m→30m→stop)" data-action="toggleLive"></span>`;
  syncSbLive();
}

export function jumpTo(id) {
  const el = document.getElementById(id);
  if (!el || el.style.display === 'none') return;
  const barH = document.getElementById('stickyBar').offsetHeight || 0;
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - barH - 8, behavior: 'smooth' });
}

// the sticky bar's live chip mirrors the main button so live is reachable from anywhere

export function syncSbLive() {
  const el = document.getElementById('sbLive');
  if (!el) return;
  if (state.liveInterval) {
    const remain = Math.max(0, Math.ceil((state.liveEnd - Date.now()) / 1000));
    const mmss = remain >= 60 ? `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, '0')}` : `${remain}s`;
    el.className = 'sb-live on';
    el.innerHTML = `<span class="pulse"></span>${mmss}`;
  } else if (state.livePausedRemaining > 0) {
    el.className = 'sb-live on';
    el.textContent = '⏸ live';
  } else {
    el.className = 'sb-live';
    el.textContent = '⚡ live';
  }
}

export function updateStickyBar() {
  const bar = document.getElementById('stickyBar');
  const qs = document.getElementById('quoteSection');
  // #quoteSection is display:contents (no box of its own), so measure the quote card inside it
  const show = !!state.quoteData && qs.style.display !== 'none' && window.scrollY > document.getElementById('quoteCard').offsetTop + 60;
  bar.style.display = show ? 'flex' : 'none';
  if (show) renderStickyBar();
  // chain header sticks just below the bar on mobile
  document.documentElement.style.setProperty('--sbh', show ? bar.offsetHeight + 'px' : '0px');
}
