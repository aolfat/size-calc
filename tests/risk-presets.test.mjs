// Run with: node --test
// The risk strip's preset chips, % and $: each row editable in place (✎ turns the chips into boxes, ✓ saves), at most 6,
// always smallest first whatever order they're typed or saved in (owner request), and synced with your account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const usdChips = elements => [...elements.get('riskUsdPresets').innerHTML.matchAll(/data-usd="([\d.]+)"/g)].map(m => +m[1]);
const pctChips = elements => [...elements.get('riskPctPresets').innerHTML.matchAll(/data-pct="([\d.]+)"[^>]*>([^<]*)</g)].map(m => `${m[1]} ${m[2]}`);

/** ✎, type into the boxes (the fake DOM has none of its own), then ✓ */
function edit(run, kind, values) {
  const toggle = kind === 'pct' ? 'togglePctEdit()' : 'toggleUsdEdit()';
  run(toggle);
  const boxes = values.map(value => ({ value }));
  const qsa = document.querySelectorAll;
  document.querySelectorAll = sel => sel === `#${kind === 'pct' ? 'riskPctPresets' : 'riskUsdPresets'} .usd-edit-box` ? boxes : qsa(sel);
  try { run(toggle); } finally { document.querySelectorAll = qsa; }
}

test('% presets: the defaults until you edit them, labelled as before', async () => {
  const { run, elements } = await app();
  run('renderRiskPresets()');
  assert.deepEqual(pctChips(elements), ['0.125 .125%', '0.25 .25%', '0.5 .50%', '1 1%', '2 2%', '3 3%']);
  assert.match(elements.get('pctEditBtn').title, /Edit the percent presets/);
});

test('% presets: ✎ turns the chips into boxes, ✓ saves them smallest first; a blank deletes, a value of 100 or more is dropped', async () => {
  const storage = new Map();
  const { run, elements, state } = await app({ storage });
  run('renderRiskPresets()');
  run('togglePctEdit()');
  assert.equal(state.editingPct, true);
  assert.equal(elements.get('pctEditBtn').textContent, '✓');
  assert.equal([...elements.get('riskPctPresets').innerHTML.matchAll(/class="usd-edit-box"/g)].length, 7, 'six chips and the + box');
  assert.match(elements.get('riskPctPresets').innerHTML, /value=".125"/, 'a box reads like its chip');
  assert.match(elements.get('riskPctPresets').innerHTML, /data-enter="togglePctEdit"/);
  run('togglePctEdit()');
  edit(run, 'pct', ['1', '', '0.75', '0.5', '150', '0.3']);
  assert.equal(storage.get('risk_pct_presets'), '[0.3,0.5,0.75,1]');
  assert.deepEqual(pctChips(elements), ['0.3 .30%', '0.5 .50%', '0.75 .75%', '1 1%']);
  assert.equal(state.editingPct, false);
  // the ladder and a tap use them
  run("document.getElementById('accountSize').value = 10000");
  assert.deepEqual(run('riskLadder()').filter(v => v < 100), [30, 50, 75]);
  run('setRiskPct(0.75)');
  assert.equal(+elements.get('riskDollar').value, 75);
});

test('$ presets: saved out of order (or synced from before) they still show smallest first', async () => {
  const { run, elements } = await app({ storage: new Map([['risk_usd_presets', '[500,100,1000,250]']]) });
  run('renderUsdPresets()');
  assert.deepEqual(usdChips(elements), [100, 250, 500, 1000]);
});

test('$ presets: a value added at the end lands in its place, and is saved sorted', async () => {
  const storage = new Map();
  const { run, elements } = await app({ storage });
  edit(run, 'usd', ['100', '250', '500', '1000', '', '50', '750', '300']); // a blank deletes, 7 left: the first 6 kept
  assert.equal(storage.get('risk_usd_presets'), '[50,100,250,500,750,1000]');
  assert.deepEqual(usdChips(elements), [50, 100, 250, 500, 750, 1000]);
});

test('both preset lists are account settings: an edit is pending for the cloud, and a pulled list redraws the chips', async () => {
  const { run, elements, state } = await app({ storage: new Map([['cloud_user', 'user-1']]), session: { user: { id: 'user-1' } } });
  assert.ok(run("CLOUD_KEYS.includes('risk_pct_presets') && CLOUD_KEYS.includes('risk_usd_presets')"));
  edit(run, 'pct', ['0.5', '1']);
  edit(run, 'usd', ['200']);
  assert.ok(state.cloudPending.has('risk_pct_presets'), 'the % list goes to the account');
  assert.ok(state.cloudPending.has('risk_usd_presets'), 'and the $ list');
  // another device's lists arrive
  run("store.set('risk_pct_presets', '[2,0.25]'); store.set('risk_usd_presets', '[900,300]'); cloudRehydrate()");
  assert.deepEqual(pctChips(elements), ['0.25 .25%', '2 2%']);
  assert.deepEqual(usdChips(elements), [300, 900]);
});
