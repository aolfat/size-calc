// Preloaded into scripts/journal.mjs by tests/claude-access.test.mjs (node --import): fetch answers the Claude functions
// and the claude-model-example Edge Function from a JSON file instead of Supabase. FAKE_JOURNAL names the file ({ data,
// books, key }); each save's body is appended to its saves list (with fn, the function's name), each added example to
// its added list, and a wrong key is refused the way the database refuses it.
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.env.FAKE_JOURNAL;
globalThis.fetch = async (url, init) => {
  const fake = JSON.parse(readFileSync(path, 'utf8'));
  const body = JSON.parse(init.body);
  const answer = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const keep = () => writeFileSync(path, JSON.stringify(fake));
  const fn = String(url).split('/').pop();
  if (String(url).includes('/functions/v1/')) {
    if (fn !== 'claude-model-example' || fake.noFunction) return answer(404, { message: 'Function not found' });
    if (body.key !== fake.key) return answer(401, { code: '28000', message: 'not a Claude key' });
    const id = `e${String((fake.added || []).length + 1).padStart(7, '0')}-0000-4000-8000-000000000000`;
    fake.added = [...(fake.added || []), { ...body.example, image: body.image.length }];
    fake.books.examples.unshift({ id, ...body.example, created_at: '2026-10-28T00:00:00Z' });
    keep();
    return answer(200, { id, path: `user-1/${id}.png` });
  }
  if (body.p_key !== fake.key) return answer(401, { code: '28000', message: 'not a Claude key' });
  if (fn === 'claude_journal_read') return answer(200, fake.data);
  if (fn === 'claude_model_books_read') return answer(200, { ...fake.books, library: [...(fake.data.library || []), ...(fake.library || [])] });
  if (fn === 'claude_journal_save' || fn === 'claude_model_books_save') {
    fake.saves = [...(fake.saves || []), fn === 'claude_journal_save' ? body.p_changes : { fn, ...body.p_changes }];
    if (fn === 'claude_journal_save') fake.library = [...(fake.library || []), ...(body.p_changes.library || [])];
    else {
      for (const b of body.p_changes.books || []) fake.books.books = [...fake.books.books.filter(x => x.id !== b.id), { created_at: '2026-10-28T00:00:00Z', ...b }];
      for (const e of body.p_changes.examples || []) Object.assign(fake.books.examples.find(x => x.id === e.id), e.fields);
    }
    keep();
    // oldSave: a database before the day and week review migrations, whose save skips those reviews
    return answer(200, { saved: fake.oldSave && (body.p_changes.notebook || body.p_changes.periods) ? 0 : 1 });
  }
  return answer(404, { message: 'Could not find the function' });
};
