// Sharing Positions (the share button in its head): a sheet to pick the positions (all ticked to start), then a table card image of
// them, copied. No share counts and no dollars but prices, like the other share cards: each position's size and risk as a percent
// of the account, its cost, price, P/L %, R and stop, a spread as one row, and the totals of the ones picked.
import { marketEscape as esc } from '../core/format.js';
import { atBreakeven, fmtPositionPrice, pickedTotals, spreadR } from '../core/positions.js';
import { inZone, zoneAbbr } from '../lib/zone.js';
import { state } from '../state.js';
import { effects } from './effects.js';
import { showError } from './feedback.js';
import { SHARE_ICON } from './share-button.js';
import { openSheet } from './sheets.js';
import { cardR, sideOf, tableRows } from './positions.js';
import { SC } from './share-image.js';

const signedPct = (v, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`;
const tone = v => v === null || Math.abs(v) < 0.005 ? SC.text : v > 0 ? SC.green : SC.red;
const SIDE_COLOR = { long: SC.green, short: SC.red, neutral: SC.text2 };
const DASH = { t: '—', c: SC.text3 };

/** the side cell: 'Long', 'Short QQQ' (a leveraged or inverse fund names what it bets on) */
function sideCell(legs, under) {
  const { side, fund } = sideOf(legs, under);
  return { t: `${side.charAt(0).toUpperCase() + side.slice(1)}${fund ? ` ${fund.under}` : ''}`, c: SIDE_COLOR[side] };
}

/** risk at the stops as a percent of the account: a loss in red, a lock-in in green */
function riskCell(pct) {
  if (pct === null || pct === undefined) return DASH;
  if (Math.abs(pct) < 0.005) return { t: '0%', c: SC.green };
  return pct > 0 ? { t: `−${pct.toFixed(2)}%`, c: SC.red } : { t: `+${(-pct).toFixed(2)}%`, c: SC.green };
}

function rowCells(r) {
  const px = v => fmtPositionPrice(v, r.tradeAs);
  const R = r.pnl === null ? null : cardR(r);
  return [
    { t: r.label, b: true }, sideCell([r], r.under), { t: `${r.pctAcct.toFixed(1)}%` },
    r.avg > 0 ? { t: px(r.avg), c: SC.text2 } : DASH, { t: px(r.price) },
    r.pnlPct === null ? DASH : { t: signedPct(r.pnlPct), c: tone(r.pnlPct), b: true },
    R === null ? DASH : { t: `${R >= 0 ? '+' : '−'}${Math.abs(R).toFixed(2)}R`, c: tone(R) },
    r.stop === null ? DASH : { t: px(r.stop) + (r.stops > 1 ? ` +${r.stops - 1}` : ''), c: atBreakeven(r) ? SC.green : SC.amber },
    riskCell(r.riskPct),
  ];
}

function spreadCells(s) {
  const { r } = spreadR(s);
  return [
    { t: s.label, b: true }, sideCell(s.legs, s.under), { t: `${s.pctAcct.toFixed(1)}%` },
    s.avg > 0 ? { t: fmtPositionPrice(s.avg, 'OPTION'), c: SC.text2 } : DASH, { t: fmtPositionPrice(s.price, 'OPTION') },
    s.pnlPct === null ? DASH : { t: signedPct(s.pnlPct), c: tone(s.pnlPct), b: true },
    r === null ? DASH : { t: `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R`, c: tone(r) },
    DASH, // a spread's risk is its max loss, not a stop
    s.maxLossPct === null ? DASH : riskCell(s.maxLossPct),
  ];
}

/** a row's or a spread's key: what the sheet's ticks name */
const keyOf = i => i.spread ? i.spread.key : i.row.symbol;

/** the positions the card shows: every one but those unticked in the sheet */
export const pickedPositions = p => tableRows(p).filter(i => !state.posShareOff.includes(keyOf(i)));

/** the card: a row per position picked (a spread once), their totals under them; nothing that gives away a share count or a dollar */
export function positionsShareSpec(p, now = Date.now(), items = tableRows(p)) {
  const t = pickedTotals(items, p.value);
  const when = `${inZone(now, { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(',', '')} ${zoneAbbr()}`;
  return {
    title: [{ t: 'Positions  ' }, { t: `${items.length} open`, c: SC.text2 }],
    sub: `${when} · size and risk as a percent of the account`,
    cols: [{ label: 'Position' }, { label: 'Side' }, { label: 'Size', right: true }, { label: 'Cost', right: true }, { label: 'Price', right: true },
      { label: 'P/L', right: true }, { label: 'R', right: true }, { label: 'Stop', right: true }, { label: 'Risk', right: true }],
    rows: items.map(i => i.spread ? spreadCells(i.spread) : rowCells(i.row)),
    total: [{ t: 'Total', b: true }, null, { t: `${t.totalPct.toFixed(1)}%`, b: true }, null, null,
      t.pnlPct === null ? DASH : { t: signedPct(t.pnlPct), c: tone(t.pnlPct), b: true }, null, null, t.riskPct > 0 ? riskCell(t.riskPct) : DASH],
    footer: 'P/L % from cost · R: open P/L over 1R · Risk: the loss at the stops',
  };
}

/** the share sheet: a tick per position (its side and size beside it), All and None, and the button that copies the card */
export function renderPosShare() {
  const body = document.getElementById('posShareBody');
  const p = state.positions;
  const items = p ? tableRows(p) : [];
  if (!items.length) { body.innerHTML = '<p class="hint">No positions to share.</p>'; return; }
  const n = pickedPositions(p).length;
  const row = i => {
    const key = keyOf(i), x = i.spread || i.row, on = !state.posShareOff.includes(key);
    const side = sideCell(i.spread ? i.spread.legs : [i.row], x.under);
    return `<label class="ps-row"><input type="checkbox" data-change="togglePosShare" data-arg="${esc(key)}"${on ? ' checked' : ''} />`
      + `<b>${esc(x.label)}</b><span class="ps-meta">${esc(side.t)} · ${x.pctAcct.toFixed(1)}%</span></label>`;
  };
  body.innerHTML = `<div class="ps-body">
    <div class="ps-quick"><span>${n} of ${items.length} picked</span><button class="pos-link" data-action="pickAllPosShare" data-arg="all">All</button><button class="pos-link" data-action="pickAllPosShare" data-arg="none">None</button></div>
    <div class="ps-list">${items.map(row).join('')}</div>
    <button class="btn primary ps-go" data-action="sharePositions"${n ? '' : ' disabled'}>${SHARE_ICON}Share ${n === items.length ? `all ${n}` : n} position${n === 1 ? '' : 's'}</button>
    <p class="hint">Copies a card image: each position's size and risk as a percent of the account, cost, price, P/L %, R and stop, and the totals of the ones picked. No share counts and no dollars.</p>
  </div>`;
}

/** the share button in Positions' head: the sheet, every position ticked unless you left it off this visit */
export function openPosShare() {
  const p = state.positions;
  if (!p || !p.rows.length) { showError('No positions to share.'); return; }
  renderPosShare();
  openSheet('posShare');
}

/** a tick in the sheet: that position on or off the card */
export function togglePosShare(key) {
  state.posShareOff = state.posShareOff.includes(key) ? state.posShareOff.filter(k => k !== key) : [...state.posShareOff, key];
  renderPosShare();
}

/** All ('all') or None ('none') */
export function pickAllPosShare(which) {
  state.posShareOff = which !== 'none' || !state.positions ? [] : tableRows(state.positions).map(keyOf);
  renderPosShare();
}

/** Share: the card image of the positions picked, copied (or downloaded where the clipboard can't take it). Returns the drawn card (tests read it). */
export function sharePositions() {
  const p = state.positions;
  if (!p || !p.rows.length) { showError('No positions to share.'); return null; }
  const items = pickedPositions(p);
  if (!items.length) { showError('Pick a position to share.'); return null; }
  const card = effects.drawTableCard(positionsShareSpec(p, Date.now(), items));
  effects.shareCanvasToClipboard(card, `positions-${new Date().toISOString().slice(0, 10)}`);
  return card;
}
