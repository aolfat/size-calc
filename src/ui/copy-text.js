// Copy as text: one-liners for the live chat.
import { state } from '../state.js';
import { expChat, fmt$, fmtN } from '../core/format.js';
import { sizeUnit } from '../core/options.js';
import { calcAllocation, unitsFor } from '../core/sizing.js';
import { allocationForCard, allocationInputs, allocationSummary } from './allocation.js';
import { showError, showToast } from './feedback.js';
import { riskDollars } from './risk.js';
import { entryVal, stopLongVal, stopShortVal } from './stops.js';
import { effects } from './effects.js';

export function copyPlainText(text) {
  const ok = () => showToast('Copied: ' + text);
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); ok(); } catch(e) { showError('Could not copy.'); }
    ta.remove();
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok).catch(fallback);
    else fallback();
  } catch(e) { fallback(); }
}

export function ex100(unit, word) { // '· to risk $100: 3 contracts', or the one-unit cost when even one risks more
  if (!(unit > 0)) return '';
  const n = unitsFor(100, unit);
  return n >= 1 ? ` · to risk $100: ${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}` : ` · 1 ${word} risks ${fmt$(unit)}`;
}

export function copyShares() {
  const q = state.quoteData;
  if (!q) { showError('Load a ticker first.'); return; }
  if (state.sizingMode === 'allocation') {
    const r = calcAllocation({ ...allocationInputs(q.symbol), unitCost: entryVal() });
    if (r.error) return;
    effects.copyPlainText(`Buy ${r.units} $${q.symbol} shares @ ${fmtN(entryVal(), 2)} · commitment ${fmt$(r.commitment)} · total allocation ${r.actualPct.toFixed(2)}% · before fees`);
    return;
  }
  const isLong = state.direction === 'long';
  const entry = entryVal();
  const stop = isLong ? stopLongVal() : stopShortVal();
  const rps = isLong ? entry - stop : stop - entry;
  if (!(rps > 0) || !Number.isFinite(stop)) { showError('Stop is on the wrong side of entry.'); return; }
  const shares = unitsFor(riskDollars(), rps);
  const acct = parseFloat(document.getElementById('accountSize').value) || 1;
  effects.copyPlainText(`${isLong ? 'bought' : 'shorted'} $${q.symbol} @ ${fmtN(entry, 2)} with stop at ${fmtN(stop, 2)} · risk ${(shares * rps / acct * 100).toFixed(2)}% of account${ex100(rps, 'share')}`);
}

export function copyPinned(cardId) {
  const d = state.pinnedData[cardId];
  if (!d) return;
  if (d.sizing === 'allocation') {
    const r = allocationForCard(d); if (r.error) return; const qty = r.units; const entry = d.mid;
    effects.copyPlainText(allocationSummary(d, qty, entry, r)); return;
  }
  const unit = sizeUnit(d);
  const cts = unitsFor(riskDollars(), unit);
  const acct = parseFloat(document.getElementById('accountSize').value) || 1;
  const what = d.kind === 'spread' ? `${+d.legs[0].K}/${+d.legs[1].K}${d.isCall ? 'c' : 'p'} ${d.credit ? 'credit' : 'debit'} spread` : `${+d.parsed.strike}${d.isCall ? 'c' : 'p'}`;
  // a stop on the winning side loses nothing: no risk to state (the share image shows —)
  const risk = unit > 0 ? `risk ${(Math.max(1, cts) * unit / acct * 100).toFixed(2)}% of account` : 'no loss at this stop';
  effects.copyPlainText(`${d.credit ? 'sold' : 'bought'} $${d.parsed.ticker} ${expChat(d.parsed.expStr)} ${what} @ ${fmtN(d.mid, 2)} with stop at ${fmtN(d.stopLevel, 2)} on the underlying · ${risk}${ex100(unit, d.kind === 'spread' ? 'spread' : 'contract')}`);
}
