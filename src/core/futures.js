import { unitsFor } from './sizing.js';

// ---------- futures: manual prices, risk per tick, no market-data dependency ----------
// Outright contract specs (CME, checked September 2026):
// https://www.cmegroup.com/trading/equity-index/files/cme-micro-e-mini-futures-fact-card.pdf
// https://www.cmegroup.com/education/modules/files/EQ240_EQ_for_AIT.pdf
// https://www.cmegroup.com/education/courses/futures-vs-etfs/reasons-to-trade-e-mini-russell-2000-futures-over-russell-2000-etf
// https://www.cmegroup.com/education/articles-and-reports/micro-wti-crude-oil-futures-faq
// https://www.cmegroup.com/education/lessons/micro-gold-and-micro-silver-futures-product-overview
// https://www.cmegroup.com/trading/metals/files/fact-card-gold-futures-options.pdf

export const FUTURES_CONTRACTS = {
  MES: { name: 'Micro E-mini S&P 500', tickSize: 0.25, tickValue: 1.25 },
  ES:  { name: 'E-mini S&P 500', tickSize: 0.25, tickValue: 12.5 },
  MNQ: { name: 'Micro E-mini Nasdaq-100', tickSize: 0.25, tickValue: 0.5 },
  NQ:  { name: 'E-mini Nasdaq-100', tickSize: 0.25, tickValue: 5 },
  MYM: { name: 'Micro E-mini Dow', tickSize: 1, tickValue: 0.5 },
  YM:  { name: 'E-mini Dow', tickSize: 1, tickValue: 5 },
  M2K: { name: 'Micro E-mini Russell 2000', tickSize: 0.1, tickValue: 0.5 },
  RTY: { name: 'E-mini Russell 2000', tickSize: 0.1, tickValue: 5 },
  MCL: { name: 'Micro WTI Crude Oil', tickSize: 0.01, tickValue: 1 },
  CL:  { name: 'WTI Crude Oil', tickSize: 0.01, tickValue: 10 },
  MGC: { name: 'Micro Gold', tickSize: 0.1, tickValue: 1 },
  GC:  { name: 'Gold', tickSize: 0.1, tickValue: 10 }
};

export function calcFutures({ risk, entry, stop, direction, tickSize, tickValue, fees = 0 }) {
  if (![tickSize, tickValue].every(v => Number.isFinite(v) && v > 0)) return { error: 'Enter a positive tick size and dollar tick value.' };
  if (![entry, stop].every(Number.isFinite)) return { error: 'Enter your futures entry and stop prices.' };
  if (!Number.isFinite(risk) || risk < 0) return { error: 'Enter a valid risk budget of zero or more.' };
  if (!Number.isFinite(fees) || fees < 0) return { error: 'Fees must be zero or more.' };
  if (direction !== 'long' && direction !== 'short') return { error: 'Choose Long or Short.' };
  if ((direction === 'long' ? entry - stop : stop - entry) <= 0) {
    return { error: `Stop must be ${direction === 'long' ? 'below' : 'above'} entry for a ${direction}.` };
  }
  const entryTicks = entry / tickSize, stopTicks = stop / tickSize;
  // Check both prices, not just their distance. Tolerance only absorbs binary float noise.
  if ([entryTicks, stopTicks].some(v => !Number.isSafeInteger(Math.round(v)) || Math.abs(v - Math.round(v)) > 1e-7)) {
    return { error: `Entry and stop must use ${tickSize}-point tick increments.` };
  }
  const ticks = Math.abs(Math.round(entryTicks) - Math.round(stopTicks));
  const riskPerContract = ticks * tickValue + fees;
  const contracts = unitsFor(risk, riskPerContract);
  if (!Number.isSafeInteger(ticks) || ticks < 1 || !Number.isFinite(riskPerContract) || !(riskPerContract > 0) || !Number.isSafeInteger(contracts)) {
    return { error: 'These values are outside the supported sizing range.' };
  }
  return { ticks, points: ticks * tickSize, riskPerContract, contracts, totalRisk: contracts * riskPerContract };
}
