// Trade screenshots (step 3; docs/journal-step-3.md): the Screenshots row in the Review section (thumbnails, Add
// screenshot, paste anywhere on the trade page, drop onto it), the viewer (#shotViewer: full size, caption, delete), and
// the shrinking goes through effects.prepareImage (ui/image-prep.js). services/journal-shots.js keeps them.
import { marketEscape as esc } from '../core/format.js';
import { deleteShot, loadShots, MAX_SHOT_BYTES, MAX_SHOTS, saveShotCaption, signShots, uploadShot } from '../services/journal-shots.js';
import { state } from '../state.js';
import { effects } from './effects.js';
import { pastedImages } from './image-prep.js';
import { showError, showToast } from './feedback.js';

/** a picked or pasted file bigger than this isn't read at all */
const MAX_RAW_BYTES = 25 * 1024 * 1024;

// The trade page registers how to redraw itself. It can do that before this module has finished loading (effects.js
// sits in a long import loop back to the Journal), so the hook is a hoisted var with no initializer and a function
// declaration: registering early can't hit a not-yet-initialized binding, and nothing resets it afterwards.
var redrawHook; // eslint-disable-line no-var
function rerender() { if (redrawHook) redrawHook(); }
export function onShotsChange(fn) { redrawHook = fn; }

/** read every screenshot of yours with the journal; a failure says why in the row and nothing else breaks */
export async function loadJournalShots() {
  try {
    state.journalShots = await loadShots();
    state.journalShotsError = '';
  } catch(e) {
    state.journalShotsError = String(e?.message || e);
  }
}

const shotsOf = t => (state.journalShots || []).filter(s => s.trade_key === t.key);

/** signed links for the trade's screenshots that don't have one yet (they last an hour; a reload signs again) */
async function sign(t) {
  const need = shotsOf(t).map(s => s.path).filter(p => !state.journalShotUrls[p]);
  if (!need.length) return;
  try {
    Object.assign(state.journalShotUrls, await signShots(need));
    rerender();
  } catch(e) { /* thumbnails stay blank; the next open asks again */ }
}

// ---------- adding ----------

/** Add screenshot, paste or drop: each image shrunk, kept, and shown; ten a trade at most */
export async function addTradeShots(t, fileList) {
  if (!t || state.journalShotsError) { if (state.journalShotsError) showError(`Screenshots unavailable: ${state.journalShotsError}`); return; }
  const files = [...(fileList || [])].filter(f => /^image\//.test(f.type || ''));
  if (!files.length) { showError('That isn\'t an image.'); return; }
  const room = MAX_SHOTS - shotsOf(t).length;
  if (room <= 0) { showError(`Ten screenshots a trade at most.`); return; }
  if (files.length > room) showError(`Only ${room} more fit on this trade; keeping the first ${room}.`);
  state.shotsBusy = (state.shotsBusy || 0) + Math.min(files.length, room);
  rerender();
  let kept = 0;
  for (const f of files.slice(0, room)) {
    try {
      if (f.size > MAX_RAW_BYTES) throw new Error('that image is over 25 MB');
      const img = await effects.prepareImage(f);
      if (img.blob.size > MAX_SHOT_BYTES) throw new Error('even shrunk, that image is over 2 MB');
      const row = await uploadShot(t.key, img);
      state.journalShots = [...(state.journalShots || []), row];
      kept++;
    } catch(e) {
      showError(`Couldn't keep the screenshot: ${String(e?.message || e)}`);
    } finally {
      state.shotsBusy--;
      rerender();
    }
  }
  if (kept) { showToast(kept === 1 ? 'Screenshot kept.' : `${kept} screenshots kept.`); sign(t); }
}

/** the paste key on this device, for the hint: ⌘V on a Mac or iPad, Ctrl+V elsewhere */
export const pasteKey = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '') ? '⌘V' : 'Ctrl+V';
/** a touch screen with no keyboard to press it on: the hint points at the button instead */
export const touchOnly = () => !!globalThis.matchMedia?.('(pointer: coarse)')?.matches && !globalThis.matchMedia?.('(pointer: fine)')?.matches;

/** Paste from clipboard: the image you copied, straight from the clipboard */
export async function pasteTradeShot(t) {
  let images;
  try { images = await effects.readClipboardImages(); }
  catch(e) {
    const why = e?.name === 'NotAllowedError' ? 'The browser didn\'t allow reading the clipboard.' : 'This browser can\'t paste images from a button.';
    showError(`${why} Press ${pasteKey()} on this page instead, or use + Add screenshot.`);
    return;
  }
  if (!images.length) { showError('No image on the clipboard. Copy a screenshot first, then Paste.'); return; }
  return addTradeShots(t, images);
}

/** Add screenshot: the hidden file picker (the photo library on a phone) */
export function pickTradeShots() { document.getElementById('tradeShotInput')?.click?.(); }

// ---------- the row ----------

export function shotsRowHtml(t) {
  if (t.status === 'history') return '';
  if (state.journalShotsError) return `<div class="jr-row"><div class="jr-label">Screenshots</div><p class="hint" style="color:var(--amber)">Screenshots unavailable: ${esc(state.journalShotsError)}</p></div>`;
  const shots = shotsOf(t);
  if (shots.some(s => !state.journalShotUrls[s.path])) queueMicrotask(() => sign(t));
  const thumbs = shots.map(s => {
    const url = state.journalShotUrls[s.path];
    return `<button class="jr-shot" data-action="openShot" data-arg="${esc(s.id)}" aria-label="Open screenshot${s.caption ? `: ${esc(s.caption)}` : ''}">${url ? `<img src="${esc(url)}" alt="${esc(s.caption || 'Screenshot')}" loading="lazy" />` : '<span class="jr-shot-wait">…</span>'}</button>`;
  }).join('');
  const busy = state.shotsBusy ? `<span class="jr-shot-busy">Keeping ${state.shotsBusy}…</span>` : '';
  const full = shots.length >= MAX_SHOTS;
  return `<div class="jr-row"><div class="jr-label">Screenshots<span class="jr-sub">${touchOnly() ? 'copy a screenshot, then tap Paste' : `or press ${pasteKey()} on this page, or drop one here`}</span></div>
    <div class="chip-row jr-chips jr-shots">${thumbs}${busy}
      <button class="btn" data-action="pasteTradeShot"${full ? ' disabled title="Ten a trade at most"' : ''}>Paste from clipboard</button>
      <button class="btn" data-action="pickTradeShots"${full ? ' disabled title="Ten a trade at most"' : ''}>+ Add screenshot</button>
      <input type="file" id="tradeShotInput" accept="image/*" multiple hidden data-change="addTradeShotsFromInput" />
    </div></div>`;
}

// ---------- the viewer ----------

const shotById = id => (state.journalShots || []).find(s => s.id === id);

export function openShot(id) {
  const s = shotById(id);
  if (!s) return;
  state.shotView = id;
  state.shotDeleteArmed = false;
  renderShotViewer();
}
export function closeShotViewer() { state.shotView = null; renderShotViewer(); }

export function renderShotViewer() {
  const el = document.getElementById('shotViewer');
  if (!el) return;
  const s = state.shotView ? shotById(state.shotView) : null;
  el.style.display = s ? '' : 'none';
  if (!s) return;
  const url = state.journalShotUrls[s.path] || '';
  document.getElementById('shotViewerImg').src = url;
  document.getElementById('shotViewerImg').alt = s.caption || 'Screenshot';
  document.getElementById('shotCaption').value = s.caption || '';
  const open = document.getElementById('shotOpen');
  open.href = url;
  document.getElementById('shotDelete').textContent = state.shotDeleteArmed ? 'Delete for good?' : 'Delete';
}

export async function saveTradeShotCaption(text) {
  const s = shotById(state.shotView);
  if (!s) return;
  const caption = String(text || '').trim().slice(0, 300) || null;
  if (caption === (s.caption || null)) return;
  const before = s.caption;
  s.caption = caption;
  rerender();
  try { await saveShotCaption(s.id, caption); }
  catch(e) { s.caption = before; showError(`Couldn't save the caption: ${String(e?.message || e)}`); rerender(); renderShotViewer(); }
}

/** Delete asks once ("Delete for good?"), then the file and its row go */
export async function deleteTradeShot() {
  const s = shotById(state.shotView);
  if (!s) return;
  if (!state.shotDeleteArmed) { state.shotDeleteArmed = true; renderShotViewer(); return; }
  try {
    await deleteShot(s);
    state.journalShots = (state.journalShots || []).filter(x => x.id !== s.id);
    delete state.journalShotUrls[s.path];
    closeShotViewer();
    showToast('Screenshot deleted.');
    rerender();
  } catch(e) {
    state.shotDeleteArmed = false;
    showError(`Couldn't delete the screenshot: ${String(e?.message || e)}`);
    renderShotViewer();
  }
}

/** paste a screenshot anywhere on the trade page, drop one onto it, Esc closes the viewer */
export function initTradeShotEvents(pageTrade) {
  const onPage = () => state.journalView && state.journalTrade;
  document.addEventListener('paste', e => {
    if (!onPage()) return;
    const files = pastedImages(e.clipboardData);
    if (!files.length) return; // text pastes into the note as usual
    e.preventDefault();
    addTradeShots(pageTrade(), files);
  });
  const section = document.getElementById('journalTradeSection');
  section?.addEventListener('dragover', e => { if (onPage() && [...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); section.classList.add('jr-dropping'); } });
  section?.addEventListener('dragleave', () => section.classList.remove('jr-dropping'));
  section?.addEventListener('drop', e => {
    section.classList.remove('jr-dropping');
    if (!onPage() || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    addTradeShots(pageTrade(), e.dataTransfer.files);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.shotView) { e.preventDefault(); closeShotViewer(); } });
}
