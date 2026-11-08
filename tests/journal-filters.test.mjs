// Run with: node --test
// The Journal's More filters (docs/journal.md, More filters): + Add filter, a field's values as chips counted over what the
// other filters leave, is or is not, every filter at once, on Trades, Calendar and Stats; and a day on the Trades tab
// opening its notebook page to review it, ← Trades back to the list as it was. A trade feature as a condition: at least,
// at most or between its stamped value, a trade without a current value left out, counted, and only once stamps are read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';
import { applyFilters, conditionCounts, filterChoices, filterField, filtersOn, NONE } from '../src/core/journal-filters.js';
import { FEATURES, featureVersion } from '../src/core/features/index.js';

const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
let n = 0;
const order = (instruction, time, qty, price, symbol) => { const id = ++n; return { kind: 'order', record_id: String(id), account: '6789', entered_at: time, data: {
  orderId: id, enteredTime: time, status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction, quantity: qty, instrument: { symbol, assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 9000 + id, executionLegs: [{ legId: 1, quantity: qty, price, time }] }] } }; };
// three closed trades on two days: AAPL won and MSFT lost on 10/1, NVDA won on 10/2
const ROWS = [
  order('BUY', '2026-10-01T14:30:00Z', 100, 100, 'AAPL'), order('SELL', '2026-10-01T18:00:00Z', 100, 102, 'AAPL'),
  order('BUY', '2026-10-01T15:00:00Z', 10, 400, 'MSFT'), order('SELL', '2026-10-01T19:00:00Z', 10, 396, 'MSFT'),
  order('BUY', '2026-10-02T14:00:00Z', 50, 180, 'NVDA'), order('SELL', '2026-10-02T17:00:00Z', 50, 183, 'NVDA'),
];
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

async function journal(width = 1500) {
  const supabase = fakeRecords(ROWS);
  const a = await app({ width, supabase, session: SESSION });
  const key = sym => a.run(`journalTradeList().find(t => t.symbol === '${sym}').key`);
  a.run("setView('journal')");
  await a.run('loadJournal()');
  await settle();
  // AAPL graded A with a mistake, MSFT graded C; NVDA not reviewed yet
  const s = supabase;
  s.reviews.set(`user-1:${key('AAPL')}`, { user_id: 'user-1', trade_key: key('AAPL'), setup_grade: 'A', plan_followed: 'yes' });
  s.tables.trade_labels.set(`user-1:${key('AAPL')}:mistake:chased`, { user_id: 'user-1', trade_key: key('AAPL'), kind: 'mistake', value: 'chased', set_by: 'you' });
  s.reviews.set(`user-1:${key('MSFT')}`, { user_id: 'user-1', trade_key: key('MSFT'), setup_grade: 'C', plan_followed: 'no' });
  await a.run('loadJournal()');
  await settle();
  const shown = () => a.run('benchKeys()').map(k => k.split('|')[1]).sort().join(','); // the Trades tab's list, as filtered
  return { ...a, key, shown, list: () => a.elements.get('journalSection').innerHTML };
}

test('core: each filter is any of its values (none of them with is not), every filter at once; a filter with nothing picked narrows nothing', () => {
  const trades = [
    { key: 'a', status: 'closed', pnl: 50, r: 2.5, assetType: 'EQUITY', openedAt: '2026-10-01T14:30:00Z', holdMs: 600000, exits: 1 },
    { key: 'b', status: 'closed', pnl: -20, r: -1.2, assetType: 'OPTION', openedAt: '2026-10-02T14:30:00Z', holdMs: 600000, exits: 2 },
    { key: 'c', status: 'open', pnl: 0, r: null, assetType: 'EQUITY', openedAt: '2026-10-05T14:30:00Z', holdMs: null, exits: 0 },
    { key: 'h', status: 'history', pnl: 0, r: null, assetType: 'EQUITY', openedAt: null, holdMs: null, exits: 1 },
  ];
  const grades = { a: 'A', b: 'C' };
  const ctx = { grade: t => grades[t.key] || '', plan: () => '', market: () => '', labels: t => t.key === 'a' ? ['chased'] : [], nameOf: (kind, key) => key === 'chased' ? 'Chased the entry' : key };
  const keys = filters => applyFilters(trades, filters, ctx).map(t => t.key).join(',');
  assert.equal(keys([{ field: 'grade', values: ['A', 'C'] }]), 'a,b');
  assert.equal(keys([{ field: 'grade', values: ['A'], not: true }]), 'b,c,h', 'is not: every trade without it, before your history too');
  assert.equal(keys([{ field: 'grade', values: [NONE] }]), 'c', 'not graded: a trade from before your history has no review to lack');
  assert.equal(keys([{ field: 'outcome', values: ['win'] }, { field: 'instrument', values: ['Options'] }]), '', 'every filter at once');
  assert.equal(keys([{ field: 'r', values: ['ge2', 'lt-1'] }]), 'a,b');
  assert.equal(keys([{ field: 'exits', values: ['scaled'] }]), 'b');
  assert.equal(keys([{ field: 'mistake', values: [NONE] }]), 'b,c', 'No mistakes');
  assert.equal(keys([{ field: 'grade', values: [] }]), 'a,b,c,h');
  assert.equal(filtersOn([{ field: 'grade', values: [] }, { field: 'outcome', values: ['win'] }, { field: 'nope', values: ['x'] }]), 1);
  // the counts leave this filter out and keep the others: what picking a value would show
  const filters = [{ field: 'grade', values: ['A'] }, { field: 'outcome', values: ['win', 'loss'] }];
  assert.deepEqual(filterChoices(trades, filters, 'grade', ctx).map(c => `${c.name} ${c.count}${c.on ? ' on' : ''}`), ['A 1 on', 'C 1']);
  assert.deepEqual(filterChoices(trades, filters, 'outcome', ctx).map(c => `${c.name} ${c.count}`), ['Win 1', 'Loss 0'], 'a picked value stays with 0');
  assert.deepEqual(filterChoices(trades, [], 'mistake', ctx).map(c => `${c.name} ${c.count}`), ['Chased the entry 1', 'No mistakes 2'], 'yours most used first, none last');
});

test('core: a feature condition is at least, at most or between its value; no current value never fits; no number narrows nothing', () => {
  const F = FEATURES.find(f => f.key === 'atr_from_daily_sma50'), key = `feature:${F.key}`;
  const values = { a: -1, b: 2, c: 4.5, d: null };
  const trades = ['a', 'b', 'c', 'd', 'e'].map(k => ({ key: k, status: 'win', pnl: 1 }));
  const ctx = { featureValue: (t, f) => f === F ? values[t.key] ?? null : null };
  const keys = filters => applyFilters(trades, filters, ctx).map(t => t.key).join(',');
  assert.equal(filterField(key).label, 'ATRs from the daily 50 SMA');
  assert.equal(keys([{ field: key, values: [], op: 'atleast', min: 2 }]), 'b,c', 'at least: the number itself fits');
  assert.equal(keys([{ field: key, values: [], op: 'atmost', max: 2 }]), 'a,b');
  assert.equal(keys([{ field: key, values: [], op: 'between', min: 4.5, max: 0 }]), 'b,c', 'between, either order, both ends in');
  assert.equal(keys([{ field: key, values: [], op: 'atleast', min: null }]), 'a,b,c,d,e', 'no number yet: narrows nothing');
  assert.equal(keys([{ field: key, values: [], op: 'between', min: 1, max: null }]), 'a,b,c,d,e', 'between needs both');
  assert.equal(filtersOn([{ field: key, values: [], op: 'atleast', min: null }, { field: key, values: [], op: 'atmost', max: 0 }]), 1);
  assert.equal(keys([{ field: key, values: [], op: 'atleast', min: -5 }, { field: 'outcome', values: ['win'] }]), 'a,b,c', 'with the others; d unknown and e not stamped left out');
  assert.deepEqual(conditionCounts(trades, [{ field: key, values: [], op: 'atleast', min: 3 }], key, ctx), { total: 5, fit: 1, noValue: 2 });
  assert.deepEqual(conditionCounts(trades, [{ field: key, values: [], op: 'atleast', min: null }], key, ctx), { total: 5, fit: 5, noValue: 2 });
  assert.equal(filterField('feature:not_a_feature'), null);
});

test('a feature as a filter: in the menu by family once stamps are read; the condition narrows Trades and Stats; counts; the numbers', async () => {
  const a = await journal();
  const F = FEATURES.find(f => f.key === 'atr_from_daily_sma50'), key = `feature:${F.key}`, v = featureVersion(F);
  a.run("featureStamps = null; renderJournal()");
  assert.doesNotMatch(a.list(), /Features: /, 'before the stamps are read: no features in the menu');
  a.run(`featureStamps = ${JSON.stringify({ [a.key('AAPL')]: { [F.key]: { v, value: 1.2 } }, [a.key('MSFT')]: { [F.key]: { v, value: 4.8 } }, [a.key('NVDA')]: { [F.key]: { v, value: null, note: 'fewer than 49 daily sessions before' } } })}; renderJournal()`);
  assert.match(a.list(), /<optgroup label="Features: Moving averages">[^]*?<option value="feature:atr_from_daily_sma50">ATRs from the daily 50 SMA<\/option>/);
  a.run(`addJournalFilter('${key}')`);
  let block = a.list().split('class="jf-filter jf-condition')[1].split('class="jf-foot"')[0];
  assert.match(block, /aria-pressed="true" data-action="setJournalFilterOp" data-arg="feature:atr_from_daily_sma50" data-arg2="atleast">at least</);
  assert.match(block, /<input class="jf-num" type="number" step="any" value="" data-change="setJournalFilterBound" data-arg="feature:atr_from_daily_sma50" data-arg2="min"/);
  assert.match(block, /<span class="jf-unit">ATR<\/span><span class="jf-count">2 of 3 trades have a value<\/span>/);
  assert.equal(a.shown(), 'AAPL,MSFT,NVDA', 'no number yet: every trade');
  a.run(`setJournalFilterBound('${key}', 'min', '3')`);
  assert.equal(a.shown(), 'MSFT');
  block = a.list().split('class="jf-filter jf-condition')[1].split('class="jf-foot"')[0];
  assert.match(block, /^ active"/, 'set: active');
  assert.match(block, /value="3"/);
  assert.match(block, /1 of 3 trades fit · 1 without a value left out/);
  a.run(`setJournalFilterOp('${key}', 'atmost'); setJournalFilterBound('${key}', 'max', '2')`);
  assert.equal(a.shown(), 'AAPL');
  a.run(`setJournalFilterOp('${key}', 'between'); setJournalFilterBound('${key}', 'max', '5')`);
  assert.equal(a.shown(), 'MSFT', 'between the 3 typed before and 5: the typed numbers stay');
  assert.match(a.list(), /value="3"[^]*?<span class="jf-and">and<\/span>[^]*?value="5"/);
  a.run(`setJournalFilterBound('${key}', 'min', '-1')`);
  assert.equal(a.shown(), 'AAPL,MSFT');
  a.run("setJournalTab('stats')");
  assert.match(a.list(), />AAPL</);
  assert.doesNotMatch(a.list(), />NVDA</, 'Stats count the same trades');
  a.run(`setJournalTab('trades'); setJournalFilterBound('${key}', 'min', '')`);
  assert.equal(a.shown(), 'AAPL,MSFT,NVDA', 'a number cleared: narrows nothing again');
  a.run(`setJournalFilterOp('${key}', 'sideways'); setJournalFilterBound('${key}', 'mid', '1')`);
  assert.equal(a.run(`journalFilters.find(f => f.field === '${key}').op`), 'between', 'unknown ops and ends change nothing');
  // the stamps not read (signed out, or the table not pushed): the condition stands down rather than hide every trade
  a.run(`setJournalFilterBound('${key}', 'min', '3'); featuresError = 'no table'; renderJournal()`);
  assert.equal(a.shown(), 'AAPL,MSFT,NVDA');
  assert.doesNotMatch(a.list(), /jf-condition/);
});

test('+ Add filter: Setup grade with its values counted; picking A narrows Trades, Stats and Calendar; is not; × takes it off', async () => {
  const a = await journal();
  assert.match(a.list(), /<div class="jb-filters journal-controls"[^]*?<select class="jf-add" data-change="addJournalFilter"[^]*?<option value="grade">Setup grade<\/option>/, 'in the rail');
  a.run("addJournalFilter('grade')");
  assert.equal(a.shown(), 'AAPL,MSFT,NVDA', 'nothing picked yet: every trade');
  const block = a.list().split('class="jf-filter')[1].split('class="jf-foot"')[0];
  assert.match(block, /<span class="jf-name">Setup grade<\/span>/);
  assert.match(block, /data-arg2="A">A <b>1<\/b><\/button>[^]*?data-arg2="C">C <b>1<\/b>[^]*?data-arg2="none">Not graded <b>1<\/b>/);
  assert.doesNotMatch(block, /data-arg2="B"/, 'only the grades some trade has');
  assert.doesNotMatch(a.list(), /<option value="grade">/, 'used: off the menu');
  a.run("toggleJournalFilterValue('grade', 'A')");
  assert.equal(a.shown(), 'AAPL');
  assert.match(a.list(), /<div class="jf-filter active">/);
  a.run("setJournalFilterNot('grade', 'not')");
  assert.equal(a.shown(), 'MSFT,NVDA');
  a.run("setJournalFilterNot('grade', 'is')");
  a.run("setJournalTab('stats')");
  assert.match(a.list(), />AAPL</, 'Stats count the same trades');
  assert.doesNotMatch(a.list(), />(MSFT|NVDA)</);
  assert.match(a.list(), /class="jf-filter active"/, 'and show the filters');
  a.run("setJournalTab('trades'); removeJournalFilter('grade')");
  assert.equal(a.shown(), 'AAPL,MSFT,NVDA');
  assert.doesNotMatch(a.list(), /class="jf-filter/);
});

test('filters add up: an outcome and a mistake; the review chips count what they leave; Remove all', async () => {
  const a = await journal();
  a.run("addJournalFilter('outcome'); toggleJournalFilterValue('outcome', 'win')");
  assert.equal(a.shown(), 'AAPL,NVDA');
  a.run("addJournalFilter('mistake'); toggleJournalFilterValue('mistake', 'none')");
  assert.equal(a.shown(), 'NVDA');
  assert.match(a.list(), /data-arg="all">All <b>1<\/b>/, 'the chips count the filtered trades');
  const mistakes = a.list().split('<span class="jf-name">Mistakes</span>')[1].split('class="jf-foot"')[0];
  assert.match(mistakes, /Chased the entry <b>1<\/b>[^]*?No mistakes <b>1<\/b>/, 'counted over the winners');
  a.run('clearJournalFilters()');
  assert.equal(a.shown(), 'AAPL,MSFT,NVDA');
});

test('phones: More filters sit in Filters and count toward its number', async () => {
  const a = await journal(390);
  a.run("addJournalFilter('grade'); toggleJournalFilterValue('grade', 'C')");
  assert.match(a.list(), /data-action="toggleJournalFilters" aria-expanded="false">Filters <b>1<\/b>/);
  assert.doesNotMatch(a.list(), /class="jf"/, 'closed');
  a.run('toggleJournalFilters()');
  assert.match(a.list(), /<div class="journal-filters">[^]*?<div class="jf" role="group" aria-label="More filters">/);
  assert.equal(a.shown(), 'MSFT');
});

test('a day on the Trades tab: its date and Review the day open its notebook page, ← Trades goes back with the filters kept', async () => {
  const a = await journal();
  const head = a.list().split('<tr class="jb-day">').find(h => h.includes('data-arg="2026-10-01"'));
  assert.match(head, /<button class="jd-date" data-action="reviewJournalDay" data-arg="2026-10-01"[^>]*>Thu · Oct 1<\/button>/, 'the date opens the day');
  assert.match(head, /<span class="jb-day-end"><button class="pos-link jd-review" data-action="reviewJournalDay" data-arg="2026-10-01"[^>]*>Review the day ›<\/button><b class="jb-day-total/, 'Review the day beside its P&L');
  a.run("state.journalSymbol = 'A'; reviewJournalDay('2026-10-01')");
  assert.equal(a.run('state.journalNotebookDay'), '2026-10-01');
  assert.match(a.list(), /data-action="closeJournalDay">← Trades<\/button>/);
  a.run('stepJournalDay(-1)');
  assert.match(a.list(), /← Trades/, 'stepping days keeps the way back');
  a.run('closeJournalDay()');
  assert.equal(a.run('state.journalTab'), 'trades');
  assert.equal(a.run('state.journalSymbol'), 'A', 'the list as it was');
  a.run("reviewJournalDay('2026-10-01'); setJournalTab('calendar'); openJournalDay('2026-10-02')");
  assert.match(a.list(), /← Calendar/, 'opened from the calendar: back to it');
});

test('a calendar day picked on the Trades tab keeps through its notebook page and back', async () => {
  const a = await journal(1000);
  a.run("pickJournalDay('2026-10-02')");
  assert.match(a.list(), /Exits 10\/2 ×[^]*?The day's stats<\/button><button class="pos-link jd-review" data-action="reviewJournalDay" data-arg="2026-10-02"/);
  a.run("reviewJournalDay('2026-10-02'); closeJournalDay()");
  assert.equal(a.run('state.journalDay'), '2026-10-02');
  assert.equal(a.shown(), 'NVDA');
});

test('core: Ticker type is what the trade is on, whatever the instrument: Stocks, ETFs, Indexes, Futures', async () => {
  const { tickerType } = await import('../src/core/journal-filters.js');
  const { ETFS } = await import('../src/core/etfs.js');
  const { readFileSync, readdirSync } = await import('node:fs');
  assert.equal(tickerType({ symbol: 'AAPL', assetType: 'EQUITY' }), 'Stocks');
  assert.equal(tickerType({ symbol: 'NVDA', assetType: 'EQUITY' }), 'Stocks', 'a stock a leveraged fund tracks is still a stock');
  assert.equal(tickerType({ symbol: 'SPY', assetType: 'EQUITY' }), 'ETFs');
  assert.equal(tickerType({ symbol: 'TQQQ', assetType: 'EQUITY' }), 'ETFs', 'a leveraged fund');
  assert.equal(tickerType({ symbol: 'XYZW', assetType: 'COLLECTIVE_INVESTMENT' }), 'ETFs', 'Schwab says so');
  assert.equal(tickerType({ symbol: 'ABCD', assetType: 'EQUITY' }, { ABCD: '-NVDA' }), 'ETFs', 'one of your funds');
  assert.equal(tickerType({ symbol: 'QQQ   261120C00500000', assetType: 'OPTION' }), 'ETFs', 'an option on an ETF');
  assert.equal(tickerType({ symbol: 'AAPL  261120C00200000', assetType: 'OPTION' }), 'Stocks');
  assert.equal(tickerType({ symbol: 'SPXW  261106C05900000', assetType: 'OPTION' }), 'Indexes');
  assert.equal(tickerType({ symbol: 'SPY', assetType: 'SPREAD', legs: [] }), 'ETFs', 'a spread goes by its root');
  assert.equal(tickerType({ symbol: '/MESZ26', assetType: 'FUTURE' }), 'Futures');
  // the Market tab's ETF list is all in
  const csv = readdirSync('data').find(f => /^market-etfs-.*\.csv$/.test(f));
  const tickers = readFileSync(`data/${csv}`, 'utf8').trim().split('\n').slice(1).map(l => l.split(',')[0]);
  assert.deepEqual(tickers.filter(t => !ETFS.has(t)), []);
  // only ETFs, or everything but futures
  const trades = [
    { key: 'a', symbol: 'AAPL', assetType: 'EQUITY', status: 'closed' }, { key: 's', symbol: 'SPY', assetType: 'EQUITY', status: 'closed' },
    { key: 'f', symbol: '/MESZ26', assetType: 'FUTURE', status: 'closed' },
  ];
  const ctx = { grade: () => '', plan: () => '', market: () => '', labels: () => [], nameOf: (k, v) => v };
  const keys = filters => applyFilters(trades, filters, ctx).map(t => t.key).join(',');
  assert.equal(keys([{ field: 'ticker', values: ['ETFs'] }]), 's');
  assert.equal(keys([{ field: 'ticker', values: ['Stocks'] }]), 'a');
  assert.equal(keys([{ field: 'ticker', values: ['Futures'], not: true }]), 'a,s');
  assert.deepEqual(filterChoices(trades, [], 'ticker', ctx).map(c => `${c.name} ${c.count}`), ['Stocks 1', 'ETFs 1', 'Futures 1'], 'only the kinds some trade has');
});

test('+ Add filter offers Ticker type in the rail', async () => {
  const a = await journal();
  assert.match(a.list(), /<option value="ticker">Ticker type<\/option>/);
  a.run("addJournalFilter('ticker')");
  const block = a.list().split('class="jf-filter')[1].split('class="jf-foot"')[0];
  assert.match(block, /data-arg2="Stocks">Stocks <b>3<\/b>/);
  a.run("toggleJournalFilterValue('ticker', 'ETFs')");
  assert.equal(a.shown(), '');
});
