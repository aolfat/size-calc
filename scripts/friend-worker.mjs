#!/usr/bin/env node
// A friend's Schwab login worker, on your Cloudflare account (docs/schwab-setup.md): the same worker/schwab code under
// its own name, with the friend's App Key and Secret as its secrets and the callback their Schwab app has, so they only
// paste the worker's URL into the app's Settings. Secrets are typed in hidden and go straight to Cloudflare: never
// printed, never written to disk.
//
//   node scripts/friend-worker.mjs <friend>                 deploy and set the friend's App Key and Secret
//   node scripts/friend-worker.mjs <friend> --redeploy      deploy again, secrets kept (after a worker change or a move)
//   node scripts/friend-worker.mjs <friend> --callback <url>   their Schwab app's callback (default https://127.0.0.1)
//   node scripts/friend-worker.mjs <friend> --dry-run       check the deploy without uploading anything or asking for secrets
//
// Needs Node 18+ and `npx wrangler login` once. Allowed origins come from worker/schwab/wrangler.toml, without localhost.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'worker', 'schwab', 'wrangler.toml');
export const DEFAULT_CALLBACK = 'https://127.0.0.1';

/** the friend's worker name: 'Sam Lee' → 'size-calc-schwab-sam-lee'; null for a name that leaves nothing usable */
export function workerName(friend) {
  const slug = String(friend || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
  return slug ? 'size-calc-schwab-' + slug : null;
}

/** the app origins in wrangler.toml's ALLOWED_ORIGINS, https only (a friend's worker never serves localhost) */
export function appOrigins(toml) {
  const m = /^\s*ALLOWED_ORIGINS\s*=\s*"([^"]*)"/m.exec(String(toml || ''));
  return (m ? m[1] : '').split(',').map(s => s.trim()).filter(s => /^https:\/\/[^/\s]+$/.test(s));
}

/** a callback Schwab takes: https, no spaces @param {string} url */
export const callbackOk = url => /^https:\/\/[^\s]+$/.test(String(url || ''));

/** the command line: { friend, redeploy, callback } or { error } */
export function parseArgs(argv) {
  const out = { friend: '', redeploy: false, dryRun: false, callback: DEFAULT_CALLBACK };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--redeploy') out.redeploy = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--callback') out.callback = argv[++i] || '';
    else if (a.startsWith('--')) return { error: 'Unknown option ' + a };
    else if (!out.friend) out.friend = a;
    else return { error: 'One friend at a time.' };
  }
  if (!workerName(out.friend)) return { error: 'Name the friend: node scripts/friend-worker.mjs <friend>' };
  if (!callbackOk(out.callback)) return { error: 'The callback must be an https address, exactly as in their Schwab app.' };
  return out;
}

/** the wrangler deploy arguments for one friend */
export function deployArgs(name, callback, origins) {
  return ['wrangler', 'deploy', '--config', CONFIG, '--name', name,
    '--var', 'SCHWAB_CALLBACK_URL:' + callback, '--var', 'ALLOWED_ORIGINS:' + origins.join(',')];
}

/** the workers.dev address in wrangler's deploy output, or '' */
export const workerUrl = text => (/https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(String(text || '')) || [''])[0];

/** runs npx; the output shows as it comes and is kept for the URL; stdin gets `input` when given */
function npx(args, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', args, { stdio: [input === null ? 'inherit' : 'pipe', 'pipe', 'inherit'], shell: process.platform === 'win32' });
    let out = '';
    child.stdout.on('data', d => { out += d; process.stdout.write(d); });
    if (input !== null) { child.stdin.write(input); child.stdin.end(); }
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out) : reject(new Error(`npx ${args.slice(0, 2).join(' ')} failed (${code})`)));
  });
}

/** a line typed without echo (a pasted secret comes in one piece) */
function askHidden(question) {
  return new Promise(resolve => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) { console.error('Run this in a terminal: it asks for the App Key and Secret without showing them.'); process.exit(2); }
    stdout.write(question);
    let value = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = chunk => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); resolve(value.trim()); return; }
        if (c === '\u0003') { stdin.setRawMode(false); stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1); else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error(args.error); process.exit(2); }
  const name = /** @type {string} */ (workerName(args.friend));
  const origins = appOrigins(readFileSync(CONFIG, 'utf8'));
  if (!origins.length) { console.error('No https origin in ALLOWED_ORIGINS in worker/schwab/wrangler.toml.'); process.exit(2); }
  let key = '', secret = '';
  if (!args.redeploy && !args.dryRun) {
    key = await askHidden(`${args.friend}'s Schwab App Key (hidden): `);
    secret = await askHidden(`${args.friend}'s Schwab Secret (hidden): `);
    if (!key || !secret || /\s/.test(key + secret)) { console.error('Both are needed, without spaces. Nothing deployed.'); process.exit(2); }
  }
  console.log(`\nDeploying ${name} (callback ${args.callback}; app ${origins.join(', ')})`);
  const out = await npx([...deployArgs(name, args.callback, origins), ...(args.dryRun ? ['--dry-run'] : [])]);
  if (args.dryRun) { console.log('\nDry run: nothing uploaded.'); return; }
  if (!args.redeploy) {
    await npx(['wrangler', 'secret', 'put', 'SCHWAB_APP_KEY', '--config', CONFIG, '--name', name], key);
    await npx(['wrangler', 'secret', 'put', 'SCHWAB_APP_SECRET', '--config', CONFIG, '--name', name], secret);
  }
  const url = workerUrl(out);
  console.log(`\nDone. Send ${args.friend} the worker URL${url ? ': ' + url : ' (printed above)'}`);
  console.log('They paste it in the app: Settings, Schwab, then Log in to Schwab.');
  if (args.callback === DEFAULT_CALLBACK) console.log('Their callback is https://127.0.0.1: after the Schwab login they copy the address of the page that does not load and paste it in Settings within 30 seconds.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
