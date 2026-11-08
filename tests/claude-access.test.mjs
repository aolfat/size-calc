// Run with: node --test
// Claude access (docs/claude-access.md): keys in Settings (made in the browser, only the hash saved, shown once, revoked),
// the journal a Claude session reads (the app's own trades from claude_journal_read's answer), a review turned into
// claude_journal_save's changes (names matched or added, the day's market or the trade's, reviewed_at), each trade's
// result beside its feature stamps (claude_features_read), and the script.
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
import { dayDetail, FEATURE_TABLE_COLUMNS, featureCoverageText, featureTable, findItem, findTrades, handleOf, journalFrom, periodDetail, planDay, planDetail, planPeriod, planPremarket, planReview, stampsFrom, toCsv, tradeBy, tradeDetail, tradeLine } from '../scripts/journal-lib.mjs';
import { FEATURES, featureVersion } from '../src/core/features/index.js';

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

// ---------- the day's review (the notebook's post-market half) ----------

const RULES = [
  { id: 'r1', kind: 'rule', name: 'Follow your stops', settings: { order: 1, since: '2026-10-20' } },
  { id: 'r2', kind: 'rule', name: 'do not oversize', settings: { order: 2, since: '2026-10-20' } },
  { id: 'r3', kind: 'rule', name: 'Made later', settings: { order: 3, since: '2026-10-26' } },
  { id: 'r4', kind: 'rule', name: 'Retired', hidden: true, settings: { order: 4, since: '2026-10-20' } },
];
const DAY = '2026-10-23';
const DAY_DATA = { ...DATA, library: RULES, days: [{ day: DAY, market: 'bearish' }] };
const DAY_REVIEW = {
  grade: 'd', rules: { 'follow your stops': 'Broke', 'mine:r2': 'kept' },
  wentWell: 'Cut the loser at -1R.', workOn: 'Moved a stop after 3pm.', focusNext: 'Name the setup before every order.',
};

test("a day's review becomes the notebook's changes: rules by name or key, only the ones that apply, reviewed_at", () => {
  const j = journalFrom(DAY_DATA);
  const plan = planDay(j, DAY, DAY_REVIEW, opts);
  assert.deepEqual(plan.changes.notebook, [{ day: DAY, fields: {
    grade: 'D', rules: { 'mine:r1': 'broke', 'mine:r2': 'kept' }, went_well: DAY_REVIEW.wentWell, work_on: DAY_REVIEW.workOn,
    focus_next: DAY_REVIEW.focusNext, reviewed_at: '2026-10-24T18:00:00.000Z',
  } }], 'a grade, every rule that applies and a guided note: reviewed');
  assert.deepEqual([plan.changes.library, plan.changes.reviews, plan.changes.labels_add, plan.changes.labels_remove, plan.changes.days], [[], [], [], [], []]);
  assert.equal(plan.after.reviewed, true);
  assert.equal(planDay(j, DAY, { grade: 'D' }, opts).after.reviewed, false, 'a grade alone is not a review');
});

test("a day's review again: only what changed is sent, null clears a rule and the reviewed stamp with it", () => {
  const reviewed = { day: DAY, market: 'bearish', grade: 'D', rules: { 'mine:r1': 'broke', 'mine:r2': 'kept' }, went_well: 'Cut the loser.', reviewed_at: '2026-10-23T21:00:00.000Z' };
  const j = journalFrom({ ...DAY_DATA, days: [reviewed] });
  assert.deepEqual(planDay(j, DAY, { grade: 'D', rules: { 'Follow your stops': 'broke' } }, opts).changes.notebook, [], 'the same answers change nothing');
  assert.deepEqual(planDay(j, DAY, { rules: { 'do not oversize': 'broke' }, note: 'More.' }, opts).changes.notebook,
    [{ day: DAY, fields: { rules: { 'mine:r2': 'broke' }, note: 'More.' } }]);
  assert.deepEqual(planDay(j, DAY, { rules: { 'Follow your stops': null } }, opts).changes.notebook,
    [{ day: DAY, fields: { rules: { 'mine:r1': null }, reviewed_at: null } }], 'a rule unanswered: no longer reviewed');
  assert.deepEqual(planDay(j, DAY, { wentWell: null }, opts).changes.notebook,
    [{ day: DAY, fields: { went_well: null, reviewed_at: null } }]);
});

test("a day's review that can't be: an unknown field, a rule that isn't the day's, an answer or grade not on the list, a bad day", () => {
  const j = journalFrom(DAY_DATA);
  assert.throws(() => planDay(j, DAY, { plan: 'yes' }), /not plan/);
  assert.throws(() => planDay(j, DAY, { rules: { 'Made later': 'kept' } }), /Made later isn't one of 2026-10-23's rules: Follow your stops, do not oversize/);
  assert.throws(() => planDay(j, DAY, { rules: { Retired: 'kept' } }), /isn't one of/, 'retired before the day was answered');
  assert.throws(() => planDay(j, DAY, { rules: { 'Follow your stops': 'mostly' } }), /kept or broke/);
  assert.throws(() => planDay(j, DAY, { rules: ['Follow your stops'] }), /rules: an object/);
  assert.throws(() => planDay(j, DAY, { grade: 'A+' }), /grade: A, B, C, D, F/);
  assert.throws(() => planDay(j, DAY, { focusKept: 'mostly' }), /focusKept: yes, partly or no/);
  assert.throws(() => planDay(j, DAY, { focusNext: 'x'.repeat(501) }), /focusNext: 500 characters at most/);
  assert.throws(() => planDay(j, '2026-13-01', { grade: 'B' }), /a day as YYYY-MM-DD/);
});

test("the whole day: its market, P&L, trades and the review in words, with what's missing", () => {
  const j = journalFrom({ ...DAY_DATA, days: [{ day: DAY, market: 'bearish', rules: { 'mine:r1': 'broke' } }] });
  const text = dayDetail(j, DAY);
  assert.match(text, /^2026-10-23 \(Fri\)\nmarket: Bearish\nP&L: \$11\.00 · 1 trade with an exit/);
  assert.match(text, new RegExp(`\\n  ${handleOf(KEY)} · QQQ 10/23/26 706P`));
  assert.match(text, /\n    Follow your stops: broke\n    do not oversize: —\n/);
  assert.doesNotMatch(text, /Made later|Retired/, 'rules that never applied to the day');
  assert.match(text, /missing: a grade, 1 rule and what went well or what to work on$/);
});

// ---------- the day's plan (the notebook's premarket half: the plan and the focus list) ----------

const NEXT = '2026-10-26';
const SETUPS = [{ id: 's1', kind: 'pattern', name: 'EMA 21 bounce' }, { id: 's2', kind: 'setup', name: 'EMA 21 bounce', settings: { pattern: 'mine:s1' } }];
const FOCUS_KEPT_ROW = { id: 'f1', symbol: 'AMD', side: 'short', setups: [], note: 'Under 150.', played: 'worked', review: 'Clean fade.' };
const PLAN_DATA = { ...DATA, library: [...RULES, ...SETUPS], days: [{ day: NEXT, focus_list: [FOCUS_KEPT_ROW] }] };

test("a day's plan becomes the notebook's changes: the plan text, tickers added or changed by symbol, setups matched or added", () => {
  const j = journalFrom(PLAN_DATA);
  const p = planPremarket(j, NEXT, {
    plan: '  Trade only the open drive. ',
    focus: { nvda: { side: 'Long', setups: ['ema 21 bounce'], note: 'Reclaim of 180, stop under the LOD.' }, AMD: { note: 'Under 148 now.' }, TSLA: { setups: ['Gap fill'] } },
  }, opts);
  const [amd, nvda, tsla] = p.changes.notebook[0].fields.focus_list;
  assert.equal(p.changes.notebook[0].fields.plan, 'Trade only the open drive.');
  assert.deepEqual(p.changes.notebook[0].fields.focus_list.map(f => f.symbol), ['AMD', 'NVDA', 'TSLA'], 'the list as it was, new ones after');
  assert.deepEqual(amd, { ...FOCUS_KEPT_ROW, note: 'Under 148 now.' }, 'a ticker already there keeps its id, side, how it played and its review');
  assert.deepEqual({ ...nvda, id: 'x' }, { id: 'x', symbol: 'NVDA', side: 'long', setups: ['mine:s2'], note: 'Reclaim of 180, stop under the LOD.', played: null, review: null });
  assert.equal(p.changes.library.length, 2, 'Gap fill: a pattern and the setup made of it');
  assert.deepEqual(tsla.setups, [`mine:${p.changes.library[1].id}`]);
  assert.match(p.said.join('\n'), /New setup in My setups: Gap fill\./);
  assert.deepEqual([p.changes.reviews, p.changes.days, p.changes.labels_add], [[], [], []]);
});

test("a day's plan again: the same changes nothing, null takes a ticker off and clears the plan", () => {
  const j = journalFrom({ ...PLAN_DATA, days: [{ day: NEXT, plan: 'Open drive.', focus_list: [FOCUS_KEPT_ROW] }] });
  assert.deepEqual(planPremarket(j, NEXT, { plan: 'Open drive.', focus: { AMD: { note: 'Under 150.' } } }, opts).changes.notebook, []);
  assert.deepEqual(planPremarket(j, NEXT, { plan: null, focus: { AMD: null, QQQ: null } }, opts).changes.notebook,
    [{ day: NEXT, fields: { plan: null, focus_list: [] } }]);
});

test("a day's plan that can't be: an unknown field, a bad ticker, side or note, a 13th ticker, a bad day", () => {
  const j = journalFrom(PLAN_DATA);
  assert.throws(() => planPremarket(j, NEXT, { grade: 'B' }), /a day's plan takes plan, focus; not grade/);
  assert.throws(() => planPremarket(j, NEXT, { focus: ['NVDA'] }), /focus: an object by ticker/);
  assert.throws(() => planPremarket(j, NEXT, { focus: { 'not a ticker': {} } }), /isn't a ticker/);
  assert.throws(() => planPremarket(j, NEXT, { focus: { NVDA: { side: 'up' } } }), /NVDA side: long or short/);
  assert.throws(() => planPremarket(j, NEXT, { focus: { NVDA: { played: 'worked' } } }), /NVDA takes side, setups, note; not played/);
  assert.throws(() => planPremarket(j, NEXT, { focus: { NVDA: { note: 'x'.repeat(501) } } }), /NVDA note: 500 characters at most/);
  assert.throws(() => planPremarket(j, NEXT, { plan: 'x'.repeat(5001) }), /plan: 5000 characters at most/);
  const many = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map(s => [s, {}]));
  assert.throws(() => planPremarket(j, NEXT, { focus: many }), /12 tickers on a focus list at most; 2026-10-26's has AMD, A, B/);
  assert.throws(() => planPremarket(j, '2026-02-30', { plan: 'x' }), /a day as YYYY-MM-DD/);
});

test("the day's plan in words: the last focus, the plan and each ticker", () => {
  const j = journalFrom({ ...PLAN_DATA, days: [{ day: DAY, focus_next: 'Name the setup first.' }, { day: NEXT, plan: 'Open drive.\nNothing after 11.', focus_list: [FOCUS_KEPT_ROW, { id: 'f2', symbol: 'NVDA', side: 'long', setups: ['mine:s2'], note: null }] }] });
  assert.equal(planDetail(j, NEXT), [
    '2026-10-26 (Mon) premarket', 'last focus (2026-10-23): Name the setup first.', 'plan: ', '  Open drive.', '  Nothing after 11.',
    'focus list (2 of 12):', '  AMD · short · Under 150. · played: Worked · review: Clean fade.', '  NVDA · long · EMA 21 bounce',
  ].join('\n'));
  assert.match(planDetail(journalFrom(DATA), NEXT), /plan: —\nfocus list \(0 of 12\):\n  —$/);
});

// ---------- a week's or month's review (period_reviews) ----------

const MONDAY = '2026-10-19';
const PARTS = ['Trade selection', 'Entry timing', 'Exit discipline', 'Risk management', 'Emotional control', 'Market awareness', 'Preparedness', 'Execution consistency'];
const WEEK_REVIEW = {
  parts: Object.fromEntries(PARTS.map((p, i) => [p, { grade: i === 3 ? 'd+' : 'B' }])),
  rulesNext: ['Name the setup and tactic before every order.'], wentWell: 'Sold the swing into strength.',
};
WEEK_REVIEW.parts['Risk management'].note = 'Moved a stop, oversized a spread.';

test("a week's review becomes period_reviews changes: parts by name or key, plus-minus grades, reviewed_at", () => {
  const j = journalFrom(DATA);
  const plan = planPeriod(j, 'week', '2026-10-23', WEEK_REVIEW, opts);
  assert.equal(plan.key, MONDAY, 'any day of the week names its Monday');
  const fields = plan.changes.periods[0].fields;
  assert.deepEqual(plan.changes.periods.map(p => [p.unit, p.key]), [['week', MONDAY]]);
  assert.equal(fields.risk_grade, 'D+');
  assert.equal(fields.risk_note, 'Moved a stop, oversized a spread.');
  assert.equal(fields.selection_grade, 'B');
  assert.deepEqual(fields.rules_next.map(r => r.text), WEEK_REVIEW.rulesNext);
  assert.ok(fields.rules_next[0].id, 'each rule gets an id');
  assert.equal(fields.rule_next, WEEK_REVIEW.rulesNext[0], 'the old column keeps the first one');
  assert.equal(fields.went_well, WEEK_REVIEW.wentWell);
  assert.equal(fields.reviewed_at, '2026-10-24T18:00:00.000Z', 'every part graded and the rules set');
  assert.deepEqual([plan.changes.library, plan.changes.reviews, plan.changes.days, plan.changes.notebook], [[], [], [], []]);
  assert.equal(planPeriod(j, 'week', MONDAY, { parts: { risk: { grade: 'C' } } }, opts).after.reviewed, false, 'one grade is not a review');
  assert.deepEqual(planPeriod(j, 'month', '2026-10', { workOn: 'Fewer trades.' }, opts).changes.periods, [{ unit: 'month', key: '2026-10', fields: { work_on: 'Fewer trades.' } }]);
});

test("a week's review again: only what changed, null clears and takes the stamp with it", () => {
  const row = { unit: 'week', period_key: MONDAY, rules_next: [{ id: 'r1', text: 'Wait for the setup.' }], rule_next: 'Wait for the setup.', reviewed_at: '2026-10-24T00:00:00.000Z',
    ...Object.fromEntries(['selection', 'entry', 'exit', 'risk', 'emotion', 'market', 'prep', 'consistency'].map(k => [`${k}_grade`, 'B'])) };
  const j = journalFrom({ ...DATA, periods: [row] });
  assert.deepEqual(planPeriod(j, 'week', MONDAY, { parts: { selection: { grade: 'B' } }, rulesNext: ['Wait for the setup.'] }, opts).changes.periods, [], 'the same answers change nothing');
  const more = planPeriod(j, 'week', MONDAY, { rulesNext: ['Wait for the setup.', 'Size down after a loss.'] }, opts).changes.periods[0].fields;
  assert.equal(more.rules_next[0].id, 'r1', 'a rule already on the list keeps its id');
  assert.equal(more.rules_next[1].text, 'Size down after a loss.');
  assert.equal('rule_next' in more, false, 'the first rule is the same');
  assert.deepEqual(planPeriod(j, 'week', MONDAY, { parts: { exit: { grade: null } } }, opts).changes.periods,
    [{ unit: 'week', key: MONDAY, fields: { exit_grade: null, reviewed_at: null } }]);
  assert.deepEqual(planPeriod(j, 'week', '2026-10-26', { rulesKept: { 'wait for the setup.': 'Partly' } }, opts).changes.periods,
    [{ unit: 'week', key: '2026-10-26', fields: { rules_kept: { r1: 'partly' } } }], "Kept it? is about the rules last week set, saved on this week's row");
  assert.deepEqual(planPeriod(j, 'week', '2026-10-26', { rulesKept: { 1: 'no' }, rulesNote: 'Waited, mostly.' }, opts).changes.periods[0].fields,
    { rules_kept: { r1: 'no' }, rules_note: 'Waited, mostly.' }, 'by number too');
  const old = journalFrom({ ...DATA, periods: [{ unit: 'week', period_key: MONDAY, rule_next: 'Wait for the setup.' }] });
  assert.deepEqual(planPeriod(old, 'week', '2026-10-26', { rulesKept: { 1: 'yes' } }, opts).changes.periods[0].fields, { rule_kept: 'yes' }, 'a rule from before the list answers in rule_kept');
});

test("a period's review that can't be: an unknown field or part, a grade or answer not on the list, a bad period", () => {
  const j = journalFrom(DATA);
  assert.throws(() => planPeriod(j, 'week', MONDAY, { grade: 'B' }), /not grade/);
  assert.throws(() => planPeriod(j, 'week', MONDAY, { parts: { Timing: { grade: 'B' } } }), /Timing isn't a part: Trade selection, Entry timing/);
  assert.throws(() => planPeriod(j, 'week', MONDAY, { parts: { risk: { grade: 'E' } } }), /grade: A\+, A, A-/);
  assert.throws(() => planPeriod(j, 'week', MONDAY, { parts: { risk: { score: 3 } } }), /a part takes grade, note; not score/);
  assert.throws(() => planPeriod(j, 'week', MONDAY, { ruleNext: 'x' }), /not ruleNext/);
  assert.throws(() => planPeriod(j, 'week', MONDAY, { rulesKept: { 1: 'yes' } }), /1 isn't one of the rules last week set: none/);
  const k = journalFrom({ ...DATA, periods: [{ unit: 'week', period_key: '2026-10-12', rules_next: [{ id: 'r1', text: 'Wait.' }] }] });
  assert.throws(() => planPeriod(k, 'week', MONDAY, { rulesKept: { 'Wait.': 'mostly' } }), /Wait\.: yes, partly or no, or null/);
  assert.throws(() => planPeriod(j, 'week', MONDAY, { rulesNext: ['x'.repeat(501)] }), /rulesNext 1: 500 characters at most/);
  assert.throws(() => planPeriod(j, 'week', MONDAY, { rulesNext: ['a', 'b', 'c', 'd', 'e', 'f'] }), /rulesNext: 5 rules at most/);
  assert.throws(() => planPeriod(j, 'week', MONDAY, { rulesNext: 'one' }), /rulesNext: a list/);
  assert.throws(() => planPeriod(j, 'week', '2026-10', {}), /a week by any of its days, YYYY-MM-DD/);
  assert.throws(() => planPeriod(j, 'month', '2026-13', {}), /a month as YYYY-MM/);
});

test("the whole week: its P&L, trades, last week's rule and each part's grade, with what's missing", () => {
  const j = journalFrom({ ...DATA, periods: [{ unit: 'week', period_key: '2026-10-12', rule_next: 'Wait for the setup.' }, { unit: 'week', period_key: MONDAY, risk_grade: 'D', risk_note: 'Oversized.' }] });
  const text = periodDetail(j, 'week', MONDAY);
  assert.match(text, /^Week of 2026-10-19\nP&L: \$11\.00 · 1 trade with an exit/);
  assert.match(text, new RegExp(`\\n  ${handleOf(KEY)} · QQQ 10/23/26 706P`));
  assert.match(text, /\n  this week's rules \(set last week\):\n    1\. Wait for the setup\. · kept: —\n  how they went: —\n/);
  assert.match(text, /\n    Risk management: D · Oversized\.\n/);
  assert.match(text, /\n    Trade selection: —\n/);
  assert.match(text, /\n  rules for next week: —\n/);
  assert.match(text, /missing: grades on 7 parts and the rules for next week$/, 'Kept it? on a rule from before the list is never needed');
});

test("this week's rules: each day checks them, the week's review shows how the days went and asks Kept it? and how they went", () => {
  const RULES = [{ id: 'r1', text: 'No trades before 9:45.' }, { id: 'r2', text: 'Size down after a loss.' }];
  const j = journalFrom({ ...DATA, periods: [{ unit: 'week', period_key: '2026-10-12', rules_next: RULES }],
    days: [...DATA.days, { day: '2026-10-20', week_rules: { r1: 'kept', r2: 'broke' } }, { day: '2026-10-21', week_rules: { r1: 'kept', gone: 'kept' } }] });
  const day = planDay(j, '2026-10-22', { weekRules: { 'no trades before 9:45.': 'Kept', 2: 'broke' } }, opts);
  assert.deepEqual(day.changes.notebook, [{ day: '2026-10-22', fields: { week_rules: { r1: 'kept', r2: 'broke' } } }]);
  assert.deepEqual(planDay(j, '2026-10-21', { weekRules: { 1: 'kept' } }, opts).changes.notebook, [], 'the same answer changes nothing');
  assert.deepEqual(planDay(j, '2026-10-21', { weekRules: { 1: null } }, opts).changes.notebook[0].fields.week_rules, { r1: null }, 'null clears one');
  assert.throws(() => planDay(j, '2026-10-22', { weekRules: { 'Trade less': 'kept' } }), /Trade less isn't one of this week's rules: 1\. No trades before 9:45\. 2\. Size down after a loss\./);
  assert.throws(() => planDay(j, '2026-10-12', { weekRules: { 1: 'kept' } }), /none \(last week's review set none\)/);
  assert.match(dayDetail(j, '2026-10-20'), /\n  this week's rules \(from last week's review\):\n    1\. No trades before 9:45\.: kept\n    2\. Size down after a loss\.: broke\n/);
  assert.match(dayDetail(j, '2026-10-22'), /missing: a grade, 2 of this week's rules and what went well or what to work on$/);

  const text = periodDetail(j, 'week', MONDAY);
  assert.match(text, /\n    1\. No trades before 9:45\. · days: kept 2, broke 0, 3 not checked · kept: —\n    2\. Size down after a loss\. · days: kept 0, broke 1, 4 not checked · kept: —\n/);
  assert.match(text, /missing: Kept it\? on this week's rules, how this week's rules went, grades on 8 parts and the rules for next week$/);
  const graded = { parts: Object.fromEntries(PARTS.map(p => [p, { grade: 'B' }])), rulesNext: ['Wait for the setup.'] };
  assert.equal(planPeriod(j, 'week', MONDAY, graded, opts).after.reviewed, false, 'still owes the rules it held');
  const done = planPeriod(j, 'week', MONDAY, { ...graded, rulesKept: { 1: 'yes', 2: 'partly' }, rulesNote: 'Held the open, not the size.' }, opts);
  assert.equal(done.after.reviewed, true);
  assert.deepEqual(done.changes.periods[0].fields.rules_kept, { r1: 'yes', r2: 'partly' });
});

// ---------- trade features, for analysis ----------

const byKey = k => FEATURES.find(f => f.key === k);
/** the QQQ put's stamps: one current value, one unknown, one stamped by an older version (so not counted) */
const STAMP_ROWS = [{ trade_key: KEY, stamps: {
  atr_from_daily_sma50: { v: featureVersion(byKey('atr_from_daily_sma50')), value: 4.0123, note: '50 SMA 690.10 · ATR $8.20 (1.15%)' },
  gap_atr: { v: featureVersion(byKey('gap_atr')), value: null, note: 'fewer than 15 daily sessions before, for the ATR' },
  adr_from_vwap: { v: '0.1', value: 9 },
} }, { trade_key: 'gone|trade', stamps: { atr_from_daily_sma50: { v: '1.1', value: 1 } } }];

test("each closed trade's result beside its features: the app's own numbers, current stamps only, by symbol and day", () => {
  const j = journalFrom({ ...DATA, labels: [{ trade_key: KEY, kind: 'setup', value: 'lotto', set_by: 'you' }] }, { now: Date.parse('2026-10-24T18:00:00Z') });
  const stamps = stampsFrom(STAMP_ROWS);
  const table = featureTable(j, stamps);
  assert.deepEqual(table.columns, [...FEATURE_TABLE_COLUMNS, ...FEATURES.map(f => f.key)]);
  assert.equal(table.rows.length, 1, 'one closed trade; a stamp for a trade that is gone is left out');
  const row = Object.fromEntries(table.columns.map((c, i) => [c, table.rows[0][i]]));
  assert.deepEqual({ ...Object.fromEntries(FEATURE_TABLE_COLUMNS.map(c => [c, row[c]])) }, {
    handle: handleOf(KEY), opened: '2026-10-23 13:40', closed: '2026-10-23 15:50', symbol: 'QQQ 10/23/26 706P', underlying: 'QQQ',
    type: 'OPTION', side: 'short', status: j.trades[0].status, market: null, setups: j.lib.nameOf('setup', 'lotto', 'short'), tactics: null,
    mistakes: null, grade: null, plan: null, qty: 1, entry: 1.69, exit: 1.8, pnl: 11, risk: 169, r: 0.07, hold_min: 130,
  });
  assert.equal(row.atr_from_daily_sma50, 4.0123, 'a current value');
  assert.equal(row.gap_atr, null, 'unknown');
  assert.equal(row.adr_from_vwap, null, 'stamped by an older version: not counted');
  assert.equal(featureTable(j, stamps, { symbol: 'qqq' }).rows.length, 1, 'by the underlying, any case');
  assert.equal(featureTable(j, stamps, { symbol: 'SPY' }).rows.length, 0);
  assert.equal(featureTable(j, stamps, { from: '2026-10-23', to: '2026-10-23' }).rows.length, 1);
  assert.equal(featureTable(j, stamps, { from: '2026-10-24' }).rows.length, 0, 'opened before');
  // how far the features are stamped over those trades
  const cov = featureCoverageText(table, stamps);
  assert.match(cov, new RegExp(`^1 closed trade · 1 with an R · 1 with features stamped · ${FEATURES.length} features\n`));
  assert.match(cov, /\nMoving averages:\n/);
  assert.match(cov, /\n  atr_from_daily_sma50: 1 value\n/);
  assert.match(cov, /\n  gap_atr: 0 values, 1 unknown \(fewer than 15 daily sessions before, for the ATR\)\n/);
  assert.match(cov, /\n  adr_from_vwap: 0 values, 1 not stamped yet\n/);
});

test('a table as CSV: one header row, fields quoted only when they must be, empty for null', () => {
  assert.equal(toCsv({ columns: ['a', 'b', 'c'], rows: [['x,y', 'say "hi"', 2.5], [null, 'two\nlines', -1]] }), 'a,b,c\n"x,y","say ""hi""",2.5\n,"two\nlines",-1\n');
});

test('the features read: its own keyed function returning every trade_features row of the key\'s owner', () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const sql = readFileSync(new URL('20261118000000_claude_features_read.sql', dir), 'utf8').replace(/--[^\n]*/g, '');
  assert.match(sql, /create or replace function public\.claude_features_read\(p_key text\) returns jsonb[\s\S]*uid uuid := public\.claude_key_user\(p_key\);[\s\S]*jsonb_build_object\('trade_key', f\.trade_key, 'stamps', f\.stamps\)[\s\S]*from public\.trade_features f where f\.user_id = uid/);
  assert.doesNotMatch(sql, /insert|update|delete/i, 'read only');
});

// ---------- the script ----------

const SCRIPT = fileURLToPath(new URL('../scripts/journal.mjs', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./helpers/journal-fetch.mjs', import.meta.url));
function script(args, { key = 'scj_test_key_0123456789abcdefghijklmnop', data = DATA, oldSave = false, features = [], noFeatures = false, noPlan = false } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'journal-')), 'fake.json');
  writeFileSync(file, JSON.stringify({ key: 'scj_test_key_0123456789abcdefghijklmnop', data, oldSave, features, noFeatures, noPlan }));
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

test('the script: the features table as CSV on stdout or to a file, the coverage, a database without the read', () => {
  const features = STAMP_ROWS;
  const out = script(['features'], { features });
  assert.equal(out.status, 0, out.stderr);
  const [header, row, end] = out.stdout.split('\n');
  assert.ok(header.startsWith('handle,opened,closed,symbol,underlying,') && header.endsWith(FEATURES.at(-1).key));
  assert.ok(row.startsWith(`${handleOf(KEY)},2026-10-23 13:40,2026-10-23 15:50,QQQ 10/23/26 706P,QQQ,OPTION,short,`));
  assert.ok(row.includes(',4.0123,'), row);
  assert.equal(end, '', 'ends with a line break');
  assert.match(out.stderr, /^1 closed trade · 1 with an R · 1 with features stamped/);
  const file = join(mkdtempSync(join(tmpdir(), 'features-')), 'trades.csv');
  const saved = script(['features', '--out', file, '--from', '2026-10-01'], { features });
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(readFileSync(file, 'utf8'), out.stdout);
  assert.match(saved.stdout, new RegExp(`^Wrote 1 trades × ${FEATURE_TABLE_COLUMNS.length + FEATURES.length} columns to `));
  const cov = script(['features', '--coverage'], { features });
  assert.match(cov.stdout, /\n  atr_from_daily_sma50: 1 value\n/);
  assert.match(script(['features', '--from', '10/1'], { features }).stderr, /Not a day: 10\/1/);
  const old = script(['features'], { noFeatures: true });
  assert.equal(old.status, 1);
  assert.match(old.stderr, /doesn't have Claude access to trade features yet: npx supabase db push/);
});

test("the script: shows a day, saves its review, a dry run saves nothing", () => {
  const show = script(['day', DAY], { data: DAY_DATA });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /^2026-10-23 \(Fri\)/);

  const dry = script(['day', DAY, JSON.stringify(DAY_REVIEW), '--dry-run'], { data: DAY_DATA });
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(dry.saves, []);
  assert.match(dry.stdout, /"notebook"/);

  const saved = script(['day', DAY, JSON.stringify(DAY_REVIEW)], { data: DAY_DATA });
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(saved.saves.length, 1);
  assert.deepEqual(saved.saves[0].notebook[0].fields.rules, { 'mine:r1': 'broke', 'mine:r2': 'kept' });
  assert.match(saved.stdout, /^Saved\./m);

  assert.match(script(['day'], { data: DAY_DATA }).stderr, /Which day\?/);
  const old = script(['day', DAY, JSON.stringify(DAY_REVIEW)], { data: DAY_DATA, oldSave: true });
  assert.equal(old.status, 1, "a database before the migration saves nothing, and says so");
  assert.match(old.stderr, /npx supabase db push/);
});

test("the script: shows a week or a month, saves its review, a dry run saves nothing", () => {
  const show = script(['week', '2026-10-23']);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /^Week of 2026-10-19/);
  assert.match(script(['month', '2026-10']).stdout, /^October 2026/);

  const dry = script(['week', MONDAY, JSON.stringify(WEEK_REVIEW), '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(dry.saves, []);
  assert.match(dry.stdout, /"periods"/);

  const saved = script(['week', MONDAY, JSON.stringify(WEEK_REVIEW)]);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(saved.saves[0].periods[0].fields.risk_grade, 'D+');
  assert.match(saved.stdout, /^Saved\./m);

  assert.match(script(['week']).stderr, /Which week\?/);
  const old = script(['week', MONDAY, JSON.stringify(WEEK_REVIEW)], { oldSave: true });
  assert.equal(old.status, 1);
  assert.match(old.stderr, /npx supabase db push/);
});

test("the script: shows a day's plan, saves it, a dry run saves nothing, a database before the migration says so", () => {
  const show = script(['plan', NEXT], { data: PLAN_DATA });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /^2026-10-26 \(Mon\) premarket\n/);
  const input = JSON.stringify({ plan: 'Open drive only.', focus: { NVDA: { side: 'long', setups: ['EMA 21 bounce'], note: 'Reclaim of 180.' } } });
  const dry = script(['plan', NEXT, input, '--dry-run'], { data: PLAN_DATA });
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(dry.saves, []);
  assert.match(dry.stdout, /"focus_list"/);
  const saved = script(['plan', NEXT, input], { data: PLAN_DATA });
  assert.equal(saved.status, 0, saved.stderr);
  assert.deepEqual(saved.saves[0].notebook[0].fields.focus_list.map(f => [f.symbol, f.setups]), [['AMD', []], ['NVDA', ['mine:s2']]]);
  assert.match(saved.stdout, /^Saved\./m);
  assert.match(script(['plan'], { data: PLAN_DATA }).stderr, /Which day\?/);
  const old = script(['plan', NEXT, input], { data: PLAN_DATA, noPlan: true });
  assert.equal(old.status, 1);
  assert.match(old.stderr, /doesn't take a day's plan yet: npx supabase db push/);
});

test('the save function takes the week and month review fields; the read returns the rows', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const sql = readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => readFileSync(new URL(f, dir), 'utf8')).join('\n').replace(/--[^\n]*/g, '');
  const last = name => [...sql.matchAll(new RegExp(`create or replace function public\\.${name}\\(p_key text[\\s\\S]*?end \\$\\$;`, 'gi'))].pop()?.[0] || '';
  const save = last('claude_journal_save'), read = last('claude_journal_read');
  assert.match(save, /p_changes->'periods'/);
  assert.match(save, /p_changes->'notebook'/, 'the day review stays');
  for (const k of ['selection', 'entry', 'exit', 'risk', 'emotion', 'market', 'prep', 'consistency']) {
    assert.match(save, new RegExp(`${k}_grade = case when f \\? '${k}_grade'`), k);
    assert.match(read, new RegExp(`'${k}_note', p\\.${k}_note`), k);
  }
  assert.match(read, /'periods', coalesce\(\(select jsonb_agg[\s\S]*from public\.period_reviews p where p\.user_id = uid/);
  assert.match(read, /'order_plans', coalesce/);
  assert.match(read, /'went_well', d\.went_well/, "the day's review stays");
});

test('the save function takes the day review fields, the plan and the focus list, nothing else of the notebook; the read returns them', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const sql = readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => readFileSync(new URL(f, dir), 'utf8')).join('\n').replace(/--[^\n]*/g, '');
  const last = name => [...sql.matchAll(new RegExp(`create or replace function public\\.${name}\\(p_key text[\\s\\S]*?end \\$\\$;`, 'gi'))].pop()?.[0] || '';
  const save = last('claude_journal_save'), read = last('claude_journal_read');
  assert.match(save, /p_changes->'notebook'/);
  assert.match(save, /k not in \('grade', 'rules', 'week_rules', 'went_well', 'work_on', 'note', 'focus_next', 'focus_kept', 'reviewed_at', 'plan', 'focus_list'\)/, 'the review, the plan and the focus list; never the check-in or the missed trades');
  assert.match(save, /jsonb_strip_nulls\(coalesce\(d\.week_rules, '\{\}'\) \|\| \(f->'week_rules'\)\)/, 'week rules merge one at a time too');
  assert.match(save, /jsonb_strip_nulls\(coalesce\(p\.rules_kept, '\{\}'\) \|\| \(f->'rules_kept'\)\)/, 'Kept it? merges one rule at a time');
  assert.match(save, /rules_next = case when f \? 'rules_next' then coalesce\(f->'rules_next', '\[\]'\)/, 'the list is replaced whole');
  assert.match(read, /'week_rules', d\.week_rules/);
  assert.match(read, /'plan', d\.plan, 'focus_list', d\.focus_list/, "each day's plan and focus list");
  assert.match(save, /focus_list = case when f \? 'focus_list' then coalesce\(f->'focus_list', '\[\]'\)/, 'the focus list is replaced whole');
  assert.match(save, /jsonb_array_length\(f->'focus_list'\) > 12/, 'twelve tickers at most, as the app keeps');
  assert.doesNotMatch(save, /feelings|energy|sleep_hours|missed =|planned_at/, 'the check-in, the missed trades and the plan stamp stay out of reach');
  assert.match(read, /'rules_next', p\.rules_next, 'rules_kept', p\.rules_kept, 'rules_note', p\.rules_note/);
  assert.match(save, /jsonb_strip_nulls\(coalesce\(d\.rules, '\{\}'\) \|\| \(f->'rules'\)\)/, 'rules merge one at a time, null clears one');
  assert.match(read, /'order_plans', coalesce/, 'the read keeps the order plans');
  assert.match(read, /'went_well', d\.went_well/);
  assert.doesNotMatch(read, /d\.market is not null/, 'every day row, a review can come before a market');
});
