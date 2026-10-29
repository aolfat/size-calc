// Run with: node --test
// A leveraged or inverse ETF's trade is a bet on its underlying: long SQQQ is short QQQ, so its side, setup words and
// charts read on QQQ, unless the trade's Setup on switch keeps it on the fund (trade_reviews.setup_on).
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

test('long SQQQ is short QQQ; long TQQQ long QQQ; your own symbol keeps it on the fund; plain stocks stay as they are', async () => {
  const { run } = await app();
  const records = [order(501, 'SQQQ'), order(601, 'TQQQ'), order(701, 'AAPL', 'EQUITY')];
  const trades = reviews => json(run, `journalTrades(fillsFrom(${JSON.stringify(records)}), ${JSON.stringify(records)}, ${JSON.stringify(reviews)}, { now: ${TODAY} })`);
  const by = (list, s) => list.find(t => t.symbol === s);
  const all = trades({});
  assert.deepEqual([by(all, 'SQQQ').bias, by(all, 'SQQQ').setupOn, by(all, 'SQQQ').setupLev], ['short', 'QQQ', -3]);
  assert.equal(by(all, 'SQQQ').direction, 'long', 'the P&L and stop math stay on what was bought');
  assert.equal(by(all, 'SQQQ').pnl, 100);
  assert.deepEqual([by(all, 'TQQQ').bias, by(all, 'TQQQ').setupOn], ['long', 'QQQ']);
  assert.deepEqual([by(all, 'AAPL').bias, by(all, 'AAPL').setupOn], ['long', null]);
  const kept = trades({ [KEY]: { stop: null, deleted: false, setupOn: 'SQQQ' } });
  assert.deepEqual([by(kept, 'SQQQ').bias, by(kept, 'SQQQ').setupOn], ['long', null], 'on the fund: a long');
  assert.equal(run(`tradeSide(${JSON.stringify(by(all, 'SQQQ'))})`), 'short', 'its setups read in short words');
  assert.equal(run(`tradeUnderlying(${JSON.stringify(by(all, 'SQQQ'))})`), 'QQQ', 'a QQQ focus ticker counts as traded');
  assert.deepEqual(json(run, `tradeBarSymbols(${JSON.stringify(by(all, 'SQQQ'))})`), ['QQQ', 'SQQQ'], 'both kept; the fund last, the one features compare');
  assert.deepEqual(json(run, `tradeBarSymbols(${JSON.stringify(by(kept, 'SQQQ'))})`), ['SQQQ']);
  assert.equal(run("levFundOf({ symbol: 'SQQQ  261120P00070000', assetType: 'OPTION' })"), null, 'options on a fund stay on the fund');
});

const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

async function page(t, tweak) {
  // canvases can't read CSS variables, so the colors come from the stylesheet: here, each variable's own name
  globalThis.getComputedStyle = () => ({ getPropertyValue: n => n });
  t.after(() => { delete globalThis.getComputedStyle; });
  const supabase = fakeRecords([order(501, 'SQQQ')]);
  supabase.bars.set('user-1:QQQ:2026-10-01', { user_id: 'user-1', symbol: 'QQQ', day: '2026-10-01', bars: [['10:30', 481, 482, 480, 480.5, 1]] });
  tweak?.(supabase);
  const a = await app({ supabase, session: SESSION, clock: true, now: TODAY });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  a.run(`openJournalTrade('${KEY}')`);
  await settle();
  return { ...a, supabase, head: () => a.elements.get('jtHead').innerHTML, body: () => a.elements.get('jtBody').innerHTML };
}

test('the trade page: short QQQ, QQQ\'s charts beside SQQQ\'s, and Setup on keeps it on SQQQ', async t => {
  const { run, head, body, supabase, elements, state } = await page(t);
  assert.match(head(), /Short QQQ · 100 · /);
  assert.match(body(), /Setup on <span class="jr-sub">SQQQ is −3x QQQ<\/span>/);
  assert.match(body(), /aria-pressed="true" data-action="setSetupOn" data-arg="QQQ">QQQ</);
  assert.match(body(), /aria-pressed="false" data-action="setSetupOn" data-arg="SQQQ">SQQQ</);
  assert.equal(elements.get('jtWrapU').style.display, '', 'QQQ\'s 5 minutes beside the trade\'s');
  assert.equal(state.journalTrade.under.length, 1, 'QQQ\'s saved bars are read');
  assert.equal(state.journalTrade.under[0].close, 480.5);
  await run("setSetupOn(journalPageTrade(), 'SQQQ')");
  assert.equal(supabase.writes.filter(w => w.table === 'trade_reviews').pop().setup_on, 'SQQQ');
  assert.match(head(), /Long 100 · /);
  assert.equal(elements.get('jtWrapU').style.display, 'none', 'on the fund: its own charts only');
  assert.equal(state.journalTrade.key, KEY);
  await run("setSetupOn(journalPageTrade(), 'QQQ')");
  assert.equal(supabase.writes.filter(w => w.table === 'trade_reviews').pop().setup_on, null, 'back to the default');
  assert.match(head(), /Short QQQ · 100 · /);
  await settle();
});

test('before the migration: every fund trade reads on its underlying, and the switch says what to push', async t => {
  const { run, head, elements } = await page(t, s => s.failColumn('trade_reviews', 'setup_on'));
  assert.match(head(), /Short QQQ · 100 · /, 'the trades still load');
  await run("setSetupOn(journalPageTrade(), 'SQQQ')");
  assert.match(elements.get('errorBox').textContent, /Couldn't save: the database doesn't have the setup on column yet: npx supabase db push/);
  assert.match(head(), /Short QQQ · 100 · /, 'back as it was');
  await settle();
});
