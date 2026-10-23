// Run with: node --test
// Positions: the selected Schwab account's holdings read live, stops from its working stop orders, and the 30s refresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const json = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

const connected = (extra = []) => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
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
    calls.push({ url, headers: init.headers || {}, cache: init.cache });
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

// Schwab's day P/L on each position; ACAT has no cost basis and no day figure
const WITH_DAY = { ...ACCOUNT.securitiesAccount, positions: ACCOUNT.securitiesAccount.positions.map((p, i) => ({ ...p, ...[{ currentDayProfitLoss: 200 }, { currentDayProfitLoss: -40 }, { currentDayProfitLoss: 50 }, {}][i] })) };
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('each row has its P/L from average cost and today\'s P/L from Schwab, both in dollars and percent, with totals', async () => {
  const { run } = await app();
  const p = run(`positionRows(${JSON.stringify(WITH_DAY)}, [])`);
  const [acat, shrt, stock, opt] = p.rows;
  assert.equal(stock.pnl, 500); assert.equal(stock.pnlPct, 10);
  assert.equal(stock.day, 200); assert.ok(near(stock.dayPct, 200 / 5300 * 100), 'of yesterday\'s value');
  assert.equal(opt.pnl, 100); assert.equal(opt.pnlPct, 20, 'times the multiplier');
  assert.equal(opt.day, -40); assert.ok(near(opt.dayPct, -6.25));
  assert.equal(shrt.pnl, 100, 'a short gains as the price falls'); assert.equal(shrt.pnlPct, 10);
  assert.equal(shrt.day, 50); assert.ok(near(shrt.dayPct, 50 / 950 * 100));
  assert.equal(acat.pnl, null); assert.equal(acat.pnlPct, null);
  assert.equal(acat.day, null); assert.equal(acat.dayPct, null);
  assert.equal(p.pnl, 700); assert.ok(near(p.pnlPct, 700 / 6500 * 100), 'over the cost of the rows that have one');
  assert.equal(p.day, 210); assert.ok(near(p.dayPct, 210 / 6890 * 100));
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
  assert.ok(net.calls.every(c => c.cache === 'no-store'), 'live data is never served from a cache');
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

test('P/L columns are off until picked from Columns; picks and hiding the account value stay on this device', async () => {
  const day = path => path.includes('/orders?') ? json([]) : path.endsWith('?fields=positions') ? json({ securitiesAccount: WITH_DAY }) : json({}, 404);
  const storage = connected();
  const { run, elements } = await app({ fetch: network(day).fetch, storage });
  run("setView('positions')");
  await settle();
  const html = () => elements.get('positionsSection').innerHTML;
  assert.doesNotMatch(html(), /<th[^>]*>P\/L/);
  assert.doesNotMatch(html(), /data-action="togglePosColumn"/, 'the picker starts closed');
  assert.match(html(), /data-action="togglePosColumnsMenu"[^>]*aria-expanded="false"/);

  run('togglePosColumnsMenu()');
  for (const col of ['pnl', 'pnlPct', 'day', 'dayPct']) assert.match(html(), new RegExp(`data-action="togglePosColumn" data-arg="${col}"[^>]*aria-pressed="false"`));
  run("togglePosColumn('pnlPct')");
  run("togglePosColumn('dayPct')");
  assert.match(html(), /<th scope="col">P\/L %<\/th>/);
  assert.match(html(), /<th scope="col">Today %<\/th>/);
  assert.doesNotMatch(html(), /<th scope="col">P\/L<\/th>/);
  const stock = html().split('<tr>').find(r => r.includes('<b>TEST</b>'));
  assert.match(stock, /\+10\.00%/);
  assert.match(stock, /\+3\.77%/);
  const opt = html().split('<tr>').find(r => r.includes('<b>TEST 12/18/26'));
  assert.match(opt, /−6\.25%/);
  assert.match(html().split('<tfoot>')[1], /\+10\.77%/, 'the total row');
  assert.equal(storage.get('positions_cols'), JSON.stringify(['pnlPct', 'dayPct']));
  run("togglePosColumn('pnlPct')");
  assert.doesNotMatch(html(), /<th scope="col">P\/L %<\/th>/);

  assert.match(html(), /Account value \$100,000\.00 · cash \$25,000\.00/);
  run('togglePosHideValue()');
  assert.doesNotMatch(html(), /\$100,000|\$25,000/);
  assert.match(html(), /Account value hidden/);
  assert.match(html(), /data-action="togglePosHideValue"[^>]*>Show</);
  assert.equal(storage.get('positions_hide_value'), '1');

  // a new visit keeps both
  const again = await app({ fetch: network(day).fetch, storage });
  again.run("setView('positions')");
  await settle();
  const next = again.elements.get('positionsSection').innerHTML;
  assert.match(next, /<th scope="col">Today %<\/th>/);
  assert.match(next, /Account value hidden/);
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

test('Refresh shows it is working and confirms when it lands; the 30s refresh stays quiet', async () => {
  let gate = null;
  const net = network(async path => { if (gate) await gate.promise; return schwabOk(path); });
  // the account size stays typed in, so the day's first read has nothing to say either
  const { run, elements, advance } = await app({ fetch: net.fetch, storage: connected([['schwab_acct_source', 'manual']]), timers: 'fake' });
  run("setView('positions')");
  await settle();
  assert.equal(elements.get('errorBox').textContent, '', 'opening the tab says nothing extra');
  gate = Promise.withResolvers();
  const done = run('refreshPositions(true)');
  await settle();
  const busy = elements.get('positionsSection').innerHTML;
  assert.match(busy, /data-action="refreshPositions" disabled[^>]*><span class="spinner"[^>]*><\/span> Refreshing…</);
  assert.match(busy, /TEST 12\/18\/26 55C/, 'the table stays up while it reads');
  gate.resolve();
  gate = null;
  await done;
  assert.match(elements.get('positionsSection').innerHTML, /data-action="refreshPositions"[^>]*>↻ Refresh</);
  assert.match(elements.get('errorBox').textContent, /^Positions refreshed at \d/);
  elements.get('errorBox').textContent = '';
  await advance(30000);
  await settle();
  assert.equal(net.calls.length, 6);
  assert.equal(elements.get('errorBox').textContent, '', 'the automatic refresh stays quiet');
});

test('a Schwab read that never answers gives up after 15 seconds, and Refresh works again', async () => {
  let hang = false;
  const ok = network(schwabOk);
  const fetch = async (url, init = {}) => hang
    ? new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    : ok.fetch(url, init);
  const { run, elements, advance } = await app({ fetch, storage: connected(), timers: 'fake' });
  await run('refreshPositions()');
  hang = true;
  run('refreshPositions(true)');
  await settle();
  assert.match(elements.get('positionsSection').innerHTML, /data-action="refreshPositions" disabled/);
  await advance(15000);
  await settle();
  const html = elements.get('positionsSection').innerHTML;
  assert.match(html, /No answer from Schwab in 15 seconds\. Try again\./);
  assert.match(html, /data-action="refreshPositions" title="[^"]*">↻ Refresh</, 'the button is back');
  assert.match(html, /TEST 12\/18\/26 55C/, 'the last table stays');
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

// ---------- working orders ----------

const W = (orderId, orderType, symbol, instruction, quantity, extra = {}) => ({ orderId, orderType, status: 'WORKING', orderStrategyType: 'SINGLE', session: 'NORMAL', duration: 'GOOD_TILL_CANCEL',
  quantity, orderLegCollection: [leg(instruction, quantity, symbol, symbol.includes(' ') ? 'OPTION' : 'EQUITY')], enteredTime: '2026-10-01T14:00:00+0000', ...extra });
const BOOK = [
  W(1, 'STOP', 'TEST', 'SELL', 100, { stopPrice: 48 }),
  { orderId: 2, status: 'WORKING', orderStrategyType: 'OCO', childOrderStrategies: [
    W(3, 'LIMIT', 'TEST', 'SELL', 50, { price: 60, enteredTime: '2026-10-05T12:00:00+0000' }), W(4, 'STOP', 'TEST', 'SELL', 50, { stopPrice: 48, enteredTime: '2026-10-05T12:00:00+0000' })] },
  // an entry that hasn't filled: its stop waits on it
  { ...W(5, 'LIMIT', 'NVDA', 'BUY', 20, { price: 110, duration: 'DAY', session: 'SEAMLESS' }), orderStrategyType: 'TRIGGER',
    childOrderStrategies: [W(6, 'STOP', 'NVDA', 'SELL', 20, { stopPrice: 104, status: 'AWAITING_PARENT_ORDER' })] },
  W(7, 'STOP_LIMIT', 'AMD', 'SELL', 30, { stopPrice: 150, price: 149.5, filledQuantity: 10 }),
  W(8, 'TRAILING_STOP', OPT, 'SELL_TO_CLOSE', 2, { stopPriceOffset: 0.5, stopPrice: 2.9, status: 'QUEUED' }),
  W(9, 'STOP', 'TEST', 'SELL', 100, { stopPrice: 40, status: 'CANCELED' }),
  W(10, 'LIMIT', 'TEST', 'SELL', 100, { price: 55, status: 'FILLED' }),
];

test('working orders list everything still in play, entries included, pairs and waiting stops marked', async () => {
  const { run } = await app();
  const list = JSON.parse(run(`JSON.stringify(workingOrders(${JSON.stringify(BOOK)}))`));
  assert.deepEqual(list.map(o => o.orderId), [7, 5, 6, 3, 4, 1, 8], 'by underlying, newest first, children after their order; done orders gone');
  const by = id => list.find(o => o.orderId === id);
  assert.equal(by(3).oco, 2);
  assert.equal(by(4).oco, 2);
  assert.equal(by(1).oco, null);
  assert.equal(by(6).parent, 'BUY', 'waits on the buy');
  assert.equal(by(6).status, 'AWAITING_PARENT_ORDER');
  assert.equal(by(5).parent, '');
  assert.deepEqual([by(7).stop, by(7).price, by(7).qty, by(7).filled], [150, 149.5, 30, 10]);
  assert.equal(by(8).label, 'TEST 12/18/26 55C');
  assert.equal(by(8).trail, '$0.50');
  assert.equal(run("schwabTime('2026-10-08T13:41:22+0000')"), Date.UTC(2026, 9, 8, 13, 41, 22), 'the offset without its colon still reads');
  assert.ok(Number.isNaN(run("schwabTime('')")));
});

test('the Positions tab lists working orders under the table', async () => {
  const net = network(path => path.includes('/orders?') ? json(BOOK) : path.endsWith('?fields=positions') ? json(ACCOUNT) : json({}, 404));
  const { run, elements } = await app({ fetch: net.fetch, storage: connected() });
  await run('refreshPositions()');
  const html = elements.get('positionsSection').innerHTML;
  const card = html.slice(html.indexOf('orders-card'));
  assert.match(card, /Working orders<\/span><span class="positions-meta">7</);
  const row = id => card.split('<tr').find(r => r.includes(id)) || '';
  assert.match(row('Sell limit'), /<b>TEST<\/b>[\s\S]*Sell limit<span class="pos-sub">one cancels the other with the stop \$48\.00<\/span>[\s\S]*\$60\.00[\s\S]*Until canceled[\s\S]*working[\s\S]*10\/5/);
  assert.match(row('Buy limit'), /<b>NVDA<\/b>[\s\S]*\$110\.00[\s\S]*Today<span class="pos-sub">extended hours<\/span>/);
  assert.match(row('after the buy fills'), /Sell stop<span class="pos-sub">after the buy fills<\/span>[\s\S]*\$104\.00[\s\S]*waiting on entry/);
  assert.match(row('Sell stop limit'), /\$150\.00 stop<span class="pos-sub">\$149\.50 limit<\/span>[\s\S]*20<span class="pos-sub">of 30, 10 filled<\/span>/);
  assert.match(row('trailing stop'), /TEST 12\/18\/26 55C[\s\S]*Sell to close trailing stop[\s\S]*trail \$0\.50<span class="pos-sub">now \$2\.90<\/span>[\s\S]*queued/);
  assert.match(card, /class="pos-oco"/);
  assert.doesNotMatch(card, /\$40\.00|\$55\.00/, 'cancelled and filled orders are gone');

  const none = network(path => path.includes('/orders?') ? json([]) : path.endsWith('?fields=positions') ? json(ACCOUNT) : json({}, 404));
  const empty = await app({ fetch: none.fetch, storage: connected() });
  await empty.run('refreshPositions()');
  assert.match(empty.elements.get('positionsSection').innerHTML, /Working orders<\/span><span class="positions-meta">None<\/span>[\s\S]*Nothing working in the last 59 days/);
  const down = network(path => path.includes('/orders?') ? json({ message: 'down' }, 500) : path.endsWith('?fields=positions') ? json(ACCOUNT) : json({}, 404));
  const blind = await app({ fetch: down.fetch, storage: connected() });
  await blind.run('refreshPositions()');
  assert.match(blind.elements.get('positionsSection').innerHTML, /Orders unavailable: Schwab did not return this account's orders/);
});

test('a refresh overtaken by a newer one resolves once the newer read is in', async () => {
  let release, n = 0;
  const gate = new Promise(r => { release = r; });
  const fetch = async url => {
    const path = url.slice(PROXY.length);
    if (path.endsWith('?fields=positions') && ++n === 2) await gate; // the newer read is the slow one
    return schwabOk(path);
  };
  const { run, state } = await app({ fetch, storage: connected() });
  const older = run('refreshPositions()');
  run('refreshPositions()');
  let done = false;
  older.then(() => { done = true; });
  await settle();
  assert.equal(done, false, 'the older read landed, but the newer one is still out');
  assert.equal(state.positions, null, 'and its answer was dropped');
  release();
  await older;
  assert.equal(state.positions.rows.length, 4);
  assert.equal(state.positions.hash, 'HASH1');
});

// ---------- R: open P/L over the trade's risk at entry ----------

// a journal trade as core/journal.js builds it, open on TEST in account 6789
const openTrade = (extra = {}) => ({ key: '6789|TEST|long|t', account: '6789', symbol: 'TEST', direction: 'long', status: 'open', deleted: false, kind: 'single',
  openQty: 100, entryQty: 100, avgEntry: 50, multiplier: 1, risk: 300, rBasis: 'stop', stop: 47, stopSource: 'schwab', exits: 0, pnl: 0, grossPnl: 0, ...extra });

test('R counts from the Journal trade\'s first stop, not the stop working now; trims add on', async () => {
  const { run } = await app();
  const rows = run(`positionRows(${JSON.stringify(ACCOUNT.securitiesAccount)}, ${JSON.stringify(ORDERS)}).rows`);
  const stock = [...rows].find(r => r.label === 'TEST');
  const r = (trades, row = stock) => run(`positionR(${JSON.stringify(row)}, ${JSON.stringify(trades)}, '6789')`);

  const first = r([openTrade()]);
  assert.equal(first.source, 'journal');
  assert.equal(first.stop, 47, 'the first stop, though $48 is working now');
  assert.equal(Math.round(first.r * 100) / 100, 1.67, '$500 open P/L over $300 risk');
  assert.equal(first.withTrims, null);

  const trimmed = r([openTrade({ entryQty: 200, risk: 600, exits: 1, grossPnl: 400, pnl: 390 })]);
  assert.equal(Math.round(trimmed.r * 100) / 100, 0.83, 'the open shares over the whole trade\'s risk');
  assert.equal(Math.round(trimmed.withTrims * 100) / 100, 1.5, 'with the $400 the trim took, before fees like Schwab\'s P/L');

  const premium = r([openTrade({ rBasis: 'premium', stop: null, risk: 1000 })]);
  assert.equal(premium.basis, 'premium');
  assert.equal(premium.r, 0.5);

  // no match: the nearest stop working now, $2 under the $50 cost on 100 shares
  for (const trades of [null, [], [openTrade({ account: '4321' })], [openTrade({ deleted: true })], [openTrade({ direction: 'short' })], [openTrade({ status: 'win' })], [openTrade({ kind: 'spread' })]]) {
    const fell = r(trades);
    assert.equal(fell.source, 'stop', JSON.stringify(trades));
    assert.equal(fell.r, 2.5);
    assert.equal(fell.stop, 48);
  }
  const behind = r([openTrade({ openQty: 50 })]);
  assert.equal(behind.source, 'stop', 'the Journal holding another quantity is behind Schwab');
  assert.equal(behind.journalQty, 50);
});

test('R without a Journal trade: the nearest stop, a long option\'s premium, nothing past breakeven', async () => {
  const { run } = await app();
  const rows = orders => [...run(`positionRows(${JSON.stringify(ACCOUNT.securitiesAccount)}, ${JSON.stringify(orders)}).rows`)];
  const r = row => run(`positionR(${JSON.stringify(row)}, null, '6789')`);
  const [acat, shrt, , opt] = rows(ORDERS);
  const short = r(shrt);
  assert.equal(short.r, 1, 'a short: $100 open P/L over $2 × 50 shares to the $22 stop');
  const past = r(opt);
  assert.equal(past.r, null, 'a stop over the cost has no risk left');
  assert.match(past.why, /breakeven/);
  assert.equal(r(acat).r, null, 'no cost basis');
  const bare = rows([])[3];
  const prem = r(bare);
  assert.equal(prem.source, 'premium');
  assert.equal(prem.r, 0.2, 'a long call with no stop: $100 over the $500 paid');
  const noStop = r(rows([])[2]);
  assert.equal(noStop.r, null);
  assert.match(noStop.why, /No stop/);
});

test('1R in the position\'s price sets a target in R: the Journal trade\'s risk per share at entry, else the nearest stop or the premium', async () => {
  const { run } = await app();
  const rows = orders => [...run(`positionRows(${JSON.stringify(ACCOUNT.securitiesAccount)}, ${JSON.stringify(orders)}).rows`)];
  const unit = (row, trades = null) => run(`rUnit(${JSON.stringify(row)}, ${JSON.stringify(trades)}, '6789')`);
  const price = (row, r, per) => run(`rTargetPrice(${JSON.stringify(row)}, ${r}, ${per})`);
  const all = rows(ORDERS), stock = all.find(r => r.label === 'TEST');

  const first = unit(stock, [openTrade()]);
  assert.equal(first.source, 'journal');
  assert.equal(first.per, 3, '$300 over 100 shares: the first stop $47, not the $48 working now');
  assert.equal(unit(stock, [openTrade({ entryQty: 200, risk: 600, exits: 1, grossPnl: 400 })]).per, 3, 'over the whole entry, so a trim doesn\'t change 1R');
  assert.equal(price(stock, 5, 3), 65, '5R: $50 cost + 5 × $3');
  assert.equal(unit(stock).per, 2, 'no Journal trade: the nearest stop, $48');
  assert.equal(unit(stock).stop, 48);

  const short = all[1];
  assert.equal(unit(short).per, 2, 'a short: $2 to the $22 stop');
  assert.equal(price(short, 2, 2), 16, 'below the $20 cost on a short');
  assert.equal(price(short, 12, 2), 0, 'a short target can\'t go under zero');

  const call = rows([])[3];
  assert.equal(unit(call).source, 'premium');
  assert.equal(unit(call).per, 2.5, 'a long call with no stop: 1R is the premium');
  assert.equal(price(call, 1.1, 2.53), 5.3, 'on the option grid: $5.283 goes to the nearest dime above $3');

  const past = unit(all[3]);
  assert.equal(past.per, null, 'a stop past breakeven');
  assert.match(past.why, /breakeven/);
  assert.equal(unit(rows([])[2]).per, null);
  assert.equal(price(all[0], 2, 1), 0, 'no cost basis, no target in R');
});

// the TEST trade in the Journal: 100 bought at $50 with a $47 stop, replaced later by the $48 working now
const TEST_BUY = { kind: 'order', record_id: '801', account: '6789', entered_at: '2026-10-05T14:00:00Z', data: {
  orderId: 801, enteredTime: '2026-10-05T14:00:00+0000', status: 'FILLED', orderType: 'MARKET', orderStrategyType: 'TRIGGER',
  orderLegCollection: [{ legId: 1, instruction: 'BUY', quantity: 100, instrument: { symbol: 'TEST', assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 8001, executionLegs: [{ legId: 1, quantity: 100, price: 50, time: '2026-10-05T14:00:01+0000' }] }],
  childOrderStrategies: [{ orderId: 802, status: 'REPLACED', orderType: 'STOP', stopPrice: 47, quantity: 100, orderLegCollection: [{ legId: 1, instruction: 'SELL', quantity: 100, instrument: { symbol: 'TEST', assetType: 'EQUITY' } }] }],
} };

const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
// connected, with the Schwab login bound to the signed-in Google user (a login bound to no one is cleared on sign-in)
function signedIn(extra = []) {
  const storage = connected(extra);
  storage.set('schwab_tokens', JSON.stringify({ ...JSON.parse(storage.get('schwab_tokens')), userId: SESSION.user.id }));
  return storage;
}

test('the R column reads the Journal when signed in, and counts from the stop now when signed out', async () => {
  const supabase = fakeRecords([TEST_BUY]);
  const { run, elements } = await app({ fetch: network(schwabOk).fetch, storage: signedIn([['positions_cols', JSON.stringify(['r'])]]), supabase, session: SESSION });
  run("setView('positions')");
  await settle();
  const html = () => elements.get('positionsSection').innerHTML;
  const row = label => html().split('<tr>').find(r => r.includes(`<b>${label}</b>`));
  assert.match(html(), /<th scope="col">R<\/th>/);
  assert.match(row('TEST'), /\+1\.67R/);
  assert.match(row('TEST'), /first stop \$47\.00/);
  assert.match(row('SHRT'), /\+1\.00R[\s\S]*stop now \$22\.00/, 'no Journal trade: the stop working now');
  assert.match(row('TEST 12/18/26 55C'), /title="The stop is at or past breakeven/);
  assert.match(html(), /R is open P\/L over the risk at entry/);

  const out = await app({ fetch: network(schwabOk).fetch, storage: connected([['positions_cols', JSON.stringify(['r'])]]) });
  out.run("setView('positions')");
  await settle();
  const stock = out.elements.get('positionsSection').innerHTML.split('<tr>').find(r => r.includes('<b>TEST</b>'));
  assert.match(stock, /\+2\.50R[\s\S]*stop now \$48\.00/);
  assert.match(stock, /Sign in to count from the Journal trade/);
});

test('the R column is in the Columns picker, and the Journal is read only once it is on', async () => {
  const supabase = fakeRecords([TEST_BUY]);
  const { run, elements, state } = await app({ fetch: network(schwabOk).fetch, storage: signedIn(), supabase, session: SESSION });
  run("setView('positions')");
  await settle();
  assert.equal(state.journalRecords, null, 'no R column, no Journal read');
  run('togglePosColumnsMenu()');
  assert.match(elements.get('positionsSection').innerHTML, /data-action="togglePosColumn" data-arg="r"/);
  run("togglePosColumn('r')");
  assert.match(elements.get('positionsSection').innerHTML.split('<tr>').find(r => r.includes('<b>TEST</b>')), /…/, 'waiting on the Journal');
  await settle();
  assert.equal(state.journalRecords.length, 1);
  assert.match(elements.get('positionsSection').innerHTML, /\+1\.67R/);
  assert.equal(elements.get('positionsSection').innerHTML.split('<tfoot>')[1].includes('R</'), false, 'no total for R');
});

test('a reload on Positions while signed in reads the account once the stored session comes back, R column and all', async () => {
  const supabase = fakeRecords([TEST_BUY]);
  supabase.auth = { getSession: async () => ({ data: { session: SESSION } }) };
  const storage = signedIn([['positions_cols', JSON.stringify(['r'])], ['cloud_user', SESSION.user.id], ['sb-dhohfavttsxwutanvcuj-auth-token', '{"access_token":"jwt"}']]);
  const net = network(schwabOk);
  const { run, elements } = await app({ fetch: net.fetch, storage, supabase });
  run("setView('positions')"); // what main.js does on load, before the session is back
  assert.equal(net.calls.length, 0, 'the Schwab login is this user\'s: nothing to read without the session');
  run("initCloud('https://size-calc.example/#positions')");
  await settle();
  const html = elements.get('positionsSection').innerHTML;
  assert.match(html, /••6789/);
  assert.match(html.split('<tr>').find(r => r.includes('<b>TEST</b>')), /\+1\.67R[\s\S]*first stop \$47\.00/);
});
