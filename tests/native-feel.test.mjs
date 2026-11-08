// Phones feel like an iOS app: sheets slide and pull down to close, the tab you're on goes back to the top,
// and the stylesheet drops the web page tells (tap flash, long-press selection, double-tap zoom).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { app, css } from './helpers/app.mjs';

const shown = el => el.style.display !== 'none';

// a phone that allows motion (the harness's matchMedia reads a query with no width as true, so reduced motion would be on)
const phoneWithMotion = () => {
  globalThis.window.matchMedia = q => ({ matches: /max-width:\s*600px/.test(q) && !/reduced-motion/.test(q), addEventListener() {} });
};

// a sheet whose touch listeners the test can fire, 600px tall
function touchable(el) {
  const on = {};
  el.addEventListener = (type, fn) => { (on[type] ||= []).push(fn); };
  el.offsetHeight = 600;
  el.scrollTop = 0;
  const fire = (type, y, x = 100) => {
    const e = { touches: type === 'touchend' ? [] : [{ clientX: x, clientY: y }], target: { closest: () => null }, preventDefault() { this.prevented = true; } };
    for (const fn of on[type] || []) fn(e);
    return e;
  };
  return fire;
}

test('pulling a phone sheet down far enough closes it; a short pull springs back', async () => {
  const { run, elements, advance } = await app({ width: 390, clock: true });
  const sheet = elements.get('settingsSheet'), backdrop = elements.get('sheetBackdrop');
  const fire = touchable(sheet);
  run("openSheet('settings')");
  assert.ok(shown(sheet));

  fire('touchstart', 100);
  assert.ok(fire('touchmove', 150).prevented, 'a pull from the top is the sheet\'s, not a scroll');
  assert.equal(sheet.style.transform, 'translateY(50px)', 'the sheet follows the finger');
  assert.ok(+backdrop.style.opacity < 1, 'the dim fades as it goes');
  advance(400); // a slow pull, not a flick
  fire('touchend');
  assert.ok(shown(sheet), '50px is short of the 120px it takes');
  assert.equal(sheet.style.transform, '', 'it springs back');

  fire('touchstart', 100);
  fire('touchmove', 300);
  advance(400);
  fire('touchend');
  assert.ok(!shown(sheet) && !shown(backdrop), 'past the line it closes');
  assert.equal(sheet.style.transform, '', 'and opens clean next time');

  run("openSheet('settings')");
  fire('touchstart', 100);
  fire('touchmove', 160);
  advance(60);
  fire('touchend');
  assert.ok(!shown(sheet), 'a quick flick closes it from a short pull');
  assert.equal(sheet.style.transform, '', 'and opens clean next time');
});

test('a phone sheet scrolls as usual: up, sideways, or from partway down its own scroll', async () => {
  const { run, elements } = await app({ width: 390 });
  const sheet = elements.get('settingsSheet');
  const fire = touchable(sheet);
  run("openSheet('settings')");

  fire('touchstart', 300);
  assert.ok(!fire('touchmove', 200).prevented, 'an upward swipe scrolls the sheet');
  fire('touchend');

  fire('touchstart', 100, 100);
  assert.ok(!fire('touchmove', 110, 160).prevented, 'a sideways swipe is not a pull');
  fire('touchend');

  sheet.scrollTop = 80;
  fire('touchstart', 100);
  assert.ok(!fire('touchmove', 400).prevented, 'scrolled down, a downward swipe scrolls back up first');
  fire('touchend');
  assert.ok(shown(sheet));
});

test('desktop sheets are panels: no pull to close', async () => {
  const { run, elements } = await app({ width: 1400 });
  const sheet = elements.get('settingsSheet');
  const fire = touchable(sheet);
  run("openSheet('settings')");
  fire('touchstart', 100);
  assert.ok(!fire('touchmove', 400).prevented);
  fire('touchend');
  assert.ok(shown(sheet));
});

test('× and the backdrop slide a phone sheet down before it closes', async () => {
  const { run, elements } = await app({ width: 390 });
  phoneWithMotion();
  const sheet = elements.get('riskSheet');
  run("openSheet('risk')");
  run('wait = () => new Promise(r => { slid = r; })');
  run('actions.closeSheet()');
  assert.ok(shown(sheet), 'still on screen while it slides');
  assert.equal(sheet.style.transform, 'translateY(100%)');
  run('slid()');
  await new Promise(r => setImmediate(r));
  assert.ok(!shown(sheet) && run('openSheetName') === null);
  assert.equal(sheet.style.transform, '');
});

test('a sheet reopened while the last one slides away stays open', async () => {
  const { run, elements } = await app({ width: 390 });
  phoneWithMotion();
  run("openSheet('risk')");
  run('wait = () => new Promise(r => { slid = r; })');
  run('actions.closeSheet()');
  run("openSheet('settings')");
  run('slid()');
  await new Promise(r => setImmediate(r));
  assert.ok(shown(elements.get('settingsSheet')));
  assert.equal(run('openSheetName'), 'settings');
  assert.equal(elements.get('sheetBackdrop').style.opacity, '', 'the dim is back');
  run("openSheet('risk')");
  assert.equal(elements.get('riskSheet').style.transform, '', 'the sheet that was leaving opens in place');
});

test('the page behind an open sheet is marked so phones hold it still', async () => {
  const { run } = await app({ width: 390 });
  run("openSheet('settings')");
  assert.ok(run("document.body.classList.contains('sheet-open')"));
  run('closeSheet()');
  assert.ok(!run("document.body.classList.contains('sheet-open')"));
  assert.match(css, /html:has\(body\.sheet-open\), body\.sheet-open \{ overflow:hidden; \}/);
});

test('tapping the tab you are on goes back to the top; another tab switches', async () => {
  const { run, elements } = await app({ width: 390 });
  const scrolls = [];
  globalThis.window.scrollTo = o => scrolls.push(o);
  for (const [id, view] of [['brandSize', 'calc'], ['brandTools', 'utils']]) { elements.get(id).classList.add('brand-nav'); elements.get(id).dataset.arg = view; }
  run("setView('calc')");
  run("actions.setView(document.getElementById('brandTools'))");
  assert.equal(run('utilsView'), true, 'another tab switches');
  assert.equal(scrolls.length, 0);
  run("actions.setView(document.getElementById('brandTools'))");
  assert.equal(run('utilsView'), true, 'the same tab stays put');
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0].top, 0);
});

test('tapping Journal on a trade page goes back to the list', async () => {
  const { run, elements } = await app({ width: 390 });
  const el = elements.get('brandJournal');
  el.classList.add('brand-nav'); el.dataset.arg = 'journal';
  run("setView('journal')");
  run('journalTrade = { key: "t1", nav: ["t1"], charts: {} }');
  run('actions.setView(document.getElementById("brandJournal"))');
  assert.equal(run('journalTrade'), null);
});

test('a button elsewhere that opens a view still just opens it', async () => {
  const { run, elements } = await app({ width: 390 });
  const scrolls = [];
  globalThis.window.scrollTo = o => scrolls.push(o);
  run("setView('utils')");
  run("actions.setView({ dataset: { arg: 'utils' }, classList: { contains: () => false }, getAttribute: () => null })");
  assert.equal(scrolls.length, 0);
  assert.equal(run('utilsView'), true);
  assert.ok(elements.get('utilsSection').style.display !== 'none');
});

test('the stylesheet drops the web page tells on phones', () => {
  assert.match(css, /\* \{ -webkit-tap-highlight-color: transparent; \}/, 'no grey flash on tap');
  assert.match(css, /button, summary, \[role="button"\], \[data-action\], \.brand-tabs \{ -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; \}/, 'a long press on a control selects nothing');
  assert.match(css, /input, textarea, select, \[contenteditable\] \{ -webkit-user-select: text; user-select: text; \}/, 'fields still select');
  assert.match(css, /input, select, textarea \{ font-size: 16px !important; \}/, 'no field is small enough for iOS to zoom on focus');
  assert.match(css, /text-size-adjust: 100%/);
  assert.match(css, /@media \(max-width: 600px\) and \(prefers-reduced-motion: no-preference\) \{\s*\.sheet \{ animation: sheet-up/, 'sheets slide only for those who allow motion');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/, 'it opens full screen from the home screen');
});
