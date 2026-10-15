// Run with: node --test
// Journal calendar and stats: which trades count, the per-group stats, daily P&L on the close's New York day, the month
// grid, the equity curve and drawdown, streaks, the breakdowns, and the Calendar and Stats tabs.
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
  const D = (pnl, trades, wins, losses, winRate, profitFactor) => ({ pnl, trades, wins, losses, winRate, profitFactor });
  assert.deepEqual(daily, [['2026-10-05', D(300, 1, 1, 0, 100, null)], ['2026-10-06', D(-350, 2, 0, 2, 0, 0)], ['2026-10-13', D(50, 1, 1, 0, 100, null)], ['2026-10-15', D(0, 1, 0, 0, 0, null)]],
    'the 1:30 AM UTC close is the evening of 10/13 in New York; a day without a loss has no profit factor');
  const cal = json(run, `calendarMonth(dailyPnl(${JSON.stringify(TRADES)}), '2026-10')`);
  assert.equal(cal.weeks[0].days[0], null, 'Mon 9/28 is September');
  assert.deepEqual(cal.weeks[0].days[3], { day: '2026-10-01', pnl: null, trades: 0, winRate: null, profitFactor: null });
  assert.equal(cal.weeks[0].start, '2026-09-28', 'a week is named by its Monday, even in the month before');
  assert.deepEqual(cal.weeks[1].days.map(d => d && d.pnl), [300, -350, null, null, null]);
  assert.deepEqual(cal.weeks[1].days[1], { day: '2026-10-06', pnl: -350, trades: 2, winRate: 0, profitFactor: 0 });
  assert.deepEqual([cal.weeks[1].pnl, cal.weeks[1].trades, cal.weeks[1].wins, cal.weeks[1].winRate], [-50, 3, 1, 33.3]);
  assert.deepEqual([cal.weeks[2].pnl, cal.weeks[2].trades, cal.weeks[2].winRate], [50, 2, 50], 'the breakeven counts as a trade');
  assert.equal(cal.weeks.length, 5, 'Sep 28 through Nov 1');
  assert.deepEqual([cal.pnl, cal.trades, cal.days, cal.green, cal.red], [0, 5, 4, 2, 1]);
  assert.deepEqual(json(run, `activeMonths(dailyPnl(${JSON.stringify(TRADES)}))`), ['2026-10']);
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

test('periods: a day, its week (named by the Monday, weekends folded in), its month; the ones with trades; stepping and switching', async () => {
  const { run } = await app();
  assert.equal(run("periodKey('2026-10-08', 'week')"), '2026-10-05');
  assert.equal(run("periodKey('2026-10-11', 'week')"), '2026-10-05', 'Sunday belongs to the week before');
  assert.equal(run("periodKey('2026-10-12', 'week')"), '2026-10-12');
  assert.equal(run("periodKey('2026-11-01', 'week')"), '2026-10-26', 'across a month end');
  assert.equal(run("periodKey('2026-10-08', 'month')"), '2026-10');
  assert.equal(run("periodKey('2026-10-08', 'day')"), '2026-10-08');
  const J = JSON.stringify(TRADES);
  assert.deepEqual(json(run, `activePeriods(${J}, 'day')`), ['2026-10-15', '2026-10-13', '2026-10-06', '2026-10-05']);
  assert.deepEqual(json(run, `activePeriods(${J}, 'week')`), ['2026-10-12', '2026-10-05']);
  assert.deepEqual(json(run, `inPeriod(${J}, 'week', '2026-10-12').map(t => t.key)`), ['d', 'e'], 'the 10/13 evening close and the 10/15 one');
  assert.deepEqual(json(run, `inPeriod(${J}, 'day', '2026-10-06').map(t => t.key)`), ['b', 'c']);
  assert.equal(json(run, `inPeriod(${J}, 'all', '').length`), 5, 'all time: every counted trade');
  const days = `activePeriods(${J}, 'day')`;
  assert.equal(run(`stepPeriod(${days}, '2026-10-13', -1)`), '2026-10-06', 'back skips the days without closes');
  assert.equal(run(`stepPeriod(${days}, '2026-10-13', 1)`), '2026-10-15');
  assert.equal(run(`stepPeriod(${days}, '2026-10-15', 1)`), null, 'nothing newer');
  assert.equal(run(`stepPeriod(${days}, '2026-10-09', 1)`), '2026-10-13', 'from a day without trades');
  assert.equal(run(`switchPeriod(${J}, 'all', '', 'day')`), '2026-10-15', 'from all time: the newest close');
  assert.equal(run(`switchPeriod(${J}, 'week', '2026-10-05', 'day')`), '2026-10-06', 'a week to its newest day with a close');
  assert.equal(run(`switchPeriod(${J}, 'day', '2026-10-06', 'month')`), '2026-10');
  assert.equal(run(`switchPeriod(${J}, 'month', '2026-09', 'week')`), '2026-08-31', 'an empty month: its first day picks the week');
  assert.deepEqual(json(run, `periodResults(${J}, 'day')`).map(r => [r.key, r.trades, r.net]), [['2026-10-15', 1, 0], ['2026-10-13', 1, 50], ['2026-10-06', 2, -350], ['2026-10-05', 1, 300]]);
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

async function journal() {
  const a = await app({ supabase: fakeRecords(RECORDS), session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  return { ...a, out: () => a.elements.get('journalSection').innerHTML };
}

test('the Calendar tab: the month of the latest close, a day tapped shows its trades, ‹ › step months', async () => {
  const { run, state, out } = await journal();
  assert.match(out(), /data-action="setJournalTab" data-arg="calendar">Calendar<\/button><button[^>]*data-action="setJournalTab" data-arg="stats">Stats</);
  run("setJournalTab('calendar')");
  assert.match(out(), /class="jc-title">October 2026</);
  assert.match(out(), /<dl class="js-stats jc-stats">\s*<div><dt>Net P&amp;L<\/dt><dd class="journal-buy">\+\$200\.00<span class="pos-sub">2 trades<\/span>/, 'the month\'s own numbers');
  assert.match(out(), /<dt>Win rate<\/dt><dd class="">50%<span class="pos-sub">1 won, 1 lost</);
  assert.match(out(), /<dt>Profit factor<\/dt><dd class="">3\.00</);
  assert.match(out(), /<dt>Green days<\/dt><dd class="">1 of 2<span class="pos-sub">1 red</);
  assert.match(out(), /<button class="jc-day journal-buy" data-action="pickJournalDay" data-arg="2026-10-05"[^>]*><span class="jc-num">5<\/span><span class="jc-pnl">\+\$300<\/span><span class="jc-n">1 trade<\/span><span class="jc-rate">100%<span class="jc-wide"> won<\/span>/, 'no losses: no profit factor');
  assert.match(out(), /data-arg="2026-10-06"[^>]*><span class="jc-num">6<\/span><span class="jc-pnl">−\$100<\/span><span class="jc-n">1 trade<\/span><span class="jc-rate">0%<span class="jc-wide"> won · PF 0\.00</);
  assert.match(out(), /data-action="openJournalStats" data-arg="week" data-arg2="2026-10-05"[^>]*><span class="journal-buy">\+\$200<\/span><span class="jc-n">2 trades · 50%</);
  run("pickJournalDay('2026-10-06')");
  assert.equal(state.journalTab, 'trades');
  assert.match(out(), /data-action="clearJournalDay"[^>]*>Closed 10\/6 ×<\/button><button class="pos-link" data-action="openJournalStats" data-arg="day" data-arg2="2026-10-06">The day's stats</);
  assert.match(out(), /<b>MSFT<\/b>/);
  assert.doesNotMatch(out(), /<b>AAPL<\/b>/, 'only that day\'s trades');
  run('clearJournalDay()');
  assert.match(out(), /<b>AAPL<\/b>/);
  run("setJournalTab('calendar'); shiftJournalMonth('-1')");
  assert.match(out(), /September 2026<\/span>[\s\S]*No closed trades this month/);
  run("shiftJournalMonth('1')");
  assert.match(out(), /October 2026/);
  run("openJournalStats('month', '2026-10')");
  assert.equal(state.journalTab, 'stats');
  assert.match(out(), /aria-pressed="true" data-action="setJournalPeriod" data-arg="month">Month</);
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

test('the Stats tab narrowed to a day, a week or a month: ‹ › step through the ones with trades, the place kept switching', async () => {
  const { run, state, out } = await journal();
  run("setJournalTab('stats')");
  assert.match(out(), /aria-pressed="true" data-action="setJournalPeriod" data-arg="all">All time</);
  assert.match(out(), /By month/);
  run("setJournalPeriod('day')");
  assert.match(out(), /class="jc-title">Tue, Oct 6, 2026</, 'the newest day with a close');
  assert.match(out(), /<dt>Net P&amp;L<\/dt><dd class="journal-sell">−\$100\.00<span class="pos-sub">1 closed trade</);
  assert.match(out(), /aria-label="Later day with trades" disabled>/, 'nothing newer');
  assert.match(out(), /data-action="pickJournalDay" data-arg="2026-10-06">The day's trades</);
  assert.doesNotMatch(out(), /By month|By day|By weekday/);
  run("stepJournalPeriod('-1')");
  assert.match(out(), /Mon, Oct 5, 2026[\s\S]*<dd class="journal-buy">\+\$300\.00/);
  assert.match(out(), /aria-label="Earlier day with trades" disabled>/);
  run("setJournalPeriod('week')");
  assert.match(out(), /class="jc-title">Oct 5–9, 2026</, 'the week of the day shown');
  assert.match(out(), /<dd class="journal-buy">\+\$200\.00<span class="pos-sub">2 closed trades/);
  assert.match(out(), /By day[\s\S]*<b>Tue 10\/6<\/b>[\s\S]*<b>Mon 10\/5<\/b>/, 'a week shows each day, newest first');
  run("setJournalPeriod('month')");
  assert.match(out(), /class="jc-title">October 2026</);
  run("document.getElementById('journalSymbol').value = 'MSFT'; journalSymbolChanged(); setJournalPeriod('day'); stepJournalPeriod('-1')");
  assert.equal(state.journalPeriodShown, '2026-10-06', 'only MSFT\'s day');
  run("state.journalPeriodKey = '2026-10-05'; renderJournal()");
  assert.match(out(), /No closed trades this day/, 'a period the filter empties says so');
  run("setJournalPeriod('all')");
  assert.equal(state.journalPeriodKey, '');
  assert.match(out(), /By month/);
});
