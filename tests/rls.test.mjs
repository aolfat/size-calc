// Run with: node --test
// Row-level security, checked from the migration files (no database needed). Supabase's publishable key is public,
// so these rules are the only thing between one user and another's data: every table must have them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const files = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
// comments out, so a commented-out policy doesn't count
const sql = files.map(f => readFileSync(join(DIR, f), 'utf8')).join('\n').replace(/--[^\n]*/g, '');
const tables = [...sql.matchAll(/create table (?:if not exists )?public\.(\w+)/gi)].map(m => m[1]);

test('migrations exist and create tables', () => {
  assert.ok(files.length > 0);
  assert.ok(tables.length > 0);
});

test('every table has row-level security turned on', () => {
  for (const t of tables) assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security`, 'i'), t);
});

test('every table has an owner rule for signed-in users, checked on read and on write', () => {
  for (const t of tables) {
    const policy = sql.match(new RegExp(`create policy \\w+ on public\\.${t}[^;]*;`, 'i'));
    assert.ok(policy, `${t} has no policy`);
    assert.match(policy[0], /to authenticated/i, `${t}: only signed-in users`);
    assert.match(policy[0], /using \(user_id = \(select auth\.uid\(\)\)\)/i, `${t}: rows are visible only to their owner`);
    assert.match(policy[0], /with check \(user_id = \(select auth\.uid\(\)\)\)/i, `${t}: rows can only be written as their owner`);
  }
});

test('every table carries its owner and is deleted with the account', () => {
  for (const t of tables) {
    const body = sql.match(new RegExp(`create table (?:if not exists )?public\\.${t} \\(([\\s\\S]*?)\\n\\);`, 'i'));
    assert.ok(body, t);
    assert.match(body[1], /user_id uuid not null default auth\.uid\(\) references auth\.users \(id\) on delete cascade/i, t);
  }
});

// Claude access (docs/claude-access.md): these take a key in place of a sign-in, so they're the one thing anon may run;
// each one checks the key before anything else, and the check itself is never callable
const KEYED = ['claude_journal_read', 'claude_journal_save', 'claude_model_books_read', 'claude_model_books_save'];
// these check a key too, but only the service role runs them: the Edge Function that uploads a Model books screenshot
const SERVICE_KEYED = ['claude_model_example_add'];
const KEY_CHECK = 'claude_key_user';

test('nothing is granted to the anonymous role but the functions that check a Claude key', () => {
  for (const [grant] of sql.matchAll(/grant[^;]*to[^;]*\banon\b[^;]*;/gi)) {
    const names = [...grant.matchAll(/public\.(\w+)\(/g)].map(m => m[1]);
    assert.match(grant, /^grant execute on function/i, `only functions: ${grant}`);
    assert.ok(names.length && names.every(n => KEYED.includes(n)), `only the keyed functions: ${grant}`);
  }
  for (const t of tables) assert.match(sql, new RegExp(`revoke all on [^;]*public\\.${t}[^;]* from anon`, 'i'), t);
});

test('a keyed function checks the key first, and the check is callable by no one', () => {
  for (const name of [...KEYED, ...SERVICE_KEYED]) {
    const fn = sql.match(new RegExp(`create or replace function public\\.${name}\\(p_key text[^)]*\\)[^$]*\\$\\$\\s*declare\\s*uid uuid := public\\.${KEY_CHECK}\\(p_key\\);`, 'i'));
    assert.ok(fn, `${name} starts with the key check`);
  }
  assert.match(sql, new RegExp(`revoke execute on function public\\.${KEY_CHECK}\\(text\\) from public, anon, authenticated`, 'i'));
  assert.doesNotMatch(sql, new RegExp(`grant[^;]*public\\.${KEY_CHECK}\\(`, 'i'));
});

test('a function only the service role runs is taken from everyone else and granted to it alone', () => {
  for (const name of SERVICE_KEYED) {
    assert.match(sql, new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\) from public, anon, authenticated`, 'i'), name);
    const grants = [...sql.matchAll(new RegExp(`grant[^;]*public\\.${name}\\([^;]*;`, 'gi'))].map(m => m[0]);
    assert.ok(grants.length && grants.every(g => /to service_role;$/i.test(g)), `${name}: service role only`);
  }
});

test('functions that run with elevated rights fix their search path and are callable only by signed-in users (or with a Claude key)', () => {
  const definers = [...sql.matchAll(/create (?:or replace )?function public\.(\w+)\(([^)]*)\)[^$]*?security definer[^$]*?\$\$/gi)];
  assert.ok(definers.length > 0);
  for (const [whole, name] of definers) {
    assert.match(whole, /set search_path = ''/i, `${name}: fixed search path`);
    assert.match(sql, new RegExp(`revoke execute on function [^;]*public\\.${name}\\(`, 'i'), `${name}: revoked from public`);
    if (name === KEY_CHECK || SERVICE_KEYED.includes(name)) continue; // checked above: no one, or the service role alone
    assert.match(sql, new RegExp(`grant execute on function [^;]*public\\.${name}\\([^;]*to ${KEYED.includes(name) ? 'anon, ' : ''}authenticated`, 'i'), `${name}: signed-in users only`);
  }
});

// Supabase keys its history on the version (the timestamp before the first _): two files sharing one means the second
// is refused at db push ('schema_migrations_pkey'), as 20261029000000 bars_source and statement_fills once were
test('every migration has a version of its own', () => {
  const versions = files.map(f => f.split('_')[0]);
  const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
  assert.deepEqual(dupes, [], `shared versions: ${dupes.join(', ')}`);
});

test('one baseline migration first, and every migration safe to run on a database that already has some of it', () => {
  assert.match(files[0], /_baseline\.sql$/, 'the schema starts from one baseline (docs/journal-step-2.md, slice 6)');
  assert.equal(files.filter(f => /_baseline\.sql$/.test(f)).length, 1, 'and only one: changes since are their own files after it, never edits to it');
  assert.doesNotMatch(sql, /create table public\./i, 'tables: create table if not exists');
  assert.doesNotMatch(sql, /create function /i, 'functions: create or replace');
  assert.doesNotMatch(sql, /create trigger /i, 'triggers: create or replace');
  assert.doesNotMatch(sql, /create index (?!if not exists)/i, 'indexes: if not exists');
  for (const [, name, table] of sql.matchAll(/create policy (\w+) on (public\.\w+)/gi)) {
    assert.match(sql, new RegExp(`drop policy if exists ${name} on ${table.replace('.', '\\.')}`, 'i'), `${name} is dropped first`);
  }
});

test('every synced setting is a key the settings table accepts', async () => {
  const { app } = await import('./helpers/app.mjs');
  const { run } = await app();
  const allowed = [...sql.matchAll(/constraint settings_key_check check \(key in \(([^)]*)\)\)/gi)].pop(); // the latest migration's list wins
  assert.ok(allowed, 'the settings key check');
  const keys = [...allowed[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  for (const k of JSON.parse(run('JSON.stringify(CLOUD_KEYS)'))) assert.ok(keys.includes(k), `${k} is allowed`);
  assert.ok(keys.includes('tradier_key_at'), 'and the key stamp the Vault functions write');
  assert.ok(keys.includes('schwab_login_at'), 'and the shared Schwab login\'s stamp');
});
