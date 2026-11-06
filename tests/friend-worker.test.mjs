// Run with: node --test
// scripts/friend-worker.mjs: a friend's Schwab login worker on the owner's Cloudflare account. Only the pure parts run
// here; wrangler itself never does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appOrigins, deployArgs, parseArgs, workerName, workerUrl } from '../scripts/friend-worker.mjs';

test("a friend's worker gets its own name", () => {
  assert.equal(workerName('Sam Lee'), 'size-calc-schwab-sam-lee');
  assert.equal(workerName('  ROB_99! '), 'size-calc-schwab-rob-99');
  assert.equal(workerName('a'.repeat(40)), 'size-calc-schwab-' + 'a'.repeat(30));
  assert.equal(workerName('!!!'), null);
  assert.equal(workerName(''), null);
});

test('the command line: one friend, the 127.0.0.1 callback by default, https only', () => {
  assert.deepEqual(parseArgs(['sam']), { friend: 'sam', redeploy: false, dryRun: false, callback: 'https://127.0.0.1' });
  assert.deepEqual(parseArgs(['sam', '--redeploy', '--callback', 'https://app.example/']), { friend: 'sam', redeploy: true, dryRun: false, callback: 'https://app.example/' });
  assert.equal(parseArgs(['sam', '--dry-run']).dryRun, true);
  assert.match(parseArgs([]).error, /Name the friend/);
  assert.match(parseArgs(['sam', 'rob']).error, /One friend/);
  assert.match(parseArgs(['sam', '--callback', 'http://127.0.0.1']).error, /https/);
  assert.match(parseArgs(['sam', '--secret', 'x']).error, /Unknown option/);
});

test("the app's origins come from the worker's own config, without localhost", () => {
  const toml = readFileSync(new URL('../worker/schwab/wrangler.toml', import.meta.url), 'utf8');
  assert.deepEqual(appOrigins(toml), ['https://aolfat.github.io']);
  assert.deepEqual(appOrigins('ALLOWED_ORIGINS = "https://a.example, http://localhost:8765,https://b.example/x"'), ['https://a.example']);
  const args = deployArgs('size-calc-schwab-sam', 'https://127.0.0.1', ['https://a.example', 'https://b.example']);
  assert.deepEqual(args.slice(-4), ['--var', 'SCHWAB_CALLBACK_URL:https://127.0.0.1', '--var', 'ALLOWED_ORIGINS:https://a.example,https://b.example']);
  assert.ok(args.includes('size-calc-schwab-sam'));
  assert.ok(!args.join(' ').match(/SECRET|APP_KEY/), 'secrets never go on the command line');
});

test("the worker's address is read from wrangler's output", () => {
  assert.equal(workerUrl('Uploaded size-calc-schwab-sam\nDeployed size-calc-schwab-sam triggers\n  https://size-calc-schwab-sam.ali.workers.dev\n'), 'https://size-calc-schwab-sam.ali.workers.dev');
  assert.equal(workerUrl('no address'), '');
});
