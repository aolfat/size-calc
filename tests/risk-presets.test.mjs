// Run with: node --test
// The risk strip's preset chips: one row, every chip its dollars over its percent of the account (owner request), smallest
// first. Each keeps the unit it was added in (a % chip follows the account size). Edit puts a × on each chip and an add
// box that takes dollars or a percent; at most 6 of each, synced with your account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

/** the chips as drawn: 'kind value $ %' */
const chips = elements => [...elements.get('riskPresets').innerHTML.matchAll(/data-kind="(\w+)" data-value="([\d.]+)"[^>]*><span class="rc-usd">([^<]*)<\/span><span class="rc-pct">([^<]*)</g)]
  .map(m => `${m[1]} ${m[2]} ${m[3]} ${m[4]}`);

async function account(opts = {}, size = 50000) {
  const a = await app(opts);
  a.run(`document.getElementById('accountSize').value = ${size}`);
  a.run('renderRiskPresets()');
  return a;
}

/** Edit, type into the add box with a unit, Add */
function add(run, elements, text, unit = 'usd') {
  if (!run('state.editingRisk')) run('toggleRiskEdit()');
  run(`setRiskAddUnit('${unit}')`);
  elements.get('riskAddInput').value = text;
  run('addRiskPreset()');
}

test('one row: the % and $ defaults merged smallest first, dollars over percent on every chip; a $ that matches a % chip shows once', async () => {
  const { elements } = await account();
  assert.deepEqual(chips(elements), [
    'pct 0.125 $62.50 .125%', 'usd 100 $100 .2%', 'pct 0.25 $125 .25%', 'pct 0.5 $250 .50%', 'pct 1 $500 1%', 'pct 2 $1,000 2%', 'pct 3 $1,500 3%',
  ]);
  assert.equal(elements.get('riskPresets').style.gridTemplateColumns, 'repeat(4, minmax(0, 1fr))', 'seven chips: two rows of four');
  assert.match(elements.get('riskPresets').innerHTML, /data-action="setRiskPct" data-arg="0.125"/);
  assert.match(elements.get('riskPresets').innerHTML, /data-action="setRiskUsd" data-arg="100"/);
  assert.match(elements.get('riskPresets').innerHTML, /aria-label="\$100, \.2% of the account"/);
  assert.equal(elements.get('riskEditBtn').textContent, 'Edit');
  assert.equal(elements.get('riskAddRow').style.display, 'none');
});

test('the owner\'s presets at $72,266: twelve chips in two rows of six, a $ chip says what it is of the account', async () => {
  const storage = new Map([['risk_usd_presets', '[25,50,100,250,500,1000]']]);
  const { elements } = await account({ storage }, 72266);
  assert.deepEqual(chips(elements).map(c => c.split(' ').slice(2).join(' ')), [
    '$25 .035%', '$50 .069%', '$90.33 .125%', '$100 .138%', '$181 .25%', '$250 .346%',
    '$361 .50%', '$500 .692%', '$723 1%', '$1,000 1.38%', '$1,445 2%', '$2,168 3%',
  ]);
  assert.equal(elements.get('riskPresets').style.gridTemplateColumns, 'repeat(6, minmax(0, 1fr))');
});

test('a tap sets the max loss and lights its chip; a % chip follows the account size', async () => {
  const { run, elements } = await account();
  run('setRiskUsd(100)');
  assert.equal(+elements.get('riskDollar').value, 100);
  assert.match(elements.get('riskPresets').innerHTML, /data-kind="usd" data-value="100"/);
  run('setRiskPct(0.25)');
  assert.equal(+elements.get('riskDollar').value, 125);
  run("document.getElementById('accountSize').value = 80000; syncRiskDollar()");
  assert.equal(+elements.get('riskDollar').value, 200);
  assert.ok(chips(elements).includes('pct 0.25 $200 .25%'), 'the chip redraws with the new dollars');
});

test('a % chip lights by its dollars too: stepping or typing onto them, not only tapping it', async () => {
  const { run, elements } = await account({}, 72266);
  run('setRiskUsd(90.33)'); // what - / = sets on the way to .125%
  const lit = [];
  document.querySelectorAll = sel => sel === '#riskPresets .risk-chip'
    ? [...elements.get('riskPresets').innerHTML.matchAll(/data-kind="(\w+)" data-value="([\d.]+)" data-usd="([\d.]+)"/g)].map(m => ({
        dataset: { kind: m[1], value: m[2], usd: m[3] }, classList: { toggle: (c, on) => { if (on) lit.push(m[2]); } },
      }))
    : [];
  run('updateRiskPresets()');
  assert.deepEqual(lit, ['0.125']);
});

test('Edit: a × on every chip and the add box; Done puts them away', async () => {
  const { run, elements, state } = await account();
  run('toggleRiskEdit()');
  assert.equal(state.editingRisk, true);
  assert.equal(elements.get('riskEditBtn').textContent, 'Done');
  assert.equal(elements.get('riskAddRow').style.display, '');
  assert.equal([...elements.get('riskPresets').innerHTML.matchAll(/class="risk-chip-x"/g)].length, 7);
  assert.match(elements.get('riskPresets').innerHTML, /data-action="removeRiskPreset" data-arg="usd" data-arg2="100" aria-label="Remove \$100, \.2% of the account"/);
  run('toggleRiskEdit()');
  assert.equal(state.editingRisk, false);
  assert.doesNotMatch(elements.get('riskPresets').innerHTML, /risk-chip-x/);
});

test('add a preset in dollars or in percent; a typed % wins over the $ unit; saved smallest first in its own list', async () => {
  const storage = new Map();
  const { run, elements, state } = await account({ storage });
  add(run, elements, '75');
  assert.equal(storage.get('risk_usd_presets'), '[75,100,250,500,1000]');
  assert.equal(state.riskAddNote, 'Added $75.');
  assert.equal(elements.get('riskAddInput').value, '', 'the box clears for the next one');
  add(run, elements, '0.1', 'pct');
  assert.equal(storage.get('risk_pct_presets'), undefined, 'the % list already has six');
  assert.equal(state.riskAddNote, 'Six percent presets at most. Remove one first.');
  run("removeRiskPreset('pct', 3)");
  add(run, elements, '0.1', 'pct');
  assert.equal(storage.get('risk_pct_presets'), '[0.1,0.125,0.25,0.5,1,2]');
  run("removeRiskPreset('pct', 2)");
  add(run, elements, '1.5%'); // the $ unit is picked, the % sign says otherwise
  assert.equal(storage.get('risk_pct_presets'), '[0.1,0.125,0.25,0.5,1,1.5]');
  add(run, elements, '$1,200');
  assert.equal(storage.get('risk_usd_presets'), '[75,100,250,500,1000,1200]');
  assert.deepEqual(chips(elements).map(c => c.split(' ')[2]), ['$50', '$62.50', '$75', '$100', '$125', '$250', '$500', '$750', '$1,000', '$1,200']);
});

test('add refuses what isn\'t a preset and what is already there', async () => {
  const storage = new Map();
  const { run, elements, state } = await account({ storage });
  add(run, elements, 'abc');
  assert.match(state.riskAddNote, /Type a dollar amount/);
  add(run, elements, '150', 'pct');
  assert.match(state.riskAddNote, /percent under 100/);
  add(run, elements, '500'); // 1% of $50,000 is already a chip
  assert.equal(state.riskAddNote, '$500 is already there.');
  assert.equal(storage.get('risk_usd_presets'), undefined, 'nothing saved');
});

test('removing a chip: × takes it out of its own list, and an emptied list stays empty', async () => {
  const storage = new Map();
  const { run, elements } = await account({ storage });
  run("removeRiskPreset('usd', 100)");
  assert.equal(storage.get('risk_usd_presets'), '[250,500,1000]');
  for (const v of [250, 500, 1000]) run(`removeRiskPreset('usd', ${v})`);
  assert.equal(storage.get('risk_usd_presets'), '[]');
  run('renderRiskPresets()');
  assert.ok(chips(elements).every(c => c.startsWith('pct')), 'no $ chips come back as defaults');
  assert.deepEqual(run('getUsdPresets()'), []);
});

test('saved out of order (or synced from before) they still show smallest first; the ladder uses both lists', async () => {
  const { run, elements } = await account({ storage: new Map([['risk_usd_presets', '[500,100,1000,250]'], ['risk_pct_presets', '[1,0.5]']]) }, 10000);
  assert.deepEqual(chips(elements).map(c => c.split(' ')[2]), ['$50', '$100', '$250', '$500', '$1,000']);
  assert.deepEqual(run('riskLadder()'), [50, 100, 250, 500, 1000]);
});

test('both preset lists are account settings: an edit is pending for the cloud, and a pulled list redraws the chips', async () => {
  const storage = new Map([['cloud_user', 'user-1'], ['risk_pct_presets', '[1]'], ['risk_usd_presets', '[100]']]);
  const { run, elements, state } = await app({ storage, session: { user: { id: 'user-1' } } });
  run("document.getElementById('accountSize').value = 10000");
  assert.ok(run("CLOUD_KEYS.includes('risk_pct_presets') && CLOUD_KEYS.includes('risk_usd_presets')"));
  add(run, elements, '0.75', 'pct');
  add(run, elements, '200');
  assert.ok(state.cloudPending.has('risk_pct_presets'), 'the % list goes to the account');
  assert.ok(state.cloudPending.has('risk_usd_presets'), 'and the $ list');
  // another device's lists arrive
  run("store.set('risk_pct_presets', '[2,0.25]'); store.set('risk_usd_presets', '[900,300]'); cloudRehydrate()");
  assert.deepEqual(chips(elements).map(c => c.split(' ').slice(0, 2).join(' ')), ['pct 0.25', 'pct 2', 'usd 300', 'usd 900']);
});

test('allocation sizing hides the chips and Edit, and closes the editor', async () => {
  const { run, elements, state } = await account();
  run('toggleRiskEdit()');
  elements.get('riskAddInput').value = 'abc';
  run('addRiskPreset()');
  assert.notEqual(elements.get('riskAddNote').textContent, '');
  run("setSizingMode('allocation')");
  assert.equal(elements.get('riskAddNote').textContent, '', 'the note goes with the editor');
  assert.equal(elements.get('riskPresets').style.display, 'none');
  assert.equal(elements.get('riskEditBtn').style.display, 'none');
  assert.equal(state.editingRisk, false);
});
