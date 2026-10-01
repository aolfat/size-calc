// Run with: node --test
// Layout shell: header nav, settings/risk sheets, the shares answer card and the desktop rail.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const init = script.indexOf('syncSuppress = true; // init');
assert.ok(init > 0, 'Locate initialization separately from the app functions');

// the markup between an element's opening tag and the next element at the same nesting depth
function block(id) {
  const start = html.search(new RegExp(`<[a-z]+[^>]*\\bid="${id}"`));
  assert.ok(start >= 0, `Missing #${id}`);
  const tag = html.slice(start + 1).match(/^[a-z]+/)[0];
  let depth = 0;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
  re.lastIndex = start;
  for (let m; (m = re.exec(html));) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, re.lastIndex);
  }
  throw new Error(`Unclosed #${id}`);
}

function app({ width = 1400, fetch } = {}) {
  const elements = new Map();
  const listeners = new Map();
  const makeElement = id => {
    const classes = new Set();
    const attrs = new Map();
    return {
      id, value: '', style: {}, dataset: {}, innerHTML: '', textContent: '', disabled: false,
      classList: {
        toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
        add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains: c => classes.has(c),
      },
      attrs, setAttribute(k, v) { attrs.set(k, String(v)); }, removeAttribute(k) { attrs.delete(k); },
      getAttribute: k => attrs.get(k) ?? null,
      focus() {}, blur() {}, select() {}, addEventListener() {}, scrollIntoView() {},
      prepend(child) { elements.set(child.id, child); }, appendChild(child) { if (child.id) elements.set(child.id, child); },
      querySelector() { return null; }, querySelectorAll() { return []; }, remove() { elements.delete(this.id); },
    };
  };
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const el = makeElement(match[1]);
    el.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
    if (/\bstyle="[^"]*display:\s*none/.test(match[0])) el.style.display = 'none'; // start from the markup's hidden state
    elements.set(match[1], el);
  }
  const storage = new Map();
  const matches = q => q.split(',').some(part => [...part.matchAll(/\((min|max)-width:\s*([\d.]+)px\)/g)]
    .every(([, kind, px]) => kind === 'min' ? width >= +px : width <= +px));
  const context = vm.createContext({
    document: {
      createElement: () => makeElement(''),
      getElementById: id => { assert.ok(elements.has(id), `Missing #${id}`); return elements.get(id); },
      querySelector: selector => selector === '.app' ? elements.get('app') : null,
      querySelectorAll: () => [],
      addEventListener: (type, fn) => listeners.set(type, fn),
      documentElement: { style: { setProperty() {} } },
    },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    window: { scrollY: 0, scrollTo() {}, matchMedia: q => ({ matches: matches(q), addEventListener() {} }) },
    navigator: {},
    fetch: fetch || (async () => { throw new Error('no network in tests'); }),
    setTimeout() {}, clearTimeout() {}, clearInterval() {},
  });
  vm.runInContext(html.match(/<script id="marketLogic">([\s\S]*?)<\/script>/)[1], context);
  vm.runInContext(script.slice(0, init), context);
  vm.runInContext('loadMarket = async () => {};', context); // Market view is covered by market.test.mjs
  return { run: code => vm.runInContext(code, context), elements, listeners };
}

const shown = el => el.style.display !== 'none';

test('header carries the view nav with Positions, the risk pill and the settings button', () => {
  const header = block('appHeader');
  for (const id of ['brandMarket', 'brandSize', 'brandPositions', 'brandTools', 'riskPill', 'settingsBtn']) {
    assert.match(header, new RegExp(`id="${id}"`), id);
  }
  assert.match(block('riskPill'), /id="riskStatus"/);
  assert.match(block('brandPositions'), /id="posCount"/);
  assert.doesNotMatch(block('modeSeg'), /Positions/, 'Positions is a view, not a sizing mode');
});

test('setup lives in sheets: settings holds the key, backup and sync; risk holds the account', () => {
  const settings = block('settingsSheet');
  for (const id of ['apiKey', 'apiEnv', 'importFile', 'syncPass', 'syncBtn', 'apiStatus']) assert.match(settings, new RegExp(`id="${id}"`), id);
  const risk = block('riskSheet');
  for (const id of ['accountSize', 'riskPct', 'riskDollar', 'riskPresets', 'riskUsdRow', 'allocationControls']) assert.match(risk, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(html, /id="apiToggle"|id="riskToggle"/, 'no collapsible setup cards left behind');
});

test('sheets open one at a time and close back to the page', () => {
  const { run, elements } = app();
  const settings = elements.get('settingsSheet'), risk = elements.get('riskSheet'), backdrop = elements.get('sheetBackdrop');
  assert.ok(!shown(settings) && !shown(risk) && !shown(backdrop));
  run("openSheet('settings')");
  assert.ok(shown(settings) && shown(backdrop) && !shown(risk));
  run("openSheet('risk')");
  assert.ok(shown(risk) && !shown(settings));
  run('closeSheet()');
  assert.ok(!shown(settings) && !shown(risk) && !shown(backdrop));
});

test('Escape closes an open sheet even from inside a field', () => {
  const { run, elements, listeners } = app();
  run("initShortcuts(); openSheet('settings')");
  listeners.get('keydown')({ key: 'Escape', target: { tagName: 'INPUT', blur() {} }, preventDefault() {} });
  assert.ok(!shown(elements.get('settingsSheet')));
});

test('the risk pill tracks risk dollars and allocation', () => {
  const { run, elements } = app();
  elements.get('accountSize').value = '50000';
  elements.get('riskPct').value = '1';
  run('recalcAll()');
  assert.match(elements.get('riskStatus').innerHTML, /\$500\.00/);
  run("setSizingMode('allocation')");
  assert.match(elements.get('riskStatus').textContent, /allocation/);
});

test('setup notice invites a key in the calculator and goes away once one is saved', () => {
  const { run, elements } = app();
  const notice = elements.get('setupNotice');
  run("setView('calc'); updateApiStatus()");
  assert.ok(shown(notice));
  elements.get('apiKey').value = 'test-only';
  run('saveKey()');
  assert.ok(!shown(notice));
  elements.get('apiKey').value = '';
  run('saveKey()');
  assert.ok(shown(notice));
  for (const view of ['positions', 'utils', 'market']) {
    run(`setView('${view}')`);
    assert.ok(!shown(notice), view);
  }
});

test('loading without a key points to Settings instead of a card above', async () => {
  const { run, elements } = app();
  elements.get('ticker').value = 'AAPL';
  await run('fetchQuote()');
  assert.match(elements.get('errorBox').textContent, /Settings/);
  assert.ok(shown(elements.get('settingsSheet')));
});

test('the shares answer is its own card in the rail and follows the quote surfaces', async () => {
  assert.match(block('railPane'), /id="sharesSection"/);
  assert.doesNotMatch(block('quoteSection'), /id="sharesSection"/);
  assert.match(block('sharesSection').split('>')[0], /class="card/);
  const { run, elements } = app();
  const shares = elements.get('sharesSection');
  run("quoteData = { symbol: 'TEST', last: 100, low: 98, high: 102 }");
  await run("setMode('shares')");
  assert.ok(shown(shares));
  run("setView('positions')");
  assert.ok(!shown(shares));
  assert.ok(!shown(elements.get('modeCard')), 'no sizing inputs in Positions');
  run("setView('calc')");
  assert.ok(shown(shares) && shown(elements.get('modeCard')));
  await run("setMode('options')");
  assert.ok(!shown(shares));
});

test('Positions in the header reflects the active view and the saved count', () => {
  const { run, elements } = app();
  run("setView('positions')");
  assert.equal(elements.get('brandPositions').getAttribute('aria-current'), 'page');
  assert.equal(elements.get('brandSize').getAttribute('aria-current'), null);
  run("savedData.x = {}; updateSavedBar()");
  assert.equal(elements.get('posCount').textContent, '1');
});

test('chain layout tiers follow the main pane width', () => {
  const at = width => app({ width });
  assert.equal(at(400).run('isMobileChain()'), true);
  assert.equal(at(800).run('isMobileChain()'), false);
  const compact = at(1200);
  assert.equal(compact.run('twoPaneChain() && isMobileChain()'), true);
  const wide = at(1500);
  assert.equal(wide.run('twoPaneChain() || isMobileChain()'), false);
  assert.equal(wide.run("chainSide = 'call'; chainColCount()"), 12, 'wide desktop gets the full single-side columns');
});

const contract = {
  opt: { symbol: 'TEST261218C00100000', strike: 100, bid: 2.9, ask: 3.1 }, isCall: true, contracts: 3, lossPerContract: 150,
  lossPerContractON: 0, totalCost: 900, atStop: 1.5, entryPrem: 3, mid: 3, stop: 98, lossOfCost: 50, lossOfCostON: 0,
  vol: 10, oi: 20, delta: 0.5, iv: 0.3, model: 'bs', customEntry: false, itm: false, wideSpread: false, spreadPct: 0,
};

test('desktop rail ticket replaces the inline detail row and a second tap clears it', () => {
  const { run, elements } = app({ width: 1400 });
  const ticket = elements.get('optionTicket');
  run(`quoteData = { symbol: 'TEST', last: 100, low: 98, high: 102 }; selectedExp = '2026-12-18';
    globalThis.__inserted = []; globalThis.__tr = { classList: { add() {}, remove() {} }, nextSibling: null, parentNode: { insertBefore: r => __inserted.push(r) } };
    showDetail(__tr, ${JSON.stringify(contract)}, 50000)`);
  assert.ok(shown(ticket));
  assert.match(ticket.innerHTML, /TEST261218C00100000/);
  assert.match(ticket.innerHTML, /simulate returns/);
  assert.equal(run('__inserted.length'), 0, 'no inline detail row on desktop');
  run(`showDetail(__tr, ${JSON.stringify(contract)}, 50000)`);
  assert.ok(!shown(ticket), 'second tap on the same contract clears the ticket');
});

test('phones and tablets keep the inline detail row', () => {
  const { run, elements } = app({ width: 800 });
  run(`quoteData = { symbol: 'TEST', last: 100, low: 98, high: 102 }; selectedExp = '2026-12-18';
    globalThis.__inserted = []; globalThis.__tr = { classList: { add() {}, remove() {} }, nextSibling: null, parentNode: { insertBefore: r => __inserted.push(r) } };
    showDetail(__tr, ${JSON.stringify(contract)}, 50000)`);
  assert.equal(run('__inserted.length'), 1);
  assert.ok(!shown(elements.get('optionTicket')));
});

test('closing details clears the rail ticket too', () => {
  const { run, elements } = app({ width: 1400 });
  run(`quoteData = { symbol: 'TEST', last: 100, low: 98, high: 102 }; selectedExp = '2026-12-18';
    globalThis.__tr = { classList: { add() {}, remove() {} }, nextSibling: null, parentNode: { insertBefore() {} } };
    showDetail(__tr, ${JSON.stringify(contract)}, 50000); closeDetails()`);
  assert.ok(!shown(elements.get('optionTicket')));
  assert.equal(run('railDetailSym'), null);
});
