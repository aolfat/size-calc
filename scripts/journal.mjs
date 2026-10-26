#!/usr/bin/env node
// The journal from a Claude Code session (docs/claude-access.md): reads it with the Claude key in JOURNAL_KEY (made in
// the app's Settings, kept as an environment secret) and saves reviews. Only what claude_journal_read and
// claude_journal_save allow: your trades and their reviews, never your settings, Tradier key or Schwab login.
//
//   node scripts/journal.mjs trades [--symbol QQQ] [--day 2026-10-23] [--todo] [--open] [--deleted] [--limit 20]
//   node scripts/journal.mjs show <handle or key>
//   node scripts/journal.mjs choices [kind]
//   node scripts/journal.mjs review <handle or key> '<json>' [--dry-run]
//
// A review's JSON: market, marketFor ('day' | 'trade'), sector, setups, tactics, tags, mistakes (names or keys; each one
// given replaces that kind's labels), grade (A to F), plan (yes | partly | no), entryNote, exitNote, stop; null clears.
import { spawnSync } from 'node:child_process';
import { SUPABASE_KEY, SUPABASE_URL } from '../src/services/supabase.js';
import { changesAnything, choicesText, findTrades, journalFrom, planReview, tradeBy, tradeDetail, tradeLine } from './journal-lib.mjs';

// Node's fetch ignores HTTPS_PROXY unless told to (a cloud session's traffic goes through one): run again with it on
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
  process.exit(r.status ?? 1);
}

const fail = msg => { console.error(msg); process.exit(1); };

async function call(fn, body) {
  const key = process.env.JOURNAL_KEY;
  if (!key) fail('No JOURNAL_KEY. Make a key in the app (Settings → Claude access) and add it to this environment as the JOURNAL_KEY secret.');
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_key: key, ...body }),
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
  if (res.status === 404 || /could not find the function/i.test(msg)) fail("The database doesn't have Claude access yet: npx supabase db push");
  if (res.status === 403 && !out) fail(`Blocked before Supabase (${res.status}). If this is a cloud session, allow ${new URL(SUPABASE_URL).host} in the environment's network access.`);
  fail(`Supabase refused (${res.status}): ${msg}`);
}

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--symbol', '--day', '--limit'].includes(args[i - 1])));
const [cmd, ref, json] = positional;

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
} else {
  fail('node scripts/journal.mjs trades | show <trade> | choices [kind] | review <trade> <json> [--dry-run]');
}
