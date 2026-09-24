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

function app(overrides = {}) {
  const elements = new Map();
  const makeElement = () => ({ value: '', style: {}, classList: { toggle() {}, add() {}, remove() {} }, innerHTML: '', textContent: '',
    focus() {}, addEventListener() {}, setAttribute() {}, removeAttribute() {},
    prepend(child) { elements.set(child.id, child); }, appendChild(child) { if (child.id) elements.set(child.id, child); },
    querySelector() { return null; }, remove() { elements.delete(this.id); } });
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const attrs = match[0];
    elements.set(match[1], {
      ...makeElement(), value: attrs.match(/\bvalue="([^"]*)"/)?.[1] || '',
    });
  }
  const storage = new Map();
  const context = vm.createContext({
    document: {
      createElement: makeElement,
      getElementById: id => { assert.ok(elements.has(id), `Missing #${id}`); return elements.get(id); },
      querySelector: selector => selector === '.app' ? elements.get('app') : null,
      querySelectorAll: () => [],
      documentElement: { style: { setProperty() {} } },
    },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    window: { scrollY: 0 },
    navigator: {},
    setTimeout() {}, clearTimeout() {}, clearInterval() {},
    ...overrides,
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

test('ATR uses 14 true ranges, Wilder smoothing, gaps, and only completed five-minute bars', () => {
  const { run } = app();
  run(`var bars = Array.from({ length: 16 }, (_, i) => ({ ts: 1751376600 + i * 300, h: 101, l: 99, c: 100 }));`);
  assert.equal(run('calculateAtr5(bars.slice(0, 14), Infinity)'), null);
  assert.equal(run('calculateAtr5(bars.slice(0, 15), Infinity).value'), 2);
  run('bars[15] = { ...bars[15], h: 105, l: 104, c: 104.5 };');
  assert.equal(run('calculateAtr5(bars, bars[15].ts * 1000 + 299999).value'), 2);
  assert.ok(Math.abs(run('calculateAtr5(bars, (bars[15].ts + 300) * 1000).value') - 31 / 14) < 1e-12);
  assert.equal(run('calculateAtr5(bars.slice().reverse(), Infinity).value'), run('calculateAtr5(bars, Infinity).value'));
  assert.equal(run('calculateAtr5([{ ts: NaN, h: 1, l: 0, c: 1 }], Infinity)'), null);
});

test('missing ATR blocks sizing without falling back and manual stops still work', () => {
  const { run, elements } = app();
  run("quoteData = { symbol: 'TEST', last: 100, low: 99, high: 102 }; atr5 = { symbol: 'OTHER', value: 0.5 }; setAtrMultiplier(0.5);");
  assert.ok(Number.isNaN(run('stopLongVal()')));
  assert.equal(elements.get('sharesCopy').disabled, true);
  assert.match(elements.get('sharesStats').innerHTML, /ATR.*unavailable/);
  assert.equal(run("calcOpt({ option_type: 'call' }, 100, stopLongVal(), stopShortVal(), 500, 0, 0)"), null);
  elements.get('stopLong').value = '98';
  run('stopsChanged()');
  assert.equal(elements.get('sharesCopy').disabled, false);
  assert.match(elements.get('sharesStats').innerHTML, /value="250"/);
  elements.get('stopLong').value = '';
  run('setAtrMultiplier(0)');
  assert.equal(run('stopLongVal()'), 99);
});

test('five-minute ATR buffer moves the stop and keeps the dollar risk budget', () => {
  const { run, elements, storage } = app();
  run("quoteData = { symbol: 'TEST', last: 100, low: 99, high: 102 }; atr5 = { symbol: 'TEST', value: 0.5, asOf: 1751376600 }; setAtrMultiplier(0.5);");
  assert.equal(run('stopLongVal()'), 98.75);
  assert.equal(run('stopShortVal()'), 102.25);
  assert.match(elements.get('sharesStats').innerHTML, /value="400"/);
  assert.match(elements.get('sharesStats').innerHTML, /LOD.*0\.5× ATR/);
  assert.match(elements.get('sharesStats').innerHTML, /\$500\.00/);
  assert.equal(storage.get('atr_multiplier'), '0.5');
  run("setDirection('short')");
  assert.match(elements.get('sharesStats').innerHTML, /value="222"/);
  assert.match(elements.get('sharesStats').innerHTML, /HOD.*0\.5× ATR/);
  run("sharesQtyChanged({ value: '12' })");
  assert.equal(+elements.get('riskDollar').value, 27);
});

test('ATR buffer rounds outward independently of entry and manual stops override it', () => {
  const { run, elements } = app();
  run("quoteData = { symbol: 'TEST', last: 100, low: 99.73, high: 102 }; atr5 = { symbol: 'TEST', value: 0.27, asOf: 1751376600 }; setAtrMultiplier(0.5);");
  assert.equal(run('stopLongVal()'), 99.59);
  elements.get('entryPrice').value = '101';
  assert.equal(run('stopLongVal()'), 99.59);
  assert.equal(run('stopShortVal()'), 102.14);
  elements.get('stopLong').value = '99.73';
  elements.get('stopShort').value = '103';
  run('stopsChanged()');
  assert.equal(run('stopLongVal()'), 99.73);
  assert.equal(run('stopShortVal()'), 103);
  assert.match(elements.get('sharesStats').innerHTML, /Custom stop/);
  run("sharesQtyChanged({ value: '12' })");
  assert.equal(+elements.get('riskDollar').value, 15.24);
  elements.get('stopLong').value = '';
  run('setAtrMultiplier(0)');
  assert.equal(run('stopLongVal()'), 99.73);
});

test('buffered stop is shared by chart overlays, images, summaries and option estimates', () => {
  const { run, elements } = app();
  run("quoteData = { symbol: 'TEST', last: 100, low: 99, high: 102 }; atr5 = { symbol: 'TEST', value: 0.5, asOf: 1751376600 }; setAtrMultiplier(0.5); var sharedSpec, copiedText; drawShareCard = spec => { sharedSpec = spec; return {}; }; shareCanvasToClipboard = () => {}; copyPlainText = text => { copiedText = text; }; shareShares(); copyShares();");
  assert.equal(run('chartStopVal(true)'), 98.75);
  assert.equal(run("sharedSpec.stats.find(stat => stat.label === 'Stop').value"), '$98.75');
  assert.match(run("sharedSpec.stats.find(stat => stat.label === 'Stop').sub"), /LOD.*0\.5× ATR/);
  assert.match(run('copiedText'), /stop at 98\.75.*to risk \$100: 80 shares/);
  run("var opt = { option_type: 'call', strike: 100, bid: 5, ask: 5, greeks: { delta: 0.5 } }; var estimate = calcOpt(opt, 100, stopLongVal(), stopShortVal(), 500, 0, 0);");
  assert.equal(run('estimate.lossPerContract'), 62.5);
  assert.equal(run('estimate.contracts'), 8);
  run('setAtrMultiplier(0)');
  assert.equal(run('chartStopVal(true)'), 0);
  elements.get('stopLong').value = '98';
  assert.equal(run('chartStopVal(true)'), 98);
});

test('invalid levels and nonpositive buffered prices cannot produce share sizing', () => {
  const { run, elements } = app();
  for (const quote of [
    { symbol: 'TEST', last: 100, low: 0, high: 102 },
    { symbol: 'TEST', last: 100, low: 0.1, high: 102 },
    { symbol: 'TEST', last: 100, low: 101, high: 102 },
  ]) {
    run(`quoteData = ${JSON.stringify(quote)}; atr5 = { symbol: 'TEST', value: 0.25 }; setAtrMultiplier(2);`);
    for (const id of ['sharesImage', 'sharesCopy']) assert.equal(elements.get(id).disabled, true);
    assert.doesNotMatch(elements.get('sharesStats').innerHTML, /id="sharesQty"/);
  }
});

test('multiplier preference restores safely and is included in backups', () => {
  const { run, storage } = app();
  storage.set('atr_multiplier', '1.5');
  run('loadKey()');
  assert.equal(run('atrMultiplier'), 1.5);
  assert.ok(run("BACKUP_KEYS.includes('atr_multiplier')"));
  for (const value of ['NaN', 'Infinity', '-1', '999', '1.25oops']) {
    storage.set('atr_multiplier', value);
    run('loadKey()');
    assert.equal(run('atrMultiplier'), 0);
  }
});

test('ATR stays on five-minute data across chart intervals, ignores stale requests, and clears on failure', async () => {
  const pending = [];
  const { run, elements } = app({ fetch: () => new Promise(resolve => pending.push(resolve)) });
  elements.get('ticker').value = 'TEST';
  run("quoteData = { symbol: 'TEST', last: 100, low: 99, high: 102 }; drawChart = () => {}; setAtrMultiplier(0.5);");
  const bars = Array.from({ length: 16 }, (_, i) => ({ timestamp: 1751376600 + i * 300, time: `2025-07-01T${String(9 + Math.floor((30 + i * 5) / 60)).padStart(2, '0')}:${String((30 + i * 5) % 60).padStart(2, '0')}:00`, open: 100, high: 100.25, low: 99.75, close: 100, volume: 1 }));
  const respond = (resolve, data) => resolve({ ok: true, json: async () => ({ series: { data } }) });
  const first = run("fetchChart('TEST')");
  respond(pending.shift(), bars);
  await first;
  assert.equal(run('atr5.value'), 0.5);
  assert.equal(run('stopLongVal()'), 98.75);
  const stale = run("fetchChart('TEST')");
  run('chartInterval = 30');
  const latest = run("fetchChart('TEST')");
  respond(pending.pop(), bars);
  await latest;
  assert.equal(run('atr5.value'), 0.5);
  assert.equal(run('chartBars.length'), 3);
  respond(pending.shift(), bars.map(b => ({ ...b, high: 110, low: 90 })));
  await stale;
  assert.equal(run('atr5.value'), 0.5);
  const failed = run("fetchChart('TEST')");
  pending.shift()({ ok: false });
  await failed;
  assert.equal(run('atr5'), null);
  assert.equal(elements.get('sharesCopy').disabled, true);
});

test('quick lookup snapshots the buffered stop and quote refresh preserves that price', async () => {
  let underlying = { symbol: 'TEST', last: 100, low: 99, high: 102 };
  const { run, elements } = app({ fetch: async url => ({ ok: true, json: async () => ({ quotes: { quote: url.includes('greeks=true')
    ? { type: 'option', bid: 5, ask: 5, greeks: { delta: 0.5 } } : underlying } }) }) });
  elements.get('apiKey').value = 'test-only';
  elements.get('quickInput').value = 'TEST 100 12/18/26';
  run("quoteData = { symbol: 'TEST', last: 100, low: 99, high: 102 }; atr5 = { symbol: 'TEST', value: 0.5, asOf: 1751376600 }; setAtrMultiplier(0.5);");
  await run('fetchQuickOption()');
  assert.equal(run('Object.values(pinnedData)[0]?.stopLevel'), 98.75);
  assert.match(run('Object.values(pinnedData)[0].stopName'), /ATR.*fixed/);
  underlying = { ...underlying, last: 102, low: 98 };
  run('atr5.value = 2; setAtrMultiplier(2);');
  await run('refreshCardData(Object.values(pinnedData)[0])');
  assert.equal(run('Object.values(pinnedData)[0].stopLevel'), 98.75);
});

test('percentage wiggle room uses the level price, works without ATR, and preserves risk sizing', () => {
  const { run, elements } = app();
  run("quoteData = { symbol: 'TEST', last: 101, low: 100, high: 102 }; setStopPercent(0.05);");
  assert.equal(run('stopLongVal()'), 99.95);
  assert.equal(run('stopShortVal()'), 102.06); // 102.051 rounds outward to a cent
  assert.equal(run('chartStopVal(true)'), 99.95);
  assert.match(elements.get('sharesStats').innerHTML, /LOD.*0\.05%/);
  assert.match(elements.get('sharesStats').innerHTML, /value="476"/);
  assert.equal(elements.get('sharesCopy').disabled, false);
  elements.get('entryPrice').value = '103';
  run('stopsChanged()');
  assert.equal(run('stopLongVal()'), 99.95);
  run("sharesQtyChanged({ value: '12' })");
  assert.equal(+elements.get('riskDollar').value, 36.6);
  elements.get('stopLong').value = '99';
  run('stopsChanged()');
  assert.equal(run('stopLongVal()'), 99);
  assert.match(elements.get('sharesStats').innerHTML, /Custom stop/);
});

test('strategy switching keeps ATR and percentage amounts independent', () => {
  const { run, elements } = app();
  run("quoteData = { symbol: 'TEST', last: 101, low: 100, high: 102 }; atr5 = { symbol: 'TEST', value: 0.5, asOf: 1751376600 }; setAtrMultiplier(1.5); setStopPercent(0.075);");
  assert.equal(run('stopLongVal()'), 99.92);
  run("setStopStrategy('atr')");
  assert.equal(run('stopLongVal()'), 99.25);
  assert.equal(elements.get('atrPresets').style.display, 'flex');
  assert.equal(elements.get('percentControls').style.display, 'none');
  run("setStopStrategy('percent')");
  assert.equal(run('stopLongVal()'), 99.92);
  assert.equal(elements.get('percentControls').style.display, 'flex');
  run("setStopStrategy('none')");
  assert.equal(run('stopLongVal()'), 100);
  assert.equal(run('chartStopVal(true)'), 0);
  run("setStopStrategy('percent')");
  assert.equal(run('stopLongVal()'), 99.92);
});

test('percentage values are validated without silently sizing an unbuffered trade', () => {
  const { run, elements } = app();
  run("quoteData = { symbol: 'TEST', last: 101, low: 100, high: 102 };");
  for (const value of ['', '-0.05', '100', 'Infinity', '0.05oops']) {
    run(`setStopPercent(${JSON.stringify(value)})`);
    assert.ok(Number.isNaN(run('stopLongVal()')), value);
    assert.equal(elements.get('sharesCopy').disabled, true);
    assert.match(elements.get('sharesStats').innerHTML, /percentage/i);
  }
  run('setStopPercent(0)');
  assert.equal(run('stopLongVal()'), 100);
  assert.equal(elements.get('sharesCopy').disabled, false);
});

test('strategy preferences restore including migration from existing ATR settings', () => {
  const { run, storage, elements } = app();
  storage.set('atr_multiplier', '1.5');
  run('loadKey()');
  assert.equal(run('stopStrategy'), 'atr');
  run('setStopPercent(0.05); loadKey();');
  assert.equal(run('stopStrategy'), 'percent');
  assert.equal(run('stopPercent'), 0.05);
  assert.equal(elements.get('stopPercent').value, '0.05');
  assert.equal(run('atrMultiplier'), 1.5);
  assert.ok(run("BACKUP_KEYS.includes('stop_strategy') && BACKUP_KEYS.includes('stop_percent')"));
  run("setStopStrategy('none'); loadKey();");
  assert.equal(run('stopStrategy'), 'none');
  storage.set('stop_percent', '999');
  storage.set('stop_strategy', 'unsupported');
  run('loadKey()');
  assert.equal(run('stopStrategy'), 'none');
  assert.equal(run('stopPercent'), 0.05);
});

test('percentage adjustment reaches share images, summaries, and option loss estimates', () => {
  const { run } = app();
  run("quoteData = { symbol: 'TEST', last: 101, low: 100, high: 102 }; setStopPercent(0.05); var spec, summary; drawShareCard = s => { spec = s; return {}; }; shareCanvasToClipboard = () => {}; copyPlainText = s => { summary = s; }; shareShares(); copyShares();");
  assert.equal(run("spec.stats.find(s => s.label === 'Stop').value"), '$99.95');
  assert.match(run("spec.stats.find(s => s.label === 'Stop').sub"), /LOD.*0\.05%/);
  assert.match(run('summary'), /stop at 99\.95/);
  const risk = run("calcOpt({ option_type:'call', strike:101, bid:5, ask:5, greeks:{delta:0.5} }, 101, stopLongVal(), stopShortVal(), 500, 0, 0).lossPerContract");
  assert.ok(Math.abs(risk - 52.5) < 1e-9);
});

test('other-ticker percentage lookup skips ATR requests and freezes its own buffered stop', async () => {
  const requests = [];
  const { run, elements } = app({ fetch: async url => {
    requests.push(url);
    if (url.includes('timesales')) throw new Error('Percentage adjustment must not fetch ATR');
    return { ok: true, json: async () => ({ quotes: { quote: url.includes('greeks=true')
      ? { type: 'option', bid: 5, ask: 5, greeks: { delta: 0.5 } }
      : { symbol: 'OTHER', last: 101, low: 100, high: 102 } } }) };
  } });
  elements.get('apiKey').value = 'test-only';
  elements.get('quickInput').value = 'OTHER 100 12/18/26';
  run("quoteData = { symbol: 'TEST', last: 90, low: 89, high: 91 }; setAtrMultiplier(1.5); setStopPercent(0.05);");
  await run('fetchQuickOption()');
  assert.equal(requests.length, 2);
  assert.equal(run('Object.values(pinnedData)[0]?.stopLevel'), 99.95);
  assert.match(run('Object.values(pinnedData)[0].stopName'), /0\.05%.*fixed/);
  await run('refreshCardData(Object.values(pinnedData)[0])');
  assert.equal(run('Object.values(pinnedData)[0].stopLevel'), 99.95);
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

test('allocation sizes full assignment notional and includes existing exposure', () => {
  const { run } = app();
  const size = extra => run(`calcAllocation({ account: 150000, pct: 10, existing: 0, unitCost: 6500, ${extra} })`);
  const r = size('');
  assert.equal(r.units, 2);
  assert.equal(r.commitment, 13000);
  assert.equal(r.actualPct, 13000 / 150000 * 100);
  const partial = size('existing: 5000');
  assert.equal(partial.units, 1);
  assert.equal(partial.totalExposure, 11500);
  assert.match(size('existing: 10000').reason, /cannot fit one/);
  assert.match(size('existing: 15000').reason, /already used/);
  assert.match(size('existing: 16000').reason, /exceeds/);
  assert.equal(size('existing: 16000').units, 0);
  assert.equal(size('pct: 5, unitCost: 30').units, 250);
  assert.equal(size('unitCost: 210').units, 71);
  assert.equal(size('account: 3, pct: 10, unitCost: 0.1').units, 3);
  assert.equal(size('unitCost: 6500.01, account: 13000.01, pct: 100').units, 1);
});

test('invalid allocation inputs never produce a tradable quantity', () => {
  const { run } = app();
  for (const bad of ['account: 0', 'account: NaN', 'pct: -1', 'pct: 101', 'existing: -1', 'existing: Infinity', 'unitCost: 0', 'unitCost: NaN']) {
    const r = run(`calcAllocation({ account: 150000, pct: 10, existing: 0, unitCost: 6500, ${bad} })`);
    assert.ok(r.error, bad);
    assert.equal(r.units, 0);
  }
});

test('short put metrics distinguish commitment, premium, maximum loss and simple annualization', () => {
  const { run } = app();
  const r = run('shortPutMetrics(65, 2.1, 2, 18)');
  assert.equal(r.notional, 13000);
  assert.equal(r.premium, 420);
  assert.equal(r.basis, 62.9);
  assert.equal(r.maxLoss, 12580);
  assert.equal(r.returnOnNotional, 2.1 / 65);
  assert.equal(r.annualized, 2.1 / 65 * 365 / 18);
  assert.equal(run('shortPutMetrics(65, 2.1, 0, 0).annualized'), null);
});

test('allocation shares ignore stops, reverse-size allocation only, and preserve risk on mode changes', async () => {
  const { run, elements } = app();
  elements.get('accountSize').value = '150000';
  elements.get('allocationPct').value = '5';
  run("quoteData = { symbol: 'TEST', last: 30, low: 30, high: 30 }; setSizingMode('allocation');");
  assert.match(elements.get('sharesStats').innerHTML, /value="250"/);
  assert.doesNotMatch(elements.get('sharesStats').innerHTML, /Stop price|Risk at stop/);
  const risk = +elements.get('riskDollar').value;
  run("sharesQtyChanged({ value: '100' })");
  assert.equal(+elements.get('allocationPct').value, 2);
  assert.equal(+elements.get('riskDollar').value, risk);
  await run("setMode('futures')");
  assert.equal(run('sizingMode'), 'risk');
  assert.equal(+elements.get('riskDollar').value, risk);
});

test('allocation option selection validates quotes and does not require Greeks or a stop', () => {
  const { run, elements } = app();
  elements.get('accountSize').value = '150000';
  elements.get('allocationPct').value = '10';
  run("sizingMode = 'allocation'; optionTradeSide = 'sell-put'; quoteData = { symbol: 'RKLB', type: 'stock', last: 68 }; selectedExp = '2099-01-16';");
  const calc = fields => run(`calcOpt({ symbol: 'TEST', root_symbol: 'RKLB', option_type: 'put', strike: 65, bid: 2, ask: 2.2, contract_size: 100, ${fields} }, 68, 0, 0, 500, 18/365, 0)`);
  const r = calc('');
  assert.equal(r.contracts, 2);
  assert.equal(r.shortPut, true);
  assert.equal(r.allocation.commitment, 13000);
  for (const bad of ['bid: null', 'ask: 0', 'bid: 3', 'contract_size: 10', 'root_symbol: "RKLB1"', 'option_type: "call"']) {
    assert.equal(calc(bad).contracts, 0, bad);
    assert.ok(calc(bad).allocation.error, bad);
  }
  run("optionTradeSide = 'buy'");
  assert.equal(calc('').contracts, 71);
  run("quoteData.type = 'index'");
  assert.equal(calc('').contracts, 0);
});

test('short put payoff and simulator use credit minus close with assignment notional as return basis', () => {
  const { run } = app();
  run("var put = { sizing: 'allocation', shortPut: true, credit: true, isCall: false, parsed: { ticker: 'RKLB', strike: 65, expStr: '2099-01-16' }, mid: 2.1, iv: 0.5, underlyingPrice: 68 }; var sim = simParamsFromCard(put, 2.1, 2);");
  assert.equal(run('simReturnBase(sim)'), 65);
  assert.equal(run('optionPnl(put, 2.1, 1.1, 2)'), 200);
  assert.equal(run('optionPnl(put, 2.1, 65, 2)'), -12580);
  assert.equal(run('optionPnl(put, 2.1, 0, 2)'), 420);
  assert.equal(run('sim.qty'), 2);
  assert.equal(run('simParamsFromCard(put, 2.1, 0).qty'), 0);
  assert.equal(run('simReturnBase({ credit: true, width: 10, entry: 2 })'), 8);
});

test('allocation settings are backed up and exposure stays scoped to its ticker', () => {
  const { run, elements, storage } = app();
  run("quoteData = { symbol: 'RKLB', last: 68 }; setSizingMode('allocation');");
  elements.get('existingExposure').value = '5000';
  run('allocationChanged()');
  assert.equal(run("allocationInputs('RKLB').existing"), 5000);
  assert.equal(run("allocationInputs('AAPL').existing"), 0);
  storage.set('calc_allocation', '7');
  run('loadKey()');
  assert.equal(+elements.get('allocationPct').value, 7);
  assert.equal(run('JSON.parse(buildBackup()).data.calc_allocation'), '7');
});

function setupAllocationPut(run) {
  run(`document.getElementById('accountSize').value = '150000'; document.getElementById('allocationPct').value = '10';
    quoteData = { symbol: 'RKLB', type: 'stock', last: 68 }; selectedExp = '2099-01-16'; sizingMode = 'allocation'; optionTradeSide = 'sell-put';
    detailReg.TEST = calcOpt({ symbol: 'TEST', root_symbol: 'RKLB', option_type: 'put', strike: 65, bid: 2, ask: 2.2, contract_size: 100 }, 68, 0, 0, 500, 18/365, 0);
    pinAllocation('TEST'); var pinnedId = Object.keys(pinnedData)[0];
    var copiedText, sharedSpec; copyPlainText = text => { copiedText = text; }; drawShareCard = spec => { sharedSpec = spec; return {}; }; shareCanvasToClipboard = () => {};`);
}

test('pinned and saved allocation trades retain side, quantities, payoff and sharing after mode changes', () => {
  const { run, elements, storage } = app();
  setupAllocationPut(run);
  assert.match(elements.get(run('pinnedId')).innerHTML, /Short put/);
  run("setSizingMode('risk'); copyPinned(pinnedId); sharePinned(pinnedId);");
  assert.match(run('copiedText'), /Sell 2.*assignment notional \$13,000\.00/);
  assert.doesNotMatch(run('copiedText'), /stop|NaN/);
  assert.equal(run("sharedSpec.stats.find(s => s.label === 'Maximum loss').value"), '$12,580.00');
  run("saveCard(pinnedId); var savedId = Object.keys(savedData)[0]; savedData[savedId].mid = 1.1; renderSavedCard(savedId); copySaved(savedId); shareSaved(savedId);");
  assert.equal(run('savedData[savedId].qty'), 2);
  assert.match(elements.get(run('savedId')).innerHTML, /\$200\.00/);
  assert.match(run('copiedText'), /Sell 2.*assignment notional \$13,000\.00/);
  assert.equal(JSON.parse(storage.get('saved_positions'))[run('savedId')].shortPut, true);
  run("for (const id of Object.keys(savedData)) delete savedData[id]; loadSaved();");
  assert.equal(run('savedData[savedId].shortPut'), true);
  assert.equal(run('savedData[savedId].qty'), 2);
});

test('allocation does not save or simulate a phantom contract when no contracts fit', () => {
  const { run } = app();
  setupAllocationPut(run);
  run("exposureBySymbol.RKLB = 10000; saveCard(pinnedId); var simulated = false; openSim = () => { simulated = true; }; simFromPinned(pinnedId); copyPinned(pinnedId);");
  assert.equal(run('Object.keys(savedData).length'), 0);
  assert.equal(run('simulated'), false);
  assert.match(run('copiedText'), /Sell 0/);
});

test('allocation shares copy quantity and exposure without reintroducing stop-based risk', () => {
  const { run, elements } = app();
  elements.get('accountSize').value = '150000';
  elements.get('allocationPct').value = '5';
  run("quoteData = { symbol: 'TEST', last: 30, low: 30, high: 30 }; setSizingMode('allocation'); var copiedText, sharedSpec; copyPlainText = t => { copiedText = t; }; drawShareCard = s => { sharedSpec = s; return {}; }; shareCanvasToClipboard = () => {}; copyShares(); shareShares();");
  assert.match(run('copiedText'), /Buy 250.*5\.00%/);
  assert.doesNotMatch(run('copiedText'), /stop|risk|NaN/);
  assert.equal(run("sharedSpec.stats.find(s => s.label === 'Shares').value"), '250');
});

test('allocation hides stop adjustments and preserves them when risk sizing resumes', () => {
  const { run, elements } = app();
  run("quoteData = { symbol: 'TEST', last: 100, low: 99, high: 102 }; setAtrMultiplier(0.5); setSizingMode('allocation');");
  assert.equal(elements.get('stopAdjustment')?.style.display, 'none');
  assert.equal(elements.get('sharesCopy').disabled, false);
  elements.get('stopLong').value = '98';
  assert.equal(run('chartStopVal(true)'), 0);
  elements.get('stopLong').value = '';
  run("setSizingMode('risk');");
  assert.equal(elements.get('stopAdjustment').style.display, '');
  assert.equal(run('stopStrategy'), 'atr');
  assert.equal(run('atrMultiplier'), 0.5);
  assert.equal(elements.get('sharesCopy').disabled, true);
  assert.match(elements.get('sharesStats').innerHTML, /ATR.*unavailable/);
});

test('allocation quick lookup ignores unavailable ATR even when the mode changes during fetch', async () => {
  for (const symbol of ['RKLB', 'OTHER']) {
    const { run, elements } = app();
    elements.get('apiKey').value = 'fixture';
    elements.get('accountSize').value = '150000';
    elements.get('allocationPct').value = '10';
    elements.get('quickInput').value = 'RKLB 65 put 1/16/2099';
    run(`quoteData = { symbol: '${symbol}', last: 68, low: 66, high: 69 };
      setAtrMultiplier(0.5); currentMode = 'options'; sizingMode = 'allocation'; optionTradeSide = 'sell-put';
      var atrRequests = 0;
      fetch = async url => {
        if (url.includes('timesales')) { atrRequests++; throw new Error('Allocation must not require ATR'); }
        return { json: async () => ({ quotes: { quote: url.includes('greeks=true')
          ? {symbol:'RKLB990116P00065000',type:'option',root_symbol:'RKLB',contract_size:100,bid:2,ask:2.2}
          : {symbol:'RKLB',type:'stock',last:68,low:66,high:69} } }) };
      };
      var request = fetchQuickOption(); setSizingMode('risk');`);
    await run('request');
    assert.equal(run('atrRequests'), 0);
    assert.equal(run('Object.keys(pinnedData).length'), 1);
    assert.equal(run('Object.values(pinnedData)[0].shortPut'), true);
    assert.equal(run('quantityForCard(Object.values(pinnedData)[0])'), 2);
  }
});

test('DTE uses the New York calendar and zero DTE has no annualization', () => {
  const { run } = app();
  assert.equal(run("optionDte('2026-09-21', new Date('2026-09-22T01:00:00Z'))"), 0);
  assert.equal(run("optionDte('2026-10-09', new Date('2026-09-21T16:00:00Z'))"), 18);
});

test('saved annualization retains the original holding window and refresh validates standard contracts', async () => {
  const { run, elements } = app();
  setupAllocationPut(run);
  run("saveCard(pinnedId); var savedId = Object.keys(savedData)[0]; savedData[savedId].entryDte = 18; renderSavedCard(savedId);");
  assert.match(elements.get(run('savedId')).innerHTML, /65\.5% simple annualized/);
  assert.match(elements.get(run('savedId')).innerHTML, /DTE at save/);
  run(`var fixtureResponses = [ { quotes: { quote: {symbol:'RKLB', type:'stock',last:68} } },
    { quotes: { quote: {symbol:'TEST',root_symbol:'RKLB1',contract_size:100,bid:2,ask:2.2} } } ];
    fetch = async () => ({ json: async () => fixtureResponses.shift() });`);
  await run('refreshCardData(pinnedData[pinnedId])');
  assert.equal(run('quantityForCard(pinnedData[pinnedId])'), 0);
});

test('leaving Options clears sell intent and selecting the active sizing mode preserves it', async () => {
  const { run } = app();
  run("currentMode = 'options'; sizingMode = 'allocation'; optionTradeSide = 'sell-put'; setSizingMode('allocation');");
  assert.equal(run('optionTradeSide'), 'sell-put');
  await run("setMode('shares')");
  assert.equal(run('optionTradeSide'), 'buy');
});

test('quick lookup captures sell intent before fetching and spreads retain risk sizing', async () => {
  const { run, elements } = app();
  elements.get('apiKey').value = 'fixture';
  elements.get('accountSize').value = '150000';
  elements.get('allocationPct').value = '10';
  elements.get('quickInput').value = 'RKLB 65 put 1/16/2099';
  run(`currentMode = 'options'; sizingMode = 'allocation'; optionTradeSide = 'sell-put';
    fetch = async url => ({ json: async () => ({quotes:{quote: url.includes('symbols=RKLB&') || url.endsWith('symbols=RKLB')
      ? {symbol:'RKLB', type:'stock',last:68, low:66, high:69}
      : {symbol:'RKLB990116P00065000',type:'option',root_symbol:'RKLB',contract_size:100,bid:2,ask:2.2} }}) });
    var request = fetchQuickOption(); setSizingMode('risk');`);
  await run('request');
  assert.equal(run('Object.values(pinnedData)[0].shortPut'), true);
  assert.equal(run('quantityForCard(Object.values(pinnedData)[0])'), 2);

  elements.get('quickInput').value = 'RKLB 65/70 1/16/2099 cds';
  run(`sizingMode = 'allocation'; optionTradeSide = 'sell-put';
    fetch = async url => ({ json: async () => ({ quotes: { quote: url.includes('greeks=true')
      ? [{symbol:'RKLB990116C00065000',type:'option',bid:2,ask:2.2}, {symbol:'RKLB990116C00070000',type:'option',bid:1,ask:1.2}]
      : {symbol:'RKLB',type:'stock',last:68,low:66,high:69} } }) });`);
  await run('fetchQuickOption()');
  assert.equal(run("Object.values(pinnedData).find(d => d.kind === 'spread').sizing"), undefined);
  assert.equal(run("sizeUnit(Object.values(pinnedData).find(d => d.kind === 'spread'))"), 100);
});
