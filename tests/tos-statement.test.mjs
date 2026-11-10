// Run with: node --test
// Futures from a thinkorswim Account Statement: the fills read out of it (fees, opened or closed, the account's last 4
// only), the zone its clock is in, point values, the trades they make (checked against the statement's own realized
// amounts), and the Import sheet's upload: preview, save as statement fills, import again adds nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';
import { csvCells, parseTosStatement, statementRecords, statementZone, wallToMs } from '../src/core/tos-statement.js';
import { futuresSpec } from '../src/core/futures.js';
import { fillsFrom, recordsSummary } from '../src/core/journal-records.js';
import { journalTrades, multiplierOf } from '../src/core/journal.js';
import { tradeBarSymbols } from '../src/core/bars.js';

// a real export's shape (one day of MNQ, a stock trade), every number in it made up
const STATEMENT = `Account Statement for 12345678SCHW (Individual) since 10/19/26 through 10/19/26

Cash Balance
DATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE
10/19/26,22:00:00,BAL,,Cash balance at the start of business day 20.10 CST,,,,"25,000.00"
10/20/26,10:47:48,TRD,="5052168285530",SOLD -4 XYZ @41.225,-0.06,,164.90,"25,164.90"
,,,,TOTAL,($0.20),,"($1,250.00)","$23,914.90"

Futures Statements
Trade Date,Exec Date,Exec Time,Type,Ref #,Description,Misc Fees,Commissions & Fees,Amount,Balance
10/19/26,10/19/26,22:00:00,BAL,--,Futures cash balance at the start of business day 20.10 CST,--,--,--,100.00
10/19/26,10/19/26,22:00:00,FSWP,--,Cash sweep from equities account,--,--,"1,000.00","1,100.00"
10/19/26,10/20/26,07:28:36,TRD,="5052155417428",BOT +1 /MNQZ26:XCME @27874.00,-0.36,-2.25,-303.00,"1,094.39"
10/19/26,10/20/26,09:20:47,TRD,="5052165952276",SOLD -1 /MNQZ26:XCME @27716.75,-0.36,-2.25,--,"1,091.78"
10/19/26,10/20/26,14:00:00,ADJ,--,/MNQZ26:XCME mark to market at 27675.25 preliminary settlement price,--,--,83.00,"1,174.78"
*,10/20/26,15:07:08,TRD,="5052172347329",SOLD -1 /MNQZ26:XCME @27946.00,-0.36,-2.25,--,--
*,10/20/26,15:27:05,TRD,="5052172347392",SOLD -2 /MNQZ26:XCME @27972.75,-0.72,-4.50,--,--
*,10/20/26,16:21:47,TRD,="5052172347527",BOT +1 /MNQZ26:XCME @27885.00,-0.36,-2.25,-419.50,--
*,10/20/26,16:21:47,TRD,="5052172347527",BOT +1 /MNQZ26:XCME @27885.00,-0.36,-2.25,122.00,--
*,10/20/26,16:22:49,TRD,="5052172347553",BOT +1 /MNQZ26:XCME @27872.00,-0.36,-2.25,201.50,--
*,10/20/26,16:23:49,TRD,="5052172347555",BOT +1 /MNQZ26:XCME @27870.50,-0.36,-2.25,204.50,--
*,10/20/26,16:30:00,TRD,="5052172347600",BOT +1 /ZBZ26:XCBT @117.15625,-0.36,-2.25,--,--


"Total Cash $25,089.67"

Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,10/20/26 16:23:49,FUTURE,BUY,+1,TO CLOSE,/MNQZ26,DEC 26,,FUTURE,27870.50,27870.50,MKT
,10/20/26 16:22:49,FUTURE,BUY,+1,TO CLOSE,/MNQZ26,DEC 26,,FUTURE,27872.00,27872.00,MKT
,10/20/26 16:21:47,FUTURE,BUY,+1,TO CLOSE,/MNQZ26,DEC 26,,FUTURE,27885.00,27885.00,LMT
,10/20/26 16:21:47,FUTURE,BUY,+1,TO CLOSE,/MNQZ26,DEC 26,,FUTURE,27885.00,27885.00,LMT
,10/20/26 15:27:05,FUTURE,SELL,-2,TO OPEN,/MNQZ26,DEC 26,,FUTURE,27972.75,27972.75,LMT
,10/20/26 15:07:08,FUTURE,SELL,-1,TO OPEN,/MNQZ26,DEC 26,,FUTURE,27946.00,27946.00,LMT
,10/20/26 10:47:48,STOCK,SELL,-4,TO OPEN,XYZ,,,STOCK,41.225,41.225,MKT
,10/20/26 09:20:47,FUTURE,SELL,-1,TO OPEN,/MNQZ26,DEC 26,,FUTURE,27716.75,27716.75,LMT
,10/20/26 07:28:36,FUTURE,BUY,+1,TO CLOSE,/MNQZ26,DEC 26,,FUTURE,27874.00,27874.00,STP

Account Summary
Net Liquidating Value,"$25,089.67"
`;

// the same XYZ sale as Schwab's API has it: 10:47:48 Pacific
const XYZ_ORDER = {
  orderId: 5052168285530, enteredTime: '2026-10-20T17:47:47+0000', status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction: 'SELL_SHORT', quantity: 4, instrument: { symbol: 'XYZ', assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 1, executionLegs: [{ legId: 1, quantity: 4, price: 41.225, time: '2026-10-20T17:47:48+0000' }] }],
};
const SCHWAB = [{ kind: 'order', record_id: '5052168285530', account: '5678', entered_at: '2026-10-20T17:47:47Z', data: XYZ_ORDER }];

test('cells: quotes, thousands, and the ="…" thinkorswim puts around order numbers', () => {
  assert.deepEqual(csvCells('10/20/26,TRD,="5052168285530","1,164.90",'), ['10/20/26', 'TRD', '5052168285530', '1,164.90', '']);
  assert.deepEqual(csvCells('"say ""hi""",x'), ['say "hi"', 'x']);
});

test('futures contracts: root, month and dollars per point from the symbol', () => {
  assert.deepEqual(futuresSpec('/MNQZ26:XCME'), { root: 'MNQ', name: 'Micro E-mini Nasdaq-100', month: 'Dec', year: 2026, pointValue: 2 });
  assert.equal(futuresSpec('/ESH6').pointValue, 50);
  assert.equal(futuresSpec('/M2KU26').root, 'M2K');
  assert.equal(futuresSpec('/CLZ26').pointValue, 1000);
  assert.equal(futuresSpec('/ZBZ26'), null, 'a root without a point value yet');
  assert.equal(futuresSpec('MNQZ26'), null);
  assert.equal(multiplierOf('FUTURE', '/MESZ26'), 5);
  assert.equal(multiplierOf('OPTION', 'AAPL  261218C00245000'), 100);
  assert.equal(multiplierOf('EQUITY', 'AAPL'), 1);
  assert.deepEqual(tradeBarSymbols({ symbol: '/MNQZ26', assetType: 'FUTURE' }), ['/MNQZ26'], 'the contract traded: its bars come from Schwab');
});

test('the statement: futures fills with fees and whether each opened or closed, the account as its last 4 only', () => {
  const p = parseTosStatement(STATEMENT);
  assert.equal(p.error, undefined);
  assert.equal(p.account, '5678');
  assert.ok(!JSON.stringify(p).includes('12345678'), 'the full account number goes nowhere');
  assert.deepEqual([p.from, p.through], ['2026-10-19', '2026-10-19']);
  assert.deepEqual(p.fills.map(f => [f.id, f.wall, f.side, f.qty, f.price, f.fee, f.instruction]), [
    ['tos:5052155417428:1', '2026-10-20T07:28:36', 'buy', 1, 27874, 2.61, 'BUY_TO_CLOSE'],
    ['tos:5052165952276:1', '2026-10-20T09:20:47', 'sell', 1, 27716.75, 2.61, 'SELL_TO_OPEN'],
    ['tos:5052172347329:1', '2026-10-20T15:07:08', 'sell', 1, 27946, 2.61, 'SELL_TO_OPEN'],
    ['tos:5052172347392:1', '2026-10-20T15:27:05', 'sell', 2, 27972.75, 5.22, 'SELL_TO_OPEN'],
    ['tos:5052172347527:1', '2026-10-20T16:21:47', 'buy', 1, 27885, 2.61, 'BUY_TO_CLOSE'],
    ['tos:5052172347527:2', '2026-10-20T16:21:47', 'buy', 1, 27885, 2.61, 'BUY_TO_CLOSE'],
    ['tos:5052172347553:1', '2026-10-20T16:22:49', 'buy', 1, 27872, 2.61, 'BUY_TO_CLOSE'],
    ['tos:5052172347555:1', '2026-10-20T16:23:49', 'buy', 1, 27870.5, 2.61, 'BUY_TO_CLOSE'],
  ]);
  assert.ok(p.fills.every(f => f.symbol === '/MNQZ26'), 'the exchange suffix is dropped');
  assert.deepEqual(p.skipped.map(s => s.why), ['no point value for /ZBZ26 yet']);
  assert.deepEqual(p.stockFills, [{ orderId: '5052168285530', wall: '2026-10-20T10:47:48' }]);

  // without Account Trade History, nothing says opened or closed: buys and sells stay free to open either way
  const bare = parseTosStatement(STATEMENT.split('Account Trade History')[0]);
  assert.deepEqual([...new Set(bare.fills.map(f => f.instruction))], ['BUY', 'SELL_SHORT']);

  assert.match(parseTosStatement('DATE,TIME\n1,2').error, /isn't a thinkorswim Account Statement/);
  assert.match(parseTosStatement('Account Statement for 12345678SCHW (Individual) since 10/19/26 through 10/19/26\n\nCash Balance\nDATE,TIME,TYPE,REF #\n').error, /no Futures Statements/);
});

test("the file's clock: matched against Schwab's own fills, else the device's zone", () => {
  assert.equal(new Date(wallToMs('2026-10-20T10:47:48', 'America/Los_Angeles')).toISOString(), '2026-10-20T17:47:48.000Z');
  assert.equal(new Date(wallToMs('2026-12-01T09:30:00', 'America/New_York')).toISOString(), '2026-12-01T14:30:00.000Z', 'standard time after the clocks go back');
  const p = parseTosStatement(STATEMENT);
  const schwab = fillsFrom(SCHWAB).map(f => ({ orderId: f.orderId, time: f.time }));
  assert.deepEqual(statementZone(p.stockFills, schwab, 'America/New_York'), { zone: 'America/Los_Angeles', matched: 1, checked: 1 });
  assert.deepEqual(statementZone(p.stockFills, [], 'America/Chicago'), { zone: 'America/Chicago', matched: 0, checked: 0 });
});

test("the trades they make: four MNQ shorts covered at the statement's own realized amounts, $2 a point, fees after", () => {
  const p = parseTosStatement(STATEMENT);
  const records = statementRecords(p.fills, p.account, 'America/Los_Angeles');
  assert.deepEqual(records[0], {
    kind: 'statement_fill', record_id: 'tos:5052155417428:1', account: '5678', entered_at: '2026-10-20T14:28:36.000Z',
    data: { id: 'tos:5052155417428:1', orderId: 'tos:5052155417428', symbol: '/MNQZ26', label: '/MNQZ26', side: 'buy', qty: 1, price: 27874, fee: 2.61,
      instruction: 'BUY_TO_CLOSE', account: '5678', time: '2026-10-20T14:28:36.000Z', assetType: 'FUTURE', source: 'thinkorswim' },
  });
  assert.equal(recordsSummary(records).statementFills, 8);
  const fills = fillsFrom(records);
  assert.equal(fills.length, 8);

  const [short, before] = journalTrades(fills, records, {}, { now: Date.parse('2026-10-21T00:00:00Z') });
  assert.equal(short.status, 'win');
  assert.equal(short.direction, 'short');
  assert.equal(short.multiplier, 2);
  assert.equal(short.entryQty, 4);
  assert.deepEqual(short.realized.map(e => e.pnl), [-336.5, 122, 201.5, 204.5], "the statement's 122.00, 201.50, 204.50 (and −419.50 = −336.50 less yesterday's 83.00 mark)");
  assert.equal(short.pnl, 191.5);
  assert.equal(short.fees, 20.88, 'its eight contracts in and out, $2.61 each');
  assert.equal(short.feesMissing, 0);
  // the 07:28 buy covered a short from before the statement: kept out of the stats like any trade before your history
  assert.equal(before.status, 'history');
  assert.equal(before.fees, 2.61);

  const [net] = journalTrades(fills, records, {}, { afterFees: true, now: Date.parse('2026-10-21T00:00:00Z') });
  assert.equal(net.pnl, 170.62);

  // your stop makes the risk and R, at $2 a point
  const [withStop] = journalTrades(fills, records, { [short.key]: { stop: 28000 } }, { now: Date.parse('2026-10-21T00:00:00Z') });
  assert.equal(withStop.risk, Math.round((28000 - short.avgEntry) * 4 * 2 * 100) / 100);
  assert.equal(withStop.r, Math.round(191.5 / withStop.risk * 100) / 100);
});

// let pending reads and saves (fake network, fake Supabase) finish
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const statementFile = (text = STATEMENT) => ({ name: '2026-10-20-AccountStatement.csv', size: text.length, text: async () => text });

test('Import sheet: choose a statement, see what it holds, save it, and the same file again adds nothing', async () => {
  const supabase = fakeRecords(SCHWAB);
  const { run, elements, state } = await app({ supabase, session: SESSION });
  run("setView('journal')");
  await run('loadJournal()');
  run('openJournalImport()');
  const body = () => elements.get('journalImportBody').innerHTML;
  assert.match(body(), /thinkorswim statement <span class="sheet-status">futures/);
  assert.match(body(), /data-action="pickTosStatement">Choose statement \(CSV\)/);

  const input = elements.get('tosStatementInput');
  input.files = [statementFile()];
  await run(`tosStatementChosen(document.getElementById('tosStatementInput'))`);
  assert.match(body(), /<b>8 futures fills<\/b> · \/MNQZ26 · Oct 20 · fees \$23\.49 · account ••5678/);
  assert.match(body(), /All new\./);
  assert.match(body(), /Times read as Pacific time: 1 of 1 stock fills match Schwab's\./);
  assert.match(body(), /Skipped 1: BOT \+1 \/ZBZ26:XCBT @117\.15625 \(no point value for \/ZBZ26 yet\)/);
  assert.match(body(), /data-action="saveTosStatement">Save 8 fills</);

  await run('saveTosStatement()');
  await settle();
  const saved = supabase.writes.filter(w => w.table === 'schwab_records');
  assert.equal(saved.length, 8);
  assert.ok(saved.every(w => w.kind === 'statement_fill' && w.ignoreDuplicates && w.onConflict === 'user_id,kind,record_id' && w.account === '5678'));
  assert.equal(saved[0].entered_at, '2026-10-20T14:28:36.000Z', '07:28 Pacific');
  assert.equal(elements.get('errorBox').textContent, 'Saved 8 futures fills.');
  assert.equal(state.tosImport, null);

  // the journal re-read: the futures trade is there, P&L at $2 a point
  run("setJournalTab('trades')");
  assert.match(elements.get('journalSection').innerHTML, /8 futures fills/);
  assert.match(elements.get('journalSection').innerHTML, /\/MNQZ26/);

  input.files = [statementFile()];
  await run(`tosStatementChosen(document.getElementById('tosStatementInput'))`);
  assert.match(body(), /All already kept\./);
  assert.doesNotMatch(body(), /saveTosStatement/);
});

test('Import sheet: a file that is not a statement says so; the zone can be changed by hand', async () => {
  const { run, elements, state } = await app({ supabase: fakeRecords([]), session: SESSION });
  run("setView('journal')");
  await run('loadJournal()');
  run('openJournalImport()');
  const body = () => elements.get('journalImportBody').innerHTML;
  elements.get('tosStatementInput').files = [statementFile('Symbol,Qty\nAAPL,1')];
  await run(`tosStatementChosen(document.getElementById('tosStatementInput'))`);
  assert.match(body(), /isn&#39;t a thinkorswim Account Statement|isn't a thinkorswim Account Statement/);

  elements.get('tosStatementInput').files = [statementFile()];
  await run(`tosStatementChosen(document.getElementById('tosStatementInput'))`);
  assert.match(body(), /Times read as [A-Za-z ]+ time, this device's zone\./, 'no Schwab fills to match against');
  elements.get('tosZone').value = 'America/Chicago';
  run(`setTosZone(document.getElementById('tosZone'))`);
  assert.equal(state.tosImport.zone, 'America/Chicago');
  assert.match(body(), /<option value="America\/Chicago" selected>Central</);
  run('clearTosStatement()');
  assert.match(body(), /Choose statement \(CSV\)/);
});

test('Fills tab: a futures fill is valued at its point value, and the side filter sides it like its trade', async () => {
  const p = parseTosStatement(STATEMENT);
  const records = statementRecords(p.fills, p.account, 'America/Los_Angeles');
  const { run, elements } = await app({ supabase: fakeRecords([...SCHWAB, ...records]), session: SESSION });
  run("setView('journal')");
  await run('loadJournal()');
  run("setJournalTab('fills')");
  const rows = () => [...elements.get('journalSection').innerHTML.matchAll(/<tr>\s*<td><b>([^<]*)<\/b><\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td>[^<]*<\/td>\s*<td>[^<]*<\/td>\s*<td>([^<]*)<\/td>/g)]
    .map(m => `${m[1]} ${m[2]} ${m[3]}`);
  assert.ok(rows().includes('/MNQZ26 Buy to close $55,748.00'), '1 MNQ at 27,874 is $2 a point, not $27,874: ' + rows().join(' | '));
  run("setJournalSide('short')");
  assert.equal(rows().filter(r => / Sell to open /.test(r)).length, 3, 'sold to open is short, as its trade is');
  assert.equal(rows().filter(r => / Buy to close /.test(r)).length, 5, 'and so are the covers');
  run("setJournalSide('long')");
  assert.deepEqual(rows(), []);
});
