// @ts-check
// Model Books: screenshot examples grouped into books and tagged with references to the existing setup library.

/** Setup keys after library merges, once each. @param {string[]} keys @param {ReturnType<typeof import('./journal-labels.js').buildLibrary>} lib */
export function modelSetupKeys(keys, lib) {
  return [...new Set((keys || []).map(k => lib.resolve('setup', k)))];
}

/** Examples for one book, or a setup across every book. @param {any[]} examples @param {{ bookId?: string, setupKey?: string }} filter @param {ReturnType<typeof import('./journal-labels.js').buildLibrary>} lib */
export function modelExamplesFor(examples, { bookId = '', setupKey = '' }, lib) {
  const key = lib.resolve('setup', setupKey);
  return examples.filter(e => setupKey ? modelSetupKeys(e.setup_keys, lib).includes(key) : !bookId || e.book_id === bookId)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || a.id.localeCompare(b.id));
}

/** Validate the editor before keeping an example. @param {any} draft @param {any[]} books */
export function modelExampleProblem(draft, books) {
  if (!draft || !books.some(b => b.id === draft.book_id)) return 'Choose a model book.';
  if (!String(draft.title || '').trim()) return 'Give this example a title.';
  if (String(draft.title).trim().length > 120) return 'Keep the title to 120 characters.';
  if (String(draft.notes || '').length > 4000) return 'Keep the notes to 4,000 characters.';
  if (!draft.id && !draft.image) return 'Paste or choose a chart screenshot.';
  return '';
}
