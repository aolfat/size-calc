// Run with: node --test
// The fixed $ risk chips: whatever order they're typed or saved in, they show smallest first (owner request).
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const chips = elements => [...elements.get('riskUsdPresets').innerHTML.matchAll(/data-usd="([\d.]+)"/g)].map(m => +m[1]);

test('$ presets: saved out of order (or synced from before) they still show smallest first', async () => {
  const { run, elements } = await app({ storage: new Map([['risk_usd_presets', '[500,100,1000,250]']]) });
  run('renderUsdPresets()');
  assert.deepEqual(chips(elements), [100, 250, 500, 1000]);
});

test('$ presets: a value added at the end lands in its place, and is saved sorted', async () => {
  const storage = new Map();
  const { run, elements } = await app({ storage });
  run('toggleUsdEdit()'); // ✎: the chips become boxes
  const boxes = ['100', '250', '500', '1000', '', '50', '750', '300'].map(value => ({ value })); // a blank deletes, 7 left: the first 6 kept
  const qsa = document.querySelectorAll;
  document.querySelectorAll = sel => sel === '.usd-edit-box' ? boxes : qsa(sel);
  try { run('toggleUsdEdit()'); } finally { document.querySelectorAll = qsa; } // ✓
  assert.equal(storage.get('risk_usd_presets'), '[50,100,250,500,750,1000]');
  assert.deepEqual(chips(elements), [50, 100, 250, 500, 750, 1000]);
});
