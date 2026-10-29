// Journal → Model Books: pasted chart screenshots with notes and references to My setups, found by setup or kept in books.
import { marketEscape as esc } from '../core/format.js';
import { buildLibrary } from '../core/journal-labels.js';
import { chipScrollLeft, modelExampleProblem, modelExamplesFor, modelSetupKeys } from '../core/model-books.js';
import { checkModelOwner, keepModelBook, keepModelExample, modelImageLinks, MODEL_IMAGE_BYTES, readModelBooks, removeModelBook, removeModelExample } from '../services/model-books.js';
import { createState, state } from '../state.js';
import { effects } from './effects.js';
import { showError, showToast } from './feedback.js';
import { pasteKey, touchOnly } from './journal-shots.js';

const modelState = () => state.modelBooks;
const modelLibrary = () => buildLibrary(state.journalReview?.library || []);
const modelOnPage = () => state.journalView && state.journalTab === 'books' && !state.journalTrade && !!state.session;
const owned = m => m === modelState() && m.owner === state.session?.user?.id;
const modelCount = n => `${n} example${n === 1 ? '' : 's'}`;
const modelBookOf = id => modelState().books.find(b => b.id === id);
const modelExampleOf = id => modelState().examples.find(e => e.id === id);
const modelUrl = path => { const link = modelState().urls[path]; return link?.expires > Date.now() ? link.url : ''; };
const modelError = e => String(e?.message || e);

/** Read on entering the tab; a new Google owner gets an empty state before any request starts. */
export async function loadModelBooks() {
  const uid = state.session?.user?.id;
  if (!uid) return;
  if (modelState().owner !== uid) state.modelBooks = { ...createState().modelBooks, owner: uid };
  const m = modelState();
  if (m.loading) return m.pending;
  if (m.busy || m.preparing || m.draft || m.bookDraft) return;
  m.loading = true; m.error = ''; renderModelBooks();
  m.pending = (async () => {
    try {
      const data = await readModelBooks(uid);
      if (!owned(m)) return;
      m.books = data.books; m.examples = data.examples; m.loaded = true;
      if (m.bookId && !modelBookOf(m.bookId)) m.bookId = '';
    } catch(e) { if (owned(m)) m.error = modelError(e); }
    finally { if (owned(m)) { m.loading = false; m.pending = null; renderModelBooks(); } }
  })();
  return m.pending;
}

export function selectModelBook(id = '') {
  const m = modelState();
  m.mode = 'books'; m.setupKey = ''; m.bookId = id; m.deleteKey = ''; m.viewerId = '';
  renderModelBooks();
}
export function selectModelSetup(key = '') {
  const m = modelState();
  m.mode = 'setups'; m.bookId = ''; m.setupKey = key; m.deleteKey = ''; m.viewerId = '';
  renderModelBooks();
}
export function setModelBrowse(mode) { return mode === 'setups' ? selectModelSetup() : selectModelBook(); }

export function editModelBook(id = '') {
  const m = modelState(); if (m.busy || !m.loaded) return;
  m.bookDraft = id ? { ...modelBookOf(id) } : { name: '', description: '' };
  m.error = ''; renderModelBooks();
  document.getElementById('modelBookName')?.focus();
}
export function modelBookField(field, value) {
  if (!modelState().busy && ['name', 'description'].includes(field) && modelState().bookDraft) modelState().bookDraft[field] = value;
}
export function modelExampleField(field, value) {
  if (!modelState().busy && ['title', 'notes', 'book_id'].includes(field) && modelState().draft) modelState().draft[field] = value;
}
export function toggleModelSetup(key) {
  const d = modelState().draft; if (!d || modelState().busy) return;
  const lib = modelLibrary(); key = lib.resolve('setup', key);
  d.setup_keys = modelSetupKeys(d.setup_keys, lib);
  d.setup_keys = d.setup_keys.includes(key) ? d.setup_keys.filter(k => k !== key) : [...d.setup_keys, key];
  renderModelBooks();
}
export function cancelModelDraft() {
  const m = modelState(); if (m.busy || m.preparing) return;
  if (m.draft?.preview) URL.revokeObjectURL(m.draft.preview);
  m.draft = null; m.bookDraft = null; m.error = ''; m.deleteKey = '';
  renderModelBooks();
}

export async function saveModelBook() {
  const m = modelState(), d = m.bookDraft;
  if (!d || m.busy || !owned(m)) return;
  const name = String(d.name || '').trim(), description = String(d.description || '').trim();
  if (!name || name.length > 120 || description.length > 4000) { m.error = 'Add a book name (up to 120 characters) and a description of up to 4,000 characters.'; renderModelBooks(); return; }
  const row = { id: d.id || crypto.randomUUID(), name, description, created_at: d.created_at || new Date().toISOString() };
  m.busy = true; m.error = ''; renderModelBooks();
  try {
    await keepModelBook(m.owner, row);
    if (!owned(m)) return;
    m.books = [...m.books.filter(b => b.id !== row.id), row]; m.bookDraft = null;
    m.mode = 'books'; m.bookId = row.id; m.setupKey = '';
    showToast(d.id ? 'Book updated.' : 'Book created. Paste a chart screenshot to add an example.');
  } catch(e) { if (owned(m)) m.error = `Couldn't save the book: ${modelError(e)}`; }
  finally { if (owned(m)) { m.busy = false; renderModelBooks(); } }
}

/** One screenshot per example. Pasting prepares a preview; Save is the only operation that uploads it. */
export async function pasteModelImages(files) {
  const m = modelState();
  if (!owned(m) || m.busy || m.preparing || !m.loaded || m.loading) return;
  if (m.draft || m.bookDraft) { showError('Save or cancel the open form before adding another screenshot.'); return; }
  const images = [...(files || [])].filter(f => /^image\//.test(f.type || ''));
  if (!images.length) { showError('Choose an image.'); return; }
  if (images.length > 1) showToast('Add one screenshot per example. Keeping the first one.');
  const file = images[0]; m.preparing = true; m.error = ''; renderModelBooks();
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('Choose an image under 25 MB.');
    const image = await effects.prepareImage(file);
    checkModelOwner(m.owner);
    if (!owned(m)) return;
    if (image.blob.size > MODEL_IMAGE_BYTES) throw new Error('The screenshot is still over 2 MB after shrinking.');
    m.draft = { book_id: m.bookId || '', title: '', notes: '', setup_keys: m.setupKey ? [m.setupKey] : [], image, preview: URL.createObjectURL(image.blob) };
  } catch(e) { if (owned(m)) m.error = modelError(e); }
  finally { if (owned(m)) { m.preparing = false; renderModelBooks(); document.getElementById('modelExampleTitle')?.focus(); } }
}
export function pickModelImage() { document.getElementById('modelImageInput')?.click(); }
export function editModelExample(id) {
  const m = modelState(), row = modelExampleOf(id); if (!row || m.busy || m.draft || m.bookDraft) return;
  m.draft = { ...row, setup_keys: modelSetupKeys(row.setup_keys, modelLibrary()) };
  m.error = ''; m.deleteKey = ''; renderModelBooks();
  document.getElementById('modelExampleTitle')?.focus();
}
export async function saveModelExample() {
  const m = modelState(), d = m.draft; if (!d || m.busy || !owned(m)) return;
  const problem = modelExampleProblem(d, m.books);
  if (problem) { m.error = problem; renderModelBooks(); return; }
  if (state.journalReviewError) { m.error = 'Your setups could not load. Reopen Journal to retry before saving.'; renderModelBooks(); return; }
  m.busy = true; m.error = ''; renderModelBooks();
  try {
    const saved = await keepModelExample(m.owner, { ...d, setup_keys: modelSetupKeys(d.setup_keys, modelLibrary()) });
    if (!owned(m)) return;
    const before = modelExampleOf(saved.id);
    m.examples = [...m.examples.filter(e => e.id !== saved.id), { ...before, ...saved }];
    if (d.preview) URL.revokeObjectURL(d.preview);
    // stay where you were: a book you're in follows the example to its book (All examples when it has none), and a
    // setup you're in stays while the example still carries it
    if (m.mode === 'books') { if (m.bookId) m.bookId = saved.book_id || ''; }
    else if (m.setupKey && !modelSetupKeys(saved.setup_keys, modelLibrary()).includes(modelLibrary().resolve('setup', m.setupKey))) m.setupKey = '';
    m.draft = null; m.imageError = '';
    showToast(d.id ? 'Example updated.' : 'Example saved.');
  } catch(e) { if (owned(m)) m.error = `Couldn't save the example: ${modelError(e)}`; }
  finally { if (owned(m)) { m.busy = false; renderModelBooks(); } }
}

export async function deleteModelExample(id) {
  const m = modelState(), row = modelExampleOf(id); if (!row || m.busy || !owned(m)) return;
  if (m.deleteKey !== id) { m.deleteKey = id; renderModelBooks(); return; }
  m.busy = true; m.error = ''; renderModelBooks();
  try {
    await removeModelExample(m.owner, row);
    if (!owned(m)) return;
    m.examples = m.examples.filter(e => e.id !== id); delete m.urls[row.path]; m.deleteKey = ''; showToast('Example deleted.');
  } catch(e) { if (owned(m)) m.error = `Couldn't delete the example: ${modelError(e)}`; }
  finally { if (owned(m)) { m.busy = false; renderModelBooks(); } }
}
export async function deleteModelBook(id) {
  const m = modelState(); if (!modelBookOf(id) || m.busy || !owned(m)) return;
  if (m.examples.some(e => e.book_id === id)) { m.error = 'Move or delete the examples before deleting this book.'; renderModelBooks(); return; }
  if (m.deleteKey !== id) { m.deleteKey = id; renderModelBooks(); return; }
  m.busy = true; m.error = ''; renderModelBooks();
  try {
    await removeModelBook(m.owner, id);
    if (!owned(m)) return;
    m.books = m.books.filter(b => b.id !== id); m.bookId = ''; m.deleteKey = ''; showToast('Book deleted.');
  } catch(e) { if (owned(m)) m.error = `Couldn't delete the book: ${modelError(e)}`; }
  finally { if (owned(m)) { m.busy = false; renderModelBooks(); } }
}

export async function refreshModelImages() {
  const m = modelState(); if (m.signing || !owned(m)) return;
  const paths = [...new Set(modelExamplesFor(m.examples, m, modelLibrary()).map(e => e.path).filter(p => !modelUrl(p)))];
  if (!paths.length) return;
  m.signing = true; m.imageError = '';
  try {
    const urls = await modelImageLinks(m.owner, paths);
    if (owned(m)) { Object.assign(m.urls, urls); if (paths.some(p => !urls[p])) m.imageError = 'Some screenshots could not load.'; }
  } catch(e) { if (owned(m)) m.imageError = `Screenshots unavailable: ${modelError(e)}`; }
  finally { if (owned(m)) { m.signing = false; renderModelBooks(); } }
}
export function openModelImage(id) { modelState().viewerId = id; renderModelBooks(); }
export function closeModelImage() { document.getElementById('modelImageViewer')?.close?.(); modelState().viewerId = ''; renderModelBooks(); }

function modelBookEditor() {
  const m = modelState(), d = m.bookDraft;
  return `<div class="mb-editor"><h2>${d.id ? 'Edit book' : 'New model book'}</h2>
    <label for="modelBookName">Name</label><input id="modelBookName" maxlength="120" autocomplete="off" placeholder="e.g. ATH AVWAP bounce" value="${esc(d.name)}" data-input="modelBookField" data-arg="name" data-enter="saveModelBook"${m.busy ? ' disabled' : ''} />
    <label for="modelBookDescription">Description <span>optional</span></label><textarea id="modelBookDescription" rows="4" maxlength="4000" placeholder="What belongs in this book?" data-input="modelBookField" data-arg="description"${m.busy ? ' disabled' : ''}>${esc(d.description)}</textarea>
    <div class="mb-actions"><button class="btn primary" data-action="saveModelBook"${m.busy ? ' disabled' : ''}>${m.busy ? 'Saving…' : 'Save book'}</button><button class="btn" data-action="cancelModelDraft"${m.busy ? ' disabled' : ''}>Cancel</button></div></div>`;
}
function modelExampleEditor(lib) {
  const m = modelState(), d = m.draft;
  const selected = modelSetupKeys(d.setup_keys, lib);
  const choices = [...new Set([...lib.choices('setup').map(s => s.key), ...selected])];
  const url = d.preview || modelUrl(d.path);
  return `<div class="mb-editor"><h2>${d.id ? 'Edit example' : 'New example'}</h2>
    ${url ? `<img class="mb-preview" src="${esc(url)}" alt="Chart screenshot preview" />` : ''}
    <label for="modelExampleTitle">Title</label><input id="modelExampleTitle" maxlength="120" autocomplete="off" placeholder="e.g. NVDA higher lows into the pivot" value="${esc(d.title)}" data-input="modelExampleField" data-arg="title"${m.busy ? ' disabled' : ''} />
    <label for="modelExampleBook">Book <span>optional</span></label><select id="modelExampleBook" data-change="modelExampleField" data-arg="book_id"${m.busy ? ' disabled' : ''}><option value=""${d.book_id ? '' : ' selected'}>No book</option>${m.books.map(b => `<option value="${esc(b.id)}"${d.book_id === b.id ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
    <label for="modelExampleNotes">Notes <span>optional</span></label><textarea id="modelExampleNotes" rows="4" maxlength="4000" placeholder="What makes this example worth studying?" data-input="modelExampleField" data-arg="notes"${m.busy ? ' disabled' : ''}>${esc(d.notes)}</textarea>
    ${state.journalReviewError ? '<p class="mb-error" role="status">Your setups could not load. Reopen Journal to retry before saving.</p>' : ''}
    <fieldset class="mb-setup-picker"${m.busy || state.journalReviewError ? ' disabled' : ''}><legend>My setups <span>optional</span></legend><p>Tag this example with your existing setups.</p><div class="mb-tags">${choices.map(k => `<button class="filter-btn${selected.includes(k) ? ' active' : ''}" aria-pressed="${selected.includes(k)}" data-action="toggleModelSetup" data-arg="${esc(k)}">${esc(lib.nameOf('setup', k, 'both'))}</button>`).join('')}</div></fieldset>
    <div class="mb-actions"><button class="btn primary" data-action="saveModelExample"${m.busy || state.journalReviewError ? ' disabled' : ''}>${m.busy ? 'Saving…' : 'Save example'}</button><button class="btn" data-action="cancelModelDraft"${m.busy ? ' disabled' : ''}>Cancel</button></div></div>`;
}
const modelTags = (keys, lib) => keys.length ? `<div class="mb-tags">${keys.map(k => `<button class="filter-btn" data-action="selectModelSetup" data-arg="${esc(k)}">${esc(lib.nameOf('setup', k, 'both'))}</button>`).join('')}</div>` : '';
/** A gallery tile: the chart first, then what it is. The book is named only where examples from several books mix. */
function modelExampleCard(e, lib) {
  const m = modelState(), url = modelUrl(e.path), keys = modelSetupKeys(e.setup_keys, lib);
  const book = m.bookId ? '' : modelBookOf(e.book_id)?.name || '';
  return `<article class="mb-example" id="model-example-${esc(e.id)}">
    ${url ? `<button class="mb-image" data-action="openModelImage" data-arg="${esc(e.id)}" aria-label="Open screenshot: ${esc(e.title)}"><img src="${esc(url)}" alt="${esc(e.title)}" width="${e.width}" height="${e.height}" loading="lazy" /></button>` : '<div class="mb-image mb-image-wait">Loading screenshot…</div>'}
    <div class="mb-example-body"><h3>${esc(e.title)}</h3>${book ? `<span class="mb-meta">${esc(book)}</span>` : ''}
    ${modelTags(keys, lib)}
    ${e.notes ? `<p class="mb-notes">${esc(e.notes)}</p>` : ''}</div>
    <div class="mb-example-foot mb-actions"><button class="pos-link" data-action="editModelExample" data-arg="${esc(e.id)}"${m.busy ? ' disabled' : ''}>Edit</button><button class="pos-link journal-danger" data-action="deleteModelExample" data-arg="${esc(e.id)}"${m.busy ? ' disabled' : ''}>${m.deleteKey === e.id ? 'Delete for good?' : 'Delete'}</button>${m.deleteKey === e.id ? '<button class="pos-link" data-action="cancelModelDraft">Cancel</button>' : ''}</div></article>`;
}
/** Full size with everything the tile clamps: book, setups and the whole note. */
function modelViewer(e, lib) {
  const url = modelUrl(e.path), keys = modelSetupKeys(e.setup_keys, lib), book = modelBookOf(e.book_id)?.name || '';
  return `<dialog class="mb-viewer" id="modelImageViewer" aria-label="Chart screenshot: ${esc(e.title)}"><div class="mb-viewer-bar"><div><strong>${esc(e.title)}</strong>${book ? `<span class="mb-meta">${esc(book)}</span>` : ''}</div>
    <div class="mb-actions">${url ? `<a class="pos-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open full size</a>` : ''}<button class="btn" data-action="closeModelImage" autofocus>Close</button></div></div>
    ${url ? `<img src="${esc(url)}" alt="${esc(e.title)}" />` : ''}
    ${keys.length || e.notes ? `<div class="mb-viewer-body">${modelTags(keys, lib)}${e.notes ? `<p class="mb-notes">${esc(e.notes)}</p>` : ''}</div>` : ''}</dialog>`;
}

export function renderModelBooks() {
  const el = document.getElementById('modelBooksBody'); if (!el || !modelOnPage()) return;
  const m = modelState(); if (!owned(m)) { el.innerHTML = ''; return; }
  const active = document.activeElement;
  const focus = active?.id?.startsWith('model') ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  const rowScroll = el.querySelector?.('.mb-nav-list')?.scrollLeft || 0; // the phone's sideways chip row, kept where it was
  const lib = modelLibrary(), list = modelExamplesFor(m.examples, m, lib);
  const book = modelBookOf(m.bookId);
  // every one of My setups, so a setup's first example can start here, then any hidden one an example still carries
  const setupKeys = [...new Set([...lib.choices('setup').map(s => s.key), ...m.examples.flatMap(e => modelSetupKeys(e.setup_keys, lib))])];
  const nav = (label, count, action, key, active) => `<button class="mb-nav${active ? ' active' : ''}" ${action === 'selectModelSetup' ? 'data-action="selectModelSetup"' : 'data-action="selectModelBook"'} data-arg="${esc(key)}"${active ? ' aria-current="true"' : ''}><span>${esc(label)}</span><small>${count}</small></button>`;
  const title = m.setupKey ? lib.nameOf('setup', m.setupKey, 'both') : book?.name || 'All examples';
  const err = m.error ? `<p class="mb-error" role="alert">${esc(m.error)}</p>` : '';
  el.innerHTML = `<div class="mb-shell"><aside class="mb-sidebar" aria-label="Model book navigation">
    <div class="mb-sidebar-head"><h2>Model books</h2><button class="pos-link" data-action="editModelBook"${m.busy || m.draft || m.bookDraft || !m.loaded || m.loading ? ' disabled' : ''}>+ New book</button></div>
    <div class="seg mb-browse" aria-label="Browse examples"><button class="${m.mode === 'books' ? 'active' : ''}" aria-pressed="${m.mode === 'books'}" data-action="setModelBrowse" data-arg="books">By book</button><button class="${m.mode === 'setups' ? 'active' : ''}" aria-pressed="${m.mode === 'setups'}" data-action="setModelBrowse" data-arg="setups">By setup</button></div>
    <div class="mb-nav-list">${nav('All examples', m.examples.length, m.mode === 'setups' ? 'selectModelSetup' : 'selectModelBook', '', !m.bookId && !m.setupKey)}${m.mode === 'books'
      ? m.books.map(b => nav(b.name, m.examples.filter(e => e.book_id === b.id).length, 'selectModelBook', b.id, m.bookId === b.id)).join('')
      : setupKeys.map(k => nav(lib.nameOf('setup', k, 'both'), modelExamplesFor(m.examples, { setupKey: k }, lib).length, 'selectModelSetup', k, m.setupKey === k)).join('')}</div>
    <p class="mb-sidebar-hint">${m.mode === 'setups' ? 'Every chart tagged with a setup, in a book or not.' : 'Books are optional collections. A chart with no book is in All examples.'}</p></aside>
    <div class="mb-content">${err}${m.loading ? '<p class="hint" role="status">Loading model books…</p>' : ''}${m.error && !m.loaded ? '<button class="btn" data-action="loadModelBooks">Retry</button>' : ''}
    ${m.bookDraft ? modelBookEditor() : m.draft ? modelExampleEditor(lib) : `<div class="mb-feed-head"><div><h2>${esc(title)}</h2><p class="mb-meta">${modelCount(list.length)}${m.setupKey && m.books.length ? ' across your books' : ''}${book ? ` · <button class="pos-link" data-action="editModelBook" data-arg="${esc(book.id)}">Edit book</button> · <button class="pos-link journal-danger" data-action="deleteModelBook" data-arg="${esc(book.id)}">${m.deleteKey === book.id ? 'Delete for good?' : 'Delete book'}</button>${m.deleteKey === book.id ? ' <button class="pos-link" data-action="cancelModelDraft">Cancel</button>' : ''}` : ''}</p></div>
      <div class="mb-add"><button class="btn primary" data-action="pickModelImage"${m.preparing || m.loading || !m.loaded ? ' disabled' : ''}>${m.preparing ? 'Preparing…' : '+ Add example'}</button>${touchOnly() ? '' : `<span class="mb-paste-hint">or press ${pasteKey()}, or drop an image</span>`}</div></div>
      ${book?.description ? `<p class="mb-description">${esc(book.description)}</p>` : ''}
      ${m.imageError ? `<p class="mb-error" role="status">${esc(m.imageError)} <button class="pos-link" data-action="refreshModelImages">Retry images</button></p>` : ''}
      ${list.length ? `<div class="mb-grid">${list.map(e => modelExampleCard(e, lib)).join('')}</div>` : !m.loading && m.loaded ? `<div class="mb-empty"><span class="mb-empty-icon" aria-hidden="true">▧</span><h3>Your next model starts with a chart</h3><p>${m.setupKey ? 'Add a chart and it comes tagged with this setup.' : m.bookId ? 'Add a chart and it goes in this book.' : 'Paste a screenshot from your charting platform, add what you noticed, and tag it with My setups.'}</p></div>` : ''}`}
    <input type="file" id="modelImageInput" accept="image/png,image/jpeg,image/webp" hidden data-change="modelImagePicked" />
    </div></div>${m.viewerId && modelExampleOf(m.viewerId) ? modelViewer(modelExampleOf(m.viewerId), lib) : ''}`;
  const row = el.querySelector?.('.mb-nav-list'), chip = row?.querySelector('.mb-nav.active');
  if (row && chip && row.scrollWidth > row.clientWidth) { // phones: the selected book or setup stays in view
    const at = chip.getBoundingClientRect().left - row.getBoundingClientRect().left;
    row.scrollLeft = chipScrollLeft(rowScroll, row.clientWidth, at + row.scrollLeft, chip.getBoundingClientRect().width);
  }
  if (m.viewerId) document.getElementById('modelImageViewer')?.showModal?.();
  if (focus && (m.draft || m.bookDraft)) {
    const field = document.getElementById(focus.id);
    field?.focus({ preventScroll: true });
    if (Number.isInteger(focus.start)) field?.setSelectionRange?.(focus.start, focus.end);
  }
  if (!m.signing && !m.imageError && list.some(e => !modelUrl(e.path))) queueMicrotask(refreshModelImages);
}

/** Image paste belongs to this tab; ordinary text paste still belongs to the focused input. */
export function initModelBookEvents() {
  document.addEventListener('paste', e => {
    if (!modelOnPage() || state.openSheetName) return;
    const files = [...(e.clipboardData?.files || [])].filter(f => /^image\//.test(f.type || ''));
    if (!files.length) return;
    e.preventDefault(); pasteModelImages(files);
  });
  const section = document.getElementById('journalSection');
  section?.addEventListener('dragover', e => { if (modelOnPage() && [...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  section?.addEventListener('drop', e => { if (modelOnPage() && e.dataTransfer?.files?.length) { e.preventDefault(); pasteModelImages(e.dataTransfer.files); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modelOnPage() && modelState().viewerId) { e.preventDefault(); closeModelImage(); } });
  document.addEventListener('click', e => { if (e.target?.id === 'modelImageViewer') closeModelImage(); });
}
