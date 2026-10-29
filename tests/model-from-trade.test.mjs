// Run with: node --test
// Add to model book on a Journal trade page: the form at the end of the Review section, filled in from the trade (its
// name, setups, day and notes), keeps one of the trade's screenshots (copied by Storage into the model-books bucket) with
// the trade's key; the example links back to the trade from Model books, and the row lists what's been kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const ENTRY = {
  orderId: 501, enteredTime: '2026-10-01T14:30:00+0000', status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction: 'BUY', quantity: 100, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7001, executionLegs: [{ legId: 1, quantity: 100, price: 100.02, time: '2026-10-01T14:30:01+0000' }] }],
  childOrderStrategies: [{
    orderId: 502, status: 'FILLED', orderType: 'STOP', stopPrice: 95,
    orderLegCollection: [{ legId: 1, instruction: 'SELL', quantity: 100, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7002, executionLegs: [{ legId: 1, quantity: 100, price: 94.98, time: '2026-10-02T15:00:00+0000' }] }],
  }],
};
const KEY = '6789|AAPL|long|2026-10-01T14:30:01.000Z';
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
const PREPARE = "effects.prepareImage = async f => ({ blob: { size: 180000 }, type: 'image/webp', width: 1600, height: 900 })";
const png = "{ type: 'image/png', size: 900000, name: 'shot.png' }";

async function page(tweak) {
  const supabase = fakeRecords([{ kind: 'order', record_id: '501', account: '6789', entered_at: '2026-10-01T14:30:00Z', data: ENTRY }]);
  if (tweak) tweak(supabase);
  const a = await app({ supabase, session: SESSION });
  a.run(PREPARE);
  a.run("setView('journal')");
  await a.run('loadJournal()');
  a.run(`openJournalTrade('${KEY}')`);
  await settle();
  const t = 'journalPageTrade()';
  return {
    ...a, supabase, t,
    body: () => a.elements.get('jtBody').innerHTML,
    shots: () => [...supabase.tables.trade_shots.values()],
    examples: () => [...supabase.tables.model_examples.values()],
    toast: () => a.elements.get('errorBox').textContent,
    addShot: async () => { await a.run(`addTradeShots(${t}, [${png}])`); await settle(); },
  };
}

test('Add to model book fills the form from the trade, and saving copies its screenshot with the trade linked', async () => {
  const p = await page();
  assert.match(p.body(), /<div class="jr-label">Model books<span class="jr-sub">keep a chart of this trade to study<\/span><\/div>/);
  assert.match(p.body(), /data-action="addTradeToModelBook">\+ Add to model book<\/button>/);
  await p.run(`toggleReviewLabel(${p.t}, 'setup', 'base_breakout')`);
  await p.run(`reviewNoteSave(${p.t}, 'Bought the break of the base', 'entry')`);
  await p.run(`reviewNoteSave(${p.t}, 'Stopped on the flush', 'exit')`);

  await p.run('addTradeToModelBook()');
  await settle();
  const d = p.run('modelBooks.draft');
  assert.equal(d.trade_key, KEY);
  assert.equal(d.title, 'AAPL · Base breakout · 10/1');
  assert.equal(d.notes, 'Bought the break of the base\n\nStopped on the flush');
  assert.deepEqual([...d.setup_keys], ['base_breakout']);
  assert.match(p.body(), /<input id="modelTradeTitle"[^>]*value="AAPL · Base breakout · 10\/1"/);
  assert.match(p.body(), /<textarea id="modelTradeNotes"[^>]*>Bought the break of the base\n\nStopped on the flush<\/textarea>/);
  assert.match(p.body(), /class="filter-btn active" aria-pressed="true" data-action="toggleModelSetup" data-arg="base_breakout"/);
  // no screenshot on the trade yet: it says so, and Save waits for one
  assert.match(p.body(), /Add a screenshot of this trade above first: the example keeps a copy of it\./);
  assert.match(p.body(), /data-action="saveModelExample" disabled>Save to model book/);

  await p.addShot();
  const [shot] = p.shots();
  assert.match(p.body(), new RegExp(`class="jr-shot active" aria-pressed="true" data-action="pickTradeExampleShot" data-arg="${shot.id}"`), 'picked for you');
  p.run("modelExampleField('title', 'AAPL base breakout that failed')");
  await p.run('saveModelExample()');
  await settle();

  const copy = p.supabase.storageOps.find(o => o.op === 'copy');
  assert.deepEqual([copy.bucket, copy.from, copy.destinationBucket], ['trade-shots', shot.path, 'model-books']);
  assert.match(copy.to, /^user-1\/[\da-f-]+\.webp$/, 'into your folder of model-books');
  assert.ok(!p.supabase.storageOps.some(o => o.op === 'upload' && o.bucket === 'model-books'), 'copied, not uploaded again');
  const [row] = p.examples();
  assert.deepEqual([row.trade_key, row.path, row.width, row.height, row.bytes, row.book_id, row.title], [KEY, copy.to, 1600, 900, 180000, null, 'AAPL base breakout that failed']);
  assert.deepEqual([...row.setup_keys], ['base_breakout']);
  assert.equal(row.notes, 'Bought the break of the base\n\nStopped on the flush');
  assert.equal(p.run('modelBooks.draft'), null);
  assert.match(p.toast(), /Added to Model books\./);
  assert.match(p.body(), new RegExp(`data-action="openTradeExample" data-arg="${row.id}">AAPL base breakout that failed</button><span class="mb-meta">No book</span>`), 'the row lists it');
  assert.match(p.body(), /data-action="addTradeToModelBook">\+ Add to model book/, 'and offers another');
});

test('pick a book and another of the trade’s screenshots; the toast names the book', async () => {
  const p = await page();
  p.run("modelBooks.owner = 'user-1'; modelBooks.loaded = true; modelBooks.books = [{ id: 'b1', name: 'Best longs', description: '' }]");
  await p.addShot(); await p.addShot();
  const [, second] = p.shots();
  await p.run('addTradeToModelBook()');
  assert.match(p.body(), /<select id="modelTradeBook"[^>]*><option value="" selected>No book<\/option><option value="b1">Best longs<\/option>/);
  p.run(`pickTradeExampleShot('${second.id}'); modelExampleField('book_id', 'b1')`);
  assert.match(p.body(), new RegExp(`class="jr-shot active" aria-pressed="true" data-action="pickTradeExampleShot" data-arg="${second.id}"`));
  await p.run('saveModelExample()');
  await settle();
  assert.equal(p.supabase.storageOps.find(o => o.op === 'copy').from, second.path);
  assert.equal(p.examples()[0].book_id, 'b1');
  assert.match(p.toast(), /Added to Best longs\./);
  assert.match(p.body(), /<span class="mb-meta">Best longs<\/span>/);
});

test('Model books links the example back to its trade, and the trade page opens the example there', async () => {
  const p = await page();
  await p.addShot();
  await p.run('addTradeToModelBook()');
  await p.run('saveModelExample()');
  await settle();
  const [row] = p.examples();

  p.run(`openTradeExample('${row.id}')`);
  await settle();
  assert.equal(p.run('journalTrade'), null, 'the trade page closes');
  assert.equal(p.run('journalTab'), 'books');
  assert.equal(p.run('modelBooks.viewerId'), row.id, 'with the example open full size');
  const books = p.elements.get('modelBooksBody').innerHTML;
  assert.match(books, new RegExp(`From <button class="pos-link" data-action="openModelTrade" data-arg="${KEY.replace(/[|.]/g, '\\$&')}">AAPL · Long · 10/1</button>`));

  p.run(`closeModelImage(); openJournalTrade('${KEY}')`);
  await settle();
  assert.equal(p.run('journalTrade.key'), KEY);
});

test('leaving the trade drops its form; a Books draft open elsewhere keeps the button off', async () => {
  const p = await page();
  await p.addShot();
  await p.run('addTradeToModelBook()');
  assert.ok(p.run('modelBooks.draft'));
  p.run('closeJournalTrade()');
  assert.equal(p.run('modelBooks.draft'), null);

  p.run(`openJournalTrade('${KEY}')`);
  await settle();
  p.run("modelBooks.draft = { book_id: '', title: '', notes: '', setup_keys: [], image: {} }; renderJournalTrade()");
  assert.match(p.body(), /data-action="addTradeToModelBook" disabled title="Save or cancel the example open in Model books first">/);
  await p.run('addTradeToModelBook()');
  assert.match(p.toast(), /Save or cancel the example open in Model books first\./);
  assert.equal(p.run('modelBooks.draft.trade_key'), undefined, 'the Books draft is left alone');
});

test('a refused row takes the copied file back out; before the migration, Model books still reads and the row says why', async () => {
  const p = await page();
  await p.addShot();
  await p.run('addTradeToModelBook()');
  p.supabase.failTable('model_examples');
  await p.run('saveModelExample()');
  await settle();
  const copy = p.supabase.storageOps.find(o => o.op === 'copy');
  assert.ok(p.supabase.storageOps.some(o => o.op === 'remove' && o.bucket === 'model-books' && o.paths[0] === copy.to), 'the copy is removed');
  assert.ok(p.run('modelBooks.draft'), 'the form stays to try again');
  assert.match(p.body(), /Couldn(?:'|&#39;)t save the example/);

  const old = await page(s => s.failColumn('model_examples', 'trade_key'));
  assert.equal(old.run('modelBooks.loaded'), true, 'read without the new column');
  assert.match(old.body(), /Adding a trade to a model book needs a database update: npx supabase db push/);
  assert.doesNotMatch(old.body(), /data-action="addTradeToModelBook"/);
});
