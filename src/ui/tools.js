import { state } from '../state.js';
import { hv20At } from '../core/bars.js';
import { dateStr, fmt$, fmtDayVol, fmtLev } from '../core/format.js';
import { LEV_ALIASES, LEV_ETFS, LEV_NAMES, LEV_REVERSE } from '../core/lev-etfs.js';
import { baseUrl, headers } from '../services/tradier.js';
import { showError } from './feedback.js';
import { fetchQuote } from './ticker.js';
import { setView } from './views.js';

export function renderGain() {
  const cost = parseFloat(document.getElementById('gainCost').value);
  const now = parseFloat(document.getElementById('gainNow').value);
  const el = document.getElementById('gainStats');
  if (!(cost > 0) || isNaN(now) || now < 0) {
    el.innerHTML = '<div class="hint" style="margin:0;grid-column:1/-1;">enter what you paid and what it trades at now</div>';
    return;
  }
  const pct = (now - cost) / cost * 100;
  const up = pct >= 0;
  const sign = up ? '+' : '−';
  el.innerHTML = `
    <div class="stat ${up ? 'good' : 'danger'}"><div class="s-label">${up ? 'Gain' : 'Loss'}</div><div class="s-val">${sign}${Math.abs(pct).toFixed(2)}%</div><div class="s-sub">${fmt$(cost)} → ${fmt$(now)}</div></div>
    <div class="stat"><div class="s-label">Change</div><div class="s-val">${sign}${fmt$(Math.abs(now - cost))}</div><div class="s-sub">per unit</div></div>
    <div class="stat teal"><div class="s-label">Multiple</div><div class="s-val">${(now / cost).toFixed(2)}×</div><div class="s-sub">of cost</div></div>
  `;
}

export function setLevDir(d) {
  state.levDir = d;
  document.getElementById('levDirBoth').classList.toggle('active', d === 'both');
  document.getElementById('levDirLong').classList.toggle('active', d === 'long');
  document.getElementById('levDirShort').classList.toggle('active', d === 'short');
  if (state.levLast) renderLevTable(state.levLast.under, state.levLast.rows, state.levLast.note, state.levLast.live);
  else if (document.getElementById('levSymbol').value.trim()) findLevEtfs();
}

export async function findLevEtfs() {
  const raw = document.getElementById('levSymbol').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const out = document.getElementById('levResults');
  if (!raw) { state.levLast = null; out.innerHTML = ''; return; }
  let under = LEV_ALIASES[raw] || raw;
  let note = '';
  if (!LEV_ETFS[under] && LEV_REVERSE[under]) {
    const r = LEV_REVERSE[under];
    note = `${under} is already leveraged: ${fmtLev(r.lev)} ${r.under} daily · showing the whole family`;
    under = r.under;
  }
  const fam = LEV_ETFS[under];
  if (!fam) {
    state.levLast = null;
    out.innerHTML = `<div class="hint" style="margin:0;">nothing tracked for ${raw} · coverage is the popular single-stock names plus major index, sector and commodity ETFs</div>`;
    return;
  }
  const rows = fam.map(([sym, lev]) => ({ sym, lev }));
  const key = document.getElementById('apiKey').value.trim();
  if (!key) { renderLevTable(under, rows, note, false); return; }
  document.getElementById('levBtnText').innerHTML = '<span class="spinner"></span>';
  try {
    const res = await fetch(`${baseUrl()}/markets/quotes?symbols=${rows.map(r => r.sym).join(',')}`, { headers: headers() });
    const json = await res.json();
    let qs = json?.quotes?.quote || [];
    if (!Array.isArray(qs)) qs = [qs];
    const bySym = {};
    for (const q of qs) bySym[q.symbol] = q;
    for (const r of rows) {
      const q = bySym[r.sym];
      if (!q || !(q.last > 0)) continue; // delisted or renamed since the map was written — sinks to the bottom
      r.last = q.last;
      const vol = q.average_volume > 0 ? q.average_volume : q.volume;
      r.dayVol = vol > 0 ? vol * q.last : 0;
      if (q.bid > 0 && q.ask > 0 && q.ask >= q.bid) r.spread = (q.ask - q.bid) / ((q.ask + q.bid) / 2) * 100;
    }
    rows.sort((a, b) => (b.dayVol || 0) - (a.dayVol || 0));
    renderLevTable(under, rows, note, true);
  } catch (e) {
    showError('Leveraged ETF lookup failed: ' + e.message);
    renderLevTable(under, rows, note, false);
  } finally {
    document.getElementById('levBtnText').textContent = 'Find';
  }
}

export function renderLevTable(under, rows, note, live) {
  state.levLast = { under, rows, note, live };
  const out = document.getElementById('levResults');
  const name = LEV_NAMES[under];
  const shown = state.levDir === 'both' ? rows : rows.filter(r => state.levDir === 'long' ? r.lev > 0 : r.lev < 0);
  if (!shown.length) {
    out.innerHTML = `<div class="hint" style="margin:0;">no ${state.levDir} leveraged ETF tracked for ${under}</div>`;
    return;
  }
  const bestLong = live ? shown.find(r => r.lev > 0 && r.dayVol > 0) : null;
  const bestShort = live ? shown.find(r => r.lev < 0 && r.dayVol > 0) : null;
  const badge = r => r === bestLong
    ? '<span class="lev-badge" style="background:var(--green-bg);color:var(--green);">best long</span>'
    : r === bestShort
    ? '<span class="lev-badge" style="background:var(--red-bg);color:var(--red);">best short</span>' : '';
  const body = shown.map(r => `
    <tr data-action="levLoad" data-arg="${r.sym}" title="load ${r.sym} in the calculator">
      <td><b>${r.sym}</b>${badge(r)}</td>
      <td style="color:${r.lev > 0 ? 'var(--green)' : 'var(--red)'};font-weight:600;">${fmtLev(r.lev)}</td>
      <td>${r.last ? fmt$(r.last) : '—'}</td>
      <td${r.spread > 0.25 ? ' style="color:var(--amber);font-weight:600;"' : ''}>${r.spread != null ? r.spread.toFixed(2) + '%' : '—'}</td>
      <td>${live ? fmtDayVol(r.dayVol) : '—'}</td>
    </tr>`).join('');
  out.innerHTML = `
    ${note ? `<div class="hint" style="margin:0 0 8px;">${note}</div>` : ''}
    <div style="font-size:12px;color:var(--text2);margin-bottom:6px;">leveraged plays on <b style="color:var(--text);">${under}</b>${name ? ' · ' + name : ''} · daily reset, they decay on chop</div>
    <table>
      <thead><tr><th style="width:30%;">ETF</th><th>Lev</th><th>Price</th><th>Spread</th><th>$ / day</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${live ? '' : '<div class="hint" style="margin-top:8px;">add a Tradier key on the Size side to rank these by live volume and spread</div>'}
  `;
}

export function levLoad(sym) {
  document.getElementById('ticker').value = sym;
  setView('calc');
  if (document.getElementById('apiKey').value.trim()) fetchQuote();
  else document.getElementById('ticker').focus();
}

// ---- Lev ETF price target ----
// one daily reset is exact: lev × underlying move. Past that, GBM drag off the underlying's HV20:
// expected = etfNow × gross^lev × exp((lev − lev²)/2 · σ² · days/252)

export async function levTarget() {
  const out = document.getElementById('levTgtResults');
  const sym = document.getElementById('levTgtSymbol').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!sym) { out.innerHTML = ''; return; }
  const r = LEV_REVERSE[sym];
  if (!r) {
    const fam = LEV_ETFS[LEV_ALIASES[sym] || sym];
    out.innerHTML = fam
      ? `<div class="hint" style="margin:0;">${sym} is the underlying · pick one of its leveraged ETFs: ${fam.map(x => x[0]).join(', ')}</div>`
      : `<div class="hint" style="margin:0;">nothing tracked for ${sym} · type a leveraged ETF from the finder above (NVDL, TQQQ, SOXL, TSLL...)</div>`;
    return;
  }
  const target = parseFloat(document.getElementById('levTgtPrice').value);
  if (!(target > 0)) { out.innerHTML = `<div class="hint" style="margin:0;">enter a target price for ${r.under}</div>`; return; }
  if (!document.getElementById('apiKey').value.trim()) {
    out.innerHTML = '<div class="hint" style="margin:0;">needs a Tradier key · add one in the API card on the Size side</div>';
    return;
  }
  const days = Math.max(1, Math.round(parseFloat(document.getElementById('levTgtDays').value) || 1));
  document.getElementById('levTgtBtnText').innerHTML = '<span class="spinner"></span>';
  try {
    const res = await fetch(`${baseUrl()}/markets/quotes?symbols=${sym},${r.under}`, { headers: headers() });
    let qs = (await res.json())?.quotes?.quote || [];
    if (!Array.isArray(qs)) qs = [qs];
    const etfNow = qs.find(q => q.symbol === sym)?.last;
    const underNow = qs.find(q => q.symbol === r.under)?.last;
    if (!(etfNow > 0) || !(underNow > 0)) { showError(`No quote for ${sym} / ${r.under}.`); return; }
    const gross = target / underNow;
    let expected, noDrag = 0, hvNote = '';
    if (days <= 1) {
      expected = Math.max(0, etfNow * (1 + r.lev * (gross - 1)));
    } else {
      noDrag = etfNow * Math.pow(gross, r.lev);
      let hv = 0;
      try {
        const from = new Date(); from.setDate(from.getDate() - 60);
        const hres = await fetch(`${baseUrl()}/markets/history?symbol=${r.under}&interval=daily&start=${dateStr(from)}&end=${dateStr(new Date())}`, { headers: headers() });
        let hdays = (await hres.json())?.history?.day || [];
        if (!Array.isArray(hdays)) hdays = [hdays];
        const closes = hdays.map(d => d.close).filter(c => c > 0);
        if (closes.length >= 21) hv = hv20At(closes, closes.length - 1);
      } catch (e) {}
      expected = Math.max(0, noDrag * Math.exp((r.lev - r.lev * r.lev) / 2 * hv * hv * days / 252));
      hvNote = hv > 0 ? `HV20 ${(hv * 100).toFixed(0)}% · ${days} days` : 'no history · drag skipped';
    }
    renderLevTarget(sym, r, etfNow, underNow, target, days, expected, noDrag, hvNote);
  } catch (e) {
    showError('Target estimate failed: ' + e.message);
  } finally {
    document.getElementById('levTgtBtnText').textContent = 'Estimate';
  }
}

export function renderLevTarget(sym, r, etfNow, underNow, target, days, expected, noDrag, hvNote) {
  const uPct = (target / underNow - 1) * 100;
  const ePct = (expected / etfNow - 1) * 100;
  const up = ePct >= 0;
  const sign = p => (p >= 0 ? '+' : '−') + Math.abs(p).toFixed(1) + '%';
  const drag = days > 1 && noDrag > 0 ? Math.max(0, noDrag - expected) : 0;
  document.getElementById('levTgtResults').innerHTML = `
    <div class="stat-grid">
      <div class="stat ${up ? 'good' : 'danger'}"><div class="s-label">${sym} at target</div><div class="s-val">${fmt$(expected)}</div><div class="s-sub">${fmt$(etfNow)} → ${fmt$(expected)}</div></div>
      <div class="stat"><div class="s-label">${sym} move</div><div class="s-val">${sign(ePct)}</div><div class="s-sub">${sym} is ${fmtLev(r.lev)} ${r.under}</div></div>
      <div class="stat"><div class="s-label">${r.under} move</div><div class="s-val">${sign(uPct)}</div><div class="s-sub">${fmt$(underNow)} → ${fmt$(target)}</div></div>
      ${days > 1 ? `<div class="stat"><div class="s-label">Decay cost</div><div class="s-val">−${fmt$(drag)}</div><div class="s-sub">${noDrag > 0 ? '−' + (drag / noDrag * 100).toFixed(1) + '% · ' : ''}${hvNote}</div></div>` : ''}
    </div>`;
}
