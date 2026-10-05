// Run with: node --test
// Layout shell: header nav, settings/risk sheets, the shares answer card, the desktop rail, and the phone layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app as harness, html, css } from './helpers/app.mjs';

// these layout cases default to a 1400px desktop window
const app = (opts = {}) => harness({ width: 1400, ...opts });

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

const shown = el => el.style.display !== 'none';

test('header carries the view nav with Positions and the settings button', async () => {
  const header = block('appHeader');
  for (const id of ['brandMarket', 'brandSize', 'brandPositions', 'brandTools', 'settingsBtn']) {
    assert.match(header, new RegExp(`id="${id}"`), id);
  }
  assert.doesNotMatch(header, /id="riskPill"/, 'risk is adjusted in the page, not behind a pill');
  assert.match(block('brandPositions'), /id="posCount"/);
  assert.doesNotMatch(block('modeSeg'), /Positions/, 'Positions is a view, not a sizing mode');
});

test('setup lives in sheets: settings holds the key, backup and sync; the risk sheet holds the account', async () => {
  const settings = block('settingsSheet');
  for (const id of ['apiKey', 'apiEnv', 'importFile', 'syncPass', 'syncBtn', 'apiStatus']) assert.match(settings, new RegExp(`id="${id}"`), id);
  const risk = block('riskSheet');
  for (const id of ['accountSize', 'riskPct', 'sizingRisk', 'sizingAllocation']) assert.match(risk, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(html, /id="apiToggle"|id="riskToggle"/, 'no collapsible setup cards left behind');
});

test('the risk amount and its chips come first, ahead of the ticket, one tap away', async () => {
  const strip = block('riskStrip');
  for (const id of ['riskDollar', 'riskPresets', 'riskUsdRow', 'usdEditBtn', 'allocationControls', 'riskStatus']) assert.match(strip, new RegExp(`id="${id}"`), id);
  const rail = block('railPane');
  assert.ok(rail.indexOf('id="riskStrip"') < rail.indexOf('id="modeCard"'), 'desktop rail: risk above the ticket');
  // phones and tablets place cards with CSS order: risk must come before the ticket there too
  const order = id => +css.match(new RegExp(`#${id}(?:, [^{]+)? \\{ order: (\\d+); \\}`))[1];
  assert.ok(order('riskStrip') < order('modeCard'), 'phone order: risk above the ticket');
  assert.ok(order('setupNotice') <= order('riskStrip'));
  assert.doesNotMatch(block('riskSheet'), /id="riskDollar"|id="riskPresets"/, 'one copy of each control');
});

test('the risk strip shows wherever risk sizes a trade', async () => {
  const { run, elements } = await app();
  const strip = elements.get('riskStrip');
  for (const mode of ['shares', 'options', 'futures']) {
    await run(`setMode('${mode}')`);
    assert.ok(shown(strip), mode);
  }
  for (const view of ['positions', 'utils', 'market']) {
    run(`setView('${view}')`);
    assert.ok(!shown(strip), view);
  }
});

test('risk steps through your presets from the keyboard', async () => {
  const { run, elements, listeners } = await app();
  elements.get('accountSize').value = '50000';
  elements.get('riskPct').value = '1';
  run('recalcAll(); initShortcuts()');
  const key = k => listeners.get('keydown')({ key: k, target: { tagName: 'BODY' }, preventDefault() {} });
  const risk = () => +elements.get('riskDollar').value;
  // ladder for $50k: .125% 62.5, $100, .25% 125, .5% / $250, 1% / $500, 2% / $1000, 3% 1500
  key('='); assert.equal(risk(), 1000);
  key('+'); assert.equal(risk(), 1500);
  key('='); assert.equal(risk(), 1500, 'stays at the top preset');
  key('-'); key('-'); key('-'); assert.equal(risk(), 250);
  assert.equal(+elements.get('riskPct').value, 0.5, 'percent follows the dollar step');
  elements.get('riskDollar').value = '600';
  run('syncFromDollar()');
  key('-'); assert.equal(risk(), 500, 'an off-ladder amount steps to the nearest preset below');
  run("setSizingMode('allocation')");
  key('='); assert.equal(risk(), 500, 'allocation sizing ignores risk steps');
});

test('sheets open one at a time and close back to the page', async () => {
  const { run, elements } = await app();
  const settings = elements.get('settingsSheet'), risk = elements.get('riskSheet'), backdrop = elements.get('sheetBackdrop');
  assert.ok(!shown(settings) && !shown(risk) && !shown(backdrop));
  run("openSheet('settings')");
  assert.ok(shown(settings) && shown(backdrop) && !shown(risk));
  run("openSheet('risk')");
  assert.ok(shown(risk) && !shown(settings));
  run('closeSheet()');
  assert.ok(!shown(settings) && !shown(risk) && !shown(backdrop));
});

test('Escape closes an open sheet even from inside a field', async () => {
  const { run, elements, listeners } = await app();
  run("initShortcuts(); openSheet('settings')");
  listeners.get('keydown')({ key: 'Escape', target: { tagName: 'INPUT', blur() {} }, preventDefault() {} });
  assert.ok(!shown(elements.get('settingsSheet')));
});

test('the risk strip summary tracks percent of account and allocation', async () => {
  const { run, elements } = await app();
  elements.get('accountSize').value = '50000';
  elements.get('riskPct').value = '1';
  run('recalcAll()');
  assert.equal(elements.get('riskStatus').textContent, '1% of $50,000');
  assert.equal(elements.get('riskStripTitle').textContent, 'Max loss per trade');
  run('setRiskPct(0.125)');
  assert.equal(elements.get('riskStatus').textContent, '0.125% of $50,000');
  run("setSizingMode('allocation')");
  assert.equal(elements.get('riskStripTitle').textContent, 'Allocation');
  assert.equal(elements.get('riskStatus').textContent, '5% of $50,000');
});

test('setup notice invites a key in the calculator and goes away once one is saved', async () => {
  const { run, elements } = await app();
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
  const { run, elements } = await app();
  elements.get('ticker').value = 'AAPL';
  await run('fetchQuote()');
  assert.match(elements.get('errorBox').textContent, /Settings/);
  assert.ok(shown(elements.get('settingsSheet')));
});

test('the shares answer is its own card in the rail and follows the quote surfaces', async () => {
  assert.match(block('railPane'), /id="sharesSection"/);
  assert.doesNotMatch(block('quoteSection'), /id="sharesSection"/);
  assert.match(block('sharesSection').split('>')[0], /class="card/);
  const { run, elements } = await app();
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

test('Positions in the header reflects the active view and the saved count', async () => {
  const { run, elements } = await app();
  run("setView('positions')");
  assert.equal(elements.get('brandPositions').getAttribute('aria-current'), 'page');
  assert.equal(elements.get('brandSize').getAttribute('aria-current'), null);
  run("savedData.x = {}; updateSavedBar()");
  assert.equal(elements.get('posCount').textContent, '1');
});

test('chain layout tiers follow the main pane width', async () => {
  // one window at a time: each app() swaps the globals, so build and check each width in turn
  const at = width => app({ width });
  assert.equal((await at(400)).run('isMobileChain()'), true);
  assert.equal((await at(800)).run('isMobileChain()'), false);
  const compact = await at(1200);
  assert.equal(compact.run('twoPaneChain() && isMobileChain()'), true);
  const wide = await at(1500);
  assert.equal(wide.run('twoPaneChain() || isMobileChain()'), false);
  assert.equal(wide.run("chainSide = 'call'; chainColCount()"), 12, 'wide desktop gets the full single-side columns');
});

const contract = {
  opt: { symbol: 'TEST261218C00100000', strike: 100, bid: 2.9, ask: 3.1 }, isCall: true, contracts: 3, lossPerContract: 150,
  lossPerContractON: 0, totalCost: 900, atStop: 1.5, entryPrem: 3, mid: 3, stop: 98, lossOfCost: 50, lossOfCostON: 0,
  vol: 10, oi: 20, delta: 0.5, iv: 0.3, model: 'bs', customEntry: false, itm: false, wideSpread: false, spreadPct: 0,
};

test('desktop rail ticket replaces the inline detail row and a second tap clears it', async () => {
  const { run, elements } = await app({ width: 1400 });
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

test('phones and tablets keep the inline detail row', async () => {
  const { run, elements } = await app({ width: 800 });
  run(`quoteData = { symbol: 'TEST', last: 100, low: 98, high: 102 }; selectedExp = '2026-12-18';
    globalThis.__inserted = []; globalThis.__tr = { classList: { add() {}, remove() {} }, nextSibling: null, parentNode: { insertBefore: r => __inserted.push(r) } };
    showDetail(__tr, ${JSON.stringify(contract)}, 50000)`);
  assert.equal(run('__inserted.length'), 1);
  assert.ok(!shown(elements.get('optionTicket')));
});

test('closing details clears the rail ticket too', async () => {
  const { run, elements } = await app({ width: 1400 });
  run(`quoteData = { symbol: 'TEST', last: 100, low: 98, high: 102 }; selectedExp = '2026-12-18';
    globalThis.__tr = { classList: { add() {}, remove() {} }, nextSibling: null, parentNode: { insertBefore() {} } };
    showDetail(__tr, ${JSON.stringify(contract)}, 50000); closeDetails()`);
  assert.ok(!shown(elements.get('optionTicket')));
  assert.equal(run('railDetailSym'), null);
});

// ---------- phone layout: bottom tabs, screen title, one search box ----------

test('phones get the view tabs as a bottom bar with icons, clear of the home indicator', async () => {
  for (const id of ['brandMarket', 'brandSize', 'brandPositions', 'brandTools']) {
    assert.match(block(id), /<svg class="tab-icon"/, `${id} has an icon for the bottom bar`);
  }
  assert.match(html, /name="viewport" content="[^"]*viewport-fit=cover/, 'safe-area insets need viewport-fit=cover');
  const phone = [...css.matchAll(/@media \(max-width: ?600px\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join('\n');
  assert.match(phone, /\.brand-tabs \{ position:fixed;[^}]*bottom:0;[^}]*safe-area-inset-bottom/);
});

test('the header names the current screen', async () => {
  const { run, elements } = await app();
  const title = elements.get('viewTitle');
  for (const [view, name] of [['market', 'Market'], ['positions', 'Positions'], ['utils', 'Tools'], ['calc', 'Size']]) {
    run(`setView('${view}')`);
    assert.equal(title.textContent, name, view);
  }
});

test('shorthand reads a strike with a c or p suffix', async () => {
  const { run } = await app();
  const call = run("parseQuickStr('AAPL 245c 6/20/27')");
  assert.equal(call.strike, 245);
  assert.equal(call.optType, 'call');
  assert.equal(call.occ, 'AAPL270620C00245000');
  const put = run("parseQuickStr('spy 580.5p 6/18/26')");
  assert.equal(put.strike, 580.5);
  assert.equal(put.optType, 'put');
  assert.equal(run("parseQuickStr('AAPL 245c put 6/20')"), null, 'conflicting types are rejected');
});

test('the ticker field is one search box: a symbol loads a quote, a contract pins a card', async () => {
  const requests = [];
  const { run, elements } = await app({ fetch: async url => { requests.push(String(url)); throw new Error('offline'); } });
  elements.get('apiKey').value = 'test-only';
  elements.get('ticker').value = 'aapl';
  await run('submitTicker()');
  assert.match(requests[0], /\/markets\/quotes\?symbols=AAPL&greeks=true$/, 'a symbol loads its quote');
  requests.length = 0;
  elements.get('ticker').value = 'AAPL 245c 6/20/27';
  await run('submitTicker()');
  assert.ok(requests.some(u => u.includes('symbols=AAPL270620C00245000')), 'a contract fetches that option to pin it');
});

test('typing a contract in the search box previews what it will pin', async () => {
  const { run, elements } = await app();
  const preview = elements.get('tickerParsed');
  elements.get('ticker').value = 'AAPL';
  run('tickerInputChanged()');
  assert.match(preview.textContent, /AAPL 245c 6\/20/, 'a plain symbol shows the shorthand hint');
  elements.get('ticker').value = 'AAPL 245c 6/20/27';
  run('tickerInputChanged()');
  assert.equal(preview.textContent, 'Pin AAPL $245 call 2027-06-20');
  elements.get('ticker').value = 'AAPL 245';
  run('tickerInputChanged()');
  assert.match(preview.textContent, /expiry/, 'an incomplete contract says what is missing');
});

test('pinning from the search box puts the loaded symbol back in the field', async () => {
  const { run, elements } = await app({ fetch: async url => ({ ok: true, json: async () => ({ quotes: { quote: url.includes('greeks=true')
    ? { type: 'option', symbol: 'TEST261218C00100000', bid: 5, ask: 5, greeks: { delta: 0.5 } } : { symbol: 'TEST', last: 100, low: 99, high: 102 } } }) }) });
  elements.get('apiKey').value = 'test-only';
  run("quoteData = { symbol: 'TEST', last: 100, low: 99, high: 102 }");
  elements.get('ticker').value = 'TEST 100c 12/18/26';
  await run('submitTicker()');
  assert.equal(run('Object.keys(pinnedData).length'), 1);
  assert.equal(elements.get('ticker').value, 'TEST');
});

// ---------- event delegation: no inline handlers, every named action has a handler ----------

test('markup and templates use data-action attributes, and every action name has a handler', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const walk = dir => readdirSync(dir).flatMap(n => statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : n.endsWith('.js') ? [join(dir, n)] : []);
  const sources = [html, ...walk(new URL('../src', import.meta.url).pathname).map(f => readFileSync(f, 'utf8'))];
  for (const text of sources) assert.doesNotMatch(text, /\son(click|input|change|keydown)="/, 'no inline on* handlers');
  const named = new Set();
  for (const text of sources) for (const m of text.matchAll(/data-(action|input|change|enter)="([^"]+)"/g)) {
    // a template may pick the name: data-action="${saved ? 'copySaved' : 'copyPinned'}"
    const names = m[2].startsWith('${') ? [...m[2].matchAll(/'(\w+)'/g)].map(x => x[1]) : [m[2]];
    names.forEach(n => named.add(n));
  }
  const { api } = await app();
  const handlers = new Set(Object.keys(api.actions));
  assert.deepEqual([...named].filter(n => !handlers.has(n)), [], 'names without a handler');
  assert.deepEqual([...handlers].filter(n => !named.has(n)), [], 'handlers nothing uses');
});
