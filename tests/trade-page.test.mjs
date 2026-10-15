// Run with: node --test
// The Journal's trade page: the bars inside a hold, where fills land on a chart, the daily window, the excursions (MFE,
// MAE, exit efficiency), and the page itself (opened from a row, saved bars read, Edit, back to the list).
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const json = (run, code) => JSON.parse(run(`JSON.stringify(${code})`));
const bar = (date, time, open, high, low, close) => ({ date, time, open, high, low, close });
const long = { direction: 'long', avgEntry: 100, entryQty: 100, multiplier: 1, openedAt: '2026-10-13T13:40:10.000Z', closedAt: '2026-10-13T14:31:00.000Z', status: 'win', pnl: 200, risk: 200 };
const BARS = [
  bar('2026-10-13', '09:30', 99, 105, 98, 100), // before the entry (09:40): not part of the hold
  bar('2026-10-13', '09:40', 100, 101, 99.5, 100.5),
  bar('2026-10-13', '09:45', 100.5, 103, 99, 102),
  bar('2026-10-13', '10:30', 102, 102.5, 101, 102),
  bar('2026-10-13', '10:35', 102, 110, 101, 109), // after the exit (10:31): not part of it either
];

test('New York stamps, bars unpacked, regular hours unless a fill was outside them', async () => {
  const { run } = await app();
  assert.equal(run("nyStamp('2026-10-13T13:41:02.000Z')"), '2026-10-13 09:41', 'EDT');
  assert.equal(run("nyStamp('2026-12-01T15:05:00.000Z')"), '2026-12-01 10:05', 'EST');
  assert.equal(run("barStart('2026-10-13 09:44')"), '2026-10-13 09:40');
  const rows = [{ day: '2026-10-14', bars: [['09:30', 1, 2, 0.5, 1.5, 10]] }, { day: '2026-10-13', bars: [['16:05', 1, 1, 1, 1, 0], ['09:35', 2, 3, 1, 2.5, 5]] }];
  const all = json(run, `unpackBars(${JSON.stringify(rows)})`);
  assert.deepEqual(all.map(b => `${b.date} ${b.time}`), ['2026-10-13 09:35', '2026-10-13 16:05', '2026-10-14 09:30'], 'oldest first');
  assert.equal(json(run, `holdChartBars(${JSON.stringify(all)}, [{ time: '2026-10-13T13:40:00.000Z' }])`).length, 2, 'the after-hours bar drops');
  assert.equal(json(run, `holdChartBars(${JSON.stringify(all)}, [{ time: '2026-10-13T20:10:00.000Z' }])`).length, 3, 'unless a fill happened then');
});

test('fills land on the bar they happened in, or their day on a daily chart; the daily view frames the trade', async () => {
  const { run } = await app();
  const fills = [{ time: '2026-10-13T13:40:10.000Z', side: 'buy', qty: 100, price: 100 }, { time: '2026-10-13T14:31:00.000Z', side: 'sell', qty: 100, price: 102 }, { time: '2026-10-20T14:00:00.000Z', side: 'sell', qty: 1, price: 1 }];
  assert.deepEqual(json(run, `fillMarks(${JSON.stringify(BARS)}, ${JSON.stringify(fills)})`).map(m => [m.index, m.side]), [[1, 'buy'], [3, 'sell']], 'a fill off the chart is left out');
  const daily = Array.from({ length: 100 }, (_, i) => { const d = new Date(Date.UTC(2026, 5, 1) + i * 864e5).toISOString().slice(0, 10); return { date: d, open: 1, high: 1, low: 1, close: 1 }; });
  assert.deepEqual(json(run, `fillMarks(${JSON.stringify(daily)}, ${JSON.stringify(fills.slice(0, 1))})`), [], 'no bar that day: left out');
  const oct = [{ date: '2026-10-12', open: 1, high: 1, low: 1, close: 1 }, { date: '2026-10-13', open: 1, high: 1, low: 1, close: 1 }];
  assert.deepEqual(json(run, `fillMarks(${JSON.stringify(oct)}, ${JSON.stringify(fills)})`).map(m => [m.index, m.side]), [[1, 'buy'], [1, 'sell']], 'on a daily chart, the fill\'s day');
  const win = json(run, `dailyWindow(${JSON.stringify(daily)}, { openedAt: '${daily[60].date}T15:00:00.000Z', closedAt: '${daily[70].date}T15:00:00.000Z' })`);
  assert.deepEqual(win, { count: 61, offset: 19 }, '40 sessions before the open through 10 after the close');
});

test('excursions: the best and worst while it was open, in dollars and R, and the share of the best move kept', async () => {
  const { run } = await app();
  const ex = json(run, `excursions(${JSON.stringify(long)}, ${JSON.stringify(BARS)})`);
  assert.deepEqual(ex, { mfe: 300, mae: -100, mfePrice: 103, maePrice: 99, mfeR: 1.5, maeR: -0.5, bars: 3, efficiency: 0.667 },
    'the 09:30 high of 105 and the 10:35 run to 110 were outside the hold');
  const short = json(run, `excursions(${JSON.stringify({ ...long, direction: 'short', avgEntry: 102, pnl: -50 })}, ${JSON.stringify(BARS)})`);
  assert.deepEqual([short.mfe, short.mae, short.mfePrice, short.maePrice, short.efficiency], [300, -100, 99, 103, null], 'a short: lows for, highs against; a loser has no efficiency');
  const opt = json(run, `excursions(${JSON.stringify({ ...long, multiplier: 100, entryQty: 2, pnl: 999999 })}, ${JSON.stringify(BARS)})`);
  assert.equal(opt.mfe, 600, '×100 a contract');
  assert.equal(opt.efficiency, 1, 'never more than all of it');
  const open = json(run, `excursions(${JSON.stringify({ ...long, status: 'open', closedAt: null })}, ${JSON.stringify(BARS)})`);
  assert.equal(open.mfe, 1000, 'open: through the latest bar');
  assert.equal(open.efficiency, null);
  assert.equal(run(`excursions(${JSON.stringify({ ...long, legs: [] })}, ${JSON.stringify(BARS)})`), null, 'spreads come later');
  assert.equal(run(`excursions(${JSON.stringify(long)}, [])`), null, 'no bars, no numbers');
});

test('the exit in words: one price or the average of several, and how much is closed while it\'s open', async () => {
  const { run } = await app();
  const t = { avgExit: 0.71, exits: 3, entryQty: 100, openQty: 40, direction: 'long', status: 'open' };
  assert.deepEqual(json(run, `exitParts(${JSON.stringify(t)})`), { avg: true, closed: 60, verb: 'sold' });
  assert.equal(run(`exitLineLabel(${JSON.stringify(t)})`), 'avg exit 0.71 · 60 of 100', 'trimmed, still open');
  assert.equal(run(`exitLineLabel(${JSON.stringify({ ...t, openQty: 0, status: 'win' })})`), 'avg exit 0.71', 'closed in pieces');
  assert.equal(run(`exitLineLabel(${JSON.stringify({ ...t, exits: 1, openQty: 0, status: 'win' })})`), 'exit 0.71', 'one exit');
  assert.equal(json(run, `exitParts(${JSON.stringify({ ...t, direction: 'short' })})`).verb, 'bought back');
  assert.equal(json(run, `exitParts(${JSON.stringify({ ...t, legs: [] })})`).verb, 'closed', 'a spread');
  assert.equal(run(`exitParts(${JSON.stringify({ ...t, avgExit: null, exits: 0 })})`), null, 'nothing closed yet');
});

// ---------- the page ----------

const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
// 100 AAPL bought 10/1 10:30 ET at 100.02 with a trigger stop at 95, which filled 10/2 at 94.98
const ENTRY = {
  orderId: 501, enteredTime: '2026-10-01T14:30:00+0000', status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction: 'BUY', quantity: 100, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7001, executionLegs: [{ legId: 1, quantity: 100, price: 100.02, time: '2026-10-01T14:30:01+0000' }] }],
  childOrderStrategies: [{
    orderId: 502, status: 'FILLED', orderType: 'STOP', stopPrice: 95,
    orderLegCollection: [{ legId: 1, instruction: 'SELL', quantity: 100, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7002, executionLegs: [{ legId: 1, quantity: 100, price: 94.98, time: '2026-10-02T15:00:00+0000' }] }],
  }],
};
const KEY = '6789|AAPL|long|2026-10-01T14:30:01.000Z';
const day = (d, rows) => ({ user_id: 'user-1', symbol: 'AAPL', day: d, bars: rows });

async function page(opts = {}) {
  const supabase = fakeRecords([{ kind: 'order', record_id: '501', account: '6789', entered_at: '2026-10-01T14:30:00Z', data: ENTRY }]);
  supabase.bars.set('user-1:AAPL:2026-10-01', day('2026-10-01', [['10:25', 100, 100.5, 99.8, 100.2, 1], ['10:30', 100, 101.5, 99, 101, 1], ['15:55', 101, 103, 100.5, 102, 1]]));
  supabase.bars.set('user-1:AAPL:2026-10-02', day('2026-10-02', [['09:30', 102, 104, 97, 98, 1], ['11:00', 96, 96.5, 94.5, 95, 1]]));
  const a = await app({ supabase, session: SESSION, fetch: opts.fetch });
  if (opts.key) a.elements.get('apiKey').value = 'test-key';
  a.run("setView('journal')");
  await a.run('loadJournal()');
  return { ...a, supabase, body: () => a.elements.get('jtBody').innerHTML, head: () => a.elements.get('jtHead').innerHTML };
}
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

test('a row opens the trade page: its saved bars, MFE and MAE, the fills and stops; Edit and back', async () => {
  const { run, state, elements, supabase, body, head } = await page();
  run(`openTradeRow('${KEY}', { target: { closest: () => null } })`);
  await settle();
  assert.equal(elements.get('journalSection').style.display, 'none', 'the list steps aside');
  assert.equal(elements.get('journalTradeSection').style.display, '');
  assert.match(head(), /data-action="closeJournalTrade">← Trades/);
  assert.match(head(), /id="jtTitle">AAPL<\/span>/);
  assert.match(head(), /Long 100 at \$100\.02 → \$94\.98/);
  assert.ok(supabase.reads.some(r => r.table === 'bars_5m' && r.cols === 'day,bars'), 'the saved bars are read');
  assert.equal(state.journalTrade.five.length, 5, 'the hold\'s days, regular hours');
  assert.match(body(), /<dt>MFE<\/dt><dd class="journal-buy">\+\$398\.00<span class="pos-sub">\+0\.79R · best \$104\.00<\/span>/, '(104 − 100.02) × 100, the 10:25 bar before the entry left out');
  assert.match(body(), /<dt>MAE<\/dt><dd class="journal-sell">−\$552\.00<span class="pos-sub">−1\.10R · worst \$94\.50<\/span>/);
  assert.match(body(), /<dt>Exit efficiency<\/dt><dd class="">—<span class="pos-sub">winners only<\/span>/);
  assert.match(body(), /From 4 five-minute bars while it was open/);
  assert.match(body(), /<td>10\/1, 10:30 AM<\/td><td class="journal-buy">Buy<\/td><td>100<\/td><td>\$100\.02<\/td>/, 'the fills, in New York time');
  assert.match(body(), /\$95\.00 <span class="journal-tag journal-tag-quiet">first<\/span><\/td><td>filled<\/td>/, 'the stop orders');
  assert.match(elements.get('jtStatusD').textContent, /Add a Tradier key in Settings for the daily chart/);
  run('editJournalTrade()');
  assert.equal(state.openSheetName, 'tradeReview');
  run('closeSheet(); closeJournalTrade()');
  assert.equal(state.journalTrade, null);
  assert.equal(elements.get('journalSection').style.display, '');
  assert.equal(elements.get('journalTradeSection').style.display, 'none');
});

test('an open trade trimmed twice: how much was sold at what average, and how much is still open', async () => {
  const supabase = fakeRecords([{ kind: 'order', record_id: '601', account: '6789', entered_at: '2026-10-01T14:30:00Z', data: {
    ...ENTRY, orderId: 601, childOrderStrategies: [] } },
  ...[[602, 30, 101, '2026-10-02T15:00:00+0000'], [603, 30, 103, '2026-10-05T15:00:00+0000']].map(([id, qty, price, time]) => ({
    kind: 'order', record_id: String(id), account: '6789', entered_at: time.replace('+0000', 'Z'), data: {
      orderId: id, enteredTime: time, status: 'FILLED',
      orderLegCollection: [{ legId: 1, instruction: 'SELL', quantity: qty, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
      orderActivityCollection: [{ activityType: 'EXECUTION', activityId: id * 10, executionLegs: [{ legId: 1, quantity: qty, price, time }] }],
    } }))]);
  const a = await app({ supabase, session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  a.run(`openJournalTrade('${KEY}')`);
  await settle();
  assert.match(a.elements.get('jtHead').innerHTML, /Long 100 at \$100\.02 · 60 sold at \$102\.00 avg · 40 open</);
});

test('with a key: the daily chart from Tradier, framed on the trade', async () => {
  const days = Array.from({ length: 80 }, (_, i) => { const d = new Date(Date.UTC(2026, 7, 1) + i * 864e5).toISOString().slice(0, 10); return { date: d, open: 100, high: 101, low: 99, close: 100, volume: 1 }; });
  const fetch = async url => {
    if (String(url).includes('/markets/history')) return new Response(JSON.stringify({ history: { day: days } }), { status: 200 });
    if (String(url).includes('/markets/timesales')) return new Response(JSON.stringify({ series: null }), { status: 200 });
    throw new Error('unexpected ' + url);
  };
  const { run, state, elements } = await page({ key: true, fetch });
  run(`openJournalTrade('${KEY}')`);
  await settle();
  assert.equal(state.journalTrade.daily.length, 80);
  assert.equal(elements.get('jtStatusD').textContent, '');
  const at = days.findIndex(d => d.date === '2026-10-01');
  assert.deepEqual(json(run, "journalTradeRange('D')"), { start: at - 40, end: Math.min(80, days.findIndex(d => d.date === '2026-10-02') + 11) });
  assert.equal(elements.get('jtKindD').textContent, 'Daily · AAPL');
});

test('a trade with nothing saved says why', async () => {
  const { run, state, supabase, elements } = await page();
  supabase.bars.clear();
  run(`openJournalTrade('${KEY}')`);
  await settle();
  assert.equal(state.journalTrade.five.length, 0);
  assert.match(elements.get('jtStatus5').textContent, /Add a Tradier key in Settings to load this trade(?:'|’)s 5-minute bars|No 5-minute bars were saved/);
});
