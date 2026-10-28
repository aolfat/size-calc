// Run with: node --test
// Claude access (docs/claude-access.md): keys in Settings (made in the browser, only the hash saved, shown once, revoked),
// the journal a Claude session reads (the app's own trades from claude_journal_read's answer), a review turned into
// claude_journal_save's changes (names matched or added, the day's market or the trade's, reviewed_at), and the script.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';
import { findItem, findTrades, handleOf, journalFrom, planReview, tradeBy, tradeDetail, tradeLine } from '../scripts/journal-lib.mjs';

const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
const sha = s => createHash('sha256').update(s).digest('hex');

test('Settings: Claude access shows signed in; Make key saves only its hash and shows it once; Copy; Revoke', async () => {
  const out = await app();
  out.run('setCloudUi("")');
  assert.equal(out.elements.get('claudeSection').style.display, 'none', 'signed out: no section');

  const supabase = fakeRecords();
  const { run, elements } = await app({ supabase, session: SESSION });
  run("openSheet('settings')");
  await settle();
  assert.equal(elements.get('claudeSection').style.display, '');
  assert.match(elements.get('claudeKeys').innerHTML, /data-action="makeClaudeKey"/);
  assert.doesNotMatch(elements.get('claudeKeys').innerHTML, /Revoke/, 'no keys yet');

  await run('makeClaudeAccessKey()');
  const key = run('claudeNewKey');
  assert.match(key, /^scj_[A-Za-z0-9_-]{43}$/);
  const rows = [...supabase.tables.claude_keys.values()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key_hash, sha(key), 'the hash the database checks against');
  assert.ok(!JSON.stringify(rows).includes(key), 'the key itself is never sent');
  const html = elements.get('claudeKeys').innerHTML;
  assert.ok(html.includes(key) && /Shown once/.test(html) && /Revoke/.test(html) && /not used yet/.test(html));

  run('var copied, shown; copyPlainText = (t, s) => { copied = t; shown = s; }; copyClaudeKey()');
  assert.equal(run('copied'), key);
  assert.equal(run('shown'), 'your Claude key', "the toast doesn't repeat the key");

  run('closeSheet()');
  assert.equal(run('claudeNewKey'), '');
  assert.ok(!elements.get('claudeKeys').innerHTML.includes(key), 'gone from the page once the sheet closes');

  await run(`revokeClaudeAccessKey('${rows[0].id}')`);
  assert.equal(supabase.tables.claude_keys.size, 0);
  assert.doesNotMatch(elements.get('claudeKeys').innerHTML, /Revoke/);
});

test("Settings: a database without Claude keys says so and keeps the rest working", async () => {
  const supabase = fakeRecords();
  supabase.failTable('claude_keys');
  const { run, elements } = await app({ supabase, session: SESSION });
  run("openSheet('settings')");
  await settle();
  assert.match(elements.get('claudeKeys').innerHTML, /npx supabase db push/);
});

// ---------- the journal a Claude session reads ----------

const PUT = 'QQQ   261023P00706000';
const order = (id, instruction, price, time) => ({
  kind: 'order', record_id: String(id), account: '6789', entered_at: time,
  data: {
    orderId: id, enteredTime: time, status: 'FILLED',
    orderLegCollection: [{ legId: 1, instruction, quantity: 1, instrument: { symbol: PUT, assetType: 'OPTION' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: id * 10, executionLegs: [{ legId: 1, quantity: 1, price, time }] }],
  },
});
const DATA = {
  records: [order(902, 'SELL_TO_CLOSE', 1.80, '2026-10-23T19:50:00+0000'), order(901, 'BUY_TO_OPEN', 1.69, '2026-10-23T17:40:00+0000')],
  trades: [], reviews: [], labels: [], days: [], library: [],
};
const KEY = `6789|${PUT}|long|2026-10-23T17:40:00.000Z`;
const QQQ_REVIEW = {
  market: 'Bearish', sector: 'N/A', setups: ['Lotto'], tactics: ['No trigger'], mistakes: ["Didn't take the stop"],
  grade: 'D', plan: 'Partly',
  entryNote: 'Lotto on Nasdaq weakness, 2 days after the daily pennant broke down. Exit if it loses VWAP.',
  exitNote: 'Said I would exit on losing VWAP, relabeled it a lotto and held. Took +0.11 on luck, not the plan.',
};
let ids = 0;
const opts = { now: () => '2026-10-24T18:00:00.000Z', newId: () => `00000000-0000-4000-8000-00000000000${++ids}` };

test('the read made into the app\'s trades: the same key, a short handle, a line and the whole trade', () => {
  const j = journalFrom(DATA, { now: Date.parse('2026-10-24T18:00:00Z') });
  assert.equal(j.trades.length, 1);
  const t = j.trades[0];
  assert.equal(t.key, KEY);
  assert.equal(t.bias, 'short', 'a long put is a bet against the stock');
  assert.match(handleOf(KEY), /^t[0-9a-f]{7}$/);
  assert.equal(tradeBy(j, handleOf(KEY)), t);
  assert.equal(tradeBy(j, KEY), t);
  assert.deepEqual(findTrades(j, { symbol: 'qqq', day: '2026-10-23' }), [t]);
  assert.deepEqual(findTrades(j, { symbol: 'SPY' }), []);
  assert.deepEqual(findTrades(j, { todo: true }), [t]);
  assert.match(tradeLine(j, t), /QQQ 10\/23\/26 706P · short · 1 · 1\.69 → 1\.80 · \$11\.00 · 2026-10-23 13:40 ET · missing market/);
  const detail = tradeDetail(j, t);
  assert.match(detail, /Buy to open 1 QQQ 10\/23\/26 706P @ 1\.69/);
  assert.match(detail, /Sell to close 1 QQQ 10\/23\/26 706P @ 1\.80/);
  assert.match(detail, /missing: market, sector, setup, tactic, setup grade, plan followed, exit note/);
});

test('the whole trade includes the plan kept with its order, for analysis', () => {
  const plan = { id: 'p1', account: '6789', symbol: 'QQQ', side: 'long', order_ids: ['901'], sent_at: '2026-10-23T17:40:00.000Z', setups: [], tactics: [], trade_key: null,
    plan: { qty: 1, planned_risk: 169, schwab_value: 50000, stop_source: 'custom', stop: 0 } };
  const j = journalFrom({ ...DATA, order_plans: [plan] });
  assert.match(tradeDetail(j, j.trades[0]), /\norder plan:\n  0\.34% of Schwab ••6789 \(\$169\.00 of \$50,000\) · 1 sh · stop Custom stop at \$0\.00/);
  assert.doesNotMatch(tradeDetail(journalFrom(DATA), journalFrom(DATA).trades[0]), /order plan/, 'none kept, none shown');
});

test('a review becomes the changes the trade page would make: names matched, new ones added, the day\'s market, reviewed_at', () => {
  ids = 0;
  const j = journalFrom(DATA);
  const plan = planReview(j, j.trades[0], QQQ_REVIEW, opts);
  const c = plan.changes;
  assert.deepEqual(c.library.map(r => [r.kind, r.name, r.settings]), [
    ['pattern', 'Lotto', {}],
    ['setup', 'Lotto', { pattern: 'mine:00000000-0000-4000-8000-000000000001' }],
    ['tactic', 'No trigger', {}],
  ], 'a setup that isn\'t one becomes a pattern and the setup made of it, as + New setup does');
  assert.deepEqual(c.labels_add.map(l => [l.kind, l.value]), [
    ['sector', 'na'], ['setup', 'mine:00000000-0000-4000-8000-000000000002'], ['tactic', 'mine:00000000-0000-4000-8000-000000000003'], ['mistake', 'skipped_stop'],
  ], "the defaults by their names (N/A, Didn't take the stop)");
  assert.deepEqual(c.labels_remove, []);
  assert.deepEqual(c.days, [{ day: '2026-10-23', market: 'bearish' }], 'the market goes on the day, as the trade page does');
  assert.deepEqual(c.reviews, [{ trade_key: KEY, fields: {
    setup_grade: 'D', plan_followed: 'partly', entry_note: QQQ_REVIEW.entryNote, note: QQQ_REVIEW.exitNote, reviewed_at: '2026-10-24T18:00:00.000Z',
  } }], 'everything a review needs is in, so it\'s stamped reviewed');
  assert.equal(plan.after.reviewed, true);
  assert.ok(plan.said.some(s => /New setup in My setups: Lotto/.test(s)));
});

test('a review again: kinds named are set exactly, the rest stay; a day with another market makes it the trade\'s own', () => {
  ids = 0;
  const lib = [
    { id: 'p1', kind: 'pattern', name: 'Lotto', settings: {} },
    { id: 's1', kind: 'setup', name: 'Lotto', settings: { pattern: 'mine:p1' } },
  ];
  const data = {
    ...DATA, library: lib, days: [{ day: '2026-10-23', market: 'choppy' }],
    labels: [{ trade_key: KEY, kind: 'setup', value: 'flag_breakout' }, { trade_key: KEY, kind: 'mistake', value: 'chased' }, { trade_key: KEY, kind: 'tag', value: 'option_flow' }],
    reviews: [{ trade_key: KEY, setup_grade: 'C' }],
  };
  const j = journalFrom(data);
  const t = j.trades[0];
  assert.equal(findItem(j.lib, 'setup', 'pennant or flag breakdown')?.key, 'flag_breakout', 'a setup by its short side\'s words');
  const c = planReview(j, t, { setups: 'lotto', mistakes: [], market: 'bearish' }, opts).changes;
  assert.deepEqual(c.library, [], 'Lotto is already yours');
  assert.deepEqual(c.labels_remove.map(l => l.value), ['flag_breakout', 'chased']);
  assert.deepEqual(c.labels_add.map(l => l.value), ['mine:s1']);
  assert.deepEqual(c.days, [], "the day's market stays");
  assert.deepEqual(c.reviews, [{ trade_key: KEY, fields: { market: 'bearish' } }], 'this trade\'s own; the tag and grade untouched');
  const day = planReview(j, t, { market: 'bearish', marketFor: 'day' }, opts).changes;
  assert.deepEqual(day.days, [{ day: '2026-10-23', market: 'bearish' }], 'unless it says the day');
  assert.deepEqual(planReview(j, t, { grade: 'C' }, opts).changes.reviews, [], 'the same grade changes nothing');
});

test('a review that can\'t be: an unknown field, a grade or plan not on the list, two sectors', () => {
  const j = journalFrom(DATA), t = j.trades[0];
  assert.throws(() => planReview(j, t, { setup: 'Lotto' }), /not setup/);
  assert.throws(() => planReview(j, t, { grade: 'A+' }), /grade: A, B, C, D, F/);
  assert.throws(() => planReview(j, t, { plan: 'mostly' }), /plan: yes, partly or no/);
  assert.throws(() => planReview(j, t, { sector: ['Strong', 'Weak'] }), /one sector per trade/);
  assert.throws(() => planReview(j, t, { stop: -1 }), /stop/);
});

// ---------- the script ----------

const SCRIPT = fileURLToPath(new URL('../scripts/journal.mjs', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./helpers/journal-fetch.mjs', import.meta.url));
function script(args, { key = 'scj_test_key_0123456789abcdefghijklmnop', data = DATA } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'journal-')), 'fake.json');
  writeFileSync(file, JSON.stringify({ key: 'scj_test_key_0123456789abcdefghijklmnop', data }));
  const env = { ...process.env, FAKE_JOURNAL: file, JOURNAL_KEY: key };
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'NODE_USE_ENV_PROXY']) delete env[k];
  const r = spawnSync(process.execPath, ['--import', PRELOAD, SCRIPT, ...args], { env, encoding: 'utf8' });
  return { ...r, saves: JSON.parse(readFileSync(file, 'utf8')).saves || [] };
}

test('the script: lists and shows trades, saves a review, a dry run saves nothing, a wrong key is refused', () => {
  const list = script(['trades', '--symbol', 'QQQ']);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, new RegExp(`^${handleOf(KEY)} · QQQ 10/23/26 706P`));
  const show = script(['show', handleOf(KEY)]);
  assert.match(show.stdout, /key: 6789\|QQQ {3}261023P00706000\|long/);

  const dry = script(['review', handleOf(KEY), JSON.stringify(QQQ_REVIEW), '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(dry.saves, []);
  assert.match(dry.stdout, /"labels_add"/);

  const saved = script(['review', handleOf(KEY), JSON.stringify(QQQ_REVIEW)]);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(saved.saves.length, 1);
  assert.deepEqual(saved.saves[0].days, [{ day: '2026-10-23', market: 'bearish' }]);
  assert.match(saved.stdout, /^Saved\./m);

  const bad = script(['trades'], { key: 'scj_someone_elses_key_0123456789abcdefgh' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /refused the key/);
  const none = script(['trades'], { key: '' });
  assert.match(none.stderr, /No JOURNAL_KEY/);
  const unknown = script(['show', 'tnothere']);
  assert.match(unknown.stderr, /No trade tnothere/);
});
