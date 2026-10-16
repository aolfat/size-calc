// Run with: node --test
// Saving 5-minute bars for the journal's trades: which symbols and days they need (barsNeeded), Tradier's timesales
// packed per day, the save (only what's missing, holidays kept empty, a refused symbol skipped), and when it runs.
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
  const need = JSON.parse(run(`JSON.stringify([...barsNeeded(${JSON.stringify([stock, call])}, ${NOW})])`));
  assert.deepEqual(need, [
    ['AAPL', ['2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14']],
    ['AAPL261218C00245000', ['2026-10-13', '2026-10-14']],
  ], 'the open call runs to yesterday, never today; its underlying joins the stock\'s days');
  const evening = ms => JSON.parse(run(`JSON.stringify([...barsNeeded(${JSON.stringify([call])}, ${ms})])`))[0][1].at(-1);
  assert.equal(evening(Date.parse('2026-10-15T23:59:00Z')), '2026-10-14', '19:59 ET: today is still trading after hours');
  assert.equal(evening(Date.parse('2026-10-16T00:00:00Z')), '2026-10-15', '20:00 ET: extended hours are over, today is done');
  assert.equal(run(`lastDoneDay(${Date.parse('2026-12-02T01:00:00Z')})`), '2026-12-01', '20:00 EST too');
  assert.equal(run(`lastDoneDay(${Date.parse('2026-12-02T00:59:00Z')})`), '2026-11-30');
  const old = { ...stock, openedAt: '2026-08-03T14:30:00.000Z', closedAt: '2026-09-15T15:00:00.000Z' };
  const clipped = JSON.parse(run(`JSON.stringify([...barsNeeded(${JSON.stringify([old])}, ${NOW})])`));
  assert.equal(clipped[0][1][0], '2026-09-10', 'nothing older than 35 days: Tradier wouldn\'t have it');
  assert.deepEqual(JSON.parse(run(`JSON.stringify([...barsNeeded(${JSON.stringify([{ ...stock, status: 'history', openedAt: '' }])}, ${NOW})])`)), [], 'a trade from before the history has no dates');
  const packed = JSON.parse(run(`JSON.stringify([...barsByDay([{ time: '2026-10-13T09:35:00', open: 2, high: 3, low: 1, close: 2.5, volume: 10 }, { time: '2026-10-13T09:30:00', open: 1, high: 2, low: 1, close: 2 }, { time: 'junk' }])])`));
  assert.deepEqual(packed, [['2026-10-13', [['09:30', 1, 2, 1, 2, 0], ['09:35', 2, 3, 1, 2.5, 10]]]]);
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
  const r = JSON.parse(await run(`saveTradeBars(${JSON.stringify([stock, call])}, ${NOW}).then(r => JSON.stringify(r))`));
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

  const again = JSON.parse(await run(`saveTradeBars(${JSON.stringify([stock, call])}, ${NOW}).then(r => JSON.stringify(r))`));
  assert.equal(net.calls.length, 2, 'everything kept: no more Tradier calls');
  assert.deepEqual([again.saved, again.through], [0, '2026-10-14']);
});

test('a symbol Tradier refuses is skipped and named, the rest still save', async () => {
  const net = tradier(['AAPL261218C00245000']);
  const supabase = fakeRecords();
  const { run, elements } = await app({ fetch: net.fetch, supabase, session: SESSION });
  elements.get('apiKey').value = 'test-key';
  const r = JSON.parse(await run(`saveTradeBars(${JSON.stringify([stock, call])}, ${NOW}).then(r => JSON.stringify(r))`));
  assert.deepEqual(r.failed, ['AAPL261218C00245000']);
  assert.equal(r.saved, 4);
  assert.ok(![...supabase.bars.keys()].some(k => k.includes('C00245000')), 'nothing kept for it, so the next run asks again');
});

test('when it runs: after the journal loads, with a key, at most hourly; and the Import sheet says how it went', async () => {
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
  assert.match(run('barsLine()'), /Add a Tradier key in Settings/);
  elements.get('apiKey').value = 'test-key';
  run("setView('journal')");
  await run('loadJournal()');
  for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
  assert.ok(net.calls.some(c => c.symbol === 'MSFT'), 'opening the journal saved its trades\' bars');
  assert.ok([...supabase.bars.keys()].some(k => k.startsWith('user-1:MSFT:')));
  assert.match(run('barsLine()'), /^5-minute bars saved through \d+\/\d+\/\d{2} · \d+ new days? last time\.$/);
  assert.ok(JSON.parse(storage.get('journal_bars')).user === 'user-1');
  const calls = net.calls.length;
  assert.equal(await run('maybeSaveBars()'), null, 'within the hour: skipped');
  assert.equal(net.calls.length, calls);
  run('openJournalImport()');
  assert.match(elements.get('journalImportBody').innerHTML, /id="journalBarsStatus"[^>]*>5-minute bars saved through/);
});
