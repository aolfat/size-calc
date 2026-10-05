export function riskForQty(qty, perUnit) {
  // cent-rounded risk that floors back to exactly qty units
  let risk = +(qty * perUnit).toFixed(2);
  if (unitsFor(risk, perUnit) < qty) risk = +(risk + 0.01).toFixed(2);
  return risk;
}

export function unitsFor(risk, perUnit) {
  // float-noise-tolerant floor: 11.999999999999998 units is 12, not 11
  return perUnit > 0 ? Math.floor(risk / perUnit + 1e-9) : 0;
}

// Allocation is a capital cap; it never uses stops or estimated broker margin.

export function calcAllocation({ account, pct, existing, unitCost }) {
  if (![account, pct, existing, unitCost].every(Number.isFinite) || account <= 0 || pct < 0 || pct > 100 || existing < 0 || unitCost <= 0) {
    return { units: 0, error: 'Enter a positive account and unit price, 0–100% allocation, and nonnegative exposure.' };
  }
  const target = account * pct / 100;
  const budget = Math.max(0, target - existing);
  // Tolerate only arithmetic noise at an exact boundary, never a material overspend.
  const ratio = budget / unitCost;
  const units = Math.floor(ratio + Number.EPSILON * Math.max(1, ratio) * 4);
  if (!Number.isSafeInteger(units)) return { units: 0, error: 'Position size is too large.' };
  const commitment = units * unitCost;
  const totalExposure = existing + commitment;
  const reason = existing > target ? 'Existing exposure exceeds allocation.'
    : existing === target ? 'Allocation already used.'
    : units === 0 ? 'Remaining budget cannot fit one unit.' : '';
  return { units, target, budget, commitment, totalExposure, existing, actualPct: totalExposure / account * 100, reason };
}

export function shortPutMetrics(strike, credit, contracts, dte) {
  const basis = strike - credit;
  const returnOnNotional = credit / strike;
  return { basis, notional: strike * 100 * contracts, premium: credit * 100 * contracts,
    maxLoss: basis * 100 * contracts, returnOnNotional, annualized: dte > 0 ? returnOnNotional * 365 / dte : null };
}

export function optionDte(exp, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = type => parts.find(p => p.type === type).value;
  return Math.round((Date.parse(exp + 'T00:00:00Z') - Date.UTC(+part('year'), +part('month') - 1, +part('day'))) / 864e5);
}

export function optionPnl(d, entry, close, qty) { return (d.credit ? entry - close : close - entry) * 100 * qty; }

export function simReturnBase(o) { return o.shortPut ? o.K : o.credit ? Math.max(0.01, (o.width || 0) - o.entry) : o.entry; }
