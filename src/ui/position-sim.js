// Position sim: an option position's Simulate button opens the return simulator at your average cost and size,
// fitting IV to Schwab's displayed premium and one Tradier underlying quote.
import { state } from '../state.js';
import { impliedVolatility, RISK_FREE } from '../core/black-scholes.js';
import { effectivePrice } from '../core/extended-hours.js';
import { fmt$ } from '../core/format.js';
import { expiryCloseMs } from '../core/options.js';
import { baseUrl, headers } from '../services/tradier.js';
import { effects } from './effects.js';
import { showError } from './feedback.js';
import { requireKey } from './settings.js';

export async function simPosition(symbol) {
  let positions = state.positions;
  let row = positions && positions.rows.find(r => r.symbol === symbol);
  if (!row || !row.option) return;
  if (!requireKey()) return;
  let quotes;
  try {
    const res = await fetch(`${baseUrl()}/markets/quotes?symbols=${encodeURIComponent(row.under)}`, { headers: headers() });
    const raw = (await res.json())?.quotes?.quote;
    quotes = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  } catch(e) {
    showError('Could not reach Tradier for this contract.');
    return;
  }
  // A refresh may have landed while the quote was in flight. Fit what holdings shows now.
  if (!state.positions || state.positions.hash !== positions.hash) return;
  positions = state.positions;
  row = positions.rows.find(r => r.symbol === symbol);
  if (!row || !row.option) return;
  const uq = quotes.find(q => q.symbol === row.under);
  const spot = uq ? +effectivePrice(uq).toFixed(2) : 0; // match the simulator's penny-step underlying control
  if (!(spot > 0)) { showError(`Tradier has no quote for ${row.label}.`); return; }
  const { type, strike, exp } = row.option;
  const asOf = Date.now(), T = (expiryCloseMs(exp) - asOf) / (365 * 24 * 3600 * 1000);
  if (!(T > 0)) { showError(`${row.label} has expired. Nothing to simulate.`); return; }
  const iv = impliedVolatility(type === 'C', row.price, spot, strike, T, RISK_FREE);
  if (iv === null) {
    showError(`Cannot fit a simulation to Schwab's ${fmt$(row.price)} price for ${row.label} with ${row.under} at ${fmt$(spot)}. Refresh positions and try again.`);
    return;
  }
  const short = row.qty < 0;
  effects.openSim({
    isCall: type === 'C', K: strike, expStr: exp, iv,
    mark: row.price, markAsOf: positions.asOf, asOf,
    credit: short, shortPut: false, width: 0, // a sold option measures against its premium, puts too: on notional a held put barely moves
    entry: row.avg, entryWord: short ? 'sold at' : 'avg cost', qty: Math.abs(row.qty), spot, stop: null,
    em: spot * iv * Math.sqrt(T), // one standard deviation by expiry at the fitted IV
    parsedTicker: row.under, label: row.label,
  });
}
