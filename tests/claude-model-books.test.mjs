// Run with: node --test
// Claude access to Model books (docs/claude-access.md): the claude-model-example Edge Function (the image read from its
// own bytes, the row added with the key check, the file uploaded, the row taken back when Storage refuses), a book or an
// example described in words turned into the save's changes, and the script's books commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle, imageInfo, MODEL_IMAGE_BYTES } from '../supabase/functions/claude-model-example/handler.js';
import { bookBy, booksFrom, booksText, exampleBy, planBook, planExample } from '../scripts/model-books-lib.mjs';

// ---------- images, from their own bytes ----------

const bytes = (...parts) => Uint8Array.from(parts.flatMap(p => typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : p));
const be32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = n => [(n >> 8) & 255, n & 255];
const le24 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const PNG = (w, h) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), 'IHDR', be32(w), be32(h), [8, 6, 0, 0, 0], be32(0));
const JPEG = (w, h) => bytes([0xff, 0xd8, 0xff, 0xe0], be16(16), 'JFIF', [0, 1, 1, 0, 0, 1, 0, 1, 0, 0], [0xff, 0xc0], be16(17), [8], be16(h), be16(w), [3], new Array(12).fill(0));
const WEBP = (chunk, body) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', chunk, [10, 0, 0, 0], body, new Array(8).fill(0));

test('an image is read from its own bytes: PNG, JPEG, the three WebP kinds; anything else, or over 2 MB, is refused', () => {
  assert.deepEqual(imageInfo(PNG(1600, 900)), { type: 'image/png', ext: 'png', width: 1600, height: 900 });
  assert.deepEqual(imageInfo(JPEG(1280, 720)), { type: 'image/jpeg', ext: 'jpg', width: 1280, height: 720 });
  assert.deepEqual(imageInfo(WEBP('VP8X', [0, 0, 0, 0, ...le24(1999), ...le24(1124)])), { type: 'image/webp', ext: 'webp', width: 2000, height: 1125 });
  const w = 1599, h = 899; // VP8L: 14 bits each, less one
  assert.deepEqual(imageInfo(WEBP('VP8L', [0x2f, w & 255, ((w >> 8) & 0x3f) | ((h & 3) << 6), (h >> 2) & 255, (h >> 10) & 0x0f])), { type: 'image/webp', ext: 'webp', width: 1600, height: 900 });
  assert.deepEqual(imageInfo(WEBP('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 1200 & 255, 1200 >> 8, 675 & 255, 675 >> 8])), { type: 'image/webp', ext: 'webp', width: 1200, height: 675 });
  assert.match(imageInfo(bytes('GIF89a', new Array(30).fill(0))), /PNG, JPEG, or WebP/);
  assert.match(imageInfo(PNG(0, 900)), /size/);
  assert.match(imageInfo(new Uint8Array(MODEL_IMAGE_BYTES + 1)), /2 MB at most/);
  assert.match(imageInfo(new Uint8Array(0)), /No image/);
});

// ---------- the Edge Function ----------

const ENV = { SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' };
const b64 = b => Buffer.from(b).toString('base64');
const post = body => new Request('https://db.example/functions/v1/claude-model-example', { method: 'POST', body: JSON.stringify(body) });
const EXAMPLE = { book_id: 'b1', title: 'EMA 21 reclaim', notes: 'held the 21', setup_keys: ['ema21_bounce'] };
/** a fetch that answers the add and the upload, and records every call */
function server({ add = 200, upload = 200 } = {}) {
  const calls = [];
  const send = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (url.endsWith('/rpc/claude_model_example_add')) return add === 200
      ? Response.json({ user_id: 'user-1', id: 'ex-1', path: 'user-1/ex-1.png' })
      : Response.json({ code: '28000', message: 'not a Claude key' }, { status: add });
    if (url.includes('/storage/v1/object/')) return upload === 200 ? Response.json({ Key: 'model-books/user-1/ex-1.png' }) : Response.json({ message: 'The resource already exists' }, { status: upload });
    return new Response('', { status: 204 });
  };
  return { calls, send };
}
const run = (body, srv, env = ENV) => handle(post(body), { env: k => env[k], fetch: srv.send });

test('the function adds the row with the key check, then uploads the file to the owner\'s folder', async () => {
  const srv = server();
  const res = await run({ key: 'scj_key', example: EXAMPLE, image: b64(PNG(1600, 900)) }, srv);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: 'ex-1', path: 'user-1/ex-1.png', type: 'image/png', width: 1600, height: 900, bytes: PNG(1600, 900).length });
  const [add, upload] = srv.calls;
  assert.deepEqual(JSON.parse(add.body), { p_key: 'scj_key', p_example: { ...EXAMPLE, ext: 'png', width: 1600, height: 900, bytes: PNG(1600, 900).length } }, 'the size and type it read, never the caller\'s');
  assert.deepEqual(add.headers.apikey, 'sb_secret_test');
  assert.equal(add.headers.Authorization, undefined, 'a secret key goes as the apikey alone');
  assert.equal(upload.url, 'https://db.example/storage/v1/object/model-books/user-1/ex-1.png');
  assert.equal(upload.headers['Content-Type'], 'image/png');
  assert.equal(upload.headers['x-upsert'], 'false');
  assert.deepEqual([...upload.body], [...PNG(1600, 900)]);

  const jwt = server();
  await run({ key: 'scj_key', example: EXAMPLE, image: b64(PNG(10, 10)) }, jwt, { ...ENV, SUPABASE_SERVICE_ROLE_KEY: 'eyJservice' });
  assert.equal(jwt.calls[0].headers.Authorization, 'Bearer eyJservice', 'a legacy service_role JWT goes as the bearer too');
});

test('the function: a wrong key or a bad image never reaches Storage; a refused upload takes the row back', async () => {
  const wrong = server({ add: 403 });
  const res = await run({ key: 'scj_nope', example: EXAMPLE, image: b64(PNG(10, 10)) }, wrong);
  assert.equal(res.status, 401);
  assert.match((await res.json()).message, /not a Claude key/);
  assert.equal(wrong.calls.length, 1, 'no upload');

  for (const body of [{ example: EXAMPLE, image: b64(PNG(10, 10)) }, { key: 'k', example: EXAMPLE, image: b64(bytes('GIF89a', new Array(30).fill(0))) }, { key: 'k', example: EXAMPLE }, { key: 'k', image: b64(PNG(10, 10)) }]) {
    const srv = server();
    const r = await run(body, srv);
    assert.ok(r.status === 400 || r.status === 401, JSON.stringify(body).slice(0, 60));
    assert.equal(srv.calls.length, 0, 'nothing sent');
  }
  assert.equal((await handle(new Request('https://db.example/x'), { env: k => ENV[k], fetch: server().send })).status, 405);
  assert.equal((await run({ key: 'k', example: EXAMPLE, image: b64(PNG(10, 10)) }, server(), {})).status, 500, 'no service key');

  const refused = server({ upload: 409 });
  const r = await run({ key: 'scj_key', example: EXAMPLE, image: b64(PNG(10, 10)) }, refused);
  assert.equal(r.status, 502);
  assert.match((await r.json()).message, /Storage refused the screenshot \(409\): The resource already exists/);
  const undo = refused.calls[2];
  assert.deepEqual([undo.method, undo.url], ['DELETE', 'https://db.example/rest/v1/model_examples?user_id=eq.user-1&id=eq.ex-1']);
});

// ---------- a book or an example in words ----------

const BOOK = { id: 'b1000000-0000-4000-8000-000000000000', name: 'Best longs', description: 'A+ only', created_at: '2026-10-01T00:00:00Z' };
const OTHER = { id: 'b2000000-0000-4000-8000-000000000000', name: 'Failed breakouts', description: '', created_at: '2026-10-02T00:00:00Z' };
const EX = { id: 'e1000000-0000-4000-8000-000000000000', book_id: BOOK.id, title: 'NVDA reclaim', notes: 'Held VWAP', setup_keys: ['ema21_bounce'], width: 1600, height: 900, bytes: 1000, created_at: '2026-10-10T00:00:00Z' };
const BOOKS = { books: [BOOK, OTHER], examples: [EX], library: [] };
let n = 0;
const opts = { newId: () => `new-${++n}` };

test('books in words: handles, examples under their book with setups by name, a book by name or handle', () => {
  const m = booksFrom(BOOKS);
  assert.equal(booksText(m), 'b1000000 · Best longs (1 example) · A+ only\n  e1000000 · NVDA reclaim · 21 EMA bounce / rejection · Held VWAP\nb2000000 · Failed breakouts (0 examples)');
  assert.equal(bookBy(m, 'best LONGS'), BOOK);
  assert.equal(bookBy(m, 'b20000'), OTHER);
  assert.equal(bookBy(m, 'b'), null, 'too short a handle');
  assert.equal(exampleBy(m, 'e1000000'), EX);
});

test('a book: new, renamed, the same changes nothing, a name you already have is refused', () => {
  const m = booksFrom(BOOKS);
  n = 0;
  assert.deepEqual(planBook(m, null, { name: ' Gap and go ', description: 'Opening drives' }, opts).changes.books, [{ id: 'new-1', name: 'Gap and go', description: 'Opening drives' }]);
  assert.deepEqual(planBook(m, BOOK, { name: 'Best longs ever' }).changes.books, [{ id: BOOK.id, name: 'Best longs ever', description: 'A+ only' }], 'the description stays');
  assert.deepEqual(planBook(m, BOOK, { name: 'Best longs' }).changes.books, []);
  assert.throws(() => planBook(m, BOOK, { name: 'failed breakouts' }), /already have a book called Failed breakouts/);
  assert.throws(() => planBook(m, null, {}), /name: needs one/);
  assert.throws(() => planBook(m, null, { name: 'x', color: 'red' }), /not color/);
});

test('a new example: its book by name (a new name makes it), setups matched or added to My setups', () => {
  const m = booksFrom(BOOKS);
  n = 0;
  const p = planExample(m, null, { book: 'failed breakouts', title: 'SPY fade', setups: ['21 EMA bounce', 'Opening range fade'] }, opts);
  assert.equal(p.add.book_id, OTHER.id);
  assert.deepEqual(p.add.setup_keys, ['ema21_bounce', 'mine:new-2'], 'a setup that isn\'t one becomes a pattern and the setup made of it');
  assert.deepEqual(p.library.map(r => [r.kind, r.name]), [['pattern', 'Opening range fade'], ['setup', 'Opening range fade']]);
  assert.deepEqual(p.changes, { books: [], examples: [] });

  const made = planExample(m, null, { book: 'Lotto plays', title: 'QQQ put' }, opts);
  assert.deepEqual(made.changes.books, [{ id: made.add.book_id, name: 'Lotto plays', description: '' }]);
  assert.deepEqual(made.said, ['New book: Lotto plays.']);

  assert.throws(() => planExample(m, null, { title: 'x' }), /book: which one\? Best longs, Failed breakouts/);
  assert.equal(planExample(booksFrom({ ...BOOKS, books: [BOOK] }), null, { title: 'x' }).add.book_id, BOOK.id, 'your one book by default');
  assert.throws(() => planExample(m, null, { book: 'Best longs' }), /title: needs one/);
  assert.throws(() => planExample(m, null, { book: 'Best longs', title: 'x'.repeat(121) }), /120 characters/);
  assert.throws(() => planExample(m, null, { book: 'Best longs', title: 'x', tags: [] }), /not tags/);
});

test('an example\'s change: only the fields that differ, moved by book name, setups replaced or cleared', () => {
  const m = booksFrom(BOOKS);
  assert.deepEqual(planExample(m, EX, { title: 'NVDA reclaim', setups: ['ema21_bounce'] }).changes.examples, [], 'the same changes nothing');
  assert.deepEqual(planExample(m, EX, { book: 'Failed breakouts', notes: null }).changes.examples, [{ id: EX.id, fields: { book_id: OTHER.id, notes: '' } }]);
  assert.deepEqual(planExample(m, EX, { setups: null }).changes.examples, [{ id: EX.id, fields: { setup_keys: [] } }]);
});

// ---------- the script ----------

const SCRIPT = fileURLToPath(new URL('../scripts/journal.mjs', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./helpers/journal-fetch.mjs', import.meta.url));
const KEY = 'scj_test_key_0123456789abcdefghijklmnop';
function script(args, { key = KEY, noFunction = false } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'books-')), 'fake.json');
  writeFileSync(file, JSON.stringify({ key: KEY, data: { library: [] }, books: { books: [BOOK, OTHER], examples: [EX] }, noFunction }));
  const env = { ...process.env, FAKE_JOURNAL: file, JOURNAL_KEY: key };
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'NODE_USE_ENV_PROXY']) delete env[k];
  const r = spawnSync(process.execPath, ['--import', PRELOAD, SCRIPT, ...args], { env, encoding: 'utf8' });
  return { ...r, fake: () => JSON.parse(readFileSync(file, 'utf8')) };
}
// <png> in the args: an image file written for the run
const withImage = (args, img = PNG(1600, 900), o = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'img-'));
  const file = join(dir, 'chart.png');
  writeFileSync(file, img);
  return script(args.map(a => a === '<png>' ? file : a), o);
};

test('the script: lists books, makes a book, adds an example with its screenshot, edits one; dry runs save nothing', () => {
  const list = script(['books']);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^b1000000 · Best longs \(1 example\)/);
  assert.match(script(['books', 'Failed breakouts']).stdout, /^b2000000 · Failed breakouts \(0 examples\)$/m);

  const book = script(['book', '{"name":"Gap and go"}']);
  assert.equal(book.status, 0, book.stderr);
  assert.equal(book.fake().saves[0].books[0].name, 'Gap and go');
  assert.match(book.stdout, /^Saved\. New book: Gap and go\./);

  const dry = withImage(['add-example', '<png>', '{"book":"Best longs","title":"AMD reclaim","setups":["21 EMA bounce"]}', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.fake().added, undefined);
  assert.match(dry.stdout, /image\/png 1600×900/);

  const add = withImage(['add-example', '<png>', '{"book":"Best longs","title":"AMD reclaim","notes":"Second test held","setups":["21 EMA bounce","Opening range fade"]}']);
  assert.equal(add.status, 0, add.stderr);
  const fake = add.fake();
  assert.deepEqual(fake.saves.map(s => s.library?.map(r => r.kind)), [['pattern', 'setup']], 'the new setup saved first');
  assert.equal(fake.added.length, 1);
  assert.deepEqual({ ...fake.added[0], image: undefined }, { book_id: BOOK.id, title: 'AMD reclaim', notes: 'Second test held', setup_keys: ['ema21_bounce', `mine:${fake.library[1].id}`], image: undefined });
  assert.equal(fake.added[0].image, Buffer.from(PNG(1600, 900)).toString('base64').length);
  assert.match(add.stdout, /Saved\. e0000001 · AMD reclaim · 21 EMA bounce \/ rejection, Opening range fade · Second test held in Best longs\./);

  const edit = script(['example', 'e1000000', '{"title":"NVDA VWAP reclaim","book":"Failed breakouts"}']);
  assert.equal(edit.status, 0, edit.stderr);
  assert.deepEqual(edit.fake().saves, [{ fn: 'claude_model_books_save', books: [], examples: [{ id: EX.id, fields: { book_id: OTHER.id, title: 'NVDA VWAP reclaim' } }] }]);
  assert.match(edit.stdout, /Saved\. e1000000 · NVDA VWAP reclaim/);
});

test('the script: an image that isn\'t one, too big, a missing function or a wrong key say so', () => {
  const big = withImage(['add-example', '<png>', '{"book":"Best longs","title":"x"}'], new Uint8Array(MODEL_IMAGE_BYTES + 1));
  assert.equal(big.status, 1);
  assert.match(big.stderr, /2 MB at most\. Shrink it first/);
  const gif = withImage(['add-example', '<png>', '{"book":"Best longs","title":"x"}'], bytes('GIF89a', new Array(30).fill(0)));
  assert.match(gif.stderr, /PNG, JPEG, or WebP/);
  assert.match(script(['add-example', '/nowhere/chart.png', '{"title":"x"}']).stderr, /Can't read \/nowhere\/chart\.png: ENOENT/);
  const missing = withImage(['add-example', '<png>', '{"book":"Best longs","title":"x"}'], PNG(10, 10), { noFunction: true });
  assert.match(missing.stderr, /isn't deployed yet: npx supabase functions deploy claude-model-example --no-verify-jwt/);
  assert.match(script(['books'], { key: 'scj_someone_elses_key_0123456789abcdefgh' }).stderr, /refused the key/);
  assert.match(script(['example', 'e9999999', '{"title":"x"}']).stderr, /No example e9999999/);
});
