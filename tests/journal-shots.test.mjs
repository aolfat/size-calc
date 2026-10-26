// Run with: node --test
// Screenshots on a trade (journal step 3): kept in your folder of the private trade-shots bucket with a trade_shots row,
// shown by signed links, added by the button, paste or drop (shrunk first, ten a trade), opened full size with a
// caption, deleted after asking once; and what happens when Storage or the table isn't there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';

const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
const ENTRY = {
  orderId: 501, enteredTime: '2026-10-01T14:30:00+0000', status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction: 'BUY', quantity: 100, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7001, executionLegs: [{ legId: 1, quantity: 100, price: 100.02, time: '2026-10-01T14:30:01+0000' }] }],
  childOrderStrategies: [{
    orderId: 502, status: 'FILLED', orderType: 'STOP', stopPrice: 95,
    orderLegCollection: [{ legId: 1, instruction: 'SELL', quantity: 100, instrument: { symbol: 'AAPL', assetType: 'EQUITY' } }],
    orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 7002, executionLegs: [{ legId: 1, quantity: 100, price: 94.98, time: '2026-10-02T15:00:00+0000' }] }],
  }],
};
const KEY = '6789|AAPL|long|2026-10-01T14:30:01.000Z';
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
// the canvas can't run here: stand in for the shrinking, a 1600×900 WebP of 180 KB
const PREPARE = "effects.prepareImage = async f => ({ blob: { size: f.size > 3e6 ? 3e6 : 180000 }, type: 'image/webp', width: 1600, height: 900 })";

async function page(tweak) {
  const supabase = fakeRecords([{ kind: 'order', record_id: '501', account: '6789', entered_at: '2026-10-01T14:30:00Z', data: ENTRY }]);
  if (tweak) tweak(supabase);
  const a = await app({ supabase, session: SESSION });
  a.run(PREPARE);
  a.run("setView('journal')");
  await a.run('loadJournal()');
  a.run(`openJournalTrade('${KEY}')`);
  await settle();
  return { ...a, supabase, t: 'journalPageTrade()', body: () => a.elements.get('jtBody').innerHTML, shots: () => [...supabase.tables.trade_shots.values()] };
}
const png = (size = 900000) => `{ type: 'image/png', size: ${size}, name: 'shot.png' }`;

test('a screenshot is shrunk, kept in your folder of the private bucket with its row, and shown by a signed link', async () => {
  const { run, t, body, shots, supabase, elements } = await page();
  assert.match(body(), /<div class="jr-label">Screenshots<span class="jr-sub">or press (?:⌘V|Ctrl\+V) on this page, or drop one here<\/span><\/div>[\s\S]*data-action="pasteTradeShot">Paste from clipboard<\/button>\s*<button class="btn" data-action="pickTradeShots">\+ Add screenshot<\/button>\s*<input type="file" id="tradeShotInput" accept="image\/\*" multiple hidden data-change="addTradeShotsFromInput"/);
  assert.ok(supabase.reads.some(r => r.table === 'trade_shots'), 'read with the journal');
  await run(`addTradeShots(${t}, [${png()}])`);
  await settle();
  const up = supabase.storageOps.find(o => o.op === 'upload');
  assert.equal(up.bucket, 'trade-shots');
  assert.match(up.path, /^user-1\/[0-9a-f-]+\.webp$/, 'in your own folder, as WebP');
  assert.deepEqual([up.contentType, up.upsert, up.size], ['image/webp', false, 180000]);
  const [row] = shots();
  assert.deepEqual([row.trade_key, row.path, row.width, row.height, row.bytes], [KEY, up.path, 1600, 900, 180000]);
  assert.ok(supabase.storageOps.some(o => o.op === 'sign' && o.paths.includes(up.path) && o.seconds === 3600), 'an hour-long signed link');
  assert.match(body(), new RegExp(`data-action="openShot" data-arg="${row.id}"[^>]*><img src="https://fake\\.storage\\.test/trade-shots/${up.path.replace(/[/.]/g, '\\$&')}\\?token=t&amp;expires=3600"`));
  assert.match(elements.get('errorBox').textContent, /Screenshot kept\./);
});

test('only images, ten a trade, and nothing over 2 MB even shrunk; paste anywhere on the trade page adds one', async () => {
  const { run, t, shots, elements, dispatch } = await page();
  await run(`addTradeShots(${t}, [{ type: 'application/pdf', size: 100 }])`);
  assert.match(elements.get('errorBox').textContent, /That isn(?:'|’)t an image/);
  await run(`addTradeShots(${t}, [${png(5e6)}])`);
  assert.match(elements.get('errorBox').textContent, /even shrunk, that image is over 2 MB/);
  assert.equal(shots().length, 0);
  run('initTradeShotEvents(() => journalPageTrade())'); // main.js does this at boot
  let pasted = false;
  dispatch('paste', { clipboardData: { files: [{ type: 'image/png', size: 1000 }] }, preventDefault() { pasted = true; } });
  await settle();
  assert.equal(pasted, true, 'the paste is taken');
  assert.equal(shots().length, 1, 'and kept');
  dispatch('paste', { clipboardData: { files: [] }, preventDefault() { throw new Error('text pastes go on as usual'); } });
  await run(`addTradeShots(${t}, [${Array.from({ length: 12 }, () => png()).join(',')}])`);
  await settle();
  assert.equal(shots().length, 10, 'ten a trade');
  assert.match(run("document.getElementById('jtBody').innerHTML"), /data-action="pickTradeShots" disabled title="Ten a trade at most"/);
});

test('the viewer: full size, a caption, and Delete asks once before the file and its row go', async () => {
  const { run, t, shots, supabase, elements } = await page();
  await run(`addTradeShots(${t}, [${png()}])`);
  await settle();
  const [row] = shots();
  run(`openShot('${row.id}')`);
  assert.equal(elements.get('shotViewer').style.display, '');
  assert.match(elements.get('shotViewerImg').src, /^https:\/\/fake\.storage\.test\/trade-shots\/user-1\//);
  await run("saveTradeShotCaption('the 10:00 flush into the 21 EMA')");
  assert.equal(shots()[0].caption, 'the 10:00 flush into the 21 EMA');
  await run('deleteTradeShot()');
  assert.equal(elements.get('shotDelete').textContent, 'Delete for good?', 'it asks first');
  assert.equal(shots().length, 1);
  await run('deleteTradeShot()');
  assert.equal(shots().length, 0, 'the row is gone');
  assert.ok(supabase.storageOps.some(o => o.op === 'remove' && o.paths[0] === row.path), 'and the file');
  assert.equal(elements.get('shotViewer').style.display, 'none');
  assert.match(elements.get('errorBox').textContent, /Screenshot deleted\./);
});

test('if Storage refuses the file, no row is saved; before the migration, the row says why and the page still works', async () => {
  const one = await page(s => s.tables.trade_shots && null);
  one.supabase.failTable('storage');
  await one.run(`addTradeShots(${one.t}, [${png()}])`);
  await settle();
  assert.equal(one.shots().length, 0);
  assert.match(one.elements.get('errorBox').textContent, /Couldn't keep the screenshot: the database doesn(?:'|’)t have screenshots yet: npx supabase db push/);

  const two = await page(s => s.failTable('trade_shots'));
  assert.match(two.body(), /Screenshots unavailable: the database doesn(?:'|&#39;)t have screenshots yet: npx supabase db push/);
  assert.match(two.body(), /<dt>P&amp;L<\/dt>/, 'the rest of the page is there');
});

test('Paste from clipboard reads the copied image; an empty clipboard or a refusal says what to do instead', async () => {
  const { run, t, shots, elements, dispatch } = await page();
  run("effects.readClipboardImages = async () => [{ type: 'image/png', size: 400000 }]");
  await run(`pasteTradeShot(${t})`);
  await settle();
  assert.equal(shots().length, 1, 'the copied screenshot is kept');
  assert.match(elements.get('errorBox').textContent, /Screenshot kept\./);
  run("effects.readClipboardImages = async () => []");
  await run(`pasteTradeShot(${t})`);
  assert.match(elements.get('errorBox').textContent, /No image on the clipboard\. Copy a screenshot first, then Paste\./);
  run("effects.readClipboardImages = async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); }");
  await run(`pasteTradeShot(${t})`);
  assert.match(elements.get('errorBox').textContent, /The browser didn(?:'|’)t allow reading the clipboard\. Press (?:⌘V|Ctrl\+V) on this page instead, or use \+ Add screenshot\./);
  run("effects.readClipboardImages = async () => { throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' }); }");
  await run(`pasteTradeShot(${t})`);
  assert.match(elements.get('errorBox').textContent, /This browser can(?:'|’)t paste images from a button\./);
  assert.equal(shots().length, 1);

  // a paste where the browser hands the image over only as an item
  run('initTradeShotEvents(() => journalPageTrade())');
  dispatch('paste', { clipboardData: { files: [], items: [{ kind: 'file', type: 'image/png', getAsFile: () => ({ type: 'image/png', size: 2000 }) }, { kind: 'string', type: 'text/plain' }] }, preventDefault() {} });
  await settle();
  assert.equal(shots().length, 2, 'taken from the items');
});

test('a missed trade keeps screenshots too: added, pasted onto it on the notebook page, counted, and gone with it after Undo runs out', async () => {
  const supabase = fakeRecords([{ kind: 'order', record_id: '501', account: '6789', entered_at: '2026-10-01T14:30:00Z', data: ENTRY }]);
  const a = await app({ supabase, session: SESSION });
  const { run, dispatch } = a;
  run(PREPARE);
  run('effects.wait = () => new Promise(r => { globalThis.__undoOver = r; })');
  run("setView('journal')");
  await run('loadJournal()');
  run("openJournalDay('2026-10-01'); missedInput('NVDA'); addMissedTrade()");
  await settle();
  const out = () => a.elements.get('journalSection').innerHTML;
  const id = a.state.journalReview.days['2026-10-01'].missed[0].id;
  assert.match(out(), /data-action="pasteMissedShot">Paste from clipboard<\/button>\s*<button class="btn" data-action="pickMissedShots">\+ Add screenshot<\/button>\s*<input type="file" id="missedShotInput"[^>]*data-change="addMissedShotsFromInput"/, 'its own picker, not the trade page\'s');
  await run(`addMissedShots([${png()}])`);
  await settle();
  const shots = () => [...supabase.tables.trade_shots.values()];
  assert.deepEqual(shots().map(s => s.trade_key), [`missed:${id}`]);
  assert.match(out(), /data-action="openShot" data-arg="[^"]+"[^>]*><img src="https:\/\/fake\.storage\.test\/trade-shots\//, 'shown on the open missed trade');
  run('initTradeShotEvents(() => journalPageTrade())');
  dispatch('paste', { clipboardData: { files: [{ type: 'image/png', size: 1000 }] }, preventDefault() {} });
  await settle();
  assert.equal(shots().length, 2, 'a paste anywhere on the page goes on the open missed trade');
  run(`openMissedTrade('${id}')`);
  assert.match(out(), /<span class="nb-miss-shots">2 screenshots<\/span>/, 'closed, it counts them');
  dispatch('paste', { clipboardData: { files: [{ type: 'image/png', size: 1000 }] }, preventDefault() { throw new Error('none open: the paste is left alone'); } });
  run(`removeMissedTrade('${id}'); undoRemoveMissed()`);
  await settle();
  run('globalThis.__undoOver()');
  await settle();
  assert.equal(shots().length, 2, 'brought back with Undo: kept');
  run(`removeMissedTrade('${id}')`);
  await settle();
  assert.equal(shots().length, 2, 'not while Undo can still bring it back');
  run('globalThis.__undoOver()');
  await settle();
  assert.equal(shots().length, 0, 'then the rows go');
  assert.equal(supabase.storageOps.filter(o => o.op === 'remove').length, 2, 'and the files');
});
