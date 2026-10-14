import test from 'node:test';
import assert from 'node:assert/strict';
import * as bs from '../src/core/black-scholes.js';

test('implied volatility fits calls and puts back to their market premium, including near expiry and high IV', () => {
  for (const isCall of [true, false]) {
    for (const [spot, strike, years, vol] of [
      [100, 100, 0.25, 0.3], [41.1, 50, 65 / 365, 0.9], [41.1, 40, 65 / 365, 0.6],
      [100, 105, 1 / 8760, 25], [100, 100, 1 / 8760, 0.5], [100, 90, 2, 0.8],
    ]) {
      const price = bs.bsPrice(isCall, spot, strike, years, vol, bs.RISK_FREE);
      const fitted = bs.impliedVolatility(isCall, price, spot, strike, years, bs.RISK_FREE);
      assert.ok(fitted > 0);
      assert.ok(Math.abs(bs.bsPrice(isCall, spot, strike, years, fitted, bs.RISK_FREE) - price) < 1e-7);
    }
  }
});

test('implied volatility refuses invalid, expired and unmodellable prices instead of returning a false fit', () => {
  for (const [isCall, price, spot, strike, years, rate] of [
    [true, NaN, 100, 100, 1, 0.04], [true, 5, 0, 100, 1, 0.04], [true, 5, 100, -1, 1, 0.04],
    [true, 5, 100, 100, 0, 0.04], [false, -1, 100, 100, 1, 0.04], [true, 5, 100, 100, 1, Infinity],
    [true, 1, 100, 90, 1, 0.04], // below the model's minimum, even with almost no volatility
    [true, 100, 100, 100, 1, 0.04], [false, 100, 100, 100, 1, 0.04], // at or above the upper bound
  ]) {
    assert.equal(bs.impliedVolatility(isCall, price, spot, strike, years, rate), null);
  }
});
