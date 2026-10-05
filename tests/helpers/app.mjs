// Test harness: runs the real src/ modules against a small fake DOM built from index.html.
//
//   const { run, elements, storage } = await app({ width: 1400, fetch });
//   run("quoteData = { symbol: 'TEST', last: 100 }; renderShares()");
//
// run() evaluates code where every module export is in scope, state fields read and write the shared
// state object, and the side-effect seam (copyPlainText, drawShareCard, ...) can be swapped by assignment.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const stylesDir = join(ROOT, 'styles');
export const css = readdirSync(stylesDir).filter(f => f.endsWith('.css')).sort().map(f => readFileSync(join(stylesDir, f), 'utf8')).join('\n');
// elements the page declares, plus the ones modules render from templates (sticky bar chips, sheets' contents)
const sources = [html];

// every module except the browser entry point
function moduleFiles(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? moduleFiles(path) : name.endsWith('.js') && name !== 'main.js' ? [path] : [];
  });
}
for (const file of moduleFiles(join(ROOT, 'src'))) sources.push(readFileSync(file, 'utf8'));
const MARKUP = sources.flatMap(text => [...text.matchAll(/<[^>]+\bid="([^"$]+)"[^>]*>/g)].map(m => [m[1], m[0]]));

let api = null;
async function loadModules() {
  if (api) return api;
  api = {};
  for (const file of moduleFiles(join(ROOT, 'src')).sort()) Object.assign(api, await import(pathToFileURL(file).href));
  return api;
}

export function makeElement(id = '') {
  const classes = new Set();
  const attrs = new Map();
  return {
    id, value: '', style: {}, dataset: {}, innerHTML: '', textContent: '', disabled: false, placeholder: '', title: '', className: '',
    classList: {
      toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); return classes.has(c); },
      add(...c) { c.forEach(x => classes.add(x)); }, remove(...c) { c.forEach(x => classes.delete(x)); }, contains: c => classes.has(c),
    },
    attrs, setAttribute(k, v) { attrs.set(k, String(v)); }, removeAttribute(k) { attrs.delete(k); }, getAttribute: k => attrs.get(k) ?? null,
    focus() {}, blur() {}, select() {}, click() {}, addEventListener() {}, scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false,
    prepend() {}, appendChild() {}, remove() {},
  };
}

/**
 * Fresh app per test: new fake page, storage and globals, and a reset state object.
 * @param {{ width?: number | null, fetch?: Function, lenient?: boolean, timers?: 'noop' | 'fake', clock?: boolean, storage?: Map<string,string> }} [opts]
 */
export async function app({ width = null, fetch, lenient = false, timers = 'noop', clock = false, storage = new Map() } = {}) {
  const elements = new Map();
  const listeners = new Map();
  const element = id => {
    if (!elements.has(id)) {
      assert.ok(lenient, `Missing #${id}`);
      elements.set(id, makeElement(id));
    }
    return elements.get(id);
  };
  for (const [id, tag] of MARKUP) {
    const el = makeElement(id);
    el.value = tag.match(/\bvalue="([^"]*)"/)?.[1] || '';
    if (/\bstyle="[^"]*display:\s*none/.test(tag)) el.style.display = 'none'; // start from the markup's hidden state
    el.prepend = el.appendChild = child => { if (child.id) elements.set(child.id, child); };
    elements.set(id, el);
  }
  for (const el of elements.values()) el.remove = function () { elements.delete(this.id); };

  const matches = q => q.split(',').some(part => [...part.matchAll(/\((min|max)-width:\s*([\d.]+)px\)/g)]
    .every(([, kind, px]) => kind === 'min' ? width >= +px : width <= +px));
  let now = Date.now();
  const pending = new Map();
  let nextTimer = 0;
  const fakeTimers = {
    setTimeout: (callback, ms = 0) => { const id = ++nextTimer; pending.set(id, { callback, at: now + ms }); return id; },
    clearTimeout: id => { pending.delete(id); },
  };
  const noop = { setTimeout: () => 0, clearTimeout: () => {} };
  const RealDate = globalThis.__RealDate || (globalThis.__RealDate = Date);
  class Clock extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }

  const globals = {
    document: {
      hidden: false, activeElement: null, body: makeElement('body'),
      createElement: () => makeElement(''),
      getElementById: element,
      querySelector: selector => lenient ? element(selector) : selector === '.app' ? elements.get('app') : null,
      querySelectorAll: () => [],
      addEventListener: (type, fn) => listeners.set(type, fn),
      documentElement: { style: { setProperty() {} } },
    },
    window: {
      scrollY: 0, innerWidth: width || 1024, innerHeight: 900, devicePixelRatio: 1,
      scrollTo() {}, addEventListener() {},
      // no width: no matchMedia at all, so every layout tier reads false (the plain single-column app)
      ...(width ? { matchMedia: q => ({ matches: matches(q), addEventListener() {} }) } : {}),
    },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    navigator: {},
    fetch: fetch || (async url => { throw new Error('Unexpected request ' + url); }),
    setTimeout: (timers === 'fake' ? fakeTimers : noop).setTimeout,
    clearTimeout: (timers === 'fake' ? fakeTimers : noop).clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0,
    Date: clock ? Clock : RealDate,
  };
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });

  const mods = await loadModules();
  mods.resetState();
  const { state, effects } = mods;

  // run() scope: exports, live state fields, the effects seam, and the swapped globals
  const scope = { console, JSON, Math, Object, Array, Number, String, Promise, URLSearchParams, AbortController };
  for (const [k, v] of Object.entries(mods)) scope[k] = v;
  for (const k of Object.keys(state)) Object.defineProperty(scope, k, { get: () => state[k], set: v => { state[k] = v; }, enumerable: true });
  for (const k of Object.keys(effects)) Object.defineProperty(scope, k, { get: () => effects[k], set: v => { effects[k] = v; }, enumerable: true });
  for (const k of ['document', 'window', 'localStorage', 'navigator', 'fetch', 'Date'])
    Object.defineProperty(scope, k, { get: () => globalThis[k], set: v => { globalThis[k] = v; }, enumerable: true });
  const context = vm.createContext(scope);
  // effects keep their production implementations unless a test swaps them
  for (const k of Object.keys(effects)) effects[k] = mods[k];

  return {
    run: code => vm.runInContext(code, context),
    elements, element, listeners, storage, state, api: mods,
    dispatch: (type, event) => listeners.get(type)(event),
    advance: async ms => {
      now += ms;
      for (const [id, t] of [...pending].filter(([, t]) => t.at <= now)) {
        if (!pending.delete(id)) continue;
        await t.callback();
      }
    },
  };
}
