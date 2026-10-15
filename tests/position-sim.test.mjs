// Run with: node --test
// Position sim: returns use average cost, with the model fitted to the price in Schwab holdings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 14, 17);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

const connected = (extra = []) => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }])],
  ['schwab_account', 'HASH1'],
  ...extra,
]);

const CALL = 'HOOD  261218C00050000', PUT = 'HOOD  261218P00040000', SHORT_CALL = 'HOOD  261218C00060000';
const ACCOUNT = { securitiesAccount: { currentBalances: { liquidationValue: 100000, cashBalance: 25000 }, positions: [
  { longQuantity: 300, shortQuantity: 0, averagePrice: 38.2, marketValue: 300 * 41.1, instrument: { assetType: 'EQUITY', symbol: 'HOOD' } },
  { longQuantity: 2, shortQuantity: 0, averagePrice: 2.5, marketValue: 600, instrument: { assetType: 'OPTION', symbol: CALL, underlyingSymbol: 'HOOD' } },
  { longQuantity: 0, shortQuantity: 3, averagePrice: 1.8, marketValue: -450, instrument: { assetType: 'OPTION', symbol: PUT, underlyingSymbol: 'HOOD' } },
  { longQuantity: 0, shortQuantity: 1, averagePrice: 1.2, marketValue: -100, instrument: { assetType: 'OPTION', symbol: SHORT_CALL, underlyingSymbol: 'HOOD' } },
] } };
const QUOTES = [
  { symbol: 'HOOD', type: 'stock', last: 41.1, bid: 41.05, ask: 41.15 },
  { symbol: 'HOOD261218C00050000', type: 'option', bid: 2.9, ask: 3.1, greeks: { smv_vol: 0.6, mid_iv: 0.58 } },
  { symbol: 'HOOD261218P00040000', type: 'option', bid: 1.45, ask: 1.55, greeks: { smv_vol: 0.65 } },
  { symbol: 'HOOD261218C00060000', type: 'option', bid: 0.95, ask: 1.05, greeks: { mid_iv: 0.55 } },
];

function network({ quotes = QUOTES } = {}) {
  const tradier = [];
  const fetch = async (url) => {
    if (url.startsWith(PROXY)) {
      const path = url.slice(PROXY.length);
      return path.includes('/orders?') ? json([]) : path.endsWith('?fields=positions') ? json(ACCOUNT) : json({}, 404);
    }
    if (url.includes('/markets/quotes')) { tradier.push(url); return json({ quotes: { quote: quotes } }); }
    throw new Error('Unexpected request ' + url);
  };
  return { fetch, tradier };
}

async function simApp({ key = true, ...opts } = {}) {
  const net = network(opts);
  const h = await app({ fetch: net.fetch, storage: connected(key ? [['tradier_key', 'tk']] : []), clock: true });
  await h.advance(NOW - h.run('Date.now()'));
  if (key) h.elements.get('apiKey').value = 'tk';
  h.run("setView('positions')");
  await settle();
  h.run('var opened = null; openSim = o => { opened = o; };');
  return { ...h, tradier: net.tradier };
}

const tableRow = (elements, label) => elements.get('positionsSection').innerHTML.split('<tr>').find(r => r.includes(`<b>${label}`)) || '';

test('option rows get a Simulate button; stock rows do not', async () => {
  const { elements } = await simApp();
  assert.match(tableRow(elements, 'HOOD 12/18/26 50C'), new RegExp(`data-action="simPosition" data-arg="${CALL}"`));
  assert.match(tableRow(elements, 'HOOD 12/18/26 40P'), /data-action="simPosition"/);
  assert.doesNotMatch(tableRow(elements, 'HOOD</b>'), /simPosition/);
});

test('a long call fits Schwab’s price, keeping average cost and size, with one underlying quote request', async () => {
  const { run, tradier } = await simApp();
  await run(`simPosition('${CALL}')`);
  assert.equal(tradier.length, 1);
  assert.equal(new URL(tradier[0]).searchParams.get('symbols'), 'HOOD');
  const o = run('opened');
  assert.equal(o.isCall, true);
  assert.equal(o.K, 50);
  assert.equal(o.expStr, '2026-12-18');
  assert.ok(o.iv > 0);
  assert.equal(o.mark, 3);
  assert.equal(o.markAsOf, NOW);
  assert.equal(o.asOf, NOW);
  assert.ok(Math.abs(run('simState = opened; simCurve(opened.spot)[0].v') - 3) < 1e-7);
  assert.equal(o.entry, 2.5);
  assert.equal(o.qty, 2);
  assert.equal(o.spot, 41.1);
  assert.equal(o.credit, false);
  assert.equal(o.shortPut, false);
  assert.equal(o.stop, null);
  assert.equal(o.parsedTicker, 'HOOD');
  assert.equal(o.label, 'HOOD 12/18/26 50C');
  // one standard deviation by expiry: spot × IV × √years
  const years = run("yearsToExp('2026-12-18')");
  assert.ok(Math.abs(o.em - 41.1 * o.iv * Math.sqrt(years)) < 1e-9);
});

test('sold options measure P/L the other way, as % of the premium received (not a put\'s assignment notional)', async () => {
  const { run } = await simApp();
  await run(`simPosition('${PUT}')`);
  let o = run('opened');
  assert.equal(o.credit, true);
  assert.equal(o.shortPut, false);
  assert.equal(o.qty, 3);
  assert.equal(o.entry, 1.8);
  assert.equal(run('simReturnBase(opened)'), 1.8);

  await run(`simPosition('${SHORT_CALL}')`);
  o = run('opened');
  assert.equal(o.credit, true);
  assert.equal(o.shortPut, false);
  assert.ok(o.iv > 0);
  assert.ok(Math.abs(run('simState = opened; simCurve(opened.spot)[0].v') - 1) < 1e-7);
  assert.equal(run('simReturnBase(opened)'), 1.2); // no width: % of the credit, not of a spread's max loss
});

test('no Tradier key: nothing is fetched and Settings opens', async () => {
  const { run, tradier, elements } = await simApp({ key: false });
  await run(`simPosition('${CALL}')`);
  assert.equal(tradier.length, 0);
  assert.equal(run('opened'), null);
  assert.equal(run('openSheetName'), 'settings');
  assert.match(elements.get('errorBox').textContent, /Tradier API key/);
});

test('Tradier without the underlying: an error, no simulator', async () => {
  const { run, elements } = await simApp({ quotes: QUOTES.slice(1) });
  await run(`simPosition('${CALL}')`);
  assert.equal(run('opened'), null);
  assert.match(elements.get('errorBox').textContent, /Tradier has no quote for HOOD 12\/18\/26 50C/);
});

test('a position can simulate without Tradier option greeks or an option quote', async () => {
  const { run } = await simApp({ quotes: [QUOTES[0]] });
  await run(`simPosition('${CALL}')`);
  assert.ok(run('opened.iv > 0'));
  assert.ok(Math.abs(run('simState = opened; simCurve(opened.spot)[0].v') - 3) < 1e-7);
});

test('a holdings refresh during the quote request uses the newest position price and cost', async () => {
  const { run } = await simApp();
  run(`var releaseQuote; fetch = () => new Promise(resolve => { releaseQuote = resolve; });
    var pendingSim = simPosition('${CALL}');
    positions = { ...positions, asOf: Date.now() + 1000, rows: positions.rows.map(r => r.symbol === '${CALL}' ? { ...r, price: 4, avg: 2.75, qty: 1 } : r) };
    releaseQuote({ json: async () => ({ quotes: { quote: { symbol: 'HOOD', last: 41.1 } } }) });`);
  await run('pendingSim');
  assert.equal(run('opened.mark'), 4);
  assert.equal(run('opened.markAsOf'), NOW + 1000);
  assert.equal(run('opened.entry'), 2.75);
  assert.equal(run('opened.qty'), 1);
});

test('an account switch or a closed position during the quote request cannot open an old position', async () => {
  for (const change of ["positions = null", "positions = { ...positions, hash: 'HASH2' }", "positions = { ...positions, rows: [] }"]) {
    const { run } = await simApp();
    run(`var releaseQuote; fetch = () => new Promise(resolve => { releaseQuote = resolve; });
      var pendingSim = simPosition('${CALL}'); ${change};
      releaseQuote({ json: async () => ({ quotes: { quote: { symbol: 'HOOD', last: 41.1 } } }) });`);
    await run('pendingSim');
    assert.equal(run('opened'), null);
  }
});

test('an expired option or a price the model cannot fit shows an error, not a different current value', async () => {
  for (const edit of ["row.price = -1", "row.price = 100", "row.option = { ...row.option, exp: '2026-10-13' }"]) {
    const { run, elements } = await simApp();
    run(`var row = positions.rows.find(r => r.symbol === '${CALL}'); ${edit}`);
    await run(`simPosition('${CALL}')`);
    assert.equal(run('opened'), null);
    assert.match(elements.get('errorBox').textContent, /cannot fit|expired/i);
  }
});

function useRealSimulator({ api, elements }, t) {
  api.effects.openSim = api.openSim;
  elements.get('simChart').getContext = () => new Proxy({ measureText: () => ({ width: 40 }) }, { get: (o, k) => k in o ? o[k] : () => {}, set: (o, k, v) => { o[k] = v; return true; } });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  t.after(() => { delete globalThis.getComputedStyle; });
}

test('the now readout matches holdings price and P/L for long calls and sold puts and calls', async t => {
  const h = await simApp();
  useRealSimulator(h, t);
  for (const [symbol, price, pct, pnl] of [[CALL, '3.00', '20.0', '100.00'], [PUT, '1.50', '16.7', '90.00'], [SHORT_CALL, '1.00', '16.7', '20.00']]) {
    await h.run(`simPosition('${symbol}')`);
    assert.match(h.elements.get('simReadout').innerHTML, new RegExp(`est <b>\\$${price}</b>/ct.*\\+${pct}%.*\\+\\$${pnl}`));
    assert.match(h.elements.get('simMeta').textContent, /Schwab.*as of.*IV.*fitted/);
  }
});

test('the current chip and redraws keep the fitted position snapshot, even with an older calculator quote', async t => {
  const h = await simApp();
  useRealSimulator(h, t);
  await h.run(`simPosition('${CALL}')`);
  const original = h.run('simCurve(simState.spot)');
  h.run("quoteData = { symbol: 'HOOD', last: 35 }; simSetPrice('+em'); simSetPrice('current')");
  assert.equal(+h.elements.get('simPrice').value, 41.1);
  await h.advance(DAY);
  h.run('drawSim()');
  assert.equal(h.run('simCurve(simState.spot)[0].v'), original[0].v);
  assert.equal(h.run('simCurve(simState.spot)[0].t'), original[0].t);
  assert.match(h.elements.get('simReadout').innerHTML, /est <b>\$3\.00<\/b>/);
  const moved = h.run('simCurve(55)');
  assert.ok(moved[0].v > 3);
  assert.equal(moved.at(-1).v, 5, 'expiry is still intrinsic, with no permanent price offset');
});

test('the simulator: a position swaps stop and R chips for ±1σ, which move the price by the expected move', async t => {
  const h = await simApp();
  const { run, elements } = h;
  useRealSimulator(h, t);
  await run(`simPosition('${CALL}')`);
  assert.equal(elements.get('simRChips').style.display, 'none');
  assert.equal(elements.get('simEmChips').style.display, '');
  assert.match(elements.get('simMeta').textContent, /avg cost \$2\.50\/ct · 2 ct/);
  const em = run('simState.em');
  run("simSetPrice('+em')");
  assert.equal(+elements.get('simPrice').value, +(41.1 + em).toFixed(2));
  run("simSetPrice('-em')");
  assert.equal(+elements.get('simPrice').value, +(41.1 - em).toFixed(2));
  // the slider covers at least 1.5× the move either side
  assert.ok(+elements.get('simPrice').max >= 41.1 + em * 1.5 - 0.01);

  // a calculator card still gets its stop chips
  run("openSim({ isCall: true, K: 50, expStr: '2026-12-18', iv: 0.5, entry: 2, qty: 1, spot: 41, stop: 39, label: 'x', parsedTicker: 'HOOD' })");
  assert.equal(elements.get('simRChips').style.display, '');
  assert.equal(elements.get('simEmChips').style.display, 'none');
});
