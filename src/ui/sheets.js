import { state } from '../state.js';

export const SHEETS = { settings: 'settingsSheet', risk: 'riskSheet' };

export function openSheet(name) {
  if (!SHEETS[name]) return;
  if (!state.openSheetName) state.sheetOpener = document.activeElement;
  for (const [n, id] of Object.entries(SHEETS)) document.getElementById(id).style.display = n === name ? '' : 'none';
  document.getElementById('sheetBackdrop').style.display = '';
  state.openSheetName = name;
  // an empty key field is the one place focus helps; elsewhere it would pop the phone keyboard over the chips
  const keyEl = document.getElementById('apiKey');
  if (name === 'settings' && !keyEl.value.trim()) keyEl.focus();
  else document.getElementById(SHEETS[name]).focus();
}

export function closeSheet() {
  for (const id of Object.values(SHEETS)) document.getElementById(id).style.display = 'none';
  document.getElementById('sheetBackdrop').style.display = 'none';
  state.openSheetName = null;
  if (state.sheetOpener && state.sheetOpener.focus) state.sheetOpener.focus();
  state.sheetOpener = null;
}
