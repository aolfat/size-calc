// Sheets: settings, account & risk, and the Schwab order reviews (new trade, held position, cancelling a working order), a panel under the header on desktop and a bottom sheet on phones.
import { state } from '../state.js';

export const SHEETS = { settings: 'settingsSheet', risk: 'riskSheet', trade: 'tradeSheet', posTrade: 'posTradeSheet', cancel: 'cancelSheet' };
// the page behind a sheet goes inert (no clicks, no Tab stops, hidden from screen readers); the toast stays live
export const SHEET_BACKGROUND = ['stickyBar', 'appHeader', 'sidePane', 'mainPane', 'simOverlay'];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const trapped = new WeakSet();

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
  for (const [n, id] of Object.entries(SHEETS)) document.getElementById(id).style.display = n === name ? '' : 'none';
  document.getElementById('sheetBackdrop').style.display = '';
  state.openSheetName = name;
  setBackgroundInert(true);
  const sheet = document.getElementById(SHEETS[name]);
  if (!trapped.has(sheet)) { trapped.add(sheet); sheet.addEventListener('keydown', sheetTab); }
  // an empty key field is the one place focus helps; elsewhere it would pop the phone keyboard over the chips
  const keyEl = document.getElementById('apiKey');
  if (name === 'settings' && !keyEl.value.trim()) keyEl.focus();
  else sheet.focus();
}

export function closeSheet() {
  for (const id of Object.values(SHEETS)) document.getElementById(id).style.display = 'none';
  document.getElementById('sheetBackdrop').style.display = 'none';
  state.openSheetName = null;
  setBackgroundInert(false); // first: an inert opener can't take focus back
  if (state.sheetOpener && state.sheetOpener.focus) state.sheetOpener.focus();
  state.sheetOpener = null;
}
