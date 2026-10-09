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

test('nothing is granted to the anonymous role', () => {
  assert.doesNotMatch(sql, /grant[^;]*to[^;]*\banon\b/i);
  for (const t of tables) assert.match(sql, new RegExp(`revoke all on [^;]*public\\.${t}[^;]* from anon`, 'i'), t);
});

test('functions that run with elevated rights fix their search path and are callable only by signed-in users', () => {
  const definers = [...sql.matchAll(/create function public\.(\w+)\(([^)]*)\)[^$]*?security definer[^$]*?\$\$/gi)];
  assert.ok(definers.length > 0);
  for (const [whole, name] of definers) {
    assert.match(whole, /set search_path = ''/i, `${name}: fixed search path`);
    assert.match(sql, new RegExp(`revoke execute on function [^;]*public\\.${name}\\(`, 'i'), `${name}: revoked from public`);
    assert.match(sql, new RegExp(`grant execute on function [^;]*public\\.${name}\\([^;]*to authenticated`, 'i'), `${name}: signed-in users only`);
  }
});
