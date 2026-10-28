// Run with: node --test
// Order plans (docs/schwab.md, docs/journal.md): what the Trade at Schwab sheet saves with an order (setups, entry
// tactics, the risk against the Schwab account, how the stop was set), matched to the journal trade its fills open, the
// labels it puts on that trade, and the plan in words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const json = (run, code) => JSON.parse(run(`JSON.stringify(${code})`));

const PLAN = {
  id: 'p1', account: '6789', symbol: 'AAPL', side: 'long', order_ids: ['1001'], sent_at: '2026-10-01T14:30:00.000Z',
  setups: ['ema21_bounce'], tactics: ['pivot15'], trade_key: null,
  plan: {
    qty: 100, entry_type: 'MARKET', entry: 100, stop: 97.5, planned_risk: 250, fill_risk: 252, max_loss: 250,
    account_size: 50000, account_source: 'schwab', risk_pct: 0.5, schwab_value: 52100, schwab_value_at: '2026-10-01T14:30:01.000Z',
    stop_source: 'auto', stop_strategy: 'atr', stop_amount: 0.5, stop_level: 97.71, stop_level_name: 'LOD', ext_hours: false, atr5: 0.42, stop_planned: 97.5,
  },
};
const TRADE = { key: '6789|AAPL|long|2026-10-01T14:30:01.000Z', account: '6789', symbol: 'AAPL', direction: 'long', status: 'closed', openedAt: '2026-10-01T14:30:01.000Z', entryOrderIds: ['1001'], risk: 260 };
const plan = (extra = {}, numbers = {}) => ({ ...PLAN, ...extra, plan: { ...PLAN.plan, ...numbers } });
const trade = (extra = {}) => ({ ...TRADE, ...extra });
const matched = (run, trades, plans) => json(run, `[...matchPlans(${JSON.stringify(trades)}, ${JSON.stringify(plans)})].map(([k, ps]) => [k, ps.map(p => p.id)])`);

test('a saved row is cleaned: ids as text, picks deduped and capped, numbers only where they are numbers', async () => {
  const { run } = await app();
  const row = json(run, `cleanPlanRow(${JSON.stringify({ ...PLAN, order_ids: [1001, '1001', '', 1002], setups: ['a', 'a', 7, 'b'], plan: { ...PLAN.plan, qty: '100', atr5: 'x', stop_strategy: 'wild' } })})`);
  assert.deepEqual(row.order_ids, ['1001', '1002']);
  assert.deepEqual(row.setups, ['a', 'b']);
  assert.equal(row.plan.qty, null, 'a number saved as text is not trusted');
  assert.equal(row.plan.atr5, null);
  assert.equal(row.plan.stop_strategy, null, 'only the strategies the calculator has');
  assert.equal(run(`cleanPlanRow(${JSON.stringify({ ...PLAN, side: 'up' })})`), null, 'a side is long or short');
  assert.equal(run(`cleanPlanRow(${JSON.stringify({ ...PLAN, id: '' })})`), null);
});

test('a plan finds its trade by the order that opened it, a replaced order\'s new id too, never the other side', async () => {
  const { run } = await app();
  assert.deepEqual(matched(run, [trade()], [plan()]), [[TRADE.key, ['p1']]]);
  assert.deepEqual(matched(run, [trade({ entryOrderIds: ['1002'] })], [plan({ order_ids: ['1001', '1002'] })]), [[TRADE.key, ['p1']]], 'Change limit added the new id');
  assert.deepEqual(matched(run, [trade({ direction: 'short' })], [plan()]), [], 'a reversal: the plan goes with the side it was sent for');
  assert.deepEqual(matched(run, [trade({ account: '1111' })], [plan()]), [], 'another account');
  assert.deepEqual(matched(run, [trade({ status: 'history' }), trade({ key: 'gone', deleted: true })], [plan()]), [], 'nothing before your history, nothing deleted');
});

test('adding to a position: every order\'s plan, oldest first', async () => {
  const { run } = await app();
  const add = plan({ id: 'p2', order_ids: ['1005'], sent_at: '2026-10-01T15:00:00.000Z', setups: ['other'] });
  assert.deepEqual(matched(run, [trade({ entryOrderIds: ['1001', '1005'] })], [add, plan()]), [[TRADE.key, ['p1', 'p2']]]);
});

test('a plan Schwab gave no id: the first trade on its account, symbol and side after the send, within 30 minutes for a market entry', async () => {
  const { run } = await app();
  const lost = plan({ order_ids: [] });
  const at = min => new Date(Date.parse(PLAN.sent_at) + min * 60000).toISOString();
  assert.deepEqual(matched(run, [trade({ key: 'k2', openedAt: at(2), entryOrderIds: ['9'] })], [lost]), [['k2', ['p1']]]);
  assert.deepEqual(matched(run, [trade({ key: 'k2', openedAt: at(45), entryOrderIds: ['9'] })], [lost]), [], 'a market order fills at once or not at all');
  assert.deepEqual(matched(run, [trade({ key: 'k2', openedAt: at(-5), entryOrderIds: ['9'] })], [lost]), [], 'not a trade opened before it');
  const limit = plan({ order_ids: [] }, { entry_type: 'LIMIT' });
  assert.deepEqual(matched(run, [trade({ key: 'k2', openedAt: at(200), entryOrderIds: ['9'] })], [limit]), [['k2', ['p1']]], 'a limit can wait all day');
  assert.deepEqual(matched(run, [trade({ key: 'k2', openedAt: at(24 * 60), entryOrderIds: ['9'] })], [limit]), [], 'but not into the next day');
  // two lost answers, two trades: earliest to earliest; a trade another plan found by id is not taken
  const second = plan({ id: 'p2', order_ids: [], sent_at: at(5) });
  const trades = [trade({ key: 'byId', openedAt: at(1), entryOrderIds: ['777'] }), trade({ key: 'a', openedAt: at(3), entryOrderIds: ['8'] }), trade({ key: 'b', openedAt: at(6), entryOrderIds: ['9'] })];
  assert.deepEqual(matched(run, trades, [second, lost, plan({ id: 'p3', order_ids: ['777'] })]), [['byId', ['p3']], ['a', ['p1']], ['b', ['p2']]]);
  // once applied, it stays with that trade
  assert.deepEqual(matched(run, [trade({ key: 'k9', openedAt: at(300), entryOrderIds: ['9'] })], [plan({ order_ids: [], trade_key: 'k9' })]), [['k9', ['p1']]]);
});

test('what a plan puts on its trade: the first plan\'s setups and tactics, a kind already labeled left alone', async () => {
  const { run } = await app();
  const add = plan({ id: 'p2', setups: ['other'], tactics: [] });
  assert.deepEqual(json(run, `planLabels(${JSON.stringify([plan(), add])}, [])`), [['setup', 'ema21_bounce'], ['tactic', 'pivot15']]);
  assert.deepEqual(json(run, `planLabels(${JSON.stringify([plan({ setups: [] }), add])}, [])`), [['setup', 'other'], ['tactic', 'pivot15']], 'the first plan that has any');
  assert.deepEqual(json(run, `planLabels(${JSON.stringify([plan()])}, [{ kind: 'setup', value: 'mine' }])`), [['tactic', 'pivot15']]);
});

test('the plan in words: risk as a share of the Schwab account, planned and actual, and how the stop was set', async () => {
  const { run } = await app();
  const words = (plans, t = TRADE) => json(run, `planLines(${JSON.stringify(plans)}.map(cleanPlanRow), ${JSON.stringify(t)})`);
  assert.deepEqual(words([plan()]), [
    '0.48% of Schwab ••6789 ($250.00 of $52,100) · 100 sh · stop LOD − 0.5× ATR(5m) at $97.50 (LOD $97.71, ATR(5m) $0.42)',
    'Actual risk 0.50% ($260.00)',
  ]);
  assert.equal(json(run, `planRisk(cleanPlanRow(${JSON.stringify(plan())}))`).pct.toFixed(4), '0.4798');
  assert.match(words([plan({ side: 'short' }, { stop_level_name: 'HOD', stop_strategy: 'percent', stop_amount: 0.1, stop: 102.1, stop_level: 102, ext_hours: true })], { ...TRADE, direction: 'short', risk: null })[0],
    /stop HOD \+ 0\.1% at \$102\.10 \(HOD \$102\.00, ext hours, ATR\(5m\) \$0\.42\)$/);
  assert.match(words([plan({}, { stop_source: 'custom', stop_strategy: 'none' })])[0], /stop Custom stop at \$97\.50 \(LOD \$97\.71, ATR\(5m\) \$0\.42\)/);
  assert.match(words([plan({}, { stop_source: 'orb', orb_minutes: 15 })])[0], /stop 15m range low at \$97\.50/);
  assert.match(words([plan({}, { schwab_value: null })])[0], /^\$250\.00 planned, no Schwab account value/);
  assert.match(words([plan({}, { edits: [{ at: '2026-10-01T14:40:00.000Z', order_id: '1002', qty: 80 }] })])[0], / · edited to 80 sh/);
  const two = words([plan(), plan({ id: 'p2' }, { planned_risk: 100, qty: 40 })]);
  assert.equal(two.length, 3);
  assert.match(two[1], /^Add: 0\.19% of Schwab/);
  assert.equal(two[2], 'Planned 0.67% ($350.00) · actual risk 0.50% ($260.00)');
});

test('the plans are kept in their own table, and the journal Claude reads includes them', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const sql = readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => readFileSync(new URL(f, dir), 'utf8')).join('\n').replace(/--[^\n]*/g, '');
  assert.match(sql, /create table if not exists public\.order_plans/);
  const reads = [...sql.matchAll(/create or replace function public\.claude_journal_read\(p_key text\)[\s\S]*?end \$\$;/gi)];
  assert.match(reads[reads.length - 1][0], /'order_plans', coalesce\(\(select jsonb_agg\([\s\S]*from public\.order_plans p where p\.user_id = uid/, 'the latest definition wins');
});
