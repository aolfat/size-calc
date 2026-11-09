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

// ---------- pull to refresh ----------

// listeners on a stand-in for window, so a test can fire a pull
function pullTarget() {
  const on = {};
  const target = { addEventListener: (type, fn) => { (on[type] ||= []).push(fn); } };
  const fire = (type, y, x = 200, extra = {}) => {
    const e = { touches: type === 'touchend' ? [] : [{ clientX: x, clientY: y }], defaultPrevented: false, ...extra };
    for (const fn of on[type] || []) fn(e);
    return e;
  };
  return { target, fire };
}

const flush = () => new Promise(r => setImmediate(r));

test('pull to refresh: past the line a release refreshes, with a tap you can feel and a spinner until it answers', async () => {
  const { run, elements } = await app({ width: 390 });
  const { attachPullRefresh, PULL_TRIGGER } = await import('../src/ui/native-feel.js');
  const { effects } = await import('../src/ui/effects.js');
  const { target, fire } = pullTarget();
  let taps = 0, answer;
  effects.haptic = () => { taps++; };
  effects.wait = ms => ms === 500 ? Promise.resolve() : new Promise(() => {});
  run("setView('positions')");
  run('positionsBusy = false');
  attachPullRefresh(target);
  const ind = elements.get('pullRefresh');

  fire('touchstart', 100);
  fire('touchmove', 100 + PULL_TRIGGER / 2);
  assert.ok(ind.classList.contains('show') && !ind.classList.contains('armed'), 'it follows the pull');
  fire('touchend');
  assert.ok(!ind.classList.contains('show') && taps === 0, 'short of the line: nothing happens');

  fire('touchstart', 100);
  fire('touchmove', 100 + PULL_TRIGGER + 10);
  assert.ok(ind.classList.contains('armed'), 'past the line it says so');
  fire('touchend');
  assert.equal(taps, 1, 'a tap you can feel');
  assert.ok(ind.classList.contains('busy'), 'a spinner while it refreshes');
  fire('touchstart', 100);
  fire('touchmove', 300);
  assert.ok(ind.classList.contains('busy'), 'a second pull waits for the first');
  await flush(); await flush();
  assert.ok(!ind.classList.contains('busy') && !ind.classList.contains('show'), 'done: it tucks away');
});

test('pull to refresh leaves other gestures alone', async () => {
  const { run, elements } = await app({ width: 390 });
  const { attachPullRefresh } = await import('../src/ui/native-feel.js');
  const { target, fire } = pullTarget();
  run("setView('positions')");
  attachPullRefresh(target);
  const ind = elements.get('pullRefresh');
  const pull = () => { fire('touchstart', 100); fire('touchmove', 300); const on = ind.classList.contains('show'); fire('touchend'); return on; };

  globalThis.window.scrollY = 200;
  assert.ok(!pull(), 'only from the very top');
  globalThis.window.scrollY = 0;
  fire('touchstart', 300); fire('touchmove', 200); fire('touchmove', 400);
  assert.ok(!ind.classList.contains('show'), 'an upward start is a scroll');
  fire('touchend');
  fire('touchstart', 100, 100); fire('touchmove', 110, 200);
  assert.ok(!ind.classList.contains('show'), 'sideways is not a pull');
  fire('touchend');
  fire('touchstart', 100); fire('touchmove', 300, 200, { defaultPrevented: true });
  assert.ok(!ind.classList.contains('show'), 'a chart that claims the gesture keeps it');
  fire('touchend');
  run("openSheet('settings')");
  assert.ok(!pull(), 'not under a sheet');
  run('closeSheet()');
  run("setView('utils')");
  assert.ok(!pull(), 'not where there is nothing to refresh');
  run("setView('positions')");
  assert.ok(pull(), 'and still works after all that');
});

test('pull to refresh refreshes what the view you are on refreshes', async () => {
  const { run } = await app({ width: 390 });
  run("setView('utils')");
  assert.equal(run('pullRefreshAction()'), null, 'Tools has nothing to refresh');
  run("setView('calc')");
  assert.equal(run('pullRefreshAction()'), null, 'no ticker loaded yet');
  run("quoteData = { symbol: 'AAPL', last: 200 }");
  assert.equal(typeof run('pullRefreshAction()'), 'function', 'Size: the quote, as ↻ does');
  run("setView('positions')");
  assert.equal(typeof run('pullRefreshAction()'), 'function');
  run("setView('market')");
  assert.equal(typeof run('pullRefreshAction()'), 'function');
  run("setView('journal')");
  assert.equal(run('pullRefreshAction()'), null, 'signed out, the journal has nothing to read');
  run('session = { user: { id: "u" } }');
  assert.equal(typeof run('pullRefreshAction()'), 'function');
  run('journalTrade = { key: "t1" }');
  assert.equal(run('pullRefreshAction()'), null, 'not on a trade page');
});

// ---------- swipe back ----------

function swipePage() {
  const on = {};
  const page = { style: {}, addEventListener: (type, fn) => { (on[type] ||= []).push(fn); } };
  const fire = (type, x, y = 300) => {
    const e = { touches: type === 'touchend' ? [] : [{ clientX: x, clientY: y }], preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    for (const fn of on[type] || []) fn(e);
    return e;
  };
  return { page, fire };
}

test('swiping from the left edge of a Journal trade page goes back to the list; a short swipe springs back', async () => {
  const { run, advance } = await app({ width: 390, clock: true });
  const { attachSwipeBack } = await import('../src/ui/native-feel.js');
  const { page, fire } = swipePage();
  attachSwipeBack(page);
  run("setView('journal')");
  run('journalTrade = { key: "t1", nav: ["t1"], charts: {} }');

  fire('touchstart', 10);
  const move = fire('touchmove', 70);
  assert.ok(move.prevented && move.stopped, 'the page owns the drag: a chart under the edge does not pan along');
  assert.equal(page.style.transform, 'translateX(60px)', 'the page follows the finger');
  await advance(500);
  fire('touchend');
  assert.ok(run('journalTrade'), 'a short slow swipe stays');
  assert.equal(page.style.transform, '', 'and springs back');

  fire('touchstart', 10);
  fire('touchmove', 250);
  await advance(500);
  fire('touchend');
  assert.equal(run('journalTrade'), null, 'past a third of the width it goes back');
});

test('swipe back only starts at the edge of a trade page, and only sideways', async () => {
  const { run } = await app({ width: 390 });
  const { attachSwipeBack } = await import('../src/ui/native-feel.js');
  const { page, fire } = swipePage();
  attachSwipeBack(page);
  run("setView('journal')");
  run('journalTrade = { key: "t1", nav: ["t1"], charts: {} }');
  fire('touchstart', 120);
  assert.ok(!fire('touchmove', 300).prevented, 'away from the edge the page belongs to the chart and the list');
  fire('touchend');
  fire('touchstart', 10, 300);
  assert.ok(!fire('touchmove', 14, 380).prevented, 'down from the edge is a scroll');
  fire('touchend');
  assert.ok(run('journalTrade'));
});

// ---------- the small title bar ----------

test('the small title bar shows once the large title scrolls away, and gives way to the quote bar', async () => {
  const { run, elements } = await app({ width: 390 });
  const bar = elements.get('titleBar'), title = elements.get('viewTitle');
  bar.offsetHeight = 44;
  run("setView('positions')");
  assert.equal(elements.get('titleBarText').textContent, 'Positions', 'it names the view');
  title.getBoundingClientRect = () => ({ bottom: 80 });
  run('updateTitleBar()');
  assert.ok(!bar.classList.contains('on'), 'the large title is still in view');
  title.getBoundingClientRect = () => ({ bottom: -20 });
  run('updateTitleBar()');
  assert.ok(bar.classList.contains('on'));
  assert.equal(bar.getAttribute('aria-hidden'), 'false');
  elements.get('stickyBar').style.display = 'flex';
  run('updateTitleBar()');
  assert.ok(!bar.classList.contains('on'), 'the quote bar has the top on Size');
});

test('desktop has no small title bar', async () => {
  const { run, elements } = await app({ width: 1400 });
  elements.get('viewTitle').getBoundingClientRect = () => ({ bottom: -20 });
  run('updateTitleBar()');
  assert.ok(!elements.get('titleBar').classList.contains('on'));
});

// ---------- haptics ----------

test('a haptic tap: vibrate where there is one, else the switch iOS ticks for, kept from the page', async () => {
  const { run } = await app({ width: 390 });
  const { haptic } = await import('../src/ui/effects.js');
  const buzz = [];
  globalThis.navigator.vibrate = ms => buzz.push(ms);
  haptic();
  assert.deepEqual(buzz, [8]);
  delete globalThis.navigator.vibrate;

  const made = [], clicks = [];
  globalThis.document.createElement = tag => {
    const el = { tag, style: {}, attrs: {}, kids: [], on: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.kids.push(c); }, addEventListener(t, fn) { this.on[t] = fn; }, click() { clicks.push(this); const e = { stopPropagation() { e.stopped = true; } }; this.on.click(e); this.stopped = e.stopped; }, remove() { this.removed = true; } };
    made.push(el); return el;
  };
  globalThis.document.head = { appendChild() {} };
  haptic();
  const input = made.find(el => el.tag === 'input');
  assert.equal(input.type, 'checkbox');
  assert.ok('switch' in input.attrs, 'a switch, which Safari ticks for');
  assert.ok(clicks[0].stopped, 'its click never reaches the page');
  assert.ok(clicks[0].removed, 'and it is gone after');
  delete globalThis.document.head;
  assert.doesNotThrow(() => haptic(), 'no head, no haptics, no error');
  run('0');
});

test('the risk steps and the long/short switch tap back; the side you are on does not', async () => {
  const { run } = await app({ width: 390 });
  let taps = 0;
  const { effects } = await import('../src/ui/effects.js');
  effects.haptic = () => { taps++; };
  run(`direction = 'long'`);
  run(`actions.setDirection({ dataset: { arg: 'long' } })`);
  assert.equal(taps, 0);
  run(`actions.setDirection({ dataset: { arg: 'short' } })`);
  assert.equal(taps, 1);
  run(`actions.stepRisk({ dataset: { arg: '1' } })`);
  assert.equal(taps, 2);
});

// ---------- hover ----------

test('hover styles need a mouse: a tap never leaves one stuck on a phone', () => {
  const loose = css.split('\n').filter(line => line.includes(':hover') && !line.includes('@media (hover: hover)'));
  // the one exception: a calendar day's events open on hover, and on a phone the tap is what opens them
  assert.deepEqual(loose.map(l => l.trim()), ['.jc-has-ev:hover .jc-pop, .jc-has-ev:focus-within .jc-pop { display: block; }']);
});
