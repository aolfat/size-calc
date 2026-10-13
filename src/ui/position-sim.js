// Position sim: an option position's Simulate button opens the return simulator at your average cost and size,
// with the underlying price and the contract's IV from one Tradier quotes call.
import { state } from '../state.js';
import { effectivePrice } from '../core/extended-hours.js';
import { yearsToExp } from '../core/options.js';
import { baseUrl, headers } from '../services/tradier.js';
import { effects } from './effects.js';
import { showError } from './feedback.js';
import { requireKey } from './settings.js';

export async function simPosition(symbol) {
  const row = state.positions && state.positions.rows.find(r => r.symbol === symbol);
  if (!row || !row.option) return;
  if (!requireKey()) return;
  const occ = symbol.replace(/\s+/g, ''); // Schwab pads the root to six characters; Tradier doesn't
  let quotes;
  try {
    const res = await fetch(`${baseUrl()}/markets/quotes?symbols=${encodeURIComponent(row.under + ',' + occ)}&greeks=true`, { headers: headers() });
    const raw = (await res.json())?.quotes?.quote;
    quotes = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  } catch(e) {
    showError('Could not reach Tradier for this contract.');
    return;
  }
  const uq = quotes.find(q => q.symbol === row.under), oq = quotes.find(q => q.symbol === occ);
  const spot = uq ? effectivePrice(uq) : 0;
  if (!oq || !(spot > 0)) { showError(`Tradier has no quote for ${row.label}.`); return; }
  const { type, strike, exp } = row.option;
  const iv = oq.greeks?.smv_vol || oq.greeks?.mid_iv || 0;
  const short = row.qty < 0;
  effects.openSim({
    isCall: type === 'C', K: strike, expStr: exp, iv,
    credit: short, shortPut: false, width: 0, // a sold option measures against its premium, puts too: on notional a held put barely moves
    entry: row.avg, entryWord: short ? 'sold at' : 'avg cost', qty: Math.abs(row.qty), spot, stop: null,
    em: spot * iv * Math.sqrt(yearsToExp(exp)), // one standard deviation by expiry at this IV
    parsedTicker: row.under, label: row.label,
  });
}
