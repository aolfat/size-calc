// Preloaded into scripts/journal.mjs by tests/claude-access.test.mjs (node --import): fetch answers the two Claude
// functions from a JSON file instead of Supabase. FAKE_JOURNAL names the file ({ data, key }); each save's body is
// appended to its saves list, and a wrong key is refused the way the database refuses it.
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.env.FAKE_JOURNAL;
globalThis.fetch = async (url, init) => {
  const fake = JSON.parse(readFileSync(path, 'utf8'));
  const body = JSON.parse(init.body);
  const answer = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  if (body.p_key !== fake.key) return answer(401, { code: '28000', message: 'not a Claude key' });
  if (String(url).endsWith('/rpc/claude_journal_read')) return answer(200, fake.data);
  if (String(url).endsWith('/rpc/claude_journal_save')) {
    fake.saves = [...(fake.saves || []), body.p_changes];
    writeFileSync(path, JSON.stringify(fake));
    return answer(200, { saved: 1 });
  }
  return answer(404, { message: 'Could not find the function' });
};
