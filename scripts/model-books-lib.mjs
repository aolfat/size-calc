// Model books as a Claude session sees them (docs/claude-access.md), pure: what claude_model_books_read returns, books
// and examples in words, and a book or example you describe ({ book: 'Best longs', setups: ['EMA 21 bounce'] }) turned
// into the changes claude_model_books_save and the claude-model-example function take: the book is optional (by name,
// a new name makes the book), setups matched to My setups or added to your library, as the review's names are. Nothing here reads the
// network or a file.
import { randomUUID } from 'node:crypto';
import { buildLibrary } from '../src/core/journal-labels.js';
import { modelExamplesFor, modelSetupKeys } from '../src/core/model-books.js';
import { librarian } from './journal-lib.mjs';

/** everything a book and an example may say */
export const BOOK_FIELDS = ['name', 'description'];
export const EXAMPLE_FIELDS = ['book', 'title', 'notes', 'setups'];

/** a short handle for a book or an example: the first 8 of its id */
export const shortId = id => String(id).slice(0, 8);
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** @param {{ books: any[], examples: any[], library: any[] }} data */
export function booksFrom(data) {
  const rows = data.library || [];
  return { books: data.books || [], examples: data.examples || [], rows, lib: buildLibrary(rows) };
}

/** a row by its id or its handle (a prefix of 6 or more that only one has) */
const byId = (list, ref) => {
  const r = String(ref || '').trim().toLowerCase();
  if (!r) return null;
  const hit = list.find(x => x.id === r);
  if (hit) return hit;
  const some = r.length >= 6 ? list.filter(x => x.id.startsWith(r)) : [];
  return some.length === 1 ? some[0] : null;
};
/** a book by its id, handle or name @param {ReturnType<typeof booksFrom>} m @param {string} ref */
export const bookBy = (m, ref) => byId(m.books, ref) || m.books.find(b => norm(b.name) === norm(ref)) || null;
/** an example by its id or handle @param {ReturnType<typeof booksFrom>} m @param {string} ref */
export const exampleBy = (m, ref) => byId(m.examples, ref);

const clip = (s, n) => s.length > n ? `${s.slice(0, n - 1)}…` : s;
/** an example's line: handle, title, its setups, the start of its notes */
export function exampleLine(m, e) {
  const setups = modelSetupKeys(e.setup_keys, m.lib).map(k => m.lib.nameOf('setup', k, 'both'));
  const notes = String(e.notes || '').replace(/\s+/g, ' ').trim();
  return [shortId(e.id), e.title, setups.join(', '), notes && clip(notes, 80)].filter(Boolean).join(' · ');
}

/** every book (or one) with its examples, newest first, then the examples in no book */
export function booksText(m, only = null) {
  const books = only ? [only] : m.books;
  const loose = only ? [] : modelExamplesFor(m.examples.filter(e => !e.book_id), {}, m.lib);
  if (!books.length && !loose.length) return 'No model book examples yet.';
  const lines = books.map(b => {
    const list = modelExamplesFor(m.examples, { bookId: b.id }, m.lib);
    const head = `${shortId(b.id)} · ${b.name} (${list.length} example${list.length === 1 ? '' : 's'})${b.description ? ` · ${clip(b.description.replace(/\s+/g, ' '), 100)}` : ''}`;
    return [head, ...list.map(e => `  ${exampleLine(m, e)}`)].join('\n');
  });
  if (loose.length) lines.push([`No book (${loose.length} example${loose.length === 1 ? '' : 's'})`, ...loose.map(e => `  ${exampleLine(m, e)}`)].join('\n'));
  return lines.join('\n');
}

const text = (input, field, max, { required = false } = {}) => {
  const v = input[field] === null || input[field] === undefined ? '' : String(input[field]).trim();
  if (required && !v) throw new Error(`${field}: needs one`);
  if (v.length > max) throw new Error(`${field}: ${max} characters at most`);
  return v;
};
const only = (input, fields, what) => {
  const unknown = Object.keys(input).filter(k => !fields.includes(k));
  if (unknown.length) throw new Error(`${what} takes ${fields.join(', ')}; not ${unknown.join(', ')}`);
};

/**
 * A new book (book null) or a change to one, as the row claude_model_books_save takes.
 * @param {ReturnType<typeof booksFrom>} m @param {any} book @param {Record<string, any>} input @param {{ newId?: () => string }} [opts]
 */
export function planBook(m, book, input, opts = {}) {
  only(input, BOOK_FIELDS, 'a book');
  const name = 'name' in input || !book ? text(input, 'name', 120, { required: true }) : book.name;
  const description = 'description' in input ? text(input, 'description', 4000) : book?.description || '';
  const clash = m.books.find(b => b.id !== book?.id && norm(b.name) === norm(name));
  if (clash) throw new Error(`you already have a book called ${clash.name} (${shortId(clash.id)})`);
  const row = { id: book?.id || (opts.newId || randomUUID)(), name, description };
  const same = book && book.name === name && (book.description || '') === description;
  return { changes: { books: same ? [] : [row], examples: [] }, said: same ? [] : [book ? `Book ${name}.` : `New book: ${name}.`], book: row };
}

/**
 * A new example (example null: what the claude-model-example function takes, as add) or a change to one (the changes
 * claude_model_books_save takes). book: optional, a name or handle, a new name makes the book; null (or left out of a
 * new example) is no book. setups: names or keys of My setups, each one new added as + New setup does; the list given replaces the
 * example's. Fields left out stay; null clears notes or setups. library is for claude_journal_save, saved first.
 * @param {ReturnType<typeof booksFrom>} m @param {any} example @param {Record<string, any>} input @param {{ newId?: () => string }} [opts]
 * @returns {{ library: any[], changes: { books: any[], examples: any[] }, add: any, said: string[] }}
 */
export function planExample(m, example, input, opts = {}) {
  only(input, EXAMPLE_FIELDS, 'an example');
  const newId = opts.newId || randomUUID;
  const names = librarian(m, { newId });
  const books = [], fields = {};
  let bookId = example?.book_id || null;
  if ('book' in input) {
    const ref = input.book === null ? '' : String(input.book).trim();
    const hit = ref ? bookBy(m, ref) : null;
    const made = hit || !ref ? null : planBook(m, null, { name: ref }, { newId });
    bookId = hit ? hit.id : made ? made.book.id : null;
    if (made) { books.push(made.book); names.said.push(...made.said); }
    if (example && bookId !== (example.book_id || null)) fields.book_id = bookId;
  }
  if ('title' in input || !example) {
    const title = text(input, 'title', 120, { required: true });
    if (title !== example?.title) fields.title = title;
  }
  if ('notes' in input) {
    const notes = text(input, 'notes', 4000);
    if (notes !== (example?.notes || '')) fields.notes = notes;
  }
  if ('setups' in input) {
    const raw = input.setups;
    const list = raw === null || raw === '' ? [] : Array.isArray(raw) ? raw : [raw];
    const keys = [...new Set(list.map(ref => names.itemKey('setup', ref)))];
    if (keys.length > 100) throw new Error('setups: 100 at most');
    const had = modelSetupKeys(example?.setup_keys, m.lib);
    if (keys.length !== had.length || keys.some(k => !had.includes(k))) fields.setup_keys = keys;
  }
  const add = example ? null : { book_id: bookId, title: fields.title, notes: fields.notes || '', setup_keys: fields.setup_keys || [] };
  const examples = example && Object.keys(fields).length ? [{ id: example.id, fields }] : [];
  return { library: names.library, changes: { books, examples }, add, said: names.said };
}
