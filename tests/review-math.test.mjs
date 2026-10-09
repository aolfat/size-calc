// Run with: node --test
// Review fixes in the pure math: New York expiry close, allocation round trips, monthly expiries,
// extended-hours windows, shorthand dates and extra numbers, clock-time bar buckets.
// The browser here sits in London, so anything still keyed to the local 4pm shows up.
process.env.TZ = 'Europe/London';
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { expiryCloseMs, isMonthlyExp, nyDate, yearsToExp } from '../src/core/options.js';
import { calcAllocation } from '../src/core/sizing.js';
import { effectivePrice, extSession } from '../src/core/extended-hours.js';
import { parseQuickStr, quickParseHint } from '../src/core/shorthand.js';
import { aggregateBars } from '../src/core/bars.js';

const HOUR = 3600e3, YEAR = 365 * 24 * HOUR;
/** New York wall time on 2026-10-09 (EDT, UTC−4). */
const ny = (h, m = 0) => Date.UTC(2026, 9, 9, h + 4, m);
/** Run fn with Date.now pinned to ms. */
function at(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = real; }
}

test('the test process really is in London', () => {
  assert.notEqual(new Date('2026-10-09T16:00:00').getTime(), Date.UTC(2026, 9, 9, 20), 'local 4pm is not the New York close');
});

test('expiry is the 4pm New York close in EDT and EST, whatever the browser zone', () => {
  assert.equal(expiryCloseMs('2026-10-09'), Date.UTC(2026, 9, 9, 20), 'EDT: 20:00 UTC');
  assert.equal(expiryCloseMs('2026-12-18'), Date.UTC(2026, 11, 18, 21), 'EST: 21:00 UTC');
  assert.equal(expiryCloseMs('2026-03-08'), Date.UTC(2026, 2, 8, 20), 'the day DST starts');
  assert.equal(expiryCloseMs('2026-11-01'), Date.UTC(2026, 10, 1, 21), 'the day DST ends');
  assert.equal(expiryCloseMs('2026-03-28'), Date.UTC(2026, 2, 28, 20), 'London and New York on different offsets');
  assert.ok(Number.isNaN(expiryCloseMs('')) && Number.isNaN(expiryCloseMs('6/20')));
  assert.equal(at(ny(10), () => yearsToExp('2026-10-09')), 6 * HOUR / YEAR, '0DTE at 10:00 ET has six hours left');
  assert.equal(at(Date.UTC(2026, 11, 18, 15), () => yearsToExp('2026-12-18')), 6 * HOUR / YEAR, 'EST 0DTE too');
  assert.equal(at(ny(16, 30), () => yearsToExp('2026-10-09')), 0, 'after the close: nothing left');
  assert.equal(at(ny(10), () => yearsToExp('2026-10-10', 1)), Math.max(0, 30 * HOUR / YEAR - 1 / 365));
  assert.equal(at(Date.UTC(2026, 9, 10, 2), () => nyDate()), '2026-10-09', '10pm New York is still the 9th');
});

test('the simulator curve ends at the New York close', async () => {
  const h = await app({ clock: true });
  await h.advance(ny(10) - h.run('Date.now()'));
  h.run("simState = { expStr: '2026-10-09', isCall: true, K: 100, iv: 0.3 }");
  const pts = h.run('simCurve(105)');
  assert.equal(pts[0].t, ny(10));
  assert.equal(pts[pts.length - 1].t, Date.UTC(2026, 9, 9, 20));
  assert.ok(Math.abs(pts[pts.length - 1].v - 5) < 1e-9, 'intrinsic at expiry');
});

test('a typed allocation quantity always floors back to itself with existing exposure', async () => {
  // the formula allocationQtyChanged writes back
  const pctFor = (account, existing, qty, unitCost) => (existing + qty * unitCost) / account * 100;
  const repro = calcAllocation({ account: 100000, pct: pctFor(100000, 25000.5, 3, 123.45), existing: 25000.5, unitCost: 123.45 });
  assert.equal(repro.units, 3);
  let seed = 11, checked = 0;
  const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  for (let i = 0; i < 600; i++) {
    const account = +(1000 + rnd() * 5e6).toFixed(2), existing = +(rnd() * account * 0.6).toFixed(2);
    const unitCost = +(0.01 + rnd() * 2000).toFixed(i % 3 ? 2 : 4);
    for (let qty = 0; qty <= 50; qty++) {
      const pct = pctFor(account, existing, qty, unitCost);
      if (pct > 100) break;
      assert.equal(calcAllocation({ account, pct, existing, unitCost }).units, qty, `${account} ${existing} ${unitCost} ×${qty}`);
      checked++;
    }
  }
  assert.ok(checked > 10000);
  // still no material overspend: a cent short of two units is one
  assert.equal(calcAllocation({ account: 13000.01, pct: 100, existing: 0, unitCost: 6500.01 }).units, 1);
  assert.equal(calcAllocation({ account: 100000, pct: 25.37, existing: 25000.5, unitCost: 123.45 }).units, 2, '369.50 left is 2.99 units');
});

test('typing shares in allocation mode with existing exposure keeps the typed count', async () => {
  const { run, elements } = await app();
  elements.get('accountSize').value = '100000';
  elements.get('allocationPct').value = '30';
  run("quoteData = { symbol: 'TEST', last: 123.45, low: 120, high: 125 }; setSizingMode('allocation'); exposureBySymbol.TEST = 25000.5;");
  for (let qty = 1; qty <= 50; qty++) {
    run(`sharesQtyChanged({ value: '${qty}' })`);
    assert.match(elements.get('sharesStats').innerHTML, new RegExp(`value="${qty}"`), `typed ${qty}`);
  }
});

test('a Thursday is monthly only when the third Friday is an NYSE holiday', () => {
  assert.equal(isMonthlyExp('2026-10-15'), false, 'an ordinary Thursday before the third Friday');
  assert.equal(isMonthlyExp('2026-10-16'), true);
  assert.equal(isMonthlyExp('2025-04-17'), true, 'Good Friday 2025 was the third Friday');
  assert.equal(isMonthlyExp('2025-04-18'), false, 'no expiry on the holiday itself');
  assert.equal(isMonthlyExp('2022-04-14'), true, 'Good Friday 2022');
  assert.equal(isMonthlyExp('2026-04-02'), false, 'Good Friday 2026 is the first Friday');
  assert.equal(isMonthlyExp('2026-04-17'), true);
  assert.equal(isMonthlyExp('2026-06-18'), true, 'Juneteenth 2026 is the third Friday');
  assert.equal(isMonthlyExp('2026-06-19'), false);
  assert.equal(isMonthlyExp('2027-06-17'), true, 'Juneteenth 2027 is a Saturday, closed Friday the 18th');
  assert.equal(isMonthlyExp('2021-06-17'), false, 'before NYSE observed Juneteenth');
  assert.equal(isMonthlyExp('2021-06-18'), true);
  assert.equal(isMonthlyExp('2026-12-17'), false);
  assert.equal(isMonthlyExp('2026-12-18'), true);
});

test('the extended price counts only while now is in that window, from that window', () => {
  const q = { last: 100, trade_date: ny(10, 55), bid: 95, ask: 95.1, bid_date: ny(9, 20), ask_date: ny(9, 20), prevclose: 90, close: 100 };
  at(ny(11), () => {
    assert.equal(extSession(q), null, 'a 9:20 quote is stale at 11:00');
    assert.equal(effectivePrice(q), 100, 'the regular-session last wins');
  });
  at(ny(9, 25), () => {
    const pre = extSession({ ...q, trade_date: ny(9) });
    assert.equal(pre?.label, 'PRE');
    assert.equal(pre?.price, 95.05, 'the fresher quote mid over the 9:00 print');
  });
  at(ny(17), () => {
    assert.equal(extSession({ ...q, trade_date: ny(15, 59) }), null, 'at 17:00 a morning quote and the closing print are not after-hours');
    const ah = extSession({ ...q, last: 101, trade_date: ny(16, 30) });
    assert.deepEqual([ah?.label, ah?.price, ah?.chg], ['AH', 101, 1], 'an after-hours print against the close');
  });
  at(ny(2), () => assert.equal(extSession({ ...q, trade_date: ny(1) }), null, 'overnight is neither window'));
  at(ny(17), () => assert.equal(extSession({ ...q, last: 101, trade_date: ny(16, 30) - 24 * HOUR }), null, "yesterday's after-hours"));
});

test('shorthand rejects impossible dates and rolls a passed month/day to next year', () => {
  at(ny(10), () => {
    assert.equal(parseQuickStr('SPY 580 9/31'), null);
    assert.match(quickParseHint('SPY 580 9/31'), /No such date: 9\/31/);
    assert.equal(parseQuickStr('AAPL 245 2/30'), null);
    assert.match(quickParseHint('AAPL 245 2/30'), /No such date/);
    assert.equal(parseQuickStr('AAPL 245 2/29/28').expStr, '2028-02-29', 'a real leap day');
    assert.equal(parseQuickStr('AAPL 245 2/29'), null, 'Feb 2027 has no 29th');
    assert.equal(parseQuickStr('AAPL 245 1/15').expStr, '2027-01-15', 'Jan 15 passed: next year');
    assert.equal(parseQuickStr('AAPL 245 1/15').occ, 'AAPL270115C00245000');
    assert.equal(parseQuickStr('AAPL 245 10/9').expStr, '2026-10-09', 'today still counts (0DTE)');
    assert.equal(parseQuickStr('AAPL 245 12/18').expStr, '2026-12-18');
    assert.equal(parseQuickStr('9.18 300 aapl').expStr, '2027-09-18', 'dotted dates roll too');
    assert.equal(parseQuickStr('AAPL 245 10/8/26').expStr, '2026-10-08', 'an explicit year is kept');
    assert.equal(parseQuickStr('F 9.31 6/20/27').strike, 9.31, 'a dotted number that is no date is a strike');
  });
  // 10pm in New York is still the 9th there (already the 10th in London)
  at(Date.UTC(2026, 9, 10, 2), () => assert.equal(parseQuickStr('AAPL 245 10/9').expStr, '2026-10-09'));
});

test('shorthand calls an unexplained second number ambiguous, spreads still take two', () => {
  at(ny(10), () => {
    assert.equal(parseQuickStr('AAPL 245 250 6/20'), null, 'no silent $245 call');
    assert.match(quickParseHint('AAPL 245 250 6/20'), /Two strikes: add cds, pds, ccs or pcs/);
    assert.match(quickParseHint('AAPL 245c 250 6/20'), /Two strikes/);
    assert.match(quickParseHint('AAPL 105/115 6/20'), /strike pair needs cds/);
    assert.match(quickParseHint('rbrk 105/115 120 8/28 cds'), /number too many/);
    assert.equal(quickParseHint('AAPL 245 6/20'), '');
    assert.equal(quickParseHint('AAPL 245'), '', 'just incomplete');
    const debit = parseQuickStr('rbrk 105 115 8/28/27 cds');
    assert.deepEqual([debit.strike, debit.strike2, debit.optType, debit.credit], [105, 115, 'call', false]);
    const credit = parseQuickStr('rbrk 105/115 8/28/27 pcs');
    assert.deepEqual([credit.strike, credit.strike2, credit.optType, credit.credit], [115, 105, 'put', true]);
  });
});

test('the quick lookup preview and error say why shorthand cannot pin', async () => {
  const { run, elements } = await app();
  elements.get('quickInput').value = 'AAPL 245 250 6/20/27';
  run('parseQuick()');
  assert.match(elements.get('quickParsed').textContent, /Two strikes/);
  elements.get('quickInput').value = 'AAPL 245';
  run('parseQuick()');
  assert.equal(elements.get('quickParsed').textContent, '?', 'incomplete is still just ?');
  elements.get('quickInput').value = 'SPY 580 9/31/27';
  await run('fetchQuickOption()');
  assert.equal(elements.get('errorBox').textContent, 'No such date: 9/31/2027. Try: AAPL 245 6/20  or  SPY 580 put 6/20');
});

test('copying a pinned card whose stop is on the winning side states no negative risk', async () => {
  const { run } = await app();
  run(`var copied; copyPlainText = t => { copied = t; };
    pinnedData.win = { parsed: { ticker: 'TEST', strike: 100, expStr: '2099-01-16' }, isCall: true, mid: 2, stopLevel: 95, stopName: 'LOD', lossPerContract: -50 };
    copyPinned('win');`);
  assert.match(run('copied'), /no loss at this stop/);
  assert.doesNotMatch(run('copied'), /risk -|−|NaN/);
  run("pinnedData.lose = { ...pinnedData.win, lossPerContract: 50 }; copyPinned('lose');");
  assert.match(run('copied'), /risk \d+\.\d\d% of account/);
});

test('allocation refuses a contract once its 4pm New York close has passed', async () => {
  const h = await app({ clock: true });
  const card = "({ sizing: 'allocation', isCall: false, underlyingType: 'stock', rootSymbol: 'RKLB', contractSize: 100, bid: 2, ask: 2.2, mid: 2.1, parsed: { ticker: 'RKLB', strike: 65, expStr: '2026-10-09' } })";
  await h.advance(ny(15, 30) - h.run('Date.now()'));
  assert.equal(h.run(`allocationQuoteError(${card})`), '', 'before the close it sizes');
  await h.advance(ny(16, 1) - h.run('Date.now()'));
  assert.match(h.run(`allocationQuoteError(${card})`), /expired/, 'same day after 16:00 ET');
});

test('intraday buckets follow the clock from 9:30, so a missing 5m bar shifts nothing', () => {
  const bar = (t, o) => ({ t: `2026-10-09T${t}:00`, o, h: o + 1, l: o - 1, c: o + 0.5, v: 10 });
  const times = ['09:30', '09:35', /* 09:40 missing */ '09:45', '09:50', '09:55', '10:00', '10:05', '10:10'];
  const out = aggregateBars(times.map((t, i) => bar(t, 100 + i)), 15);
  assert.deepEqual(out.map(b => b.t.slice(11, 16)), ['09:30', '09:45', '10:00']);
  assert.deepEqual(out.map(b => b.v), [20, 30, 30]);
  assert.equal(out[1].o, 102, 'the 9:45 bucket opens at the 9:45 bar');
  // 65m: 9:30–10:35 then 10:35 on, and never across a session
  const day2 = ['09:30', '10:30', '10:35'].map((t, i) => ({ ...bar(t, 200 + i), t: `2026-10-12T${t}:00` }));
  const out65 = aggregateBars([...times.map((t, i) => bar(t, 100 + i)), ...day2], 65);
  assert.deepEqual(out65.map(b => b.t), ['2026-10-09T09:30:00', '2026-10-12T09:30:00', '2026-10-12T10:35:00']);
  assert.equal(out65[1].c, 201.5);
});
