import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const SESSION = { user: { id: 'user-1' } };
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
async function books() {
  const supabase = fakeRecords();
  const a = await app({ supabase, session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  a.run("setJournalTab('books')");
  await a.run('loadModelBooks()');
  a.api.effects.prepareImage = async () => ({ blob: new Blob(['chart']), type: 'image/webp', width: 1600, height: 900 });
  return { ...a, supabase, body: () => a.elements.get('modelBooksBody').innerHTML };
}
async function addBook(a, name = 'Long setups') {
  a.run('editModelBook()');
  a.run(`modelBookField('name', ${JSON.stringify(name)})`);
  a.run("modelBookField('description', 'Charts worth studying')");
  await a.run('saveModelBook()');
  return [...a.supabase.tables.model_books.values()].at(-1);
}
async function example(a, title = 'NVDA tightening above the 50 SMA') {
  await a.run("pasteModelImages([{ type: 'image/png', size: 1200 }])");
  a.run(`modelExampleField('title', ${JSON.stringify(title)})`);
  a.run("modelExampleField('notes', 'Higher lows into the pivot'); toggleModelSetup('base_breakout')");
  await a.run('saveModelExample()');
  await settle();
  return [...a.supabase.tables.model_examples.values()].at(-1);
}

test('Model Books is available inside Journal before any broker imports', async () => {
  const a = await books();
  assert.match(a.elements.get('journalSection').innerHTML, /Model books/);
  assert.equal(a.run('journalTab'), 'books');
  assert.match(a.body(), /New book/);
  assert.doesNotMatch(a.body(), /Connect Schwab/);
  assert.equal(a.supabase.table.size, 0);
});

test('create and rename a book, and paste a screenshot with notes and existing setup keys', async () => {
  const a = await books();
  const book = await addBook(a);
  assert.equal(book.description, 'Charts worth studying');
  const row = await example(a);
  assert.equal(row.book_id, book.id);
  assert.deepEqual([...row.setup_keys], ['base_breakout']);
  assert.equal(row.notes, 'Higher lows into the pivot');
  const upload = a.supabase.storageOps.find(o => o.op === 'upload');
  assert.equal(upload.bucket, 'model-books');
  assert.match(upload.path, /^user-1\/[\da-f-]+\.webp$/);
  assert.match(a.body(), /NVDA tightening/);
  assert.match(a.body(), /Base breakout/);
  assert.match(a.body(), /https:\/\/fake.storage.test\/model-books/);
  a.run(`editModelBook('${book.id}'); modelBookField('name', 'Best longs')`);
  await a.run('saveModelBook()');
  assert.equal([...a.supabase.tables.model_books.values()][0].name, 'Best longs');
});

test('setup browsing spans books and follows renames and merges in My setups', async () => {
  const a = await books();
  await addBook(a, '2026 examples'); await example(a, 'NVDA model');
  await addBook(a, 'Historical examples'); await example(a, 'SMCI model');
  a.run("journalReview.library = [{ id: 'rename', kind: 'setup', default_key: 'base_breakout', name: 'My breakout', merged_into: 'sma50_bounce' }, { id: 'bounce', kind: 'setup', default_key: 'sma50_bounce', name: 'My 50 day bounce' }]");
  a.run("selectModelSetup('sma50_bounce')");
  assert.match(a.body(), /NVDA model/);
  assert.match(a.body(), /SMCI model/);
  assert.match(a.body(), /My 50 day bounce/);
  a.run("modelBooks.draft = null; selectModelBook(modelBooks.books[0].id)");
  assert.equal(a.run('modelBooks.setupKey'), '');
});

test('By setup lists every one of My setups, so the first example can start from a setup with none', async () => {
  const a = await books();
  await addBook(a);
  a.run("journalReview.library = [{ id: 'hide', kind: 'setup', default_key: 'earnings_gap', hidden: true }]");
  a.run("setModelBrowse('setups')");
  const nav = a.body().split('mb-nav-list')[1].split('</aside>')[0];
  assert.match(nav, /data-arg="ema21_bounce"><span>21 EMA bounce[^<]*<\/span><small>0<\/small>/);
  assert.doesNotMatch(nav, /earnings_gap/, 'a hidden setup without examples stays out');
  a.run("selectModelSetup('ema21_bounce')");
  assert.match(a.body(), /comes tagged with this setup/);
  await a.run("pasteModelImages([{ type: 'image/png', size: 1200 }])");
  assert.deepEqual([...a.run('modelBooks.draft.setup_keys')], ['ema21_bounce']);
});

test('edit notes, setup tags and book without uploading another copy of the screenshot', async () => {
  const a = await books();
  await addBook(a); const row = await example(a); const other = await addBook(a, 'Study later');
  a.run(`editModelExample('${row.id}'); modelExampleField('book_id', '${other.id}'); modelExampleField('notes', 'Updated observation'); toggleModelSetup('sma50_bounce')`);
  await a.run('saveModelExample()');
  const updated = [...a.supabase.tables.model_examples.values()][0];
  assert.equal(updated.notes, 'Updated observation');
  assert.equal(updated.book_id, other.id);
  assert.deepEqual([...updated.setup_keys], ['base_breakout', 'sma50_bounce']);
  assert.equal(a.supabase.storageOps.filter(o => o.op === 'upload').length, 1);
});

test('a failed example save removes the upload, keeps the draft and permits retry', async () => {
  const a = await books();
  await addBook(a);
  a.supabase.failTable('model_examples');
  await example(a);
  assert.equal(a.supabase.files.size, 0);
  assert.equal(a.supabase.tables.model_examples.size, 0);
  assert.ok(a.run('modelBooks.draft'), 'draft retained after failure');
  assert.match(a.body(), /Couldn&#39;t save|Couldn’t save|Couldn't save/);
});

test('an account change while preparing an image never saves it under the new account', async () => {
  const a = await books(); await addBook(a);
  let finish;
  a.api.effects.prepareImage = () => new Promise(r => { finish = r; });
  const pending = a.run("pasteModelImages([{ type: 'image/png', size: 1200 }])");
  await settle();
  a.run("session = { user: { id: 'user-2' } }");
  finish({ blob: new Blob(['chart']), type: 'image/webp', width: 1600, height: 900 });
  await pending;
  assert.equal(a.supabase.storageOps.filter(o => o.op === 'upload').length, 0);
  assert.equal(a.run('modelBooks.draft'), null);
});

test('deletion asks first; an example removes its file, and a populated book cannot be deleted', async () => {
  const a = await books(); const book = await addBook(a); const row = await example(a);
  await a.run(`deleteModelBook('${book.id}')`);
  assert.equal(a.supabase.tables.model_books.size, 1);
  await a.run(`deleteModelExample('${row.id}')`);
  assert.equal(a.supabase.tables.model_examples.size, 1);
  await a.run(`deleteModelExample('${row.id}')`);
  assert.equal(a.supabase.tables.model_examples.size, 0);
  assert.equal(a.supabase.files.size, 0);
  await a.run(`deleteModelBook('${book.id}')`);
  await a.run(`deleteModelBook('${book.id}')`);
  assert.equal(a.supabase.tables.model_books.size, 0);
});

test('paste is scoped to Model Books and text pastes are left alone', async () => {
  const a = await books(); await addBook(a);
  a.run('initModelBookEvents()');
  let prevented = false;
  a.dispatch('paste', { clipboardData: { files: [{ type: 'image/png', size: 20 }] }, preventDefault() { prevented = true; } });
  await settle();
  assert.equal(prevented, true);
  assert.ok(a.run('modelBooks.draft'));
  a.dispatch('paste', { clipboardData: { files: [] }, preventDefault() { throw new Error('text must paste normally'); } });
  a.run("cancelModelDraft(); journalTab = 'trades'");
  a.dispatch('paste', { clipboardData: { files: [{ type: 'image/png' }] }, preventDefault() { throw new Error('other tabs own their pastes'); } });
  assert.equal(a.run('modelBooks.draft'), null);
});

test('expired image links are renewed, and the full-size viewer can be closed', async () => {
  const a = await books(); await addBook(a); const row = await example(a);
  const before = a.supabase.storageOps.filter(o => o.op === 'sign').length;
  a.run(`modelBooks.urls[${JSON.stringify(row.path)}].expires = 0`);
  await a.run('refreshModelImages()');
  assert.equal(a.supabase.storageOps.filter(o => o.op === 'sign').length, before + 1);
  a.run(`openModelImage('${row.id}')`);
  assert.match(a.body(), /<dialog[^>]*id="modelImageViewer"/);
  a.run('closeModelImage()');
  assert.doesNotMatch(a.body(), /<dialog/);
  a.run(`openModelImage('${row.id}'); setView('calc')`);
  assert.equal(a.run('modelBooks.viewerId'), '', 'leaving Journal closes its modal');
});

test('an invalid draft cannot upload; a missing migration gives a recoverable error', async () => {
  const a = await books(); await addBook(a);
  await a.run("pasteModelImages([{ type: 'image/png', size: 20 }])");
  await a.run('saveModelExample()');
  assert.match(a.body(), /Give this example a title/);
  assert.equal(a.supabase.storageOps.filter(o => o.op === 'upload').length, 0);
  const s = fakeRecords(); s.failTable('model_books');
  const b = await app({ supabase: s, session: SESSION });
  b.run("setView('journal'); setJournalTab('books')");
  await b.run('loadModelBooks()');
  assert.match(b.elements.get('modelBooksBody').innerHTML, /Model Books isn&#39;t available yet/);
  assert.match(b.elements.get('modelBooksBody').innerHTML, /data-action="loadModelBooks"/);
});
