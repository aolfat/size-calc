#!/usr/bin/env node
// Database migrations over HTTPS, for places that can't reach Postgres directly (a Claude Code cloud session only gets
// out through an HTTPS proxy, which carries no raw TCP, so `npx supabase db push` can't connect there).
// Does what db push does through the Supabase Management API's SQL endpoint: reads which versions
// supabase_migrations.schema_migrations has, runs each newer file in supabase/migrations/ in its own transaction and
// records it there the same way the CLI does, so db push and this stay interchangeable.
// Needs SUPABASE_ACCESS_TOKEN (a personal access token from the Supabase dashboard, Account, Access tokens).
//
//   node scripts/migrate.mjs            what's applied, what's pending (changes nothing)
//   node scripts/migrate.mjs --apply    run the pending files, oldest first; stops at the first that fails
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

// Node's fetch ignores HTTPS_PROXY unless told to (a cloud session's traffic goes through one): run again with it on
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
  process.exit(r.status ?? 1);
}

const PROJECT_REF = 'dhohfavttsxwutanvcuj';
const DIR = new URL('../supabase/migrations/', import.meta.url);
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.error('SUPABASE_ACCESS_TOKEN is not set: make a personal access token in the Supabase dashboard (Account, Access tokens) and add it to the environment.');
  process.exit(1);
}

/** @param {string} query @param {boolean} [readOnly] */
async function sql(query, readOnly = false) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, read_only: readOnly }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  return JSON.parse(text);
}

/** A dollar-quoted literal whose tag the text doesn't contain. @param {string} text */
function quoted(text) {
  let tag = 'm';
  while (text.includes(`$${tag}$`)) tag += 'x';
  return `$${tag}$${text}$${tag}$`;
}

const files = readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()
  .map((f) => ({ file: f, version: f.split('_')[0], name: f.slice(f.indexOf('_') + 1, -4) }));
const applied = new Set((await sql('select version from supabase_migrations.schema_migrations', true)).map((r) => r.version));
const pending = files.filter((m) => !applied.has(m.version));
const remoteOnly = [...applied].filter((v) => !files.some((m) => m.version === v)).sort();

console.log(`${files.length - pending.length} of ${files.length} local migrations applied.`);
if (remoteOnly.length) console.log(`On the database but not in this checkout (pull main?): ${remoteOnly.join(', ')}`);
if (!pending.length) { console.log('Nothing pending.'); process.exit(0); }
console.log(`Pending:\n${pending.map((m) => `  ${m.file}`).join('\n')}`);
if (!process.argv.includes('--apply')) { console.log('Run again with --apply to apply them.'); process.exit(0); }
if (remoteOnly.some((v) => v > pending[0].version)) {
  console.error('The database has a newer migration than the first pending one: pull main first so they run in order.');
  process.exit(1);
}

for (const m of pending) {
  const body = readFileSync(new URL(m.file, DIR), 'utf8');
  try {
    await sql(`begin;\n${body}\n;\ninsert into supabase_migrations.schema_migrations (version, name, statements) values ('${m.version}', ${quoted(m.name)}, array[${quoted(body)}]);\ncommit;`);
    console.log(`Applied ${m.file}`);
  } catch (e) {
    console.error(`Failed on ${m.file} (rolled back, later files not run):\n${e.message}`);
    process.exit(1);
  }
}
