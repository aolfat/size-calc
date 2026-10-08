// Share cards: hand-drawn PNG of a plan or position, copied to the clipboard (download fallback).
import { state } from '../state.js';
import { effectivePrice } from '../core/extended-hours.js';
import { fmt$, fmtN } from '../core/format.js';
import { isBull, sizeUnit, spreadWidth, strikesLabel, typeLabel } from '../core/options.js';
import { calcAllocation, unitsFor } from '../core/sizing.js';
import { SANS_FONT } from '../lib/media.js';
import { allocationForCard, allocationInputs, shareAllocation } from './allocation.js';
import { showError, showToast } from './feedback.js';
import { riskDollars } from './risk.js';
import { entryVal, rawStop, stopLongVal, stopShortVal, stopSourceName } from './stops.js';
import { effects } from './effects.js';

export const SC = { bg: '#0b0d12', card1: '#161c28', card2: '#0e1118', border: '#323a4a', text: '#e9ecf2', text2: '#97a0b3', text3: '#5b6478', green: '#2fd67b', red: '#ff5d5d', blue: '#5b9dff', teal: '#2dd4bf' };

export function drawShareCard(spec) {
  const rows = [];
  for (let i = 0; i < spec.stats.length; i += 4) rows.push(spec.stats.slice(i, i + 4));

  // measure-and-fit: columns take the width their content needs; the canvas grows
  // to hold them, and the value font steps down uniformly if it would get too wide
  const meas = document.createElement('canvas').getContext('2d');
  const PAD = 40, GAP = 36;
  let valueFont = 29, W = 0, rowCols = [];
  for (valueFont = 29; valueFont >= 20; valueFont--) {
    rowCols = rows.map(row => row.map(s => {
      meas.font = `700 ${valueFont}px ${SANS_FONT}`;
      const v = meas.measureText(s.value).width;
      meas.font = `500 13px ${SANS_FONT}`;
      const sb = s.sub ? meas.measureText(s.sub).width : 0;
      meas.font = `600 12px ${SANS_FONT}`;
      const lb = meas.measureText(s.label.toUpperCase()).width;
      return Math.max(v, sb, lb, 104);
    }));
    meas.font = `700 30px ${SANS_FONT}`;
    const titleW = spec.title.reduce((a, p) => a + meas.measureText(p.t).width, 0);
    meas.font = `500 14px ${SANS_FONT}`;
    const subW = meas.measureText(spec.sub).width;
    meas.font = `500 13px ${SANS_FONT}`;
    const footW = spec.footer ? meas.measureText(spec.footer).width + 220 : 0; // leave room for the wordmark
    W = Math.max(720, titleW + PAD * 2, subW + PAD * 2, footW + PAD * 2,
      ...rowCols.map(ws => PAD * 2 + ws.reduce((a, b) => a + b, 0) + GAP * (ws.length - 1)));
    if (W <= 900) break;
  }

  const H = 132 + rows.length * 116 + 24;
  const scale = 2;
  const c = document.createElement('canvas');
  c.width = W * scale; c.height = H * scale;
  const x = c.getContext('2d');
  x.scale(scale, scale);
  x.fillStyle = SC.bg; x.fillRect(0, 0, W, H);
  const rr = (px, py, pw, ph, r) => {
    x.beginPath();
    x.moveTo(px + r, py);
    x.arcTo(px + pw, py, px + pw, py + ph, r);
    x.arcTo(px + pw, py + ph, px, py + ph, r);
    x.arcTo(px, py + ph, px, py, r);
    x.arcTo(px, py, px + pw, py, r);
    x.closePath();
  };
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, SC.card1); g.addColorStop(1, SC.card2);
  rr(14, 14, W - 28, H - 28, 16);
  x.fillStyle = g; x.fill();
  x.strokeStyle = SC.border; x.lineWidth = 1.5; x.stroke();

  let tx = 40;
  x.font = `700 30px ${SANS_FONT}`;
  spec.title.forEach(part => {
    x.fillStyle = part.c || SC.text;
    x.fillText(part.t, tx, 66);
    tx += x.measureText(part.t).width;
  });
  x.font = `500 14px ${SANS_FONT}`;
  x.fillStyle = SC.text2;
  x.fillText(spec.sub, 40, 96);

  rows.forEach((row, ri) => {
    const widths = rowCols[ri];
    // spread the leftover space between measured columns
    const slack = Math.max(0, (W - PAD * 2 - widths.reduce((a, b) => a + b, 0) - GAP * (widths.length - 1)) / Math.max(1, widths.length - 1));
    const top = 134 + ri * 116;
    let sx = PAD;
    row.forEach((s, ci) => {
      x.font = `600 12px ${SANS_FONT}`;
      x.fillStyle = SC.text3;
      x.fillText(s.label.toUpperCase(), sx, top + 14);
      x.font = `700 ${valueFont}px ${SANS_FONT}`;
      x.fillStyle = s.color || SC.text;
      x.fillText(s.value, sx, top + 50);
      if (s.sub) {
        x.font = `500 13px ${SANS_FONT}`;
        x.fillStyle = SC.text2;
        x.fillText(s.sub, sx, top + 74);
      }
      sx += widths[ci] + GAP + slack;
    });
  });

  if (spec.footer) {
    x.font = `500 13px ${SANS_FONT}`;
    x.fillStyle = SC.text2;
    x.fillText(spec.footer, PAD, H - 30);
  }
  x.font = `700 12px ${SANS_FONT}`;
  x.textAlign = 'right';
  x.fillStyle = SC.text3;
  x.fillText('SIZE / CALCULATOR', W - 40, H - 30);
  x.fillStyle = SC.green;
  x.fillText('●', W - 40 - x.measureText('SIZE / CALCULATOR').width - 8, H - 30);
  x.textAlign = 'left';
  return c;
}

export function shareCanvasToClipboard(canvas, name) {
  const blobP = new Promise(res => canvas.toBlob(res, 'image/png'));
  const fallback = () => {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = name + '.png';
    a.click();
    showToast('Clipboard unavailable — downloaded the image instead.');
  };
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) return fallback();
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blobP })])
      .then(() => showToast('Card image copied to clipboard.'))
      .catch(fallback);
  } catch(e) { fallback(); }
}

export function shareShares() {
  const q = state.quoteData;
  if (!q) { showError('Load a ticker first.'); return; }
  if (state.sizingMode === 'allocation') {
    const r = calcAllocation({ ...allocationInputs(q.symbol), unitCost: entryVal() });
    if (r.error) return;
    effects.shareCanvasToClipboard(effects.drawShareCard({ title: [{ t: q.symbol + ' LONG SHARES' }], sub: 'Allocation plan · before fees',
      stats: [{ label: 'Shares', value: String(r.units) }, { label: 'Entry', value: fmt$(entryVal()) },
        { label: 'New commitment', value: fmt$(r.commitment) }, { label: 'Total allocation', value: r.actualPct.toFixed(2) + '%' }] }), q.symbol + '-allocation');
    return;
  }
  const price = effectivePrice(q);
  const isLong = state.direction === 'long';
  const entry = entryVal();
  const stop = isLong ? stopLongVal() : stopShortVal();
  const rps = isLong ? entry - stop : stop - entry;
  if (!(rps > 0) || !Number.isFinite(stop)) { showError('Stop is on the wrong side of entry — nothing to share.'); return; }
  const risk = riskDollars();
  const acct = parseFloat(document.getElementById('accountSize').value) || 1;
  const shares = unitsFor(risk, rps);
  const chg = q.change_percentage || 0;
  effects.shareCanvasToClipboard(effects.drawShareCard({
    title: [{ t: q.symbol + '  ' }, { t: fmt$(price) }, { t: `  ${chg >= 0 ? '+' : ''}${fmtN(chg, 2)}%`, c: chg >= 0 ? SC.green : SC.red }],
    sub: `${isLong ? 'LONG' : 'SHORT'} · risk ${(risk / acct * 100).toFixed(2)}% of account · ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
    stats: [
      { label: isLong ? 'Entry — long' : 'Entry — short', value: fmt$(entry), color: SC.blue, sub: rawStop('entryPrice') > 0 ? 'planned entry' : 'current price' },
      { label: 'Stop', value: fmt$(stop), color: SC.red, sub: `${(entry > 0 ? rps / entry * 100 : 0).toFixed(1)}% away · ${stopSourceName(isLong)}` },
      { label: 'Max loss', value: (shares * rps / acct * 100).toFixed(2) + '%', color: SC.red, sub: 'of account' },
      { label: 'Position', value: (shares * entry / acct * 100).toFixed(1) + '%', sub: 'of account' }
    ],
    footer: (() => {
      const s10 = unitsFor(10000 * (risk / acct), rps);
      return `on a $10k account: ${s10.toLocaleString()} shares · ${fmt$(s10 * rps)} max loss`;
    })()
  }), q.symbol + '-plan');
}

export function sharePinned(cardId) {
  const d = state.pinnedData[cardId];
  if (!d) return;
  if (d.sizing === 'allocation') {
    const r = allocationForCard(d); if (r.error) return; const qty = r.units; const entry = d.mid;
    shareAllocation(d, qty, entry, r); return;
  }
  const cts = unitsFor(riskDollars(), sizeUnit(d));
  const acct = parseFloat(document.getElementById('accountSize').value) || 1;
  effects.shareCanvasToClipboard(effects.drawShareCard({
    title: [{ t: `${d.parsed.ticker} ${strikesLabel(d)} ` }, { t: typeLabel(d).toUpperCase(), c: isBull(d) ? SC.green : SC.red }, { t: ` ${d.parsed.expStr}` }],
    sub: `underlying ${fmt$(d.underlyingPrice)} · stop ${d.stopName} ${fmt$(d.stopLevel)} (${d.lodPct}%) · as of ${d.asOf || ''} · ${new Date().toLocaleDateString()}`,
    stats: [
      { label: d.kind === 'spread' ? (d.credit ? 'Credit / spread' : 'Debit / spread') : 'Entry / ct', value: fmt$(d.mid), color: SC.blue, sub: d.credit && spreadWidth(d) > 0 ? `${(d.mid / spreadWidth(d) * 100).toFixed(0)}% of width · bid ${fmt$(d.bid)} / ask ${fmt$(d.ask)}` : `bid ${fmt$(d.bid)} / ask ${fmt$(d.ask)}` },
      { label: 'Stop — underlying', value: fmt$(d.stopLevel), color: SC.red, sub: `${d.lodPct}% away · ${d.stopName}` },
      { label: 'Loss @ stop', value: d.lossOfCost.toFixed(0) + '%', color: SC.red, sub: d.kind === 'spread' ? (d.credit ? 'of max loss' : 'of debit') : 'of premium' },
      { label: 'Max loss', value: cts > 0 ? (cts * sizeUnit(d) / acct * 100).toFixed(2) + '%' : '—', color: SC.red, sub: cts > 0 ? (d.kind === 'spread' ? (d.credit ? 'of account · width − credit' : 'of account · full debit') : 'of account') : '' }
    ],
    footer: (() => {
      const unit = sizeUnit(d);
      if (!(unit > 0)) return '';
      const word = d.kind === 'spread' ? 'spread' : 'contract';
      const c10 = unitsFor(10000 * (riskDollars() / acct), unit);
      return c10 >= 1
        ? `on a $10k account: ${c10} ${word}${c10 === 1 ? '' : 's'} · ${fmt$(c10 * unit)} max loss`
        : `on a $10k account: even 1 ${word} risks ${fmt$(unit)} (${(unit / 10000 * 100).toFixed(2)}% of it)`;
    })()
  }), `${d.parsed.ticker}-${d.parsed.strike}${d.isCall ? 'c' : 'p'}`);
}

export function shareSaved(id) {
  const d = state.savedData[id];
  if (!d) return;
  if (d.sizing === 'allocation') {
    const r = null; const qty = d.qty; const entry = d.entry;
    shareAllocation(d, qty, entry, r); return;
  }
  const qty = d.qty || 0;
  const sgn = d.credit ? -1 : 1;
  const pnl = sgn * (d.mid - d.entry) * 100 * qty;
  const lossAtStop = sgn * (d.entry - d.atLod) * 100 * qty;
  const acct = parseFloat(document.getElementById('accountSize').value) || 1;
  effects.shareCanvasToClipboard(effects.drawShareCard({
    title: [{ t: `${d.parsed.ticker} ${strikesLabel(d)} ` }, { t: typeLabel(d).toUpperCase(), c: isBull(d) ? SC.green : SC.red }, { t: ` ${d.parsed.expStr}` }],
    sub: `POSITION · underlying ${fmt$(d.underlyingPrice)} · stop ${d.stopName} ${fmt$(d.stopLevel)} (${d.lodPct}%) · as of ${d.asOf || ''} · ${new Date().toLocaleDateString()}`,
    stats: [
      { label: d.kind === 'spread' ? (d.credit ? 'Credit / spread' : 'Debit / spread') : 'Entry / ct', value: fmt$(d.entry), color: SC.blue, sub: 'your fill' },
      { label: 'Stop — underlying', value: fmt$(d.stopLevel), color: SC.red, sub: `${d.lodPct}% away · ${d.stopName}` },
      { label: 'P&L now', value: `${pnl >= 0 ? '+' : '−'}${(d.entry > 0 ? Math.abs(pnl) / (d.entry * 100 * qty) * 100 : 0).toFixed(1)}%`, color: pnl >= 0 ? SC.green : SC.red, sub: `mid ${fmt$(d.mid)}` },
      { label: lossAtStop > 0 ? 'Loss @ stop' : 'Locked @ stop', value: `${lossAtStop > 0 ? '−' : '+'}${(d.entry > 0 ? Math.abs(lossAtStop) / (d.entry * 100 * qty) * 100 : 0).toFixed(0)}%`, color: lossAtStop > 0 ? SC.red : SC.green, sub: `of cost · ${(Math.abs(lossAtStop) / acct * 100).toFixed(2)}% of acct` }
    ]
  }), `${d.parsed.ticker}-position`);
}
