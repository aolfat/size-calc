// Run with: node --test
// Positions: option legs Schwab lists one by one, folded back into the spreads they make.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const connected = () => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ userId: null, proxy: PROXY, connectionId: 'test-connection', access: 'acc-1', accessExp: Date.now() + 20 * 60000, refresh: 'ref-1', refreshExp: Date.now() + 5 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }])],
  ['schwab_account', 'HASH1'],
]);

const LONG = 'RBRK  260828C00105000', SHORT = 'RBRK  260828C00115000';
const SOLD = 'XYZ   270115P00090000', BOUGHT = 'XYZ   270115P00085000';
const opt = (symbol, qty, avg, price, extra = {}) => ({
  longQuantity: qty > 0 ? qty : 0, shortQuantity: qty < 0 ? -qty : 0, averagePrice: avg, marketValue: qty * price * 100,
  instrument: { assetType: 'OPTION', symbol, underlyingSymbol: symbol.slice(0, 6).trim(), optionMultiplier: 100 }, ...extra,
});
const ACCOUNT = {
  currentBalances: { liquidationValue: 100000, cashBalance: 25000 },
  positions: [
    opt(LONG, 3, 6, 7, { currentDayProfitLoss: 60 }), opt(SHORT, -3, 2.5, 3, { currentDayProfitLoss: -30 }),
    opt(SOLD, -2, 3, 2.5), opt(BOUGHT, 2, 1.2, 1),
    { longQuantity: 100, averagePrice: 50, marketValue: 5500, instrument: { assetType: 'EQUITY', symbol: 'TEST' } },
  ],
};
const leg = (instruction, quantity, symbol) => ({ instruction, quantity, instrument: { symbol, assetType: 'OPTION' } });
// the call debit went in as one vertical order; the put credit was opened before the 59 days of orders
const ORDERS = [{ orderId: 7, orderType: 'NET_DEBIT', status: 'FILLED', price: 3.5, quantity: 3, enteredTime: '2026-10-01T14:00:00+0000',
  orderLegCollection: [leg('BUY_TO_OPEN', 3, LONG), leg('SELL_TO_OPEN', 3, SHORT)] }];

test('legs opened in one order make one spread: net cost and mark per spread, P/L added up, the debit its max loss', async () => {
  const { run } = await app();
  const p = run(`positionRows(${JSON.stringify(ACCOUNT)}, ${JSON.stringify(ORDERS)})`);
  assert.equal(p.rows.length, 5, 'the legs stay rows, so the chart, simulator and orders still find them');
  const [debit, credit] = p.spreads;
  assert.equal(debit.label, 'RBRK 8/28/26 105/115C');
  assert.equal(debit.structure, 'call debit');
  assert.equal(debit.legWords, '+3 105C −3 115C');
  assert.equal(debit.by, 'order');
  assert.equal(debit.qty, 3);
  assert.equal(debit.avg, 3.5);
  assert.equal(debit.price, 4);
  assert.equal(debit.value, 1200);
  assert.equal(debit.pnl, 150);
  assert.ok(Math.abs(debit.pnlPct - 150 / 1050 * 100) < 1e-9);
  assert.equal(debit.day, 30);
  assert.equal(debit.maxLoss, 1050);
  assert.equal(debit.riskBasis, 'debit');
  assert.ok(Math.abs(run(`spreadR(positionRows(${JSON.stringify(ACCOUNT)}, ${JSON.stringify(ORDERS)}).spreads[0])`).r - 150 / 1050) < 1e-9);

  assert.equal(credit.label, 'XYZ 1/15/27 85/90P');
  assert.equal(credit.structure, 'put credit');
  assert.equal(credit.legWords, '+2 85P −2 90P');
  assert.equal(credit.by, 'pair', 'no order for it: the only bought and sold puts on XYZ');
  assert.equal(credit.qty, -2, 'a credit spread is sold, so negative like any short');
  assert.ok(Math.abs(credit.avg - 1.8) < 1e-9);
  assert.ok(Math.abs(credit.price - 1.5) < 1e-9, 'what it costs to buy back');
  assert.ok(Math.abs(credit.pnl - 60) < 1e-9);
  assert.ok(Math.abs(credit.maxLoss - 640) < 1e-9, 'width less the credit');
  assert.equal(credit.riskBasis, 'width');
  assert.ok(Math.abs(p.risk - 1690) < 1e-9, 'the total risk counts each spread\'s max loss');
});

test('legs that don\'t read as one spread stay single', async () => {
  const { run } = await app();
  const spreads = (positions, orders = []) => run(`positionRows(${JSON.stringify({ ...ACCOUNT, positions })}, ${JSON.stringify(orders)}).spreads`);
  assert.equal(spreads([opt(LONG, 3, 6, 7), opt(SHORT, 3, 2.5, 3)]).length, 0, 'both bought');
  assert.equal(spreads([opt(LONG, 3, 6, 7), opt(SHORT, -2, 2.5, 3)]).length, 0, 'different sizes, with no order saying so');
  assert.equal(spreads([opt(LONG, 1, 6, 7), opt('RBRK  260828P00095000', -1, 2, 2)]).length, 0, 'a call and a put, with no order saying so');
  assert.equal(spreads([opt(LONG, 1, 6, 7), opt(SHORT, -1, 2.5, 3), opt('RBRK  260918C00120000', -1, 2, 2)]).length, 0, 'three legs, no order: which pair?');
  assert.equal(spreads([opt(LONG, -1, 6, 7)]).length, 0, 'a covered call is one option');
  // the order wins over the guess: a ratio it opened is one spread, sized by the smaller leg
  const [ratio] = spreads([opt(LONG, 1, 6, 7), opt(SHORT, -2, 2.5, 3)], [{ ...ORDERS[0], orderLegCollection: [leg('BUY_TO_OPEN', 1, LONG), leg('SELL_TO_OPEN', 2, SHORT)] }]);
  assert.equal(ratio.legWords, '+1 105C −2 115C');
  assert.equal(ratio.units, 1);
  assert.equal(ratio.maxLoss, null, 'the second call sold is uncovered');
  // an order that didn't fill holds nothing together
  assert.equal(spreads([opt(LONG, 3, 6, 7), opt(SHORT, -2, 2.5, 3)], [{ ...ORDERS[0], status: 'CANCELED' }]).length, 0);
});

test('calendars and diagonals by expiry; a mixed-type order is a spread with no defined max loss', async () => {
  const { run } = await app();
  const spreads = (positions, orders = []) => run(`positionRows(${JSON.stringify({ ...ACCOUNT, positions })}, ${JSON.stringify(orders)}).spreads`);
  const [cal] = spreads([opt('RBRK  260918C00105000', 1, 8, 8), opt(LONG, -1, 5, 5)]);
  assert.equal(cal.structure, 'time spread');
  assert.equal(cal.label, 'RBRK time spread');
  assert.equal(cal.legWords, '−1 8/28/26 105C +1 9/18/26 105C');
  const [diag] = spreads([opt('RBRK  260918C00100000', 1, 10, 10), opt(SHORT, -1, 2, 2)]);
  assert.equal(diag.structure, 'call diagonal');
  assert.equal(cal.maxLoss, 300, 'the debit: the bought call covers the sold one');
  assert.equal(diag.maxLoss, 800);
  const [putDiag] = spreads([opt('RBRK  260918P00085000', 1, 6, 6), opt('RBRK  260828P00090000', -1, 2, 2)]);
  assert.equal(putDiag.maxLoss, null, 'the bought put sits under the sold one: more than the debit at risk');
  const PUT = 'RBRK  260828P00095000';
  const [rr] = spreads([opt(LONG, 1, 6, 7), opt(PUT, -1, 2, 2)], [{ ...ORDERS[0], orderLegCollection: [leg('BUY_TO_OPEN', 1, LONG), leg('SELL_TO_OPEN', 1, PUT)] }]);
  assert.equal(rr.label, 'RBRK 8/28/26 95P/105C');
  assert.equal(rr.structure, 'debit spread');
  assert.equal(rr.maxLoss, null, 'a sold put under it risks more than the debit');
  assert.equal(run(`spreadR(positionRows(${JSON.stringify({ ...ACCOUNT, positions: [opt(LONG, 1, 6, 7), opt(PUT, -1, 2, 2)] })}, ${JSON.stringify([{ ...ORDERS[0], orderLegCollection: [leg('BUY_TO_OPEN', 1, LONG), leg('SELL_TO_OPEN', 1, PUT)] }])}).spreads[0])`).r, null);
});

test('the Positions tab shows a spread as one row, its legs a tap away', async () => {
  const fetch = async url => {
    const path = url.slice(PROXY.length);
    return path.includes('/orders?') ? json(ORDERS) : path.endsWith('?fields=positions') ? json({ securitiesAccount: ACCOUNT }) : json({}, 404);
  };
  const { run, elements, state } = await app({ fetch, storage: connected() });
  run("setView('positions')");
  await settle();
  const html = () => elements.get('positionsSection').innerHTML;
  const body = () => html().split('<tbody>')[1].split('</tbody>')[0];
  assert.equal(elements.get('posCount').textContent, '3', 'two spreads and the stock');
  assert.equal((body().match(/<tr/g) || []).length, 3);
  const spread = body().split('<tr').find(r => r.includes('RBRK 8/28/26 105/115C'));
  assert.match(spread, /call debit/);
  assert.match(spread, /\+3 105C −3 115C/);
  assert.match(spread, /\$3\.50<span class="pos-sub">debit/);
  assert.match(spread, /\$1,200\.00/);
  assert.match(spread, /−\$1,050\.00<\/span><span class="pos-sub">max loss · 1\.05% of acct/);
  assert.match(spread, /data-action="togglePosLegs"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(body(), /RBRK 8\/28\/26 105C/, 'the legs are folded');
  assert.match(html().split('<tfoot>')[1], /−\$1,690\.00/);

  run(`togglePosLegs('${LONG},${SHORT}')`);
  assert.equal((body().match(/<tr/g) || []).length, 5);
  assert.match(body(), /<tr class="pos-leg">\s*<td><b>RBRK 8\/28\/26 105C<\/b>/);
  assert.match(body(), /data-action="simPosition" data-arg="RBRK  260828C00115000"/, 'each leg keeps its own buttons');
  assert.deepEqual([...state.posLegsOpen], [`${LONG},${SHORT}`]);
  run(`togglePosLegs('${LONG},${SHORT}')`);
  assert.equal((body().match(/<tr/g) || []).length, 3);

  run("togglePosColumn('r')");
  assert.match(body().split('<tr').find(r => r.includes('105/115C')), /\+0\.14R<\/span><span class="pos-sub">debit paid/);
  run("togglePosColumn('pnl')");
  assert.match(body().split('<tr').find(r => r.includes('85/90P')), /\+\$60\.00/);
});
