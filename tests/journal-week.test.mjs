// Run with: node --test
// Week and month reviews (journal step 3, slice 6, part 1): a period's numbers per part of a self-assessment (selection,
// entry, exits, risk, emotions, market, preparation, consistency), against the period before, and the review panel the
// calendar opens for a week or a month, with exit efficiency from the trades' saved 5-minute bars.
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
    'Setup grades: 1 A++, 1 A, 1 B, 1 C',
    '[good] Best setup: 21 EMA bounce: 2 trades, +$700.00 (+3.0R)',
    '[bad] Worst setup: Base breakout: 1 trade, −$350.00 (−1.8R)',
    '1 trade with no setup labeled',
  ]);
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
    'A++ and A trades +$700.00 over 2; C and below −$350.00 over 1',
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

async function journal() {
  const supabase = fakeRecords(RECORDS);
  // AAPL's bars on its day: it reached $107 before the $103 exit
  supabase.bars.set('user-1:AAPL:2026-10-05', { user_id: 'user-1', symbol: 'AAPL', day: '2026-10-05', bars: [['09:35', 100, 101, 99.5, 100.5, 1000], ['10:00', 100.5, 107, 100, 105, 1000], ['11:00', 104, 104, 102, 103, 1000]] });
  const a = await app({ supabase, session: SESSION });
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
  assert.match(panel, /<div class="jw-cat-name">Exit discipline<\/div><ul class="jw-facts"><li class="jw-bad">Kept 43% of the best move on 1 winner<\/li>/, '$300 of the $700 it reached');
  assert.match(panel, /Gave back over half the best move on 1 winner: AAPL/);
  assert.match(panel, /No 5-minute bars for 1 trade \(MSFT\)/);
  assert.match(panel, /<li class="jw-bad">2 trades with no stop: AAPL and MSFT<\/li>/, 'named in the order they opened');
  assert.match(panel, /<li class="">No more than 1 trade opened a day<\/li>/);
  assert.match(panel, /2 trades opened before 9:45: 1 won, \+\$200\.00/);
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
