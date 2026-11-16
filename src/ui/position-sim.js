// Position sim: an option position's or a spread's Simulate button opens the return simulator at your average cost and size,
// fitting IV to Schwab's displayed premiums (each leg its own) and one Tradier underlying quote.
import { state } from '../state.js';
import { impliedVolatility, RISK_FREE } from '../core/black-scholes.js';
import { effectivePrice } from '../core/extended-hours.js';
import { fmt$ } from '../core/format.js';
import { expiryCloseMs } from '../core/options.js';
import { baseUrl, headers } from '../services/tradier.js';
import { marketFetch } from '../services/market-source.js';
import { effects } from './effects.js';
import { showError } from './feedback.js';
import { requireKey } from './settings.js';

/** the underlying's price now (the extended price when live), from one quotes call; null with an error shown */
async function underlyingSpot(under, label) {
  let quotes;
  try {
    const res = await marketFetch(`${baseUrl()}/markets/quotes?symbols=${encodeURIComponent(under)}`, { headers: headers() });
    const raw = (await res.json())?.quotes?.quote;
    quotes = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  } catch(e) {
    showError('Could not reach Tradier for this contract.');
    return null;
  }
  const uq = quotes.find(q => q.symbol === under);
  const spot = uq ? +effectivePrice(uq).toFixed(2) : 0; // match the simulator's penny-step underlying control
  if (!(spot > 0)) { showError(`Tradier has no quote for ${label}.`); return null; }
  return spot;
}

const yearsTo = (exp, asOf) => (expiryCloseMs(exp) - asOf) / (365 * 24 * 3600 * 1000);

/** key: an option row's symbol, or a spread's key (its legs' symbols) */
export async function simPosition(key) {
  if (state.positions?.spreads?.some(s => s.key === key)) return simSpread(key);
  let positions = state.positions;
  let row = positions && positions.rows.find(r => r.symbol === key);
  if (!row || !row.option) return;
  if (!requireKey()) return;
  const quoted = await underlyingSpot(row.under, row.label);
  // A refresh may have landed while the quote was in flight. Fit what holdings shows now.
  if (!state.positions || state.positions.hash !== positions.hash) return;
  positions = state.positions;
  row = positions.rows.find(r => r.symbol === key);
  if (!row || !row.option || quoted === null) return;
  const spot = quoted;
  const { type, strike, exp } = row.option;
  const asOf = Date.now(), T = yearsTo(exp, asOf);
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

/**
 * A spread's Simulate: every leg fitted to Schwab's price at its own type, strike and expiry, netted in the legs' ratio per spread,
 * at the net cost and the count of spreads. A credit is short its legs' net, so its legs flip and P/L runs the other way;
 * a credit vertical measures against its max loss (width less the credit), anything else against the net paid or taken in.
 * The time axis runs to the nearest expiry (a calendar's short leg).
 */
async function simSpread(key) {
  let positions = state.positions;
  let s = positions.spreads.find(x => x.key === key);
  if (!requireKey()) return;
  const quoted = await underlyingSpot(s.under, s.label);
  if (!state.positions || state.positions.hash !== positions.hash) return;
  positions = state.positions;
  s = (positions.spreads || []).find(x => x.key === key);
  if (!s || quoted === null) return;
  const spot = quoted, asOf = Date.now();
  if (!(s.avg > 0)) { showError(`Schwab has no average cost on every leg of ${s.label}, so there's nothing to measure returns from.`); return; }
  const sign = s.kind === 'credit' ? -1 : 1;
  const legs = s.legs.map(l => ({
    K: l.option.strike, isCall: l.option.type === 'C', expStr: l.option.exp, mid: l.price,
    side: sign * l.qty / s.units, symbol: l.symbol,
  }));
  const near = legs.map(L => L.expStr).sort()[0];
  const T = yearsTo(near, asOf);
  if (!(T > 0)) { showError(`${s.label} has a leg expiring. Nothing to simulate.`); return; }
  const ivs = legs.map(L => impliedVolatility(L.isCall, L.mid, spot, L.K, yearsTo(L.expStr, asOf), RISK_FREE));
  if (ivs.some(v => v === null)) {
    showError(`Cannot fit a simulation to Schwab's prices for ${s.label} with ${s.under} at ${fmt$(spot)}. Refresh positions and try again.`);
    return;
  }
  const iv = ivs.reduce((a, v) => a + v, 0) / ivs.length;
  const mark = legs.reduce((a, L) => a + L.side * L.mid, 0);
  effects.openSim({
    isCall: legs[0].isCall, K: legs[0].K, expStr: near, iv, legs,
    mark, markAsOf: positions.asOf, asOf,
    credit: s.kind === 'credit', shortPut: false,
    width: s.riskBasis === 'width' ? Math.abs(legs[0].K - legs[1].K) : 0, noFloor: s.maxLoss === null,
    entry: s.avg, entryWord: s.kind === 'credit' ? 'credit' : 'net debit', qty: s.units, spot, stop: null,
    em: spot * iv * Math.sqrt(T), // one standard deviation by the nearest expiry at the legs' average fitted IV
    parsedTicker: s.under, label: s.label,
  });
}
