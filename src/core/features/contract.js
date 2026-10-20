// @ts-check
// Option features: the contract you bought or sold at your entry, worked out from your fill and the underlying's price
// then (Black-Scholes, as the calculator prices options). Stocks and spreads have none.
import { impliedVolatility, normCdf, RISK_FREE } from '../black-scholes.js';
import { expiryCloseMs } from '../options.js';
import { parseSchwabOption } from '../positions.js';
import { family, feature } from './define.js';

export const CONTRACT_FAMILY = family({ key: 'options', name: 'Options', version: 1 });

const YEAR_MS = 365 * 86400000;
const NOT_OPTION = Object.freeze({ value: null, note: 'not an option' });

/** the contract, and its time to the 4pm New York close on expiry in years @param {import('./context.js').FeatureContext} ctx */
function contract(ctx) {
  const o = ctx.trade.assetType === 'OPTION' ? parseSchwabOption(ctx.trade.symbol) : null;
  if (!o) return null;
  return { ...o, isCall: o.type === 'C', years: (expiryCloseMs(o.exp) - ctx.at) / YEAR_MS };
}

/** the underlying's price at the entry @param {import('./context.js').FeatureContext} ctx */
const spot = ctx => ctx.intraday('$underlying', { session: 'all' })?.price ?? null;

/** the IV your fill implies, and the contract; or why there's none @param {import('./context.js').FeatureContext} ctx */
function impliedAtEntry(ctx) {
  const o = contract(ctx);
  if (!o) return { out: NOT_OPTION };
  const S = spot(ctx), fill = ctx.optionFill;
  if (!S || !fill) return { out: null };
  if (o.years <= 0) return { out: { value: null, note: 'entered at or after expiry' } };
  const iv = impliedVolatility(o.isCall, fill, S, o.strike, o.years, RISK_FREE);
  if (iv === null) return { out: { value: null, note: "your fill can't be priced by Black-Scholes (under intrinsic value?)" } };
  return { o, S, iv };
}

export const CONTRACT_FEATURES = [
  feature(CONTRACT_FAMILY, {
    key: 'dte_at_entry',
    name: 'Days to expiry',
    desc: "Calendar days from your entry to the contract's 4pm New York close on expiry (0.25 = six hours: a 0DTE).",
    version: 1, at: 'entry', unit: '', bins: [1, 7, 30, 60],
    needs: {},
    compute: ctx => { const o = contract(ctx); return o ? Math.max(0, o.years * 365) : NOT_OPTION; },
  }),
  feature(CONTRACT_FAMILY, {
    key: 'strike_vs_stock',
    name: 'Strike out of the money',
    desc: 'How far the strike was from the stock at your entry, as a % out of the money (a call above the stock, a put below it). Below 0 = in the money.',
    version: 1, at: 'entry', unit: '%', bins: [-5, 0, 5, 10],
    needs: { intraday: ['$underlying'], session: 'all' },
    compute: ctx => {
      const o = contract(ctx);
      if (!o) return NOT_OPTION;
      const S = spot(ctx);
      return S ? (o.isCall ? o.strike / S - 1 : 1 - o.strike / S) * 100 : null;
    },
  }),
  feature(CONTRACT_FAMILY, {
    key: 'iv_at_entry',
    name: 'IV at entry',
    desc: 'The implied volatility your fill priced in, as a %: Black-Scholes fitted to your price and the stock at that moment (4% rate, no dividends).',
    version: 1, at: 'entry', unit: '', bins: [30, 50, 80, 120],
    needs: { intraday: ['$underlying'], session: 'all' },
    compute: ctx => { const r = impliedAtEntry(ctx); return 'out' in r ? r.out : r.iv * 100; },
  }),
  feature(CONTRACT_FAMILY, {
    key: 'delta_at_entry',
    name: 'Delta at entry',
    desc: "The contract's delta at your entry from that IV, as a size (0.50 = at the money, whether call or put).",
    version: 1, at: 'entry', unit: '', bins: [0.2, 0.4, 0.6, 0.8],
    needs: { intraday: ['$underlying'], session: 'all' },
    compute: ctx => {
      const r = impliedAtEntry(ctx);
      if ('out' in r) return r.out;
      const { o, S, iv } = r;
      const d1 = (Math.log(S / o.strike) + (RISK_FREE + iv * iv / 2) * o.years) / (iv * Math.sqrt(o.years));
      return Math.abs(o.isCall ? normCdf(d1) : normCdf(d1) - 1);
    },
  }),
  feature(CONTRACT_FAMILY, {
    key: 'iv_vs_hv20',
    name: 'IV vs HV20',
    desc: "The IV your fill priced in over the stock's 20-day historical volatility (the sessions before). Above 1.5 = you paid up for volatility.",
    version: 1, at: 'entry', unit: 'x', bins: [0.8, 1, 1.5, 2],
    needs: { intraday: ['$underlying'], daily: ['$underlying'], dailySessions: 21, session: 'all' },
    compute: ctx => {
      const r = impliedAtEntry(ctx);
      if ('out' in r) return r.out;
      const hv = ctx.daily('$underlying', 21)?.hv(20);
      return hv ? r.iv * 100 / hv : null;
    },
  }),
  feature(CONTRACT_FAMILY, {
    key: 'premium_pct_of_stock',
    name: 'Premium as % of the stock',
    desc: "Your fill per share over the stock's price at the entry, as a %. What the contract cost against the stock it controls.",
    version: 1, at: 'entry', unit: '', bins: [0.5, 1, 2, 5],
    needs: { intraday: ['$underlying'], session: 'all' },
    compute: ctx => {
      if (!contract(ctx)) return NOT_OPTION;
      const S = spot(ctx), fill = ctx.optionFill;
      return S && fill ? fill / S * 100 : null;
    },
  }),
];
