// Claude access keys (docs/claude-access.md): make one (drawn in the browser; only its SHA-256 is kept, in claude_keys),
// list yours, revoke one. A key lets a Claude Code session read the journal and save reviews through two database
// functions, nothing else. Row-level security returns only your rows. Never touches the page.
import { state } from '../state.js';
import { supabaseClient } from './supabase.js';

/** what every key starts with, so one is easy to recognize (and to find if it's ever pasted somewhere it shouldn't be) */
export const KEY_PREFIX = 'scj_';

/** a new key: the prefix and 32 random bytes, base64url */
export function newClaudeKey() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return KEY_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 hex, what claude_keys keeps and the database checks a key against. @param {string} key */
export async function claudeKeyHash(key) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function refused(res, what) {
  if (!res?.error) return;
  const err = new Error(/schema cache|does not exist/i.test(res.error.message || '') ? "the database doesn't have Claude keys yet: npx supabase db push" : res.error.message || what);
  err.status = res.status || 0;
  throw err;
}

async function client() {
  if (!state.session) throw new Error('Sign in with Google to make a Claude key.');
  return supabaseClient();
}

/** your keys, oldest first: { id, label, created_at, last_used_at } */
export async function loadClaudeKeys() {
  const c = await client();
  const res = await c.from('claude_keys').select('id,label,created_at,last_used_at').order('created_at', { ascending: true }).limit(50);
  refused(res, 'Supabase refused the read.');
  return res.data || [];
}

/** a new key saved (as its hash) and returned, the only time it's seen. @returns {Promise<{ key: string, row: any }>} */
export async function makeClaudeKey(label = 'Claude') {
  const c = await client();
  const key = newClaudeKey();
  const row = { id: globalThis.crypto.randomUUID(), key_hash: await claudeKeyHash(key), label };
  refused(await c.from('claude_keys').insert([row]), 'Supabase refused the save.');
  return { key, row: { id: row.id, label, created_at: new Date().toISOString(), last_used_at: null } };
}

/** a key gone: the next call with it is refused. @param {string} id */
export async function revokeClaudeKey(id) {
  const c = await client();
  refused(await c.from('claude_keys').delete().eq('id', id), 'Supabase refused the delete.');
}
