// Sharing Positions (the Share button in its head; one tap): a table card image of every position, copied. No share counts and
// no dollars but prices, like the other share cards: each position's size and risk as a percent of the account, its cost, price,
// P/L %, R and stop, a spread as one row.
import { atBreakeven, fmtPositionPrice, spreadR } from '../core/positions.js';
import { inZone, zoneAbbr } from '../lib/zone.js';
import { state } from '../state.js';
import { effects } from './effects.js';
import { showError } from './feedback.js';
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

/** the card: a row per position (a spread once), the totals under them; nothing that gives away a share count or a dollar */
export function positionsShareSpec(p, now = Date.now()) {
  const items = tableRows(p);
  const when = `${inZone(now, { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(',', '')} ${zoneAbbr()}`;
  return {
    title: [{ t: 'Positions  ' }, { t: `${items.length} open`, c: SC.text2 }],
    sub: `${when} · size and risk as a percent of the account`,
    cols: [{ label: 'Position' }, { label: 'Side' }, { label: 'Size', right: true }, { label: 'Cost', right: true }, { label: 'Price', right: true },
      { label: 'P/L', right: true }, { label: 'R', right: true }, { label: 'Stop', right: true }, { label: 'Risk', right: true }],
    rows: items.map(i => i.spread ? spreadCells(i.spread) : rowCells(i.row)),
    total: [{ t: 'Total', b: true }, null, { t: `${p.totalPct.toFixed(1)}%`, b: true }, null, null,
      p.pnlPct === null ? DASH : { t: signedPct(p.pnlPct), c: tone(p.pnlPct), b: true }, null, null, p.risk > 0 ? riskCell(p.riskPct) : DASH],
    footer: 'P/L % from cost · R: open P/L over 1R · Risk: the loss at the stops',
  };
}

/** Share: the card image, copied (or downloaded where the clipboard can't take it). Returns the drawn card (tests read it). */
export function sharePositions() {
  const p = state.positions;
  if (!p || !p.rows.length) { showError('No positions to share.'); return null; }
  const card = effects.drawTableCard(positionsShareSpec(p));
  effects.shareCanvasToClipboard(card, `positions-${new Date().toISOString().slice(0, 10)}`);
  return card;
}
