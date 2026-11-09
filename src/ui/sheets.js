// Sheets: settings, account & risk, the Schwab order reviews (new trade, held position, closing a spread, cancelling or changing a working order, cancelling them all), the Journal's Import and Export, and a journal trade (your stop, deleting it), a panel under the header on desktop and a bottom sheet on phones.
import { state } from '../state.js';
import { marketSource } from '../services/market-source.js';
import { mq, PHONE_MQ } from '../lib/media.js';
import { effects } from './effects.js';

export const SHEETS = { settings: 'settingsSheet', risk: 'riskSheet', trade: 'tradeSheet', posTrade: 'posTradeSheet', posActions: 'posActionsSheet', spreadClose: 'spreadCloseSheet', cancel: 'cancelSheet', cancelAll: 'cancelAllSheet', edit: 'editSheet', journalImport: 'journalImportSheet', journalExport: 'journalExportSheet', tradeReview: 'tradeReviewSheet', journalLibrary: 'journalLibrarySheet' };
// the page behind a sheet goes inert (no clicks, no Tab stops, hidden from screen readers); the toast stays live
export const SHEET_BACKGROUND = ['stickyBar', 'titleBar', 'appHeader', 'sidePane', 'mainPane', 'simOverlay'];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const trapped = new WeakSet();
const draggable = new WeakSet();
/** how long a phone sheet takes to slide away (styles/chrome.css slides it in) */
export const SHEET_OUT_MS = 240;
// iOS's own sheet curve: quick off the mark, a long soft landing
const SHEET_EASE = 'cubic-bezier(.32,.72,0,1)';
const sheetMotion = () => mq(PHONE_MQ) && !mq('(prefers-reduced-motion: reduce)');
/** told the sheet that opened, or null when they all close (Claude access forgets a new key then) */
const watchers = [];
export function onSheetChange(fn) { watchers.push(fn); }

function setBackgroundInert(on) {
  for (const id of SHEET_BACKGROUND) { const el = document.getElementById(id); if (el) el.inert = on; }
}

// Tab and Shift+Tab cycle inside the open sheet
export function sheetTab(e) {
  if (e.key !== 'Tab') return;
  const sheet = e.currentTarget;
  const items = [...sheet.querySelectorAll(FOCUSABLE)].filter(el => el.getClientRects().length);
  if (!items.length) { e.preventDefault(); sheet.focus(); return; }
  const first = items[0], last = items[items.length - 1], at = document.activeElement;
  if (e.shiftKey ? at === first || at === sheet : at === last) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
}

export function openSheet(name) {
  if (!SHEETS[name]) return;
  if (!state.openSheetName) state.sheetOpener = document.activeElement;
  // clean styles: a sheet still sliding away (dismissSheet) or let go mid-pull would keep its offset and the faded dim
  for (const [n, id] of Object.entries(SHEETS)) Object.assign(document.getElementById(id).style, { display: n === name ? '' : 'none', transform: '', transition: '' });
  Object.assign(document.getElementById('sheetBackdrop').style, { display: '', opacity: '', transition: '' });
  state.openSheetName = name;
  setBackgroundInert(true);
  const sheet = document.getElementById(SHEETS[name]);
  if (!trapped.has(sheet)) { trapped.add(sheet); sheet.addEventListener('keydown', sheetTab); }
  if (!draggable.has(sheet)) { draggable.add(sheet); attachSheetDrag(sheet); }
  document.body.classList.add('sheet-open'); // phones: the page behind holds still
  // an empty key field is the one place focus helps; elsewhere it would pop the phone keyboard over the chips
  const keyEl = document.getElementById('apiKey');
  if (name === 'settings' && !marketSource()) keyEl.focus();
  else sheet.focus();
  for (const fn of watchers) fn(name);
}

export function closeSheet() {
  for (const id of Object.values(SHEETS)) Object.assign(document.getElementById(id).style, { display: 'none', transform: '', transition: '' });
  Object.assign(document.getElementById('sheetBackdrop').style, { display: 'none', opacity: '', transition: '' });
  document.body.classList.remove('sheet-open');
  state.openSheetName = null;
  setBackgroundInert(false); // first: an inert opener can't take focus back
  if (state.sheetOpener && state.sheetOpener.focus) state.sheetOpener.focus();
  state.sheetOpener = null;
  for (const fn of watchers) fn(null);
}

/** × and the backdrop: on a phone the sheet slides back down first, the way iOS dismisses one */
export function dismissSheet() {
  const name = state.openSheetName;
  if (!name) return;
  if (!sheetMotion()) { closeSheet(); return; }
  const sheet = document.getElementById(SHEETS[name]), backdrop = document.getElementById('sheetBackdrop');
  Object.assign(sheet.style, { transition: `transform ${SHEET_OUT_MS}ms ${SHEET_EASE}`, transform: 'translateY(100%)' });
  Object.assign(backdrop.style, { transition: `opacity ${SHEET_OUT_MS}ms ease`, opacity: '0' });
  effects.wait(SHEET_OUT_MS).then(() => { if (state.openSheetName === name) closeSheet(); });
}

/**
 * Phones: pull a sheet down to close it.
 * A drag only starts from the top of the sheet's own scroll and downward; anything else scrolls the sheet as usual.
 * The sheet follows the finger and the backdrop fades with it; let go past a quarter of the sheet (120px at most)
 * or with a quick flick and it closes, short of that it springs back.
 */
export function attachSheetDrag(sheet) {
  const backdrop = () => document.getElementById('sheetBackdrop');
  let mode = null, x0 = 0, y0 = 0, t0 = 0, dy = 0; // mode: null idle, 'maybe' until the first move, 'drag', 'off'
  sheet.addEventListener('touchstart', e => {
    mode = null;
    if (e.touches.length !== 1 || !mq(PHONE_MQ) || sheet.scrollTop > 0) return;
    if (e.target?.closest?.('input, textarea, select')) return; // typing and picking stay theirs
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); dy = 0; mode = 'maybe';
  }, { passive: true });
  sheet.addEventListener('touchmove', e => {
    if (mode !== 'maybe' && mode !== 'drag') return;
    if (e.touches.length !== 1) { springBack(); return; }
    const dx = e.touches[0].clientX - x0;
    dy = e.touches[0].clientY - y0;
    if (mode === 'maybe') {
      if (dy <= 0 || Math.abs(dx) > dy) { mode = 'off'; return; } // up or sideways: an ordinary scroll
      mode = 'drag';
      sheet.style.transition = 'none';
      backdrop().style.transition = 'none';
    }
    e.preventDefault(); // the sheet owns the gesture: no rubber band, no scroll behind
    const h = sheet.offsetHeight || 1;
    sheet.style.transform = `translateY(${Math.max(0, dy)}px)`;
    backdrop().style.opacity = String(Math.max(0, Math.min(1, 1 - dy / h)));
  }, { passive: false });
  function springBack() {
    mode = null;
    Object.assign(sheet.style, { transition: `transform 300ms ${SHEET_EASE}`, transform: '' });
    Object.assign(backdrop().style, { transition: 'opacity 300ms ease', opacity: '' });
  }
  const end = () => {
    if (mode !== 'drag') { mode = null; return; }
    mode = null;
    const h = sheet.offsetHeight || 0;
    const flick = dy > 30 && dy / Math.max(1, Date.now() - t0) > 0.5; // faster than half a pixel per ms
    if (dy > Math.min(120, h / 4) || flick) dismissSheet(); else springBack();
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
}
