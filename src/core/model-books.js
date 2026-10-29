// @ts-check
// Model Books: screenshot examples tagged with references to the existing setup library, and kept in a book if you like.

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

/**
 * Validate the editor before keeping an example; the book is optional. A new one needs its screenshot: a pasted image, or
 * (from a trade page) one of the trade's screenshots, shot. @param {any} draft @param {any[]} books
 */
export function modelExampleProblem(draft, books) {
  if (!draft) return 'Paste or choose a chart screenshot.';
  if (draft.book_id && !books.some(b => b.id === draft.book_id)) return 'That book is gone. Choose another, or No book.';
  if (!String(draft.title || '').trim()) return 'Give this example a title.';
  if (String(draft.title).trim().length > 120) return 'Keep the title to 120 characters.';
  if (String(draft.notes || '').length > 4000) return 'Keep the notes to 4,000 characters.';
  if (!draft.id && draft.trade_key && !draft.shot) return 'Add a screenshot of this trade first: the example keeps a copy of it.';
  if (!draft.id && !draft.trade_key && !draft.image) return 'Paste or choose a chart screenshot.';
  return '';
}

/**
 * Where a sideways chip row scrolls so its selected chip shows: as it was when the chip is already in view, else just
 * far enough to show it with a little of the next one. @param {number} scroll @param {number} view the row's width
 * @param {number} start the chip's left edge in the row's content @param {number} size the chip's width
 */
export function chipScrollLeft(scroll, view, start, size, peek = 24) {
  if (start < scroll) return Math.max(0, start - peek);
  if (start + size > scroll + view) return start + size - view + peek;
  return scroll;
}
