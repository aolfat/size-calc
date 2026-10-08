// Keyboard shortcuts: one keydown listener, ignored while typing or while a sheet is open.
import { state } from '../state.js';
import { cycleExp, setSide, setZoneMode } from './chain.js';
import { closeDetails } from './detail.js';
import { setFuturesDirection } from './futures.js';
import { toggleLive } from './live.js';
import { marketRefreshToday, marketSetScope } from './market.js';
import { refreshPositions } from './positions.js';
import { toggleQuick } from './quick-lookup.js';
import { stepRisk } from './risk.js';
import { closeSheet } from './sheets.js';
import { closeSim } from './sim.js';
import { cancelSpread } from './spreads.js';
import { setDirection } from './stops.js';
import { refreshQuote } from './ticker.js';
import { setMode, setView } from './views.js';

export function toggleKbdHelp() {
  const h = document.getElementById('kbdHelp');
  h.style.display = h.style.display === 'none' ? 'block' : 'none';
}

export function initShortcuts() {
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'select' || tag === 'textarea';
    if (e.key === 'Escape') {
      if (state.openSheetName) { closeSheet(); return; }
      if (state.simState) { closeSim(); return; }
      if (state.spreadPending) { cancelSpread(); return; }
      if (typing) { e.target.blur(); return; }
      if (state.marketView && state.marketState.group) { marketSetScope('groups'); return; }
      closeDetails();
      return;
    }
    if (typing && e.key === '/' && e.target.id === 'ticker') { e.preventDefault(); e.target.select(); return; } // '/' re-selects even from inside the field
    if (typing || state.openSheetName) return; // never hijack keys while filling a field or working in a sheet
    const focus = id => { e.preventDefault(); document.getElementById(id).focus(); };
    if (state.marketView && !['/', 'm', 's', 'o', 'f', 'v', 't', 'u', 'r', '?'].includes(e.key)) return;
    switch (e.key) {
      case '/': {
        if (!state.marketView && state.currentMode === 'futures') { setView('calc'); focus('futuresContract'); break; }
        const id = state.marketView ? 'marketSearch' : 'ticker';
        focus(id); document.getElementById(id).select(); break;
      }
      case 'q': if (state.currentMode !== 'futures') { toggleQuick(true); focus('quickInput'); } break;
      case 's': setMode('shares'); break;
      case 'o': setMode('options'); break;
      case 'f': setMode('futures'); break;
      case 'v': setView(state.positionsView ? 'calc' : 'positions'); break;
      case 't':
      case 'u': setView(state.utilsView ? 'calc' : 'utils'); break;
      case 'm': setView(state.marketView ? 'calc' : 'market'); break;
      case 'r': if (state.marketView) marketRefreshToday(); else if (state.positionsView) refreshPositions(true); else refreshQuote(); break;
      case 'l': toggleLive(); break;
      case '-': stepRisk(-1); break;
      case '=':
      case '+': stepRisk(1); break;
      case 'd':
        if (state.currentMode === 'futures') setFuturesDirection(state.futuresDirection === 'long' ? 'short' : 'long');
        else if (state.currentMode === 'shares') setDirection(state.direction === 'long' ? 'short' : 'long');
        break;
      case 'b': if (state.currentMode === 'options') setSide('both'); break;
      case 'c': if (state.currentMode === 'options') setSide('call'); break;
      case 'p': if (state.currentMode === 'options') setSide('put'); break;
      case '1': if (state.currentMode === 'options') setZoneMode('otm'); break;
      case '2': if (state.currentMode === 'options') setZoneMode('itm'); break;
      case '3': if (state.currentMode === 'options') setZoneMode('both'); break;
      case '4': if (state.currentMode === 'options') setZoneMode('all'); break;
      case '[': cycleExp(-1); break;
      case ']': cycleExp(1); break;
      case '?': toggleKbdHelp(); break;
    }
  });
}
