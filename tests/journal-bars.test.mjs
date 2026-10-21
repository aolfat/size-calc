// Run with: node --test
// Saving 5-minute bars for the journal's trades: which symbols and days they need (barsNeeded: the hold, the weekdays
// before it, the market basket), Tradier's timesales packed per day, the save (only what's missing, holidays kept empty,
// a refused symbol skipped, the provider named, older databases without the source column), and when it runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const NOW = Date.parse('2026-10-15T18:00:00Z'); // a Thursday afternoon in New York
const stock = { symbol: 'AAPL', assetType: 'EQUITY', status: 'win', openedAt: '2026-10-09T14:30:00.000Z', closedAt: '2026-10-13T15:00:00.000Z' };
const call = { symbol: 'AAPL  261218C00245000', assetType: 'OPTION', status: 'open', openedAt: '2026-10-13T14:00:00.000Z', closedAt: null };

test('which bars the trades need: each weekday open, finished days only, both an option and its underlying', async () => {
  const { run } = await app();
  assert.deepEqual(JSON.parse(run("JSON.stringify(weekdaysBetween('2026-10-09', '2026-10-13'))")), ['2026-10-09', '2026-10-12', '2026-10-13'], 'no weekend');
  const need = JSON.parse(run(`JSON.stringify([...barsNeeded(${JSON.stringify([stock, call])}, ${NOW}, { lookback: 0 })])`));
  assert.deepEqual(need, [
    ['AAPL', ['2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14']],
    ['AAPL261218C00245000', ['2026-10-13', '2026-10-14']],
  ], 'the open call runs to yesterday, never today; its underlying joins the stock\'s days');
  const evening = ms => JSON.parse(run(`JSON.stringify([...barsNeeded(${JSON.stringify([call])}, ${ms}, { lookback: 0 })])`))[0][1].at(-1);
  assert.equal(evening(Date.parse('2026-10-15T23:59:00Z')), '2026-10-14', '19:59 ET: today is still trading after hours');
  assert.equal(evening(Date.parse('2026-10-16T00:00:00Z')), '2026-10-15', '20:00 ET: extended hours are over, today is done');
  assert.equal(run(`lastDoneDay(${Date.parse('2026-12-02T01:00:00Z')})`), '2026-12-01', '20:00 EST too');
  assert.equal(run(`lastDoneDay(${Date.parse('2026-12-02T00:59:00Z')})`), '2026-11-30');
  const old = { ...stock, openedAt: '2026-08-03T14:30:00.000Z', closedAt: '2026-09-15T15:00:00.000Z' };
  const clipped = JSON.parse(run(`JSON.stringify([...barsNeeded(${JSON.stringify([old])}, ${NOW}, { lookback: 0 })])`));
  assert.equal(clipped[0][1][0], '2026-09-10', 'nothing older than 35 days: Tradier wouldn\'t have it');
  assert.deepEqual(JSON.parse(run(`JSON.stringify([...barsNeeded(${JSON.stringify([{ ...stock, status: 'history', openedAt: '' }])}, ${NOW})])`)), [], 'a trade from before the history has no dates');
  const packed = JSON.parse(run(`JSON.stringify([...barsByDay([{ time: '2026-10-13T09:35:00', open: 2, high: 3, low: 1, close: 2.5, volume: 10 }, { time: '2026-10-13T09:30:00', open: 1, high: 2, low: 1, close: 2 }, { time: 'junk' }])])`));
  assert.deepEqual(packed, [['2026-10-13', [['09:30', 1, 2, 1, 2, 0], ['09:35', 2, 3, 1, 2.5, 10]]]]);
});

test('the weekdays before a trade for its stock, and the market basket every weekday, inside the window', async () => {
  const { run } = await app();
  const need = sets => JSON.parse(run(`JSON.stringify([...barsNeeded(${sets})])`));
  assert.deepEqual(JSON.parse(run("JSON.stringify(weekdaysBefore('2026-10-12', 3))")), ['2026-10-07', '2026-10-08', '2026-10-09'], 'the weekend skipped, the day itself left out');
  const both = need(`${JSON.stringify([stock, call])}, ${NOW}`);
  assert.equal(both[0][0], 'AAPL');
  assert.equal(both[0][1][0], '2026-09-11', "20 weekdays before the stock's open on 10/9");
  assert.equal(both[0][1].length, 24, 'then every weekday through yesterday, once');
  assert.deepEqual(both[1], ['AAPL261218C00245000', ['2026-10-13', '2026-10-14']], "the contract only while held: the run rate compares the underlying's volume");
  const early = need(`${JSON.stringify([{ ...stock, openedAt: '2026-09-14T14:30:00.000Z' }])}, ${NOW}`);
  assert.equal(early[0][1][0], '2026-09-10', 'clipped at 35 days back: Tradier wouldn\'t have the rest');
  const market = need(`[], ${NOW}, { market: ['SPY', 'QQQ'] }`);
  assert.deepEqual(market.map(([sym, days]) => [sym, days[0], days.at(-1), days.length]), [['SPY', '2026-09-10', '2026-10-14', 25], ['QQQ', '2026-09-10', '2026-10-14', 25]], 'every weekday in the window, traded or not');
  const basket = JSON.parse(run('JSON.stringify(MARKET_BASKET)'));
  assert.ok(basket.includes('SPY') && basket.includes('QQQ') && basket.includes('XLK'));
  assert.equal(new Set(basket).size, basket.length);
});

/** a fake Tradier: two bars a day for every weekday asked, none on 10/12 (as if a holiday); `refuse` symbols get a 401 */
function tradier(refuse = []) {
  const calls = [];
  const fetch = async url => {
    const u = new URL(url);
    const symbol = u.searchParams.get('symbol');
    calls.push({ symbol, start: u.searchParams.get('start'), end: u.searchParams.get('end'), session: u.searchParams.get('session_filter') });
    if (refuse.includes(symbol)) return new Response('no', { status: 401 });
    const data = [];
    for (let t = Date.parse(u.searchParams.get('start').slice(0, 10) + 'T12:00:00Z'); t <= Date.parse(u.searchParams.get('end').slice(0, 10) + 'T12:00:00Z'); t += 864e5) {
      const day = new Date(t).toISOString().slice(0, 10), wd = new Date(t).getUTCDay();
      if (wd === 0 || wd === 6 || day === '2026-10-12') continue;
      data.push({ time: `${day}T09:30:00`, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }, { time: `${day}T09:35:00`, open: 1.5, high: 2.5, low: 1, close: 2, volume: 50 });
    }
    return new Response(JSON.stringify({ series: data.length ? { data } : null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch, calls };
}

test('saving: one Tradier call per symbol for what\'s missing, a holiday kept empty, nothing twice', async () => {
  const net = tradier();
  const supabase = fakeRecords();
  const { run, elements } = await app({ fetch: net.fetch, supabase, session: SESSION });
  elements.get('apiKey').value = 'test-key';
  const r = JSON.parse(await run(`saveTradeBars(${JSON.stringify([stock, call])}, ${NOW}, { lookback: 0 }).then(r => JSON.stringify(r))`));
  assert.deepEqual(net.calls.map(c => [c.symbol, c.start, c.end, c.session]), [
    ['AAPL', '2026-10-09 04:00', '2026-10-14 20:00', 'all'],
    ['AAPL261218C00245000', '2026-10-13 04:00', '2026-10-14 20:00', 'all'],
  ]);
  const rows = [...supabase.bars.values()].map(b => [b.symbol, b.day, b.bars.length]).sort();
  assert.deepEqual(rows, [['AAPL', '2026-10-09', 2], ['AAPL', '2026-10-12', 0], ['AAPL', '2026-10-13', 2], ['AAPL', '2026-10-14', 2], ['AAPL261218C00245000', '2026-10-13', 2], ['AAPL261218C00245000', '2026-10-14', 2]],
    '10/12 had nothing, so it\'s kept empty and never asked for again');
  assert.deepEqual(supabase.bars.get('user-1:AAPL:2026-10-13').bars[0], ['09:30', 1, 2, 0.5, 1.5, 100]);
  assert.ok(supabase.writes.filter(w => w.table === 'bars_5m').every(w => w.ignoreDuplicates && w.onConflict === 'user_id,symbol,day'));
  assert.deepEqual([r.saved, r.symbols, r.through, r.failed], [6, 2, '2026-10-14', []]);

  const again = JSON.parse(await run(`saveTradeBars(${JSON.stringify([stock, call])}, ${NOW}, { lookback: 0 }).then(r => JSON.stringify(r))`));
  assert.equal(net.calls.length, 2, 'everything kept: no more Tradier calls');
  assert.deepEqual([again.saved, again.through], [0, '2026-10-14']);
});

test('every saved day names its provider; a database without the source column still saves', async () => {
  const net = tradier();
  const supabase = fakeRecords();
  const { run, elements } = await app({ fetch: net.fetch, supabase, session: SESSION });
  elements.get('apiKey').value = 'test-key';
  const r = JSON.parse(await run(`saveTradeBars([], ${NOW}, { market: ['SPY'] }).then(r => JSON.stringify(r))`));
  assert.deepEqual(net.calls.map(c => [c.symbol, c.start, c.end]), [['SPY', '2026-09-10 04:00', '2026-10-14 20:00']], 'the basket with no trades at all');
  assert.equal(r.saved, 25);
  assert.ok([...supabase.bars.values()].every(b => b.source === 'tradier'));

  const old = fakeRecords();
  old.failColumn('bars_5m', 'source');
  const before = await app({ fetch: tradier().fetch, supabase: old, session: SESSION });
  before.elements.get('apiKey').value = 'test-key';
  const r2 = JSON.parse(await before.run(`saveTradeBars([], ${NOW}, { market: ['SPY'] }).then(r => JSON.stringify(r))`));
  assert.equal(r2.saved, 25, 'before the migration is pushed: saved without it (the column defaults to tradier)');
  assert.ok([...old.bars.values()].every(b => !('source' in b)));
});

test('a symbol Tradier refuses is skipped and named, the rest still save', async () => {
  const net = tradier(['AAPL261218C00245000']);
  const supabase = fakeRecords();
  const { run, elements } = await app({ fetch: net.fetch, supabase, session: SESSION });
  elements.get('apiKey').value = 'test-key';
  const r = JSON.parse(await run(`saveTradeBars(${JSON.stringify([stock, call])}, ${NOW}, { lookback: 0 }).then(r => JSON.stringify(r))`));
  assert.deepEqual(r.failed, ['AAPL261218C00245000']);
  assert.equal(r.saved, 4);
  assert.ok(![...supabase.bars.keys()].some(k => k.includes('C00245000')), 'nothing kept for it, so the next run asks again');
});

test('when it runs: after the journal loads, with a key, at most hourly; quietly, nothing in the Import sheet', async () => {
  const day = 864e5, iso = t => new Date(t).toISOString();
  const opened = Date.now() - 6 * day, closed = Date.now() - 2 * day;
  const order = (id, instruction, time, price) => ({ kind: 'order', record_id: String(id), account: '6789', entered_at: iso(time), data: {
    orderId: id, enteredTime: iso(time).replace('.000Z', '+0000'), status: 'FILLED',
    orderLegCollection: [{ legId: 1, instruction, quantity: 10, instrument: { symbol: 'MSFT', assetType: 'EQUITY' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: id * 10, executionLegs: [{ legId: 1, quantity: 10, price, time: iso(time).replace('.000Z', '+0000') }] }],
  } });
  const supabase = fakeRecords([order(1, 'BUY', opened, 500), order(2, 'SELL', closed, 510)]);
  const net = tradier();
  const { run, elements, storage } = await app({ fetch: net.fetch, supabase, session: SESSION });
  assert.equal(await run('maybeSaveBars()'), null, 'no Tradier key: nothing to fetch with');
  elements.get('apiKey').value = 'test-key';
  run("setView('journal')");
  await run('loadJournal()');
  for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
  assert.ok(net.calls.some(c => c.symbol === 'MSFT'), 'opening the journal saved its trades\' bars');
  assert.ok(['SPY', 'QQQ', 'XLRE'].every(sym => net.calls.some(c => c.symbol === sym)), "and the market basket's");
  assert.ok([...supabase.bars.keys()].some(k => k.startsWith('user-1:MSFT:')));
  assert.ok(JSON.parse(storage.get('journal_bars')).user === 'user-1');
  const calls = net.calls.length;
  assert.equal(await run('maybeSaveBars()'), null, 'within the hour: skipped');
  assert.equal(net.calls.length, calls);
  run('openJournalImport()');
  assert.doesNotMatch(elements.get('journalImportBody').innerHTML, /5-minute bars/);
});

test("each provider's reach: Tradier's 35 days, a paid Massive plan's years, and which one serves a day", async () => {
  const { run } = await app();
  const reach = plan => JSON.parse(run(`JSON.stringify(barsReach(${NOW}, ${JSON.stringify(plan)}))`));
  assert.deepEqual(reach(null), { id: 'tradier', tradier: '2026-09-10', stocks: '2026-09-10', options: '2026-09-10', massive: { stocks: false, options: false } });
  assert.equal(reach('free').id, 'tradier', 'the free plan: its 5 calls a minute go to the breadth');
  const paid = reach('stocks');
  assert.equal(paid.id, 'massive');
  assert.ok(paid.stocks > '2021-10-01' && paid.stocks < '2021-11-01', 'five years back, a week inside them');
  assert.equal(paid.options, '2026-09-10', 'no options on Stocks Starter');
  assert.ok(reach('stocks_options').options > '2024-10-01' && reach('stocks_options').options < '2024-11-01', 'two years of options');
  const route = (sym, day, plan) => run(`barRoute(${JSON.stringify(sym)}, ${JSON.stringify(day)}, barsReach(${NOW}, ${JSON.stringify(plan)}))`);
  assert.equal(route('AAPL', '2026-10-01', 'stocks'), 'tradier', 'Tradier inside its window, paid plan or not');
  assert.equal(route('AAPL', '2026-06-01', 'stocks'), 'massive', 'older: Massive');
  assert.equal(route('AAPL', '2026-06-01', null), null, 'older without Massive: nobody');
  assert.equal(route('AAPL261218C00245000', '2026-06-01', 'stocks'), null, 'an option on Stocks Starter');
  assert.equal(route('AAPL261218C00245000', '2026-06-01', 'stocks_options'), 'massive');
  assert.equal(route('AAPL', '2019-06-03', 'stocks'), null, 'past the plan');
  assert.deepEqual(JSON.parse(run("JSON.stringify(daySpans(['2026-01-02', '2026-01-05', '2026-01-30', '2026-06-01']))")),
    [['2026-01-02', '2026-01-05'], ['2026-01-30', '2026-01-30'], ['2026-06-01', '2026-06-01']], 'a request per run of days, a new one after two weeks apart');
  assert.equal(JSON.parse(run("JSON.stringify(daySpans(weekdaysBetween('2025-01-01', '2025-12-31')))")).length, 3, 'about half a year a request at most');
});

test('with a paid Massive plan the saver keeps only the held days, for the charts; the plan is device-local and paces nothing', async () => {
  const net = tradier();
  const supabase = fakeRecords();
  const a = await app({ fetch: net.fetch, supabase, session: SESSION, storage: new Map([['massive_key', 'mk'], ['massive_plan', 'stocks']]) });
  a.elements.get('apiKey').value = 'test-key';
  assert.deepEqual(JSON.parse(a.run('JSON.stringify(barsToKeep())')), { market: [], lookback: 0 }, 'the basket and lookback come from Massive');
  assert.equal(a.run('massivePaid()'), true);
  a.storage.set('massive_plan', 'free');
  assert.equal(a.run('massivePaid()'), false);
  assert.ok(JSON.parse(a.run('JSON.stringify(barsToKeep())')).market.includes('SPY'), 'the free plan: saved as before');
  a.storage.set('massive_plan', 'nonsense');
  assert.equal(a.run('massivePlan()'), 'free');
  a.storage.delete('massive_key');
  a.storage.set('massive_plan', 'stocks');
  assert.equal(a.run('massivePaid()'), false, 'a plan without a key is nothing');
  // paced: a paid plan never waits; the free plan waits out 12.5 seconds between calls
  a.storage.set('massive_key', 'mk');
  a.run('globalThis.__waits = []; effects.wait = async ms => { globalThis.__waits.push(ms); }');
  const waits = () => JSON.parse(a.run('JSON.stringify(globalThis.__waits)'));
  for (let i = 0; i < 3; i++) await a.run('massivePaced(async () => 1)');
  assert.deepEqual(waits(), [], 'paid: no pacing');
  a.storage.set('massive_plan', 'free');
  for (let i = 0; i < 2; i++) await a.run('massivePaced(async () => 1)');
  assert.equal(waits().length, 2);
  assert.ok(waits().every(ms => ms > 12000 && ms <= 12500), 'free: five calls a minute');
});

test("a trade page's held days from Massive are kept for its chart, and never read by the stamper", async () => {
  const supabase = fakeRecords();
  const a = await app({ supabase, session: SESSION });
  supabase.bars.set('user-1:AAPL:2026-06-02', { user_id: 'user-1', symbol: 'AAPL', day: '2026-06-02', bars: [['09:30', 1, 2, 1, 2, 10]], source: 'tradier' });
  const saved = await a.run("saveMassiveDays('AAPL', new Map([['2026-06-01', [['09:30', 3, 4, 3, 4, 20]]]]))");
  assert.equal(saved, 1);
  assert.equal(supabase.bars.get('user-1:AAPL:2026-06-01').source, 'massive', 'named with its provider');
  const chart = JSON.parse(await a.run("loadTradeBars('AAPL', ['2026-06-01', '2026-06-02']).then(r => JSON.stringify(r.map(x => x.day).sort()))"));
  assert.deepEqual(chart, ['2026-06-01', '2026-06-02'], 'the chart reads both');
  const kept = JSON.parse(await a.run("loadKeptBars('AAPL', ['2026-06-01', '2026-06-02']).then(m => JSON.stringify([...m.keys()]))"));
  assert.deepEqual(kept, ['2026-06-02'], "the stamper reads Tradier's only, so a comparison never mixes the two");
  const old = fakeRecords();
  old.failColumn('bars_5m', 'source');
  old.bars.set('user-1:AAPL:2026-06-02', { user_id: 'user-1', symbol: 'AAPL', day: '2026-06-02', bars: [['09:30', 1, 2, 1, 2, 10]] });
  const b = await app({ supabase: old, session: SESSION });
  assert.deepEqual(JSON.parse(await b.run("loadKeptBars('AAPL', ['2026-06-02']).then(m => JSON.stringify([...m.keys()]))")), ['2026-06-02'], 'before the source column: every row is Tradier\'s');
});
