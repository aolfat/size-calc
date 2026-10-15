// Run with: node --test
// Journal calendar and stats: which trades count, the per-group stats, daily P&L on each exit's New York day (trims
// included, open trades too), the month grid, the equity curve and drawdown, streaks, the breakdowns, and the Calendar and Stats tabs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const json = (run, code) => JSON.parse(run(`JSON.stringify(${code})`));
const T = (key, closedAt, pnl, extra = {}) => ({
  key, symbol: 'AAPL', label: 'AAPL', assetType: 'EQUITY', status: pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven', bias: 'long', direction: 'long',
  openedAt: closedAt.replace(/T.*/, 'T13:35:00.000Z'), closedAt, pnl, r: null, exits: 1, holdMs: 3600000, ...extra,
});
// five trades over two weeks of October 2026 (times UTC; New York is 4 hours behind)
const TRADES = [
  T('a', '2026-10-05T15:00:00.000Z', 300, { r: 1.5, exits: 2 }),
  T('b', '2026-10-06T15:00:00.000Z', -100, { r: -0.5, symbol: 'MSFT', label: 'MSFT' }),
  T('c', '2026-10-06T19:00:00.000Z', -250, { r: -2.1, assetType: 'OPTION', symbol: 'AAPL  261218C00245000', label: 'AAPL 12/18/26 245C', openedAt: '2026-10-06T19:45:00.000Z' }),
  T('d', '2026-10-14T01:30:00.000Z', 50, { holdMs: 3 * 86400000, bias: 'short' }), // 9:30 PM on 10/13 in New York
  T('e', '2026-10-15T15:00:00.000Z', 0),
  T('open', '2026-10-15T15:00:00.000Z', 999, { status: 'open', closedAt: null }),
  T('gone', '2026-10-15T15:00:00.000Z', 999, { deleted: true }),
  T('old', '2026-10-15T15:00:00.000Z', 0, { status: 'history' }),
];

test('group stats: net, average and median, win rate, average win and loss, profit factor, big losses in R, thin', async () => {
  const { run } = await app();
  assert.deepEqual(json(run, `countedTrades(${JSON.stringify(TRADES)}).map(t => t.key)`), ['a', 'b', 'c', 'd', 'e'], 'open, deleted and before-history trades never count');
  const s = json(run, `groupStats(countedTrades(${JSON.stringify(TRADES)}))`);
  assert.deepEqual(s, { trades: 5, net: 0, avg: 0, median: 0, wins: 2, losses: 2, winRate: 40, avgWin: 175, avgLoss: -175, profitFactor: 1, expectancy: 0, avgR: -0.37, bigLosses: 1, thin: true });
  assert.equal(json(run, `groupStats(${JSON.stringify([T('x', '2026-10-05T15:00:00.000Z', 10), T('y', '2026-10-05T15:00:00.000Z', 30)])})`).median, 20, 'an even count: the middle two averaged');
  assert.equal(json(run, `groupStats(${JSON.stringify([T('x', '2026-10-05T15:00:00.000Z', 10)])})`).profitFactor, null, 'no losses: no profit factor');
  assert.equal(json(run, `groupStats(${JSON.stringify(Array.from({ length: 10 }, (_, i) => T('t' + i, '2026-10-05T15:00:00.000Z', 1)))})`).thin, false, 'ten trades is enough');
});

test('daily P&L lands on the New York day each trade closed, and the month grid adds up its weeks', async () => {
  const { run } = await app();
  const daily = json(run, `[...dailyPnl(${JSON.stringify(TRADES)})]`);
  assert.deepEqual(daily, [['2026-10-05', { pnl: 300, trades: 1, keys: ['a'] }], ['2026-10-06', { pnl: -350, trades: 2, keys: ['b', 'c'] }], ['2026-10-13', { pnl: 50, trades: 1, keys: ['d'] }], ['2026-10-15', { pnl: 0, trades: 1, keys: ['e'] }]],
    'the 1:30 AM UTC close is the evening of 10/13 in New York; without exits, an open trade adds nothing');
  const cal = json(run, `calendarMonth(dailyPnl(${JSON.stringify(TRADES)}), '2026-10')`);
  assert.equal(cal.weeks[0].days[0], null, 'Mon 9/28 is September');
  assert.deepEqual(cal.weeks[0].days[3], { day: '2026-10-01', pnl: null, trades: 0 });
  assert.deepEqual(cal.weeks[1].days.map(d => d && d.pnl), [300, -350, null, null, null]);
  assert.deepEqual([cal.weeks[1].pnl, cal.weeks[1].trades], [-50, 3]);
  assert.deepEqual([cal.weeks[2].pnl, cal.weeks[2].trades], [50, 2], 'the breakeven counts as a trade');
  assert.equal(cal.weeks.length, 5, 'Sep 28 through Nov 1');
  assert.deepEqual([cal.pnl, cal.trades, cal.green, cal.red], [0, 5, 2, 1]);
  assert.deepEqual(json(run, `activeMonths(dailyPnl(${JSON.stringify(TRADES)}))`), ['2026-10']);
});

const fill = (id, side, time, qty, price, symbol = 'AAPL', assetType = 'EQUITY', orderId = id) => ({
  id, orderId, account: '6789', time, symbol, label: symbol, assetType, instruction: side === 'buy' ? 'BUY' : 'SELL', side, qty, price,
});
// AAPL bought 100, trimmed 50 on Monday (+$150), the rest sold Wednesday (+$200); an XLU call trimmed and still open
const TRIMS = [
  fill('1', 'buy', '2026-10-05T13:35:00.000Z', 100, 100), fill('2', 'sell', '2026-10-05T15:00:00.000Z', 50, 103), fill('3', 'sell', '2026-10-07T15:00:00.000Z', 50, 104),
  fill('4', 'buy', '2026-10-13T14:00:00.000Z', 10, 2, 'XLU   270319C00045000', 'OPTION'), fill('5', 'sell', '2026-10-14T15:00:00.000Z', 5, 3, 'XLU   270319C00045000', 'OPTION'),
];

test('trims: each exit\'s P&L goes on the day it was taken, open trades included, a trade counted once a week', async () => {
  const { run } = await app();
  const trades = json(run, `buildTrades(${JSON.stringify(TRIMS)})`);
  const aapl = trades.find(t => t.symbol === 'AAPL'), xlu = trades.find(t => t.symbol !== 'AAPL');
  assert.deepEqual(aapl.realized, [{ at: '2026-10-05T15:00:00.000Z', qty: 50, pnl: 150 }, { at: '2026-10-07T15:00:00.000Z', qty: 50, pnl: 200 }]);
  assert.equal(aapl.pnl, 350);
  assert.equal(xlu.status, 'open');
  assert.deepEqual(xlu.realized, [{ at: '2026-10-14T15:00:00.000Z', qty: 5, pnl: 500 }], 'an option exit is ×100');
  const daily = json(run, `[...dailyPnl(buildTrades(${JSON.stringify(TRIMS)}))].map(([d, c]) => [d, c.pnl, c.trades])`);
  assert.deepEqual(daily, [['2026-10-05', 150, 1], ['2026-10-07', 200, 1], ['2026-10-14', 500, 1]], 'the trim lands Monday, the open call\'s trim Wednesday');
  const cal = json(run, `calendarMonth(dailyPnl(buildTrades(${JSON.stringify(TRIMS)})), '2026-10')`);
  assert.deepEqual([cal.weeks[1].pnl, cal.weeks[1].trades], [350, 1], 'one trade over two days counts once in the week');
  assert.deepEqual([cal.pnl, cal.trades, cal.green], [850, 2, 3]);
  assert.deepEqual(json(run, `[...exitDays(buildTrades(${JSON.stringify(TRIMS)})[0])]`), ['2026-10-05', '2026-10-07']);
  assert.deepEqual(json(run, `[...dailyPnl(buildTrades(${JSON.stringify(TRIMS)}).map(t => ({ ...t, deleted: true })))]`), [], 'deleted trades add nothing');
});

test('trims after fees: each exit carries the fees for the part of the entry it closed; spreads and merges keep their legs\' exits', async () => {
  const { run } = await app();
  const net = json(run, `withFees(buildTrades(${JSON.stringify(TRIMS.slice(0, 3))})[0], new Map([['1', 1], ['2', 0.5], ['3', 0.5]]), new Map([['1', 100], ['2', 50], ['3', 50]]), true)`);
  assert.equal(net.pnl, 348);
  assert.deepEqual(net.realized.map(e => e.pnl), [149, 199], 'half the entry closed each time: half of $2 each');
  const C245 = 'AAPL  261218C00245000', C255 = 'AAPL  261218C00255000';
  const legs = [
    { ...fill('a', 'buy', '2026-10-05T14:00:00.000Z', 1, 5, C245, 'OPTION', 'o1'), instruction: 'BUY_TO_OPEN' }, { ...fill('b', 'sell', '2026-10-05T14:00:00.000Z', 1, 2, C255, 'OPTION', 'o1'), instruction: 'SELL_TO_OPEN' },
    { ...fill('c', 'sell', '2026-10-06T15:00:00.000Z', 1, 7, C245, 'OPTION'), instruction: 'SELL_TO_CLOSE' }, { ...fill('d', 'buy', '2026-10-07T15:00:00.000Z', 1, 3, C255, 'OPTION'), instruction: 'BUY_TO_CLOSE' },
  ];
  const spread = json(run, `spreadTrade('s', 'auto', buildTrades(${JSON.stringify(legs)}))`);
  assert.deepEqual(spread.realized.map(e => [e.at.slice(0, 10), e.pnl]), [['2026-10-06', 200], ['2026-10-07', -100]], 'each leg\'s close on its own day');
  const merged = json(run, `shapeTrades(buildTrades(${JSON.stringify([...TRIMS.slice(0, 3), fill('6', 'buy', '2026-10-08T14:00:00.000Z', 10, 100), fill('7', 'sell', '2026-10-09T14:00:00.000Z', 10, 99)])}), [{ id: 'm', account: '6789', fill_ids: ['1', '6'] }])`);
  assert.deepEqual(merged[0].realized.map(e => e.pnl), [150, 200, -10], 'a merged trade keeps every part\'s exits, in order');
});

test('equity curve with its drawdown, streaks, and months', async () => {
  const { run } = await app();
  const eq = json(run, `equityCurve(${JSON.stringify(TRADES)})`);
  assert.deepEqual(eq.points.map(p => [p.total, p.peak, p.drawdown]), [[300, 300, 0], [200, 300, -100], [-50, 300, -350], [0, 300, -300], [0, 300, -300]]);
  assert.equal(eq.maxDrawdown, -350);
  assert.equal(eq.maxDrawdownAt, '2026-10-06T19:00:00.000Z');
  assert.deepEqual(json(run, `streaks(${JSON.stringify(TRADES)})`), { longestWin: 1, longestLoss: 2, current: null }, 'a breakeven ends the run');
  assert.deepEqual(json(run, `monthlyResults(${JSON.stringify(TRADES)})`).map(m => [m.month, m.trades, m.net]), [['2026-10', 5, 0]]);
});

test('breakdowns: by underlying, side, instrument, time of day, weekday, hold, exits, and the R distribution', async () => {
  const { run } = await app();
  const b = json(run, `breakdowns(${JSON.stringify(TRADES)})`);
  assert.deepEqual(b.bySymbol.map(r => [r.group, r.stats.trades, r.stats.net]), [['AAPL', 4, 100], ['MSFT', 1, -100]], 'the AAPL call counts under AAPL');
  assert.deepEqual(b.concentration, { group: 'AAPL', share: 100 }, 'AAPL made all the gross gains');
  assert.deepEqual(b.bySide.map(r => [r.group, r.stats.trades]), [['Long', 4], ['Short', 1]]);
  assert.deepEqual(b.byInstrument.map(r => [r.group, r.stats.trades]), [['Stocks', 4], ['Options', 1]]);
  assert.deepEqual(b.byTimeOfDay.map(r => [r.group, r.stats.trades]), [['9:30–9:45', 4], ['3:30–4:00', 1]], '13:35 UTC is 9:35 AM; the call opened 3:45 PM');
  assert.deepEqual(b.byWeekday.map(r => r.group), ['Mon', 'Tue', 'Wed', 'Thu']);
  assert.deepEqual(b.byHold.map(r => [r.group, r.stats.trades]), [['1–4h', 4], ['1–5 days', 1]]);
  assert.equal(b.holdWinners, (3600000 + 3 * 86400000) / 2);
  assert.deepEqual(b.byExits.map(r => [r.group, r.stats.trades]), [['Scaled out', 1], ['All at once', 4]]);
  assert.equal(b.withR, 3);
  assert.deepEqual(b.rDistribution.filter(r => r.count).map(r => [r.group, r.count]), [['Under −2R', 1], ['−0.5 to 0R', 1], ['1 to 2R', 1]]);
  assert.equal(run("timeBucket('16:10')"), 'Extended hours');
  assert.equal(run("holdBucket(10 * 60000)"), 'Under 15m');
});

// ---------- the tabs ----------

const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const order = (id, instruction, time, qty, price, symbol = 'AAPL') => ({ kind: 'order', record_id: String(id), account: '6789', entered_at: time.replace('+0000', 'Z'), data: {
  orderId: id, enteredTime: time, status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction, quantity: qty, instrument: { symbol, assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: id * 10, executionLegs: [{ legId: 1, quantity: qty, price, time }] }],
} });
const RECORDS = [
  order(1, 'BUY', '2026-10-05T13:35:00+0000', 100, 100), order(2, 'SELL', '2026-10-05T15:00:00+0000', 100, 103),
  order(3, 'BUY', '2026-10-06T13:40:00+0000', 50, 200, 'MSFT'), order(4, 'SELL', '2026-10-06T15:00:00+0000', 50, 198, 'MSFT'),
];

async function journal(records = RECORDS) {
  const a = await app({ supabase: fakeRecords(records), session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  return { ...a, out: () => a.elements.get('journalSection').innerHTML };
}

test('the Calendar tab: the month of the latest close, a day tapped shows its trades, ‹ › step months', async () => {
  const { run, state, out } = await journal();
  assert.match(out(), /data-action="setJournalTab" data-arg="calendar">Calendar<\/button><button[^>]*data-action="setJournalTab" data-arg="stats">Stats</);
  run("setJournalTab('calendar')");
  assert.match(out(), /class="jc-title">October 2026</);
  assert.match(out(), /<span class="journal-buy">\+\$200\.00<\/span> · 2 trades · 1 green day, 1 red/);
  assert.match(out(), /<button class="jc-day journal-buy" data-action="pickJournalDay" data-arg="2026-10-05"[^>]*><span class="jc-num">5<\/span><span class="jc-pnl">\+\$300<\/span><span class="jc-n">1 trade<\/span>/);
  assert.match(out(), /data-arg="2026-10-06"[^>]*><span class="jc-num">6<\/span><span class="jc-pnl">−\$100<\/span>/);
  run("pickJournalDay('2026-10-06')");
  assert.equal(state.journalTab, 'trades');
  assert.match(out(), /data-action="clearJournalDay"[^>]*>Exits 10\/6 ×</);
  assert.match(out(), /<b>MSFT<\/b>/);
  assert.doesNotMatch(out(), /<b>AAPL<\/b>/, 'only that day\'s trades');
  run('clearJournalDay()');
  assert.match(out(), /<b>AAPL<\/b>/);
  run("setJournalTab('calendar'); shiftJournalMonth('-1')");
  assert.match(out(), /September 2026<\/span>[\s\S]*No exits this month/);
  run("shiftJournalMonth('1')");
  assert.match(out(), /October 2026/);
  // This month: back to today's month in New York, whatever month is shown
  const now = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', year: 'numeric' }).format(new Date());
  run("shiftJournalMonth('-5')");
  assert.match(out(), /data-action="journalThisMonth">This month</);
  run('journalThisMonth()');
  assert.match(out(), new RegExp(`class="jc-title">${now}<`));
  assert.match(out(), /data-action="journalThisMonth" disabled>This month</, 'already there: nothing to do');
});

test('the Calendar tab: a trim shows on its day, and that day lists the trade even while it is open', async () => {
  const { run, out } = await journal([
    order(1, 'BUY', '2026-10-05T13:35:00+0000', 100, 100), order(2, 'SELL', '2026-10-05T15:00:00+0000', 50, 103), order(3, 'SELL', '2026-10-07T15:00:00+0000', 20, 104),
  ]);
  run("setJournalTab('calendar')");
  assert.match(out(), /data-arg="2026-10-05"[^>]*><span class="jc-num">5<\/span><span class="jc-pnl">\+\$150<\/span>/);
  assert.match(out(), /data-arg="2026-10-07"[^>]*><span class="jc-num">7<\/span><span class="jc-pnl">\+\$80<\/span>/);
  assert.match(out(), /<span class="journal-buy">\+\$230\.00<\/span> · 1 trade · 2 green days/);
  run("pickJournalDay('2026-10-05')");
  assert.match(out(), /<b>AAPL<\/b>/, 'the open trade trimmed that day');
});

test('the Stats tab: headline numbers, the equity canvas, tables by group, thin groups marked, filters apply', async () => {
  const { run, out } = await journal();
  run("setJournalTab('stats')");
  assert.match(out(), /<dt>Net P&amp;L<\/dt><dd class="journal-buy">\+\$200\.00<span class="pos-sub">2 closed trades<\/span>/);
  assert.match(out(), /<dt>Win rate<\/dt><dd class="">50%<span class="pos-sub">1 won, 1 lost<\/span>/);
  assert.match(out(), /<dt>Profit factor<\/dt><dd class="">3\.00</);
  assert.match(out(), /<dt>Max drawdown<\/dt><dd class="journal-sell">−\$100\.00</);
  assert.match(out(), /id="journalEquity"/);
  assert.match(out(), /By symbol[\s\S]*<b>AAPL<\/b> <span class="journal-tag journal-tag-quiet"[^>]*>thin<\/span>/);
  assert.match(out(), /By time of day[\s\S]*9:30–9:45/);
  assert.match(out(), /R distribution<\/div><p class="hint">No closed trades with an initial stop yet/);
  run("document.getElementById('journalSymbol').value = 'MSFT'; journalSymbolChanged()");
  assert.match(out(), /<dt>Net P&amp;L<\/dt><dd class="journal-sell">−\$100\.00/, 'the symbol filter narrows the stats');
});
