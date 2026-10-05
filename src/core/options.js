import { RISK_FREE, bsPrice } from './black-scholes.js';

export function strikesLabel(d) {
  return d.kind === 'spread' ? `$${+d.legs[0].K}/$${+d.legs[1].K}` : `$${+d.parsed.strike}`;
}

export function typeLabel(d) {
  if (d.sizing === 'allocation') return d.shortPut ? 'short put' : 'long ' + (d.isCall ? 'call' : 'put');
  return `${d.isCall ? 'call' : 'put'}${d.kind === 'spread' ? (d.credit ? ' credit spread' : ' debit spread') : ''}`;
}

// trade direction: long calls and put credit spreads win up, long puts and call credit spreads win down

export function isBull(d) { return d.credit ? !d.isCall : d.isCall; }

export function spreadWidth(d) { return d.legs ? Math.abs(d.legs[1].K - d.legs[0].K) : 0; }

// net Black-Scholes value of a card at underlying S with T years left (legs-aware)

export function cardValueAt(d, S, T) {
  const TT = Math.max(0, T);
  if (d.legs) return d.legs.reduce((a, L) => a + L.side * bsPrice(d.isCall, S, L.K, TT, L.iv || d.iv, RISK_FREE), 0);
  return bsPrice(d.isCall, S, d.parsed.strike, TT, d.iv, RISK_FREE);
}

export function sizeUnit(d) { // $ risked per contract for sizing: defined risk for spreads (full debit, or width − credit), loss@stop for singles
  if (d.kind === 'spread') return (d.credit ? spreadWidth(d) - d.mid : d.mid) * 100;
  return d.lossPerContract;
}

export function isMonthlyExp(expStr) {
  // standard monthly = third Friday; if that Friday is a holiday the listed
  // expiry lands on the Thursday before, so accept that too
  const [y, m, d] = expStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow = date.getDay();
  // third Friday of this month
  const first = new Date(y, m - 1, 1);
  const firstFriOffset = (5 - first.getDay() + 7) % 7;
  const thirdFri = 1 + firstFriOffset + 14;
  if (dow === 5 && d === thirdFri) return true;
  if (dow === 4 && d === thirdFri - 1) return true; // holiday Thursday case
  return false;
}

export function lossClass(lossPct) {
  if (lossPct < 25) return 'loss-low';
  if (lossPct < 60) return 'loss-mid';
  return 'loss-high';
}

export function yearsToExp(expStr, daysLess = 0) {
  if (!expStr) return 0;
  const ms = new Date(expStr + 'T16:00:00') - Date.now();
  return Math.max(0, ms / (365 * 24 * 3600 * 1000) - daysLess / 365);
}
