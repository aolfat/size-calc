// Run with: node --test
// Stats by a trade feature (docs/journal-features.md, part 3; core/feature-stats.js): five even groups or the feature's
// own cut points, words by word, only current stamps counted, the rest said apart; and the By a feature section on the
// Journal's Stats tab: the picker, the two groupings, the counts, and what it says without stamps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeWords, featureBreakdown } from '../src/core/feature-stats.js';
import { family, feature } from '../src/core/features/define.js';
import { FEATURES, featureVersion } from '../src/core/features/index.js';
import { app } from './helpers/app.mjs';

const F = FEATURES.find(f => f.key === 'atr_from_daily_sma50'); // unit atr, cut points -2, 0, 2, 4
const V = featureVersion(F);
/** a closed trade, its P&L and R */
const trade = (i, pnl, r = null) => ({ key: `k${i}`, symbol: 'NVDA', label: 'NVDA', assetType: 'EQUITY', status: pnl > 0 ? 'win' : 'loss', direction: 'long',
  openedAt: `2026-10-${String(1 + i).padStart(2, '0')}T14:00:00.000Z`, closedAt: `2026-10-${String(1 + i).padStart(2, '0')}T15:00:00.000Z`, pnl, r, exits: 1, holdMs: 3600000 });
const stamped = values => Object.fromEntries(values.map((value, i) => [`k${i}`, { [F.key]: { v: V, value } }]));

test('five even groups: about as many trades in each, named by their own lowest and highest value', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const trades = values.map((v, i) => trade(i, v > 6 ? -100 : 100, v > 6 ? -1 : 1));
  const b = featureBreakdown(trades, stamped(values), F);
  assert.deepEqual(b.rows.map(r => [r.group, r.stats.trades]), [['+1.00 ATR to +2.00 ATR', 2], ['+3.00 ATR to +4.00 ATR', 2], ['+5.00 ATR to +6.00 ATR', 2], ['+7.00 ATR to +8.00 ATR', 2], ['+9.00 ATR to +10.00 ATR', 2]]);
  assert.deepEqual(b.rows.map(r => r.stats.avgR), [1, 1, 1, -1, -1], "each group's numbers are groupStats'");
  assert.deepEqual([b.total, b.valued, b.unknown, b.pending], [10, 10, 0, 0]);
  // equal values never straddle two groups: a split inside a run of them moves up to the next value
  const ties = [1, 1, 1, 1, 1, 1, 2, 3, 4, 5];
  const t = featureBreakdown(ties.map((_, i) => trade(i, 10)), stamped(ties), F);
  assert.deepEqual(t.rows.map(r => [r.group, r.stats.trades]), [['+1.00 ATR', 6], ['+2.00 ATR to +3.00 ATR', 2], ['+4.00 ATR to +5.00 ATR', 2]], 'all the 1s in one group');
  assert.equal(t.rows.reduce((n, r) => n + r.stats.trades, 0), 10);
  // fewer distinct values than five: that many groups
  assert.deepEqual(featureBreakdown([trade(0, 1), trade(1, 1), trade(2, 1)], stamped([2, 2, 3]), F).rows.map(r => r.group), ['+2.00 ATR', '+3.00 ATR']);
});

test("cut points: the feature's own, one group under the first, between each pair, and the last and over", () => {
  const values = [-3, -1, 0, 1, 3, 4, 9];
  const b = featureBreakdown(values.map((_, i) => trade(i, 50)), stamped(values), F, 'cuts');
  assert.deepEqual(b.rows.map(r => [r.group, r.stats.trades]), [
    ['Under −2.00 ATR', 1], ['−2.00 ATR to 0.00 ATR', 1], ['0.00 ATR to +2.00 ATR', 2], ['+2.00 ATR to +4.00 ATR', 1], ['+4.00 ATR and over', 2],
  ], 'a value on a cut point goes to the group above');
  // a group with no trades is left out
  assert.deepEqual(featureBreakdown([trade(0, 1)], stamped([5]), F, 'cuts').rows.map(r => r.group), ['+4.00 ATR and over']);
});

test('only current stamps count: unknown and not stamped yet are counted apart; words group by word', () => {
  const trades = [0, 1, 2, 3].map(i => trade(i, 10));
  const stamps = { k0: { [F.key]: { v: V, value: 1.5 } }, k1: { [F.key]: { v: V, value: null, note: 'fewer than 49 daily sessions before' } }, k2: { [F.key]: { v: '0.1', value: 3 } } };
  const b = featureBreakdown(trades, stamps, F);
  assert.deepEqual([b.total, b.valued, b.unknown, b.pending], [4, 1, 1, 2], 'an older version and no stamp at all are both not stamped yet');
  assert.deepEqual(b.rows.map(r => r.group), ['+1.50 ATR']);
  assert.deepEqual(featureBreakdown(trades, null, F).rows, [], 'no stamps read');
  // a feature of words: its own words, in its order
  const words = feature(family({ key: 'test', name: 'Test', version: 1 }), { key: 'prior_day', name: 'Prior day', desc: 'd', version: 1, at: 'entry', needs: {},
    values: [['inside', 'Inside day'], ['nr7', 'NR7'], ['none', 'Neither']], compute: () => null });
  const w = Object.fromEntries(['none', 'inside', 'none', 'nr7'].map((value, i) => [`k${i}`, { prior_day: { v: featureVersion(words), value } }]));
  assert.deepEqual(featureBreakdown(trades, w, words).rows.map(r => [r.group, r.stats.trades]), [['Inside day', 1], ['NR7', 1], ['Neither', 2]]);
  // a plain number's edges to two places
  assert.equal(edgeWords(FEATURES.find(f => !f.unit), 0.123456), '0.12');
});

test('Stats: By a feature picks any feature, splits the trades both ways, says how many have a value, and what it needs', async () => {
  const { run } = await app();
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  run(`var T = ${JSON.stringify(values.map((v, i) => trade(i, v > 6 ? -100 : 100, v > 6 ? -1 : 1)))};`);
  run(`featureStamps = ${JSON.stringify({ ...stamped(values), k9: {} })}; session = { user: { id: 'u' } };`);
  let html = run('statsView(T)');
  assert.match(html, /By a feature/);
  assert.match(html, new RegExp(`<select id="statsFeature" class="journal-setup-filter js-feature-select" data-change="setStatsFeature"`));
  assert.match(html, /<optgroup label="Moving averages">/);
  run(`setStatsFeature('${F.key}')`);
  html = run('statsView(T)');
  assert.match(html, new RegExp(`<option value="${F.key}" selected>`));
  assert.match(html, /9 of 10 trades with a value, 1 not stamped yet\./);
  assert.match(html, /<b>\+2\.00 ATR to \+3\.00 ATR<\/b>/, 'nine values: 1 alone, then pairs');
  assert.match(html, /aria-pressed="true" data-action="setStatsFeatureMode" data-arg="even">Five even groups/);
  run("setStatsFeatureMode('cuts')");
  html = run('statsView(T)');
  assert.match(html, /<b>\+4\.00 ATR and over<\/b>/);
  assert.match(html, /some splits will look meaningful by chance/);
  run("setStatsFeature('not_a_feature'); setStatsFeatureMode('sideways')");
  assert.equal(run('statsFeature'), F.key, 'an unknown key changes nothing');
  assert.equal(run('statsFeatureMode'), 'even');
  // before the stamps are read, signed out, or the table not pushed yet
  run('featureStamps = null');
  assert.match(run('statsView(T)'), /Features load with the Journal\./);
  run('session = null');
  assert.match(run('statsView(T)'), /Sign in to see your trades by their features\./);
  run("featuresError = 'no table'");
  assert.match(run('statsView(T)'), /Features need the database update: npx supabase db push\./);
});
