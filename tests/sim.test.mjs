import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const NOW = Date.UTC(2026, 9, 14, 17), EXP = '2026-12-18';

async function simulator(t) {
  const h = await app({ clock: true, width: 1440 });
  await h.advance(NOW - h.run('Date.now()'));
  h.elements.get('simChart').getContext = () => new Proxy({}, { get: () => () => {} });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  t.after(() => { delete globalThis.getComputedStyle; });
  return h;
}

const card = (extra = {}) => ({ isCall: true, parsed: { ticker: 'HOOD', strike: 50, expStr: EXP },
  iv: 0.6, mid: 3, underlyingPrice: 41.1, stopLevel: 39, asOf: '10:00:00 AM', ...extra });

test('pinned call and allocation put simulations fit the displayed mid even when vendor IV is absent or different', async t => {
  const { run, elements } = await simulator(t);
  for (const d of [card(), card({ iv: 0 }), card({ isCall: false, sizing: 'allocation', shortPut: true, credit: true,
    parsed: { ticker: 'HOOD', strike: 40, expStr: EXP }, mid: 1.5, iv: 0.65 })]) {
    run(`openSim(simParamsFromCard(${JSON.stringify(d)}, ${d.mid}, 2))`);
    assert.equal(run('simCurve(simState.spot)[0].v'), d.mid);
    assert.match(elements.get('simReadout').innerHTML, /\+0\.0%.*\+\$0\.00/);
    assert.match(elements.get('simMeta').textContent, /Tradier mid.*as of 10:00:00 AM.*fitted/);
    const higher = run('simCurve(45)[0].v');
    assert.ok(d.isCall ? higher > d.mid : higher < d.mid);
  }
});

test('the pinned-card button calibrates the model without modifying the stored quote or IV', async t => {
  const { run } = await simulator(t);
  run(`pinnedData.test = ${JSON.stringify(card({ lossPerContract: 100 }))}; simFromPinned('test')`);
  assert.equal(run('simCurve(simState.spot)[0].v'), 3);
  assert.equal(run('pinnedData.test.iv'), 0.6);
  assert.equal(run('pinnedData.test.mid'), 3);
});

test('calculator detail keeps its planned entry separate from the current market premium', async t => {
  const { run, elements } = await simulator(t);
  run(`quoteData = { symbol: 'HOOD', last: 41.1 }; selectedExp = '${EXP}';
    var c = { opt: { symbol: 'HOOD261218C00050000', strike: 50 }, isCall: true, iv: 0.6, mid: 3,
      entryPrem: 2.5, contracts: 2, stop: 39, lossPerContract: 100, totalCost: 500, atStop: 1.5,
      lossOfCost: 50, vol: 10, oi: 20, delta: 0.5, model: 'bs' };
    var tr = { classList: { add() {}, remove() {} }, nextSibling: null };
    showDetail(tr, c, 50000); actions.openSimFor({ dataset: { arg: c.opt.symbol } })`);
  assert.equal(run('simState.entry'), 2.5);
  assert.equal(run('simCurve(simState.spot)[0].v'), 3);
  assert.match(elements.get('simReadout').innerHTML, /\+20\.0%.*\+\$100\.00/);
});

test('debit and credit spreads fit each leg, preserve quote data, and settle to the correct intrinsic payoff', async t => {
  const { run, elements } = await simulator(t);
  for (const isCall of [true, false]) {
    for (const credit of [true, false]) {
      const legs = isCall
        ? [{ K: 50, side: 1, mid: 3, iv: 0.6 }, { K: 55, side: -1, mid: 1.5, iv: 0.5 }]
        : [{ K: 40, side: 1, mid: 1.5, iv: 0.65 }, { K: 35, side: -1, mid: 0.5, iv: 0.55 }];
      const d = card({ kind: 'spread', isCall, credit, legs, mid: legs[0].mid - legs[1].mid });
      run(`var source = ${JSON.stringify(d)}; openSim(simParamsFromCard(source, source.mid, 2))`);
      assert.equal(run('simCurve(simState.spot)[0].v'), d.mid);
      assert.match(elements.get('simReadout').innerHTML, /\+0\.0%.*\+\$0\.00/);
      assert.ok(Math.abs(run('simState.legs.reduce((v, L) => v + L.side * bsPrice(simState.isCall, simState.spot, L.K, yearsToExp(simState.expStr), L.iv, RISK_FREE), 0)') - d.mid) < 1e-7);
      assert.equal(run(`simCurve(${isCall ? 60 : 30}).at(-1).v`), 5);
      assert.equal(run(`simCurve(${isCall ? 30 : 60}).at(-1).v`), 0);
      assert.equal(run('JSON.stringify(source.legs)'), JSON.stringify(legs));
    }
  }
});

test('a quote snapshot remains consistent after a price chip, an unrelated quote update, and a later redraw', async t => {
  const { run, elements, advance } = await simulator(t);
  run(`openSim(simParamsFromCard(${JSON.stringify(card())}, 3, 2)); quoteData = { symbol: 'HOOD', last: 50 }; simSetPrice(1); simSetPrice('current')`);
  assert.equal(+elements.get('simPrice').value, 41.1);
  await advance(60000);
  run('drawSim()');
  assert.equal(run('simCurve(simState.spot)[0].t'), NOW);
  assert.equal(run('simCurve(simState.spot)[0].v'), 3);
});

test('unfittable current premiums and spread legs cannot silently fall back to vendor IV', async t => {
  const { run, elements } = await simulator(t);
  for (const d of [card({ mid: 100 }), card({ kind: 'spread', mid: 1.5,
    legs: [{ K: 50, side: 1, mid: 3, iv: 0.6 }, { K: 55, side: -1, mid: 100, iv: 0.5 }] })]) {
    run(`closeSim(); openSim(simParamsFromCard(${JSON.stringify(d)}, 3, 2))`);
    assert.equal(run('simState'), null);
    assert.match(elements.get('errorBox').textContent, /cannot fit/i);
  }
});
