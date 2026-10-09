// Run with: node --test
// Account size from Schwab: the selected account's value goes into the account size once per New York day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const PROXY = 'https://size-calc-schwab.test.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const json = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

// tokens outlast the clock jumps below, so no refresh call gets in the way
const connected = (extra = []) => new Map([
  ['schwab_proxy', PROXY],
  ['schwab_tokens', JSON.stringify({ access: 'acc-1', accessExp: Date.now() + 5 * DAY, refresh: 'ref-1', refreshExp: Date.now() + 6 * DAY })],
  ['schwab_accounts', JSON.stringify([{ hash: 'HASH1', last4: '6789' }, { hash: 'HASH2', last4: '4321' }])],
  ['schwab_account', 'HASH1'],
  ...extra,
]);

const VALUES = { HASH1: 52340.61, HASH2: 80000 };
const account = hash => ({ securitiesAccount: { type: 'MARGIN', currentBalances: { liquidationValue: VALUES[hash], cashBalance: 1000 }, positions: [] } });

// Schwab answers balances, positions and orders; every Schwab path is logged
function network() {
  const paths = [];
  const fetch = async (url) => {
    if (!url.startsWith(PROXY)) throw new Error('Unexpected request ' + url);
    const path = url.slice(PROXY.length);
    paths.push(path);
    const hash = path.match(/\/accounts\/([^/?]+)/)?.[1];
    if (path.includes('/orders?')) return json([]);
    if (hash in VALUES) return json(account(hash));
    return json({}, 404);
  };
  return { paths, fetch, balances: () => paths.filter(p => /\/accounts\/[^/?]+$/.test(p)).length };
}

// starts every test at noon New York time, so "later today" never crosses midnight there
async function setup(storage = connected()) {
  const net = network();
  const h = await app({ fetch: net.fetch, storage, clock: true, timers: 'fake' });
  const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(h.run('Date.now()')));
  const mins = +ny.find(p => p.type === 'hour').value * 60 + +ny.find(p => p.type === 'minute').value;
  await h.advance(((12 * 60 - mins + 24 * 60) % (24 * 60)) * 60000);
  h.run('syncRiskDollar()'); // $50,000 at 1% = $500
  return { ...h, net };
}

const acctSize = elements => elements.get('accountSize').value;

test('the first Schwab read of the day sets the account size; the risk % holds and the max loss follows', async () => {
  const { run, elements, storage, advance, net } = await setup();
  run('initSchwab("https://size.test/")');
  await settle();
  assert.equal(net.balances(), 1, 'one balances read');
  assert.equal(acctSize(elements), '52341', 'whole dollars');
  assert.equal(elements.get('riskPct').value, '1');
  assert.equal(+elements.get('riskDollar').value, 523.41);
  assert.equal(storage.get('calc_account'), '52341', 'stored like a typed account size, so it backs up and syncs');
  assert.equal(elements.get('errorBox').textContent, 'Account size $52,341 from Schwab ••6789. Max loss $523.41.');
  assert.match(elements.get('acctSourceNote').textContent, /^Set to \$52,341 from Schwab ••6789 at \d+:\d\d [AP]M\. Updates once a day/);
  assert.equal(elements.get('acctSourceRow').style.display, '');
  assert.ok(!JSON.parse(storage.get('schwab_acct_size')).hasOwnProperty('last4'), 'the marker keeps the hash, not the account number');

  // a number typed later in the day holds
  elements.get('accountSize').value = '60000';
  run('recalcAll()');
  await advance(3 * 60 * 60000);
  await run('dailyAccountSize()');
  assert.equal(net.balances(), 1, 'no second read the same day');
  assert.equal(acctSize(elements), '60000');

  // the next day takes Schwab's value again
  VALUES.HASH1 = 51000;
  await advance(DAY);
  await run('dailyAccountSize()');
  assert.equal(net.balances(), 2);
  assert.equal(acctSize(elements), '51000');
  VALUES.HASH1 = 52340.61;
});

test('a lit $ chip keeps its dollars when the account size changes', async () => {
  const { run, elements } = await setup();
  run('setRiskUsd(250)');
  assert.equal(+elements.get('riskPct').value, 0.5);
  // 0.5% is also a % chip: the % holds
  await run('dailyAccountSize()');
  assert.equal(+elements.get('riskDollar').value, 261.7); // 0.5% of $52,341

  const two = await setup();
  two.run('setRiskUsd(100)'); // 0.2%: no % chip
  await two.run('dailyAccountSize()');
  assert.equal(acctSize(two.elements), '52341');
  assert.equal(+two.elements.get('riskDollar').value, 100, 'still $100');
  assert.equal(+two.elements.get('riskPct').value, +(100 / 52341 * 100).toFixed(10));
});

test('Positions reads the account anyway: its first read of the day sets the size with no extra call', async () => {
  const { run, elements, net } = await setup();
  run("setView('positions')");
  await settle();
  assert.equal(net.balances(), 0);
  assert.equal(net.paths.length, 2, 'positions and orders only');
  assert.equal(acctSize(elements), '52341');
  await run('dailyAccountSize()');
  assert.equal(net.paths.length, 2, 'already done today');
});

test('a new account is due right away; Typed in stops it; switching back updates now', async () => {
  const { run, elements, storage, net } = await setup();
  await run('dailyAccountSize()');
  assert.equal(acctSize(elements), '52341');
  storage.set('schwab_account', 'HASH2');
  await run('dailyAccountSize()');
  assert.equal(acctSize(elements), '80000', 'the other account has its own value');

  run("setAccountSizeSource('manual')");
  assert.equal(storage.get('schwab_acct_source'), 'manual');
  assert.equal(elements.get('acctSourceNote').textContent, 'Account size stays at what you type.');
  assert.equal(elements.get('acctSrcManual').getAttribute('aria-pressed'), 'true');
  storage.set('schwab_account', 'HASH1');
  await run('dailyAccountSize()');
  assert.equal(net.balances(), 2, 'typed in: no read');
  assert.equal(acctSize(elements), '80000');

  run("setAccountSizeSource('schwab')");
  await settle();
  assert.equal(net.balances(), 3);
  assert.equal(acctSize(elements), '52341');

  run('disconnectSchwab()');
  assert.equal(storage.get('schwab_acct_size'), undefined, 'the marker goes with the login');
  assert.equal(storage.get('schwab_acct_source'), 'schwab', 'the choice stays');
  assert.equal(elements.get('acctSourceRow').style.display, 'none');
});

test('no login, a failed read or an empty account changes nothing', async () => {
  const off = await setup(new Map());
  await off.run('dailyAccountSize()');
  assert.equal(off.net.paths.length, 0);
  assert.equal(acctSize(off.elements), '50000');

  const { run, elements, storage } = await setup();
  const zero = VALUES.HASH1;
  VALUES.HASH1 = 0;
  await run('dailyAccountSize()');
  assert.equal(acctSize(elements), '50000');
  assert.equal(storage.get('schwab_acct_size'), undefined, 'still due');
  delete VALUES.HASH1; // 404
  await run('dailyAccountSize()');
  assert.equal(acctSize(elements), '50000');
  assert.equal(elements.get('errorBox').textContent, '', 'quiet; the next focus tries again');
  VALUES.HASH1 = zero;
  await run('dailyAccountSize()');
  assert.equal(acctSize(elements), '52341');
});
