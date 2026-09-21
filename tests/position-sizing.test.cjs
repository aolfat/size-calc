// Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const init = script.indexOf('syncSuppress = true; // init');
assert.ok(init > 0, 'Locate initialization separately from the app functions');

function app() {
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const attrs = match[0];
    elements.set(match[1], {
      value: attrs.match(/\bvalue="([^"]*)"/)?.[1] || '',
      style: {}, classList: { toggle() {}, add() {}, remove() {} },
      innerHTML: '', textContent: '', focus() {}, addEventListener() {}, setAttribute() {}, removeAttribute() {},
    });
  }
  const storage = new Map();
  const context = vm.createContext({
    document: {
      getElementById: id => { assert.ok(elements.has(id), `Missing #${id}`); return elements.get(id); },
      querySelector: selector => selector === '.app' ? elements.get('app') : null,
      querySelectorAll: () => [],
      documentElement: { style: { setProperty() {} } },
    },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    window: { scrollY: 0 },
    navigator: {},
    setTimeout() {}, clearTimeout() {}, clearInterval() {},
  });
  vm.runInContext(script.slice(0, init), context);
  return { run: code => vm.runInContext(code, context), elements, storage };
}

test('existing quantity rounding and reverse sizing stay consistent', () => {
  const { run } = app();
  assert.equal(run('unitsFor(0.3, 0.1)'), 3);
  assert.equal(run('unitsFor(riskForQty(12, 1.27), 1.27)'), 12);
});

test('existing shares sizing works for both directions', () => {
  const { run, elements } = app();
  run("quoteData = { symbol: 'TEST', last: 100, low: 98, high: 102 }; renderShares();");
  assert.match(elements.get('sharesStats').innerHTML, /value="250"/);
  run("setDirection('short')");
  assert.match(elements.get('sharesStats').innerHTML, /value="250"/);
  assert.match(elements.get('sharesStats').innerHTML, /to short/);
});

test('shares card identifies default and custom stops independently of the price', () => {
  const { run, elements } = app();
  run("quoteData = { symbol: 'TEST', last: 100, low: 98, high: 102 }; renderShares();");
  assert.match(elements.get('sharesStats').innerHTML, /Stop price/);
  assert.match(elements.get('sharesStats').innerHTML, /Low of day/);
  elements.get('stopLong').value = '98';
  run('renderShares()');
  assert.match(elements.get('sharesStats').innerHTML, /Custom stop/);
  assert.doesNotMatch(elements.get('sharesStats').innerHTML, /Low of day/);
  run("setDirection('short')");
  assert.match(elements.get('sharesStats').innerHTML, /High of day/);
  elements.get('stopShort').value = '103';
  run('renderShares()');
  assert.match(elements.get('sharesStats').innerHTML, /Custom stop/);
  assert.match(elements.get('sharesStats').innerHTML, /\$103\.00/);
});

test('shares card retains planned entry and reverse sizing with a custom stop', () => {
  const { run, elements } = app();
  run("quoteData = { symbol: 'TEST', last: 100, low: 98, high: 102 };");
  elements.get('entryPrice').value = '101';
  elements.get('stopLong').value = '99.73';
  run("sharesQtyChanged({ value: '12' })");
  assert.equal(+elements.get('riskDollar').value, 15.24);
  const card = elements.get('sharesStats').innerHTML;
  assert.match(card, /value="12"/);
  assert.match(card, /Entry.*\$101\.00/);
  assert.match(card, /Custom stop/);
  assert.match(card, /\$1,212\.00/);
});

test('invalid stops disable both share actions and valid stops enable them again', () => {
  const { run, elements } = app();
  run("quoteData = { symbol: 'TEST', last: 100, low: 98, high: 102 }; renderShares();");
  for (const id of ['sharesImage', 'sharesCopy']) assert.equal(elements.get(id).disabled, false);
  elements.get('stopLong').value = '101';
  run('renderShares()');
  assert.match(elements.get('sharesStats').innerHTML, /must be below entry/);
  for (const id of ['sharesImage', 'sharesCopy']) assert.equal(elements.get(id).disabled, true);
  elements.get('stopLong').value = '';
  run('renderShares()');
  for (const id of ['sharesImage', 'sharesCopy']) assert.equal(elements.get(id).disabled, false);
});

test('image and compact summary share the selected stop without exposing the account balance', () => {
  const { run, elements } = app();
  run("quoteData = { symbol: 'TEST', last: 100, low: 98, high: 102 }; var sharedSpec, copiedText; drawShareCard = spec => { sharedSpec = spec; return {}; }; shareCanvasToClipboard = () => {}; copyPlainText = text => { copiedText = text; };");
  elements.get('accountSize').value = '123456';
  elements.get('stopLong').value = '98';
  run('shareShares(); copyShares();');
  assert.equal(run("sharedSpec.stats.find(stat => stat.label === 'Stop').value"), '$98.00');
  assert.match(run("sharedSpec.stats.find(stat => stat.label === 'Stop').sub"), /Custom stop/);
  assert.match(run('copiedText'), /bought \$TEST @ 100\.00 with stop at 98\.00/);
  assert.match(run('copiedText'), /risk .*% of account.*to risk \$100: 50 shares/);
  assert.doesNotMatch(run('JSON.stringify(sharedSpec) + copiedText'), /123,?456/);
  elements.get('stopLong').value = '';
  run('shareShares();');
  assert.match(run("sharedSpec.stats.find(stat => stat.label === 'Stop').sub"), /LOD/);
  run("setDirection('short'); shareShares(); copyShares();");
  assert.match(run("sharedSpec.stats.find(stat => stat.label === 'Stop').sub"), /HOD/);
  assert.match(run('copiedText'), /shorted \$TEST @ 100\.00 with stop at 102\.00/);
});

const specs = [
  ['ES', 0.25, 12.5], ['MES', 0.25, 1.25],
  ['NQ', 0.25, 5], ['MNQ', 0.25, 0.5],
  ['YM', 1, 5], ['MYM', 1, 0.5],
  ['RTY', 0.1, 5], ['M2K', 0.1, 0.5],
  ['CL', 0.01, 10], ['MCL', 0.01, 1],
  ['GC', 0.1, 10], ['MGC', 0.1, 1],
];
for (const [symbol, tickSize, tickValue] of specs) {
  test(`${symbol}: ten-tick stop uses the correct dollar risk and whole contracts`, () => {
    const { run } = app();
    assert.equal(run(`FUTURES_CONTRACTS.${symbol}.tickSize`), tickSize);
    assert.equal(run(`FUTURES_CONTRACTS.${symbol}.tickValue`), tickValue);
    const result = run(`calcFutures({ risk: 500, entry: 100, stop: ${100 - tickSize * 10}, direction: 'long', ...FUTURES_CONTRACTS.${symbol}, fees: 0 })`);
    assert.equal(result.error, undefined);
    assert.equal(result.ticks, 10);
    assert.equal(result.riskPerContract, tickValue * 10);
    assert.equal(result.contracts, Math.floor(500 / (tickValue * 10)));
    assert.ok(result.totalRisk <= 500);
  });
}

test('fees count toward risk and a short stop is above entry', () => {
  const { run } = app();
  const result = run("calcFutures({ risk: 500, entry: 6000, stop: 6005, direction: 'short', ...FUTURES_CONTRACTS.ES, fees: 5 })");
  assert.equal(result.contracts, 1);
  assert.equal(result.riskPerContract, 255);
  assert.equal(result.totalRisk, 255);
});

test('insufficient and zero budgets return zero contracts', () => {
  const { run } = app();
  for (const risk of [0, 249.99]) {
    const result = run(`calcFutures({ risk: ${risk}, entry: 6000, stop: 5995, direction: 'long', ...FUTURES_CONTRACTS.ES, fees: 0 })`);
    assert.equal(result.contracts, 0);
    assert.equal(result.totalRisk, 0);
  }
});

test('custom tick sizes work, including negative futures prices', () => {
  const { run } = app();
  const result = run("calcFutures({ risk: 100, entry: -10, stop: -10.03125, direction: 'long', tickSize: 0.015625, tickValue: 15.625, fees: 0 })");
  assert.equal(result.ticks, 2);
  assert.equal(result.contracts, 3);
  assert.equal(result.totalRisk, 93.75);
});

test('invalid inputs cannot produce a position size', () => {
  const { run } = app();
  const invalid = [
    "entry: NaN", "stop: NaN", "entry: Infinity", "stop: 6000", "stop: 6001",
    "direction: 'short'", "direction: 'other'", "tickSize: 0", "tickValue: -1",
    "tickSize: Infinity", "risk: -1", "risk: Infinity", "fees: -1", "fees: NaN",
    "entry: 6000.1, stop: 5995.1", "stop: 5995.1",
  ];
  for (const override of invalid) {
    const result = run(`calcFutures({ risk: 500, entry: 6000, stop: 5995, direction: 'long', tickSize: 0.25, tickValue: 12.5, fees: 0, ${override} })`);
    assert.ok(result.error, override);
    assert.equal(result.contracts, undefined, override);
  }
});

test('futures reverse sizing and shared risk changes update without a quote', async () => {
  const { run, elements } = app();
  elements.get('futuresContract').value = 'MES';
  run('futuresContractChanged()');
  elements.get('futuresEntry').value = '6000';
  elements.get('futuresStop').value = '5995';
  run('renderFutures()');
  assert.match(elements.get('futuresStats').innerHTML, /value="20"/);
  run("futuresQtyChanged({ value: '3' })");
  assert.equal(+elements.get('riskDollar').value, 75);
  assert.match(elements.get('futuresStats').innerHTML, /value="3"/);
  run('setRiskUsd(100)');
  assert.match(elements.get('futuresStats').innerHTML, /value="4"/);
  run('setRiskPct(1)');
  assert.match(elements.get('futuresStats').innerHTML, /value="20"/);
});

test('futures view hides equity surfaces and survives Positions and Tools navigation', async () => {
  const { run, elements } = app();
  run("quoteData = { symbol: 'TEST', last: 100, low: 98, high: 102 };");
  await run("setMode('futures')");
  assert.notEqual(elements.get('futuresSection').style.display, 'none');
  for (const id of ['sizingControls', 'quickCard', 'quoteSection', 'chartWrap', 'pinnedSection']) {
    assert.equal(elements.get(id).style.display, 'none', id);
  }
  for (const view of ['positions', 'utils']) {
    run(`setView('${view}')`);
    assert.equal(elements.get('futuresSection').style.display, 'none');
    run("setView('calc')");
    assert.notEqual(elements.get('futuresSection').style.display, 'none');
  }
  await run("setMode('shares')");
  assert.equal(elements.get('futuresSection').style.display, 'none');
  assert.notEqual(elements.get('quoteSection').style.display, 'none');
});

test('fractional-dollar futures risk survives mode switches and rehydration', async () => {
  const { run, elements } = app();
  elements.get('futuresContract').value = 'MES';
  run('futuresContractChanged()');
  elements.get('futuresEntry').value = '6000';
  elements.get('futuresStop').value = '5999.75';
  run("futuresQtyChanged({ value: '3' })");
  assert.equal(+elements.get('riskDollar').value, 3.75);
  await run("setMode('futures')");
  assert.equal(+elements.get('riskDollar').value, 3.75);
  run('loadKey(); syncRiskDollar(); renderFutures();');
  assert.equal(+elements.get('riskDollar').value, 3.75);
  assert.match(elements.get('futuresStats').innerHTML, /value="3"/);
  run('setRiskPct(0.125)');
  assert.equal(+elements.get('riskDollar').value, 62.5);
});
