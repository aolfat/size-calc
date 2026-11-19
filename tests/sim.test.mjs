import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const NOW = Date.UTC(2026, 9, 14, 17), EXP = '2026-12-18'; // Wednesday Oct 14, 1:00 PM New York

// a 2D context that answers every call (the chart's paint runs whole, drawing nothing)
function fakeContext() {
  const p = new Proxy(function () {}, { get: (o, k) => k === 'measureText' ? () => ({ width: 40 }) : p, apply: () => p, set: () => true });
  return p;
}

async function simulator(t, opts = {}) {
  const h = await app({ clock: true, width: 1440, ...opts });
  await h.advance(NOW - h.run('Date.now()'));
  h.elements.get('simChart').getContext = fakeContext;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  t.after(() => { delete globalThis.getComputedStyle; });
  return h;
}

const card = (extra = {}) => ({ isCall: true, parsed: { ticker: 'HOOD', strike: 50, expStr: EXP },
  iv: 0.6, mid: 3, underlyingPrice: 41.1, stopLevel: 39, asOf: '10:00:00 AM', ...extra });
const atNow = 'simView.S = simState.spot; simView.t = simState.asOf; drawSim()';

test('pinned call and allocation put simulations fit the displayed mid even when vendor IV is absent or different', async t => {
  const { run, elements } = await simulator(t);
  for (const d of [card(), card({ iv: 0 }), card({ isCall: false, sizing: 'allocation', shortPut: true, credit: true,
    parsed: { ticker: 'HOOD', strike: 40, expStr: EXP }, mid: 1.5, iv: 0.65 })]) {
    run(`openSim(simParamsFromCard(${JSON.stringify(d)}, ${d.mid}, 2)); ${atNow}`);
    assert.equal(run('simCurve(simState.spot)[0].v'), d.mid);
    assert.match(elements.get('simValue').innerHTML, new RegExp(`^\\$${d.mid.toFixed(2)}<small>`));
    assert.match(elements.get('simResult').innerHTML, /\+\$0<\/span>.*\+0%/);
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
    showDetail(tr, c, 50000); actions.openSimFor({ dataset: { arg: c.opt.symbol } }); ${atNow}`);
  assert.equal(run('simState.entry'), 2.5);
  assert.equal(run('simCurve(simState.spot)[0].v'), 3);
  assert.match(elements.get('simResult').innerHTML, /\+\$100<\/span>.*R<\/span>.*\+20%/, 'dollars, R off the stop, percent of the entry');
});

test('debit and credit spreads fit each leg, preserve quote data, and settle to the correct intrinsic payoff', async t => {
  const { run, elements } = await simulator(t);
  for (const isCall of [true, false]) {
    for (const credit of [true, false]) {
      const legs = isCall
        ? [{ K: 50, side: 1, mid: 3, iv: 0.6 }, { K: 55, side: -1, mid: 1.5, iv: 0.5 }]
        : [{ K: 40, side: 1, mid: 1.5, iv: 0.65 }, { K: 35, side: -1, mid: 0.5, iv: 0.55 }];
      const d = card({ kind: 'spread', isCall, credit, legs, mid: legs[0].mid - legs[1].mid });
      run(`var source = ${JSON.stringify(d)}; openSim(simParamsFromCard(source, source.mid, 2)); ${atNow}`);
      assert.equal(run('simCurve(simState.spot)[0].v'), d.mid);
      assert.match(elements.get('simResult').innerHTML, /\+\$0<\/span>.*\+0%/);
      assert.match(elements.get('simValue').innerHTML, credit ? /to close/ : /per spread/);
      assert.match(elements.get('simFacts').innerHTML, /Max gain <b class="pos">\+\$\d.*Max loss <b class="neg">−\$\d/);
      assert.ok(Math.abs(run('simState.legs.reduce((v, L) => v + L.side * bsPrice(simState.isCall, simState.spot, L.K, yearsToExp(simState.expStr), L.iv, RISK_FREE), 0)') - d.mid) < 1e-7);
      assert.equal(run(`simCurve(${isCall ? 60 : 30}).at(-1).v`), 5);
      assert.equal(run(`simCurve(${isCall ? 30 : 60}).at(-1).v`), 0);
      assert.equal(run('JSON.stringify(source.legs)'), JSON.stringify(legs));
    }
  }
});

test('a quote snapshot remains consistent after moving the target, an unrelated quote update, and a later redraw', async t => {
  const { run, elements, advance } = await simulator(t);
  run(`openSim(simParamsFromCard(${JSON.stringify(card())}, 3, 2)); quoteData = { symbol: 'HOOD', last: 50 }; simView.S = 45; drawSim(); ${atNow}`);
  assert.equal(elements.get('simPxInput').value, '41.10');
  await advance(60000);
  run('drawSim()');
  assert.equal(run('simCurve(simState.spot)[0].t'), NOW);
  assert.equal(run('simCurve(simState.spot)[0].v'), 3);
  assert.match(elements.get('simValue').innerHTML, /^\$3\.00/);
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

test('the sheet opens on 1R at 3:00 PM the next session, and price, day and time each move alone', async t => {
  const { run, elements } = await simulator(t);
  run(`openSim(simParamsFromCard(${JSON.stringify(card())}, 3, 2))`);
  assert.equal(run('openSheetName'), 'sim');
  assert.equal(run('simView.S'), 43.2, '1R: the stop is 2.10 under, so 2.10 over');
  assert.equal(run('simView.t'), Date.UTC(2026, 9, 15, 19), 'Thursday 3:00 PM New York');
  assert.equal(elements.get('simDayText').textContent, 'Tomorrow');
  assert.equal(elements.get('simTimeText').textContent, '3:00 PM');
  assert.match(elements.get('simPxText').textContent, /\$43\.20 · 1R/);
  run("simTargetPrice({ value: '45', blur() {} })");
  assert.equal(run('simView.S'), 45);
  assert.equal(run('simView.t'), Date.UTC(2026, 9, 15, 19), 'a typed price leaves the time');
  run("simTargetDay({ value: '2026-10-17' })"); // a Saturday rolls to Monday, same time of day
  assert.equal(run('simView.t'), Date.UTC(2026, 9, 19, 19));
  assert.equal(run('simView.S'), 45, 'a picked day leaves the price');
  run("simTargetTime({ value: '10:05' })");
  assert.equal(run('simView.t'), Date.UTC(2026, 9, 19, 14, 5));
  run("timeZone = 'pt'; simTargetTime({ value: '07:00' })"); // typed in Pacific time: 10:00 New York
  assert.equal(run('simView.t'), Date.UTC(2026, 9, 19, 14));
  run("simTargetTime({ value: '20:00' })");
  assert.equal(run('simView.t'), Date.UTC(2026, 9, 19, 20), 'held to the close');
});

test('a held position with no stop marks one standard deviation either way and starts on its side', async t => {
  const { run } = await simulator(t);
  run("openSim({ isCall: false, K: 40, expStr: '2026-12-18', iv: 0.5, entry: 2, qty: 1, spot: 41, stop: null, em: 4, label: 'p', parsedTicker: 'HOOD' })");
  assert.equal(run('JSON.stringify(simLevels(simState).map(l => [l.label, l.price]))'), JSON.stringify([['−1σ', 37], ['+1σ', 45]]));
  assert.equal(run('simView.S'), 37, 'a put aims down');
});

test('the history chips are 1M, 3M and 6M, kept on this device; the moving averages share the daily chart\'s switches', async t => {
  const { run, elements, storage } = await simulator(t);
  run(`openSim(simParamsFromCard(${JSON.stringify(card())}, 3, 2))`);
  assert.match(elements.get('simLegend').innerHTML, /data-arg="21" class="on"/, '1M to start');
  assert.deepEqual([...elements.get('simLegend').innerHTML.matchAll(/data-action="simRange" data-arg="(\d+)"/g)].map(m => +m[1]), [21, 63, 126]);
  run('actions.simRange({ dataset: { arg: "63" } })');
  assert.equal(storage.get('sim_range'), '63');
  assert.match(elements.get('simLegend').innerHTML, /data-arg="63" class="on"/);
  run("actions.simToggleInd({ dataset: { arg: 'sma50' } })");
  assert.ok(run('dailyIndOff').includes('sma50'), 'the daily chart hides it too');
  assert.match(elements.get('simLegend').innerHTML, /data-arg="sma50" class="off"/);
});

test('closing keeps where you left the target for the next open of that contract', async t => {
  const { run } = await simulator(t);
  const open = `openSim(simParamsFromCard(${JSON.stringify(card())}, 3, 2))`;
  run(`${open}; simView.S = 44.5; closeSheet()`);
  assert.equal(run('simState'), null, 'the backdrop or a pull down closes the simulator');
  run(open);
  assert.equal(run('simView.S'), 44.5);
});

test('the chart paints with the daily bars of the loaded symbol', async t => {
  const { run, elements } = await simulator(t);
  elements.get('simChart').clientWidth = 380;
  run(`dailySymbol = 'HOOD'; dailyBars = Array.from({ length: 40 }, (_, i) => ({ date: '2026-09-' + String(i % 28 + 1).padStart(2, '0'), open: 40, high: 41, low: 39, close: 40.5 }));
    openSim(simParamsFromCard(${JSON.stringify(card())}, 3, 2))`);
  assert.equal(elements.get('simChart').style.height, '330px');
  assert.ok(run('simView.lo') < 39 && run('simView.hi') > 43.2, 'the scale holds the candles and the levels');
});

test('sessions skip weekends and NYSE holidays; the chart runs on market minutes', async t => {
  const { run } = await simulator(t);
  const days = run("sessionsThrough(Date.UTC(2026, 10, 25, 15), '2026-12-01').map(s => s.day)");
  assert.deepEqual(days, ['2026-11-25', '2026-11-27', '2026-11-30', '2026-12-01'], 'Thanksgiving and the weekend skipped');
  assert.deepEqual(['2027-01-01', '2027-03-26', '2027-06-18', '2027-07-05', '2027-11-25', '2027-12-24', '2026-11-27'].map(d => run(`nyseHoliday('${d}')`)),
    [true, true, true, true, true, true, false]);
  const s = run("sessionsThrough(Date.UTC(2026, 10, 25, 15), '2026-12-01')");
  assert.equal(run(`minuteOf(${JSON.stringify(s)}, Date.UTC(2026, 10, 25, 15))`), 30, '10:00 is 30 minutes in');
  assert.equal(run(`momentAt(${JSON.stringify(s)}, 390 + 60)`), Date.UTC(2026, 10, 27, 15, 30), 'Friday 10:30, past the holiday');
});
