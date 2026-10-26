// Claude access in Settings (docs/claude-access.md): your Claude keys (made, last used, Revoke), Make key, and a new key
// shown once with Copy (forgotten when the sheet closes). Shown only while signed in; the list is read when Settings opens.
import { marketEscape as esc } from '../core/format.js';
import { loadClaudeKeys, makeClaudeKey, revokeClaudeKey } from '../services/claude-keys.js';
import { state } from '../state.js';
import { effects } from './effects.js';
import { showError, showToast } from './feedback.js';
import { onSheetChange } from './sheets.js';

const day = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
const when = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

export function renderClaudeAccess() {
  const section = document.getElementById('claudeSection');
  section.style.display = state.session ? '' : 'none';
  if (!state.session) return;
  const keys = state.claudeKeys;
  const rows = state.claudeKeysError ? `<p class="hint">${esc(state.claudeKeysError)}</p>`
    : !keys ? '<p class="hint">Loading…</p>'
    : keys.map(k => `<div class="claude-key"><span>${esc(k.label)} · made ${esc(day(k.created_at))} · ${k.last_used_at ? `used ${esc(when(k.last_used_at))}` : 'not used yet'}</span>
        <button class="link-btn" data-action="revokeClaudeKey" data-arg="${esc(k.id)}" aria-label="Revoke the key made ${esc(day(k.created_at))}">Revoke</button></div>`).join('');
  const fresh = state.claudeNewKey ? `<div class="claude-new">
      <div class="field"><label for="claudeNewKey">Your new key</label><input type="text" id="claudeNewKey" readonly spellcheck="false" autocomplete="off" value="${esc(state.claudeNewKey)}" /></div>
      <button class="btn" data-action="copyClaudeKey">Copy</button>
      <p class="hint">Shown once. Add it to your Claude Code environment as the JOURNAL_KEY secret.</p></div>` : '';
  document.getElementById('claudeKeys').innerHTML = rows + fresh
    + `<div class="row" style="gap:8px;"><button class="btn" data-action="makeClaudeKey"${state.claudeBusy ? ' disabled' : ''}>Make key</button></div>`;
}

/** read your keys; a failure (the migration not pushed yet) says why in the section */
export async function loadClaudeAccess() {
  if (!state.session) return renderClaudeAccess();
  try { state.claudeKeys = await loadClaudeKeys(); state.claudeKeysError = ''; }
  catch(e) { state.claudeKeysError = String(e?.message || e); }
  renderClaudeAccess();
}

export async function makeClaudeAccessKey() {
  if (state.claudeBusy) return;
  state.claudeBusy = true;
  renderClaudeAccess();
  try {
    const { key, row } = await makeClaudeKey();
    state.claudeNewKey = key;
    state.claudeKeys = [...(state.claudeKeys || []), row];
    state.claudeKeysError = '';
  } catch(e) { showError(`Couldn't make a key: ${String(e?.message || e)}`); }
  finally { state.claudeBusy = false; renderClaudeAccess(); }
}

export function copyClaudeKey() {
  if (!state.claudeNewKey) return;
  effects.copyPlainText(state.claudeNewKey, 'your Claude key');
}

export async function revokeClaudeAccessKey(id) {
  try {
    await revokeClaudeKey(id);
    state.claudeKeys = (state.claudeKeys || []).filter(k => k.id !== id);
    showToast('Key revoked. Claude sessions using it are cut off.');
  } catch(e) { showError(`Couldn't revoke the key: ${String(e?.message || e)}`); }
  renderClaudeAccess();
}

// Settings opening reads the list; any sheet opening or closing forgets a new key, so it's only ever on screen once
onSheetChange(name => {
  const shown = !!state.claudeNewKey;
  state.claudeNewKey = '';
  if (name === 'settings') loadClaudeAccess();
  else if (shown) renderClaudeAccess();
});
