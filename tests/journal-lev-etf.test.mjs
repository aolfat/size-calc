// Run with: node --test
// A leveraged or inverse ETF's trade is a bet on its underlying: long SQQQ is short QQQ, so its side, setup words and
// charts read on QQQ. The built-in list knows most funds; yours (journal_funds, synced) set any ticker, for every trade in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const json = (run, code) => JSON.parse(run(`JSON.stringify(${code})`));
const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const TODAY = Date.parse('2026-10-16T18:00:00Z');

/** 100 shares bought 10/1 10:30 ET at 20, sold 10/2 at 21 */
const order = (id, symbol, assetType = 'COLLECTIVE_INVESTMENT') => ({
  kind: 'order', record_id: String(id), account: '6789', entered_at: '2026-10-01T14:30:00Z',
  data: {
    orderId: id, enteredTime: '2026-10-01T14:30:00+0000', status: 'FILLED',
    orderLegCollection: [{ legId: 1, instruction: 'BUY', quantity: 100, instrument: { symbol, assetType } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: id * 10, executionLegs: [{ legId: 1, quantity: 100, price: 20, time: '2026-10-01T14:30:01+0000' }] }],
    childOrderStrategies: [{
      orderId: id + 1, status: 'FILLED', orderType: 'LIMIT',
      orderLegCollection: [{ legId: 1, instruction: 'SELL', quantity: 100, instrument: { symbol, assetType } }],
      orderActivityCollection: [{ activityType: 'EXECUTION', activityId: id * 10 + 1, executionLegs: [{ legId: 1, quantity: 100, price: 21, time: '2026-10-02T15:00:00+0000' }] }],
    }],
  },
});
const KEY = '6789|SQQQ|long|2026-10-01T14:30:01.000Z';

test('long SQQQ is short QQQ, long TQQQ long QQQ, NVDL long NVDA: the built-in list; plain stocks stay as they are', async () => {
  const { run } = await app();
  const records = [order(501, 'SQQQ'), order(601, 'TQQQ'), order(701, 'AAPL', 'EQUITY'), order(801, 'NVDL')];
  const trades = (funds = {}) => json(run, `journalTrades(fillsFrom(${JSON.stringify(records)}), ${JSON.stringify(records)}, {}, { now: ${TODAY}, funds: ${JSON.stringify(funds)} })`);
  const by = (list, s) => list.find(t => t.symbol === s);
  const all = trades();
  assert.deepEqual([by(all, 'SQQQ').bias, by(all, 'SQQQ').setupOn, by(all, 'SQQQ').setupLev], ['short', 'QQQ', -3]);
  assert.equal(by(all, 'SQQQ').direction, 'long', 'the P&L and stop math stay on what was bought');
  assert.equal(by(all, 'SQQQ').pnl, 100);
  assert.deepEqual([by(all, 'TQQQ').bias, by(all, 'TQQQ').setupOn], ['long', 'QQQ']);
  assert.deepEqual([by(all, 'NVDL').bias, by(all, 'NVDL').setupOn], ['long', 'NVDA'], 'single-stock funds too');
  assert.deepEqual([by(all, 'AAPL').bias, by(all, 'AAPL').setupOn], ['long', null]);
  const mine = trades({ SQQQ: '', AAPL: '-SPY', TQQQ: 'NDX' });
  assert.deepEqual([by(mine, 'SQQQ').bias, by(mine, 'SQQQ').setupOn], ['long', null], 'yours keeps it on itself');
  assert.deepEqual([by(mine, 'AAPL').bias, by(mine, 'AAPL').setupOn, by(mine, 'AAPL').setupLev], ['short', 'SPY', -1], 'any ticker, inverse');
  assert.deepEqual([by(mine, 'TQQQ').setupOn, by(mine, 'TQQQ').setupLev], ['NDX', 1], 'yours over the list');
  assert.equal(run(`tradeSide(${JSON.stringify(by(all, 'SQQQ'))})`), 'short', 'its setups read in short words');
  assert.equal(run(`tradeUnderlying(${JSON.stringify(by(all, 'SQQQ'))})`), 'QQQ', 'a QQQ focus ticker counts as traded');
  assert.deepEqual(json(run, `tradeBarSymbols(${JSON.stringify(by(all, 'SQQQ'))})`), ['QQQ', 'SQQQ'], 'both kept; the fund last, the one features compare');
  assert.deepEqual(json(run, `tradeBarSymbols(${JSON.stringify(by(mine, 'SQQQ'))})`), ['SQQQ']);
  assert.equal(run("JSON.stringify(fundOf({ symbol: 'SQQQ  261120P00070000', assetType: 'OPTION' }))"), 'null', 'options on a fund stay on the fund');
});

test('your funds: kept clean, and only what differs from the list', async () => {
  const { run } = await app();
  assert.deepEqual(json(run, `parseFunds('{"NVDX":"NVDA","XYZS":"-XYZ","SQQQ":"","bad":"X","AAPL":"AAPL","MSFT":3}')`), { NVDX: 'NVDA', XYZS: '-XYZ', SQQQ: '' });
  assert.deepEqual(json(run, "parseFunds('not json')"), {});
  assert.deepEqual(json(run, "withFund({}, 'SQQQ', 'QQQ', true)"), {}, 'what the list says already');
  assert.deepEqual(json(run, "withFund({}, 'SQQQ', 'QQQ', false)"), { SQQQ: 'QQQ' });
  assert.deepEqual(json(run, "withFund({}, 'SQQQ', '')"), { SQQQ: '' }, 'a listed fund kept on itself');
  assert.deepEqual(json(run, "withFund({ AAPL: 'SPY' }, 'AAPL', '')"), {}, 'an unlisted ticker on itself needs nothing');
  assert.deepEqual(json(run, "withFund({ SQQQ: '' }, 'SQQQ', null)"), {}, 'back to the list');
  assert.deepEqual(json(run, "withFund({}, 'XYZS', 'XYZ', true)"), { XYZS: '-XYZ' });
});

const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

async function page(t, symbol = 'SQQQ') {
  // canvases can't read CSS variables, so the colors come from the stylesheet: here, each variable's own name
  globalThis.getComputedStyle = () => ({ getPropertyValue: n => n });
  t.after(() => { delete globalThis.getComputedStyle; });
  const supabase = fakeRecords([order(501, symbol)]);
  supabase.bars.set('user-1:QQQ:2026-10-01', { user_id: 'user-1', symbol: 'QQQ', day: '2026-10-01', bars: [['10:30', 481, 482, 480, 480.5, 1]] });
  const a = await app({ supabase, session: SESSION, clock: true, now: TODAY });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  a.run(`openJournalTrade('6789|${symbol}|long|2026-10-01T14:30:01.000Z')`);
  await settle();
  return { ...a, supabase, head: () => a.elements.get('jtHead').innerHTML, body: () => a.elements.get('jtBody').innerHTML };
}

test('the trade page: short QQQ, QQQ\'s charts beside SQQQ\'s, and the SQQQ chip keeps every SQQQ trade on SQQQ', async t => {
  const { run, head, body, elements, state, storage } = await page(t);
  assert.match(head(), /Short QQQ · 100 · /);
  assert.match(body(), /Setup on <span class="jr-sub">SQQQ is −3x QQQ<\/span>/);
  assert.match(body(), /aria-pressed="true" data-action="setFundOn" data-arg="QQQ">QQQ</);
  assert.match(body(), /aria-pressed="false" data-action="setFundOn" data-arg="SQQQ">SQQQ</);
  assert.doesNotMatch(body(), /Setup on another ticker/, 'a fund has its row');
  assert.equal(elements.get('jtWrapU').style.display, '', 'QQQ\'s 5 minutes beside the trade\'s');
  assert.equal(state.journalTrade.under[0].close, 480.5, 'QQQ\'s saved bars are read');
  run("setFundOn(journalPageTrade(), 'SQQQ')");
  assert.equal(storage.get('journal_funds'), '{"SQQQ":""}');
  assert.match(head(), /Long 100 · /);
  assert.match(body(), /SQQQ on itself/);
  assert.equal(elements.get('jtWrapU').style.display, 'none', 'on the fund: its own charts only');
  run("setFundOn(journalPageTrade(), 'QQQ')");
  assert.equal(storage.get('journal_funds'), '{}', 'back to the list');
  assert.match(head(), /Short QQQ · 100 · /);
  await settle();
});

test('a ticker the list doesn\'t know: Setup on another ticker, typed in, inverse, for every trade in it', async t => {
  const { run, head, body, elements, storage } = await page(t, 'XYZS');
  assert.doesNotMatch(body(), /Setup on <span/, 'no row until you ask');
  assert.match(body(), /data-action="editFund"[^>]*>Setup on another ticker</);
  run('editFund(journalPageTrade())');
  assert.match(body(), /id="fundInput"/);
  assert.match(body(), /aria-pressed="true" data-action="setFundInverse" data-arg="0">Moves with it/);
  elements.get('fundInput').value = 'qqq';
  run("setFundInverse(journalPageTrade(), '1')");
  assert.equal(elements.get('fundInput').value, 'qqq', 'what\'s typed stays');
  run('saveFund(journalPageTrade())');
  assert.equal(storage.get('journal_funds'), '{"XYZS":"-QQQ"}');
  assert.match(head(), /Short QQQ · 100 · /);
  assert.match(body(), /XYZS is QQQ inverse, set by you/);
  assert.match(elements.get('errorBox').textContent, /Every XYZS trade reads on QQQ, inverse\./);
  run('editFund(journalPageTrade())');
  elements.get('fundInput').value = '';
  run('saveFund(journalPageTrade())');
  assert.equal(storage.get('journal_funds'), '{}', 'blank: on itself again');
  assert.match(body(), /Setup on another ticker/);
  await settle();
});
