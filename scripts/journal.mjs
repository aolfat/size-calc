#!/usr/bin/env node
// The journal from a Claude Code session (docs/claude-access.md): reads it with the Claude key in JOURNAL_KEY (made in
// the app's Settings, kept as an environment secret), saves reviews and adds to Model books. Only what the Claude
// functions allow: your trades, their reviews and your model books, never your settings, Tradier key or Schwab login.
//
//   node scripts/journal.mjs trades [--symbol QQQ] [--day 2026-10-23] [--todo] [--open] [--deleted] [--limit 20]
//   node scripts/journal.mjs show <handle or key>
//   node scripts/journal.mjs choices [kind]
//   node scripts/journal.mjs review <handle or key> '<json>' [--dry-run]
//   node scripts/journal.mjs day <YYYY-MM-DD> ['<json>'] [--dry-run]
//   node scripts/journal.mjs books [book]
//   node scripts/journal.mjs book [book] '<json>' [--dry-run]
//   node scripts/journal.mjs add-example <image file> '<json>' [--dry-run]
//   node scripts/journal.mjs example <handle> '<json>' [--dry-run]
//
// A review's JSON: market, marketFor ('day' | 'trade'), sector, setups, tactics, tags, mistakes (names or keys; each one
// given replaces that kind's labels), grade (A to F), plan (yes | partly | no), entryNote, exitNote, stop; null clears.
// A day's: grade (A to F), rules ({ name or key: kept | broke | null }), wentWell, workOn, note, focusNext,
// focusKept (yes | partly | no); null clears. A book's: name, description. An example's: book (optional: a name or handle; a new name makes the book), title, notes, setups.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { SUPABASE_KEY, SUPABASE_URL } from '../src/services/supabase.js';
import { imageInfo } from '../supabase/functions/claude-model-example/handler.js';
import { changesAnything, choicesText, dayDetail, findTrades, journalFrom, planDay, planReview, tradeBy, tradeDetail, tradeLine } from './journal-lib.mjs';
import { bookBy, booksFrom, booksText, exampleBy, exampleLine, planBook, planExample, shortId } from './model-books-lib.mjs';

// Node's fetch ignores HTTPS_PROXY unless told to (a cloud session's traffic goes through one): run again with it on
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
  process.exit(r.status ?? 1);
}

const fail = msg => { console.error(msg); process.exit(1); };

const MODEL_FUNCTION = 'claude-model-example';

/** a Claude function (rpc) or the Model books Edge Function, with the key */
async function call(fn, body, { edge = false } = {}) {
  const key = process.env.JOURNAL_KEY;
  if (!key) fail('No JOURNAL_KEY. Make a key in the app (Settings → Claude access) and add it to this environment as the JOURNAL_KEY secret.');
  let res;
  try {
    res = await fetch(edge ? `${SUPABASE_URL}/functions/v1/${fn}` : `${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(edge ? { key, ...body } : { p_key: key, ...body }),
    });
  } catch(e) {
    fail(`Couldn't reach Supabase (${e?.cause?.message || e.message}). If this is a cloud session, allow ${new URL(SUPABASE_URL).host} in the environment's network access.`);
  }
  const text = await res.text();
  let out = null;
  try { out = JSON.parse(text); } catch(e) {}
  if (res.ok) return out;
  const msg = out?.message || text || res.statusText;
  if (/not a Claude key/i.test(msg)) fail('Supabase refused the key: revoked, or not one of yours. Make a new one in Settings → Claude access.');
  if (edge && res.status === 404) fail(`The ${fn} function isn't deployed yet: npx supabase functions deploy ${fn} --no-verify-jwt`);
  if (res.status === 404 || /could not find the function/i.test(msg)) fail(`The database doesn't have ${/model/.test(fn) ? 'Claude access to Model books' : 'Claude access'} yet: npx supabase db push`);
  if (res.status === 403 && !out) fail(`Blocked before Supabase (${res.status}). If this is a cloud session, allow ${new URL(SUPABASE_URL).host} in the environment's network access.`);
  fail(`Supabase refused (${res.status}): ${msg}`);
}

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--symbol', '--day', '--limit'].includes(args[i - 1])));
const [cmd, ...rest] = positional;
// a JSON argument may come without a ref before it (book '<json>' makes a new book)
const [ref, json] = rest.length === 1 && /^\s*\{/.test(rest[0]) ? [undefined, rest[0]] : rest;
const parsed = what => {
  if (!json) fail(`What to save? A JSON ${what}, e.g. ${what === 'book' ? `'{"name":"Best longs"}'` : `'{"book":"Best longs","title":"EMA 21 reclaim","setups":["EMA 21 bounce"]}'`}`);
  try { return JSON.parse(json); } catch(e) { return fail(`Not JSON: ${e.message}`); }
};
const plan = make => { try { return make(); } catch(e) { return fail(e.message); } };

async function books() { return booksFrom(await call('claude_model_books_read', {})); }
/** library rows first (a new setup), then the books and examples */
async function saveBooks(p) {
  if (p.library?.length) await call('claude_journal_save', { p_changes: { library: p.library } });
  if (p.changes.books.length || p.changes.examples.length) await call('claude_model_books_save', { p_changes: p.changes });
}

async function journal() { return journalFrom(await call('claude_journal_read', {})); }
function trade(j) {
  if (!ref) fail('Which trade? Give its handle (from trades) or its key.');
  return tradeBy(j, ref) || fail(`No trade ${ref}. List them with: node scripts/journal.mjs trades`);
}

if (cmd === 'trades') {
  const j = await journal();
  const list = findTrades(j, { symbol: opt('symbol'), day: opt('day'), todo: flag('todo'), open: flag('open'), limit: Number(opt('limit')) || 20, deleted: flag('deleted') });
  console.log(list.length ? list.map(t => tradeLine(j, t)).join('\n') : 'No trades match.');
} else if (cmd === 'show') {
  const j = await journal();
  console.log(tradeDetail(j, trade(j)));
} else if (cmd === 'choices') {
  console.log(choicesText(await journal(), ref || ''));
} else if (cmd === 'review') {
  if (!json) fail("What to save? A JSON review, e.g. '{\"setups\":[\"Lotto\"],\"grade\":\"D\"}'");
  let input;
  try { input = JSON.parse(json); } catch(e) { fail(`Not JSON: ${e.message}`); }
  const j = await journal();
  const t = trade(j);
  let plan;
  try { plan = planReview(j, t, input); } catch(e) { fail(e.message); }
  if (plan.said.length) console.log(plan.said.join('\n'));
  if (!changesAnything(plan.changes)) { console.log('Nothing to change.'); process.exit(0); }
  if (flag('dry-run')) { console.log(JSON.stringify(plan.changes, null, 2)); process.exit(0); }
  await call('claude_journal_save', { p_changes: plan.changes });
  const after = await journal();
  console.log(`Saved. ${tradeDetail(after, tradeBy(after, t.key) || t)}`);
} else if (cmd === 'day') {
  if (!ref) fail('Which day? Give it as YYYY-MM-DD: day 2026-10-30');
  const j = await journal();
  if (!json) { console.log(dayDetail(j, ref)); process.exit(0); }
  const p = plan(() => planDay(j, ref, parsed('day review')));
  if (!changesAnything(p.changes)) { console.log('Nothing to change.'); process.exit(0); }
  if (flag('dry-run')) { console.log(JSON.stringify(p.changes, null, 2)); process.exit(0); }
  await call('claude_journal_save', { p_changes: p.changes });
  console.log(`Saved. ${dayDetail(await journal(), ref)}`);
} else if (cmd === 'books') {
  const m = await books();
  const book = ref ? bookBy(m, ref) || fail(`No book ${ref}. List them with: node scripts/journal.mjs books`) : null;
  console.log(booksText(m, book));
} else if (cmd === 'book') {
  const input = parsed('book');
  const m = await books();
  const book = ref ? bookBy(m, ref) || fail(`No book ${ref}. List them with: node scripts/journal.mjs books`) : null;
  const p = plan(() => planBook(m, book, input));
  if (!p.changes.books.length) { console.log('Nothing to change.'); process.exit(0); }
  if (flag('dry-run')) { console.log(JSON.stringify(p.changes, null, 2)); process.exit(0); }
  await saveBooks(p);
  console.log(`Saved. ${p.said.join(' ')}\n${booksText(await books(), p.book)}`);
} else if (cmd === 'add-example') {
  if (!ref) fail('Which screenshot? Give the image file: add-example <file> \'<json>\'');
  let bytes;
  try { bytes = readFileSync(ref); } catch(e) { fail(`Can't read ${ref}: ${e.code || e.message}`); }
  const info = imageInfo(bytes);
  if (typeof info === 'string') fail(`${info}${/MB/.test(info) ? ' Shrink it first, e.g. sips -Z 2000 -s format jpeg in.png --out out.jpg' : ''}`);
  const input = parsed('example');
  const m = await books();
  const p = plan(() => planExample(m, null, input));
  if (p.said.length) console.log(p.said.join('\n'));
  if (flag('dry-run')) { console.log(JSON.stringify({ library: p.library, ...p.changes, add: { ...p.add, image: `${info.type} ${info.width}×${info.height}, ${bytes.length} bytes` } }, null, 2)); process.exit(0); }
  await saveBooks(p);
  const added = await call(MODEL_FUNCTION, { example: p.add, image: Buffer.from(bytes).toString('base64') }, { edge: true });
  const after = await books();
  const e = exampleBy(after, added.id);
  const book = p.add.book_id ? bookBy(after, p.add.book_id)?.name : '';
  console.log(`Saved. ${e ? exampleLine(after, e) : shortId(added.id)}${book ? ` in ${book}` : ', no book'}.`);
} else if (cmd === 'example') {
  const input = parsed('example');
  const m = await books();
  if (!ref) fail('Which example? Give its handle (from books).');
  const ex = exampleBy(m, ref) || fail(`No example ${ref}. List them with: node scripts/journal.mjs books`);
  const p = plan(() => planExample(m, ex, input));
  if (p.said.length) console.log(p.said.join('\n'));
  if (!p.changes.examples.length && !p.library.length) { console.log('Nothing to change.'); process.exit(0); }
  if (flag('dry-run')) { console.log(JSON.stringify({ library: p.library, ...p.changes }, null, 2)); process.exit(0); }
  await saveBooks(p);
  const after = await books();
  console.log(`Saved. ${exampleLine(after, exampleBy(after, ex.id) || ex)}`);
} else {
  fail('node scripts/journal.mjs trades | show <trade> | choices [kind] | review <trade> <json> [--dry-run] | day <day> [<json>] [--dry-run]\n  | books [book] | book [book] <json> | add-example <image> <json> | example <example> <json> [--dry-run]');
}
