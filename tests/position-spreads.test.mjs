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

test('on a phone a spread is one card: net cost to mark, its max loss, the legs as cards of their own', async () => {
  const fetch = async url => {
    const path = url.slice(PROXY.length);
    return path.includes('/orders?') ? json(ORDERS) : path.endsWith('?fields=positions') ? json({ securitiesAccount: ACCOUNT }) : json({}, 404);
  };
  const key = `${LONG},${SHORT}`;
  const { run, elements } = await app({ width: 390, fetch, storage: connected() });
  run("setView('positions')");
  await settle();
  const html = () => elements.get('positionsSection').innerHTML;
  const card = () => html().split('<article').find(c => c.includes(`data-arg="${key}"`)) || '';
  assert.match(card(), /<b>RBRK<\/b> <span class="pc-detail">105\/115C 8\/28\/26<\/span>/, 'strikes first, like a single option');
  assert.match(card(), /\$3\.50 → <b>\$4\.00<\/b> · 3 spreads/);
  assert.match(card(), /\+0\.14R/);
  assert.match(card(), /Call debit · max loss \$1,050\.00/);
  assert.match(card(), /pc-ladder/);
  run(`togglePosCard('${key}')`);
  assert.match(card(), /<dt>Max loss<\/dt><dd><span class="pos-loss">−\$1,050\.00/);
  assert.match(card(), /data-action="openSpreadClose"/);
  assert.doesNotMatch(html(), /pc pc-leg/);
  run(`togglePosLegs('${key}')`);
  assert.equal((html().match(/<article class="pc pc-leg"/g) || []).length, 2, 'each leg its own card, under the spread');
});

// ---------- closing a spread as one order ----------

const plain = v => JSON.parse(JSON.stringify(v));
const spreadOf = (positions, orders = ORDERS) => `positionRows(${JSON.stringify({ ...ACCOUNT, positions })}, ${JSON.stringify(orders)}).spreads[0]`;
const planFor = (positions, opts, orders = ORDERS) => plain(globalThis.__run(`spreadClosePlan(${spreadOf(positions, orders)}, ${JSON.stringify(orders)}, ${JSON.stringify(opts)})`));

test('a spread closes as one order: every leg to close in its ratio, for a net credit or debit on the option grid', async () => {
  const { run } = await app();
  globalThis.__run = run;
  const debit = [opt(LONG, 3, 6, 7), opt(SHORT, -3, 2.5, 3)];
  const all = planFor(debit, { type: 'LIMIT', price: 4.02, duration: 'GOOD_TILL_CANCEL' });
  assert.equal(all.error, '');
  assert.deepEqual(all.steps, [{ kind: 'place', order: { orderType: 'NET_CREDIT', session: 'NORMAL', duration: 'GOOD_TILL_CANCEL', orderStrategyType: 'SINGLE', price: 4,
    orderLegCollection: [
      { instruction: 'SELL_TO_CLOSE', quantity: 3, instrument: { symbol: LONG, assetType: 'OPTION' } },
      { instruction: 'BUY_TO_CLOSE', quantity: 3, instrument: { symbol: SHORT, assetType: 'OPTION' } },
    ] } }]);
  const trim = planFor(debit, { type: 'MARKET', qty: 1 });
  assert.equal(trim.steps[0].order.orderType, 'MARKET');
  assert.equal(trim.steps[0].order.duration, 'DAY');
  assert.equal(trim.steps[0].order.price, undefined);
  assert.deepEqual(trim.steps[0].order.orderLegCollection.map(l => l.quantity), [1, 1]);

  const credit = planFor([opt(SOLD, -2, 3, 2.5), opt(BOUGHT, 2, 1.2, 1)], { type: 'LIMIT', price: 1.5 }, []);
  assert.equal(credit.steps[0].order.orderType, 'NET_DEBIT', 'a credit spread costs a debit to close');
  assert.deepEqual(credit.steps[0].order.orderLegCollection.map(l => [l.instruction, l.instrument.symbol]), [['SELL_TO_CLOSE', BOUGHT], ['BUY_TO_CLOSE', SOLD]]);

  const ratioOrder = [{ ...ORDERS[0], orderLegCollection: [leg('BUY_TO_OPEN', 2, LONG), leg('SELL_TO_OPEN', 4, SHORT)] }];
  assert.deepEqual(planFor([opt(LONG, 2, 6, 7), opt(SHORT, -4, 2.5, 3)], { type: 'MARKET', qty: 1 }, ratioOrder).steps[0].order.orderLegCollection.map(l => l.quantity), [1, 2], 'a 1×2 stays 1×2');
  const odd = [{ ...ORDERS[0], orderLegCollection: [leg('BUY_TO_OPEN', 3, LONG), leg('SELL_TO_OPEN', 5, SHORT)] }];
  assert.match(planFor([opt(LONG, 3, 6, 7), opt(SHORT, -5, 2.5, 3)], { type: 'MARKET' }, odd).error, /aren't in a whole ratio/);
  assert.match(planFor(debit, { type: 'MARKET', qty: 4 }).error, /You hold 3 spreads/);
  assert.match(planFor(debit, { type: 'MARKET', qty: 0 }).error, /how many spreads/);
  assert.match(planFor(debit, { type: 'LIMIT', price: 0 }).error, /net limit price/);
});

test('closing all of a spread cancels whatever else closes a leg first; a trim fits in what they leave', async () => {
  const { run } = await app();
  globalThis.__run = run;
  const debit = [opt(LONG, 3, 6, 7), opt(SHORT, -3, 2.5, 3)];
  const working = [...ORDERS,
    { orderId: 30, orderType: 'NET_CREDIT', status: 'WORKING', orderStrategyType: 'SINGLE', price: 6, quantity: 2, remainingQuantity: 2, enteredTime: '2026-10-15T14:00:00+0000',
      orderLegCollection: [leg('SELL_TO_CLOSE', 2, LONG), leg('BUY_TO_CLOSE', 2, SHORT)] },
    { orderId: 31, orderType: 'STOP', status: 'WORKING', orderStrategyType: 'SINGLE', stopPrice: 3, quantity: 1, remainingQuantity: 1, orderLegCollection: [leg('SELL_TO_CLOSE', 1, LONG)] },
  ];
  const all = planFor(debit, { type: 'MARKET' }, working);
  assert.deepEqual(all.steps.map(s => [s.kind, s.orderId ?? null]), [['cancel', 30], ['cancel', 31], ['place', null]], 'the working spread close, then the leg\'s stop, then the close');
  assert.match(planFor(debit, { type: 'MARKET', qty: 1 }, working).error, /already close 3 of the RBRK 8\/28\/26 105C, so a partial close can take up to 0 spreads/);
  const trimRoom = planFor(debit, { type: 'MARKET', qty: 1 }, working.filter(o => o.orderId !== 31));
  assert.equal(trimRoom.error, '');
  assert.equal(trimRoom.steps.length, 1, 'a trim leaves the other orders where they are');
});

// a fake Schwab worker holding the call debit spread: a market multi-leg order fills every leg at once, a limit goes on the list
function broker() {
  const live = { positions: [opt(LONG, 3, 6, 7), opt(SHORT, -3, 2.5, 3)], orders: plain(ORDERS), nextId: 900 };
  const sent = [];
  const fetch = async (url, init = {}) => {
    const path = url.slice(PROXY.length), method = init.method || 'GET';
    if (method === 'GET') {
      if (path.includes('/orders?')) return json(live.orders);
      if (path.endsWith('?fields=positions')) return json({ securitiesAccount: { ...ACCOUNT, positions: live.positions } });
      return json({}, 404);
    }
    const body = JSON.parse(init.body);
    sent.push({ method, body });
    const orderId = live.nextId++;
    if (body.orderType === 'MARKET') {
      live.positions = live.positions.map(p => {
        const l = body.orderLegCollection.find(x => x.instrument.symbol === p.instrument.symbol);
        if (!l) return p;
        const q = (p.longQuantity || -p.shortQuantity) + (l.instruction === 'SELL_TO_CLOSE' ? -l.quantity : l.quantity);
        return { ...p, longQuantity: Math.max(q, 0), shortQuantity: Math.max(-q, 0), marketValue: p.marketValue / (p.longQuantity || -p.shortQuantity) * q };
      }).filter(p => p.longQuantity || p.shortQuantity);
    } else live.orders.push({ ...body, orderId, quantity: body.orderLegCollection[0].quantity, status: 'WORKING', enteredTime: new Date().toISOString() });
    return new Response(null, { status: 201, headers: { Location: `${PROXY}/trader/v1/accounts/HASH1/orders/${orderId}` } });
  };
  return { fetch, sent, live };
}
const KEY = `${LONG},${SHORT}`;

test('Close on a spread trims it as one order at market, and the re-read confirms every leg went', async () => {
  const b = broker();
  const { run, elements, state } = await app({ fetch: b.fetch, storage: connected() });
  run("setView('positions')");
  await settle();
  assert.match(elements.get('positionsSection').innerHTML, new RegExp(`data-action="openSpreadClose" data-arg="${KEY}"`));
  await run(`openSpreadClose('${KEY}')`);
  assert.equal(state.openSheetName, 'spreadClose');
  const t = () => state.spreadTicket;
  assert.equal(t().close.type, 'LIMIT', 'a net limit at the mark to start');
  assert.equal(t().close.price, 4);
  assert.equal(t().close.qty, 3);
  const html = () => elements.get('spreadCloseBody').innerHTML;
  assert.match(html(), /Long 3 spreads RBRK 8\/28\/26 105\/115C/);
  assert.match(html(), /Close 3 spreads RBRK 8\/28\/26 105\/115C for a net credit of \$4\.00 or better, as one order: sell 3 RBRK 8\/28\/26 105C, buy 3 RBRK 8\/28\/26 115C/);
  assert.match(html(), /likely fills right away/, 'a limit at the mark');
  run('setSpreadClosePortion(0.5)');
  assert.equal(t().close.qty, 1, 'half of 3, at least one');
  run("setSpreadCloseType('MARKET')");
  assert.match(html(), /fills each leg at its own market/);
  await run('placeSpreadClose()');
  assert.equal(b.sent.length, 1, 'one order for both legs');
  assert.equal(b.sent[0].body.orderType, 'MARKET');
  assert.deepEqual(b.sent[0].body.orderLegCollection.map(l => [l.instruction, l.quantity]), [['SELL_TO_CLOSE', 1], ['BUY_TO_CLOSE', 1]]);
  assert.equal(t().confirmed, true);
  assert.equal(t().done, 'Schwab now shows 2 spreads RBRK 8/28/26 105/115C.');
  assert.equal(state.positions.spreads[0].units, 2);
  await run('placeSpreadClose()');
  assert.equal(b.sent.length, 1, 'sent once');
});

test('a net limit close goes on Schwab\'s list and is confirmed there; Schwab changing first sends nothing', async () => {
  const b = broker();
  const { run, state } = await app({ fetch: b.fetch, storage: connected() });
  run("setView('positions')");
  await settle();
  await run(`openSpreadClose('${KEY}')`);
  run('setSpreadClosePrice("5.12")');
  assert.equal(state.spreadTicket.price, 5.1, 'snapped to the $0.10 step from $3');
  // a leg changes before the send: the plan differs, so nothing goes
  b.live.positions = [opt(LONG, 2, 6, 7), opt(SHORT, -2, 2.5, 3)];
  await run('placeSpreadClose()');
  assert.equal(b.sent.length, 0);
  assert.match(state.spreadTicket.notice, /Schwab changed since you opened this/);
  assert.equal(state.spreadTicket.close.price, 5.12, 'the form carries over');
  await run('placeSpreadClose()');
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].body.orderType, 'NET_CREDIT');
  assert.equal(b.sent[0].body.price, 5.1);
  assert.equal(state.spreadTicket.confirmed, true);
  assert.equal(state.spreadTicket.done, 'Schwab now shows a net limit $5.10 to close 2 spreads RBRK 8/28/26 105/115C.');
});

test('a spread\'s net bid and ask come from its legs: bought legs at the bid and sold ones at the ask to sell it', async () => {
  const { run } = await app();
  const legs = [{ symbol: 'L', n: 1 }, { symbol: 'S', n: -1 }];
  const quotes = { L: { last: 7, bid: 6.9, ask: 7.1 }, S: { last: 3, bid: 2.95, ask: 3.05 } };
  const q = run(`netQuote(${JSON.stringify(legs)}, ${JSON.stringify(quotes)})`);
  assert.equal(+q.bid.toFixed(2), 3.85);
  assert.equal(+q.ask.toFixed(2), 4.15);
  assert.equal(+q.last.toFixed(2), 4, 'the middle, since legs trade apart');
  assert.equal(q.mid, true);
  assert.equal(run(`netQuote(${JSON.stringify(legs)}, ${JSON.stringify({ L: quotes.L })})`), null, 'a leg missing, no quote');
  assert.equal(run(`netQuote(${JSON.stringify(legs)}, ${JSON.stringify({ ...quotes, S: { last: 3, bid: 0, ask: 3.05 } })})`), null, 'a leg with no bid, no quote');
  assert.equal(run(`tradierSymbol('RBRK  260828C00105000')`), 'RBRK260828C00105000');
});

test('Close on a spread shows its net bid, mid and ask, lighting the side it closes on', async () => {
  const b = broker();
  b.live.positions = plain(ACCOUNT.positions); // the put credit too
  const quotes = { [LONG.replace(/\s+/g, '')]: { last: 7, bid: 6.9, ask: 7.1 }, [SHORT.replace(/\s+/g, '')]: { last: 3, bid: 2.95, ask: 3.05 },
    [SOLD.replace(/\s+/g, '')]: { last: 2.5, bid: 2.45, ask: 2.55 }, [BOUGHT.replace(/\s+/g, '')]: { last: 1, bid: 0.95, ask: 1.05 } };
  const fetch = async (url, init) => {
    if (!url.includes('/markets/quotes')) return b.fetch(url, init);
    const asked = decodeURIComponent(url.split('symbols=')[1]).split(',');
    return json({ quotes: { quote: asked.map(s => ({ symbol: s, ...quotes[s] })) } });
  };
  const { run, elements } = await app({ fetch, storage: connected() });
  run("document.getElementById('apiKey').value = 'tradier-test'");
  const strip = () => elements.get('spreadCloseQuote').innerHTML;
  await run('refreshPositions()');
  await run(`openSpreadClose('${KEY}')`);
  assert.match(strip(), /Mid<span class="tq-status"><span class="tq-dot"><\/span>Live<\/span><\/span><span class="tq-val">\$4\.00</);
  assert.match(strip(), /<div class="tq-cell fills"><span class="tq-label">Bid<\/span><span class="tq-val">\$3\.85</, 'a debit spread closes by selling it, at the bid');
  assert.match(strip(), /<div class="tq-cell"><span class="tq-label">Ask<\/span><span class="tq-val">\$4\.15</);
  // the put credit: buying it back costs the sold leg's ask less the bought leg's bid
  const credit = `${BOUGHT},${SOLD}`;
  await run(`openSpreadClose('${credit}')`);
  assert.match(strip(), /<div class="tq-cell"><span class="tq-label">Bid<\/span><span class="tq-val">\$1\.40</);
  assert.match(strip(), /<div class="tq-cell fills"><span class="tq-label">Ask<\/span><span class="tq-val">\$1\.60</, 'a credit spread closes by buying it back, at the ask');
});
