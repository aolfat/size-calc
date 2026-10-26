// Run with: node --test
// Week and month reviews (journal step 3, slice 6, parts 1 and 2): a period's numbers per part of a self-assessment
// (selection, entry, exits, risk, emotions, market, preparation, consistency), against the period before, and the review
// panel the calendar opens for a week or a month, with exit efficiency from the trades' saved 5-minute bars; each part's
// grade and note, last week's rule with Kept it?, the week overall, the rule for next week, the calendar's reviewed mark,
// and the period's trades in a list sorted by P&L, P&L %, R or when they opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const json = (run, code) => JSON.parse(run(`JSON.stringify(${code})`));
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
const T = (key, openedAt, closedAt, pnl, extra = {}) => ({
  key, symbol: key.toUpperCase(), label: key.toUpperCase(), assetType: 'EQUITY', status: closedAt === null ? 'open' : pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven',
  bias: 'long', direction: 'long', openedAt, closedAt, pnl, r: null, risk: null, exits: 1, holdMs: 3600000,
  avgEntry: 100, entryQty: 100, multiplier: 1, schwabStop: null, movedTo: null, ...extra,
});
// the week of Oct 12, 2026 (UTC times; New York is 4 hours behind), and one trade the week before
const TRADES = [
  T('aapl', '2026-10-12T13:35:00Z', '2026-10-12T15:00:00Z', 400, { r: 2, risk: 200 }), // 9:35: an early entry
  T('nvda', '2026-10-13T14:00:00Z', '2026-10-13T16:00:00Z', 300, { r: 1, risk: 300 }),
  T('amd', '2026-10-14T14:00:00Z', '2026-10-14T15:00:00Z', -350, { r: -1.75, risk: 200, schwabStop: 95, movedTo: 93 }), // stop loosened
  T('tsla', '2026-10-14T15:10:00Z', '2026-10-14T16:00:00Z', -100, { r: -0.5, risk: 200 }), // 10 minutes after AMD's loss
  T('meta', '2026-10-15T14:00:00Z', null, 0, { risk: 900 }), // still open, no exit yet
  T('spy', '2026-10-05T14:00:00Z', '2026-10-05T15:00:00Z', 100, { r: 0.5, risk: 200 }),
  T('gone', '2026-10-13T14:00:00Z', '2026-10-13T15:00:00Z', 999, { deleted: true }),
];
const CTX = `{
  review: k => ({ aapl: { setup_grade: 'A', plan_followed: 'yes', entry_note: 'gap and go' }, nvda: { setup_grade: 'A++', plan_followed: 'yes' },
    amd: { setup_grade: 'C', plan_followed: 'no' }, tsla: { setup_grade: 'B', plan_followed: 'partly', entry_note: 'x' } })[k],
  labels: k => ({ aapl: [{ kind: 'setup', value: 'ema21_bounce' }, { kind: 'tactic', value: 'pivot15' }, { kind: 'sector', value: 'strong' }],
    nvda: [{ kind: 'setup', value: 'ema21_bounce' }, { kind: 'tactic', value: 'pivot15' }, { kind: 'mistake', value: 'exited_early' }],
    amd: [{ kind: 'setup', value: 'base_breakout' }, { kind: 'mistake', value: 'chased' }, { kind: 'sector', value: 'weak' }],
    tsla: [{ kind: 'mistake', value: 'revenge' }, { kind: 'mistake', value: 'mine:fomo' }] })[k] || [],
  market: t => ({ aapl: 'bullish', nvda: 'bullish', amd: 'bearish' })[t.key] || null,
  nameOf: (kind, v) => ({ ema21_bounce: '21 EMA bounce', base_breakout: 'Base breakout', pivot15: '15-minute pivot', strong: 'Strong', weak: 'Weak',
    bullish: 'Bullish', bearish: 'Bearish', exited_early: 'Exited early', chased: 'Chased the entry', revenge: 'Revenge trade', 'mine:fomo': 'FOMO' })[v] || v,
  excursion: t => ({ aapl: { mfe: 1000, mae: -50, mfeR: 5, maeR: -0.25, efficiency: 0.4 }, nvda: { mfe: 400, mae: -150, mfeR: 1.33, maeR: -0.5, efficiency: 0.75 },
    amd: { mfe: 250, mae: -400, mfeR: 1.25, maeR: -2, efficiency: null } })[t.key] ?? null,
  reviewed: t => t.key === 'aapl',
  saved: k => k === 'amd',
}`;

test('a week in numbers: the headline against the week before, best and worst, saved trades, still open', async () => {
  const { run } = await app();
  const r = json(run, `periodReview(${JSON.stringify(TRADES)}, 'week', '2026-10-12', ${CTX})`);
  assert.equal(r.prevKey, '2026-10-05');
  assert.deepEqual([r.stats.trades, r.stats.net, r.stats.winRate, r.stats.profitFactor], [4, 250, 50, 1.56], 'deleted trades never count');
  assert.deepEqual([r.prev.trades, r.prev.net], [1, 100]);
  assert.deepEqual([r.best.key, r.worst.key], ['aapl', 'amd']);
  assert.deepEqual(r.saved.map(t => t.key), ['amd']);
  assert.equal(r.openCount, 1, 'META opened this week and is still open');
  assert.deepEqual(r.categories.map(c => c.name), ['Trade selection', 'Entry timing', 'Exit discipline', 'Risk management', 'Emotional control', 'Market awareness', 'Preparedness', 'Execution consistency']);
  assert.equal(run("previousPeriod('month', '2026-01')"), '2025-12');
  assert.equal(run("previousPeriod('week', '2026-10-05')"), '2026-09-28');
});

test('each part of the week gets its own numbers, the good and the worrying ones marked', async () => {
  const { run } = await app();
  const r = json(run, `periodReview(${JSON.stringify(TRADES)}, 'week', '2026-10-12', ${CTX})`);
  const cat = key => r.categories.find(c => c.key === key).facts.map(f => `${f.tone ? `[${f.tone}] ` : ''}${f.text}`);
  assert.deepEqual(cat('selection'), [
    '2 of 4 closed trades won (50%), 100% the week before',
    'Setup grades: 2 A, 1 B, 1 C',
    '[good] Best setup: 21 EMA bounce: 2 trades, +$700.00 (+3.0R)',
    '[bad] Worst setup: Base breakout: 1 trade, −$350.00 (−1.8R)',
    '1 trade with no setup labeled',
  ]);
  const kinds = `{ ...${CTX}, labels: k => k === 'nvda' ? [{ kind: 'setup', value: 'sma50_bounce' }] : (${CTX}).labels(k),
    kinds: k => ({ aapl: ['Bounce'], nvda: ['Bounce'], amd: ['Base breakout'] })[k] || [] }`;
  const byKind = json(run, `periodReview(${JSON.stringify(TRADES)}, 'week', '2026-10-12', ${kinds})`).categories.find(c => c.key === 'selection').facts.map(f => f.text);
  assert.ok(byKind.includes('By kind: Bounce: 2 trades, +$700.00 (+3.0R) · Base breakout: 1 trade, −$350.00 (−1.8R)'), 'the 21 and 50 bounces together');
  assert.ok(!cat('selection').some(f => f.startsWith('By kind')), 'one setup per kind: nothing to add');
  const ungraded = `{ ...${CTX}, review: k => k === 'tsla' ? { plan_followed: 'partly' } : (${CTX}).review(k) }`;
  const sel = json(run, `periodReview(${JSON.stringify(TRADES)}, 'week', '2026-10-12', ${ungraded})`).categories.find(c => c.key === 'selection').facts.map(f => f.text);
  assert.ok(sel.includes('Setup grades: 2 A, 1 C'), 'the grades given (an old A++ counts as an A)');
  assert.ok(!sel.some(f => /not graded|no setup grades/i.test(f)), 'nothing about the ones without');
  const none = `{ ...${CTX}, review: () => undefined }`;
  assert.ok(!json(run, `periodReview(${JSON.stringify(TRADES)}, 'week', '2026-10-12', ${none})`).categories.find(c => c.key === 'selection').facts.some(f => /grade/i.test(f.text)), 'no grades at all: no line');
  assert.deepEqual(cat('entry'), [
    'Average heat: −0.9R against you before the exit, worst −2.0R on AMD',
    '1 trade opened before 9:45: 1 won, +$400.00',
    'By entry tactic: 15-minute pivot 2 trades +$700.00',
    '[bad] Tagged "Chased the entry" on 1 trade: AMD',
  ].map((s, i) => i === 0 ? `[bad] ${s}` : s), 'heat averages −0.92R: amber');
  assert.deepEqual(cat('exit'), [
    'Kept 57% of the best move on 2 winners',
    'Winners made +3.5% of cost on average; the best they reached was +7.0%',
    '[bad] Gave back over half the best move on 1 winner: AAPL',
    '[bad] 1 loser was up 1R or more first: AMD',
    "No 5-minute bars for 1 trade (TSLA), so they're left out of the excursions",
    '[bad] Tagged "Exited early" on 1 trade: NVDA',
  ]);
  assert.deepEqual(cat('risk'), [
    'Biggest loss: −$350.00 (−1.8R) on AMD',
    '[bad] 1 loss worse than −1.5R',
    '[bad] Risk per trade: $200.00 to $900.00, $360.00 on average',
    '[bad] Stop moved farther away on 1 trade: AMD',
  ]);
  assert.deepEqual(cat('emotion'), [
    '[bad] 1 trade opened within 15 minutes of a loss: −$100.00',
    'Most trades opened in a day: 2 (Wed, 10/14), 1.3 a day on average',
    '[bad] Tagged "Revenge trade" on 1 trade: TSLA',
  ]);
  assert.deepEqual(cat('market'), [
    'By market: Bullish 2 trades +$700.00 · Bearish 1 trade −$350.00',
    '1 trade with no market set',
    '[bad] 1 trade against the market: −$350.00',
    'By sector: Strong 1 trade +$400.00 · Weak 1 trade −$350.00',
  ]);
  assert.deepEqual(cat('prep'), ['Entry notes on 2 of 5 trades opened', 'Setup and entry tactic labeled on 2 of 5'].map((s, i) => i ? s : `[bad] ${s}`));
  assert.deepEqual(cat('consistency'), [
    '[bad] Followed the plan: 2 yes (+$700.00), 1 partly (−$100.00), 1 no (−$350.00)',
    'A trades +$700.00 over 2; C and below −$350.00 over 1',
    'Reviewed 1 of 4 trades closed',
    '[bad] Tagged "FOMO" on 1 trade: TSLA',
  ], 'your own mistakes go under consistency');
});

test('an empty week has no facts, a month counts its weeks together, bars still loading say so', async () => {
  const { run } = await app();
  const empty = json(run, `periodReview(${JSON.stringify(TRADES)}, 'week', '2026-09-21', ${CTX})`);
  assert.equal(empty.trades, 0);
  assert.ok(empty.categories.every(c => !c.facts.length));
  const month = json(run, `periodReview(${JSON.stringify(TRADES)}, 'month', '2026-10', ${CTX})`);
  assert.deepEqual([month.stats.trades, month.stats.net, month.prevKey], [5, 350, '2026-09']);
  const loading = json(run, `periodReview(${JSON.stringify(TRADES)}, 'week', '2026-10-12', { ...${CTX}, excursion: () => undefined, barsPending: true })`);
  const exit = loading.categories.find(c => c.key === 'exit').facts.map(f => f.text);
  assert.ok(exit.includes('Loading the 5-minute bars for the best and worst of each trade…'));
  assert.ok(!exit.some(f => /No 5-minute bars/.test(f)), 'not read yet is not missing');
});

test('the list of trades: the period\'s exits like the calendar, a trim\'s % over what that part cost, sorted with blanks last', async () => {
  const { run } = await app();
  // opened the Friday before, half sold then for +$300 and half this week for +$200
  const part = T('part', '2026-10-09T14:00:00Z', '2026-10-13T15:00:00Z', 500, { risk: 100, r: 5, exits: 2,
    realized: [{ at: '2026-10-09T15:00:00Z', qty: 50, pnl: 300 }, { at: '2026-10-13T15:00:00Z', qty: 50, pnl: 200 }] });
  const all = JSON.stringify([...TRADES, part]);
  const rows = json(run, `periodTradeRows(${all}, 'week', '2026-10-12')`);
  const by = k => rows.find(x => x.trade.key === k);
  assert.deepEqual([by('part').pnl, by('part').pct, by('part').r, by('part').partial], [200, 4, 2, true], 'this week\'s half: $200 on $5,000');
  assert.deepEqual([by('aapl').pnl, by('aapl').pct, by('aapl').r, by('aapl').partial], [400, 4, 2, false]);
  assert.deepEqual([by('meta').pnl, by('meta').pct, by('meta').r, by('meta').open], [null, null, null, true], 'opened, nothing closed yet');
  assert.ok(!by('gone') && !by('spy'), 'deleted and last week\'s trades left out');
  const order = (sort, dir) => json(run, `sortPeriodTrades(periodTradeRows(${all}, 'week', '2026-10-12'), '${sort}', ${dir})`).map(x => x.trade.key);
  assert.deepEqual(order('pnl', -1), ['aapl', 'nvda', 'part', 'tsla', 'amd', 'meta']);
  assert.deepEqual(order('pnl', 1), ['amd', 'tsla', 'part', 'nvda', 'aapl', 'meta'], 'no P&L stays last either way');
  assert.deepEqual(order('pct', -1), ['part', 'aapl', 'nvda', 'tsla', 'amd', 'meta'], 'a tie goes to the one opened first');
  assert.deepEqual(order('r', 1), ['amd', 'tsla', 'nvda', 'part', 'aapl', 'meta']);
  assert.deepEqual(order('opened', -1), ['meta', 'tsla', 'amd', 'nvda', 'aapl', 'part']);
});

// ---------- the panel ----------

const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const order = (id, instruction, time, qty, price, symbol = 'AAPL') => ({ kind: 'order', record_id: String(id), account: '6789', entered_at: time.replace('+0000', 'Z'), data: {
  orderId: id, enteredTime: time, status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction, quantity: qty, instrument: { symbol, assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: id * 10, executionLegs: [{ legId: 1, quantity: qty, price, time }] }],
} });
const RECORDS = [
  order(1, 'BUY', '2026-10-05T13:35:00+0000', 100, 100), order(2, 'SELL', '2026-10-05T15:00:00+0000', 100, 103),
  order(3, 'BUY', '2026-10-06T13:40:00+0000', 50, 200, 'MSFT'), order(4, 'SELL', '2026-10-06T15:00:00+0000', 50, 198, 'MSFT'),
  order(5, 'BUY', '2026-09-29T13:40:00+0000', 10, 50, 'F'), order(6, 'SELL', '2026-09-29T15:00:00+0000', 10, 51, 'F'),
];

async function journal({ periods = [], broken = false, opts = {} } = {}) {
  const supabase = fakeRecords(RECORDS);
  for (const r of periods) supabase.tables.period_reviews.set(`user-1:${r.unit}:${r.period_key}`, { user_id: 'user-1', ...r });
  if (broken) supabase.failTable('period_reviews');
  // AAPL's bars on its day: it reached $107 before the $103 exit
  supabase.bars.set('user-1:AAPL:2026-10-05', { user_id: 'user-1', symbol: 'AAPL', day: '2026-10-05', bars: [['09:35', 100, 101, 99.5, 100.5, 1000], ['10:00', 100.5, 107, 100, 105, 1000], ['11:00', 104, 104, 102, 103, 1000]] });
  const a = await app({ supabase, session: SESSION, ...opts });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  await settle();
  a.run("setJournalTab('calendar')");
  return { ...a, supabase, out: () => a.elements.get('journalSection').innerHTML };
}

test('a week\'s total on the calendar opens its review under the grid, with exit efficiency from the saved bars', async () => {
  const { run, state, out, supabase } = await journal();
  assert.doesNotMatch(out(), /journalPeriodReview/, 'nothing open until you tap a week');
  run("openPeriodReview('week', '2026-10-05')");
  assert.match(out(), /id="journalPeriodReview"[\s\S]*class="jc-title">Week of Oct 5–9, 2026</);
  assert.match(out(), /data-action="openPeriodReview" data-arg="week" data-arg2="2026-10-05"[^>]*aria-expanded="true"/, 'the week shows as open');
  assert.match(out(), /Loading the 5-minute bars/);
  await settle();
  assert.ok(supabase.reads.some(r => r.table === 'bars_5m'), 'the saved bars are read');
  const panel = out().slice(out().indexOf('journalPeriodReview'));
  assert.match(panel, /<dt>Net P&amp;L<\/dt><dd class="journal-buy">\+\$200\.00<span class="pos-sub">\+\$10\.00 the week before</, 'against the week before');
  assert.match(panel, /Best: <button class="pos-link" data-action="openTradeRow" data-arg="[^"]*AAPL[^"]*">AAPL<\/button> <span class="journal-buy">\+\$300\.00/);
  assert.match(panel, /Worst: <button[^>]*>MSFT<\/button> <span class="journal-sell">−\$100\.00/);
  assert.match(panel, /<div class="jw-cat-name">Exit discipline<\/div><select[^>]*>[\s\S]*?<\/select><\/div><ul class="jw-facts"><li class="jw-bad">Kept 43% of the best move on 1 winner<\/li>/, '$300 of the $700 it reached');
  assert.match(panel, /Gave back over half the best move on 1 winner: AAPL/);
  assert.match(panel, /No 5-minute bars for 1 trade \(MSFT\)/);
  assert.match(panel, /<li class="jw-bad">2 trades with no stop: AAPL and MSFT<\/li>/, 'named in the order they opened');
  assert.match(panel, /<li class="">No more than 1 trade opened a day<\/li>/);
  assert.match(panel, /2 trades opened before 9:45 ET: 1 won, \+\$200\.00/);
  assert.match(panel, /Average heat: −0.5% of cost against you before the exit, worst −0.5% on AAPL/, 'no stops: heat as a share of the cost');
  assert.match(panel, /The whole week: the side, symbol and setup filters don't apply/);
  const reads = supabase.reads.filter(r => r.table === 'bars_5m').length;
  run("closePeriodReview(); openPeriodReview('week', '2026-10-05')");
  await settle();
  assert.equal(supabase.reads.filter(r => r.table === 'bars_5m').length, reads, 'each trade\'s bars are read once');
  run("openPeriodReview('week', '2026-10-05')");
  assert.equal(state.journalReviewPeriod, null, 'tapping the open week closes it');
});

test('‹ › step to the nearest week with trades, the calendar follows, and the month has its own review', async () => {
  const { run, state, out } = await journal();
  run("openPeriodReview('week', '2026-10-05')");
  assert.match(out(), /aria-label="Later week with trades" disabled/, 'nothing after it');
  run("stepPeriodReview('-1')");
  assert.equal(state.journalReviewPeriod.key, '2026-09-28');
  assert.match(out(), /Week of Sep 28 – Oct 2, 2026/);
  assert.match(out(), /class="jc-title">October 2026</, 'the week of Sep 28 ends in October: the calendar stays');
  assert.match(out(), /data-action="openPeriodReview" data-arg="month" data-arg2="2026-10"[^>]*>Review the month</);
  run("openPeriodReview('month', '2026-10')");
  assert.match(out(), /class="jc-title">October 2026<\/span>[\s\S]*All of the month's stats/);
  assert.match(out(), /2 of 2 closed trades won|1 of 2 closed trades won/);
  run("shiftJournalMonth('-1')");
  assert.equal(state.journalReviewPeriod, null, 'another month closes the review');
});

// ---------- grades and notes ----------

const GRADED = Object.fromEntries(['selection', 'entry', 'exit', 'risk', 'emotion', 'market', 'prep', 'consistency'].map(k => [`${k}_grade`, 'B']));

test('a week is reviewed once every part has a grade and the rule is set; notes and Kept it? never count', async () => {
  const { run } = await app();
  const st = row => json(run, `periodReviewState(${JSON.stringify(row)})`);
  assert.deepEqual(st(null), { reviewed: false, ungraded: ['selection', 'entry', 'exit', 'risk', 'emotion', 'market', 'prep', 'consistency'], graded: 0, rule: false });
  assert.equal(st({ ...GRADED }).reviewed, false, 'no rule yet');
  assert.equal(st({ ...GRADED, rule_next: '   ' }).reviewed, false, 'a blank rule is no rule');
  assert.equal(st({ ...GRADED, rule_next: 'No trades before 9:45' }).reviewed, true);
  assert.deepEqual(st({ ...GRADED, exit_grade: 'A++', rule_next: 'x' }).ungraded, ['exit'], 'only the period grades count');
  assert.equal(run(`periodMissingWords(periodReviewState(null), 'week')`), 'grades on 8 parts and the rule for next week');
  assert.equal(run(`periodMissingWords(periodReviewState({ ...${JSON.stringify(GRADED)}, risk_grade: null }), 'month')`), 'a grade on risk management and the rule for next month');
  assert.deepEqual(json(run, 'PERIOD_GRADES'), ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F']);
  assert.equal(json(run, 'PERIOD_COLUMNS').length, 19);
});

test('a week is over after its Friday close in New York, a month once the next one starts; rows are cleaned on the way in', async () => {
  const { run } = await app();
  assert.equal(run("periodOver('week', '2026-10-12', '2026-10-16T19:59:00Z')"), false, 'Friday 3:59pm New York');
  assert.equal(run("periodOver('week', '2026-10-12', '2026-10-16T20:00:00Z')"), true, 'Friday 4pm');
  assert.equal(run("periodOver('week', '2026-10-12', '2026-10-17T03:00:00Z')"), true, 'Friday night in New York, Saturday in UTC');
  assert.equal(run("periodOver('month', '2026-10', '2026-10-31T23:00:00Z')"), false);
  assert.equal(run("periodOver('month', '2026-10', '2026-11-01T05:00:00Z')"), true);
  const row = json(run, `cleanPeriodRow({ unit: 'week', period_key: '2026-10-12', exit_grade: 'A++', risk_grade: 'B-', risk_note: 'ok', rule_kept: 'maybe', rule_next: '  ', extra: 1 })`);
  assert.deepEqual([row.exit_grade, row.risk_grade, row.risk_note, row.rule_kept, row.rule_next, row.extra], [null, 'B-', 'ok', null, null, undefined]);
  assert.equal(run("cleanPeriodRow({ unit: 'day', period_key: '2026-10-12' })"), null);
});

test('grades and notes save as you go: one column per save, a note on blur, the reviewed mark on the calendar', async () => {
  const { run, state, out, supabase } = await journal();
  const writes = () => supabase.writes.filter(w => w.table === 'period_reviews');
  assert.match(out(), /data-arg2="2026-10-05"[^>]*>[\s\S]*?<span class="jc-rev jc-rev-due">review week<\/span><\/button>/, 'a week that is over and not reviewed asks for it');
  run("openPeriodReview('week', '2026-10-05')");
  assert.match(out(), /class="jw-status jw-status-open">To finish: grades on 8 parts and the rule for next week\./);
  assert.match(out(), /<select class="jw-grade jw-grade-empty" id="jwGrade-exit" data-change="setPeriodGrade" data-arg="exit" aria-label="Exit discipline grade">/);
  assert.match(out(), /<label class="jw-rule-label" for="jwRuleNext">Rule for next week<\/label>/);
  assert.doesNotMatch(out(), /Last week's rule/, 'no rule the week before');

  run("setPeriodGrade('exit', 'B+')");
  await settle();
  assert.deepEqual(writes().map(w => [w.unit, w.period_key, w.onConflict, Object.keys(w).filter(k => k.endsWith('_grade') || k.endsWith('_note'))]),
    [['week', '2026-10-05', 'user_id,unit,period_key', ['exit_grade']]], 'only that part\'s grade');
  assert.match(out(), /<option value="B\+" selected>B\+<\/option>/);
  assert.match(out(), /To finish: grades on 7 parts/);

  run("periodTextInput('exit', 'Sold AAPL into the first pop')");
  run('renderJournal()');
  assert.match(out(), /id="jwNote-exit"[^>]*>Sold AAPL into the first pop<\/textarea>/, 'a redraw keeps the draft');
  assert.equal(writes().length, 1, 'nothing saved while typing');
  run("periodTextSave('exit', '  Sold AAPL into the first pop ')");
  await settle();
  assert.equal(writes()[1].exit_note, 'Sold AAPL into the first pop');
  assert.equal(state.periodNoteDraft, null);
  run("periodTextSave('exit', 'Sold AAPL into the first pop')");
  await settle();
  assert.equal(writes().length, 2, 'an unchanged box saves nothing');

  for (const k of ['selection', 'entry', 'risk', 'emotion', 'market', 'prep', 'consistency']) run(`setPeriodGrade('${k}', 'B')`);
  await settle();
  assert.equal(supabase.tables.period_reviews.get('user-1:week:2026-10-05').reviewed_at, undefined, 'still no rule');
  run("periodTextSave('rule', 'No entries before 9:45')");
  await settle();
  const saved = supabase.tables.period_reviews.get('user-1:week:2026-10-05');
  assert.equal(saved.rule_next, 'No entries before 9:45');
  assert.ok(saved.reviewed_at, 'reviewed_at stamped with the save that finished it');
  assert.match(out(), /<span class="journal-tag journal-tag-done">reviewed<\/span> Every part graded and the rule for next week set\./);
  assert.match(out(), /data-arg2="2026-10-05"[^>]*aria-label="[^"]*, reviewed\. Review the week"[\s\S]*?<span class="jc-rev jc-rev-done">✓ reviewed<\/span>/);
  run("setPeriodGrade('risk', '')");
  await settle();
  assert.equal(supabase.tables.period_reviews.get('user-1:week:2026-10-05').reviewed_at, null, 'a grade cleared takes the mark off');
  assert.equal(supabase.tables.period_reviews.get('user-1:week:2026-10-05').risk_grade, null);
});

test('the review lists the week\'s trades: tap a header to sort by it, again to flip it, a row opens the trade', async () => {
  const { run, out } = await journal();
  run("openPeriodReview('week', '2026-10-05')");
  const keys = () => [...out().matchAll(/<tr data-action="openTradeRow" data-arg="([^"]+)">/g)].map(m => m[1]);
  const names = () => [...out().matchAll(/<tr data-action="openTradeRow"[^>]*>\s*<td><button class="journal-name"[^>]*><b>([^<]+)<\/b>/g)].map(m => m[1]);
  assert.match(out(), /<div class="section-title js-sub">Trades <span class="jw-optional">2<\/span><\/div>/);
  assert.match(out(), /<th scope="col" class="jw-sort" aria-sort="descending"><button data-action="setPeriodTradeSort" data-arg="pnl"[^>]*>P&amp;L ↓<\/button><\/th>/, 'P&L, biggest first, to start');
  assert.deepEqual(names(), ['AAPL', 'MSFT']);
  assert.match(out(), /<td class="journal-buy">\+\$300\.00<\/td>\s*<td class="journal-buy">\+3\.00%<\/td>/);
  assert.match(out(), /<td class="journal-sell">−\$100\.00<\/td>\s*<td class="journal-sell">−1\.00%<\/td>/);
  run("setPeriodTradeSort('pnl')");
  assert.deepEqual(names(), ['MSFT', 'AAPL'], 'again: smallest first');
  assert.match(out(), /aria-sort="ascending"><button data-action="setPeriodTradeSort" data-arg="pnl"[^>]*>P&amp;L ↑/);
  run("setPeriodTradeSort('pct')");
  assert.deepEqual(names(), ['AAPL', 'MSFT'], 'a new column starts biggest first');
  run("setPeriodTradeSort('opened')");
  assert.deepEqual(names(), ['AAPL', 'MSFT'], 'Opened starts oldest first');
  assert.match(out(), /aria-sort="ascending"><button data-action="setPeriodTradeSort" data-arg="opened"[^>]*>Opened ↑/);
  run("setPeriodTradeSort('bogus')");
  assert.match(out(), /data-arg="opened"[^>]*>Opened ↑/, 'an unknown column changes nothing');
  assert.equal(keys().length, 2);
});

test('the week overall: what went well, what to work on, more notes, each its own column, never needed to finish', async () => {
  const { run, out, supabase } = await journal();
  const writes = () => supabase.writes.filter(w => w.table === 'period_reviews');
  run("openPeriodReview('week', '2026-10-05')");
  assert.match(out(), /<section class="jw-overall" aria-label="The week overall"><div class="jw-cat-name">The week overall <span class="jw-optional">optional<\/span><\/div>/);
  for (const [col, label] of [['went_well', 'What went well'], ['work_on', 'What to work on'], ['note', 'More notes']])
    assert.match(out(), new RegExp(`<label class="jw-overall-label" for="jwOverall-${col}">${label}</label>\\s*<textarea class="jw-note" id="jwOverall-${col}"[^>]*data-arg="${col}">`));
  assert.ok(out().indexOf('jw-overall') > out().indexOf('jw-cats') && out().indexOf('jw-overall') < out().indexOf('jwRuleNext'), 'after the parts, before the rule');
  run("periodTextInput('went_well', 'Waited for the 9:45 pivot')");
  run('renderJournal()');
  assert.match(out(), /id="jwOverall-went_well"[^>]*>Waited for the 9:45 pivot<\/textarea>/, 'a redraw keeps the draft');
  run("periodTextSave('went_well', ' Waited for the 9:45 pivot ')");
  await settle();
  assert.deepEqual(writes().map(w => Object.keys(w).filter(k => !['unit', 'period_key', 'onConflict', 'ignoreDuplicates', 'user_id', 'table'].includes(k))), [['went_well']], 'only that column');
  assert.equal(supabase.tables.period_reviews.get('user-1:week:2026-10-05').went_well, 'Waited for the 9:45 pivot');
  run("periodTextSave('note', 'Slept badly Wednesday')");
  await settle();
  assert.equal(supabase.tables.period_reviews.get('user-1:week:2026-10-05').note, 'Slept badly Wednesday');
  assert.match(out(), /To finish: grades on 8 parts and the rule for next week\./, 'notes don\'t count toward reviewed');
  run("closePeriodReview()");
  run("openPeriodReview('month', '2026-10')");
  assert.match(out(), /aria-label="The month overall"/);
  assert.match(out(), /placeholder="Anything else about the month"/);
});

test('before the overall notes\' columns are pushed their boxes are off and say so; grades still save', async () => {
  const supabaseCols = s => s.failColumn('period_reviews', 'went_well');
  const sb = fakeRecords(RECORDS);
  supabaseCols(sb);
  const a = await app({ supabase: sb, session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  await settle();
  a.run("setJournalTab('calendar')");
  const out = () => a.elements.get('journalSection').innerHTML;
  assert.equal(a.state.periodReviewsError, '');
  assert.match(a.state.periodOverallError, /overall note columns yet: npx supabase db push/);
  a.run("openPeriodReview('week', '2026-10-05')");
  assert.match(out(), /Overall notes need a database update: the database doesn&#39;t have the overall note columns yet: npx supabase db push\. Grades and the rest still save\./);
  assert.match(out(), /id="jwOverall-work_on"[^>]*disabled>/);
  assert.doesNotMatch(out(), /id="jwNote-exit"[^>]*disabled/, 'the parts\' notes still work');
  a.run("periodTextSave('work_on', 'x')");
  a.run("setPeriodGrade('exit', 'B')");
  await settle();
  assert.deepEqual(sb.writes.filter(w => w.table === 'period_reviews').map(w => w.exit_grade), ['B'], 'only the grade went out');
});

test('last week\'s rule shows on top with Kept it?, saved on this week', async () => {
  const { run, out, supabase } = await journal({ periods: [{ unit: 'week', period_key: '2026-09-28', rule_next: 'Size down after a loss' }] });
  run("openPeriodReview('week', '2026-10-05')");
  assert.match(out(), /<div class="jw-rule-label">Last week's rule<\/div><p class="jw-rule-text">Size down after a loss<\/p>[\s\S]*?Kept it\?<\/span><button class="filter-btn" aria-pressed="false" data-action="setRuleKept" data-arg="yes">Yes<\/button>/);
  run("setRuleKept('partly')");
  await settle();
  assert.equal(supabase.tables.period_reviews.get('user-1:week:2026-10-05').rule_kept, 'partly');
  assert.match(out(), /aria-pressed="true" data-action="setRuleKept" data-arg="partly"/);
  run("setRuleKept('partly')");
  await settle();
  assert.equal(supabase.tables.period_reviews.get('user-1:week:2026-10-05').rule_kept, null, 'tapping the lit one clears it');
  assert.equal(supabase.tables.period_reviews.get('user-1:week:2026-09-28').rule_next, 'Size down after a loss', 'last week\'s row is left alone');
});

test('a save Supabase refuses goes back with a toast; a week not over yet asks nothing', async () => {
  const a = await journal({ opts: { clock: true, now: Date.parse('2026-10-09T18:00:00Z') } });
  assert.doesNotMatch(a.out(), /jc-rev/, 'Friday at 2pm: the week of Oct 5 is still going');
  a.run("openPeriodReview('week', '2026-10-05')");
  a.supabase.fail();
  a.run("setPeriodGrade('exit', 'A')");
  assert.match(a.out(), /<option value="A" selected>A<\/option>/, 'shown at once');
  await settle();
  assert.match(a.elements.get('errorBox').textContent, /Couldn't save the review: nope/);
  assert.doesNotMatch(a.out(), /<option value="A" selected>/, 'and put back');
  assert.equal(a.state.periodReviews['week|2026-10-05'].exit_grade, null);
});

test('before the migration is pushed the numbers still show and the grades say the database needs a push', async () => {
  const { run, out, state, supabase } = await journal({ broken: true });
  assert.match(state.periodReviewsError, /npx supabase db push/);
  assert.doesNotMatch(out(), /jc-rev/, 'no marks it can\'t keep');
  run("openPeriodReview('week', '2026-10-05')");
  await settle();
  assert.match(out(), /Grades and notes need a database update: the database doesn&#39;t have the period_reviews table yet: npx supabase db push\. The numbers still work\./);
  assert.match(out(), /Kept 43% of the best move on 1 winner/, 'the numbers');
  assert.match(out(), /id="jwGrade-exit"[^>]*disabled>/);
  assert.match(out(), /id="jwRuleNext"[^>]*disabled \/>/);
  run("setPeriodGrade('exit', 'A')");
  await settle();
  assert.equal(supabase.writes.filter(w => w.table === 'period_reviews').length, 0, 'nothing written');
  assert.ok(state.tradeReviews && !state.journalError, 'the rest of the journal loaded');
});
