// Run with: node --test
// Exits and stops by group (core/exit-stats.js): the exit score, winners sold too early, holding on against the exits,
// shakeouts and how deep winners dip, per label, from each trade's reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const json = (run, code) => JSON.parse(run(`JSON.stringify(${code})`));
const T = (key, pnl, setups) => ({ key, symbol: key.toUpperCase(), status: pnl > 0 ? 'win' : 'loss', openedAt: '2026-10-05T14:00:00Z', closedAt: '2026-10-05T15:00:00Z', pnl, avgEntry: 100, entryQty: 1, multiplier: 1, setups });
const TRADES = [T('a', 300, ['bounce']), T('b', 200, ['bounce']), T('c', 100, ['bounce', 'breakout']), T('d', -100, ['bounce']), T('e', -100, ['breakout']), T('f', 50, ['breakout'])];
const READS = `({
  a: { after: { score: 0.4, verdict: 'early', held: 300, heldR: 1.5 }, stop: null, maeR: -0.2 },
  b: { after: { score: 0.9, verdict: 'good', held: -100, heldR: -0.5 }, stop: null, maeR: -0.6 },
  c: { after: { score: 0.3, verdict: 'early', held: 100, heldR: 0.5 }, stop: null, maeR: -0.3 },
  d: { after: { score: 0.05, verdict: 'stopped', held: 0, heldR: 0 }, stop: { stopped: true, verdict: 'shaken' }, maeR: -1 },
  e: null,
})`;

test('exits and stops per group: the average score, the verdicts, winners sold too early, holding on, shakeouts, the winners\' dip', async () => {
  const { run } = await app();
  const rows = json(run, `exitStatsByLabel(${JSON.stringify(TRADES)}, t => t.setups, t => ${READS}[t.key])`);
  assert.deepEqual(rows.map(r => r.group), ['bounce', 'breakout'], 'most trades first');
  assert.deepEqual(rows[0].stats, {
    trades: 4, judged: 4, pending: 0, score: 0.413, good: 1, early: 2, late: 0, stopped: 1,
    winners: 3, cut: 2, cutMore: 400, cutR: 2, held: 300, heldR: 1.5, stopOuts: 1, shaken: 1, dip80: -0.6,
  });
  // breakout: c read, e nothing to read (no bars), f still being read
  const b = rows[1].stats;
  assert.deepEqual([b.trades, b.judged, b.pending, b.winners, b.cut, b.stopOuts, b.dip80], [3, 1, 1, 1, 1, 0, null], 'under three winners: no dip');
  assert.equal(run(`exitStats([], () => null).score`), null);
});
