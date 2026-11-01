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
  const D = (pnl, keys, byTrade, wins, losses, winRate, profitFactor) => ({ pnl, keys, byTrade, trades: keys.length, wins, losses, winRate, profitFactor });
  assert.deepEqual(daily, [['2026-10-05', D(300, ['a'], { a: 300 }, 1, 0, 100, null)], ['2026-10-06', D(-350, ['b', 'c'], { b: -100, c: -250 }, 0, 2, 0, 0)], ['2026-10-13', D(50, ['d'], { d: 50 }, 1, 0, 100, null)], ['2026-10-15', D(0, ['e'], { e: 0 }, 0, 0, 0, null)]],
    'the 1:30 AM UTC close is the evening of 10/13 in New York; without exits, an open trade adds nothing; a day without a loss has no profit factor');
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
  assert.deepEqual([cal.wins, cal.losses, cal.winRate, cal.profitFactor], [2, 2, 40, 1], 'the month: 350 won over 350 lost');
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

test('realized win rate and profit factor: each trade\'s exits in the day, week or month added up', async () => {
  const { run } = await app();
  const X = T('x', '2026-10-07T15:00:00.000Z', 20, { realized: [{ at: '2026-10-05T14:00:00.000Z', qty: 50, pnl: 100 }, { at: '2026-10-05T15:00:00.000Z', qty: 20, pnl: -30 }, { at: '2026-10-07T15:00:00.000Z', qty: 30, pnl: -50 }] });
  const Y = T('y', '2026-10-05T16:00:00.000Z', -40);
  const daily = `dailyPnl(${JSON.stringify([X, Y])})`;
  const d5 = json(run, `${daily}.get('2026-10-05')`);
  assert.deepEqual([d5.pnl, d5.trades, d5.wins, d5.losses, d5.winRate, d5.profitFactor], [30, 2, 1, 1, 50, 1.75], 'x took +70 net that day, y lost 40');
  const d7 = json(run, `${daily}.get('2026-10-07')`);
  assert.deepEqual([d7.trades, d7.winRate, d7.profitFactor], [1, 0, 0], 'x\'s last exit lost');
  const cal = json(run, `calendarMonth(${daily}, '2026-10')`);
  assert.deepEqual([cal.weeks[1].trades, cal.weeks[1].wins, cal.weeks[1].winRate, cal.weeks[1].profitFactor], [2, 1, 50, 0.5], 'the week: x +20 over its three exits, y −40');
  assert.deepEqual([cal.trades, cal.pnl, cal.winRate, cal.profitFactor], [2, -20, 50, 0.5]);
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

test('a period counts the exits taken in it: a trim while the rest is open, or before it closes in a later week', async () => {
  const { run } = await app();
  const trades = `buildTrades(${JSON.stringify(TRIMS)})`;
  // AAPL: +150 trimmed Mon 10/5, +200 closed Wed 10/7; XLU call: +500 trimmed Wed 10/14, still open
  assert.deepEqual(json(run, `activePeriods(${trades}, 'week')`), ['2026-10-12', '2026-10-05'], 'the week with only a trim has exits');
  const wk = json(run, `inPeriod(${trades}, 'week', '2026-10-12')`);
  assert.deepEqual(wk.map(t => [t.symbol, t.pnl, t.status, t.closedAt, t.partial]), [['XLU   270319C00045000', 500, 'win', '2026-10-14T15:00:00.000Z', true]]);
  assert.equal(json(run, `inPeriod(${trades}, 'week', '2026-10-05')`)[0].partial, undefined, 'every exit inside: the trade itself');
  const mon = json(run, `inPeriod(${trades}, 'day', '2026-10-05')`);
  assert.deepEqual(mon.map(t => [t.pnl, t.exits, t.partial]), [[150, 1, true]], 'Monday: only the trim');
  assert.deepEqual(json(run, `periodResults(${trades}, 'day')`).map(r => [r.key, r.trades, r.net]), [['2026-10-14', 1, 500], ['2026-10-07', 1, 200], ['2026-10-05', 1, 150]]);
  assert.deepEqual(json(run, `periodResults(inPeriod(${trades}, 'week', '2026-10-05'), 'day')`).map(r => [r.key, r.net]), [['2026-10-07', 200], ['2026-10-05', 150]], 'a week cut again by day');
  assert.equal(json(run, `inPeriod(${trades}, 'all', '').length`), 1, 'all time: closed trades only');
  assert.equal(run(`switchPeriod(${trades}, 'all', '', 'week')`), '2026-10-12', 'the newest exit, even on an open trade');
  const risky = json(run, `sliceTrade({ ...${trades}[0], risk: 300 }, 'day', '2026-10-05')`);
  assert.equal(risky.r, 0.5, 'R on the exits taken then, over the trade\'s risk');
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

test('phones: a card per trade, Open then Closed by day with what they took; wider screens keep the table', async () => {
  const records = [...RECORDS, order(5, 'BUY', '2026-10-07T13:40:00+0000', 10, 50, 'PLTR')];
  const a = await app({ width: 390, supabase: fakeRecords(records), session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  const out = () => a.elements.get('journalSection').innerHTML;
  assert.doesNotMatch(out(), /journal-table/, 'no table on a phone');
  assert.match(out(), /<article class="jun" id="jUpNext" data-key="[^"]*PLTR[^"]*"/, 'the newest waiting is Up next');
  assert.match(out(), /<h3>Open <span>1<\/span>/, 'and still in the list under it');
  assert.match(out(), /<h3>Closed <span>2<\/span><\/h3><span class="jtc-total">Realized <b class="journal-buy">\+\$200\.00<\/b>/);
  assert.match(out(), /<div class="jtc-day"><span><button class="jd-date" data-action="reviewJournalDay" data-arg="2026-10-06"[^>]*>Tue · Oct 6<\/button> · <span class="jtc-day-todo">1 to review<\/span><\/span><span class="jtc-day-end"><button class="pos-link jd-review" data-action="reviewJournalDay" data-arg="2026-10-06"[^>]*>Review the day ›<\/button><b class="journal-sell">−\$100\.00<\/b><\/span><\/div><article class="jtc jtc-todo"[^]*?<b>MSFT<\/b>/, 'a day: its date and Review the day open its notebook, how many wait, its P&L');
  assert.match(out(), /<b>MSFT<\/b>[^]*?<span class="jtc-pill jtc-long">Long<\/span>[^]*?50 shr<\/span> · <span class="jtc-nowrap">Oct 6<\/span>[^]*?<dt>P&amp;L<\/dt><dd class="journal-sell">−\$100\.00/, 'same day: one date');
  assert.ok(out().indexOf('>Tue · Oct 6<') < out().indexOf('>Mon · Oct 5<'), 'newest day first');
  a.run("setJournalReviewFilter('open')");
  assert.doesNotMatch(out(), /jUpNext|class="jrp"/, 'no deck or progress outside All and To review');
  assert.match(out(), /<h3>Open <span>1<\/span><\/h3><\/div><article class="jtc jtc-is-open" data-action="openTradeRow"[^]*?<b>PLTR<\/b>[^]*?<span class="jtc-nowrap">10 shr<\/span>/);
  assert.match(out(), /<dd class="jtc-none">—<span class="jtc-pct-note">no exits yet<\/span>/, 'no exits: a quiet dash');
  assert.match(out(), /<div><dt>Avg exit<\/dt><dd>—<\/dd><\/div>/);
  assert.match(out(), /<span class="jtc-live">Live<\/span><button class="jtc-link jtc-link-todo" data-action="openTradeRow" data-arg="[^"]+" aria-label="Review PLTR">Opening pass ›<\/button>/, 'Live, and the opening pass still to do');
  assert.doesNotMatch(out(), />Open<\/span>/, 'no Open pill: the heading says it');
  const wide = await journal(records);
  assert.match(wide.out(), /journal-table/, 'the table stays on wider screens');
});

test('the Calendar tab: the month of the latest close, a day tapped opens its page, ‹ › step months', async () => {
  const { run, state, out } = await journal();
  assert.match(out(), /data-action="setJournalTab" data-arg="calendar">Calendar<\/button><button[^>]*data-action="setJournalTab" data-arg="missed">Missed<\/button><button[^>]*data-action="setJournalTab" data-arg="stats">Stats</);
  run("setJournalTab('calendar')");
  assert.match(out(), /class="jc-title">October 2026</);
  assert.match(out(), /<dl class="js-stats jc-stats">\s*<div><dt>Net P&amp;L<\/dt><dd class="journal-buy">\+\$200\.00<span class="pos-sub">2 trades<\/span>/, 'the month\'s own numbers');
  assert.match(out(), /<dt>Win rate<\/dt><dd class="">50%<span class="pos-sub">1 won, 1 lost</);
  assert.match(out(), /<dt>Profit factor<\/dt><dd class="">3\.00</);
  assert.match(out(), /<dt>Green days<\/dt><dd class="">1 of 2<span class="pos-sub">1 red</);
  assert.match(out(), /<button class="jc-day journal-buy" data-action="openJournalDay" data-arg="2026-10-05"[^>]*><span class="jc-num">5<\/span><span class="jc-pnl">\+\$300<\/span><span class="jc-n">1 trade<\/span><span class="jc-rate">100%<span class="jc-wide"> won<\/span>/, 'no losses: no profit factor');
  assert.match(out(), /data-arg="2026-10-06"[^>]*><span class="jc-num">6<\/span><span class="jc-pnl">−\$100<\/span><span class="jc-n">1 trade<\/span><span class="jc-rate">0%<span class="jc-wide"> won · PF 0\.00</);
  assert.match(out(), /data-action="openPeriodReview" data-arg="week" data-arg2="2026-10-05"[^>]*><span class="journal-buy">\+\$200<\/span><span class="jc-n">2 trades · 50%</);
  run("pickJournalDay('2026-10-06')");
  assert.equal(state.journalTab, 'trades');
  assert.match(out(), /data-action="clearJournalDay"[^>]*>Exits 10\/6 ×<\/button><button class="pos-link" data-action="openJournalStats" data-arg="day" data-arg2="2026-10-06">The day's stats</);
  assert.match(out(), /<b>MSFT<\/b>/);
  assert.doesNotMatch(out(), /<b>AAPL<\/b>/, 'only that day\'s trades');
  run('clearJournalDay()');
  assert.match(out(), /<b>AAPL<\/b>/);
  run("setJournalTab('calendar'); shiftJournalMonth('-1')");
  assert.match(out(), /September 2026<\/span>[\s\S]*No exits this month/);
  run("shiftJournalMonth('1')");
  assert.match(out(), /October 2026/);
  run("openJournalStats('month', '2026-10')");
  assert.equal(state.journalTab, 'stats');
  assert.match(out(), /aria-pressed="true" data-action="setJournalPeriod" data-arg="month">Month</);
  run("setJournalTab('calendar')");
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
  assert.match(out(), /<dt>Net P&amp;L<\/dt><dd class="journal-buy">\+\$230\.00<span class="pos-sub">1 trade<\/span>/, 'trimmed on two days, counted once in the month');
  assert.match(out(), /<dt>Win rate<\/dt><dd class="">100%<span class="pos-sub">1 won, 0 lost</);
  assert.match(out(), /<dt>Green days<\/dt><dd class="">2 of 2</);
  run("pickJournalDay('2026-10-05')");
  assert.match(out(), /<b>AAPL<\/b>/, 'the open trade trimmed that day');
});

test('a week\'s stats count it even when its only exits were trims', async () => {
  const { run, out } = await journal([
    order(1, 'BUY', '2026-10-05T13:35:00+0000', 100, 100), order(2, 'SELL', '2026-10-05T15:00:00+0000', 50, 103), order(3, 'SELL', '2026-10-13T15:00:00+0000', 20, 104),
  ]);
  run("openJournalStats('week', '2026-10-12')");
  assert.match(out(), /class="jc-title">Oct 12–16, 2026</);
  assert.match(out(), /<dt>Net P&amp;L<\/dt><dd class="journal-buy">\+\$80\.00<span class="pos-sub">1 trade · 1 partly closed<\/span>/);
  assert.match(out(), /<dt>Win rate<\/dt><dd class="">100%/);
  assert.doesNotMatch(out(), /No exits this week/);
  run("setJournalPeriod('all')");
  assert.match(out(), /No closed trades yet\. A trim on an open trade counts in its day, week and month/, 'all time still counts closed trades');
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
  run("setTimeZone('pt')");
  assert.match(out(), /By time of day<\/div><p class="hint">When the trade opened \(PT\)\.<\/p>[\s\S]*6:30–6:45/, 'in PT: the same groups, on the Pacific clock');
  run("setTimeZone('et')");
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
  assert.match(out(), /No exits this day/, 'a period the filter empties says so');
  run("setJournalPeriod('all')");
  assert.equal(state.journalPeriodKey, '');
  assert.match(out(), /By month/);
});

test('dates: any span counts the exits between its two days, ends included; it starts as the span shown', async () => {
  const { run } = await app();
  const J = JSON.stringify(TRADES);
  assert.equal(run("rangeKey('2026-10-13', '2026-10-05')"), '2026-10-05..2026-10-13', 'the earlier day first');
  assert.equal(run("isRangeKey('2026-10-05..2026-10-13')"), true);
  assert.equal(run("isRangeKey('2026-10')"), false);
  assert.deepEqual(json(run, "periodSpan('month', '2026-02')"), ['2026-02-01', '2026-02-28']);
  assert.deepEqual(json(run, "periodSpan('week', '2026-10-26')"), ['2026-10-26', '2026-11-01'], 'Monday to Sunday, the weekend folded in');
  assert.deepEqual(json(run, `inPeriod(${J}, 'range', '2026-10-06..2026-10-13').map(t => t.key)`), ['b', 'c', 'd'], 'both ends count, the 10/13 evening close too');
  assert.deepEqual(json(run, `inPeriod(${J}, 'range', '2026-10-07..2026-10-12')`), []);
  assert.equal(run(`switchPeriod(${J}, 'all', '', 'range')`), '2026-10-05..2026-10-15', 'from all time: the first exit to the last');
  assert.equal(run(`switchPeriod(${J}, 'week', '2026-10-05', 'range')`), '2026-10-05..2026-10-11');
  assert.equal(run(`switchPeriod(${J}, 'month', '2026-10', 'range')`), '2026-10-01..2026-10-31');
  assert.equal(run(`switchPeriod(${J}, 'range', '2026-10-01..2026-10-07', 'day')`), '2026-10-06', 'back to a day: the newest exit in the dates');
  assert.equal(run(`switchPeriod(${J}, 'range', '2026-09-01..2026-09-07', 'week')`), '2026-08-31', 'dates without exits: their first day');
  const trimmed = JSON.stringify([T('t', '2026-10-14T15:00:00.000Z', 700, { risk: 100, exits: 2, realized: [{ at: '2026-10-05T15:00:00.000Z', qty: 50, pnl: 200 }, { at: '2026-10-14T15:00:00.000Z', qty: 50, pnl: 500 }] })]);
  const cut = json(run, `inPeriod(${trimmed}, 'range', '2026-10-01..2026-10-10')`);
  assert.deepEqual([cut[0].pnl, cut[0].r, cut[0].partial], [200, 2, true], 'a trade closed after the dates counts the exits inside them');
});

test('the Stats tab over picked dates: From and To boxes, the stats between them, by day or by month', async () => {
  const { run, state, out } = await journal();
  run("setJournalTab('stats'); setJournalPeriod('month'); setJournalPeriod('range')");
  assert.match(out(), /aria-pressed="true" data-action="setJournalPeriod" data-arg="range">Dates</);
  assert.match(out(), /id="journalRangeFrom" value="2026-10-01" data-change="setStatsDates" data-arg="from"/, 'starts as the month shown');
  assert.match(out(), /id="journalRangeTo" value="2026-10-31" data-change="setStatsDates" data-arg="to"/);
  assert.doesNotMatch(out(), /stepJournalPeriod/, 'no ‹ ›: the dates say where');
  assert.match(out(), /<dd class="journal-buy">\+\$200\.00<span class="pos-sub">2 closed trades/);
  assert.match(out(), /By day[\s\S]*<b>Tue 10\/6<\/b>/, 'within a month: by day');
  run("setStatsDates('from', '2026-10-06')");
  assert.equal(state.journalPeriodKey, '2026-10-06..2026-10-31');
  assert.match(out(), /<dd class="journal-sell">−\$100\.00<span class="pos-sub">1 closed trade/);
  run("setStatsDates('to', '2026-10-06')");
  assert.doesNotMatch(out(), /By day|By weekday/, 'one day: no by-day or weekday tables');
  run("setStatsDates('from', '2026-10-07')");
  assert.equal(state.journalPeriodKey, '2026-10-06..2026-10-07', 'a From after To swaps them');
  run("setStatsDates('to', '')");
  assert.equal(state.journalPeriodKey, '2026-10-06..2026-10-07', 'a cleared box keeps the dates');
  run("setStatsDates('from', '2026-09-01')");
  assert.match(out(), /By month<\/div>/, 'over more than one month: by month');
  run("setStatsDates('from', '2026-10-07'); setStatsDates('to', '2026-10-31')");
  assert.match(out(), /No exits between these dates/);
  run("setJournalPeriod('day')");
  assert.equal(state.journalPeriodShown, '2026-10-07', 'back to a day: the first of the empty dates');
});

test('a span of days laid out like a month: the weeks it covers, days outside blank, its own numbers', async () => {
  const { run } = await app();
  const daily = `dailyPnl(${JSON.stringify(TRADES)})`;
  const cal = json(run, `calendarSpan(${daily}, '2026-10-06', '2026-10-13')`);
  assert.deepEqual(cal.weeks.map(w => w.start), ['2026-10-05', '2026-10-12']);
  assert.deepEqual(cal.weeks[0].days.map(d => d && d.day), [null, '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'], 'Monday 10/5 is before the dates');
  assert.deepEqual(cal.weeks[1].days.map(d => d && d.day), ['2026-10-12', '2026-10-13', null, null, null]);
  assert.deepEqual([cal.weeks[0].pnl, cal.weeks[0].trades], [-350, 2], 'a week adds up only its days inside');
  assert.deepEqual([cal.pnl, cal.trades, cal.days, cal.green, cal.red], [-300, 3, 2, 1, 1]);
  const month = json(run, `calendarMonth(${daily}, '2026-10')`);
  assert.deepEqual([month.month, month.from, month.to, month.pnl, month.trades], ['2026-10', '2026-10-01', '2026-10-31', 0, 5], 'a month is its span');
});

test('the Calendar tab over picked dates: Month | Dates, From and To, the weeks they cover, back to a month', async () => {
  const records = [...RECORDS, order(5, 'BUY', '2026-11-02T14:35:00+0000', 10, 50, 'PLTR'), order(6, 'SELL', '2026-11-02T15:00:00+0000', 10, 55, 'PLTR')];
  const { run, state, out } = await journal(records);
  run("setJournalTab('calendar')");
  assert.match(out(), /aria-pressed="true" data-action="setCalendarDates" data-arg="month">Month</);
  run("shiftJournalMonth('-1'); setCalendarDates('dates')");
  assert.equal(state.journalCalDates, '2026-10-01..2026-10-31', 'starts as the month shown');
  assert.match(out(), /aria-pressed="true" data-action="setCalendarDates" data-arg="dates">Dates</);
  assert.match(out(), /id="journalCalFrom" value="2026-10-01" data-change="setCalendarRange" data-arg="from"/);
  assert.doesNotMatch(out(), /shiftJournalMonth|journalThisMonth|Review the month/, 'the dates say where: no ‹ ›, This month or month review');
  run("setCalendarRange('from', '2026-10-06')");
  assert.match(out(), /<dt>Net P&amp;L<\/dt><dd class="journal-sell">−\$100\.00<span class="pos-sub">1 trade/);
  assert.match(out(), /<tr><td class="jc-out"><\/td><td><button class="jc-day journal-sell" data-action="openJournalDay" data-arg="2026-10-06"/, 'Monday 10/5 before the dates is blank');
  assert.match(out(), /data-arg="range" data-arg2="2026-10-06\.\.2026-10-31">All of these dates' stats</);
  run("setCalendarRange('to', '2026-11-06')");
  assert.match(out(), /<dt>Net P&amp;L<\/dt><dd class="journal-sell">−\$50\.00<span class="pos-sub">2 trades/, 'across the month end');
  assert.match(out(), /<span class="jc-num">Oct 6<\/span>/, 'across a month end: the first day shown in each month carries it');
  assert.match(out(), /data-arg="2026-11-02"[^>]*><span class="jc-num">Nov 2<\/span><span class="jc-pnl">\+\$50</);
  assert.match(out(), /<span class="jc-num">7<\/span>/, 'other days keep the plain number');
  run("setCalendarRange('from', '2026-11-20')");
  assert.equal(state.journalCalDates, '2026-11-06..2026-11-20', 'a From after To swaps them');
  assert.match(out(), /No exits between these dates/);
  run("setCalendarRange('to', '')");
  assert.equal(state.journalCalDates, '2026-11-06..2026-11-20', 'a cleared box keeps the dates');
  run("setCalendarRange('from', '2026-10-01'); openJournalStats('range', state.journalCalDates)");
  assert.equal(state.journalTab, 'stats');
  assert.match(out(), /aria-pressed="true" data-action="setJournalPeriod" data-arg="range">Dates</);
  assert.match(out(), /id="journalRangeFrom" value="2026-10-01"[\s\S]*id="journalRangeTo" value="2026-11-20"/, 'the stats get the calendar\'s dates');
  run("setJournalTab('calendar'); setCalendarDates('month')");
  assert.equal(state.journalCalDates, '');
  assert.match(out(), /class="jc-title">November 2026</, 'back to the month the dates end in');
});

test('the Trades tab from a date: From alone is that day on, To ends it, a trade opened or with an exit then shows', async () => {
  const records = [...RECORDS, order(5, 'BUY', '2026-10-05T14:00:00+0000', 10, 50, 'PLTR'), order(6, 'SELL', '2026-10-07T15:00:00+0000', 10, 55, 'PLTR')];
  const { run, state, out } = await journal(records);
  const names = () => [...out().matchAll(/<b>(AAPL|MSFT|PLTR)<\/b>/g)].map(m => m[1]).sort();
  assert.deepEqual(names(), ['AAPL', 'MSFT', 'PLTR']);
  assert.match(out(), /<label class="jr-from">Trades from <input type="date" id="journalFrom" value="" [^>]*data-change="setJournalDates" data-arg="from"/);
  assert.doesNotMatch(out(), /clearJournalDates/, 'nothing to clear yet');
  run("setJournalDates('from', '2026-10-06')");
  assert.deepEqual(names(), ['MSFT', 'PLTR'], 'PLTR opened 10/5 but closed 10/7');
  assert.match(out(), /data-action="clearJournalDates">All dates</);
  run("setJournalDates('to', '2026-10-06')");
  assert.deepEqual(names(), ['MSFT'], 'one day: opened or closed that day');
  run("setJournalDates('from', '2026-10-07')");
  assert.deepEqual([state.journalFrom, state.journalTo], ['2026-10-06', '2026-10-07'], 'a From after To swaps them');
  run("setJournalDates('from', '')");
  assert.deepEqual(names(), ['AAPL', 'MSFT', 'PLTR'], 'To alone: everything up to it');
  run("setJournalDates('to', '2026-10-05')");
  assert.deepEqual(names(), ['AAPL', 'PLTR']);
  assert.match(out(), /data-action="setJournalReviewFilter" data-arg="all">All <b>2<\/b>/, 'the review chips count what the dates leave');
  run('clearJournalDates()');
  assert.deepEqual([state.journalFrom, state.journalTo], ['', '']);
  assert.deepEqual(names(), ['AAPL', 'MSFT', 'PLTR']);
});

test('phones: the Trades dates sit in Filters and count as one on', async () => {
  const a = await app({ width: 390, supabase: fakeRecords(RECORDS), session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  const out = () => a.elements.get('journalSection').innerHTML;
  a.run("setJournalDates('from', '2026-10-06')");
  assert.match(out(), /data-action="toggleJournalFilters" aria-expanded="false">Filters <b>1<\/b>/);
  assert.doesNotMatch(out(), /id="journalFrom"/, 'closed: the boxes wait under Filters');
  a.run('toggleJournalFilters()');
  assert.match(out(), /id="journalFrom" value="2026-10-06"/);
});

test('a touch screen applies a date box once its picker closes: the redraw no longer pulls the box from under it', async () => {
  const a = await app({ width: 390, supabase: fakeRecords(RECORDS), session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  a.run(`var box = { dataset: { arg: 'from' }, value: '2026-10-06', listeners: 0, addEventListener(type, fn) { this.listeners++; this.done = fn; } }; document.activeElement = box;`);
  a.run('actions.setJournalDates(box)');
  assert.equal(a.state.journalFrom, '', 'waits while the picker is open');
  a.run("box.value = '2026-10-07'; actions.setJournalDates(box)");
  assert.equal(a.run('box.listeners'), 1, 'one wait for the latest value');
  a.run('document.activeElement = null; box.done()');
  assert.equal(a.state.journalFrom, '2026-10-07', 'closing the picker applies the day picked');
  a.run("box.value = '2026-10-08'; actions.setJournalDates(box)");
  assert.equal(a.state.journalFrom, '2026-10-08', 'a change with the box not focused applies at once');
});
