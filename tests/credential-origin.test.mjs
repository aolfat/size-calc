import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

test('credential storage requires a dedicated HTTPS origin or local development', async () => {
  const { run } = await app();
  for (const url of ['https://aolfat.github.io/size-calc/', 'https://someone.github.io/', 'http://app.example/', 'file:///app/index.html', 'not a URL']) {
    assert.equal(run(`credentialOriginAllowed(${JSON.stringify(url)})`), false, url);
  }
  for (const url of ['https://size-calc.example.workers.dev/', 'https://trade.example.com/', 'http://localhost:8765/', 'http://127.0.0.1:8765/', 'http://[::1]:8765/']) {
    assert.equal(run(`credentialOriginAllowed(${JSON.stringify(url)})`), true, url);
  }
});

test('the shared GitHub Pages address clears old secrets and disables credential entry', async t => {
  const original = globalThis.location;
  t.after(() => { if (original === undefined) delete globalThis.location; else globalThis.location = original; });
  const storage = new Map([
    ['tradier_key', 'dummy-key'], ['schwab_tokens', 'dummy-tokens'], ['schwab_accounts', '[]'],
    ['schwab_account', 'dummy-account'], ['sb-dhohfavttsxwutanvcuj-auth-token', 'dummy-session'],
    ['sb-dhohfavttsxwutanvcuj-auth-token-code-verifier', 'dummy-verifier'],
  ]);
  const supabase = { auth: { getSession: async () => ({ data: { session: null } }) } };
  const { run, elements } = await app({ storage, supabase });
  run("location = { href: 'https://aolfat.github.io/size-calc/' }");
  await run('initCloud(location.href)');
  for (const key of ['tradier_key', 'schwab_tokens', 'schwab_accounts', 'schwab_account', 'sb-dhohfavttsxwutanvcuj-auth-token', 'sb-dhohfavttsxwutanvcuj-auth-token-code-verifier']) assert.equal(storage.has(key), false, key);
  for (const id of ['apiKey', 'signInBtn', 'schwabConnect', 'schwabRedirect', 'schwabFinish']) assert.equal(elements.get(id)?.disabled, true, id);
  assert.doesNotMatch(elements.get('apiNotice').innerHTML, /Stored in this browser/);
  elements.get('apiKey').value = 'another-dummy-key';
  run('saveKey()');
  assert.equal(storage.has('tradier_key'), false);
  await assert.rejects(run('signInWithGoogle(location.href)'), /dedicated HTTPS/);
  await assert.rejects(run("schwabExchangeCode('dummy')"), /dedicated HTTPS/);
});
