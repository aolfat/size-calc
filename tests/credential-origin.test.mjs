import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { app } from './helpers/app.mjs';

test('credential storage requires HTTPS or local development', async () => {
  const { run } = await app();
  for (const url of ['http://app.example/', 'http://aolfat.github.io/size-calc/', 'file:///app/index.html', 'not a URL']) {
    assert.equal(run(`credentialOriginAllowed(${JSON.stringify(url)})`), false, url);
  }
  for (const url of ['https://aolfat.github.io/size-calc/', 'https://size-calc.example.workers.dev/', 'https://trade.example.com/', 'http://localhost:8765/', 'http://127.0.0.1:8765/', 'http://[::1]:8765/']) {
    assert.equal(run(`credentialOriginAllowed(${JSON.stringify(url)})`), true, url);
  }
});

test('an insecure address clears old secrets and disables credential entry', async t => {
  const original = globalThis.location;
  t.after(() => { if (original === undefined) delete globalThis.location; else globalThis.location = original; });
  const storage = new Map([
    ['tradier_key', 'dummy-key'], ['schwab_tokens', 'dummy-tokens'], ['schwab_accounts', '[]'],
    ['schwab_account', 'dummy-account'], ['sb-dhohfavttsxwutanvcuj-auth-token', 'dummy-session'],
    ['sb-dhohfavttsxwutanvcuj-auth-token-code-verifier', 'dummy-verifier'],
  ]);
  const supabase = { auth: { getSession: async () => ({ data: { session: null } }) } };
  const { run, elements } = await app({ storage, supabase });
  run("location = { href: 'http://app.example/' }");
  await run('initCloud(location.href)');
  for (const key of ['tradier_key', 'schwab_tokens', 'schwab_accounts', 'schwab_account', 'sb-dhohfavttsxwutanvcuj-auth-token', 'sb-dhohfavttsxwutanvcuj-auth-token-code-verifier']) assert.equal(storage.has(key), false, key);
  for (const id of ['apiKey', 'signInBtn', 'schwabConnect', 'schwabRedirect', 'schwabFinish']) assert.equal(elements.get(id)?.disabled, true, id);
  assert.doesNotMatch(elements.get('apiNotice').innerHTML, /Stored in this browser/);
  elements.get('apiKey').value = 'another-dummy-key';
  run('saveKey()');
  assert.equal(storage.has('tradier_key'), false);
  await assert.rejects(run('signInWithGoogle(location.href)'), /HTTPS app address/);
  await assert.rejects(run("schwabExchangeCode('dummy')"), /HTTPS app address/);
});

test('the app refuses to run inside another site, not inside its own pages', async () => {
  const { run } = await app();
  run("var me = { location: { origin: 'https://app.example' } }; me.self = me; me.top = me");
  assert.equal(run('framedCrossOrigin(me)'), false, 'not framed');
  run("var sameTop = { location: { origin: 'https://app.example' } }; var inOwn = { self: null, top: sameTop, location: { origin: 'https://app.example' } }; inOwn.self = inOwn");
  assert.equal(run('framedCrossOrigin(inOwn)'), false, 'framed by its own origin');
  run("var otherTop = { get location() { throw new Error('cross-origin'); } }; var inOther = { top: otherTop, location: { origin: 'https://app.example' } }; inOther.self = inOther");
  assert.equal(run('framedCrossOrigin(inOther)'), true, 'framed by another site');
  assert.equal(run('framedCrossOrigin({})'), false, 'no window: the test harness');
});

test("the page's security policy loads nothing from elsewhere but Supabase's images, and _headers says the same", () => {
  const meta = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const headers = fs.readFileSync(new URL('../_headers', import.meta.url), 'utf8').match(/Content-Security-Policy: (.+)/)[1];
  assert.equal(headers, meta + "; frame-ancestors 'none'", 'frame-ancestors only works as a header');
  const rules = Object.fromEntries(meta.split(';').map(r => r.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(rules['default-src'], ["'self'"]);
  assert.deepEqual(rules['script-src'], ["'self'"], 'no inline or other-origin script');
  assert.deepEqual(rules['img-src'], ["'self'", 'data:', 'blob:', 'https://dhohfavttsxwutanvcuj.supabase.co'], 'screenshots are signed Supabase links');
  for (const k of ['object-src', 'frame-src']) assert.deepEqual(rules[k], ["'none'"], k);
  assert.deepEqual(rules['form-action'], ["'self'"]);
});
