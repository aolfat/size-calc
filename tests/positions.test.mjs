// Run with: node --test
// Positions: the selected Schwab account's holdings read live, stops from its working stop orders, and the 30s refresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const json = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

const connected = (extra = []) => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }, { hash: 'HASH2', last4: '4321' }])],
  ['schwab_account', 'HASH1'],
  ...extra,
]);

const OPT = 'TEST  261218C00055000'; // Schwab pads the root to six characters
const ACCOUNT = { securitiesAccount: {
  type: 'MARGIN', accountNumber: '12346789',
  currentBalances: { liquidationValue: 100000, cashBalance: 25000 },
  positions: [
    { longQuantity: 100, shortQuantity: 0, averagePrice: 50, averageLongPrice: 50, marketValue: 5500, instrument: { assetType: 'EQUITY', symbol: 'TEST' } },
    { longQuantity: 2, shortQuantity: 0, averagePrice: 2.5, marketValue: 600, instrument: { assetType: 'OPTION', symbol: OPT, putCall: 'CALL', underlyingSymbol: 'TEST' } },
    { longQuantity: 0, shortQuantity: 50, averagePrice: 20, averageShortPrice: 20, marketValue: -900, instrument: { assetType: 'EQUITY', symbol: 'SHRT' } },
    { longQuantity: 10, shortQuantity: 0, averagePrice: 0, marketValue: 1000, instrument: { assetType: 'EQUITY', symbol: 'ACAT' } },
  ],
} };

const leg = (instruction, quantity, symbol, assetType = 'EQUITY') => ({ instruction, quantity, instrument: { symbol, assetType } });
const ORDERS = [
  // the app's own trade: a filled market buy whose stop child is still working
  { orderType: 'MARKET', status: 'FILLED', orderStrategyType: 'TRIGGER', orderLegCollection: [leg('BUY', 100, 'TEST')],
    childOrderStrategies: [{ orderType: 'STOP', status: 'WORKING', orderStrategyType: 'SINGLE', stopPrice: 48, quantity: 100, remainingQuantity: 100, orderLegCollection: [leg('SELL', 100, 'TEST')] }] },
  { orderType: 'STOP', status: 'CANCELED', stopPrice: 30, quantity: 100, orderLegCollection: [leg('SELL', 100, 'TEST')] },
  { orderType: 'STOP', status: 'WORKING', stopPrice: 60, quantity: 100, orderLegCollection: [leg('BUY', 100, 'TEST')] }, // a buy-stop entry, not a stop on the long
  { orderType: 'STOP', status: 'WORKING', stopPrice: 3, quantity: 2, orderLegCollection: [leg('SELL_TO_CLOSE', 2, OPT, 'OPTION')] },
  { orderType: 'STOP_LIMIT', status: 'WORKING', stopPrice: 22, price: 22.5, quantity: 30, orderLegCollection: [leg('BUY_TO_COVER', 30, 'SHRT')] },
];

// a fake network: Schwab calls go to the handler, anything else fails the test
function network(schwab) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
    if (!url.startsWith(PROXY)) throw new Error('Unexpected request ' + url);
    return schwab(url.slice(PROXY.length));
  };
  return { calls, fetch };
}
const schwabOk = path => path.includes('/orders?') ? json(ORDERS) : path.endsWith('?fields=positions') ? json(ACCOUNT) : json({}, 404);

// ---------- the rows ----------

test('Schwab option symbols read as root, expiry, strike and type', async () => {
  const { run } = await app();
  assert.deepEqual({ ...run(`parseSchwabOption('${OPT}')`) }, { root: 'TEST', exp: '2026-12-18', type: 'C', strike: 55 });
  assert.equal(run("parseSchwabOption('BRKB  270115P00512500')").strike, 512.5);
  assert.equal(run("parseSchwabOption('TEST')"), null);
  assert.equal(run(`positionLabel({ assetType: 'OPTION', symbol: '${OPT}' })`), 'TEST 12/18/26 55C');
  assert.equal(run("positionLabel({ assetType: 'EQUITY', symbol: 'TEST' })"), 'TEST');
});

test('positions become rows with price, value and share of the account, shorts negative', async () => {
  const { run } = await app();
  const p = run(`positionRows(${JSON.stringify(ACCOUNT.securitiesAccount)}, [])`);
  assert.equal(p.value, 100000);
  assert.equal(p.cash, 25000);
  assert.deepEqual([...p.rows].map(r => r.label), ['ACAT', 'SHRT', 'TEST', 'TEST 12/18/26 55C'], 'by underlying, stock before its options');
  const [acat, shrt, stock, opt] = p.rows;
  assert.equal(stock.qty, 100); assert.equal(stock.avg, 50); assert.equal(stock.price, 55); assert.equal(stock.pctAcct, 5.5);
  assert.equal(opt.qty, 2); assert.equal(opt.mult, 100); assert.equal(opt.price, 3);
  assert.equal(shrt.qty, -50); assert.equal(shrt.price, 18); assert.equal(shrt.value, -900); assert.equal(shrt.pctAcct, 0.9);
  assert.equal(acat.avg, 0);
  assert.equal(stock.stop, null); assert.equal(stock.risk, null);
});

test('working stops that close a position set its stop and the risk from average cost', async () => {
  const { run } = await app();
  const p = run(`positionRows(${JSON.stringify(ACCOUNT.securitiesAccount)}, ${JSON.stringify(ORDERS)})`);
  const [acat, shrt, stock, opt] = p.rows;
  assert.equal(stock.stop, 48, 'the stop inside a filled trigger order; canceled and opening stops ignored');
  assert.equal(stock.risk, 200); assert.equal(stock.riskPct, 0.2); assert.equal(stock.covered, 100);
  assert.equal(opt.stop, 3);
  assert.equal(opt.risk, -100, 'a stop past the average cost locks a gain');
  assert.equal(shrt.stop, 22);
  assert.equal(shrt.risk, 60); assert.equal(shrt.covered, 30, 'the stop covers part of the short');
  assert.equal(acat.risk, null, 'no cost basis, no risk');
  assert.equal(p.risk, 260, 'total risk counts losses only');
  assert.equal(p.riskPct, 0.26);
  assert.equal(p.total, 6200);
});

test('several stops on one position: the nearest leads and each covers its own shares', async () => {
  const { run } = await app();
  const account = { currentBalances: { liquidationValue: 50000 }, positions: [ACCOUNT.securitiesAccount.positions[0]] };
  const orders = [
    { orderType: 'STOP', status: 'WORKING', stopPrice: 45, quantity: 50, orderLegCollection: [leg('SELL', 50, 'TEST')] },
    { orderType: 'STOP', status: 'WORKING', stopPrice: 49, quantity: 80, orderLegCollection: [leg('SELL', 80, 'TEST')] },
  ];
  const [row] = run(`positionRows(${JSON.stringify(account)}, ${JSON.stringify(orders)})`).rows;
  assert.equal(row.stop, 49);
  assert.equal(row.stops, 2);
  assert.equal(row.risk, 80 * 1 + 20 * 5, 'capped at the shares held');
  assert.equal(row.covered, 100);
});

// ---------- the tab ----------

test('without a Schwab login the tab asks to connect and calls nothing', async () => {
  const net = network(async () => json({}, 500));
  const { run, elements } = await app({ fetch: net.fetch });
  run("setView('positions')");
  await settle();
  assert.equal(net.calls.length, 0);
  assert.match(elements.get('positionsSection').innerHTML, /Connect Schwab/);
  assert.match(elements.get('positionsSection').innerHTML, /data-action="openSheet" data-arg="settings"/);
  assert.equal(elements.get('posCount').textContent, '');
});

test('opening the tab loads the selected account live from Schwab, no Tradier key needed', async () => {
  const net = network(schwabOk);
  const { run, elements } = await app({ fetch: net.fetch, storage: connected() });
  run("setView('positions')");
  await settle();
  const [account, orders] = [...net.calls].sort((a, b) => a.url.length - b.url.length);
  assert.equal(net.calls.length, 2);
  assert.equal(account.url, PROXY + '/trader/v1/accounts/HASH1?fields=positions');
  assert.equal(account.headers.Authorization, 'Bearer acc-1');
  const q = new URL(orders.url).searchParams;
  assert.match(orders.url, /\/trader\/v1\/accounts\/HASH1\/orders\?/);
  const span = Date.parse(q.get('toEnteredTime')) - Date.parse(q.get('fromEnteredTime'));
  assert.ok(span > 58 * DAY && span <= 60 * DAY, 'inside Schwab\'s 60-day order window');

  const html = elements.get('positionsSection').innerHTML;
  assert.match(html, /••6789/);
  assert.match(html, /Account value \$100,000\.00/);
  assert.match(html, /data-action="refreshPositions"[^>]*>[^<]*↻ Refresh/);
  for (const col of ['Symbol', 'Qty', 'Avg cost', 'Price', 'Market value', '% of acct', 'Stop', 'Risk @ stop']) assert.match(html, new RegExp(`<th[^>]*>${col.replace('$', '\\$')}</th>`));
  assert.match(html, /TEST 12\/18\/26 55C/);
  assert.match(html, /\$48\.00/);
  assert.match(html, /−\$200\.00/);
  assert.match(html, /\+\$100\.00 locked/);
  assert.match(html, /covers 30 of 50/);
  assert.match(html, /−50/);
  assert.equal(elements.get('posCount').textContent, '4');
});

test('the table refreshes every 30 seconds while it is open and visible, one call at a time', async () => {
  const net = network(schwabOk);
  const { run, advance } = await app({ fetch: net.fetch, storage: connected(), timers: 'fake' });
  run("setView('positions')");
  await settle();
  assert.equal(net.calls.length, 2);
  await advance(29000); await settle();
  assert.equal(net.calls.length, 2);
  await advance(1000); await settle();
  assert.equal(net.calls.length, 4);

  run('document.hidden = true; positionsVisibilityChanged()');
  await advance(60000); await settle();
  assert.equal(net.calls.length, 4, 'a hidden page stops polling');
  run('document.hidden = false; positionsVisibilityChanged()');
  await settle();
  assert.equal(net.calls.length, 6, 'coming back refreshes at once');

  run("setView('calc')");
  await advance(60000); await settle();
  assert.equal(net.calls.length, 6, 'leaving the tab stops polling');
});

test('a stop exactly at cost reads as breakeven, never a negative zero', async () => {
  const atCost = [...ORDERS.slice(1), { orderType: 'STOP', status: 'WORKING', stopPrice: 50, quantity: 100, orderLegCollection: [leg('SELL', 100, 'TEST')] }];
  const net = network(path => path.includes('/orders?') ? json(atCost) : schwabOk(path));
  const { run, elements } = await app({ fetch: net.fetch, storage: connected() });
  await run('refreshPositions()');
  const row = elements.get('positionsSection').innerHTML.split('<tr>').find(r => r.includes('<b>TEST</b>'));
  assert.match(row, /\$0\.00<\/span><span class="pos-sub">at breakeven/);
  assert.doesNotMatch(elements.get('positionsSection').innerHTML, /-0\.00/);
});

test('without orders the positions still show, with stops marked unavailable', async () => {
  const net = network(path => path.includes('/orders?') ? json({ message: 'down' }, 500) : schwabOk(path));
  const { run, elements } = await app({ fetch: net.fetch, storage: connected() });
  await run('refreshPositions()');
  const html = elements.get('positionsSection').innerHTML;
  assert.match(html, /TEST 12\/18\/26 55C/);
  assert.match(html, /Stops unavailable/);
  assert.doesNotMatch(html, /\$48\.00/);
});

test('a failed refresh keeps the last table and says so', async () => {
  let fail = false;
  const net = network(path => fail && !path.includes('/orders?') ? json({ message: 'Service unavailable' }, 503) : schwabOk(path));
  const { run, elements } = await app({ fetch: net.fetch, storage: connected() });
  await run('refreshPositions()');
  fail = true;
  await run('refreshPositions()');
  const html = elements.get('positionsSection').innerHTML;
  assert.match(html, /Service unavailable/);
  assert.match(html, /TEST 12\/18\/26 55C/);
});

test('switching accounts or logging out drops the old account\'s table', async () => {
  const net = network(schwabOk);
  const { run, elements, storage } = await app({ fetch: net.fetch, storage: connected() });
  run("setView('positions')");
  await settle();
  elements.get('schwabAccount').value = 'HASH2';
  run('schwabAccountChanged()');
  await settle();
  assert.match(net.calls.at(-1).url, /accounts\/HASH2/);
  assert.match(elements.get('positionsSection').innerHTML, /••4321/);
  run('disconnectSchwab()');
  assert.equal(storage.has('schwab_tokens'), false);
  assert.match(elements.get('positionsSection').innerHTML, /Connect Schwab/);
  assert.equal(elements.get('posCount').textContent, '');
});
